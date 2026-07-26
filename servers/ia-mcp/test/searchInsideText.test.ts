import { afterEach, describe, expect, it, vi } from "vitest";
import { searchInsideTextHandler } from "../src/tools/searchInsideText.js";
import { fakeEnv } from "./support/fakeEnv.js";

function metadataResponse(files: Array<{ name: string }>) {
  return new Response(JSON.stringify({ identifier: "item1", metadata: {}, files }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("ia_search_inside_text", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("resolves the text file from files[] rather than guessing <id>_djvu.txt — confirmed live it's sometimes arbitrary", async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/metadata/")) return Promise.resolve(metadataResponse([{ name: "cover.jpg" }, { name: "b190w10.txt" }]));
      expect(url).toContain("b190w10.txt"); // the resolved (non-conventional) filename, not <id>_djvu.txt
      return Promise.resolve(new Response("the moon landing happened in 1969", { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchInsideTextHandler({ identifier: "item1", query: "moon landing" }, fakeEnv());

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.matches).toHaveLength(1);
  });

  it("returns an actionable error on a 401 lending-restricted download, distinct from a generic upstream error", async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/metadata/")) return Promise.resolve(metadataResponse([{ name: "item1_djvu.txt" }]));
      return Promise.resolve(new Response("Unauthorized", { status: 401 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchInsideTextHandler({ identifier: "item1", query: "anything" }, fakeEnv());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("lending-restricted");
  });

  it("returns matches with context and character offsets", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/metadata/")) return Promise.resolve(metadataResponse([{ name: "item1_djvu.txt" }]));
        return Promise.resolve(new Response("The quick brown fox jumps over the lazy dog", { status: 200 }));
      }),
    );

    const result = await searchInsideTextHandler({ identifier: "item1", query: "fox", context_chars: 20 }, fakeEnv());

    const matches = result.structuredContent?.matches as Array<{ char_offset: number; passage: string }>;
    expect(matches[0]?.char_offset).toBe(16);
    expect(matches[0]?.passage).toContain("fox");
  });
});
