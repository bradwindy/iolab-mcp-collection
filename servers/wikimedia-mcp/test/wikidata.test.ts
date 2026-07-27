import { afterEach, describe, expect, it, vi } from "vitest";
import { getEntityHandler } from "../src/tools/getEntity.js";
import { searchEntitiesHandler } from "../src/tools/searchEntities.js";
import { calledUrls, fakeEnv, stubFetchRoutes } from "./support/fakeEnv.js";

const isRest = (url: string) => url.includes("/rest.php/wikibase/v1/");
const isLabels = (url: string) => url.includes("action=wbgetentities");
const anyUrl = () => true;

describe("wikimedia_search_entities", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns Q-ids with the match type that explains a surprising result", async () => {
    stubFetchRoutes([
      {
        match: anyUrl,
        body: {
          searchinfo: { search: "kiwi bird" },
          search: [
            {
              id: "Q43642",
              title: "Q43642",
              pageid: 45830,
              label: "Apteryx",
              description: "genus of birds",
              // Live response: 'kiwi bird' matches the ALIAS, not the label — without surfacing
              // this, a caller can't tell why they got "Apteryx" back.
              match: { type: "alias", language: "en", text: "kiwi bird" },
              aliases: ["kiwi bird"],
            },
          ],
          success: 1,
        },
      },
    ]);

    const result = await searchEntitiesHandler({ query: "kiwi bird" }, fakeEnv());

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.entities).toEqual([
      {
        id: "Q43642",
        label: "Apteryx",
        description: "genus of birds",
        matched_on: "alias",
        matched_text: "kiwi bird",
        url: "https://www.wikidata.org/wiki/Q43642",
      },
    ]);
  });

  it("treats search-continue as a genuine offset, unlike the wiki list modules", async () => {
    stubFetchRoutes([{ match: anyUrl, body: { search: [{ id: "Q1" }, { id: "Q2" }], "search-continue": 2 } }]);

    const result = await searchEntitiesHandler({ query: "kiwi", limit: 2 }, fakeEnv());

    expect(result.structuredContent?.has_more).toBe(true);
    expect(result.structuredContent?.next_offset).toBe(2);
  });

  it("reports the end of results as a null offset", async () => {
    stubFetchRoutes([{ match: anyUrl, body: { search: [{ id: "Q1" }] } }]);

    const result = await searchEntitiesHandler({ query: "kiwi" }, fakeEnv());

    expect(result.structuredContent?.has_more).toBe(false);
    expect(result.structuredContent?.next_offset).toBeNull();
  });

  it("searches properties when asked, since P-ids need a different type", async () => {
    const mock = stubFetchRoutes([{ match: anyUrl, body: { search: [] } }]);

    await searchEntitiesHandler({ query: "date of birth", type: "property" }, fakeEnv());

    expect((calledUrls(mock)[0] as URL).searchParams.get("type")).toBe("property");
  });
});

const entityBody = {
  type: "item",
  id: "Q43642",
  labels: { en: "Apteryx" },
  descriptions: { en: "genus of birds" },
  aliases: { en: ["kiwi bird"] },
  statements: {
    P31: [
      {
        id: "Q43642$00A808EA",
        rank: "normal",
        qualifiers: [],
        references: [],
        property: { id: "P31", data_type: "wikibase-item" },
        value: { type: "value", content: "Q16521" },
      },
    ],
    P225: [{ id: "Q43642$x", rank: "normal", property: { id: "P225", data_type: "string" }, value: { type: "value", content: "Apteryx" } }],
  },
  sitelinks: { enwiki: { title: "Kiwi (bird)", badges: [], url: "https://en.wikipedia.org/wiki/Kiwi_(bird)" } },
};

describe("wikimedia_get_entity", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("resolves referenced entity ids to readable labels instead of returning bare Q-ids", async () => {
    stubFetchRoutes([
      { match: isRest, body: entityBody },
      { match: isLabels, body: { entities: { P31: { labels: { en: { value: "instance of" } } }, Q16521: { labels: { en: { value: "taxon" } } }, P225: { labels: { en: { value: "taxon name" } } } } } },
    ]);

    const result = await getEntityHandler({ entity_id: "Q43642" }, fakeEnv());

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.statements).toEqual([
      { property_id: "P31", property_label: "instance of", value: "taxon", value_entity_id: "Q16521", value_type: "wikibase-item", rank: "normal" },
      { property_id: "P225", property_label: "taxon name", value: "Apteryx", value_type: "string", rank: "normal" },
    ]);
    expect(result.structuredContent?.label).toBe("Apteryx");
    expect(result.structuredContent?.aliases).toEqual(["kiwi bird"]);
  });

  it("falls back to the raw id when a label lookup returns nothing", async () => {
    stubFetchRoutes([
      { match: isRest, body: entityBody },
      { match: isLabels, body: { entities: {} } },
    ]);

    const result = await getEntityHandler({ entity_id: "Q43642" }, fakeEnv());

    expect((result.structuredContent?.statements as Array<{ value: string }>)[0]?.value).toBe("Q16521");
  });

  it("filters to requested properties and errors usefully when none match", async () => {
    stubFetchRoutes([
      { match: isRest, body: entityBody },
      { match: isLabels, body: { entities: { P31: { labels: { en: { value: "instance of" } } } } } },
    ]);
    const filtered = await getEntityHandler({ entity_id: "Q43642", properties: ["P31"] }, fakeEnv());
    expect((filtered.structuredContent?.statements as unknown[]).length).toBe(1);

    vi.unstubAllGlobals();
    stubFetchRoutes([{ match: isRest, body: entityBody }]);
    const missing = await getEntityHandler({ entity_id: "Q43642", properties: ["P999"] }, fakeEnv());
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toContain("P999");
  });

  it("paginates statements client-side, since entities carry hundreds", async () => {
    stubFetchRoutes([
      { match: isRest, body: entityBody },
      { match: isLabels, body: { entities: {} } },
    ]);

    const result = await getEntityHandler({ entity_id: "Q43642", limit: 1, offset: 0 }, fakeEnv());

    expect((result.structuredContent?.statements as unknown[]).length).toBe(1);
    expect(result.structuredContent?.total_count).toBe(2);
    expect(result.structuredContent?.has_more).toBe(true);
    expect(result.structuredContent?.next_offset).toBe(1);
  });

  it("omits sitelinks unless asked, since popular entities have over a hundred", async () => {
    stubFetchRoutes([
      { match: isRest, body: entityBody },
      { match: isLabels, body: { entities: {} } },
    ]);
    const without = await getEntityHandler({ entity_id: "Q43642" }, fakeEnv());
    expect(without.structuredContent?.sitelinks).toBeUndefined();

    vi.unstubAllGlobals();
    stubFetchRoutes([
      { match: isRest, body: entityBody },
      { match: isLabels, body: { entities: {} } },
    ]);
    const withLinks = await getEntityHandler({ entity_id: "Q43642", include_sitelinks: true }, fakeEnv());
    expect(withLinks.structuredContent?.sitelinks).toEqual([
      { wiki: "enwiki", title: "Kiwi (bird)", url: "https://en.wikipedia.org/wiki/Kiwi_(bird)" },
    ]);
  });

  it("renders time, quantity and coordinate values readably rather than as JSON blobs", async () => {
    stubFetchRoutes([
      {
        match: isRest,
        body: {
          id: "Q1",
          statements: {
            P569: [{ property: { id: "P569", data_type: "time" }, value: { type: "value", content: { time: "+1952-03-11T00:00:00Z" } } }],
            P1082: [{ property: { id: "P1082", data_type: "quantity" }, value: { type: "value", content: { amount: "+5000" } } }],
            P625: [{ property: { id: "P625", data_type: "globe-coordinate" }, value: { type: "value", content: { latitude: -41.3, longitude: 174.8 } } }],
            P0: [{ property: { id: "P0", data_type: "wikibase-item" }, value: { type: "novalue" } }],
          },
        },
      },
      { match: isLabels, body: { entities: {} } },
    ]);

    const result = await getEntityHandler({ entity_id: "Q1" }, fakeEnv());

    const values = (result.structuredContent?.statements as Array<{ value: string }>).map((statement) => statement.value);
    expect(values).toEqual(["+1952-03-11T00:00:00Z", "+5000", "-41.3, 174.8", "(no value)"]);
  });

  it("routes a P-id to the properties route rather than items", async () => {
    const mock = stubFetchRoutes([
      { match: isRest, body: { id: "P31", statements: {} } },
      { match: isLabels, body: { entities: {} } },
    ]);

    await getEntityHandler({ entity_id: "p31" }, fakeEnv());

    expect((calledUrls(mock)[0] as URL).pathname).toContain("/entities/properties/P31");
  });

  it("turns a 404 into an actionable error pointing at the search tool", async () => {
    stubFetchRoutes([{ match: isRest, body: { code: "resource-not-found" }, status: 404 }]);

    const result = await getEntityHandler({ entity_id: "Q999999999" }, fakeEnv());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("wikimedia_search_entities");
  });

  it("rejects a malformed entity id at the schema", async () => {
    const error = await getEntityHandler({ entity_id: "not-an-id" }, fakeEnv()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
  });

  it("surfaces the qualifiers that tell two statements of the same property apart", async () => {
    // The reported defect: Q664 returned 36 `population` values with no point in time, no unit and
    // no way to order them. The data was in the payload the whole time.
    stubFetchRoutes([
      {
        match: isRest,
        body: {
          id: "Q664",
          statements: {
            P1082: [
              {
                id: "Q664$a",
                rank: "normal",
                property: { id: "P1082", data_type: "quantity" },
                value: { type: "value", content: { amount: "+3516000", unit: "1" } },
                qualifiers: [
                  {
                    property: { id: "P585", data_type: "time" },
                    value: {
                      type: "value",
                      content: { time: "+1991-12-31T00:00:00Z", precision: 11, calendarmodel: "http://www.wikidata.org/entity/Q1985727" },
                    },
                  },
                ],
              },
            ],
          },
        },
      },
      {
        match: isLabels,
        body: { entities: { P1082: { labels: { en: { value: "population", language: "en" } } }, P585: { labels: { en: { value: "point in time", language: "en" } } } } },
      },
    ]);

    const result = await getEntityHandler({ entity_id: "Q664", properties: ["P1082"] }, fakeEnv());

    const statements = result.structuredContent?.statements as Array<Record<string, unknown>>;
    expect(statements[0]?.["value"]).toBe("+3516000");
    expect(statements[0]?.["qualifiers"]).toEqual([
      {
        property_id: "P585",
        property_label: "point in time",
        value: "31 December 1991",
        precision: 11,
        precision_label: "day",
        calendar_model: "proleptic Gregorian",
      },
    ]);
  });

  it("asks for a language fallback and reports which language actually answered", async () => {
    // With `language: "mi"` and no fallback, wbgetentities returns {} for an id with no te reo label
    // and the tool degraded into a wall of bare Q-ids — the exact thing it exists to prevent.
    const mock = stubFetchRoutes([
      {
        match: isRest,
        body: {
          id: "Q43642",
          statements: {
            P31: [{ property: { id: "P31", data_type: "wikibase-item" }, value: { type: "value", content: "Q16521" } }],
          },
        },
      },
      {
        match: isLabels,
        body: {
          entities: {
            P31: { labels: { mi: { value: "he tauira o", language: "mi" } } },
            // The live shape of a fallback: `language` reports what served it, `for-language` marks
            // that it is a fallback. Note it is not always English — some ids fall back to `mul`.
            Q16521: { labels: { mi: { value: "taxon", language: "en", "for-language": "mi" } } },
          },
        },
      },
    ]);

    const result = await getEntityHandler({ entity_id: "Q43642", language: "mi" }, fakeEnv());

    const labelsUrl = calledUrls(mock).find((url) => url.searchParams.has("languages")) as URL;
    expect(labelsUrl.searchParams.get("languages")).toBe("mi|en");
    expect(labelsUrl.searchParams.get("languagefallback")).toBe("1");

    const statements = result.structuredContent?.statements as Array<Record<string, unknown>>;
    expect(statements[0]?.["value"]).toBe("taxon");
    expect(result.structuredContent?.label_fallbacks).toEqual({ Q16521: "en" });
  });

  it("resolves labels for reference values, not just reference properties", async () => {
    // Review finding: collectValueIds skipped references entirely, so `stated in` came back as the
    // bare "Q328" while its property label resolved — half-working reads worse than not working.
    stubFetchRoutes([
      {
        match: isRest,
        body: {
          id: "Q42",
          statements: {
            P31: [
              {
                property: { id: "P31", data_type: "wikibase-item" },
                value: { type: "value", content: "Q5" },
                references: [
                  {
                    hash: "abc",
                    parts: [{ property: { id: "P248", data_type: "wikibase-item" }, value: { type: "value", content: "Q328" } }],
                  },
                ],
              },
            ],
          },
        },
      },
      {
        match: isLabels,
        body: {
          entities: {
            P31: { labels: { en: { value: "instance of", language: "en" } } },
            P248: { labels: { en: { value: "stated in", language: "en" } } },
            Q5: { labels: { en: { value: "human", language: "en" } } },
            Q328: { labels: { en: { value: "English Wikipedia", language: "en" } } },
          },
        },
      },
    ]);

    const result = await getEntityHandler({ entity_id: "Q42", include_references: true }, fakeEnv());

    const statements = result.structuredContent?.statements as Array<Record<string, unknown>>;
    expect(statements[0]?.["references"]).toEqual([
      {
        hash: "abc",
        parts: [{ property_id: "P248", property_label: "stated in", value: "English Wikipedia", entity_id: "Q328" }],
      },
    ]);
  });

  it("pages sitelinks separately and reports their own total", async () => {
    // `limit` governs statements; a country has 300+ sitelinks, so `include_sitelinks: true` with
    // `limit: 10` used to return every one of them — thousands of tokens in a call that looked bounded.
    stubFetchRoutes([
      {
        match: isRest,
        body: {
          id: "Q664",
          statements: {},
          sitelinks: Object.fromEntries(
            Array.from({ length: 40 }, (_, index) => [`wiki${index}`, { title: `Title ${index}`, url: `https://example.org/${index}` }]),
          ),
        },
      },
      { match: isLabels, body: { entities: {} } },
    ]);

    const result = await getEntityHandler({ entity_id: "Q664", include_sitelinks: true, sitelinks_limit: 5, sitelinks_offset: 10 }, fakeEnv());

    expect((result.structuredContent?.sitelinks as unknown[]).length).toBe(5);
    expect(result.structuredContent?.sitelinks_total).toBe(40);
    expect(result.structuredContent?.sitelinks_next_offset).toBe(15);
    // total_count is statements, and now says so in the schema rather than implying it bounds the
    // sitelinks too.
    expect(result.structuredContent?.total_count).toBe(0);
  });

  it("resolves a quantity's unit symbol from P5061 in one extra batched call", async () => {
    const mock = stubFetchRoutes([
      {
        match: isRest,
        body: {
          id: "Q664",
          statements: {
            P2046: [
              {
                property: { id: "P2046", data_type: "quantity" },
                value: { type: "value", content: { amount: "+268021", unit: "http://www.wikidata.org/entity/Q712226" } },
              },
            ],
          },
        },
      },
      {
        match: (url: string) => url.includes("props=claims"),
        body: { entities: { Q712226: { claims: { P5061: [{ mainsnak: { datavalue: { value: { text: "km²", language: "en" } } } }] } } } },
      },
      { match: isLabels, body: { entities: { P2046: { labels: { en: { value: "area", language: "en" } } } } } },
    ]);

    const result = await getEntityHandler({ entity_id: "Q664", properties: ["P2046"] }, fakeEnv());

    const statements = result.structuredContent?.statements as Array<Record<string, unknown>>;
    expect(statements[0]?.["value"]).toBe("+268021 km²");
    expect(statements[0]?.["unit_id"]).toBe("Q712226");
    expect(calledUrls(mock).filter((url) => url.searchParams.get("props") === "claims")).toHaveLength(1);
  });
});
