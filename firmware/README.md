# Garden Tower firmware

Firmware for an **ESP32 DevKit V1** that runs the tower and talks to the dashboard.

It works on a bare board straight away: every sensor is simulated until you wire the real one, and the board's **blue LED lights whenever the mist valve would be open**. So you can test the whole system (schedule, Mist now, pausing, settings, dosing) from your phone before buying any parts.

## What you need

- ESP32 DevKit V1 and a USB cable that carries data (some are charge-only)
- Arduino IDE 2
- A free EMQX Cloud account (steps below)

## 1. Create a free MQTT broker (EMQX Cloud)

EMQX Cloud Serverless is free for good with no credit card. Its monthly allowance is 1 million connection-minutes and 1 GB of data; one tower uses about 5% and 25% of those.

1. Sign up at <https://accounts.emqx.com/signup> and log in to the EMQX Cloud console.
2. Create a new **Serverless** deployment. Pick the region closest to you and set the **spend limit to 0**, so it only ever uses the free allowance and can never charge you.
3. When it's running, open it. The **Overview** page shows the **Address** (something like `a1b2c3d4.ala.us-east-1.emqxsl.com`) and the ports: **8883** for MQTT over TLS and **8084** for WebSocket over TLS.
4. Go to **Access Control → Client Authentication** and add two username/password pairs:
   - `tower` with a strong password, used by the ESP32
   - `dashboard` with a different password, used by the web app

The ESP32 connects to the Address on port **8883**. The dashboard connects with `wss://<Address>:8084/mqtt`.

## 2. Set up the Arduino IDE

1. **Board support:** open *Tools → Board → Boards Manager*, search for **esp32** and install **esp32 by Espressif Systems** (version 3.x).
2. **Libraries:** open *Tools → Manage Libraries* and install:
   - **PubSubClient** by Nick O'Leary
   - **ArduinoJson** by Benoit Blanchon (version 7)
3. Open `firmware/GardenTower/GardenTower.ino`. The other files open as tabs.
4. Choose *Tools → Board → esp32 → **ESP32 Dev Module***, and pick the board's port under *Tools → Port*.

## 3. Add your details

Copy `secrets.example.h` to a new file called **`secrets.h`** in the same folder, and fill in:

- your Wi-Fi name and password (the ESP32 only works on **2.4 GHz** Wi-Fi)
- the EMQX deployment Address and the `tower` username and password
- the tower ID, `tower1` unless you change it in the dashboard too

`secrets.h` is excluded from Git, so your passwords stay off GitHub.

## 4. Upload and watch it start

Click **Upload**. If it hangs at "Connecting…", hold the board's **BOOT** button until the upload starts.

Open *Tools → Serial Monitor* at **115200 baud**. You should see:

```
Garden Tower 0.1.0
Some sensors are simulated (see hardware.h). The blue LED shows the mist valve.
[wifi] connected, IP 192.168.1.42, signal -58 dBm
[event] mist
[mqtt] connecting to a1b2c3d4.ala.us-east-1.emqxsl.com:8883 ...
[mqtt] connected
```

The first mist happens 10 seconds after boot. The LED comes on for 3–5 seconds, then waits a few minutes, following the schedule.

## 5. Connect the dashboard

In the dashboard, go to **Setup → My tower (MQTT)** and enter:

- Broker address: `wss://<Address>:8084/mqtt`
- Username and password: the `dashboard` credentials
- Tower ID: `tower1`

The pill in the top corner should change to **Tower online**. Things to try:

- **Mist now:** the LED lights straight away.
- **Pause 30 min:** the LED stops; **Resume misting** starts it again.
- **Schedule:** change the timing and **Send to tower**. The page says *Saved to the tower* when the ESP32 confirms.
- **Unplug the ESP32:** the pill shows **Tower offline** within a minute. Plug it back in and it reconnects with your saved settings.

## Wiring real hardware later

Pins are set at the top of `hardware.h`:

| Pin | Use |
|---|---|
| GPIO 2 | Built-in LED, mirrors the mist valve |
| GPIO 26 | Mist solenoid valve (through a MOSFET or relay) |
| GPIO 27 | High-pressure pump relay |
| GPIO 32 / 33 | Nutrient A / B peristaltic pumps |
| GPIO 25 / 14 | pH down / pH up peristaltic pumps |
| GPIO 34 | Pressure transducer, analog in (0.5–4.5 V through a divider) |

When a real sensor is wired, set its `SIM_...` flag in `hardware.h` to `false` and fill in its `read...Real()` function. Sensors you haven't added yet keep working as simulated, and anything reading `NAN` shows as *No reading* on the dashboard.

Never connect a pump, valve or solenoid directly to an ESP32 pin. Drive them through a MOSFET module or relay board, with a flyback diode on any coil. If your relay board switches on with a LOW signal, set `RELAY_ACTIVE_LOW` to `true`.

## How it behaves

- **The schedule always runs locally.** Wi-Fi or broker outages don't stop misting. Settings are kept in flash and survive power cuts.
- **Mist timing** uses exactly the same rules as the dashboard (`schedule.h` is a port of `js/schedule.js`, checked against it on 2,016 cases).
- **The accumulator pump** starts below the cut-in pressure and stops at the cut-out. If it runs longer than the limit, it stops and raises an alert, which usually means a leak or a dry reservoir. Fix the cause, then press **Resume misting** to clear it.
- **Misting waits for pressure:** if the accumulator is too low, the tower waits for the pump instead of spraying weakly.
- **Dosing** corrects pH first, then EC, one small dose per check, and never goes past each pump's daily limit, even for manual doses. Daily totals reset at local midnight and survive restarts.
- **Night mode** needs the clock, which is set over the internet (NTP) once Wi-Fi connects. Until then, the night multiplier is skipped.
