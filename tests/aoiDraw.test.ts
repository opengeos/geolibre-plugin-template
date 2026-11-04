import { describe, expect, it } from "vitest";
import { aoiTooLarge } from "../src/lib/core/aoiDraw";

describe("aoiTooLarge", () => {
  it("accepts a lake-sized AOI", () => {
    expect(aoiTooLarge([[-122.4, 40.6], [-122.1, 40.6], [-122.1, 40.9]])).toBe(false);
  });
  it("flags a wide AOI", () => {
    expect(aoiTooLarge([[-123, 40], [-122, 40], [-122, 40.1]])).toBe(true);
  });
  it("flags a tall AOI", () => {
    expect(aoiTooLarge([[-122, 40], [-121.9, 40], [-121.9, 40.5]])).toBe(true);
  });
});
