import { fetchWithBackoff, UpstreamHttpError } from "@iolab/mcp-kit";

const BASE_URL = "https://data-aucklandcouncil.opendata.arcgis.com/api/search/v1";
const SOURCE = "Auckland Council Open Data";
const USER_AGENT = "nz-mcp-collection/nz-govt-mcp (+https://github.com/bradwindy/nz-mcp-collection)";

export type OpenDataItem = {
  id: string;
  title: string;
  type: string;
  snippet: string | null;
  tags: string[];
  owner: string;
  modified: number;
  url: string;
  license: string | null;
};

export type OpenDataSearchResult = {
  items: OpenDataItem[];
  numberMatched: number;
};

type AucklandFeature = {
  id: string;
  properties: {
    title: string;
    type: string;
    snippet: string | null;
    tags: string[] | null;
    owner: string;
    modified: number;
    url: string;
    license: string | null;
  };
};

type AucklandFeatureCollection = {
  features: AucklandFeature[];
  numberMatched: number;
  numberReturned: number;
};

/**
 * Search the Data collection of Auckland Council's ArcGIS Hub catalogue.
 * Deliberately drops the `geometry`/`extent` polygons the upstream API embeds on every
 * catalog item (a full bounding-box polygon per result) — they describe dataset coverage,
 * not the data itself, and would otherwise obliterate the context window for no benefit.
 */
export async function searchOpenData(params: {
  query: string;
  limit: number;
  startIndex: number;
}): Promise<OpenDataSearchResult> {
  const url = new URL(`${BASE_URL}/collections/dataset/items`);
  url.searchParams.set("q", params.query);
  url.searchParams.set("limit", String(params.limit));
  if (params.startIndex > 0) url.searchParams.set("startindex", String(params.startIndex));

  const response = await fetchWithBackoff(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new UpstreamHttpError(SOURCE, response);

  const body = (await response.json()) as AucklandFeatureCollection;
  return {
    numberMatched: body.numberMatched,
    items: body.features.map((feature) => ({
      id: feature.id,
      title: feature.properties.title,
      type: feature.properties.type,
      snippet: feature.properties.snippet,
      tags: feature.properties.tags ?? [],
      owner: feature.properties.owner,
      modified: feature.properties.modified,
      url: feature.properties.url,
      license: feature.properties.license,
    })),
  };
}
