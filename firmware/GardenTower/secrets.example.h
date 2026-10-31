// Copy this file to secrets.h (same folder) and fill in your details.
// secrets.h is listed in .gitignore so your passwords never go to GitHub.
#pragma once

// Your home Wi-Fi (the ESP32 only works on 2.4 GHz networks)
#define WIFI_SSID     "your-wifi-name"
#define WIFI_PASSWORD "your-wifi-password"

// Your MQTT broker. For EMQX Cloud Serverless, copy the "Address" from the
// deployment's Overview page; it looks like "a1b2c3d4.ala.us-east-1.emqxsl.com".
// The TLS port is 8883.
#define MQTT_HOST     "your-deployment.emqxsl.com"
#define MQTT_PORT     8883
#define MQTT_USER     "tower"
#define MQTT_PASSWORD "your-tower-password"

// Must match "Tower ID" in the dashboard's Setup page.
#define TOWER_ID      "tower1"

// Local time zone, used for night mode and the daily dose limits.
// New Zealand (handles daylight saving automatically):
#define TIME_ZONE     "NZST-12NZDT,M9.5.0,M4.1.0/3"
