import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { READ_ONLY_OPEN_WORLD_ANNOTATIONS, type OAuthProps } from "@iolab/mcp-kit";
import { searchPagesHandler, searchPagesInputShape, searchPagesOutputShape } from "./tools/searchPages.js";
import { getPageHandler, getPageInputShape, getPageOutputShape } from "./tools/getPage.js";
import { getPageMetadataHandler, getPageMetadataInputShape, getPageMetadataOutputShape } from "./tools/getPageMetadata.js";
import { getBacklinksHandler, getBacklinksInputShape, getBacklinksOutputShape } from "./tools/getBacklinks.js";
import { getPageCategoriesHandler, getPageCategoriesInputShape, getPageCategoriesOutputShape } from "./tools/getPageCategories.js";
import { getCategoryMembersHandler, getCategoryMembersInputShape, getCategoryMembersOutputShape } from "./tools/getCategoryMembers.js";
import { searchMediaHandler, searchMediaInputShape, searchMediaOutputShape } from "./tools/searchMedia.js";
import { getMediaInfoHandler, getMediaInfoInputShape, getMediaInfoOutputShape } from "./tools/getMediaInfo.js";
import { searchEntitiesHandler, searchEntitiesInputShape, searchEntitiesOutputShape } from "./tools/searchEntities.js";
import { getEntityHandler, getEntityInputShape, getEntityOutputShape } from "./tools/getEntity.js";
import {
  queryWikidataSparqlHandler,
  queryWikidataSparqlInputShape,
  queryWikidataSparqlOutputShape,
} from "./tools/queryWikidataSparql.js";

export class WikimediaMcp extends McpAgent<Env, Record<string, never>, OAuthProps> {
  server = new McpServer({ name: "wikimedia-mcp", version: "0.1.0" });

  async init() {
    this.server.registerTool(
      "wikimedia_search_pages",
      {
        description:
          "Search Wikipedia and its sister projects to find which article covers a topic — full-text search over article text and titles, in any language. Beyond free text it exposes CirrusSearch's structured filters: restrict by category (optionally including subcategories), by title, by raw wikitext content, by last-edit date, or find pages similar to a given one. Use this when you know the subject but not the exact page title; use wikimedia_get_page once you have one. Long descriptive queries are matched leniently by default, so a term the article happens not to use will not zero out the results — pass `match: 'all'` if you need every term present.",
        inputSchema: searchPagesInputShape,
        outputSchema: searchPagesOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Search Wikimedia Pages" },
      },
      (rawInput) => searchPagesHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "wikimedia_get_page",
      {
        description:
          "Read the full text of a Wikipedia article, or any page on a sister project, in any language. Returns the article body as clean plain text — no reference dumps, no citation markers, no HTML entities. Omit `section` for the whole article; an article too long for the budget comes back as a section outline with each section's exact character count, and `section` then accepts one index or an array of them to read those parts in a single request. `include_references` additionally returns what the article cites as structured rows with DOIs and URLs. Disambiguation pages return their list of topics rather than misleading prose, and any redirect or title normalisation is reported. Use wikimedia_search_pages first if you do not already know the exact title.",
        inputSchema: getPageInputShape,
        outputSchema: getPageOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Read Wikimedia Page" },
      },
      (rawInput) => getPageHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "wikimedia_get_page_metadata",
      {
        description:
          "Look up facts about pages without reading their text: short description, thumbnail and lead image, coordinates, size, last-edit time, Wikidata id, and whether the title is a disambiguation page. Also returns quality signals worth checking before trusting an article — its assessment grade (FA, GA, B, C, Start, Stub), whether it is a stub, which maintenance problems editors have flagged and how long ago, plus edit protection and watcher count. With `include_languages` it reports every other language edition the page exists in. Accepts up to 50 titles at once, answers in the order asked, and reports which do not exist. Use this to triage or screen many titles cheaply; use wikimedia_get_page to actually read one.",
        inputSchema: getPageMetadataInputShape,
        outputSchema: getPageMetadataOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Get Page Metadata" },
      },
      (rawInput) => getPageMetadataHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "wikimedia_get_backlinks",
      {
        description:
          "Find what points at a page: articles that link to it, pages that transclude a template, or pages that display a file. Useful for gauging how central a topic is and for discovering related coverage that a text search misses. Results are cursor-paginated with no total available, so this reports how many it returned rather than how many exist; if the target page does not exist it says so instead of returning a bare empty list. Note `file_usage` covers this wiki only — a Commons file used across many wikis will look barely used here.",
        inputSchema: getBacklinksInputShape,
        outputSchema: getBacklinksOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Get Backlinks" },
      },
      (rawInput) => getBacklinksHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "wikimedia_get_page_categories",
      {
        description:
          "List the categories a page belongs to, excluding hidden maintenance categories by default. Use this to work out how a topic is classified before browsing sibling articles with wikimedia_get_category_members. For maintenance categories specifically, wikimedia_get_page_metadata already summarises them into quality flags, which is usually what you want instead of `include_hidden`.",
        inputSchema: getPageCategoriesInputShape,
        outputSchema: getPageCategoriesOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Get Page Categories" },
      },
      (rawInput) => getPageCategoriesHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "wikimedia_get_category_members",
      {
        description:
          "List what is inside a category — its articles, its subcategories, or its files. This is how you enumerate a complete set ('every bird endemic to New Zealand') rather than searching for it by keyword, which only finds pages whose text happens to match. Set `project: 'commons'` to browse Commons media categories. Cursor-paginated with no total available; a category name that does not exist is reported rather than returned as an empty list.",
        inputSchema: getCategoryMembersInputShape,
        outputSchema: getCategoryMembersOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Get Category Members" },
      },
      (rawInput) => getCategoryMembersHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "wikimedia_search_media",
      {
        description:
          "Search Wikimedia Commons for freely-licensed images, diagrams, audio, and video. Returns direct file and thumbnail URLs alongside each file's licence and author, so results can be cited or embedded.",
        inputSchema: searchMediaInputShape,
        outputSchema: searchMediaOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Search Commons Media" },
      },
      (rawInput) => searchMediaHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "wikimedia_get_media_info",
      {
        description:
          "Get everything needed to reuse one Commons file legally: original and thumbnail URLs, dimensions, MIME type, description, author, licence name and URL, and whether attribution is required.",
        inputSchema: getMediaInfoInputShape,
        outputSchema: getMediaInfoOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Get Commons File Info" },
      },
      (rawInput) => getMediaInfoHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "wikimedia_search_entities",
      {
        description:
          "Find a Wikidata item or property by name, turning a phrase like 'kiwi bird' into a Q-id, or 'date of birth' into a P-id. This is the entry point to structured data: feed the id to wikimedia_get_entity or use it in a SPARQL query. Matching is on **prefixes** of labels and aliases, not free text, so a partial word works but a description does not — search Wikipedia instead if you only know the concept, and read the article's `wikibase_item`.",
        inputSchema: searchEntitiesInputShape,
        outputSchema: searchEntitiesOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Search Wikidata Entities" },
      },
      (rawInput) => searchEntitiesHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "wikimedia_get_entity",
      {
        description:
          "Read the structured facts Wikidata holds about one entity: labels, aliases, and its statements with referenced entities resolved to readable labels rather than bare Q-ids. Statements carry their qualifiers, so repeated values are distinguishable — a population figure comes with the year it refers to, a quantity with its unit, a date with the precision it actually claims (a year-precision value is not a day). Filter to specific properties, or page through everything; sitelinks are paged separately because a country has hundreds. Pairs with a page's `wikibase_item` to go from an article to its machine-readable data.",
        inputSchema: getEntityInputShape,
        outputSchema: getEntityOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Get Wikidata Entity" },
      },
      (rawInput) => getEntityHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "wikimedia_query_wikidata_sparql",
      {
        description:
          "Run a read-only SPARQL query against Wikidata for questions no single lookup can answer, such as aggregating or cross-referencing across millions of items. Wikidata is split into two disjoint graphs: 'main' holds no scholarly articles at all, and 'scholarly' holds those ~45 million items — pick with the `graph` parameter, because querying the wrong one returns zero rows rather than an error.",
        inputSchema: queryWikidataSparqlInputShape,
        outputSchema: queryWikidataSparqlOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Query Wikidata (SPARQL)" },
      },
      (rawInput) => queryWikidataSparqlHandler(rawInput, this.env),
    );
  }
}
