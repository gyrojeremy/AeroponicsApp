// Thin wrapper around Chart.js so every chart shares one look:
// 2px lines, faint grid, theme-aware colors, crosshair + tooltip on hover.

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const crosshair = {
  id: "crosshair",
  afterDatasetsDraw(chart) {
    const a = chart.tooltip?.getActiveElements?.() || [];
    if (!a.length) return;
    const x = a[0].element.x, { top, bottom } = chart.chartArea, ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = css("--ink-2");
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
    ctx.restore();
  },
};

function withAlpha(hex, a) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

const timeFmt = (hours) => (v) => {
  const d = new Date(v);
  if (hours > 30) return d.toLocaleDateString([], { weekday: "short" }) + " " + d.toLocaleTimeString([], { hour: "numeric" });
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} o
 *   series: [{label, color: "--accent", data: [{x, y}] }]
 *   x: { min, max, kind: "time"|"number", fmt?, title? }
 *   y: { min?, max?, fmt, suggestedMin?, suggestedMax? }
 *   stepped, band: {lo, hi} target band drawn behind the line
 */
export function lineChart(canvas, o) {
  if (!window.Chart) return null;
  const ink2 = css("--ink-2"), line = css("--line"), surface = css("--surface"), ink = css("--ink");
  const single = o.series.length === 1;
  const hours = (o.x.max - o.x.min) / 3600_000;
  const xFmt = o.x.fmt || (o.x.kind === "time" ? timeFmt(hours) : (v) => v);

  const bandPlugin = {
    id: "band",
    beforeDatasetsDraw(chart) {
      if (!o.band) return;
      const { ctx, chartArea: ca, scales: { y } } = chart;
      const top = y.getPixelForValue(o.band.hi), bot = y.getPixelForValue(o.band.lo);
      ctx.save();
      ctx.fillStyle = withAlpha(css("--good"), 0.12);
      ctx.fillRect(ca.left, Math.max(top, ca.top), ca.right - ca.left, Math.min(bot, ca.bottom) - Math.max(top, ca.top));
      ctx.restore();
    },
  };

  return new Chart(canvas, {
    type: "line",
    data: {
      datasets: o.series.map((s) => {
        const c = css(s.color);
        return {
          label: s.label,
          data: s.data,
          borderColor: c,
          backgroundColor: single ? withAlpha(c, 0.1) : c,
          fill: single ? "start" : false,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: c,
          pointHoverBorderColor: surface,
          pointHoverBorderWidth: 2,
          stepped: o.stepped ? "after" : false,
          tension: o.stepped ? 0 : 0.25,
          spanGaps: 15 * 60_000,
        };
      }),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      normalized: true,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        decimation: { enabled: true, algorithm: "lttb", samples: 300 },
        tooltip: {
          backgroundColor: surface, titleColor: ink, bodyColor: ink, borderColor: line, borderWidth: 1,
          padding: 10, boxPadding: 4, usePointStyle: true,
          callbacks: {
            title: (items) => (items.length ? (o.x.kind === "time"
              ? new Date(items[0].parsed.x).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })
              : (o.x.tipFmt || xFmt)(items[0].parsed.x)) : ""),
            label: (item) => `${item.dataset.label}: ${o.y.fmt(item.parsed.y)}`,
          },
        },
      },
      scales: {
        x: {
          type: "linear", min: o.x.min, max: o.x.max,
          grid: { display: false },
          border: { color: line },
          ticks: { color: ink2, maxTicksLimit: 6, callback: xFmt, maxRotation: 0, font: { size: 11 } },
          title: o.x.title ? { display: true, text: o.x.title, color: ink2, font: { size: 11 } } : undefined,
        },
        y: {
          min: o.y.min, max: o.y.max, suggestedMin: o.y.suggestedMin, suggestedMax: o.y.suggestedMax,
          grid: { color: withAlpha(line.startsWith("#") ? line : "#888888", 0.7), drawTicks: false },
          border: { display: false },
          ticks: { color: ink2, maxTicksLimit: 5, padding: 6, callback: (v) => o.y.fmt(v, true), font: { size: 11 } },
        },
      },
    },
    plugins: [crosshair, bandPlugin],
  });
}
