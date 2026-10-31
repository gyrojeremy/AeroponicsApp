// Default tower configuration. The ESP32 firmware ships with the same values
// and stores whatever the dashboard sends in flash (NVS).
// Starting points for high-pressure aeroponics (HPA) — tune for your nozzles.

export const DEFAULT_CONFIG = {
  version: 1,
  towerName: "Garden Tower",

  mist: {
    mode: "bands", // "fixed" | "bands" | "vpd"
    fixed: { onSec: 3, offSec: 300 },
    // Each band applies below its `upTo` temperature (°C). Last band: upTo null.
    bands: [
      { upTo: 15, onSec: 3, offSec: 480 },
      { upTo: 22, onSec: 3, offSec: 300 },
      { upTo: 28, onSec: 4, offSec: 180 },
      { upTo: null, onSec: 5, offSec: 120 },
    ],
    // VPD mode: off time = baseOffSec × (refKpa ÷ current VPD), clamped.
    vpd: { onSec: 3, baseOffSec: 300, refKpa: 1.0, minOffSec: 90, maxOffSec: 900 },
    night: { enabled: true, start: "20:30", end: "06:30", offMultiplier: 2 },
  },

  pressure: {
    cutInPsi: 80,     // pump starts refilling the accumulator below this
    cutOutPsi: 100,   // pump stops at this
    lowAlarmPsi: 65,  // alert if pressure falls this low
    maxPumpRunSec: 120, // alert and stop the pump if it runs longer than this
  },

  dosing: {
    auto: true,
    ec: { target: 1.6, band: 0.15 },  // mS/cm
    ph: { target: 5.9, band: 0.2 },
    mixWaitMin: 10,                    // wait between auto doses
    pumps: {
      a:      { name: "Nutrient A", mlPerSec: 1.0, doseMl: 2, maxDailyMl: 40 },
      b:      { name: "Nutrient B", mlPerSec: 1.0, doseMl: 2, maxDailyMl: 40 },
      phDown: { name: "pH down",    mlPerSec: 0.8, doseMl: 1, maxDailyMl: 10 },
      phUp:   { name: "pH up",      mlPerSec: 0.8, doseMl: 1, maxDailyMl: 10 },
    },
  },

  alerts: {
    airTempHigh: 32,
    waterTempHigh: 24,
    levelLowPct: 20,
  },
};

export const PUMP_ORDER = ["a", "b", "phDown", "phUp"];

export function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

/** Fill any keys missing from an older or partial config with defaults. */
export function mergeDefaults(cfg, def = DEFAULT_CONFIG) {
  if (cfg == null || typeof cfg !== "object" || Array.isArray(cfg)) return clone(def);
  const out = Array.isArray(def) ? [] : {};
  for (const k of Object.keys(def)) {
    const d = def[k], v = cfg[k];
    if (Array.isArray(d)) out[k] = Array.isArray(v) ? clone(v) : clone(d);
    else if (d && typeof d === "object") out[k] = mergeDefaults(v, d);
    else out[k] = v === undefined ? d : v;
  }
  return out;
}
