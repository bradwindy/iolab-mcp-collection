import { afterEach, describe, expect, it, vi } from "vitest";
import { getItemHandler } from "../src/tools/getItem.js";
import { fakeEnv } from "./support/fakeEnv.js";

function metadataResponse(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("ia_get_item", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("flags is_restricted for a lending-only item via the metadata API's own is_dark flag", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        metadataResponse({
          identifier: "hobbitortherebac00tolk_2",
          is_dark: true,
          metadata: { title: "The Hobbit" },
          files: [],
        }),
      ),
    );

    const result = await getItemHandler({ identifier: "hobbitortherebac00tolk_2" }, fakeEnv());

    expect(result.structuredContent?.is_restricted).toBe(true);
  });

  it("paginates a large files[] array instead of returning it all at once", async () => {
    const files = Array.from({ length: 150 }, (_, i) => ({ name: `file${i}.txt`, format: "Text" }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(metadataResponse({ identifier: "big-item", metadata: {}, files })));

    const result = await getItemHandler({ identifier: "big-item", files_limit: 50 }, fakeEnv());

    expect(result.structuredContent?.files).toHaveLength(50);
    expect(result.structuredContent?.total_count).toBe(150);
    expect(result.structuredContent?.has_more).toBe(true);
    expect(result.structuredContent?.next_offset).toBe(50);
  });
});
