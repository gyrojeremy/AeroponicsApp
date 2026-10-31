# Garden Tower

A web dashboard for a high-pressure aeroponic (HPA) garden tower run by an ESP32.

- **Tower**: countdown to the next mist, accumulator pressure, a strip of the last hour's mist pulses, live readings with target ranges, alerts and activity.
- **Schedule**: fixed timing, temperature bands, or VPD-based timing, with a longer night wait and a chart of how the wait changes with air temperature.
- **Dosing**: EC and pH targets, auto-dosing, per-pump dose sizes, daily limits and flow calibration, manual dose and prime.
- **History**: air and reservoir temperature, wait between mists, humidity, EC, pH and reservoir level over 1 hour to 7 days.
- **Setup**: broker connection, tower name, alert thresholds, settings backup and restore.

On a phone, open the dashboard and choose **Add to Home Screen** (Safari's share menu, or Chrome's menu) to install it with its own icon; it then opens full-screen like an app.

It's plain HTML, CSS and JavaScript with no build step, so it runs straight from GitHub Pages. A built-in **demo tower** simulates the hardware, so everything works before the ESP32 is wired up.

## Put it on GitHub Pages

1. Create a new repository (for example `garden-tower`) and upload these files, keeping the folders as they are.
2. In the repository go to **Settings → Pages**, set **Source** to *Deploy from a branch*, choose `main` and `/ (root)`, and save.
3. After a minute the dashboard is live at `https://<your-username>.github.io/garden-tower/`.

To try it on your computer first, run `python3 -m http.server` in this folder and open <http://localhost:8000>. Opening `index.html` directly from disk won't work because browsers block JavaScript modules on `file://`.

## The tower firmware

The [`firmware`](firmware) folder has the ESP32 firmware, ready for the Arduino IDE. It runs on a bare ESP32 DevKit V1 with simulated sensors, so you can test everything before wiring hardware. [`firmware/README.md`](firmware/README.md) walks through broker setup, uploading and the first test.

## How the pieces talk

```
 ESP32 tower  ──MQTT/TLS──►  MQTT broker  ◄──MQTT over wss://──  Dashboard (GitHub Pages)
 (runs the schedule)          (cloud)                            (shows data, edits settings)
```

GitHub Pages is served over HTTPS, and browsers won't let an HTTPS page talk to a plain `http://` ESP32 on your home network. A cloud MQTT broker gets around this and also lets you check the tower from anywhere.

**Free broker:** EMQX Cloud Serverless is free for good with no credit card (1 million connection-minutes and 1 GB of data a month; the tower uses about 5% and 25% of those). HiveMQ Cloud no longer offers a free plan to new accounts. [`firmware/README.md`](firmware/README.md) has the step-by-step setup. In short:

- Create a Serverless deployment with a spend limit of 0, so it can never charge you.
- Add one username/password for the ESP32 and one for the dashboard.
- The ESP32 connects to the deployment address on port **8883** (MQTT over TLS).
- The dashboard connects to `wss://<deployment address>:8084/mqtt`.

In the dashboard go to **Setup → My tower (MQTT)**, enter the broker address, username, password and tower ID, then **Connect**.

> The password is only stored on your device if you tick *Remember the password*. Anyone with the broker login can control the tower, so don't put it in the repository.

**The tower must not depend on the dashboard.** The ESP32 runs the mist schedule, pressure switch and dosing on its own and keeps its settings in flash. The dashboard only views data and sends new settings. If Wi-Fi or the broker drops, the tower keeps misting.

## MQTT topics

All topics start with `aerotower/<towerId>/`. Payloads are JSON unless noted.

| Topic | Direction | Retained | What it carries |
|---|---|---|---|
| `status` | tower → | yes | `online` or `offline` (plain text). Set `offline` as the tower's MQTT last will. |
| `state` | tower → | yes | Latest readings and status, every 10 seconds and straight after any change. |
| `config` | tower → | yes | The settings the tower is actually using. Published at boot and after every change. |
| `event` | tower → | no | Something happened: a mist, a dose, a note. |
| `config/set` | → tower | yes | New settings from the dashboard. Retained so an offline tower gets them when it reconnects. |
| `cmd` | → tower | no | One-off commands. |

### `state`

```json
{
  "ts": 1761893520000,
  "air":      { "temp": 24.1, "rh": 58 },
  "water":    { "temp": 20.4, "ec": 1.58, "ph": 5.95, "levelPct": 72 },
  "pressure": { "psi": 92.4, "pump": false, "pumpRunSec": 0 },
  "mist": {
    "active": false, "onSec": 4, "offSec": 180,
    "rule": "22–28 °C", "night": false,
    "nextInSec": 132, "lastAt": 1761893400000, "pausedUntil": null
  },
  "dosing": { "auto": true, "todayMl": { "a": 4, "b": 4, "phDown": 1, "phUp": 0 }, "nextCheckInSec": 300 },
  "alerts": [ { "code": "level_low", "level": "warn", "text": "Reservoir at 18%. Top up soon." } ],
  "device": { "uptimeSec": 12345, "rssi": -61, "fw": "0.1.0" }
}
```

`ts`, `lastAt` and `pausedUntil` are Unix time in milliseconds. Sync the ESP32 clock with NTP and set the timezone (for New Zealand: `NZST-12NZDT,M9.5.0,M4.1.0/3`) so night mode switches at local time. Any sensor that isn't fitted yet can be left out or sent as `null`; its tile shows "No reading".

Alert `level` is `warn` or `crit`. Codes the demo uses: `pressure_low`, `pump_runtime`, `level_low`, `water_hot`, `air_hot`.

### `event`

```json
{ "ts": 1761893400000, "type": "mist", "onSec": 4 }
{ "ts": 1761893460000, "type": "dose", "pump": "phDown", "ml": 1, "text": "pH down 1 ml · pH 6.13 above 6.10" }
{ "ts": 1761893470000, "type": "note", "text": "Misting paused for 30 min" }
```

Publish a `mist` event at the start of every mist; the pulse strip on the Tower page is drawn from them.

### `cmd`

```json
{ "cmd": "mist" }                              // mist now, using the current mist length
{ "cmd": "mist", "seconds": 5 }
{ "cmd": "pause", "minutes": 30 }
{ "cmd": "resume" }
{ "cmd": "dose", "pump": "a", "ml": 2 }        // pump: a | b | phDown | phUp
{ "cmd": "prime", "pump": "phDown", "seconds": 5 }
```

The tower should still enforce the daily dose limits on manual doses.

### `config` / `config/set`

The full settings object. [`js/defaults.js`](js/defaults.js) has every field with comments, and the tower should ship with the same defaults. When `config/set` arrives, the tower validates it, saves it to flash (Preferences/NVS), applies it from the next cycle and republishes it on `config`. The dashboard shows *Saved to the tower* when the echo matches what it sent.

## Mist timing

[`js/schedule.js`](js/schedule.js) holds the timing rules with no browser code, so it can be ported line for line to the ESP32:

- **Fixed**: the same mist length and wait all day.
- **By temperature**: the first band whose upper limit is above the current air temperature sets the mist length and wait.
- **By VPD**: wait = base wait × reference VPD ÷ current VPD, clamped between the shortest and longest wait. VPD = 0.6108·e^(17.27·T/(T+237.3)) × (1 − RH/100) kPa.
- **Night**: inside the night window the wait is multiplied (2× by default).
- Hard limits whatever the settings: mist 1–30 s, wait 30 s–60 min.

The defaults (3–5 s every 2–8 min, 80/100 psi pressure switch) are starting points for HPA with 50 µm nozzles. Watch the roots and adjust: they should stay damp but never dripping.

## History

The ESP32 doesn't store history. The dashboard records one sample a minute while it's open and keeps 7 days in the browser on that device. For continuous logs, add a small logger later, such as Node-RED or Telegraf feeding InfluxDB on a Raspberry Pi, subscribed to `aerotower/+/state`.

## Files

```
index.html          page markup
css/style.css       styles, light and dark
js/app.js           dashboard logic and rendering
js/schedule.js      mist timing rules (firmware/GardenTower/schedule.h matches it)
js/defaults.js      default settings
js/simulator.js     the demo tower
js/mqtt-link.js     live connection over MQTT/WebSockets
js/charts.js        chart styling (Chart.js)
firmware/           ESP32 firmware (see firmware/README.md)
icons/              app icon (icon.svg is the source; PNGs are rendered from it)
manifest.webmanifest  lets phones install the dashboard as an app
```

Libraries load from public CDNs: Chart.js 4.4.1 (jsDelivr) and MQTT.js 5.10.1 (unpkg, only when you connect a real tower).
