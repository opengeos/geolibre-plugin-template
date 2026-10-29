/**
 * Group DSWx granules into observations: one satellite pass is split into one
 * granule per MGRS tile, with sensing times a few seconds to a minute apart.
 * Sensors are mixed (e.g. L8 and S2C within a few hours form one observation);
 * callers pass granules from a single product, so grouping stays per product.
 */

import type { BBox, DswxGranule, Observation } from "./types";

/** Max span between the first and last granule begin times of one observation. */
export const DEFAULT_OBSERVATION_WINDOW_MINUTES = 6 * 60;

function ms(iso?: string): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? NaN : t;
}

function unionBounds(granules: DswxGranule[]): BBox | undefined {
  const boxes = granules.map((g) => g.bbox).filter((b): b is BBox => !!b);
  if (boxes.length === 0) return undefined;
  return boxes.reduce<BBox>(
    (a, b) => [
      Math.min(a[0], b[0]),
      Math.min(a[1], b[1]),
      Math.max(a[2], b[2]),
      Math.max(a[3], b[3]),
    ],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
}

function build(members: DswxGranule[]): Observation {
  const sensors = new Set(members.map((g) => g.sensor || "unknown"));
  const start = members.reduce(
    (m, g) => (ms(g.beginDate) < ms(m) ? g.beginDate! : m),
    members[0].beginDate!,
  );
  const end = members.reduce((m, g) => {
    const e = g.endDate ?? g.beginDate!;
    return ms(e) > ms(m) ? e : m;
  }, members[0].endDate ?? members[0].beginDate!);
  const sensor = [...sensors].sort().join("/");
  return {
    id: `${start}|${sensor}`,
    start,
    end,
    sensor,
    conceptId: members.find((g) => g.conceptId)?.conceptId,
    granules: members,
    tileIds: [...new Set(members.map((g) => g.tileId).filter((t): t is string => !!t))].sort(),
    bbox: unionBounds(members),
  };
}

/**
 * Cluster granules into observations, newest first: granules are chained by
 * begin time into windows of at most `windowMinutes` measured from the
 * first granule of each group (no chaining), regardless of sensor. Granules without a
 * usable begin date are dropped.
 */
export function groupObservations(
  granules: DswxGranule[],
  windowMinutes = DEFAULT_OBSERVATION_WINDOW_MINUTES,
): Observation[] {
  const window = windowMinutes * 60_000;
  const list = granules
    .filter((g) => !Number.isNaN(ms(g.beginDate)))
    .sort((a, b) => ms(a.beginDate) - ms(b.beginDate));

  const observations: Observation[] = [];
  let current: DswxGranule[] = [];
  for (const g of list) {
    const first = current[0];
    if (first && ms(g.beginDate) - ms(first.beginDate) > window) {
      observations.push(build(current));
      current = [];
    }
    current.push(g);
  }
  if (current.length) observations.push(build(current));
  return observations.sort((a, b) => ms(b.start) - ms(a.start));
}

/**
 * RFC3339 `start/end` window for titiler-cmr that covers every granule of the
 * given observations (padded by a second so exact-boundary matches survive).
 */
export function observationTemporal(observations: Observation[]): string {
  const starts = observations.map((o) => ms(o.start));
  const ends = observations.map((o) => ms(o.end));
  const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
  return `${iso(Math.min(...starts) - 1000)}/${iso(Math.max(...ends) + 1000)}`;
}
