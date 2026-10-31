// Tower settings: defaults, and conversion to and from the JSON the dashboard
// sends on config/set. Field names and defaults match js/defaults.js.
// No Arduino-specific code here, so it can also be tested on a PC.
#pragma once
#include <cmath>
#include <string>
#include <vector>
#include <ArduinoJson.h>

struct Band {
  double upTo;   // NAN = no upper limit (the last band)
  double onSec;
  double offSec;
};

struct DosePump {
  const char* key;   // a | b | phDown | phUp
  std::string name;
  double mlPerSec;
  double doseMl;
  double maxDailyMl;
};

enum PumpIndex { PUMP_A = 0, PUMP_B = 1, PUMP_PH_DOWN = 2, PUMP_PH_UP = 3, PUMP_COUNT = 4 };

struct TowerConfig {
  double version = 1;
  std::string towerName = "Garden Tower";

  // mist
  std::string mode = "bands";  // fixed | bands | vpd
  double fixedOn = 3, fixedOff = 300;
  std::vector<Band> bands = { {15, 3, 480}, {22, 3, 300}, {28, 4, 180}, {NAN, 5, 120} };
  double vpdOn = 3, vpdBaseOff = 300, vpdRefKpa = 1.0, vpdMinOff = 90, vpdMaxOff = 900;
  bool nightEnabled = true;
  std::string nightStart = "20:30", nightEnd = "06:30";
  double nightMult = 2;

  // accumulator and pump
  double cutInPsi = 80, cutOutPsi = 100, lowAlarmPsi = 65, maxPumpRunSec = 120;

  // dosing
  bool autoDose = true;
  double ecTarget = 1.6, ecBand = 0.15;
  double phTarget = 5.9, phBand = 0.2;
  double mixWaitMin = 10;
  DosePump pumps[PUMP_COUNT] = {
    { "a",      "Nutrient A", 1.0, 2, 40 },
    { "b",      "Nutrient B", 1.0, 2, 40 },
    { "phDown", "pH down",    0.8, 1, 10 },
    { "phUp",   "pH up",      0.8, 1, 10 },
  };

  // alerts
  double airTempHigh = 32, waterTempHigh = 24, levelLowPct = 20;
};

namespace cfgjson {

inline double clampd(double v, double lo, double hi) { return v < lo ? lo : v > hi ? hi : v; }

// Read a number if present and valid, otherwise keep the current value.
inline void num(JsonVariantConst v, double& out, double lo, double hi) {
  if (v.is<double>() || v.is<long>()) out = clampd(v.as<double>(), lo, hi);
}
inline void str(JsonVariantConst v, std::string& out, size_t maxLen = 40) {
  if (v.is<const char*>()) { out = v.as<const char*>(); if (out.size() > maxLen) out.resize(maxLen); }
}
inline void flag(JsonVariantConst v, bool& out) {
  if (v.is<bool>()) out = v.as<bool>();
}
inline bool validHHMM(const std::string& s) {
  int h, m;
  return s.size() == 5 && std::sscanf(s.c_str(), "%2d:%2d", &h, &m) == 2 && h >= 0 && h < 24 && m >= 0 && m < 60;
}

/** Apply a (possibly partial) settings object on top of `c`. Missing fields keep their value. */
inline void apply(JsonVariantConst j, TowerConfig& c) {
  num(j["version"], c.version, 0, 1e6);
  str(j["towerName"], c.towerName);

  JsonVariantConst m = j["mist"];
  if (!m.isNull()) {
    std::string mode = c.mode;
    str(m["mode"], mode, 8);
    if (mode == "fixed" || mode == "bands" || mode == "vpd") c.mode = mode;
    num(m["fixed"]["onSec"], c.fixedOn, 1, 30);
    num(m["fixed"]["offSec"], c.fixedOff, 30, 3600);
    JsonArrayConst arr = m["bands"].as<JsonArrayConst>();
    if (!arr.isNull() && arr.size() > 0 && arr.size() <= 8) {
      std::vector<Band> nb;
      for (JsonVariantConst b : arr) {
        Band band = { NAN, 3, 300 };
        if (b["upTo"].is<double>() || b["upTo"].is<long>()) band.upTo = clampd(b["upTo"].as<double>(), -20, 60);
        num(b["onSec"], band.onSec, 1, 30);
        num(b["offSec"], band.offSec, 30, 3600);
        nb.push_back(band);
      }
      c.bands = nb;
    }
    JsonVariantConst v = m["vpd"];
    num(v["onSec"], c.vpdOn, 1, 30);
    num(v["baseOffSec"], c.vpdBaseOff, 30, 3600);
    num(v["refKpa"], c.vpdRefKpa, 0.1, 5);
    num(v["minOffSec"], c.vpdMinOff, 30, 3600);
    num(v["maxOffSec"], c.vpdMaxOff, 30, 3600);
    JsonVariantConst n = m["night"];
    flag(n["enabled"], c.nightEnabled);
    std::string s = c.nightStart, e = c.nightEnd;
    str(n["start"], s, 5);
    str(n["end"], e, 5);
    if (validHHMM(s)) c.nightStart = s;
    if (validHHMM(e)) c.nightEnd = e;
    num(n["offMultiplier"], c.nightMult, 1, 10);
  }

  JsonVariantConst p = j["pressure"];
  num(p["cutInPsi"], c.cutInPsi, 10, 200);
  num(p["cutOutPsi"], c.cutOutPsi, 15, 200);
  num(p["lowAlarmPsi"], c.lowAlarmPsi, 5, 200);
  num(p["maxPumpRunSec"], c.maxPumpRunSec, 10, 900);

  JsonVariantConst d = j["dosing"];
  if (!d.isNull()) {
    flag(d["auto"], c.autoDose);
    num(d["ec"]["target"], c.ecTarget, 0.1, 5);
    num(d["ec"]["band"], c.ecBand, 0.01, 2);
    num(d["ph"]["target"], c.phTarget, 3, 9);
    num(d["ph"]["band"], c.phBand, 0.01, 2);
    num(d["mixWaitMin"], c.mixWaitMin, 1, 240);
    for (auto& pump : c.pumps) {
      JsonVariantConst pj = d["pumps"][pump.key];
      if (pj.isNull()) continue;
      str(pj["name"], pump.name, 24);
      num(pj["mlPerSec"], pump.mlPerSec, 0.01, 50);
      num(pj["doseMl"], pump.doseMl, 0.1, 100);
      num(pj["maxDailyMl"], pump.maxDailyMl, 0, 2000);
    }
  }

  JsonVariantConst a = j["alerts"];
  num(a["airTempHigh"], c.airTempHigh, 0, 60);
  num(a["waterTempHigh"], c.waterTempHigh, 0, 50);
  num(a["levelLowPct"], c.levelLowPct, 0, 100);

  // Keep the pressure switch and VPD limits sensible even if sent the wrong way round.
  if (c.cutOutPsi <= c.cutInPsi) c.cutOutPsi = c.cutInPsi + 10;
  if (c.vpdMinOff > c.vpdMaxOff) std::swap(c.vpdMinOff, c.vpdMaxOff);
}

/** Write the full settings object, in the same shape as js/defaults.js. */
inline void write(const TowerConfig& c, JsonObject j) {
  j["version"] = c.version;
  j["towerName"] = c.towerName;

  JsonObject m = j["mist"].to<JsonObject>();
  m["mode"] = c.mode;
  JsonObject f = m["fixed"].to<JsonObject>();
  f["onSec"] = c.fixedOn;
  f["offSec"] = c.fixedOff;
  JsonArray bands = m["bands"].to<JsonArray>();
  for (const Band& b : c.bands) {
    JsonObject o = bands.add<JsonObject>();
    if (std::isnan(b.upTo)) o["upTo"] = nullptr; else o["upTo"] = b.upTo;
    o["onSec"] = b.onSec;
    o["offSec"] = b.offSec;
  }
  JsonObject v = m["vpd"].to<JsonObject>();
  v["onSec"] = c.vpdOn;
  v["baseOffSec"] = c.vpdBaseOff;
  v["refKpa"] = c.vpdRefKpa;
  v["minOffSec"] = c.vpdMinOff;
  v["maxOffSec"] = c.vpdMaxOff;
  JsonObject n = m["night"].to<JsonObject>();
  n["enabled"] = c.nightEnabled;
  n["start"] = c.nightStart;
  n["end"] = c.nightEnd;
  n["offMultiplier"] = c.nightMult;

  JsonObject p = j["pressure"].to<JsonObject>();
  p["cutInPsi"] = c.cutInPsi;
  p["cutOutPsi"] = c.cutOutPsi;
  p["lowAlarmPsi"] = c.lowAlarmPsi;
  p["maxPumpRunSec"] = c.maxPumpRunSec;

  JsonObject d = j["dosing"].to<JsonObject>();
  d["auto"] = c.autoDose;
  JsonObject ec = d["ec"].to<JsonObject>();
  ec["target"] = c.ecTarget;
  ec["band"] = c.ecBand;
  JsonObject ph = d["ph"].to<JsonObject>();
  ph["target"] = c.phTarget;
  ph["band"] = c.phBand;
  d["mixWaitMin"] = c.mixWaitMin;
  JsonObject pumps = d["pumps"].to<JsonObject>();
  for (const auto& pump : c.pumps) {
    JsonObject o = pumps[pump.key].to<JsonObject>();
    o["name"] = pump.name;
    o["mlPerSec"] = pump.mlPerSec;
    o["doseMl"] = pump.doseMl;
    o["maxDailyMl"] = pump.maxDailyMl;
  }

  JsonObject a = j["alerts"].to<JsonObject>();
  a["airTempHigh"] = c.airTempHigh;
  a["waterTempHigh"] = c.waterTempHigh;
  a["levelLowPct"] = c.levelLowPct;
}

}  // namespace cfgjson
