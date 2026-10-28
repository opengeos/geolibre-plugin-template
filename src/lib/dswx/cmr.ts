/**
 * NASA CMR (Common Metadata Repository) client.
 *
 * CMR granule and collection search are **public** (no Earthdata login), so this
 * runs entirely in the browser. We use it to (1) find DSWx granules and build
 * footprint polygons + a results table, and (2) resolve a collection's
 * `concept_id`, which titiler-cmr requires to render tiles.
 *
 * Mirrors the parsing the QGIS plugin's `SearchWorker` does over UMM-G metadata.
 */

import type {
  BBox,
  GranuleBand,
  GranuleSearchParams,
  GranuleSearchResult,
  DswxGranule,
} from "./types";

const CMR_BASE = "https://cmr.earthdata.nasa.gov/search";

/** In-memory cache of short_name -> concept_id to avoid repeat lookups. */
const conceptIdCache = new Map<string, string>();

/**
 * Resolve a collection `concept_id` from its short_name via the CMR collections
 * endpoint, caching the result. titiler-cmr keys off `concept_id`, not
 * short_name.
 */
export async function resolveConceptId(shortName: string): Promise<string> {
  const cached = conceptIdCache.get(shortName);
  if (cached) return cached;

  const url = `${CMR_BASE}/collections.umm_json?short_name=${encodeURIComponent(
    shortName,
  )}&page_size=1`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`CMR collection lookup failed (${res.status})`);
  }
  const json = (await res.json()) as {
    items?: Array<{ meta?: { "concept-id"?: string } }>;
  };
  const conceptId = json.items?.[0]?.meta?.["concept-id"];
  if (!conceptId) {
    throw new Error(`No CMR collection found for short_name "${shortName}"`);
  }
  conceptIdCache.set(shortName, conceptId);
  return conceptId;
}

/**
 * Search DSWx granules. Returns parsed granules, a footprint
 * `FeatureCollection` ready for `app.addGeoJsonLayer`, and the combined bounds.
 */
export async function searchGranules(
  params: GranuleSearchParams,
): Promise<GranuleSearchResult> {
  const query = new URLSearchParams();
  query.set("short_name", params.shortName);
  query.set("page_size", String(params.count ?? 50));
  if (params.bbox) {
    // CMR bounding_box is "W,S,E,N".
    query.set("bounding_box", params.bbox.join(","));
  }
  if (params.start && params.end) {
    query.set("temporal", `${params.start}T00:00:00Z,${params.end}T23:59:59Z`);
  }

  const url = `${CMR_BASE}/granules.umm_json?${query.toString()}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`CMR granule search failed (${res.status})`);
  }
  const json = (await res.json()) as { items?: UmmGranuleItem[] };
  const items = json.items ?? [];

  const granules = items.map(parseGranule);
  const features = granules
    .filter((g) => g.geometry)
    .map((g) => ({
      type: "Feature" as const,
      geometry: g.geometry,
      properties: {
        // Distinctive key so map clicks can identify a DSWx footprint via
        // queryRenderedFeatures without depending on the host's layer id.
        _dswxGranuleId: g.id,
        id: g.id,
        beginDate: g.beginDate ?? "",
        endDate: g.endDate ?? "",
        links: g.dataLinks.length,
      },
    }));

  return {
    granules,
    featureCollection: { type: "FeatureCollection", features },
    bounds: combinedBounds(granules),
  };
}

/** UMM-G item shape (only the parts we read). */
interface UmmGranuleItem {
  meta?: {
    "concept-id"?: string;
    "collection-concept-id"?: string;
    "native-id"?: string;
  };
  umm?: {
    GranuleUR?: string;
    TemporalExtent?: {
      RangeDateTime?: { BeginningDateTime?: string; EndingDateTime?: string };
    };
    SpatialExtent?: {
      HorizontalSpatialDomain?: {
        Geometry?: {
          BoundingRectangles?: Array<{
            WestBoundingCoordinate: number;
            SouthBoundingCoordinate: number;
            EastBoundingCoordinate: number;
            NorthBoundingCoordinate: number;
          }>;
          GPolygons?: Array<{
            Boundary?: { Points?: Array<{ Longitude: number; Latitude: number }> };
          }>;
        };
      };
    };
    RelatedUrls?: Array<{ URL?: string; Type?: string }>;
  };
}

const RASTER_EXT = /\.(tiff?|h5|hdf5?|hdf)$/i;

/** Parse one UMM-G granule item into an {@link DswxGranule}. */
function parseGranule(item: UmmGranuleItem): DswxGranule {
  const umm = item.umm ?? {};
  const id =
    umm.GranuleUR ?? item.meta?.["native-id"] ?? item.meta?.["concept-id"] ?? "";

  const range = umm.TemporalExtent?.RangeDateTime;
  const geo = umm.SpatialExtent?.HorizontalSpatialDomain?.Geometry;

  let geometry: unknown = null;
  let bbox: BBox | undefined;

  const rect = geo?.BoundingRectangles?.[0];
  const poly = geo?.GPolygons?.[0]?.Boundary?.Points;
  if (rect) {
    const { WestBoundingCoordinate: w, SouthBoundingCoordinate: s } = rect;
    const { EastBoundingCoordinate: e, NorthBoundingCoordinate: n } = rect;
    bbox = [w, s, e, n];
    geometry = {
      type: "Polygon",
      coordinates: [
        [
          [w, s],
          [e, s],
          [e, n],
          [w, n],
          [w, s],
        ],
      ],
    };
  } else if (poly && poly.length >= 3) {
    const ring = poly.map((p) => [p.Longitude, p.Latitude]);
    // Close the ring if needed.
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
    geometry = { type: "Polygon", coordinates: [ring] };
    bbox = ringBounds(ring);
  }

  const dataLinks = (umm.RelatedUrls ?? [])
    .map((u) => u.URL ?? "")
    .filter((u) => RASTER_EXT.test(u));

  return {
    id,
    // titiler-cmr needs the COLLECTION concept-id (C...), which CMR provides on
    // each granule's meta; meta["concept-id"] is the granule's own id (G...).
    conceptId: item.meta?.["collection-concept-id"],
    beginDate: range?.BeginningDateTime,
    endDate: range?.EndingDateTime,
    bbox,
    geometry,
    dataLinks,
  };
}

/** Bounds of a coordinate ring as `[w, s, e, n]`. */
function ringBounds(ring: number[][]): BBox {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [lon, lat] of ring) {
    if (lon < w) w = lon;
    if (lon > e) e = lon;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  }
  return [w, s, e, n];
}

/** Combine all granule bboxes into one `[w, s, e, n]`, or undefined if none. */
function combinedBounds(granules: DswxGranule[]): BBox | undefined {
  const boxes = granules.map((g) => g.bbox).filter((b): b is BBox => !!b);
  if (boxes.length === 0) return undefined;
  return boxes.reduce<BBox>(
    (acc, b) => [
      Math.min(acc[0], b[0]),
      Math.min(acc[1], b[1]),
      Math.max(acc[2], b[2]),
      Math.max(acc[3], b[3]),
    ],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
}

const BAND_PATTERNS = [
  /_(B\d+_[A-Za-z0-9-]+)\.tiff?$/i, // e.g. ..._B01_WTR.tif
  /_([VH]{2})\.tiff?$/i, // e.g. ..._VV.tif / ..._VH.tif
  /_([A-Z][A-Za-z0-9-]+)\.tiff?$/, // generic trailing token
];

/**
 * Extract the band/layer token from a data link filename. Ports the QGIS
 * plugin's `_get_layer_band` regexes.
 */
export function getLayerBand(url: string): string {
  const name = url.split("/").pop() ?? url;
  for (const pattern of BAND_PATTERNS) {
    const match = name.match(pattern);
    if (match) return match[1];
  }
  // Fallback: last "_"-delimited token before the extension.
  const stem = name.replace(RASTER_EXT, "");
  const parts = stem.split("_");
  return parts[parts.length - 1] || name;
}

/**
 * Build the selectable band list for a granule, de-duplicated by band token.
 * CMR commonly lists each asset twice (an HTTPS link and an S3 link), so the
 * raw data links would otherwise yield duplicate entries; the first (HTTPS)
 * occurrence wins.
 */
export function granuleBands(granule: DswxGranule): GranuleBand[] {
  const seen = new Set<string>();
  const bands: GranuleBand[] = [];
  for (const url of granule.dataLinks) {
    const token = getLayerBand(url);
    if (seen.has(token)) continue;
    seen.add(token);
    bands.push({ token, url, label: token });
  }
  return bands;
}
