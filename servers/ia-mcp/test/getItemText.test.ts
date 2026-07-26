import { afterEach, describe, expect, it, vi } from "vitest";
import { getItemTextHandler } from "../src/tools/getItemText.js";
import { fakeEnv } from "./support/fakeEnv.js";

function metadataResponse(files: Array<{ name: string }>) {
  return new Response(JSON.stringify({ identifier: "item1", metadata: {}, files }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("ia_get_item_text", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads sequentially via char_offset/max_chars and reports the true total length", async () => {
    const fullText = "0123456789".repeat(100); // 1000 chars
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/metadata/")) return Promise.resolve(metadataResponse([{ name: "item1_djvu.txt" }]));
        return Promise.resolve(new Response(fullText, { status: 200 }));
      }),
    );

    const first = await getItemTextHandler({ identifier: "item1", max_chars: 600 }, fakeEnv());
    expect(first.structuredContent?.content).toBe(fullText.slice(0, 600));
    expect(first.structuredContent?.next_offset).toBe(600);
    expect(first.structuredContent?.total_chars).toBe(1000);

    const second = await getItemTextHandler({ identifier: "item1", char_offset: 600, max_chars: 600 }, fakeEnv());
    expect(second.structuredContent?.content).toBe(fullText.slice(600));
    expect(second.structuredContent?.next_offset).toBeNull();
  });

  it("returns an actionable error when the item has no recognisable text file", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(metadataResponse([{ name: "cover.jpg" }])));

    const result = await getItemTextHandler({ identifier: "item1" }, fakeEnv());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("no recognisable full-text file");
  });

  it("returns an actionable error for a nonexistent identifier", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));

    const result = await getItemTextHandler({ identifier: "nonexistent" }, fakeEnv());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("No archive.org item found");
  });
});
