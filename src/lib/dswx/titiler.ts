/**
 * titiler-cmr client.
 *
 * titiler-cmr (https://github.com/developmentseed/titiler-cmr) renders map tiles
 * directly from CMR queries. Crucially, it handles Earthdata authentication and
 * Cloud-Optimized GeoTIFF reads **server-side**, so this plugin needs no
 * Earthdata credentials in the browser: it just requests a `tilejson.json` and
 * hands the returned XYZ tile template to GeoLibre.
 *
 * The runtime endpoint is configurable by the host, build environment, or the
 * DSWx panel. A public staging titiler-cmr URL is retained only as a fallback
 * for development and first-run demos.
 */

import type { BBox, TitilerBackend } from "./types";

export const FALLBACK_TITILER_CMR_ENDPOINT =
  "https://titiler-cmr.opengeos.org";

const ENDPOINT_GLOBAL = "GEOLIBRE_DSWX_TITILER_CMR_ENDPOINT";

export const DEFAULT_TITILER_CMR_ENDPOINT = resolveDefaultTitilerCmrEndpoint();

export function resolveDefaultTitilerCmrEndpoint(override?: string): string {
  return (
    cleanEndpoint(override) ||
    cleanEndpoint(readGlobalEndpoint()) ||
    cleanEndpoint(readBuildEndpoint()) ||
    FALLBACK_TITILER_CMR_ENDPOINT
  );
}

function cleanEndpoint(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : undefined;
}

function readGlobalEndpoint(): string | undefined {
  return (globalThis as Record<string, unknown>)[ENDPOINT_GLOBAL] as
    | string
    | undefined;
}

function readBuildEndpoint(): string | undefined {
  return (
    import.meta as ImportMeta & {
      env?: Record<string, string | undefined>;
    }
  ).env?.VITE_TITILER_CMR_ENDPOINT;
}

export interface TileJsonParams {
  /** Base titiler-cmr endpoint, no trailing slash. */
  endpoint: string;
  /** CMR collection concept-id. */
  conceptId: string;
  /** Reader backend; DSWx products use "rasterio". */
  backend: TitilerBackend;
  /** Temporal filter "start/end" (RFC3339) to isolate a granule or window. */
  datetime?: string;
  /**
   * Pin the result to a single granule by its CMR GranuleUR (exact match).
   * Used to render exactly the granules the user selected, rather than every
   * granule in a temporal window.
   */
  granuleUr?: string;
  /** Band token(s) to render. */
  bands?: string[];
  /** Regex titiler-cmr uses to discover band assets within a granule. */
  bandsRegex?: string;
  /** Min,max stretch, e.g. "0,4". */
  rescale?: string;
  /** Named titiler colormap, e.g. "viridis". */
  colormapName?: string;
  /**
   * Explicit colormap as a JSON string mapping class value -> [R,G,B,A]. When
   * set, it takes precedence over `rescale`/`colormapName` (used for
   * categorical layers like DSWx water classification).
   */
  colormap?: string;
  /**
   * rio-tiler band-math expression computed on the fly, e.g. `10*log10(b1)` for
   * dB. Bands are referenced as `b1`, `b2`, ... in the order of `bands`/`assets`
   * (sent with `asset_as_band=true`). Overrides plain band rendering.
   */
  expression?: string;
  /**
   * Mosaic method where granules overlap (`pixel_selection`), e.g. "lowest".
   * Sends `bands=` instead of `assets=` (the only form that works with an
   * expression) and reads every granule in the window (`exitwhenfull` and
   * `skipcovered` off); without that the server stops after the first granule.
   */
  pixelSelection?: string;
}

export interface TileJson {
  tiles: string[];
  bounds?: number[];
  minzoom?: number;
  maxzoom?: number;
  center?: number[];
}

/** TileMatrixSet id used for the XYZ tile grid. */
const TILE_MATRIX_SET = "WebMercatorQuad";

type QueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Array<string | number | boolean>;

/**
 * Backend-neutral titiler-cmr render/query parameters. `assets`/`assetsRegex`
 * target rasterio COG assets; `variables`/`group`/`sel` target xarray
 * NetCDF/HDF5/Zarr datasets.
 */
export interface CmrBackendQueryParams {
  /** Base titiler-cmr endpoint, no trailing slash. */
  endpoint: string;
  /** Reader backend: rasterio for COG/GeoTIFF, xarray for NetCDF/HDF5/Zarr. */
  backend: TitilerBackend;
  /** CMR collection concept-id. */
  conceptId: string;
  /** Optional exact CMR GranuleUR. */
  granuleUr?: string;
  /** Temporal filter, RFC3339 instant/range/list. */
  temporal?: string;
  /** Rasterio asset names, repeated as `assets=`. */
  assets?: string[];
  /** Rasterio asset regex. */
  assetsRegex?: string;
  /** Xarray variable names, repeated as `variables=`. */
  variables?: string[];
  /** Xarray group path, e.g. /science/LSAR/GCOV/grids/frequencyA. */
  group?: string;
  /** Xarray dimensional selection, JSON encoded when an object is provided. */
  sel?: string | Record<string, unknown>;
  /** One or more rescale values. Multiple entries are useful for RGB/expression output. */
  rescale?: string | string[];
  /** Named titiler colormap. */
  colormapName?: string;
  /** Explicit titiler colormap JSON string. */
  colormap?: string;
  /** Band/variable expression using b1, b2, ... */
  expression?: string;
  /** Optional minimum zoom passed through to tilejson endpoints. */
  minzoom?: number;
  /** Optional maximum zoom passed through to tilejson endpoints. */
  maxzoom?: number;
  /** Extra query params passed through as-is. */
  extraParams?: Record<string, QueryValue>;
}

export interface CmrTimeseriesTileJsonParams extends CmrBackendQueryParams {
  /** Time step as ISO-8601 duration, e.g. P1D, P1W, P1M. */
  step?: string;
  /** point = individual timestamps; interval = fixed-width intervals. */
  temporalMode?: "point" | "interval";
}

export type TimeSeriesTileJson = Record<string, TileJson>;

function appendValue(
  query: URLSearchParams,
  key: string,
  value: QueryValue,
): void {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) query.append(key, String(item));
  } else {
    query.set(key, String(value));
  }
}

function appendCommonCmrParams(
  query: URLSearchParams,
  params: CmrBackendQueryParams,
): void {
  query.set("collection_concept_id", params.conceptId);
  if (params.granuleUr) query.set("granule_ur", params.granuleUr);
  if (params.temporal) query.set("temporal", params.temporal);
  for (const asset of params.assets ?? []) query.append("assets", asset);
  if (params.assetsRegex) query.set("assets_regex", params.assetsRegex);
  for (const variable of params.variables ?? []) {
    query.append("variables", variable);
  }
  if (params.group) query.set("group", params.group);
  if (params.sel) {
    query.set(
      "sel",
      typeof params.sel === "string" ? params.sel : JSON.stringify(params.sel),
    );
  }
  const rescaleValues = Array.isArray(params.rescale)
    ? params.rescale
    : params.rescale
      ? [params.rescale]
      : [];
  for (const value of rescaleValues) query.append("rescale", value);
  applyExpression(query, params.expression);
  if (params.colormap) query.set("colormap", params.colormap);
  if (params.colormapName) query.set("colormap_name", params.colormapName);
  if (params.minzoom != null) query.set("minzoom", String(params.minzoom));
  if (params.maxzoom != null) query.set("maxzoom", String(params.maxzoom));
  for (const [key, value] of Object.entries(params.extraParams ?? {})) {
    appendValue(query, key, value);
  }
}

/** Build a backend-neutral tilejson URL for rasterio or xarray. */
export function buildCmrTileJsonUrl(params: CmrBackendQueryParams): string {
  const base = params.endpoint.replace(/\/+$/, "");
  const query = new URLSearchParams();
  appendCommonCmrParams(query, params);
  return `${base}/${params.backend}/${TILE_MATRIX_SET}/tilejson.json?${query.toString()}`;
}

/** Build a backend-neutral point-query URL for rasterio or xarray. */
export function buildCmrPointUrl(
  params: CmrBackendQueryParams & { lon: number; lat: number },
): string {
  const base = params.endpoint.replace(/\/+$/, "");
  const query = new URLSearchParams();
  appendCommonCmrParams(query, params);
  return `${base}/${params.backend}/point/${params.lon},${params.lat}?${query.toString()}`;
}

/** Build a backend-neutral statistics URL for rasterio or xarray. */
export function buildCmrStatisticsUrl(
  params: CmrBackendQueryParams & {
    categorical?: boolean;
    histogramBins?: number;
  },
): string {
  const base = params.endpoint.replace(/\/+$/, "");
  const query = new URLSearchParams();
  appendCommonCmrParams(query, params);
  if (params.categorical) query.set("categorical", "true");
  else if (params.histogramBins) {
    query.set("histogram_bins", String(params.histogramBins));
  }
  return `${base}/${params.backend}/statistics?${query.toString()}`;
}

/** Build a backend-neutral timeseries TileJSON URL. */
export function buildCmrTimeseriesTileJsonUrl(
  params: CmrTimeseriesTileJsonParams,
): string {
  const base = params.endpoint.replace(/\/+$/, "");
  const query = new URLSearchParams();
  appendCommonCmrParams(query, params);
  if (params.step) query.set("step", params.step);
  if (params.temporalMode) query.set("temporal_mode", params.temporalMode);
  return `${base}/${params.backend}/timeseries/${TILE_MATRIX_SET}/tilejson.json?${query.toString()}`;
}

/**
 * Apply a band-math `expression` to a query. titiler evaluates expressions over
 * bands named `b1`, `b2`, ... so `asset_as_band=true` is sent alongside it to
 * map each requested asset onto a band. No-op when `expression` is blank.
 */
function applyExpression(query: URLSearchParams, expression?: string): void {
  const expr = expression?.trim();
  if (!expr) return;
  query.set("expression", expr);
  query.set("asset_as_band", "true");
}

/**
 * Build the titiler-cmr `tilejson.json` request URL (current API).
 *
 * Path: `{endpoint}/{backend}/WebMercatorQuad/tilejson.json` (backend is a path
 * segment). Query params for the rasterio backend:
 * `collection_concept_id`, `assets` (repeatable), `assets_regex`, `temporal`,
 * `rescale`, `colormap_name`.
 *
 * Note: the older leafmap-style names (`concept_id`, `bands`, `bands_regex`,
 * `datetime` on `{endpoint}/WebMercatorQuad/tilejson.json`) still work but only
 * via a 301 redirect, so we target the canonical form directly. Verified live
 * against the hosted staging endpoint.
 */
export function buildTileJsonUrl(params: TileJsonParams): string {
  const mosaic = !!params.pixelSelection;
  return buildCmrTileJsonUrl({
    endpoint: params.endpoint,
    conceptId: params.conceptId,
    backend: params.backend,
    temporal: params.datetime,
    granuleUr: params.granuleUr,
    assets: mosaic ? undefined : params.bands,
    assetsRegex: mosaic ? undefined : params.bandsRegex,
    extraParams: mosaic
      ? {
          bands: params.bands,
          pixel_selection: params.pixelSelection,
          exitwhenfull: false,
          skipcovered: false,
        }
      : undefined,
    rescale: params.colormap ? undefined : params.rescale,
    colormapName: params.colormap ? undefined : params.colormapName,
    colormap: params.colormap,
    expression: params.expression,
  });
}

/**
 * Read the tile pixel size from a returned XYZ tile template's `tilesize` query
 * param (titiler-cmr defaults to 512), falling back to 256.
 */
export function tileSizeFromTemplate(template: string): number {
  const match = template.match(/[?&]tilesize=(\d+)/);
  return match ? parseInt(match[1], 10) : 256;
}

/** Parameters for a titiler-cmr `/point` pixel-value query. */
export interface PointQueryParams {
  /** Base titiler-cmr endpoint, no trailing slash. */
  endpoint: string;
  /** CMR collection concept-id. */
  conceptId: string;
  /** Reader backend; DSWx products use "rasterio". */
  backend: TitilerBackend;
  /** Longitude of the query point (EPSG:4326). */
  lon: number;
  /** Latitude of the query point (EPSG:4326). */
  lat: number;
  /** Pin the query to a single granule by its CMR GranuleUR (exact match). */
  granuleUr?: string;
  /** Temporal filter "start/end" (RFC3339) to isolate a granule or window. */
  datetime?: string;
  /** Band token(s) to read. */
  bands?: string[];
  /** Regex titiler-cmr uses to discover band assets within a granule. */
  bandsRegex?: string;
  /** rio-tiler band-math expression (bands as `b1`, `b2`, ...); see TileJsonParams. */
  expression?: string;
}

/** Pixel values for one asset (granule file) at the queried point. */
export interface PointAsset {
  /** Source asset / granule file name. */
  name: string;
  /** Per-band values at the point; `null` marks nodata/outside coverage. */
  values: (number | null)[];
  /** Band identifiers, aligned with {@link values}. */
  bandNames: string[];
  /** Human-readable band descriptions, when titiler-cmr provides them. */
  bandDescriptions?: string[];
}

/** Result of {@link fetchPoint}: the queried coordinate plus per-asset values. */
export interface PointResult {
  /** Queried `[lon, lat]` echoed back by titiler-cmr. */
  coordinates: [number, number];
  /** One entry per matching granule asset. */
  assets: PointAsset[];
}

/**
 * Build a titiler-cmr `/point/{lon},{lat}` request URL.
 *
 * Path: `{endpoint}/{backend}/point/{lon},{lat}` (lon first). Reuses the same
 * CMR query params as the tile request (`collection_concept_id`, `granule_ur`,
 * `temporal`, `assets`, `assets_regex`) so a click reads exactly the
 * granule/band being displayed. Verified live against the staging endpoint.
 */
export function buildPointUrl(params: PointQueryParams): string {
  return buildCmrPointUrl({
    endpoint: params.endpoint,
    conceptId: params.conceptId,
    backend: params.backend,
    lon: params.lon,
    lat: params.lat,
    granuleUr: params.granuleUr,
    temporal: params.datetime,
    assets: params.bands,
    assetsRegex: params.bandsRegex,
    expression: params.expression,
  });
}

/** Fetch a point pixel-value document from titiler-cmr. */
export async function fetchPoint(url: string): Promise<PointResult> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`titiler-cmr point request failed (${res.status})`);
  }
  const json = (await res.json()) as {
    coordinates: [number, number];
    assets?: Array<{
      name: string;
      values: (number | null)[];
      band_names: string[];
      band_descriptions?: string[] | null;
    }>;
  };
  return {
    coordinates: json.coordinates,
    assets: (json.assets ?? []).map((asset) => ({
      name: asset.name,
      values: asset.values,
      bandNames: asset.band_names,
      bandDescriptions: asset.band_descriptions ?? undefined,
    })),
  };
}

/** Parameters for a titiler-cmr `/statistics` zonal-stats query. */
export interface StatisticsQueryParams {
  /** Base titiler-cmr endpoint, no trailing slash. */
  endpoint: string;
  /** CMR collection concept-id. */
  conceptId: string;
  /** Reader backend; DSWx products use "rasterio". */
  backend: TitilerBackend;
  /** Pin the query to a single granule by its CMR GranuleUR (exact match). */
  granuleUr?: string;
  /** Temporal filter "start/end" (RFC3339) to isolate a granule or window. */
  datetime?: string;
  /** Band token(s) to summarize. */
  bands?: string[];
  /** Regex titiler-cmr uses to discover band assets within a granule. */
  bandsRegex?: string;
  /**
   * Request a per-class histogram (`categorical=true`) instead of binned. For
   * discrete products (DSWx water classes, DIST status) this yields exact
   * pixel counts per class, the basis for class areas.
   */
  categorical?: boolean;
  /**
   * Number of histogram bins for continuous bands (`histogram_bins`). Ignored
   * when {@link categorical} is set. titiler-cmr defaults to 10; a higher value
   * gives a smoother distribution for choosing a rescale.
   */
  histogramBins?: number;
  /** rio-tiler band-math expression (bands as `b1`, `b2`, ...); see TileJsonParams. */
  expression?: string;
  /**
   * Mosaic method used where granules overlap (`pixel_selection`), e.g.
   * "lowest". Only takes effect with `exitWhenFull`/`skipCovered` off.
   */
  pixelSelection?: string;
  /** Stop reading granules once the AOI is covered (server default: true). */
  exitWhenFull?: boolean;
  /** Skip granules that add no new coverage (server default: true). */
  skipCovered?: boolean;
}

/** Per-band statistics returned by titiler-cmr `/statistics`. */
export interface BandStatistics {
  min: number;
  max: number;
  mean: number;
  std: number;
  median?: number;
  /** Coverage-weighted pixel count within the AOI. */
  count: number;
  /** Unmasked pixel count within the AOI. */
  validPixels?: number;
  /** Masked (nodata) pixel count within the AOI. */
  maskedPixels?: number;
  /** Percentage of AOI pixels that are valid (not nodata/masked). */
  validPercent?: number;
  /**
   * `[counts, edges]`. In categorical mode `edges` are the actual class values,
   * so `counts[i]` is the pixel count for class `edges[i]`.
   */
  histogram?: [number[], number[]];
  /** 2nd-percentile value (lower bound for a suggested rescale). */
  percentile2?: number;
  /** 98th-percentile value (upper bound for a suggested rescale). */
  percentile98?: number;
  /** Band description from the source asset, when available. */
  description?: string;
}

/** Result of {@link fetchStatistics}: per-band statistics keyed by band name. */
export interface StatisticsResult {
  bands: Record<string, BandStatistics>;
}

/**
 * Build a titiler-cmr `/statistics` request URL.
 *
 * Path: `{endpoint}/{backend}/statistics` (POST a GeoJSON Feature as the AOI).
 * Reuses the same CMR query params as the tile request, plus optional
 * `categorical`. Verified live against the staging endpoint.
 */
export function buildStatisticsUrl(params: StatisticsQueryParams): string {
  const url = new URL(
    buildCmrStatisticsUrl({
      endpoint: params.endpoint,
      conceptId: params.conceptId,
      backend: params.backend,
      granuleUr: params.granuleUr,
      temporal: params.datetime,
      categorical: params.categorical,
      histogramBins: params.histogramBins,
      expression: params.expression,
    }),
  );
  // Verified live: `/statistics` rejects `assets`/`assets_regex` names (it
  // expects band indexes) but accepts the legacy `bands` parameter by name.
  for (const band of params.bands ?? []) url.searchParams.append("bands", band);
  if (params.expression?.trim()) {
    // Expressions evaluate over `b1`; `asset_as_band` is already set above.
    url.searchParams.set("asset_as_band", "true");
  }
  if (params.pixelSelection) {
    url.searchParams.set("pixel_selection", params.pixelSelection);
  }
  if (params.exitWhenFull !== undefined) {
    url.searchParams.set("exitwhenfull", String(params.exitWhenFull));
  }
  if (params.skipCovered !== undefined) {
    url.searchParams.set("skipcovered", String(params.skipCovered));
  }
  return url.toString();
}

/** Coerce an unknown JSON value to a finite number, or NaN. */
function toNum(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : NaN;
}

/** Coerce to a finite number, or undefined when absent/non-finite. */
function toOptNum(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * POST a GeoJSON AOI to titiler-cmr `/statistics` and parse the per-band stats.
 *
 * `feature` is a GeoJSON Feature (or FeatureCollection); titiler-cmr echoes it
 * back with `properties.statistics` keyed by band name (e.g. `b1`).
 */
export async function fetchStatistics(
  url: string,
  feature: unknown,
): Promise<StatisticsResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(feature),
  });
  if (!res.ok) {
    throw new Error(`titiler-cmr statistics request failed (${res.status})`);
  }
  // 204: no granule intersects the query window/AOI.
  if (res.status === 204) return { bands: {} };
  const json = (await res.json()) as {
    properties?: { statistics?: Record<string, Record<string, unknown>> };
  };
  const raw = json.properties?.statistics ?? {};
  const bands: Record<string, BandStatistics> = {};
  for (const [name, s] of Object.entries(raw)) {
    bands[name] = {
      min: toNum(s.min),
      max: toNum(s.max),
      mean: toNum(s.mean),
      std: toNum(s.std),
      median: toOptNum(s.median),
      count: toNum(s.count),
      validPixels: toOptNum(s.valid_pixels),
      maskedPixels: toOptNum(s.masked_pixels),
      validPercent: toOptNum(s.valid_percent),
      histogram: Array.isArray(s.histogram)
        ? (s.histogram as [number[], number[]])
        : undefined,
      percentile2: toOptNum(s.percentile_2),
      percentile98: toOptNum(s.percentile_98),
      description:
        typeof s.description === "string" ? s.description : undefined,
    };
  }
  return { bands };
}

/** Fetch a TileJSON document from titiler-cmr. */
export async function fetchTileJson(url: string): Promise<TileJson> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`titiler-cmr tilejson request failed (${res.status})`);
  }
  const json = (await res.json()) as TileJson;
  if (!json.tiles || json.tiles.length === 0) {
    throw new Error("titiler-cmr returned no tiles for this query");
  }
  return json;
}

/** Fetch arbitrary JSON from titiler-cmr. */
export async function fetchTitilerJson<T = unknown>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`titiler-cmr request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

/** Fetch a backend-neutral timeseries TileJSON document. */
export async function fetchTimeSeriesTileJson(
  url: string,
): Promise<TimeSeriesTileJson> {
  const json = await fetchTitilerJson<unknown>(url);
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("titiler-cmr returned an invalid timeseries TileJSON");
  }
  return json as TimeSeriesTileJson;
}

/**
 * Build a `datetime` filter that isolates a single granule by narrowing to its
 * temporal range (titiler-cmr mosaics every granule matching the query).
 */
export function granuleDatetime(
  begin?: string,
  end?: string,
): string | undefined {
  if (!begin && !end) return undefined;
  const start = begin ?? end!;
  const stop = end ?? begin!;
  return `${start}/${stop}`;
}

/** Normalize TileJSON bounds to a `[w, s, e, n]` tuple when present. */
export function tileJsonBounds(json: TileJson): BBox | undefined {
  if (json.bounds && json.bounds.length === 4) {
    const [w, s, e, n] = json.bounds;
    return [w, s, e, n];
  }
  return undefined;
}
