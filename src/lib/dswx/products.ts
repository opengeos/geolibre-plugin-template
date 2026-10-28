/**
 * Registry of the DSWx (Dynamic Surface Water eXtent) products the plugin can
 * search and display: DSWx-HLS (Landsat 8/9 + Sentinel-2) and DSWx-S1
 * (Sentinel-1 SAR, which sees through cloud).
 *
 * Both are 30 m COG products that share the same layer set (WTR, BWTR, CONF,
 * DIAG, ...), so they share render defaults too.
 */

import type { DswxProduct } from "./types";

export const DSWX_PRODUCTS: DswxProduct[] = [
  {
    shortName: "OPERA_L3_DSWX-HLS_V1",
    title:
      "Dynamic Surface Water Extent from Harmonized Landsat Sentinel-2 (Version 1)",
    shortTitle: "DSWx-HLS",
    description: "Surface water extent derived from optical HLS data",
    render: {
      backend: "rasterio",
      bands: ["B01_WTR"],
      bandsRegex: "B[0-9]{2}_[A-Z0-9-]+",
    },
  },
  {
    shortName: "OPERA_L3_DSWX-S1_V1",
    title: "Dynamic Surface Water Extent from Sentinel-1 (Version 1)",
    shortTitle: "DSWx-S1",
    description: "Surface water extent derived from Sentinel-1 SAR data",
    render: {
      backend: "rasterio",
      bands: ["B01_WTR"],
      bandsRegex: "B[0-9]{2}_[A-Z0-9-]+",
    },
  },
];

/** Look up a product by its CMR short_name. */
export function getProduct(shortName: string): DswxProduct | undefined {
  return DSWX_PRODUCTS.find((p) => p.shortName === shortName);
}

/** Native pixel size in meters (both DSWx products are on a 30 m grid). */
export const DSWX_PIXEL_SIZE_METERS = 30;

/** Suggested rescale + colormap for a band, shown in the Rendering fields. */
export interface BandRender {
  /** Rescale "min,max"; blank means none. */
  rescale: string;
  /** Named colormap; blank means the built-in categorical colormap (if any). */
  colormapName: string;
}

/**
 * Default render hints for a band. Categorical layers (WTR, BWTR, WTR-1/2) use
 * the built-in class colormap, so they return blanks; continuous layers get a
 * stretch so they do not render flat.
 */
export function bandRenderDefaults(band?: string): BandRender {
  const empty: BandRender = { rescale: "", colormapName: "" };
  if (!band) return empty;
  const b = band.toUpperCase();
  if (/WTR/.test(b)) return empty;
  if (/DEM/.test(b)) return { rescale: "0,3000", colormapName: "terrain" };
  if (/CONF/.test(b)) return { rescale: "0,100", colormapName: "viridis" };
  return empty;
}
