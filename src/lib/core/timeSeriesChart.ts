import { HLS_PROFILE, type SeriesProfile, type WaterAreaPoint } from "../dswx/timeseries";

const NS = "http://www.w3.org/2000/svg";

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/**
 * Render open and partial water area over time as an SVG line chart, with the
 * masked (cloud, snow/ice) and no-data shares of the AOI as bars on a right-hand
 * 0-100% axis. Points that errored or have no AOI pixels are skipped. `onSelect` fires
 * with the point index (into `points`) when a marker is clicked.
 */
export function renderTimeSeriesChart(
  points: WaterAreaPoint[],
  onSelect?: (index: number) => void,
  profile: SeriesProfile = HLS_PROFILE,
): SVGSVGElement {
  const W = 320;
  const H = 180;
  const m = { l: 52, r: 44, t: 8, b: 22 };
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", role: "img" });
  svg.setAttribute("aria-label", "Water area time series");

  const valid = points
    .map((p, index) => ({ p, index }))
    .filter(({ p }) => !p.error && p.totalPixels > 0);
  if (valid.length === 0) {
    const t = el("text", { x: W / 2, y: H / 2, "text-anchor": "middle", "font-size": 12, fill: "currentColor" });
    t.textContent = "No valid observations in the AOI";
    svg.append(t);
    return svg;
  }

  const times = valid.map(({ p }) => Date.parse(p.time));
  const t0 = Math.min(...times);
  const t1 = Math.max(...times);
  const yMax = Math.max(...valid.map(({ p }) => p.openKm2 + p.partialKm2), 1e-9);
  const x = (t: number) => m.l + (t1 === t0 ? (W - m.l - m.r) / 2 : ((t - t0) / (t1 - t0)) * (W - m.l - m.r));
  const y = (v: number) => H - m.b - (v / yMax) * (H - m.t - m.b);

  svg.append(
    el("line", { x1: m.l, y1: H - m.b, x2: W - m.r, y2: H - m.b, stroke: "#8888" }),
    el("line", { x1: m.l, y1: m.t, x2: m.l, y2: H - m.b, stroke: "#8888" }),
  );
  const label = (text: string, attrs: Record<string, string | number>) => {
    const t = el("text", { "font-size": 10, fill: "currentColor", ...attrs });
    t.textContent = text;
    svg.append(t);
  };
  label(yMax.toPrecision(3), { x: m.l - 4, y: m.t + 8, "text-anchor": "end" });
  label("0", { x: m.l - 4, y: H - m.b, "text-anchor": "end" });
  label("100%", { x: W - m.r + 4, y: m.t + 8 });
  label("0%", { x: W - m.r + 4, y: H - m.b });
  const midY = (m.t + H - m.b) / 2;
  const axisTitle = (text: string, cx: number, rotate: number) =>
    label(text, { x: cx, y: midY, "text-anchor": "middle", transform: `rotate(${rotate} ${cx} ${midY})` });
  axisTitle("Area (km²)", 9, -90);
  axisTitle("Invalid coverage (%)", W - 9, 90);
  label(new Date(t0).toISOString().slice(0, 10), { x: m.l, y: H - 6 });
  label(new Date(t1).toISOString().slice(0, 10), { x: W - m.r, y: H - 6, "text-anchor": "end" });

  const series: Array<[string, (p: WaterAreaPoint) => number, string]> = [
    ["Open water", (p) => p.openKm2, "#2563eb"],
    [`Open + ${profile.partialLabel}`, (p) => p.openKm2 + p.partialKm2, "#93c5fd"],
  ];
  const yPct = (f: number) => H - m.b - f * (H - m.t - m.b);
    const coverage: Array<[string, (p: WaterAreaPoint) => number, string]> = [
    [`Masked (${profile.maskedLabel})`, (p) => p.maskedFraction, "#6b7280"],
    ["No data", (p) => p.noDataFraction, "#d97706"],
  ];
  // Grouped bars, one slot per observation, sized to the closest pair so they
  // never overlap. Drawn first so the water markers stay on top and clickable.
  const xs = valid.map(({ p }) => x(Date.parse(p.time))).sort((u, v) => u - v);
  let gap = W - m.l - m.r;
  for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] > 0) gap = Math.min(gap, xs[i] - xs[i - 1]);
  const slot = Math.min(gap * 0.8, 10);
  const barW = slot / coverage.length;
  coverage.forEach(([name, value, color], k) => {
    for (const { p } of valid) {
      const top = yPct(value(p));
      const bar = el("rect", {
        x: (x(Date.parse(p.time)) - slot / 2 + k * barW).toFixed(1),
        y: top.toFixed(1),
        width: barW.toFixed(1),
        height: Math.max(0, H - m.b - top).toFixed(1),
        fill: color,
        "fill-opacity": 0.55,
      });
      const title = el("title", {});
      title.textContent = `${name}: ${(value(p) * 100).toFixed(0)}% of AOI`;
      bar.append(title);
      svg.append(bar);
    }
  });
  for (const [name, value, color] of series) {
    const d = valid
      .map(({ p }, i) => `${i ? "L" : "M"}${x(Date.parse(p.time)).toFixed(1)},${y(value(p)).toFixed(1)}`)
      .join("");
    svg.append(el("path", { d, fill: "none", stroke: color, "stroke-width": 1.5 }));
    for (const { p, index } of valid) {
      const c = el("circle", {
        cx: x(Date.parse(p.time)),
        cy: y(value(p)),
        r: 3.5,
        fill: color,
        // Hazy observations are less trustworthy: fade by unusable share.
        "fill-opacity": Math.max(0.25, 1 - p.maskedFraction - p.noDataFraction),
        style: "cursor:pointer",
      });
      const title = el("title", {});
      title.textContent = `${name}: ${value(p).toFixed(3)} km² — ${p.time.slice(0, 16).replace("T", " ")} ${p.sensor}, ${(p.maskedFraction * 100).toFixed(0)}% masked, ${(p.noDataFraction * 100).toFixed(0)}% no data`;
      c.append(title);
      c.addEventListener("click", () => onSelect?.(index));
      svg.append(c);
    }
  }
  // Legend below the axes: lines for the water series, swatches for the bars.
  const LEGEND_H = 30;
  svg.setAttribute("viewBox", `0 0 ${W} ${H + LEGEND_H}`);
  const entries: Array<[string, string, "line" | "bar"]> = [
    ...series.map(([name, , color]): [string, string, "line" | "bar"] => [name, color, "line"]),
    ...coverage.map(([name, , color]): [string, string, "line" | "bar"] => [name, color, "bar"]),
  ];
  entries.forEach(([name, color, kind], i) => {
    const lx = 14 + (i % 2) * 140;
    const ly = H + 8 + Math.floor(i / 2) * 13;
    svg.append(
      kind === "line"
        ? el("line", { x1: lx, y1: ly, x2: lx + 12, y2: ly, stroke: color, "stroke-width": 2 })
        : el("rect", { x: lx, y: ly - 4, width: 12, height: 8, fill: color, "fill-opacity": 0.55 }),
    );
    const t = el("text", { x: lx + 16, y: ly + 3, "font-size": 9, fill: "currentColor" });
    t.textContent = name;
    svg.append(t);
  });
  return svg;
}
