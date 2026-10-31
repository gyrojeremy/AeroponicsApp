// Mist timing rules. This is a line-for-line port of js/schedule.js in the
// dashboard, so the tower and the dashboard's preview always agree.
// No Arduino-specific code here, so it can also be tested on a PC.
#pragma once
#include <cmath>
#include <string>
#include <vector>
#include <algorithm>
#include <cstdio>
#include "tower_config.h"

struct MistPlan {
  double onSec;
  double offSec;
  bool night;
  std::string rule;
};

namespace sched {

constexpr double MIN_ON_SEC = 1, MAX_ON_SEC = 30, MIN_OFF_SEC = 30, MAX_OFF_SEC = 3600;

inline double clampd(double v, double lo, double hi) { return std::min(std::max(v, lo), hi); }

// Saturation vapour pressure in kPa (Tetens).
inline double svp(double t) { return 0.6108 * std::exp((17.27 * t) / (t + 237.3)); }

// Vapour pressure deficit of the air in kPa. NAN if either reading is missing.
inline double vpd(double t, double rh) {
  if (std::isnan(t) || std::isnan(rh)) return NAN;
  return svp(t) * (1 - clampd(rh, 0, 100) / 100);
}

// "HH:MM" -> minutes after midnight.
inline int hhmmToMin(const std::string& s) {
  int h = 0, m = 0;
  std::sscanf(s.c_str(), "%d:%d", &h, &m);
  return ((h * 60 + m) % 1440 + 1440) % 1440;
}

// True when nowMin falls inside a start–end window that may cross midnight.
inline bool inWindow(int nowMin, const std::string& start, const std::string& end) {
  int a = hhmmToMin(start), b = hhmmToMin(end);
  if (a == b) return false;
  return a < b ? (nowMin >= a && nowMin < b) : (nowMin >= a || nowMin < b);
}

// Format a number the way JavaScript's `${n}` does for the values we use: 15, 22.5
inline std::string fmtNum(double v) {
  char buf[24];
  std::snprintf(buf, sizeof buf, "%.6g", v);
  return buf;
}

inline double upperOf(const Band& b) { return std::isnan(b.upTo) ? INFINITY : b.upTo; }

inline std::string bandLabel(const std::vector<Band>& sorted, size_t i) {
  bool hasLo = i > 0, hasHi = !std::isnan(sorted[i].upTo);
  double lo = hasLo ? sorted[i - 1].upTo : NAN, hi = sorted[i].upTo;
  if (hasLo && std::isnan(lo)) hasLo = false;
  // ° is written as UTF-8 so it matches the dashboard exactly.
  if (!hasLo && hasHi) return "Below " + fmtNum(hi) + " \xC2\xB0" "C";
  if (hasLo && !hasHi) return fmtNum(lo) + " \xC2\xB0" "C and above";
  if (!hasLo && !hasHi) return "All temperatures";
  return fmtNum(lo) + "\xE2\x80\x93" + fmtNum(hi) + " \xC2\xB0" "C";
}

/**
 * Work out the current mist cycle.
 * airTemp / rh: latest air reading (NAN if missing)
 * nowMin: local minutes after midnight, or -1 when the clock isn't set yet
 */
inline MistPlan mistPlan(const TowerConfig& c, double airTemp, double rh, int nowMin) {
  double onSec, offSec;
  std::string rule;

  if (c.mode == "fixed" || std::isnan(airTemp)) {
    onSec = c.fixedOn;
    offSec = c.fixedOff;
    rule = std::isnan(airTemp) ? "Fixed timing (no air reading)" : "Fixed timing";
  } else if (c.mode == "vpd") {
    double d = vpd(airTemp, rh);
    if (std::isnan(d)) {
      onSec = c.fixedOn; offSec = c.fixedOff; rule = "Fixed timing (no humidity reading)";
    } else {
      onSec = c.vpdOn;
      offSec = clampd(c.vpdBaseOff * (c.vpdRefKpa / std::max(d, 0.1)), c.vpdMinOff, c.vpdMaxOff);
      char buf[32];
      std::snprintf(buf, sizeof buf, "VPD %.2f kPa", d);
      rule = buf;
    }
  } else {
    std::vector<Band> bands(c.bands.begin(), c.bands.end());
    std::stable_sort(bands.begin(), bands.end(), [](const Band& a, const Band& b) { return upperOf(a) < upperOf(b); });
    size_t i = bands.size() - 1;
    for (size_t k = 0; k < bands.size(); k++) {
      if (std::isnan(bands[k].upTo) || airTemp < bands[k].upTo) { i = k; break; }
    }
    onSec = bands[i].onSec;
    offSec = bands[i].offSec;
    rule = bandLabel(bands, i);
  }

  bool night = c.nightEnabled && nowMin >= 0 && inWindow(nowMin, c.nightStart, c.nightEnd);
  if (night) offSec *= (c.nightMult > 0 ? c.nightMult : 1);

  MistPlan p;
  p.onSec = clampd(std::round(onSec * 10) / 10, MIN_ON_SEC, MAX_ON_SEC);
  p.offSec = std::round(clampd(offSec, MIN_OFF_SEC, MAX_OFF_SEC));
  p.night = night;
  p.rule = night ? rule + ", night" : rule;
  return p;
}

}  // namespace sched
