// Live connection to the ESP32 through an MQTT broker over secure WebSockets.
// GitHub Pages is served over HTTPS, so the browser can only reach the tower
// through a wss:// broker (for example a free HiveMQ Cloud or EMQX Cloud
// cluster). The ESP32 connects to the same broker. See README.md for topics.

const MQTT_SRC = "https://unpkg.com/mqtt@5.10.1/dist/mqtt.min.js";

let loading = null;
function loadMqtt() {
  if (window.mqtt) return Promise.resolve(window.mqtt);
  loading ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = MQTT_SRC;
    s.onload = () => resolve(window.mqtt);
    s.onerror = () => { loading = null; reject(new Error("Couldn't load the MQTT library. Check your internet connection.")); };
    document.head.appendChild(s);
  });
  return loading;
}

export class MqttTower {
  constructor({ url, username, password, towerId }) {
    this.opts = { url, username, password, towerId };
    this.base = `aerotower/${towerId}`;
    this.listeners = {};
    this.client = null;
  }

  get kind() { return "mqtt"; }

  on(type, fn) {
    (this.listeners[type] ||= []).push(fn);
    return this;
  }
  emit(type, payload) {
    (this.listeners[type] || []).forEach((fn) => fn(payload));
  }

  async connect() {
    const mqtt = await loadMqtt();
    const { url, username, password } = this.opts;
    if (!/^wss?:\/\//.test(url)) throw new Error("The broker address must start with wss://");
    return new Promise((resolve, reject) => {
      let settled = false;
      const c = mqtt.connect(url, {
        username: username || undefined,
        password: password || undefined,
        clientId: "dash-" + Math.random().toString(16).slice(2, 10),
        reconnectPeriod: 5000,
        connectTimeout: 10_000,
        clean: true,
      });
      this.client = c;
      c.on("connect", () => {
        c.subscribe([`${this.base}/state`, `${this.base}/config`, `${this.base}/event`, `${this.base}/status`], { qos: 1 });
        this.emit("link", "connected");
        if (!settled) { settled = true; resolve(true); }
      });
      c.on("reconnect", () => this.emit("link", "reconnecting"));
      c.on("offline", () => this.emit("link", "offline"));
      c.on("error", (err) => {
        this.emit("link", "error");
        if (!settled) { settled = true; c.end(true); reject(new Error(friendly(err))); }
      });
      c.on("message", (topic, buf) => this.onMessage(topic, buf.toString()));
    });
  }

  onMessage(topic, text) {
    const leaf = topic.slice(this.base.length + 1);
    if (leaf === "status") return this.emit("status", text.trim() === "online" ? "online" : "offline");
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (leaf === "state") this.emit("state", msg);
    else if (leaf === "config") this.emit("config", msg);
    else if (leaf === "event") this.emit("event", msg);
  }

  publish(leaf, obj, retain = false) {
    if (!this.client?.connected) throw new Error("Not connected to the broker.");
    this.client.publish(`${this.base}/${leaf}`, JSON.stringify(obj), { qos: 1, retain });
  }

  // Retained, so a tower that is offline right now picks it up when it reconnects.
  setConfig(cfg) { this.publish("config/set", cfg, true); }
  command(cmd) { this.publish("cmd", cmd); }

  disconnect() {
    this.client?.end(true);
    this.client = null;
    this.emit("link", "offline");
  }
}

function friendly(err) {
  const m = String(err?.message || err);
  if (/not authorized|bad user name|password/i.test(m)) return "The broker rejected the username or password.";
  return `Couldn't reach the broker (${m}). Check the address and port.`;
}
