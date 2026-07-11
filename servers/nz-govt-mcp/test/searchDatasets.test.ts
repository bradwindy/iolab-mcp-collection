import { afterEach, describe, expect, it, vi } from "vitest";
import { searchDatasetsHandler } from "../src/tools/searchDatasets.js";
import { getDatasetHandler } from "../src/tools/getDataset.js";

const SAMPLE_PACKAGE = {
  id: "c1923d33-e781-46c9-9ea1-d9b850082be4",
  name: "directory-of-educational-institutions",
  title: "Directory of Educational Institutions",
  notes: "The Ministry of Education maintains...",
  organization: { name: "ministry-of-education", title: "Ministry of Education" },
  license_title: "Creative Commons Attribution 4.0 International",
  license_url: "https://creativecommons.org/licenses/by/4.0/",
  metadata_modified: "2026-07-09T19:45:25.162097",
  num_resources: 6,
  tags: [{ name: "education" }, { name: "schools" }],
  resources: [
    { id: "4b292323-9fcc-41f8-814b-3c7b19cf14b3", name: "Schools Directory [.csv]", format: "CSV", url: "https://example.test/schools.csv", datastore_active: true },
  ],
};

function ckanResponse(result: unknown) {
  return new Response(JSON.stringify({ success: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("nz_govt_search_datasets", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns concise dataset summaries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(ckanResponse({ count: 1, results: [SAMPLE_PACKAGE] })),
    );

    const result = await searchDatasetsHandler({ query: "school directory" });

    expect(result.structuredContent?.items).toEqual([
      {
        id: "directory-of-educational-institutions",
        title: "Directory of Educational Institutions",
        organisation: "Ministry of Education",
        num_resources: 6,
        license: "Creative Commons Attribution 4.0 International",
      },
    ]);
    expect(result.structuredContent?.total_count).toBe(1);
  });

  it("includes resources and tags in detailed format", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(ckanResponse({ count: 1, results: [SAMPLE_PACKAGE] })),
    );

    const result = await searchDatasetsHandler({ query: "school", response_format: "detailed" });
    const item = (result.structuredContent?.items as Array<Record<string, unknown>>)[0];

    expect(item?.tags).toEqual(["education", "schools"]);
    expect((item?.resources as unknown[]).length).toBe(1);
  });

  it("surfaces a CKAN-level action failure as a tool error, not an unhandled rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: false, error: { message: "boom" } }), { status: 200 }),
      ),
    );

    // Per MCP guidance (and this repo's own toolError() convention), a tool execution failure
    // must come back as an isError:true result the model can see and react to — not a thrown
    // exception, which would surface as an opaque, unformatted, unlogged protocol-level failure.
    const result = await searchDatasetsHandler({ query: "x" });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("boom") });
  });

  it("surfaces a network-level fetch failure as a tool error, not an unhandled rejection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    const result = await searchDatasetsHandler({ query: "x" });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("could not be reached") });
  });

  it("requests a deterministic tiebreak sort, so tied datasets still paginate stably", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ckanResponse({ count: 1, results: [SAMPLE_PACKAGE] }));
    vi.stubGlobal("fetch", fetchMock);

    await searchDatasetsHandler({ query: "school directory" });

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.searchParams.get("sort")).toBe("score desc, metadata_modified desc, name asc");
  });
});

describe("nz_govt_get_dataset", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches full metadata for a dataset by slug", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ckanResponse(SAMPLE_PACKAGE)));

    const result = await getDatasetHandler({ id_or_slug: "directory-of-educational-institutions" });

    expect(result.structuredContent?.title).toBe("Directory of Educational Institutions");
    expect(result.structuredContent?.resources).toHaveLength(1);
  });

  it("returns an actionable error on upstream HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 500, statusText: "Internal Server Error" })));

    const result = await getDatasetHandler({ id_or_slug: "does-not-exist" });

    expect(result.isError).toBe(true);
  });

  it("surfaces a CKAN-level action failure as a tool error, not an unhandled rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: false, error: { message: "boom" } }), { status: 200 })),
    );

    const result = await getDatasetHandler({ id_or_slug: "x" });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("boom") });
  });

  it("surfaces a malformed (non-JSON) upstream response as a tool error, not an unhandled rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>502 Bad Gateway</html>", { status: 200 })),
    );

    const result = await getDatasetHandler({ id_or_slug: "x" });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("could not be reached") });
  });
});
