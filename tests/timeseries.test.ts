import { describe, expect, it } from "vitest";
import {
  timeSeriesToCsv,
  waterAreaFromStats,
} from "@/lib/dswx/timeseries";
import type { BandStatistics } from "@/lib/dswx/titiler";

const obs = { id: "o1", start: "2024-06-17T18:45:00Z", sensor: "L8" };

function stats(counts: number[], classes: number[]): BandStatistics {
  return { min: 0, max: 0, mean: 0, std: 0, count: 0, histogram: [counts, classes] };
}

describe("waterAreaFromStats", () => {
  it("converts class counts to km2 at 30 m and reports obscured share", () => {
    // 1,111,111 px * 900 m2 ≈ 1000 km2
    const p = waterAreaFromStats(obs, stats([1000, 2000, 500, 500], [1, 2, 253, 0]));
    expect(p.openKm2).toBeCloseTo(0.9, 6);
    expect(p.partialKm2).toBeCloseTo(1.8, 6);
    expect(p.obscuredFraction).toBeCloseTo(500 / 4000, 6);
    expect(p.pixels).toBe(4000);
  });

  it("returns an empty point when there is no histogram", () => {
    expect(waterAreaFromStats(obs, undefined).pixels).toBe(0);
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
