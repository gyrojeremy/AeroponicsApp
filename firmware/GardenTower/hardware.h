// Pins, outputs and sensors for an ESP32 DevKit V1.
//
// Every sensor starts out SIMULATED, so the firmware runs on a bare board.
// As you wire each real sensor, set its SIM_ flag to false and fill in its
// read function below. Nothing else in the firmware needs to change.
#pragma once
#include <Arduino.h>

// ---------------------------------------------------------------- pins
constexpr int PIN_LED          = 2;   // built-in blue LED: lights while misting
constexpr int PIN_MIST_VALVE   = 26;  // mist solenoid, through a MOSFET or relay
constexpr int PIN_PUMP         = 27;  // high-pressure pump relay
constexpr int PIN_DOSE[4]      = { 32, 33, 25, 14 };  // Nutrient A, Nutrient B, pH down, pH up
constexpr int PIN_PRESSURE     = 34;  // analog pressure transducer (input-only pin)

// false: an output pin goes HIGH to switch something on (MOSFET boards, most SSRs).
// Many cheap relay boards switch on with LOW instead; set this to true for those.
constexpr bool RELAY_ACTIVE_LOW = false;

// ---------------------------------------------------------------- simulation switches
// true  = make up a believable value (no sensor needed)
// false = read the real sensor (fill in the matching function below)
constexpr bool SIM_AIR      = true;  // air temperature + humidity (e.g. SHT31 / BME280)
constexpr bool SIM_WATER_T  = true;  // reservoir temperature (e.g. DS18B20)
constexpr bool SIM_EC       = true;  // EC / TDS probe
constexpr bool SIM_PH       = true;  // pH probe
constexpr bool SIM_LEVEL    = true;  // reservoir level
constexpr bool SIM_PRESSURE = true;  // accumulator pressure transducer

inline bool anySimulated() {
  return SIM_AIR || SIM_WATER_T || SIM_EC || SIM_PH || SIM_LEVEL || SIM_PRESSURE;
}

struct Readings {
  double airTemp = NAN, rh = NAN, waterTemp = NAN, ec = NAN, ph = NAN, level = NAN, psi = NAN;
};

// ---------------------------------------------------------------- outputs
inline void writeOut(int pin, bool on) {
  digitalWrite(pin, (on ^ RELAY_ACTIVE_LOW) ? HIGH : LOW);
}

inline void setupOutputs() {
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, LOW);
  for (int pin : { PIN_MIST_VALVE, PIN_PUMP, PIN_DOSE[0], PIN_DOSE[1], PIN_DOSE[2], PIN_DOSE[3] }) {
    writeOut(pin, false);   // set the level before switching to output so relays don't click on at boot
    pinMode(pin, OUTPUT);
    writeOut(pin, false);
  }
}

inline void setValve(bool open) {
  writeOut(PIN_MIST_VALVE, open);
  digitalWrite(PIN_LED, open ? HIGH : LOW);
}
inline void setPump(bool on) { writeOut(PIN_PUMP, on); }
inline void setDosePump(int i, bool on) { writeOut(PIN_DOSE[i], on); }

// ---------------------------------------------------------------- real sensors
// Fill these in as the hardware arrives. Return NAN when a reading fails;
// the dashboard then shows "No reading" for it.

inline void readAirReal(double& temp, double& rh) { temp = NAN; rh = NAN; }
inline double readWaterTempReal() { return NAN; }
inline double readEcReal(double /*waterTemp*/) { return NAN; }
inline double readPhReal() { return NAN; }
inline double readLevelReal() { return NAN; }

// Typical 0.5–4.5 V, 0–200 psi transducer through a 2:3 divider (4.5 V -> 2.7 V).
inline double readPressureReal() {
  const double vAdc = analogReadMilliVolts(PIN_PRESSURE) / 1000.0;
  const double vSensor = vAdc * 1.5;          // undo the divider
  if (vSensor < 0.2) return NAN;              // disconnected
  return (vSensor - 0.5) / 4.0 * 200.0;       // 0.5 V = 0 psi, 4.5 V = 200 psi
}

// ---------------------------------------------------------------- simulation
// A small model of the tower so the firmware can be tested on a bare board.
// It reacts to the real outputs: pressure falls while the valve is open and
// rises while the pump runs; doses move EC and pH.
namespace sim {
  inline double airTemp = 20, rh = 60, waterTemp = 20, ec = 1.57, ph = 6.08, level = 74, psi = 90;

  inline double noise(double a) { return (random(-1000, 1001) / 1000.0) * a; }

  // Daily air temperature curve peaking mid-afternoon. hour < 0 if the clock isn't set.
  inline void update(double dt, double hour, bool valveOpen, bool pumpOn) {
    double h = hour < 0 ? 14 : hour;
    double t = 19 + 8.5 * sin(((h - 9) / 24.0) * 2 * PI);
    double targetRh = constrain(72 - 2.6 * (t - 18), 25.0, 95.0);
    airTemp += (t + noise(0.15) - airTemp) * 0.3;
    rh += (targetRh + noise(0.6) - rh) * 0.3;
    waterTemp += (19.5 + 0.25 * (airTemp - 18) - waterTemp) * 0.002 * dt;
    ph += 0.00004 * dt;
    ec += 0.000004 * dt;
    level = max(0.0, level - 0.00015 * dt - (valveOpen ? 0.004 * dt : 0));
    if (valveOpen) psi -= 2.6 * dt;
    if (pumpOn) psi += 1.7 * dt;
    psi = max(0.0, psi - 0.004 * dt + noise(0.05));
  }

  inline void dose(int pump, double ml) {
    if (pump == 0 || pump == 1) ec += 0.012 * ml;
    if (pump == 2) ph -= 0.07 * ml;
    if (pump == 3) ph += 0.07 * ml;
  }
}

inline Readings readSensors(double dt, double hour, bool valveOpen, bool pumpOn) {
  sim::update(dt, hour, valveOpen, pumpOn);
  Readings r;
  if (SIM_AIR) { r.airTemp = sim::airTemp; r.rh = sim::rh; } else readAirReal(r.airTemp, r.rh);
  r.waterTemp = SIM_WATER_T ? sim::waterTemp : readWaterTempReal();
  r.ec        = SIM_EC      ? sim::ec        : readEcReal(r.waterTemp);
  r.ph        = SIM_PH      ? sim::ph        : readPhReal();
  r.level     = SIM_LEVEL   ? sim::level     : readLevelReal();
  r.psi       = SIM_PRESSURE ? sim::psi      : readPressureReal();
  return r;
}
