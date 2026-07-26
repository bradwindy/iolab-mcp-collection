import { afterEach, describe, expect, it, vi } from "vitest";
import { getItemHandler } from "../src/tools/getItem.js";
import { fakeEnv } from "./support/fakeEnv.js";

// Matches the REAL shape of GET /metadata/<id>, confirmed live: there is no top-level
// `identifier` field — it's nested at `metadata.identifier`. An earlier version of this test
// mocked a top-level `identifier` field that the real API never sends, which is why the bug this
// covers (every call failing output validation with identifier: undefined) went unnoticed.
function metadataResponse(body: { metadata?: Record<string, unknown>; files?: unknown[]; is_dark?: boolean }) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("ia_get_item", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads identifier from metadata.identifier, not a nonexistent top-level field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        metadataResponse({
          metadata: { identifier: "nasa", title: "NASA Images" },
          files: [],
        }),
      ),
    );

    const result = await getItemHandler({ identifier: "nasa" }, fakeEnv());

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.identifier).toBe("nasa");
  });

  it("falls back to the requested identifier if metadata.identifier is somehow missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(metadataResponse({ metadata: { title: "Untitled" }, files: [] })));

    const result = await getItemHandler({ identifier: "some-id" }, fakeEnv());

    expect(result.structuredContent?.identifier).toBe("some-id");
  });

  it("returns an actionable error for a nonexistent identifier (archive.org responds 200 with {})", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(metadataResponse({})));

    const result = await getItemHandler({ identifier: "this-does-not-exist" }, fakeEnv());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("No archive.org item found");
  });

  it("drops fav-* pseudo-collections but keeps real ones", async () => {
    const collection = ["movies", "fav-alice", "fav-bob", "nasa"];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(metadataResponse({ metadata: { identifier: "nasa", collection }, files: [] })),
    );

    const result = await getItemHandler({ identifier: "nasa" }, fakeEnv());

    expect(result.structuredContent?.collections).toEqual(["movies", "nasa"]);
  });

  it("flags is_restricted for a lending-only item via the metadata API's own is_dark flag", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        metadataResponse({
          is_dark: true,
          metadata: { identifier: "hobbitortherebac00tolk_2", title: "The Hobbit" },
          files: [],
        }),
      ),
    );

    const result = await getItemHandler({ identifier: "hobbitortherebac00tolk_2" }, fakeEnv());

    expect(result.structuredContent?.is_restricted).toBe(true);
  });

  it("paginates a large files[] array instead of returning it all at once", async () => {
    const files = Array.from({ length: 150 }, (_, i) => ({ name: `file${i}.txt`, format: "Text" }));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(metadataResponse({ metadata: { identifier: "big-item" }, files })),
    );

    const result = await getItemHandler({ identifier: "big-item", files_limit: 50 }, fakeEnv());

    expect(result.structuredContent?.files).toHaveLength(50);
    expect(result.structuredContent?.total_count).toBe(150);
    expect(result.structuredContent?.has_more).toBe(true);
    expect(result.structuredContent?.next_offset).toBe(50);
  });
});
