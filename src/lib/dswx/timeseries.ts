/**
 * Water-area time series over a drawn AOI: one titiler-cmr `/statistics` call
 * per observation, converted from class pixel counts to areas.
 */

import { DSWX_HLS_PRIORITY_EXPRESSION } from "./colormaps";
import { observationTemporal } from "./observations";
import { DSWX_PIXEL_SIZE_METERS } from "./products";
import {
  buildStatisticsUrl,
  fetchStatistics,
  type BandStatistics,
} from "./titiler";
import type { Observation, TitilerBackend } from "./types";

/** Priority remap applied before the `lowest` mosaic; see colormaps.ts. */
export const PRIORITY_EXPRESSION = DSWX_HLS_PRIORITY_EXPRESSION;

/** Remapped class codes produced by {@link PRIORITY_EXPRESSION}. */
export const PRIORITY_OPEN_WATER = 1;
export const PRIORITY_PARTIAL_WATER = 2;
/** Snow/ice (4), cloud/shadow (5) and any other class (6, e.g. ocean masked). */
const PRIORITY_MASKED = [4, 5, 6];

export interface WaterAreaPoint {
  observationId: string;
  /** Observation start (ISO). */
  time: string;
  sensor: string;
  openKm2: number;
  partialKm2: number;
  /** Fraction (0-1) of AOI pixels that are cloud, snow/ice or other masks. */
  maskedFraction: number;
  /** Fraction (0-1) of AOI pixels with no data (outside coverage, fill). */
  noDataFraction: number;
  /** Classified AOI pixels counted; 0 means no usable data in the AOI. */
  pixels: number;
  /** All AOI pixels (classified plus no data). */
  totalPixels: number;
  error?: string;
}

const KM2_PER_PIXEL = (DSWX_PIXEL_SIZE_METERS * DSWX_PIXEL_SIZE_METERS) / 1e6;

/**
 * Share (0-1) of the AOI's bounding box that the polygon covers, by planar area
 * in lon/lat. titiler-cmr reports pixels outside the polygon as masked, so this
 * is used to tell them apart from real no-data. Returns 1 when the AOI is not a
 * simple polygon.
 */
export function polygonBboxFraction(aoi: unknown): number {
  const feature = aoi as { geometry?: { type?: string; coordinates?: unknown } };
  const geometry = feature?.geometry ?? (aoi as typeof feature.geometry);
  if (geometry?.type !== "Polygon") return 1;
  const ring = (geometry.coordinates as number[][][] | undefined)?.[0];
  if (!ring || ring.length < 4) return 1;
  let area2 = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    area2 += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  const xs = ring.map((v) => v[0]);
  const ys = ring.map((v) => v[1]);
  const bbox =
    (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
  return bbox > 0 ? Math.min(1, Math.abs(area2) / 2 / bbox) : 1;
}

/**
 * Convert a categorical `/statistics` result, computed over the remapped
 * priority classes, into areas and coverage fractions.
 *
 * `/statistics` reads the AOI's bounding box and counts pixels outside the
 * polygon in `masked_pixels`. `polygonFraction` (see {@link polygonBboxFraction})
 * is the polygon's share of that box, so the pixels inside the polygon are
 * estimated and only the shortfall of valid pixels counts as no data.
 */
export function waterAreaFromStats(
  obs: Pick<Observation, "id" | "start" | "sensor">,
  stats: BandStatistics | undefined,
  polygonFraction = 1,
): WaterAreaPoint {
  const base = { observationId: obs.id, time: obs.start, sensor: obs.sensor };
  const empty = {
    ...base,
    openKm2: 0,
    partialKm2: 0,
    maskedFraction: 0,
    noDataFraction: 0,
    pixels: 0,
    totalPixels: 0,
  };
  const hist = stats?.histogram;
  if (!stats || !hist) return empty;
  const [counts, classes] = hist;
  let open = 0;
  let partial = 0;
  let masked = 0;
  let valid = 0;
  classes.forEach((cls, i) => {
    const n = counts[i] ?? 0;
    valid += n;
    if (cls === PRIORITY_OPEN_WATER) open += n;
    else if (cls === PRIORITY_PARTIAL_WATER) partial += n;
    else if (PRIORITY_MASKED.includes(cls)) masked += n;
  });
  const boxPixels = valid + (stats.maskedPixels ?? 0);
  const noData = Math.max(0, boxPixels * polygonFraction - valid);
  const total = valid + noData;
  if (!total) return empty;
  return {
    ...base,
    openKm2: open * KM2_PER_PIXEL,
    partialKm2: partial * KM2_PER_PIXEL,
    maskedFraction: masked / total,
    noDataFraction: noData / total,
    pixels: valid,
    totalPixels: total,
  };
}

export interface TimeSeriesOptions {
  endpoint: string;
  conceptId: string;
  backend: TitilerBackend;
  /** Water-classification band, e.g. "B01_WTR". */
  band: string;
  bandsRegex?: string;
  /** GeoJSON Feature/FeatureCollection AOI. */
  aoi: unknown;
  observations: Observation[];
  /** Parallel requests; titiler-cmr stats are slow so keep this small. */
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/**
 * Compute a water-area point for each observation, oldest first. Failures are
 * recorded per point (`error`) rather than aborting the whole series.
 */
export async function computeWaterTimeSeries(
  opts: TimeSeriesOptions,
): Promise<WaterAreaPoint[]> {
  const queue = [...opts.observations].sort(
    (a, b) => Date.parse(a.start) - Date.parse(b.start),
  );
  const results: WaterAreaPoint[] = new Array(queue.length);
  const polygonFraction = polygonBboxFraction(opts.aoi);
  let next = 0;
  let done = 0;

  async function worker(): Promise<void> {
    while (next < queue.length && !opts.signal?.aborted) {
      const index = next++;
      const obs = queue[index];
      try {
        const url = buildStatisticsUrl({
          endpoint: opts.endpoint,
          conceptId: opts.conceptId,
          backend: opts.backend,
          datetime: observationTemporal([obs]),
          bands: [opts.band],
          bandsRegex: opts.bandsRegex,
          categorical: true,
          expression: PRIORITY_EXPRESSION,
          // Read every granule in the window so overlaps resolve by priority.
          pixelSelection: "lowest",
          exitWhenFull: false,
          skipCovered: false,
        });
        const { bands } = await fetchStatistics(url, opts.aoi);
        // A single requested band comes back keyed by its name or "b1".
        const stats = bands[opts.band] ?? Object.values(bands)[0];
        results[index] = waterAreaFromStats(obs, stats, polygonFraction);
      } catch (err) {
        results[index] = {
          ...waterAreaFromStats(obs, undefined),
          error: err instanceof Error ? err.message : String(err),
        };
      }
      opts.onProgress?.(++done, queue.length);
    }
  }

  const workers = Math.max(1, opts.concurrency ?? 3);
  await Promise.all(Array.from({ length: workers }, worker));
  return results.filter(Boolean);
}

/** CSV export of a series (RFC 4180 quoting is unnecessary: no free text). */
export function timeSeriesToCsv(points: WaterAreaPoint[]): string {
  const rows = points.map((p) =>
    [
      p.time,
      p.sensor,
      p.openKm2.toFixed(4),
      p.partialKm2.toFixed(4),
      p.maskedFraction.toFixed(4),
      p.noDataFraction.toFixed(4),
      p.pixels,
      p.error ? "error" : "ok",
    ].join(","),
  );
  return [
    "time,sensor,open_water_km2,partial_water_km2,masked_fraction,nodata_fraction,pixels,status",
    ...rows,
  ].join("\n");
}

/**
 * Drop points whose masked or no-data share of the AOI exceeds a limit.
 * Limits are fractions (0-1); `undefined` disables that limit. Errored points
 * are kept so the chart can still account for them.
 */
export function filterSeries(
  points: WaterAreaPoint[],
  limits: { maxMasked?: number; maxNoData?: number },
): WaterAreaPoint[] {
  const { maxMasked, maxNoData } = limits;
  return points.filter(
    (p) =>
      p.error ||
      ((maxMasked === undefined || p.maskedFraction <= maxMasked) &&
        (maxNoData === undefined || p.noDataFraction <= maxNoData)),
  );
}
