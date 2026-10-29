import { describe, it, expect } from "vitest";
import { parseGranuleUr } from "@/lib/dswx/cmr";
import { groupObservations, observationTemporal } from "@/lib/dswx/observations";
import type { DswxGranule } from "@/lib/dswx/types";

function g(tileId: string, begin: string, sensor = "S2A"): DswxGranule {
  return {
    id: `x_${tileId}_${begin}`,
    beginDate: begin,
    endDate: begin,
    geometry: null,
    dataLinks: [],
    tileId,
    sensor,
    bbox: [0, 0, 1, 1],
  };
}

describe("parseGranuleUr", () => {
  it("parses HLS and S1 names", () => {
    expect(
      parseGranuleUr("OPERA_L3_DSWx-HLS_T10SEG_20240617T184514Z_20240619T173448Z_L8_30_v1.0"),
    ).toEqual({ tileId: "T10SEG", sensor: "L8" });
    expect(
      parseGranuleUr("OPERA_L3_DSWx-S1_T40UFB_20261027T020714Z_20261027T202627Z_S1C_30_v1.0"),
    ).toEqual({ tileId: "T40UFB", sensor: "S1C" });
  });
  it("returns nothing for unknown names", () => {
    expect(parseGranuleUr("foo")).toEqual({});
  });
});

describe("groupObservations", () => {
  it("merges tiles of one pass and orders newest first", () => {
    const obs = groupObservations([
      g("T10SEG", "2024-06-15T19:14:10Z"),
      g("T10SEH", "2024-06-15T19:13:56Z"),
      g("T10SEG", "2024-06-17T19:04:12Z"),
    ]);
    expect(obs).toHaveLength(2);
    expect(obs[0].start).toBe("2024-06-17T19:04:12Z");
    expect(obs[1].tileIds).toEqual(["T10SEG", "T10SEH"]);
    expect(obs[1].start).toBe("2024-06-15T19:13:56Z");
  });

  it("mixes sensors acquired within the window", () => {
    const obs = groupObservations([
      g("T10SEG", "2024-06-17T18:45:14Z", "L8"),
      g("T10SEH", "2024-06-17T19:03:57Z", "S2B"),
    ]);
    expect(obs).toHaveLength(1);
    expect(obs[0].sensor).toBe("L8/S2B");
  });

  it("splits when the span exceeds the window", () => {
    const list = [g("A", "2024-06-17T19:00:00Z"), g("B", "2024-06-17T19:30:00Z")];
    expect(groupObservations(list, 10)).toHaveLength(2);
    expect(groupObservations(list, 60)).toHaveLength(1);
  });

  it("does not chain granules beyond the total window", () => {
    const list = [
      g("A", "2024-06-17T00:00:00Z"),
      g("B", "2024-06-17T04:00:00Z"),
      g("C", "2024-06-17T08:00:00Z"),
    ];
    expect(groupObservations(list, 360)).toHaveLength(2);
  });

  it("drops granules without a begin date", () => {
    expect(groupObservations([{ ...g("A", "x"), beginDate: undefined }])).toEqual([]);
  });
});

describe("observationTemporal", () => {
  it("pads the window by a second around the observation", () => {
    const [obs] = groupObservations([
      g("A", "2024-06-17T18:44:51Z"),
      g("B", "2024-06-17T18:45:14Z"),
    ]);
    expect(observationTemporal([obs])).toBe("2024-06-17T18:44:50Z/2024-06-17T18:45:15Z");
  });
});
