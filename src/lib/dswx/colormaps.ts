/**
 * Categorical colormaps for DSWx layers.
 *
 * titiler-cmr's multi-asset rasterio backend returns the raw class values and
 * does not apply a COG's embedded color table, so categorical layers (e.g. the
 * DSWx water classification) render as grayscale unless we pass an explicit
 * `colormap`. These map class value -> [R, G, B, A].
 */

type Rgba = [number, number, number, number];

const TRANSPARENT: Rgba = [0, 0, 0, 0];
const WHITE: Rgba = [255, 255, 255, 255];

/**
 * DSWx-HLS WTR / BWTR / WTR-1 / WTR-2 water-classification colormap. Class
 * colors are read from the color table embedded in the product's WTR COGs; fill
 * (255) is the GDAL nodata value, so it is transparent.
 */
export const DSWX_HLS_WTR_COLORMAP: Record<string, Rgba> = {
  "0": WHITE, // not water
  "1": [0, 0, 255, 255], // open water -> blue
  "2": [180, 213, 244, 255], // partial surface water -> light blue
  "252": [0, 255, 255, 255], // snow/ice -> cyan
  "253": [175, 175, 175, 255], // cloud/cloud shadow -> grey
  "254": [0, 0, 127, 255], // ocean masked -> navy
  "255": TRANSPARENT, // fill / no data
};

/**
 * DSWx-S1 WTR colormap. Class colors are read from the color table embedded in
 * the product's WTR COGs; fill (255) is the GDAL nodata value.
 */
export const DSWX_S1_WTR_COLORMAP: Record<string, Rgba> = {
  "0": WHITE, // not water
  "1": [0, 0, 255, 255], // open water -> blue
  "2": [120, 120, 240, 255],
  "3": [0, 255, 0, 255],
  "5": [0, 255, 0, 255],
  "6": [240, 20, 20, 255],
  "7": [200, 200, 50, 255],
  "8": [0, 255, 255, 255],
  "30": [0, 100, 0, 255],
  "31": [0, 50, 127, 255],
  "32": [60, 110, 120, 255],
  "35": [50, 177, 50, 255],
  "36": [120, 60, 20, 255],
  "37": [100, 150, 25, 255],
  "250": [200, 200, 200, 255], // HAND masked -> light grey
  "251": [128, 128, 128, 255], // layover/shadow masked -> grey
  "254": [50, 50, 240, 255], // ocean masked
  "255": TRANSPARENT, // fill / no data
};

/**
 * Priority remap applied server-side before a `lowest` mosaic, so where
 * granules overlap the most useful class wins: open water (1), partial water
 * (2), not water (3), snow/ice (4), cloud/shadow (5), anything else (6, e.g.
 * ocean masked). Fill (255) is nodata in the files and never reaches the
 * mosaic. Only valid for the DSWx-HLS class set.
 */
export const DSWX_HLS_PRIORITY_EXPRESSION =
  "where(b1==1,1,where(b1==2,2,where(b1==0,3,where(b1==252,4,where(b1==253,5,6)))))";

/**
 * Colormap for rasters remapped by {@link DSWX_HLS_PRIORITY_EXPRESSION}; the
 * colors match {@link DSWX_HLS_WTR_COLORMAP} but are keyed by the remapped
 * codes, so pixel values on such a layer are priority codes, not product classes.
 */
export const DSWX_HLS_PRIORITY_COLORMAP: Record<string, Rgba> = {
  "1": DSWX_HLS_WTR_COLORMAP["1"], // open water
  "2": DSWX_HLS_WTR_COLORMAP["2"], // partial surface water
  "3": DSWX_HLS_WTR_COLORMAP["0"], // not water
  "4": DSWX_HLS_WTR_COLORMAP["252"], // snow/ice
  "5": DSWX_HLS_WTR_COLORMAP["253"], // cloud/cloud shadow
  "6": DSWX_HLS_WTR_COLORMAP["254"], // other masked (ocean)
};

/** Human-readable labels for DSWx WTR class values, used in stats breakdowns. */
export const DSWX_WTR_CLASS_LABELS: Record<string, string> = {
  "0": "Not water",
  "1": "Open water",
  "2": "Partial surface water",
  "252": "Snow/ice",
  "253": "Cloud/cloud shadow",
  "254": "Ocean masked",
  "255": "Fill",
};

/** DSWx WTR class value (1) counted as open water for area calculations. */
export const DSWX_OPEN_WATER_CLASS = 1;
/** DSWx WTR class value (2) counted as partial surface water. */
export const DSWX_PARTIAL_WATER_CLASS = 2;

/**
 * Return an explicit titiler `colormap` (JSON string) for a categorical band,
 * or `undefined` to let the caller fall back to rescale/grayscale rendering.
 */
export function colormapForBand(
  shortName: string,
  band?: string,
): string | undefined {
  if (!band || !/DSWX/i.test(shortName) || !/WTR/i.test(band)) return undefined;
  return JSON.stringify(
    /DSWX-S1/i.test(shortName) ? DSWX_S1_WTR_COLORMAP : DSWX_HLS_WTR_COLORMAP,
  );
}

/** Whether a product's WTR layers can use the priority-composite remap. */
export function supportsPriorityComposite(shortName: string, band?: string): boolean {
  return /DSWX-HLS/i.test(shortName) && !!band && /WTR/i.test(band);
}

/**
 * Whether a band holds discrete class values, so zonal statistics should
 * request a per-class (categorical) histogram rather than continuous bins.
 */
export function isCategoricalBand(shortName: string, band?: string): boolean {
  if (!band) return false;
  if (/DSWX/i.test(shortName) && /WTR/i.test(band)) return true;
  if (/DIST/i.test(shortName) && /STATUS/i.test(band)) return true;
  return false;
}

/** Whether a band is a DSWx water-classification layer (open-water areas). */
export function isDswxWaterBand(shortName: string, band?: string): boolean {
  return !!band && /DSWX/i.test(shortName) && /WTR/i.test(band);
}
