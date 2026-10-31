import { mistPlan, vpd, fmtDuration, bandLabel } from "./schedule.js";
import { DEFAULT_CONFIG, PUMP_ORDER, clone, mergeDefaults } from "./defaults.js";
import { DemoTower } from "./simulator.js";
import { MqttTower } from "./mqtt-link.js";
import { lineChart } from "./charts.js";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (id) => parseFloat($(id).value);
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const fmtWhen = (ts) => {
  const d = new Date(ts), today = new Date().toDateString() === d.toDateString();
  return today ? fmtTime(ts) : d.toLocaleDateString([], { weekday: "short" }) + " " + fmtTime(ts);
};

const storage = {
  get(k, fallback) {
    try { const v = localStorage.getItem("aerotower:" + k); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(k, v) { try { localStorage.setItem("aerotower:" + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem("aerotower:" + k); } catch { /* storage unavailable */ } },
};

let toastTimer;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
const S = {
  tower: null,
  conn: storage.get("conn", { mode: "demo", url: "", user: "", towerId: "tower1", pass: "", remember: false }),
  link: "idle",          // broker link: idle | connecting | connected | reconnecting | offline | error
  device: "unknown",     // tower: online | offline | unknown
  cfg: clone(DEFAULT_CONFIG),
  state: null,
  stateAt: 0,            // when the last state arrived (browser clock)
  nextMistAt: 0,         // browser clock
  mistEndAt: 0,
  history: [],
  mists: [],
  events: [],
  dirty: { schedule: false, dosing: false, tower: false },
  pending: null,         // {form, cfg, at}
};

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
async function startLink() {
  if (S.tower) { S.tower.disconnect(); S.tower = null; }
  S.state = null; S.stateAt = 0; S.mists = []; S.events = []; S.device = "unknown";
  S.history = S.conn.mode === "mqtt" ? storage.get(histKey(), []) : [];
  S.mists = S.conn.mode === "mqtt" ? storage.get(histKey() + ":mists", []) : [];
  renderAll();

  const t = S.conn.mode === "mqtt"
    ? new MqttTower({ url: S.conn.url.trim(), username: S.conn.user.trim(), password: S.conn.pass, towerId: S.conn.towerId.trim() })
    : new DemoTower();
  S.tower = t;

  t.on("link", (v) => { S.link = v; renderLink(); });
  t.on("status", (v) => { S.device = v; renderLink(); });
  t.on("state", onState);
  t.on("config", onConfig);
  t.on("event", onEvent);
  t.on("history", (h) => { S.history = h; renderHistory(); });
  t.on("mists", (m) => { S.mists = m; });
  t.on("events", (e) => { S.events = e.sort((a, b) => b.ts - a.ts); renderActivity(); });

  S.link = "connecting";
  renderLink();
  setConnError("");
  try {
    await t.connect();
    if (t.kind === "demo") S.link = "connected";
    renderLink();
    $("connStatus").textContent = t.kind === "demo" ? "Running the demo tower." : "Connected to the broker.";
    $("connStatus").dataset.s = "ok";
  } catch (err) {
    S.link = "error";
    renderLink();
    setConnError(err.message);
    $("connStatus").textContent = "";
  }
}

const histKey = () => `history:${S.conn.towerId || "tower1"}`;

function setConnError(msg) {
  $("connError").textContent = msg;
  $("connError").hidden = !msg;
}

function onState(st) {
  const now = Date.now();
  S.state = st;
  S.stateAt = now;
  if (S.tower?.kind === "mqtt") S.device = "online";
  const m = st.mist || {};
  S.nextMistAt = now + (m.nextInSec ?? 0) * 1000;
  S.mistEndAt = m.active ? now + Math.max(0, m.onSec * 1000 - (st.ts - m.lastAt)) : 0;

  // Keep one history sample a minute (the demo seeds its own).
  const last = S.history[S.history.length - 1];
  if (!last || st.ts - last.ts >= 60_000) {
    S.history.push({
      ts: st.ts,
      airTemp: st.air?.temp, rh: st.air?.rh, waterTemp: st.water?.temp,
      ec: st.water?.ec, ph: st.water?.ph, level: st.water?.levelPct,
      psi: st.pressure?.psi, offSec: m.offSec,
    });
    const cutoff = st.ts - 7 * 86400_000;
    while (S.history.length && S.history[0].ts < cutoff) S.history.shift();
    if (S.tower?.kind === "mqtt") storage.set(histKey(), S.history);
  }
  renderOverview();
  renderDoseNow();
  renderNowPlan();
  renderDevice();
  renderLink();
}

function onConfig(cfg) {
  S.cfg = mergeDefaults(cfg);
  $("towerName").textContent = S.cfg.towerName;
  document.title = S.cfg.towerName;
  if (S.pending && JSON.stringify(mergeDefaults(S.pending.cfg)) === JSON.stringify(S.cfg)) {
    const f = S.pending.form;
    S.dirty[f] = false;
    status(f, `Saved to the tower at ${fmtTime(Date.now())}`, "ok");
    toast("Saved to the tower");
    S.pending = null;
  }
  if (!S.dirty.schedule) fillSchedule();
  if (!S.dirty.dosing) fillDosing();
  if (!S.dirty.tower) fillTower();
  $("cfgJson").value = JSON.stringify(S.cfg, null, 2);
  renderOverview();
  renderHistory();
}

function onEvent(e) {
  if (e.type === "mist") {
    S.mists.push({ ts: e.ts, onSec: e.onSec });
    const cutoff = Date.now() - 3 * 3600_000;
    while (S.mists.length && S.mists[0].ts < cutoff) S.mists.shift();
    if (S.tower?.kind === "mqtt") storage.set(histKey() + ":mists", S.mists);
    renderPulses();
    return;
  }
  S.events.unshift(e);
  S.events.length = Math.min(S.events.length, 100);
  renderActivity();
}

function send(form, cfg) {
  try {
    S.tower.setConfig(cfg);
    S.pending = { form, cfg, at: Date.now() };
    status(form, "Sending…");
    setTimeout(() => {
      if (S.pending && S.pending.form === form && Date.now() - S.pending.at >= 7900) {
        status(form, "Sent, but the tower hasn't confirmed yet. It will apply the change when it's back online.", "dirty");
      }
    }, 8000);
  } catch (err) {
    status(form, err.message, "dirty");
  }
}

function command(cmd, doneText) {
  try {
    S.tower.command(cmd);
    if (doneText) toast(doneText);
  } catch (err) {
    toast(err.message);
  }
}

const statusIds = { schedule: "schedStatus", dosing: "doseStatus", tower: "towerStatus" };
function status(form, text, s = "") {
  const el = $(statusIds[form]);
  el.textContent = text;
  el.dataset.s = s;
}

// ---------------------------------------------------------------------------
// Link pill
// ---------------------------------------------------------------------------
function renderLink() {
  const pill = $("linkPill"), text = $("linkText");
  let s, label;
  const stale = S.stateAt && Date.now() - S.stateAt > 30_000;
  if (S.conn.mode === "demo") { s = "demo"; label = "Demo tower"; }
  else if (S.link === "connecting") { s = "waiting"; label = "Connecting…"; }
  else if (S.link === "reconnecting") { s = "waiting"; label = "Reconnecting…"; }
  else if (S.link === "error" || S.link === "offline" || S.link === "idle") { s = "offline"; label = "Not connected"; }
  else if (S.device === "offline") { s = "offline"; label = "Tower offline"; }
  else if (!S.state) { s = "waiting"; label = "Waiting for tower"; }
  else if (stale) { s = "waiting"; label = `No data for ${fmtDuration((Date.now() - S.stateAt) / 1000)}`; }
  else { s = "online"; label = "Tower online"; }
  pill.dataset.state = s;
  text.textContent = label;
  $("demoNote").hidden = S.conn.mode !== "demo";
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
const READINGS = [
  { key: "airTemp", name: "Air", unit: "°C", get: (s) => s.air?.temp, dp: 1, scale: [0, 40],
    band: () => [18, 28], status: (v, c) => v > c.alerts.airTempHigh ? "crit" : null, note: () => "Comfort 18–28 °C" },
  { key: "rh", name: "Humidity", unit: "%", get: (s) => s.air?.rh, dp: 0, scale: [0, 100],
    band: () => [45, 80], note: () => "Comfort 45–80%" },
  { key: "vpd", name: "VPD", unit: "kPa", get: (s) => vpd(s.air?.temp, s.air?.rh), dp: 2, scale: [0, 2.5],
    band: () => [0.6, 1.4], note: () => "Leafy greens 0.6–1.4 kPa" },
  { key: "waterTemp", name: "Reservoir", unit: "°C", get: (s) => s.water?.temp, dp: 1, scale: [10, 30],
    band: () => [18, 22], status: (v, c) => v > c.alerts.waterTempHigh ? "crit" : null, note: (c) => `Alert above ${c.alerts.waterTempHigh} °C` },
  { key: "ec", name: "EC", unit: "mS/cm", get: (s) => s.water?.ec, dp: 2, scale: [0, 3],
    band: (c) => [c.dosing.ec.target - c.dosing.ec.band, c.dosing.ec.target + c.dosing.ec.band],
    note: (c) => `Target ${c.dosing.ec.target.toFixed(2)} ± ${c.dosing.ec.band}` },
  { key: "ph", name: "pH", unit: "", get: (s) => s.water?.ph, dp: 2, scale: [4.5, 7.5],
    band: (c) => [c.dosing.ph.target - c.dosing.ph.band, c.dosing.ph.target + c.dosing.ph.band],
    note: (c) => `Target ${c.dosing.ph.target.toFixed(2)} ± ${c.dosing.ph.band}` },
  { key: "level", name: "Reservoir level", unit: "%", get: (s) => s.water?.levelPct, dp: 0, scale: [0, 100],
    band: (c) => [c.alerts.levelLowPct, 100], status: (v, c) => v < c.alerts.levelLowPct ? "crit" : null, note: (c) => `Alert below ${c.alerts.levelLowPct}%` },
  { key: "wifi", name: "Wi-Fi signal", unit: "dBm", get: (s) => s.device?.rssi, dp: 0, scale: [-95, -35],
    band: () => [-70, -35], note: () => "Good above −70 dBm" },
];

function buildReadings() {
  $("readings").innerHTML = READINGS.map((r) => `
    <div class="reading" id="rd-${r.key}">
      <div class="reading-top"><span class="reading-name">${r.name}</span><span class="chip" data-s="none">–</span></div>
      <div class="reading-value">–<small>${r.unit}</small></div>
      <div class="range" aria-hidden="true"><span class="band"></span><span class="mark" hidden></span></div>
      <div class="reading-note"></div>
    </div>`).join("");
}

function renderReadings() {
  const st = S.state, c = S.cfg;
  for (const r of READINGS) {
    const el = $("rd-" + r.key);
    const v = st ? r.get(st) : NaN;
    const [lo, hi] = r.scale, [bl, bh] = r.band(c);
    const pct = (x) => Math.min(100, Math.max(0, ((x - lo) / (hi - lo)) * 100));
    const band = el.querySelector(".band"), mark = el.querySelector(".mark");
    band.style.left = pct(bl) + "%";
    band.style.width = (pct(bh) - pct(bl)) + "%";
    el.querySelector(".reading-note").textContent = r.note(c);
    const chip = el.querySelector(".chip");
    if (!isFinite(v)) {
      el.querySelector(".reading-value").innerHTML = `–<small>${r.unit}</small>`;
      chip.dataset.s = "none"; chip.textContent = "No reading";
      mark.hidden = true;
      continue;
    }
    const shown = r.key === "wifi" ? String(v).replace("-", "−") : v.toFixed(r.dp);
    el.querySelector(".reading-value").innerHTML = `${shown}<small>${r.unit}</small>`;
    mark.hidden = false;
    mark.style.left = pct(v) + "%";
    let s = r.status?.(v, c) || (v < bl ? "warn" : v > bh ? "warn" : "ok");
    chip.dataset.s = s;
    chip.textContent = s === "ok" ? "In range" : v < bl ? "Low" : "High";
  }
}

function renderOverview() {
  renderReadings();
  renderAlerts();
  renderHero();
  renderPulses();
}

function renderHero() {
  const st = S.state, hero = document.querySelector(".mist-hero");
  const P = S.cfg.pressure;
  // Accumulator
  const maxPsi = Math.max(P.cutOutPsi * 1.2, 60);
  const y = (psi) => Math.min(100, Math.max(0, (psi / maxPsi) * 100));
  $("markOut").style.bottom = y(P.cutOutPsi) + "%";
  $("markIn").style.bottom = y(P.cutInPsi) + "%";
  if (!st) {
    $("psi").textContent = "––";
    $("tankFill").style.height = "0%";
    $("mistPlan").textContent = S.conn.mode === "mqtt" ? "Waiting for the tower to report in…" : "Starting the demo tower…";
    return;
  }
  const psi = st.pressure?.psi;
  $("psi").textContent = isFinite(psi) ? Math.round(psi) : "––";
  $("tankFill").style.height = (isFinite(psi) ? y(psi) : 0) + "%";
  $("tank").dataset.low = psi < P.lowAlarmPsi;
  const pump = $("pumpState");
  pump.dataset.on = !!st.pressure?.pump;
  pump.textContent = st.pressure?.pump ? `Pump refilling · ${st.pressure.pumpRunSec}s` : "Pump idle";
  $("tank").setAttribute("aria-label", `Accumulator at ${Math.round(psi)} psi`);

  const m = st.mist;
  const paused = m.pausedUntil && m.pausedUntil > st.ts;
  $("btnPause").textContent = paused ? "Resume misting" : "Pause 30 min";
  $("mistPlan").innerHTML = `${m.onSec} s mist every ${fmtDuration(m.offSec)} <span class="rule">· ${esc(m.rule)}</span>`;
  hero.dataset.phase = paused ? "paused" : m.active ? "misting" : "waiting";
  tickCountdown();
}

function tickCountdown() {
  const st = S.state;
  if (!st) return;
  const now = Date.now(), m = st.mist;
  const paused = m.pausedUntil && m.pausedUntil > st.ts;
  if (paused) {
    $("mistState").textContent = "Misting paused. Resumes in";
    $("countdown").textContent = fmtDuration((m.pausedUntil - st.ts) / 1000 - (now - S.stateAt) / 1000);
  } else if (S.mistEndAt > now) {
    $("mistState").textContent = "Misting now";
    $("countdown").textContent = Math.ceil((S.mistEndAt - now) / 1000) + " s";
    document.querySelector(".mist-hero").dataset.phase = "misting";
  } else {
    $("mistState").textContent = "Next mist in";
    $("countdown").textContent = fmtDuration((S.nextMistAt - now) / 1000);
    document.querySelector(".mist-hero").dataset.phase = "waiting";
  }
}

function renderPulses() {
  const svg = $("pulseSvg"), now = Date.now(), W = 600, H = 64, span = 3600_000;
  const recent = S.mists.filter((m) => m.ts > now - span);
  const maxOn = Math.max(6, ...recent.map((m) => m.onSec));
  let out = `<line x1="0" y1="${H - 1}" x2="${W}" y2="${H - 1}" stroke="var(--chamber-dim)" stroke-opacity="0.5" stroke-width="1"/>`;
  for (let i = 1; i < 6; i++) out += `<line x1="${(W * i) / 6}" y1="${H - 6}" x2="${(W * i) / 6}" y2="${H - 1}" stroke="var(--chamber-dim)" stroke-opacity="0.5" stroke-width="1"/>`;
  for (const m of recent) {
    const x = ((m.ts - (now - span)) / span) * W;
    const h = 14 + (m.onSec / maxOn) * (H - 22);
    out += `<rect x="${(x - 1.5).toFixed(1)}" y="${(H - 2 - h).toFixed(1)}" width="3" height="${h.toFixed(1)}" rx="1.5" fill="var(--mist)"><title>${fmtTime(m.ts)} · ${m.onSec} s</title></rect>`;
  }
  svg.innerHTML = out;
  $("pulseCount").textContent = recent.length ? `${recent.length} mists · ${Math.round(recent.reduce((a, m) => a + m.onSec, 0))} s total` : "No mists yet";
}

function renderAlerts() {
  const list = S.state?.alerts || [];
  const icon = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17h.01"/></svg>`;
  $("alerts").innerHTML = list.map((a) => `
    <div class="alert" data-level="${a.level === "crit" ? "crit" : "warn"}">${icon}
      <div><strong>${a.level === "crit" ? "Needs attention" : "Heads up"}</strong>${esc(a.text)}</div>
    </div>`).join("");
}

function renderActivity() {
  const items = S.events.slice(0, 12);
  $("activity").innerHTML = items.length
    ? items.map((e) => `<li><time datetime="${new Date(e.ts).toISOString()}">${fmtWhen(e.ts)}</time><span>${esc(e.text || e.type)}</span></li>`).join("")
    : `<li><span class="empty">Doses, pauses and alerts will show up here.</span></li>`;
  const doses = S.events.filter((e) => e.type === "dose").slice(0, 30);
  $("doseLog").innerHTML = doses.length
    ? doses.map((e) => `<li><time datetime="${new Date(e.ts).toISOString()}">${fmtWhen(e.ts)}</time><span>${esc(e.text)}</span></li>`).join("")
    : `<li><span class="empty">No doses yet. Doses appear here as the tower makes them.</span></li>`;
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------
let draftBands = [];

function fillSchedule() {
  const m = S.cfg.mist, P = S.cfg.pressure;
  $("mode-" + m.mode).checked = true;
  $("fixedOn").value = m.fixed.onSec;
  $("fixedOff").value = m.fixed.offSec;
  $("vpdOn").value = m.vpd.onSec;
  $("vpdBase").value = m.vpd.baseOffSec;
  $("vpdRef").value = m.vpd.refKpa;
  $("vpdMin").value = m.vpd.minOffSec;
  $("vpdMax").value = m.vpd.maxOffSec;
  $("nightOn").checked = m.night.enabled;
  $("nightStart").value = m.night.start;
  $("nightEnd").value = m.night.end;
  $("nightMult").value = m.night.offMultiplier;
  $("cutIn").value = P.cutInPsi;
  $("cutOut").value = P.cutOutPsi;
  $("lowAlarm").value = P.lowAlarmPsi;
  $("maxRun").value = P.maxPumpRunSec;
  draftBands = clone(m.bands).sort((a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity));
  renderBands();
  showMode();
  renderCurve();
  renderNowPlan();
}

function renderBands() {
  const cur = currentBandIndex();
  $("bandRows").innerHTML = draftBands.map((b, i) => {
    const last = i === draftBands.length - 1;
    const prev = i > 0 ? draftBands[i - 1].upTo : null;
    const temp = last
      ? `<span>${prev == null ? "Any temperature" : `${prev} °C and above`}</span>`
      : `<label class="temp-cell" for="bUp${i}">Below <input type="number" id="bUp${i}" data-i="${i}" data-k="upTo" value="${b.upTo}" step="0.5" min="-10" max="50"> °C</label>`;
    return `<tr data-current="${i === cur}">
      <td>${temp}</td>
      <td><input type="number" id="bOn${i}" aria-label="Mist seconds, band ${i + 1}" data-i="${i}" data-k="onSec" value="${b.onSec}" step="0.5" min="1" max="30"></td>
      <td><input type="number" id="bOff${i}" aria-label="Wait seconds, band ${i + 1}" data-i="${i}" data-k="offSec" value="${b.offSec}" step="5" min="30" max="3600"></td>
      <td>${draftBands.length > 1 ? `<button type="button" class="icon-btn" data-remove="${i}" aria-label="Remove band ${i + 1}">×</button>` : ""}</td>
    </tr>`;
  }).join("");
}

function currentBandIndex() {
  const t = S.state?.air?.temp;
  if (!isFinite(t)) return -1;
  const i = draftBands.findIndex((b) => b.upTo == null || t < b.upTo);
  return i === -1 ? draftBands.length - 1 : i;
}

function showMode() {
  const mode = document.querySelector('input[name="mode"]:checked')?.value || "bands";
  document.querySelectorAll("[data-mode]").forEach((el) => (el.hidden = el.dataset.mode !== mode));
}

function readSchedule() {
  const cfg = clone(S.cfg);
  const m = cfg.mist;
  m.mode = document.querySelector('input[name="mode"]:checked').value;
  m.fixed = { onSec: num("fixedOn"), offSec: num("fixedOff") };
  m.vpd = { onSec: num("vpdOn"), baseOffSec: num("vpdBase"), refKpa: num("vpdRef"), minOffSec: num("vpdMin"), maxOffSec: num("vpdMax") };
  m.bands = clone(draftBands);
  m.night = { enabled: $("nightOn").checked, start: $("nightStart").value || "20:30", end: $("nightEnd").value || "06:30", offMultiplier: num("nightMult") };
  cfg.pressure = { cutInPsi: num("cutIn"), cutOutPsi: num("cutOut"), lowAlarmPsi: num("lowAlarm"), maxPumpRunSec: num("maxRun") };
  return cfg;
}

function validateSchedule(cfg) {
  const m = cfg.mist, P = cfg.pressure;
  const nums = [m.fixed.onSec, m.fixed.offSec, ...Object.values(m.vpd), m.night.offMultiplier, ...Object.values(P),
    ...m.bands.flatMap((b) => [b.onSec, b.offSec, b.upTo ?? 0])];
  if (nums.some((v) => !isFinite(v))) return "Fill in every number before sending.";
  for (let i = 1; i < m.bands.length - 1; i++) if (m.bands[i].upTo <= m.bands[i - 1].upTo) return "Each temperature band must start above the one before it.";
  if (m.vpd.minOffSec > m.vpd.maxOffSec) return "The shortest VPD wait must be less than the longest.";
  if (P.cutOutPsi <= P.cutInPsi) return "The pump cut-out must be higher than the cut-in.";
  if (P.lowAlarmPsi >= P.cutInPsi) return "Set the low-pressure alert below the cut-in pressure.";
  return null;
}

let curveChart;
function renderCurve() {
  const view = $("view-schedule");
  if (view.hidden) return;
  let cfg;
  try { cfg = readSchedule(); } catch { cfg = S.cfg; }
  const rh = S.state?.air?.rh ?? 60;
  const noon = new Date(); noon.setHours(12, 0, 0, 0);
  const data = [];
  for (let t = 0; t <= 40; t += 0.5) {
    const p = mistPlan(cfg, { airTemp: t, humidity: rh }, noon);
    data.push({ x: t, y: p.offSec / 60 });
  }
  $("curveNote").textContent = cfg.mist.mode === "vpd" ? `(daytime, at ${Math.round(rh)}% humidity)` : "(daytime)";
  curveChart?.destroy();
  curveChart = lineChart($("curveChart"), {
    series: [{ label: "Wait", color: "--accent", data }],
    x: { min: 0, max: 40, kind: "number", fmt: (v) => `${v} °C`, tipFmt: (v) => `Air ${v} °C` },
    y: { min: 0, fmt: (v) => fmtDuration(v * 60) },
    stepped: cfg.mist.mode === "bands",
  });
}

function renderNowPlan() {
  const el = $("nowPlan");
  if (!S.state) { el.innerHTML = "Waiting for an air reading to show the current timing."; return; }
  let cfg;
  try { cfg = readSchedule(); } catch { cfg = S.cfg; }
  const air = { airTemp: S.state.air?.temp, humidity: S.state.air?.rh };
  const p = mistPlan(cfg, air, new Date());
  el.innerHTML = `<span>At ${air.airTemp.toFixed(1)} °C and ${Math.round(air.humidity)}% humidity${S.dirty.schedule ? ", with your changes," : ""} the tower mists for</span>
    <strong>${p.onSec} s</strong><span>every</span><strong>${fmtDuration(p.offSec)}</strong><span>${esc(p.rule)}</span>`;
  // highlight active band
  const cur = currentBandIndex();
  document.querySelectorAll("#bandRows tr").forEach((tr, i) => (tr.dataset.current = i === cur));
}

function markDirty(form) {
  if (!S.dirty[form]) {
    S.dirty[form] = true;
  }
  status(form, "Unsaved changes", "dirty");
}

function wireSchedule() {
  const form = $("scheduleForm");
  form.addEventListener("input", (e) => {
    const el = e.target;
    if (el.dataset.i != null) {
      const v = parseFloat(el.value);
      draftBands[+el.dataset.i][el.dataset.k] = v;
      if (el.dataset.k === "upTo") {
        // relabel the next row's "and above" text without stealing focus
        const last = draftBands.length - 1;
        const span = $("bandRows").rows[last]?.cells[0].querySelector("span");
        if (span && +el.dataset.i === last - 1) span.textContent = `${v} °C and above`;
      }
    }
    if (el.name === "mode") showMode();
    markDirty("schedule");
    renderCurve();
    renderNowPlan();
  });
  form.addEventListener("click", (e) => {
    const rm = e.target.closest("[data-remove]");
    if (rm) {
      draftBands.splice(+rm.dataset.remove, 1);
      draftBands[draftBands.length - 1].upTo = null;
      renderBands(); markDirty("schedule"); renderCurve(); renderNowPlan();
    }
  });
  $("addBand").addEventListener("click", () => {
    const n = draftBands.length;
    const prevTop = n >= 2 ? draftBands[n - 2].upTo : 15;
    const last = draftBands[n - 1];
    draftBands.splice(n - 1, 0, { upTo: prevTop + 5, onSec: last.onSec, offSec: last.offSec });
    renderBands(); markDirty("schedule"); renderCurve(); renderNowPlan();
  });
  $("schedReset").addEventListener("click", () => { S.dirty.schedule = false; fillSchedule(); status("schedule", ""); });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const cfg = readSchedule();
    const err = validateSchedule(cfg);
    if (err) return status("schedule", err, "dirty");
    send("schedule", cfg);
  });
}

// ---------------------------------------------------------------------------
// Dosing
// ---------------------------------------------------------------------------
function fillDosing() {
  const d = S.cfg.dosing;
  $("autoDose").checked = d.auto;
  $("ecTarget").value = d.ec.target;
  $("ecBand").value = d.ec.band;
  $("phTarget").value = d.ph.target;
  $("phBand").value = d.ph.band;
  $("mixWait").value = d.mixWaitMin;
  $("pumps").innerHTML = PUMP_ORDER.map((k) => {
    const p = d.pumps[k];
    return `<div class="pump-card" id="pump-${k}">
      <div class="pump-head"><h3>${esc(p.name)}</h3><span class="pump-today" id="today-${k}"></span></div>
      <div class="meter" id="meter-${k}"><i style="width:0%"></i></div>
      <div class="row">
        <label class="field" for="dose-${k}">Dose <span class="unit-wrap"><input type="number" id="dose-${k}" value="${p.doseMl}" min="0.1" max="50" step="0.1"><span>ml</span></span></label>
        <label class="field" for="max-${k}">Daily limit <span class="unit-wrap"><input type="number" id="max-${k}" value="${p.maxDailyMl}" min="0" max="500" step="1"><span>ml</span></span></label>
        <label class="field" for="flow-${k}">Flow <span class="unit-wrap"><input type="number" id="flow-${k}" value="${p.mlPerSec}" min="0.05" max="20" step="0.05"><span>ml/s</span></span></label>
      </div>
      <div class="pump-actions">
        <button type="button" class="btn" data-dose="${k}">Dose ${p.doseMl} ml now</button>
        <button type="button" class="btn" data-prime="${k}">Prime 5 s</button>
      </div>
    </div>`;
  }).join("");
  renderDoseNow();
}

function readDosing() {
  const cfg = clone(S.cfg), d = cfg.dosing;
  d.auto = $("autoDose").checked;
  d.ec = { target: num("ecTarget"), band: num("ecBand") };
  d.ph = { target: num("phTarget"), band: num("phBand") };
  d.mixWaitMin = num("mixWait");
  for (const k of PUMP_ORDER) {
    d.pumps[k] = { ...d.pumps[k], doseMl: num("dose-" + k), maxDailyMl: num("max-" + k), mlPerSec: num("flow-" + k) };
  }
  return cfg;
}

function renderDoseNow() {
  const st = S.state, d = S.cfg.dosing;
  const el = $("doseNow");
  if (!st) { el.textContent = "Waiting for the tower's readings."; return; }
  el.innerHTML = `
    <div><span>EC</span><strong>${st.water.ec.toFixed(2)}</strong><span>target ${d.ec.target.toFixed(2)}</span></div>
    <div><span>pH</span><strong>${st.water.ph.toFixed(2)}</strong><span>target ${d.ph.target.toFixed(2)}</span></div>
    <div>${st.dosing.auto ? `<span>Next check in</span><strong>${fmtDuration(st.dosing.nextCheckInSec)}</strong>` : "<span>Auto dosing is off</span>"}</div>`;
  for (const k of PUMP_ORDER) {
    const used = st.dosing.todayMl?.[k] ?? 0, max = d.pumps[k].maxDailyMl || 1;
    const t = $("today-" + k);
    if (!t) continue;
    t.textContent = `${used} of ${d.pumps[k].maxDailyMl} ml today`;
    const meter = $("meter-" + k);
    meter.dataset.s = used / max >= 0.8 ? "warn" : "";
    meter.firstElementChild.style.width = Math.min(100, (used / max) * 100) + "%";
  }
}

function wireDosing() {
  const form = $("dosingForm");
  form.addEventListener("input", () => markDirty("dosing"));
  $("doseReset").addEventListener("click", () => { S.dirty.dosing = false; fillDosing(); status("dosing", ""); });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const cfg = readDosing(), d = cfg.dosing;
    const vals = [d.ec.target, d.ec.band, d.ph.target, d.ph.band, d.mixWaitMin, ...PUMP_ORDER.flatMap((k) => [d.pumps[k].doseMl, d.pumps[k].maxDailyMl, d.pumps[k].mlPerSec])];
    if (vals.some((v) => !isFinite(v))) return status("dosing", "Fill in every number before sending.", "dirty");
    send("dosing", cfg);
  });
  // Two-tap confirm for manual doses: chemicals can't be taken back out.
  form.addEventListener("click", (e) => {
    const dose = e.target.closest("[data-dose]"), prime = e.target.closest("[data-prime]");
    if (dose) {
      const k = dose.dataset.dose, p = S.cfg.dosing.pumps[k], ml = num("dose-" + k) || p.doseMl;
      if (dose.classList.contains("armed")) {
        dose.classList.remove("armed");
        dose.textContent = `Dose ${p.doseMl} ml now`;
        command({ cmd: "dose", pump: k, ml }, `Dosing ${ml} ml of ${p.name}`);
      } else {
        dose.classList.add("armed");
        dose.textContent = `Tap again to dose ${ml} ml`;
        setTimeout(() => { if (dose.isConnected) { dose.classList.remove("armed"); dose.textContent = `Dose ${p.doseMl} ml now`; } }, 4000);
      }
    }
    if (prime) {
      const k = prime.dataset.prime;
      command({ cmd: "prime", pump: k, seconds: 5 }, `Priming ${S.cfg.dosing.pumps[k].name} for 5 s`);
    }
  });
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
const charts = {};
function renderHistory() {
  if ($("view-history").hidden) return;
  const hours = +(document.querySelector('input[name="range"]:checked')?.value || 24);
  const max = S.state?.ts || Date.now(), min = max - hours * 3600_000;
  const rows = S.history.filter((r) => r.ts >= min);
  $("historyNote").textContent = S.conn.mode === "demo"
    ? "The demo tower's history is simulated."
    : rows.length < 2
      ? "History builds up while this page is open: one sample a minute, kept for 7 days on this device."
      : "Recorded by this browser while the page is open, one sample a minute, kept for 7 days on this device.";
  const pts = (k, f = (v) => v) => rows.filter((r) => isFinite(r[k])).map((r) => ({ x: r.ts, y: f(r[k]) }));
  const x = { min, max, kind: "time" };
  const d = S.cfg.dosing;
  const defs = {
    chTemp: { series: [{ label: "Air", color: "--accent", data: pts("airTemp") }, { label: "Reservoir", color: "--series-2", data: pts("waterTemp") }], y: { fmt: (v) => `${(+v).toFixed(1)} °C` } },
    chWait: { series: [{ label: "Wait", color: "--accent", data: pts("offSec", (v) => v / 60) }], y: { min: 0, fmt: (v) => fmtDuration(v * 60) }, stepped: true },
    chRh: { series: [{ label: "Humidity", color: "--accent", data: pts("rh") }], y: { suggestedMin: 30, suggestedMax: 90, fmt: (v) => `${Math.round(v)}%` } },
    chEc: { series: [{ label: "EC", color: "--accent", data: pts("ec") }], y: { suggestedMin: d.ec.target - 0.4, suggestedMax: d.ec.target + 0.4, fmt: (v) => (+v).toFixed(2) }, band: { lo: d.ec.target - d.ec.band, hi: d.ec.target + d.ec.band } },
    chPh: { series: [{ label: "pH", color: "--accent", data: pts("ph") }], y: { suggestedMin: d.ph.target - 0.6, suggestedMax: d.ph.target + 0.6, fmt: (v) => (+v).toFixed(2) }, band: { lo: d.ph.target - d.ph.band, hi: d.ph.target + d.ph.band } },
    chLevel: { series: [{ label: "Level", color: "--accent", data: pts("level") }], y: { min: 0, max: 100, fmt: (v) => `${Math.round(v)}%` } },
  };
  for (const [id, o] of Object.entries(defs)) {
    charts[id]?.destroy();
    charts[id] = lineChart($(id), { ...o, x });
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
function fillConn() {
  const c = S.conn;
  $("conn-" + c.mode).checked = true;
  $("brokerUrl").value = c.url;
  $("brokerUser").value = c.user;
  $("brokerPass").value = c.pass;
  $("towerId").value = c.towerId;
  $("rememberPass").checked = c.remember;
  $("mqttFields").hidden = c.mode !== "mqtt";
  $("connBtn").textContent = c.mode === "demo" ? "Restart demo" : "Connect";
}

function fillTower() {
  $("nameInput").value = S.cfg.towerName;
  $("airHigh").value = S.cfg.alerts.airTempHigh;
  $("waterHigh").value = S.cfg.alerts.waterTempHigh;
  $("levelLow").value = S.cfg.alerts.levelLowPct;
}

function renderDevice() {
  const st = S.state;
  const rows = [
    ["Connection", S.conn.mode === "demo" ? "Demo tower in this browser" : `${S.conn.url || "–"} · topic aerotower/${S.conn.towerId}`],
    ["Firmware", st?.device?.fw ?? "–"],
    ["Up for", st?.device?.uptimeSec ? fmtDuration(st.device.uptimeSec) : "–"],
    ["Last report", st ? fmtWhen(S.stateAt) : "–"],
  ];
  $("deviceInfo").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");
}

function wireSetup() {
  $("connForm").addEventListener("input", (e) => {
    if (e.target.name === "conn") {
      S.conn.mode = e.target.value;
      $("mqttFields").hidden = S.conn.mode !== "mqtt";
      $("connBtn").textContent = S.conn.mode === "demo" ? "Restart demo" : "Connect";
    }
  });
  $("connForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const mode = document.querySelector('input[name="conn"]:checked').value;
    const c = {
      mode,
      url: $("brokerUrl").value.trim(),
      user: $("brokerUser").value.trim(),
      pass: $("brokerPass").value,
      towerId: $("towerId").value.trim() || "tower1",
      remember: $("rememberPass").checked,
    };
    if (mode === "mqtt") {
      if (!/^wss:\/\/.+/.test(c.url)) return setConnError("Enter the broker's secure WebSocket address. It starts with wss://");
      if (!/^[A-Za-z0-9_-]+$/.test(c.towerId)) return setConnError("Tower ID can use letters, numbers, - and _ only.");
    }
    S.conn = c;
    storage.set("conn", { ...c, pass: c.remember ? c.pass : "" });
    startLink();
  });

  $("towerForm").addEventListener("input", () => markDirty("tower"));
  $("towerForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const cfg = clone(S.cfg);
    cfg.towerName = $("nameInput").value.trim() || "Garden Tower";
    cfg.alerts = { airTempHigh: num("airHigh"), waterTempHigh: num("waterHigh"), levelLowPct: num("levelLow") };
    if (Object.values(cfg.alerts).some((v) => !isFinite(v))) return status("tower", "Fill in every number before sending.", "dirty");
    send("tower", cfg);
  });

  $("cfgCopy").addEventListener("click", async () => {
    const ta = $("cfgJson");
    ta.value = JSON.stringify(S.cfg, null, 2);
    try { await navigator.clipboard.writeText(ta.value); $("cfgStatus").textContent = "Copied to the clipboard."; }
    catch { ta.focus(); ta.select(); $("cfgStatus").textContent = "Selected. Press Ctrl+C or ⌘C to copy."; }
  });
  $("cfgRestore").addEventListener("click", () => {
    const errEl = $("cfgError");
    try {
      const parsed = JSON.parse($("cfgJson").value);
      if (!parsed.mist || !parsed.dosing) throw new Error();
      errEl.hidden = true;
      S.dirty = { schedule: false, dosing: false, tower: false };
      send("tower", mergeDefaults(parsed));
      $("cfgStatus").textContent = "Sent to the tower.";
    } catch {
      errEl.textContent = "That isn't a settings backup. Paste the JSON from Copy settings.";
      errEl.hidden = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Routing, buttons, theme
// ---------------------------------------------------------------------------
const VIEWS = ["overview", "schedule", "dosing", "history", "setup"];
function route() {
  const v = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "overview";
  VIEWS.forEach((name) => ($("view-" + name).hidden = name !== v));
  document.querySelectorAll(".tabs a").forEach((a) => (a.dataset.view === v ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  if (v === "history") renderHistory();
  if (v === "schedule") { renderCurve(); renderNowPlan(); }
  window.scrollTo(0, 0);
}

function renderAll() {
  renderLink();
  renderOverview();
  renderActivity();
  renderDevice();
  renderDoseNow();
  renderNowPlan();
}

function init() {
  buildReadings();
  fillSchedule();
  fillDosing();
  fillTower();
  fillConn();
  wireSchedule();
  wireDosing();
  wireSetup();

  $("btnMist").addEventListener("click", () => command({ cmd: "mist" }, "Misting now"));
  $("btnPause").addEventListener("click", () => {
    const st = S.state;
    const paused = st?.mist?.pausedUntil && st.mist.pausedUntil > st.ts;
    command(paused ? { cmd: "resume" } : { cmd: "pause", minutes: 30 }, paused ? "Misting resumed" : "Misting paused for 30 minutes");
  });
  $("linkPill").addEventListener("click", () => (location.hash = "setup"));
  document.querySelectorAll('input[name="range"]').forEach((r) => r.addEventListener("change", renderHistory));

  window.addEventListener("hashchange", route);
  route();

  // Redraw charts when the colour theme changes.
  const redraw = () => { renderHistory(); renderCurve(); };
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", redraw);
  new MutationObserver(redraw).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  setInterval(tickCountdown, 250);
  setInterval(renderLink, 5000);
  setInterval(() => { if (!$("view-history").hidden) renderHistory(); renderPulses(); }, 60_000);

  startLink();
}

init();
