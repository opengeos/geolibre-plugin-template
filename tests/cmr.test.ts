import { afterEach, describe, expect, it, vi } from "vitest";
import { searchGranules } from "@/lib/dswx/cmr";

function item(n: number) {
  return {
    meta: { "collection-concept-id": "C1" },
    umm: {
      GranuleUR: `OPERA_L3_DSWx-HLS_T10SEG_20240617T18${String(n).padStart(2, "0")}00Z_20240619T173448Z_L8_30_v1.0`,
      TemporalExtent: { RangeDateTime: { BeginningDateTime: "2024-06-17T18:45:00Z" } },
    },
  };
}

function response(items: unknown[], after: string | null, hits: number) {
  return {
    ok: true,
    headers: { get: (k: string) => (k === "CMR-Search-After" ? after : null) },
    json: async () => ({ hits, items }),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("searchGranules paging", () => {
  it("follows CMR-Search-After until the limit and reports the total", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response([item(1), item(2)], "tok", 5))
      .mockResolvedValueOnce(response([item(3), item(4)], "tok2", 5));
    vi.stubGlobal("fetch", fetchMock);
    const r = await searchGranules({ shortName: "X", count: 3 });
    expect(r.granules).toHaveLength(3);
    expect(r.total).toBe(5);
    expect(fetchMock.mock.calls[1][1].headers["CMR-Search-After"]).toBe("tok");
    expect(fetchMock.mock.calls[0][0]).toContain("sort_key=-start_date");
  });

  it("stops when CMR has no more pages", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response([item(1)], null, 1));
    vi.stubGlobal("fetch", fetchMock);
    const r = await searchGranules({ shortName: "X", count: 100 });
    expect(r.granules).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
