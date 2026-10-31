/*
  Garden Tower firmware — ESP32 DevKit V1
  High-pressure aeroponic tower controller.

  The tower runs entirely on its own: mist schedule, accumulator pump,
  dosing and alerts all keep working without Wi-Fi or the dashboard.
  MQTT is only used to report readings and receive new settings.

  Setup: copy secrets.example.h to secrets.h and fill it in.
  Libraries (Arduino IDE → Library Manager): PubSubClient (Nick O'Leary),
  ArduinoJson (Benoit Blanchon, version 7).
  Board: "ESP32 Dev Module" (esp32 by Espressif Systems, 3.x).
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <time.h>
#include <sys/time.h>

#include "secrets.h"
#include "certs.h"
#include "tower_config.h"
#include "schedule.h"
#include "hardware.h"

#define FW_VERSION "0.1.1"

// ============================================================ state

TowerConfig cfg;
Preferences prefs;
WiFiClientSecure tlsClient;
PubSubClient mqtt(tlsClient);

const String TOPIC_BASE = String("aerotower/") + TOWER_ID + "/";
String topic(const char* leaf) { return TOPIC_BASE + leaf; }

Readings rd;
MistPlan plan;

// Misting
bool valveOpen = false;
uint32_t valveCloseAtMs = 0;
uint32_t nextMistAtMs = 0;
uint32_t lastMistMs = 0;
uint64_t lastMistEpochMs = 0;
uint64_t pausedUntilEpochMs = 0;   // 0 = not paused
uint32_t pausedUntilMs = 0;

// Accumulator pump
bool pumpOn = false;
uint32_t pumpStartMs = 0;
bool pumpFault = false;            // latched after an over-long run; cleared by "resume"

// Dosing
uint32_t doseUntilMs[PUMP_COUNT] = { 0 };
bool doseRunning[PUMP_COUNT] = { false };
double todayMl[PUMP_COUNT] = { 0 };
int todayKey = -1;                 // year*1000 + day of year
uint32_t nextDoseCheckMs = 60000;  // first auto check a minute after boot

// Networking
uint32_t lastMqttAttemptMs = 0;
uint32_t lastStateMs = 0;
bool stateDirty = false;          // something visible changed; report it soon

// Readings are sent every 10 s, and within half a second of anything changing
// (mist on/off, pump on/off, a command). That keeps the tower to roughly
// 250 MB a month, well inside a free broker's 1 GB allowance.
constexpr uint32_t STATE_EVERY_MS = 10000;
constexpr uint32_t STATE_SOON_MS = 500;
uint32_t lastLoopMs = 0;
bool wasWifiConnected = false;

// ============================================================ time helpers

bool clockValid() { return time(nullptr) > 1700000000; }  // after Nov 2023

uint64_t epochMs() {
  if (!clockValid()) return 0;
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  return (uint64_t)tv.tv_sec * 1000ULL + tv.tv_usec / 1000;
}

// Local minutes after midnight, or -1 if the clock isn't set yet.
int localMinutes() {
  if (!clockValid()) return -1;
  time_t t = time(nullptr);
  struct tm lt;
  localtime_r(&t, &lt);
  return lt.tm_hour * 60 + lt.tm_min;
}

int localDayKey() {
  if (!clockValid()) return -1;
  time_t t = time(nullptr);
  struct tm lt;
  localtime_r(&t, &lt);
  return (lt.tm_year + 1900) * 1000 + lt.tm_yday;
}

// True once `deadline` (a millis() value) has passed; safe across millis() rollover.
bool reached(uint32_t now, uint32_t deadline) { return (int32_t)(now - deadline) >= 0; }

// ============================================================ settings storage

void saveConfig() {
  JsonDocument doc;
  cfgjson::write(cfg, doc.to<JsonObject>());
  String json;
  serializeJson(doc, json);
  prefs.putString("cfg", json);
}

void loadConfig() {
  String json = prefs.getString("cfg", "");
  if (json.length() == 0) return;  // first boot: keep defaults
  JsonDocument doc;
  if (deserializeJson(doc, json) == DeserializationError::Ok) cfgjson::apply(doc.as<JsonVariantConst>(), cfg);
}

void saveDoseTotals() {
  prefs.putInt("doseDay", todayKey);
  prefs.putBytes("doseMl", todayMl, sizeof todayMl);
}

void loadDoseTotals() {
  todayKey = prefs.getInt("doseDay", -1);
  if (prefs.getBytesLength("doseMl") == sizeof todayMl) prefs.getBytes("doseMl", todayMl, sizeof todayMl);
}

// ============================================================ MQTT publishing

void publishJson(const char* leaf, JsonDocument& doc, bool retain) {
  if (!mqtt.connected()) return;
  String out;
  serializeJson(doc, out);
  mqtt.publish(topic(leaf).c_str(), (const uint8_t*)out.c_str(), out.length(), retain);
}

void publishConfig() {
  JsonDocument doc;
  cfgjson::write(cfg, doc.to<JsonObject>());
  publishJson("config", doc, true);
}

void publishEvent(const char* type, const String& text, int pump = -1, double ml = NAN, double onSec = NAN) {
  Serial.printf("[event] %s %s\n", type, text.c_str());
  if (!clockValid()) return;
  JsonDocument doc;
  doc["ts"] = epochMs();
  doc["type"] = type;
  if (text.length()) doc["text"] = text;
  if (pump >= 0) doc["pump"] = cfg.pumps[pump].key;
  if (!isnan(ml)) doc["ml"] = ml;
  if (!isnan(onSec)) doc["onSec"] = onSec;
  publishJson("event", doc, false);
}

void setNum(JsonObject o, const char* key, double v, int decimals) {
  if (isnan(v)) { o[key] = nullptr; return; }
  double f = pow(10, decimals);
  o[key] = round(v * f) / f;
}

void addAlerts(JsonArray arr) {
  auto add = [&](const char* code, const char* level, const String& text) {
    JsonObject a = arr.add<JsonObject>();
    a["code"] = code;
    a["level"] = level;
    a["text"] = text;
  };
  if (pumpFault)
    add("pump_runtime", "crit", "Pump ran over " + String((int)cfg.maxPumpRunSec) + " s and was stopped. Check for a leak or a dry reservoir, then resume misting.");
  if (!isnan(rd.psi) && rd.psi < cfg.lowAlarmPsi)
    add("pressure_low", "crit", "Accumulator pressure " + String(rd.psi, 0) + " psi, below " + String((int)cfg.lowAlarmPsi) + " psi");
  if (!isnan(rd.level) && rd.level < cfg.levelLowPct)
    add("level_low", "warn", "Reservoir at " + String(rd.level, 0) + "%. Top up soon.");
  if (!isnan(rd.waterTemp) && rd.waterTemp > cfg.waterTempHigh)
    add("water_hot", "warn", "Reservoir " + String(rd.waterTemp, 1) + " \xC2\xB0" "C. Warm water holds less oxygen.");
  if (!isnan(rd.airTemp) && rd.airTemp > cfg.airTempHigh)
    add("air_hot", "warn", "Air " + String(rd.airTemp, 1) + " \xC2\xB0" "C");
}

void publishState() {
  uint32_t now = millis();
  uint64_t nowEpoch = epochMs();
  JsonDocument doc;
  doc["ts"] = nowEpoch;

  JsonObject air = doc["air"].to<JsonObject>();
  setNum(air, "temp", rd.airTemp, 1);
  setNum(air, "rh", rd.rh, 0);

  JsonObject water = doc["water"].to<JsonObject>();
  setNum(water, "temp", rd.waterTemp, 1);
  setNum(water, "ec", rd.ec, 2);
  setNum(water, "ph", rd.ph, 2);
  setNum(water, "levelPct", rd.level, 0);

  JsonObject pr = doc["pressure"].to<JsonObject>();
  setNum(pr, "psi", rd.psi, 1);
  pr["pump"] = pumpOn;
  pr["pumpRunSec"] = pumpOn ? (now - pumpStartMs) / 1000 : 0;

  JsonObject m = doc["mist"].to<JsonObject>();
  m["active"] = valveOpen;
  m["onSec"] = plan.onSec;
  m["offSec"] = plan.offSec;
  m["rule"] = plan.rule;
  m["night"] = plan.night;
  m["nextInSec"] = valveOpen ? 0 : max((int32_t)0, (int32_t)(nextMistAtMs - now) / 1000);
  if (lastMistEpochMs) m["lastAt"] = lastMistEpochMs; else m["lastAt"] = nullptr;
  if (pausedUntilEpochMs) m["pausedUntil"] = pausedUntilEpochMs; else m["pausedUntil"] = nullptr;

  JsonObject d = doc["dosing"].to<JsonObject>();
  d["auto"] = cfg.autoDose;
  JsonObject t = d["todayMl"].to<JsonObject>();
  for (int i = 0; i < PUMP_COUNT; i++) t[cfg.pumps[i].key] = round(todayMl[i] * 10) / 10;
  d["nextCheckInSec"] = max((int32_t)0, (int32_t)(nextDoseCheckMs - now) / 1000);

  addAlerts(doc["alerts"].to<JsonArray>());

  JsonObject dev = doc["device"].to<JsonObject>();
  dev["uptimeSec"] = now / 1000;
  dev["rssi"] = WiFi.RSSI();
  dev["fw"] = anySimulated() ? FW_VERSION " (simulated sensors)" : FW_VERSION;
  dev["heap"] = ESP.getFreeHeap();

  publishJson("state", doc, true);
}

// ============================================================ misting

void startMist(uint32_t now, double seconds) {
  valveOpen = true;
  setValve(true);
  Serial.printf("[valve] open for %.1f s\n", seconds);
  valveCloseAtMs = now + (uint32_t)(seconds * 1000);
  lastMistMs = now;
  lastMistEpochMs = epochMs();
  nextMistAtMs = now + (uint32_t)((seconds + plan.offSec) * 1000);
  publishEvent("mist", "", -1, NAN, seconds);
  stateDirty = true;
}

bool pressureOkForMist() {
  // With no pressure reading, trust the pressure switch and mist anyway.
  return isnan(rd.psi) || rd.psi > cfg.lowAlarmPsi - 10;
}

void updateMist(uint32_t now) {
  if (valveOpen && reached(now, valveCloseAtMs)) {
    valveOpen = false;
    setValve(false);
    Serial.printf("[valve] closed, next mist in %d s\n", (int)((int32_t)(nextMistAtMs - now) / 1000));
    stateDirty = true;
  }
  if (pausedUntilEpochMs && reached(now, pausedUntilMs)) {
    pausedUntilEpochMs = 0;
    publishEvent("note", "Misting resumed");
  }
  if (!valveOpen && !pausedUntilEpochMs && reached(now, nextMistAtMs)) {
    if (pressureOkForMist()) startMist(now, plan.onSec);
    else nextMistAtMs = now + 5000;  // wait for the pump to build pressure
  }
}

// ============================================================ accumulator pump

void updatePump(uint32_t now) {
  bool want = pumpOn;
  if (pumpFault || isnan(rd.psi)) want = false;
  else if (!pumpOn && rd.psi < cfg.cutInPsi) want = true;
  else if (pumpOn && rd.psi >= cfg.cutOutPsi) want = false;

  if (want && pumpOn && now - pumpStartMs > cfg.maxPumpRunSec * 1000) {
    pumpFault = true;
    want = false;
    publishEvent("note", "Pump stopped: ran longer than " + String((int)cfg.maxPumpRunSec) + " s");
  }
  if (want != pumpOn) {
    pumpOn = want;
    if (pumpOn) pumpStartMs = now;
    setPump(pumpOn);
    stateDirty = true;
  }
}

// ============================================================ dosing

String fmt2(double v) { return String(v, 2); }

String mlText(double ml) {
  return (ml == round(ml)) ? String((int)ml) : String(ml, 1);
}

// Returns true if a dose was started.
bool dose(int i, double ml, const String& reason, uint32_t now) {
  const DosePump& p = cfg.pumps[i];
  double left = p.maxDailyMl - todayMl[i];
  if (left <= 0) {
    publishEvent("note", String(p.name.c_str()) + " skipped: daily limit of " + mlText(p.maxDailyMl) + " ml reached");
    return false;
  }
  ml = min(ml, left);
  uint32_t runMs = (uint32_t)(ml / p.mlPerSec * 1000);
  doseRunning[i] = true;
  doseUntilMs[i] = now + runMs;
  setDosePump(i, true);
  if (SIM_EC || SIM_PH) sim::dose(i, ml);
  todayMl[i] += ml;
  saveDoseTotals();
  publishEvent("dose", String(p.name.c_str()) + " " + mlText(ml) + " ml \xC2\xB7 " + reason, i, ml);
  return true;
}

void prime(int i, double seconds, uint32_t now) {
  doseRunning[i] = true;
  doseUntilMs[i] = now + (uint32_t)(seconds * 1000);
  setDosePump(i, true);
  publishEvent("note", "Primed " + String(cfg.pumps[i].name.c_str()) + " for " + mlText(seconds) + " s (" +
               mlText(round(seconds * cfg.pumps[i].mlPerSec * 10) / 10) + " ml)");
}

void autoDose(uint32_t now) {
  nextDoseCheckMs = now + (uint32_t)(cfg.mixWaitMin * 60000);
  if (!cfg.autoDose || isnan(rd.ph) || isnan(rd.ec)) return;
  // pH first: nutrient uptake depends on it. One correction per check.
  double phHi = cfg.phTarget + cfg.phBand, phLo = cfg.phTarget - cfg.phBand, ecLo = cfg.ecTarget - cfg.ecBand;
  if (rd.ph > phHi) {
    dose(PUMP_PH_DOWN, cfg.pumps[PUMP_PH_DOWN].doseMl, "pH " + fmt2(rd.ph) + " above " + fmt2(phHi), now);
  } else if (rd.ph < phLo) {
    dose(PUMP_PH_UP, cfg.pumps[PUMP_PH_UP].doseMl, "pH " + fmt2(rd.ph) + " below " + fmt2(phLo), now);
  } else if (rd.ec < ecLo) {
    String why = "EC " + fmt2(rd.ec) + " below " + fmt2(ecLo);
    dose(PUMP_A, cfg.pumps[PUMP_A].doseMl, why, now);
    dose(PUMP_B, cfg.pumps[PUMP_B].doseMl, why, now);
  }
}

void updateDosing(uint32_t now) {
  for (int i = 0; i < PUMP_COUNT; i++) {
    if (doseRunning[i] && reached(now, doseUntilMs[i])) {
      doseRunning[i] = false;
      setDosePump(i, false);
    }
  }
  int key = localDayKey();
  if (key != -1 && key != todayKey) {   // new day: reset the daily limits
    todayKey = key;
    for (double& v : todayMl) v = 0;
    saveDoseTotals();
  }
  if (reached(now, nextDoseCheckMs)) autoDose(now);
}

// ============================================================ messages from the dashboard

int pumpIndex(const char* key) {
  if (!key) return -1;
  for (int i = 0; i < PUMP_COUNT; i++) if (strcmp(cfg.pumps[i].key, key) == 0) return i;
  return -1;
}

void applyNewConfig(JsonVariantConst j) {
  TowerConfig next = cfg;
  cfgjson::apply(j, next);
  cfg = next;
  saveConfig();
  // A new schedule takes effect from the current cycle.
  plan = sched::mistPlan(cfg, rd.airTemp, rd.rh, localMinutes());
  uint32_t byNewPlan = lastMistMs + (uint32_t)((plan.onSec + plan.offSec) * 1000);
  if ((int32_t)(byNewPlan - nextMistAtMs) < 0) nextMistAtMs = byNewPlan;
  publishConfig();
  Serial.println("[config] new settings saved");
}

void handleCommand(JsonVariantConst j) {
  uint32_t now = millis();
  const char* cmd = j["cmd"] | "";
  if (!strcmp(cmd, "mist")) {
    if (!valveOpen) startMist(now, sched::clampd(j["seconds"] | plan.onSec, 1, 30));
  } else if (!strcmp(cmd, "pause")) {
    double minutes = sched::clampd(j["minutes"] | 30.0, 1, 24 * 60);
    pausedUntilMs = now + (uint32_t)(minutes * 60000);
    pausedUntilEpochMs = epochMs() ? epochMs() + (uint64_t)(minutes * 60000) : 1;
    publishEvent("note", "Misting paused for " + mlText(minutes) + " min");
  } else if (!strcmp(cmd, "resume")) {
    pausedUntilEpochMs = 0;
    if (pumpFault) { pumpFault = false; publishEvent("note", "Pump fault cleared"); }
    if ((int32_t)(nextMistAtMs - (now + 5000)) > 0) nextMistAtMs = now + 5000;
    publishEvent("note", "Misting resumed");
  } else if (!strcmp(cmd, "dose")) {
    int i = pumpIndex(j["pump"]);
    if (i >= 0) dose(i, sched::clampd(j["ml"] | cfg.pumps[i].doseMl, 0.1, 100), "Manual dose", now);
  } else if (!strcmp(cmd, "prime")) {
    int i = pumpIndex(j["pump"]);
    if (i >= 0) prime(i, sched::clampd(j["seconds"] | 5.0, 1, 30), now);
  }
  publishState();
}

void onMqttMessage(char* rawTopic, byte* payload, unsigned int length) {
  String t(rawTopic);
  JsonDocument doc;
  if (deserializeJson(doc, payload, length) != DeserializationError::Ok) {
    Serial.printf("[mqtt] ignored bad JSON on %s\n", rawTopic);
    return;
  }
  if (t == topic("config/set")) applyNewConfig(doc.as<JsonVariantConst>());
  else if (t == topic("cmd")) handleCommand(doc.as<JsonVariantConst>());
}

// ============================================================ networking

const char* wifiReason(wl_status_t st) {
  switch (st) {
    case WL_NO_SSID_AVAIL:  return "network not found. Check the name, and that it's a 2.4 GHz network";
    case WL_CONNECT_FAILED: return "connection refused. Usually a wrong password";
    case WL_CONNECTION_LOST: return "connection lost";
    case WL_IDLE_STATUS:    return "starting";
    default:                return "still trying";
  }
}

// List the networks the ESP32 can see. It can only see 2.4 GHz networks,
// so a 5 GHz network will never appear here.
void scanWifi() {
  Serial.println("[wifi] scanning for networks...");
  int n = WiFi.scanNetworks();
  bool found = false;
  for (int i = 0; i < n && i < 20; i++) {
    bool match = WiFi.SSID(i) == WIFI_SSID;
    found |= match;
    Serial.printf("  %s %-32s signal %4d dBm  channel %2d%s\n", match ? ">" : " ",
                  WiFi.SSID(i).c_str(), (int)WiFi.RSSI(i), (int)WiFi.channel(i),
                  WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? "  (open)" : "");
  }
  if (n <= 0) Serial.println("  no networks found");
  if (found) Serial.printf("[wifi] found \"%s\", joining it\n", WIFI_SSID);
  else Serial.printf("[wifi] \"%s\" is NOT in the list. It may be 5 GHz only, out of range, or the name in secrets.h may not match exactly (capitals and spaces count).\n", WIFI_SSID);
  WiFi.scanDelete();
}

void maintainNetwork(uint32_t now) {
  bool wifiUp = WiFi.status() == WL_CONNECTED;
  if (wifiUp != wasWifiConnected) {
    wasWifiConnected = wifiUp;
    if (wifiUp) Serial.printf("[wifi] connected, IP %s, signal %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    else Serial.println("[wifi] disconnected, retrying in the background");
  }
  if (!wifiUp) {
    static uint32_t lastWifiMsgMs = 0;
    if (now - lastWifiMsgMs >= 15000) {
      lastWifiMsgMs = now;
      Serial.printf("[wifi] not connected to \"%s\": %s\n", WIFI_SSID, wifiReason(WiFi.status()));
    }
    return;
  }

  if (mqtt.connected()) {
    mqtt.loop();
    return;
  }
  // Connecting blocks for a few seconds, so never try while misting
  // or just before a mist is due.
  if (valveOpen || (int32_t)(nextMistAtMs - now) < 15000) return;
  if (now - lastMqttAttemptMs < 10000 && lastMqttAttemptMs != 0) return;
  lastMqttAttemptMs = now;

  Serial.printf("[mqtt] connecting to %s:%d ...\n", MQTT_HOST, MQTT_PORT);
  String clientId = String("tower-") + TOWER_ID + "-" + String((uint32_t)ESP.getEfuseMac(), HEX);
  bool ok = mqtt.connect(clientId.c_str(), MQTT_USER, MQTT_PASSWORD,
                         topic("status").c_str(), 1, true, "offline");
  if (!ok) {
    Serial.printf("[mqtt] failed (state %d). Check host, port, username and password.\n", mqtt.state());
    return;
  }
  Serial.println("[mqtt] connected");
  mqtt.publish(topic("status").c_str(), "online", true);
  mqtt.subscribe(topic("config/set").c_str(), 1);
  mqtt.subscribe(topic("cmd").c_str(), 1);
  publishConfig();
  publishState();
}

// ============================================================ setup / loop

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("Garden Tower " FW_VERSION);
  if (anySimulated()) Serial.println("Some sensors are simulated (see hardware.h). The blue LED shows the mist valve.");

  setupOutputs();
  Serial.printf("LED self-test: the LED on GPIO %d should flash 3 times now.\n", PIN_LED);
  ledSelfTest();
  randomSeed(esp_random());

  prefs.begin("tower", false);
  loadConfig();
  loadDoseTotals();

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  scanWifi();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  configTzTime(TIME_ZONE, "pool.ntp.org", "time.google.com");

  tlsClient.setCACert(ROOT_CA);
  tlsClient.setHandshakeTimeout(8);
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(4096);
  mqtt.setKeepAlive(30);
  mqtt.setSocketTimeout(6);
  mqtt.setCallback(onMqttMessage);

  uint32_t now = millis();
  lastLoopMs = now;
  nextMistAtMs = now + 10000;   // first mist 10 s after boot
  nextDoseCheckMs = now + 60000;
}

void loop() {
  uint32_t now = millis();
  double dt = (now - lastLoopMs) / 1000.0;
  if (dt < 0.1) { delay(5); return; }   // run the control loop ~10 times a second
  lastLoopMs = now;
  dt = min(dt, 5.0);

  int mins = localMinutes();
  rd = readSensors(dt, mins < 0 ? -1 : mins / 60.0, valveOpen, pumpOn);
  plan = sched::mistPlan(cfg, rd.airTemp, rd.rh, mins);

  updatePump(now);
  updateMist(now);
  updateDosing(now);
  maintainNetwork(now);

  uint32_t since = now - lastStateMs;
  if (clockValid() && (since >= STATE_EVERY_MS || (stateDirty && since >= STATE_SOON_MS))) {
    stateDirty = false;
    lastStateMs = now;
    publishState();
  }
}
