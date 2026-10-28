import { describe, expect, it } from "vitest";
import { colormapForBand } from "../src/lib/dswx/colormaps";

const parse = (shortName: string, band: string) =>
  JSON.parse(colormapForBand(shortName, band)!) as Record<string, number[]>;

describe("colormapForBand", () => {
  it("renders HLS not-water (0) opaque white", () => {
    expect(parse("OPERA_L3_DSWX-HLS_V1", "B01_WTR")["0"]).toEqual([255, 255, 255, 255]);
  });

  it("renders S1 not-water (0) opaque white and masks fill", () => {
    const cmap = parse("OPERA_L3_DSWX-S1_V1", "B01_WTR");
    expect(cmap["0"]).toEqual([255, 255, 255, 255]);
    expect(cmap["255"][3]).toBe(0);
  });

  it("matches the palettes embedded in the product COGs", () => {
    const hls = parse("OPERA_L3_DSWX-HLS_V1", "B01_WTR");
    expect(hls["254"]).toEqual([0, 0, 127, 255]);
    const s1 = parse("OPERA_L3_DSWX-S1_V1", "B01_WTR");
    expect(s1["3"]).toEqual([0, 255, 0, 255]);
    expect(s1["250"]).toEqual([200, 200, 200, 255]);
    expect(s1["251"]).toEqual([128, 128, 128, 255]);
  });

  it("includes the S1 classes 5-8 and 30-37 from the embedded palette", () => {
    const s1 = parse("OPERA_L3_DSWX-S1_V1", "B01_WTR");
    expect(s1["6"]).toEqual([240, 20, 20, 255]);
    expect(s1["30"]).toEqual([0, 100, 0, 255]);
    expect(s1["37"]).toEqual([100, 150, 25, 255]);
  });

  it("uses product-specific classes", () => {
    expect(parse("OPERA_L3_DSWX-HLS_V1", "B01_WTR")["2"]).toBeDefined();
    expect(parse("OPERA_L3_DSWX-S1_V1", "B01_WTR")["3"]).toBeDefined();
  });

  it("returns undefined for non-categorical bands", () => {
    expect(colormapForBand("OPERA_L3_DSWX-HLS_V1", "B03_CONF")).toBeUndefined();
  });
});
