import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { READ_ONLY_OPEN_WORLD_ANNOTATIONS, type OAuthProps } from "@iolab/mcp-kit";
import {
  waybackSearchCapturesHandler,
  waybackSearchCapturesInputShape,
  waybackSearchCapturesOutputShape,
} from "./tools/waybackSearchCaptures.js";
import { waybackReadPageHandler, waybackReadPageInputShape, waybackReadPageOutputShape } from "./tools/waybackReadPage.js";
import {
  waybackGetCaptureTimelineHandler,
  waybackGetCaptureTimelineInputShape,
  waybackGetCaptureTimelineOutputShape,
} from "./tools/waybackGetCaptureTimeline.js";
import {
  waybackDiffCapturesHandler,
  waybackDiffCapturesInputShape,
  waybackDiffCapturesOutputShape,
} from "./tools/waybackDiffCaptures.js";
import {
  waybackListSiteUrlsHandler,
  waybackListSiteUrlsInputShape,
  waybackListSiteUrlsOutputShape,
} from "./tools/waybackListSiteUrls.js";
import {
  waybackFindNearestCaptureHandler,
  waybackFindNearestCaptureInputShape,
  waybackFindNearestCaptureOutputShape,
} from "./tools/waybackFindNearestCapture.js";
import { searchItemsHandler, searchItemsInputShape, searchItemsOutputShape } from "./tools/searchItems.js";
import { getItemHandler, getItemInputShape, getItemOutputShape } from "./tools/getItem.js";
import {
  searchInsideTextHandler,
  searchInsideTextInputShape,
  searchInsideTextOutputShape,
} from "./tools/searchInsideText.js";
import { getItemTextHandler, getItemTextInputShape, getItemTextOutputShape } from "./tools/getItemText.js";
import {
  openlibrarySearchHandler,
  openlibrarySearchInputShape,
  openlibrarySearchOutputShape,
} from "./tools/openlibrarySearch.js";

export class InternetArchiveMcp extends McpAgent<Env, Record<string, never>, OAuthProps> {
  server = new McpServer({ name: "ia-mcp", version: "0.1.0" });

  async init() {
    this.server.registerTool(
      "ia_wayback_search_captures",
      {
        description:
          "Search the Wayback Machine's CDX index for every archived capture of a URL: timestamps, HTTP status, MIME type, and a content digest that lets you spot which captures actually changed without fetching each page.",
        inputSchema: waybackSearchCapturesInputShape,
        outputSchema: waybackSearchCapturesOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Search Wayback Captures" },
      },
      (rawInput) => waybackSearchCapturesHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "ia_wayback_read_page",
      {
        description:
          "Read the text, markdown, links, or raw HTML of an archived web page at a given (or most recent) Wayback Machine capture. Always reports the actual capture date served, which can differ from the requested one.",
        inputSchema: waybackReadPageInputShape,
        outputSchema: waybackReadPageOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Read Archived Page" },
      },
      (rawInput) => waybackReadPageHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "ia_wayback_get_capture_timeline",
      {
        description:
          "Summarise a URL's capture history: first/last capture, per-year counts, the largest gaps between captures, and how many distinct content versions were actually captured.",
        inputSchema: waybackGetCaptureTimelineInputShape,
        outputSchema: waybackGetCaptureTimelineOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Get Capture Timeline" },
      },
      (rawInput) => waybackGetCaptureTimelineHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "ia_wayback_diff_captures",
      {
        description:
          "Compare two Wayback Machine captures of the same URL and show what text changed between them — short-circuits cheaply when the two captures' content digests already match.",
        inputSchema: waybackDiffCapturesInputShape,
        outputSchema: waybackDiffCapturesOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Diff Two Captures" },
      },
      (rawInput) => waybackDiffCapturesHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "ia_wayback_list_site_urls",
      {
        description:
          "Discover which URLs under a site or path prefix the Wayback Machine has ever captured, with each URL's most recent capture date and status.",
        inputSchema: waybackListSiteUrlsInputShape,
        outputSchema: waybackListSiteUrlsOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "List Site URLs" },
      },
      (rawInput) => waybackListSiteUrlsHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "ia_wayback_find_nearest_capture",
      {
        description: "Find the Wayback Machine capture closest to a target date, whether just before or just after it.",
        inputSchema: waybackFindNearestCaptureInputShape,
        outputSchema: waybackFindNearestCaptureOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Find Nearest Capture" },
      },
      (rawInput) => waybackFindNearestCaptureHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "ia_search_items",
      {
        description:
          "Search archive.org's item corpus (books, movies, audio, software, and more) by keyword, media type, collection, and year range.",
        inputSchema: searchItemsInputShape,
        outputSchema: searchItemsOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Search Archive.org Items" },
      },
      (rawInput) => searchItemsHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "ia_get_item",
      {
        description:
          "Fetch full metadata for one archive.org item by identifier: title, creator, date, description, subjects, licence, and a paginated file list. Flags lending-restricted items.",
        inputSchema: getItemInputShape,
        outputSchema: getItemOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Get Item Metadata" },
      },
      (rawInput) => getItemHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "ia_search_inside_text",
      {
        description:
          "Search within one archive.org text item's full text for a phrase, returning matching passages with surrounding context and character offsets that feed into ia_get_item_text. Only works for public-domain / openly-licensed items.",
        inputSchema: searchInsideTextInputShape,
        outputSchema: searchInsideTextOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Search Inside Item Text" },
      },
      (rawInput) => searchInsideTextHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "ia_get_item_text",
      {
        description:
          "Read an archive.org text item's full text sequentially, paging through with char_offset/max_chars. Only works for public-domain / openly-licensed items.",
        inputSchema: getItemTextInputShape,
        outputSchema: getItemTextOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Get Item Text" },
      },
      (rawInput) => getItemTextHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "ia_openlibrary_search",
      {
        description:
          "Search Open Library for a book by title or author; returns bibliographic details plus any archive.org identifiers for scanned editions, feeding directly into ia_get_item / ia_search_inside_text.",
        inputSchema: openlibrarySearchInputShape,
        outputSchema: openlibrarySearchOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Search Open Library" },
      },
      (rawInput) => openlibrarySearchHandler(rawInput, this.env),
    );
  }
}
