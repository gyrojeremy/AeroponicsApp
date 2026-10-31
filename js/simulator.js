// Demo tower: a simulated high-pressure aeroponic tower that runs in the
// browser and speaks the same messages as the real ESP32 over MQTT.
// It lets the dashboard be used and tested before any hardware exists.

import { mistPlan } from "./schedule.js";
import { DEFAULT_CONFIG, PUMP_ORDER, clone, mergeDefaults } from "./defaults.js";

const rand = (a, b) => a + Math.random() * (b - a);

/** Air model: daily temperature curve peaking mid-afternoon, plus a little noise. */
function airAt(ts) {
  const d = new Date(ts);
  const h = d.getHours() + d.getMinutes() / 60;
  const temp = 19 + 8.5 * Math.sin(((h - 9) / 24) * 2 * Math.PI);
  const rh = Math.min(95, Math.max(25, 72 - 2.6 * (temp - 18)));
  return { temp, rh };
}

export class DemoTower {
  constructor() {
    this.listeners = {};
    this.cfg = clone(DEFAULT_CONFIG);
    this.timer = null;
  }

  on(type, fn) {
    (this.listeners[type] ||= []).push(fn);
    return this;
  }
  emit(type, payload) {
    (this.listeners[type] || []).forEach((fn) => fn(payload));
  }

  get kind() { return "demo"; }

  async connect() {
    const now = Date.now();
    const air = airAt(now);
    this.s = {
      airTemp: air.temp, rh: air.rh,
      waterTemp: 19.5 + 0.25 * (air.temp - 18),
      ec: 1.57, ph: 6.08, level: 74,
      psi: 91, pump: false, pumpStartedAt: null,
      mistActiveUntil: 0, lastMistAt: now - 40_000, nextMistAt: now + 60_000,
      pausedUntil: null,
      todayMl: { a: 4, b: 4, phDown: 2, phUp: 0 },
      nextDoseCheckAt: now + 45_000,
      bootAt: now - 3 * 3600_000,
      dayKey: new Date(now).toDateString(),
    };
    this.alertsActive = new Map();
    this.emit("status", "online");
    this.emit("config", clone(this.cfg));
    this.emit("history", this.seedHistory(now));
    this.emit("mists", this.seedMists(now));
    this.emit("events", this.seedEvents(now));
    this.lastTick = now;
    this.timer = setInterval(() => this.tick(), 1000);
    this.publishState();
    return true;
  }

  disconnect() {
    clearInterval(this.timer);
    this.timer = null;
    this.emit("status", "offline");
  }

  // ----- messages from the dashboard -----

  setConfig(cfg) {
    this.cfg = mergeDefaults(cfg);
    // A new schedule takes effect from the next cycle.
    const plan = this.plan(Date.now());
    this.s.nextMistAt = Math.min(this.s.nextMistAt, this.s.lastMistAt + plan.offSec * 1000);
    setTimeout(() => this.emit("config", clone(this.cfg)), 400);
  }

  command(cmd) {
    const now = Date.now();
    switch (cmd.cmd) {
      case "mist":
        this.startMist(now, cmd.seconds);
        break;
      case "pause":
        this.s.pausedUntil = now + (cmd.minutes || 30) * 60_000;
        this.event({ type: "note", text: `Misting paused for ${cmd.minutes || 30} min` });
        break;
      case "resume":
        this.s.pausedUntil = null;
        this.s.nextMistAt = Math.min(this.s.nextMistAt, now + 5000);
        this.event({ type: "note", text: "Misting resumed" });
        break;
      case "dose":
        this.dose(cmd.pump, cmd.ml, "Manual dose");
        break;
      case "prime": {
        const p = this.cfg.dosing.pumps[cmd.pump];
        const ml = Math.round((cmd.seconds || 5) * p.mlPerSec * 10) / 10;
        this.event({ type: "note", text: `Primed ${p.name} for ${cmd.seconds || 5} s (${ml} ml)` });
        break;
      }
    }
    this.publishState();
  }

  // ----- simulation -----

  plan(ts) {
    return mistPlan(this.cfg, { airTemp: this.s.airTemp, humidity: this.s.rh }, new Date(ts));
  }

  startMist(now, seconds) {
    const plan = this.plan(now);
    const on = seconds || plan.onSec;
    this.s.mistActiveUntil = now + on * 1000;
    this.s.lastMistAt = now;
    this.s.nextMistAt = now + (on + plan.offSec) * 1000;
    this.emit("event", { ts: now, type: "mist", onSec: on });
  }

  dose(pump, ml, reason) {
    const p = this.cfg.dosing.pumps[pump];
    if (!p) return;
    const left = p.maxDailyMl - this.s.todayMl[pump];
    if (left <= 0) {
      this.event({ type: "note", text: `${p.name} skipped: daily limit of ${p.maxDailyMl} ml reached` });
      return;
    }
    ml = Math.min(ml ?? p.doseMl, left);
    this.s.todayMl[pump] = Math.round((this.s.todayMl[pump] + ml) * 10) / 10;
    if (pump === "a" || pump === "b") this.s.ec += 0.012 * ml;
    if (pump === "phDown") this.s.ph -= 0.07 * ml;
    if (pump === "phUp") this.s.ph += 0.07 * ml;
    this.event({ type: "dose", pump, ml, text: `${p.name} ${ml} ml · ${reason}` });
  }

  event(e) {
    this.emit("event", { ts: Date.now(), ...e });
  }

  autoDose(now) {
    const d = this.cfg.dosing;
    this.s.nextDoseCheckAt = now + d.mixWaitMin * 60_000;
    if (!d.auto) return;
    // pH first: nutrient uptake depends on it. One correction per check.
    if (this.s.ph > d.ph.target + d.ph.band) {
      this.dose("phDown", d.pumps.phDown.doseMl, `pH ${this.s.ph.toFixed(2)} above ${(d.ph.target + d.ph.band).toFixed(2)}`);
    } else if (this.s.ph < d.ph.target - d.ph.band) {
      this.dose("phUp", d.pumps.phUp.doseMl, `pH ${this.s.ph.toFixed(2)} below ${(d.ph.target - d.ph.band).toFixed(2)}`);
    } else if (this.s.ec < d.ec.target - d.ec.band) {
      const why = `EC ${this.s.ec.toFixed(2)} below ${(d.ec.target - d.ec.band).toFixed(2)}`;
      this.dose("a", d.pumps.a.doseMl, why);
      this.dose("b", d.pumps.b.doseMl, why);
    }
  }

  tick() {
    const now = Date.now();
    const dt = Math.min((now - this.lastTick) / 1000, 5);
    this.lastTick = now;
    const s = this.s, P = this.cfg.pressure;

    if (new Date(now).toDateString() !== s.dayKey) {
      s.dayKey = new Date(now).toDateString();
      PUMP_ORDER.forEach((k) => (s.todayMl[k] = 0));
    }

    const air = airAt(now);
    s.airTemp += (air.temp + rand(-0.15, 0.15) - s.airTemp) * 0.3;
    s.rh += (air.rh + rand(-0.6, 0.6) - s.rh) * 0.3;
    s.waterTemp += (19.5 + 0.25 * (s.airTemp - 18) - s.waterTemp) * 0.002 * dt;
    s.ph += 0.00004 * dt;   // pH creeps up as plants feed
    s.ec += 0.000004 * dt;  // EC creeps up as water evaporates
    s.level = Math.max(0, s.level - 0.00015 * dt);

    // Misting
    const misting = now < s.mistActiveUntil;
    if (misting) {
      s.psi -= 2.6 * dt;
      s.level -= 0.004 * dt;
    }
    const paused = s.pausedUntil && now < s.pausedUntil;
    if (s.pausedUntil && !paused) s.pausedUntil = null;
    if (!misting && !paused && now >= s.nextMistAt && s.psi > P.lowAlarmPsi - 10) this.startMist(now);

    // Accumulator and pump (pressure switch with hysteresis)
    s.psi -= 0.004 * dt;
    if (!s.pump && s.psi < P.cutInPsi) { s.pump = true; s.pumpStartedAt = now; }
    if (s.pump) s.psi += 1.7 * dt;
    if (s.pump && s.psi >= P.cutOutPsi) { s.pump = false; s.pumpStartedAt = null; }
    s.psi = Math.max(0, s.psi + rand(-0.05, 0.05));

    if (now >= s.nextDoseCheckAt) this.autoDose(now);

    this.checkAlerts(now);
    if (Math.round(now / 1000) % 2 === 0) this.publishState();
  }

  checkAlerts(now) {
    const s = this.s, A = this.cfg.alerts, P = this.cfg.pressure;
    const want = new Map();
    if (s.psi < P.lowAlarmPsi) want.set("pressure_low", { level: "crit", text: `Accumulator pressure ${s.psi.toFixed(0)} psi, below ${P.lowAlarmPsi} psi` });
    if (s.pump && s.pumpStartedAt && now - s.pumpStartedAt > P.maxPumpRunSec * 1000) want.set("pump_runtime", { level: "crit", text: `Pump has run over ${P.maxPumpRunSec} s. Check for a leak or a dry reservoir.` });
    if (s.level < A.levelLowPct) want.set("level_low", { level: "warn", text: `Reservoir at ${s.level.toFixed(0)}%. Top up soon.` });
    if (s.waterTemp > A.waterTempHigh) want.set("water_hot", { level: "warn", text: `Reservoir ${s.waterTemp.toFixed(1)} °C. Warm water holds less oxygen.` });
    if (s.airTemp > A.airTempHigh) want.set("air_hot", { level: "warn", text: `Air ${s.airTemp.toFixed(1)} °C` });
    this.alertsActive = want;
  }

  publishState() {
    const now = Date.now(), s = this.s;
    const plan = this.plan(now);
    const misting = now < s.mistActiveUntil;
    this.emit("state", {
      ts: now,
      air: { temp: r1(s.airTemp), rh: Math.round(s.rh) },
      water: { temp: r1(s.waterTemp), ec: r2(s.ec), ph: r2(s.ph), levelPct: Math.round(s.level) },
      pressure: { psi: r1(s.psi), pump: s.pump, pumpRunSec: s.pumpStartedAt ? Math.round((now - s.pumpStartedAt) / 1000) : 0 },
      mist: {
        active: misting,
        onSec: plan.onSec, offSec: plan.offSec, rule: plan.rule, night: plan.night,
        nextInSec: misting ? 0 : Math.max(0, Math.round((s.nextMistAt - now) / 1000)),
        lastAt: s.lastMistAt,
        pausedUntil: s.pausedUntil,
      },
      dosing: {
        auto: this.cfg.dosing.auto,
        todayMl: { ...s.todayMl },
        nextCheckInSec: Math.max(0, Math.round((s.nextDoseCheckAt - now) / 1000)),
      },
      alerts: [...this.alertsActive].map(([code, a]) => ({ code, ...a })),
      device: { uptimeSec: Math.round((now - s.bootAt) / 1000), rssi: -58 - Math.round(rand(0, 6)), fw: "demo" },
    });
  }

  // ----- fake past data so charts aren't empty -----

  seedHistory(now) {
    const out = [];
    const step = 5 * 60_000;
    let ec = 1.52, ph = 5.95;
    for (let ts = now - 7 * 86400_000; ts <= now; ts += step) {
      const a = airAt(ts);
      const temp = a.temp + rand(-0.4, 0.4), rh = a.rh + rand(-2, 2);
      const plan = mistPlan(this.cfg, { airTemp: temp, humidity: rh }, new Date(ts));
      ph += 0.012 + rand(-0.004, 0.004);
      if (ph > 6.1) ph -= 0.14;
      ec += 0.0012 + rand(-0.002, 0.002);
      if (ec < 1.45) ec += 0.05;
      if (ec > 1.72) ec -= 0.03;
      // Reservoir drains ~0.25%/hour and was topped up a few days ago.
      let level = 74 + ((now - ts) / step) * 0.02;
      if (level > 96) level -= 64;
      out.push({
        ts,
        airTemp: r1(temp), rh: Math.round(rh),
        waterTemp: r1(19.5 + 0.25 * (temp - 18) + rand(-0.1, 0.1)),
        ec: r2(ec), ph: r2(ph), level: Math.round(level),
        psi: r1(rand(80, 100)), offSec: plan.offSec,
      });
    }
    return out;
  }

  seedMists(now) {
    const out = [];
    let ts = now - 40_000;
    while (ts > now - 3 * 3600_000) {
      const a = airAt(ts);
      const p = mistPlan(this.cfg, { airTemp: a.temp, humidity: a.rh }, new Date(ts));
      out.unshift({ ts, onSec: p.onSec });
      ts -= (p.offSec + p.onSec) * 1000;
    }
    return out;
  }

  seedEvents(now) {
    return [
      { ts: now - 52 * 60_000, type: "dose", pump: "phDown", ml: 1, text: "pH down 1 ml · pH 6.13 above 6.10" },
      { ts: now - 2.4 * 3600_000, type: "dose", pump: "a", ml: 2, text: "Nutrient A 2 ml · EC 1.44 below 1.45" },
      { ts: now - 2.4 * 3600_000, type: "dose", pump: "b", ml: 2, text: "Nutrient B 2 ml · EC 1.44 below 1.45" },
      { ts: now - 3 * 3600_000, type: "note", text: "Tower started" },
    ];
  }
}

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
