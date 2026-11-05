import { describe, expect, it } from "vitest";
import {
  filterSeries,
  polygonBboxFraction,
  timeSeriesToCsv,
  waterAreaFromStats,
} from "@/lib/dswx/timeseries";
import type { WaterAreaPoint } from "@/lib/dswx/timeseries";
import type { BandStatistics } from "@/lib/dswx/titiler";

const obs = { id: "o1", start: "2024-06-17T18:45:00Z", sensor: "L8" };

function stats(counts: number[], classes: number[], masked = 0): BandStatistics {
  return {
    min: 0,
    max: 0,
    mean: 0,
    std: 0,
    count: 0,
    maskedPixels: masked,
    histogram: [counts, classes],
  };
}

describe("waterAreaFromStats", () => {
  it("converts priority-class counts to km2 and coverage fractions", () => {
    // classes: 1 open, 2 partial, 3 not water, 4 snow/ice, 5 cloud
    const p = waterAreaFromStats(
      obs,
      stats([1000, 2000, 5000, 500, 500], [1, 2, 3, 4, 5], 1000),
    );
    expect(p.openKm2).toBeCloseTo(0.9, 6);
    expect(p.partialKm2).toBeCloseTo(1.8, 6);
    expect(p.pixels).toBe(9000);
    expect(p.totalPixels).toBe(10000);
    expect(p.maskedFraction).toBeCloseTo(0.1, 6);
    expect(p.noDataFraction).toBeCloseTo(0.1, 6);
  });

  it("does not count pixels outside the polygon as no data", () => {
    // Triangle: half of its bounding box. 500 of 1000 box pixels are outside.
    const p = waterAreaFromStats(obs, stats([500], [3], 500), 0.5);
    expect(p.noDataFraction).toBe(0);
    expect(p.totalPixels).toBe(500);
  });

  it("counts valid-pixel shortfall inside the polygon as no data", () => {
    const p = waterAreaFromStats(obs, stats([100], [3], 900), 0.5);
    expect(p.noDataFraction).toBeCloseTo(0.8, 6);
  });

  it("returns an empty point when there is no histogram", () => {
    expect(waterAreaFromStats(obs, undefined).totalPixels).toBe(0);
  });

  it("reports a fully no-data AOI as having pixels but no classes", () => {
    const p = waterAreaFromStats(obs, stats([], [], 500));
    expect(p.noDataFraction).toBe(1);
    expect(p.pixels).toBe(0);
  });
});

describe("timeSeriesToCsv", () => {
  it("writes a header and one row per point", () => {
    const csv = timeSeriesToCsv([waterAreaFromStats(obs, stats([10], [1]))]);
    const [header, row] = csv.split("\n");
    expect(header).toContain("open_water_km2");
    expect(row.startsWith("2024-06-17T18:45:00Z,L8,0.0090")).toBe(true);
  });
});

describe("priority mosaic statistics URL", () => {
  it("sends the remap, lowest mosaic and read-all flags", async () => {
    const { buildStatisticsUrl } = await import("@/lib/dswx/titiler");
    const { PRIORITY_EXPRESSION } = await import("@/lib/dswx/timeseries");
    const u = new URL(
      buildStatisticsUrl({
        endpoint: "https://x.test",
        conceptId: "C1",
        backend: "rasterio",
        bands: ["B01_WTR"],
        categorical: true,
        expression: PRIORITY_EXPRESSION,
        pixelSelection: "lowest",
        exitWhenFull: false,
        skipCovered: false,
      }),
    );
    expect(u.searchParams.get("bands")).toBe("B01_WTR");
    expect(u.searchParams.get("expression")).toBe(PRIORITY_EXPRESSION);
    expect(u.searchParams.get("pixel_selection")).toBe("lowest");
    expect(u.searchParams.get("exitwhenfull")).toBe("false");
    expect(u.searchParams.get("skipcovered")).toBe("false");
  });
});

describe("priority mosaic tilejson URL", () => {
  it("uses bands=, lowest and read-all flags; plain URLs keep assets=", async () => {
    const { buildTileJsonUrl } = await import("@/lib/dswx/titiler");
    const base = { endpoint: "https://x.test", conceptId: "C1", backend: "rasterio" as const, bands: ["B01_WTR"] };
    const u = new URL(buildTileJsonUrl({ ...base, expression: "b1", pixelSelection: "lowest" }));
    expect(u.searchParams.get("bands")).toBe("B01_WTR");
    expect(u.searchParams.has("assets")).toBe(false);
    expect(u.searchParams.get("pixel_selection")).toBe("lowest");
    expect(u.searchParams.get("exitwhenfull")).toBe("false");
    expect(u.searchParams.get("skipcovered")).toBe("false");
    expect(u.searchParams.get("asset_as_band")).toBe("true");
    const plain = new URL(buildTileJsonUrl(base));
    expect(plain.searchParams.get("assets")).toBe("B01_WTR");
    expect(plain.searchParams.has("pixel_selection")).toBe(false);
  });
});

describe("filterSeries", () => {
  const pt = (masked: number, noData: number, error?: string) =>
    ({
      observationId: "o",
      time: "2024-01-01T00:00:00Z",
      sensor: "L8",
      openKm2: 1,
      partialKm2: 0,
      maskedFraction: masked,
      noDataFraction: noData,
      pixels: 10,
      totalPixels: 10,
      error,
    }) as WaterAreaPoint;

  it("keeps everything with no limits", () => {
    expect(filterSeries([pt(0.9, 0.9)], {})).toHaveLength(1);
  });
  it("drops points over the masked or no-data limit", () => {
    const pts = [pt(0.1, 0.1), pt(0.6, 0.1), pt(0.1, 0.6)];
    expect(filterSeries(pts, { maxMasked: 0.5 })).toHaveLength(2);
    expect(filterSeries(pts, { maxNoData: 0.5 })).toHaveLength(2);
    expect(filterSeries(pts, { maxMasked: 0.5, maxNoData: 0.5 })).toHaveLength(1);
  });
  it("keeps errored points", () => {
    expect(filterSeries([pt(0.9, 0.9, "boom")], { maxMasked: 0.1 })).toHaveLength(1);
  });
});

describe("polygonBboxFraction", () => {
  const poly = (ring: number[][]) => ({
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [ring] },
  });
  it("is 1 for a rectangle", () => {
    expect(polygonBboxFraction(poly([[0, 0], [2, 0], [2, 1], [0, 1], [0, 0]]))).toBeCloseTo(1, 6);
  });
  it("is 0.5 for a right triangle", () => {
    expect(polygonBboxFraction(poly([[0, 0], [2, 0], [0, 1], [0, 0]]))).toBeCloseTo(0.5, 6);
  });
  it("falls back to 1 for non-polygons", () => {
    expect(polygonBboxFraction(undefined)).toBe(1);
  });
});
