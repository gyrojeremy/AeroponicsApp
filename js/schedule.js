// Mist scheduling logic.
// This file is the reference for the ESP32 firmware: the tower must compute
// exactly the same plan on its own, so the dashboard is never required for
// watering to happen. Keep it free of DOM code so it can be ported 1:1.

/** Saturation vapour pressure in kPa (Tetens). */
export function svp(tempC) {
  return 0.6108 * Math.exp((17.27 * tempC) / (tempC + 237.3));
}

/** Vapour pressure deficit of the air in kPa. */
export function vpd(tempC, rhPct) {
  if (!isFinite(tempC) || !isFinite(rhPct)) return NaN;
  return svp(tempC) * (1 - Math.min(Math.max(rhPct, 0), 100) / 100);
}

/** "HH:MM" -> minutes after midnight. */
export function hhmmToMin(s) {
  const [h, m] = String(s || "0:0").split(":").map(Number);
  return ((h || 0) * 60 + (m || 0)) % 1440;
}

/** True when `date` falls inside a start–end window that may cross midnight. */
export function inWindow(date, start, end) {
  const now = date.getHours() * 60 + date.getMinutes();
  const a = hhmmToMin(start), b = hhmmToMin(end);
  if (a === b) return false;
  return a < b ? now >= a && now < b : now >= a || now < b;
}

// Hard limits the firmware enforces whatever the config says.
export const LIMITS = { minOnSec: 1, maxOnSec: 30, minOffSec: 30, maxOffSec: 3600 };

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * Work out the current mist cycle.
 * @param {object} cfg   full tower config (see defaults.js)
 * @param {{airTemp:number, humidity:number}} air  latest air reading
 * @param {Date} date    local time on the tower
 * @returns {{onSec:number, offSec:number, night:boolean, rule:string}}
 */
export function mistPlan(cfg, air, date = new Date()) {
  const m = cfg.mist;
  let onSec, offSec, rule;
  const t = air?.airTemp;

  if (m.mode === "fixed" || !isFinite(t)) {
    onSec = m.fixed.onSec;
    offSec = m.fixed.offSec;
    rule = isFinite(t) ? "Fixed timing" : "Fixed timing (no air reading)";
  } else if (m.mode === "vpd") {
    const d = vpd(t, air.humidity);
    if (!isFinite(d)) {
      onSec = m.fixed.onSec; offSec = m.fixed.offSec; rule = "Fixed timing (no humidity reading)";
    } else {
      onSec = m.vpd.onSec;
      offSec = clamp(m.vpd.baseOffSec * (m.vpd.refKpa / Math.max(d, 0.1)), m.vpd.minOffSec, m.vpd.maxOffSec);
      rule = `VPD ${d.toFixed(2)} kPa`;
    }
  } else {
    // Temperature bands, sorted by upper limit; the last band has upTo = null.
    const bands = [...m.bands].sort((a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity));
    const i = bands.findIndex((b) => b.upTo == null || t < b.upTo);
    const band = bands[i === -1 ? bands.length - 1 : i];
    onSec = band.onSec;
    offSec = band.offSec;
    rule = bandLabel(bands, i === -1 ? bands.length - 1 : i);
  }

  const night = !!(m.night?.enabled && inWindow(date, m.night.start, m.night.end));
  if (night) offSec *= m.night.offMultiplier || 1;

  return {
    onSec: clamp(Math.round(onSec * 10) / 10, LIMITS.minOnSec, LIMITS.maxOnSec),
    offSec: Math.round(clamp(offSec, LIMITS.minOffSec, LIMITS.maxOffSec)),
    night,
    rule: night ? `${rule}, night` : rule,
  };
}

export function bandLabel(sortedBands, i) {
  const lo = i === 0 ? null : sortedBands[i - 1].upTo;
  const hi = sortedBands[i].upTo;
  if (lo == null && hi != null) return `Below ${hi} °C`;
  if (hi == null && lo != null) return `${lo} °C and above`;
  if (lo == null && hi == null) return "All temperatures";
  return `${lo}–${hi} °C`;
}

/** 185 -> "3:05" */
export function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}
