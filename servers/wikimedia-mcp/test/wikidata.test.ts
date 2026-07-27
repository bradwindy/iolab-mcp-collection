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
});
