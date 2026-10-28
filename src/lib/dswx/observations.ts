/**
 * Group DSWx granules into observations: one satellite pass is split into one
 * granule per MGRS tile, with sensing times a few seconds to a minute apart.
 */

import type { BBox, DswxGranule, Observation } from "./types";

/** Max gap between consecutive granule begin times within one observation. */
export const DEFAULT_OBSERVATION_GAP_MINUTES = 10;

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
  const sensors = new Set(members.map((g) => g.sensor ?? ""));
  const start = members.reduce(
    (m, g) => (ms(g.beginDate) < ms(m) ? g.beginDate! : m),
    members[0].beginDate!,
  );
  const end = members.reduce((m, g) => {
    const e = g.endDate ?? g.beginDate!;
    return ms(e) > ms(m) ? e : m;
  }, members[0].endDate ?? members[0].beginDate!);
  const sensor = sensors.size === 1 ? [...sensors][0] || "unknown" : "mixed";
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
 * Cluster granules into observations, newest first. Granules are split by
 * sensor first (an L8 and an S2 acquisition minutes apart are different
 * observations), then chained by begin time with a maximum gap. Granules
 * without a usable begin date are dropped.
 */
export function groupObservations(
  granules: DswxGranule[],
  gapMinutes = DEFAULT_OBSERVATION_GAP_MINUTES,
): Observation[] {
  const gap = gapMinutes * 60_000;
  const bySensor = new Map<string, DswxGranule[]>();
  for (const g of granules) {
    if (Number.isNaN(ms(g.beginDate))) continue;
    const key = g.sensor ?? "";
    const list = bySensor.get(key);
    if (list) list.push(g);
    else bySensor.set(key, [g]);
  }

  const observations: Observation[] = [];
  for (const list of bySensor.values()) {
    list.sort((a, b) => ms(a.beginDate) - ms(b.beginDate));
    let current: DswxGranule[] = [];
    for (const g of list) {
      const prev = current[current.length - 1];
      if (prev && ms(g.beginDate) - ms(prev.beginDate) > gap) {
        observations.push(build(current));
        current = [];
      }
      current.push(g);
    }
    if (current.length) observations.push(build(current));
  }
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
