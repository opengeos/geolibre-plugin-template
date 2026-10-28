import type { WaterAreaPoint } from "../dswx/timeseries";

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
 * Render open and partial water area over time as an SVG line chart. Points
 * that errored or have no pixels are skipped. `onSelect` fires with the point
 * index (into `points`) when a marker is clicked.
 */
export function renderTimeSeriesChart(
  points: WaterAreaPoint[],
  onSelect?: (index: number) => void,
): SVGSVGElement {
  const W = 320;
  const H = 180;
  const m = { l: 44, r: 8, t: 8, b: 22 };
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", role: "img" });
  svg.setAttribute("aria-label", "Water area time series");

  const valid = points
    .map((p, index) => ({ p, index }))
    .filter(({ p }) => !p.error && p.pixels > 0);
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
  label(`${yMax.toPrecision(3)} km²`, { x: m.l - 4, y: m.t + 8, "text-anchor": "end" });
  label("0", { x: m.l - 4, y: H - m.b, "text-anchor": "end" });
  label(new Date(t0).toISOString().slice(0, 10), { x: m.l, y: H - 6 });
  label(new Date(t1).toISOString().slice(0, 10), { x: W - m.r, y: H - 6, "text-anchor": "end" });

  const series: Array<[string, (p: WaterAreaPoint) => number, string]> = [
    ["Open water", (p) => p.openKm2, "#2563eb"],
    ["Open + partial water", (p) => p.openKm2 + p.partialKm2, "#93c5fd"],
  ];
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
        // Hazy observations are less trustworthy: fade by obscured share.
        "fill-opacity": Math.max(0.25, 1 - p.obscuredFraction),
        style: "cursor:pointer",
      });
      const title = el("title", {});
      title.textContent = `${name}: ${value(p).toFixed(3)} km² — ${p.time.slice(0, 16).replace("T", " ")} ${p.sensor}, ${(p.obscuredFraction * 100).toFixed(0)}% obscured`;
      c.append(title);
      c.addEventListener("click", () => onSelect?.(index));
      svg.append(c);
    }
  }
  return svg;
}
