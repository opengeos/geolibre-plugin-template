/**
 * Domain types for the DSWx plugin: product definitions, search
 * parameters, and parsed granule results. Kept free of DOM/MapLibre imports so
 * the data layer can be unit-tested in isolation.
 */

/** A `[west, south, east, north]` bounding box in EPSG:4326. */
export type BBox = [number, number, number, number];

/** titiler-cmr reader backend. DSWx products are COGs, so always "rasterio". */
export type TitilerBackend = "rasterio" | "xarray";

/**
 * Default titiler-cmr render parameters for a product. These seed the request
 * and are overridable per granule/band in the UI; tune them per product against
 * the live titiler-cmr endpoint.
 */
export interface DswxRenderDefaults {
  /** Reader backend (rasterio for DSWx COGs). */
  backend: TitilerBackend;
  /** Band token(s) to render, e.g. ["B01_WTR"] for DSWx-HLS. */
  bands?: string[];
  /** Regex titiler-cmr uses to discover band assets within a granule. */
  bandsRegex?: string;
  /** Min,max stretch, e.g. "0,4" for a categorical product. */
  rescale?: string;
  /** Named titiler colormap, e.g. "viridis". Omit when COGs embed a colormap. */
  colormapName?: string;
}

/** A single DSWx product (CMR collection) the plugin can search and display. */
export interface DswxProduct {
  /** CMR collection short_name, e.g. "OPERA_L3_DSWX-HLS_V1". */
  shortName: string;
  /** Full collection title. */
  title: string;
  /** Compact label shown in the dropdown, e.g. "DSWX-HLS". */
  shortTitle: string;
  /** One-line description. */
  description: string;
  /** Default titiler-cmr render parameters. */
  render: DswxRenderDefaults;
}

/** Parameters for a CMR granule search. */
export interface GranuleSearchParams {
  shortName: string;
  /** Search bounding box; omit to search globally. */
  bbox?: BBox;
  /** Inclusive start date, ISO `YYYY-MM-DD`. */
  start?: string;
  /** Inclusive end date, ISO `YYYY-MM-DD`. */
  end?: string;
  /** Max granules to return (CMR `page_size`). */
  count?: number;
}

/** A parsed DSWx granule result. */
export interface DswxGranule {
  /** CMR granule native id / producer id. */
  id: string;
  /** Collection concept-id this granule belongs to (for titiler-cmr). */
  conceptId?: string;
  /** Temporal coverage start (ISO string). */
  beginDate?: string;
  /** Temporal coverage end (ISO string). */
  endDate?: string;
  /** Footprint bounds `[w, s, e, n]`. */
  bbox?: BBox;
  /** GeoJSON geometry of the footprint (Polygon). */
  geometry: unknown;
  /** Downloadable data links (band COG / HDF5 URLs). */
  dataLinks: string[];
  /** MGRS tile id parsed from the GranuleUR, e.g. "T10SEG". */
  tileId?: string;
  /** Sensor token parsed from the GranuleUR, e.g. "S2A", "L8", "S1A". */
  sensor?: string;
}

/**
 * One satellite observation: DSWx granules (one per MGRS tile) whose sensing
 * times are within a short gap of each other, i.e. the same pass.
 */
export interface Observation {
  /** Stable id: the earliest member's begin time plus sensor. */
  id: string;
  /** Earliest member begin date (ISO). */
  start: string;
  /** Latest member end date (ISO). */
  end: string;
  /** Sensor token when all members agree, else "mixed". */
  sensor: string;
  conceptId?: string;
  granules: DswxGranule[];
  tileIds: string[];
  /** Union bounds `[w, s, e, n]` of member footprints. */
  bbox?: BBox;
}

/** A selectable band/layer derived from a granule's data links. */
export interface GranuleBand {
  /** Band token, e.g. "B01_WTR" or "VV". */
  token: string;
  /** Source file URL the token came from. */
  url: string;
  /** Display label. */
  label: string;
}

/** Result of {@link searchGranules}: footprints + structured rows. */
export interface GranuleSearchResult {
  granules: DswxGranule[];
  /** Footprint FeatureCollection, ready for `app.addGeoJsonLayer`. */
  featureCollection: {
    type: "FeatureCollection";
    features: unknown[];
  };
  /** Combined bounds across all footprints `[w, s, e, n]`, if any. */
  bounds?: BBox;
  /** Total granules CMR matched; exceeds `granules.length` when capped. */
  total: number;
}
