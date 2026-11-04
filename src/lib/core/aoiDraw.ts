import type { Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";

export type LonLat = [number, number];

export interface AoiDrawOptions {
  /** Called with the vertices so far on every change, for a live preview. */
  onChange?: (vertices: LonLat[]) => void;
}

/** Close a vertex list into a GeoJSON Polygon Feature (needs >= 3 vertices). */
export function verticesToFeature(vertices: LonLat[]) {
  const ring = [...vertices, vertices[0]];
  return {
    type: "Feature" as const,
    properties: {},
    geometry: { type: "Polygon" as const, coordinates: [ring] },
  };
}

/**
 * Let the user draw a polygon AOI on a MapLibre map: click to add vertices,
 * double-click (or Enter) to finish, Escape to cancel. Resolves with the
 * vertices, or null when cancelled or fewer than three were placed.
 */
export function drawPolygon(
  map: MapLibreMap,
  options: AoiDrawOptions = {},
): Promise<LonLat[] | null> {
  return new Promise((resolve) => {
    const vertices: LonLat[] = [];
    const canvas = map.getCanvas();
    const prevCursor = canvas.style.cursor;
    canvas.style.cursor = "crosshair";
    map.doubleClickZoom.disable();

    const finish = (result: LonLat[] | null) => {
      map.off("click", onClick);
      map.off("dblclick", onDblClick);
      document.removeEventListener("keydown", onKey);
      canvas.style.cursor = prevCursor;
      // Re-enable after the dblclick that ended drawing has been consumed.
      setTimeout(() => map.doubleClickZoom.enable(), 0);
      resolve(result && result.length >= 3 ? result : null);
    };
    const onClick = (e: MapMouseEvent) => {
      vertices.push([e.lngLat.lng, e.lngLat.lat]);
      options.onChange?.([...vertices]);
    };
    const onDblClick = (e: MapMouseEvent) => {
      e.preventDefault();
      // The two clicks of the double-click each added the same vertex.
      if (vertices.length > 1) vertices.pop();
      finish(vertices);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(null);
      else if (e.key === "Enter") finish(vertices);
    };

    map.on("click", onClick);
    map.on("dblclick", onDblClick);
    document.addEventListener("keydown", onKey);
  });
}

/** Largest AOI extent (degrees) the titiler-cmr server handles reliably. */
export const AOI_MAX_WIDTH_DEG = 0.4;
export const AOI_MAX_HEIGHT_DEG = 0.4;

/** True when the vertices' bounding box exceeds the recommended AOI size. */
export function aoiTooLarge(vertices: LonLat[]): boolean {
  const xs = vertices.map((v) => v[0]);
  const ys = vertices.map((v) => v[1]);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  return width > AOI_MAX_WIDTH_DEG || height > AOI_MAX_HEIGHT_DEG;
}
