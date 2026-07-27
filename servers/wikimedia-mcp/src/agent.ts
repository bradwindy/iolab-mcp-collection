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
          "Search Wikipedia or a sister project (Wiktionary, Wikisource, Wikiquote, Wikivoyage, Wikinews, Wikispecies) in any language. Beyond free text it exposes CirrusSearch's structured filters directly: restrict by category (optionally including subcategories), by title, by raw wikitext content, by last-edit date, or find pages similar to a given one.",
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
          "Read a page's text from any Wikimedia project and language. Omit `section` for the whole article; articles too long to return whole come back as a section outline plus their opening text, so you can re-request one section by index. Disambiguation pages return their list of topics rather than misleading prose, and any redirect or title normalisation is reported.",
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
          "Look up facts about pages without reading them: short description, thumbnail and lead image, coordinates, size, last-edit time, Wikidata id, whether the title is a disambiguation page, and — with `include_languages` — every other language edition the page exists in and what it is called there. Accepts up to 50 titles at once and reports which don't exist.",
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
          "Find what points at a page: articles that link to it, pages that transclude a template, or pages that display a file. Useful for gauging how central a topic is and for discovering related coverage that a text search misses.",
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
          "List the categories a page belongs to, excluding hidden maintenance categories by default. Use this to work out how a topic is classified before browsing sibling articles with wikimedia_get_category_members.",
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
          "List what is inside a category — its articles, its subcategories, or its files. This is how you enumerate a set ('every bird endemic to New Zealand') rather than searching for it by keyword.",
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
          "Find a Wikidata item or property by name, turning a phrase like 'kiwi bird' into a Q-id, or 'date of birth' into a P-id. This is the entry point to structured data — Wikidata's REST API has no search of its own.",
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
          "Read the structured facts Wikidata holds about one entity: labels, aliases, and its statements with referenced entities resolved to readable labels rather than bare Q-ids. Filter to specific properties, or page through everything. Pairs with a page's `wikibase_item` to go from an article to its machine-readable data.",
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
