import { UpstreamHttpError } from "@iolab/mcp-kit";
import { iaFetch } from "./http.js";

export const SOURCE = "Open Library";
const SEARCH_URL = "https://openlibrary.org/search.json";

export type OpenLibraryDoc = {
  key: string;
  title: string;
  author_name?: string[];
  first_publish_year?: number;
  edition_count?: number;
  /** archive.org identifiers for scanned editions of this work — the bridge into ia_get_item / ia_search_inside_text. */
  ia?: string[];
};

export async function searchOpenLibrary(
  env: Env,
  params: { query: string; limit: number; offset: number },
): Promise<{ numFound: number; docs: OpenLibraryDoc[] }> {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("q", params.query);
  url.searchParams.set("fields", "key,title,author_name,first_publish_year,ia,edition_count");
  url.searchParams.set("limit", String(params.limit));
  url.searchParams.set("offset", String(params.offset));

  const response = await iaFetch(env, url);
  if (!response.ok) throw new UpstreamHttpError(SOURCE, response);
  const body = (await response.json()) as { numFound: number; docs: OpenLibraryDoc[] };
  return body;
}
