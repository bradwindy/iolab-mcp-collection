import { stripInlineHtml } from "../html.js";
import { COMMONS_HOST } from "../projects.js";
import { actionApi, PageNotFoundError, type QueryPage } from "./actionApi.js";

/**
 * The `extmetadata` fields worth pulling. Filtering matters: `extmetadata` is by far the heaviest
 * part of an imageinfo response — unfiltered it carries ~20 fields per file including full HTML
 * descriptions and category lists.
 */
const EXTMETADATA_FILTER = "LicenseShortName|Artist|Credit|LicenseUrl|UsageTerms|AttributionRequired|ImageDescription";

type ExtMetadataValue = { value?: string | number | boolean; source?: string; hidden?: string };

export type RawImageInfo = {
  size?: number;
  width?: number;
  height?: number;
  url?: string;
  thumburl?: string;
  thumbwidth?: number;
  thumbheight?: number;
  mime?: string;
  descriptionurl?: string;
  extmetadata?: Record<string, ExtMetadataValue>;
};

export type MediaAttribution = {
  artist?: string;
  credit?: string;
  license?: string;
  license_url?: string;
  usage_terms?: string;
  attribution_required?: boolean;
};

/**
 * Unwrap the `{ value, source, hidden }` envelope every `extmetadata` field is wrapped in, and
 * strip the HTML some of them carry.
 *
 * `Artist` is the reason the stripping is not optional: confirmed live it is sometimes a plain
 * name ("John Gerrard Keulemans") and sometimes a raw anchor
 * (`<a href="//commons.wikimedia.org/wiki/User:Alvesgaspar" ...>Alvesgaspar</a>`), so a caller that
 * trusted the field to be text would render markup into a citation.
 */
export function readAttribution(extmetadata: Record<string, ExtMetadataValue> | undefined): MediaAttribution {
  const read = (key: string): string | undefined => {
    const raw = extmetadata?.[key]?.value;
    if (raw === undefined || raw === null) return undefined;
    const text = stripInlineHtml(String(raw));
    return text.length > 0 ? text : undefined;
  };

  const attributionRequired = read("AttributionRequired");
  return {
    ...(read("Artist") !== undefined ? { artist: read("Artist") as string } : {}),
    ...(read("Credit") !== undefined ? { credit: read("Credit") as string } : {}),
    ...(read("LicenseShortName") !== undefined ? { license: read("LicenseShortName") as string } : {}),
    ...(read("LicenseUrl") !== undefined ? { license_url: read("LicenseUrl") as string } : {}),
    ...(read("UsageTerms") !== undefined ? { usage_terms: read("UsageTerms") as string } : {}),
    ...(attributionRequired !== undefined ? { attribution_required: attributionRequired.toLowerCase() === "true" } : {}),
  };
}

export type MediaSearchRow = {
  title: string;
  pageid?: number;
  info: RawImageInfo;
};

export async function searchMedia(
  env: Env,
  params: { search: string; limit: number; offset: number; thumbnailWidth: number },
): Promise<{ rows: MediaSearchRow[]; total_hits: number }> {
  const body = await actionApi<{
    query?: { searchinfo?: { totalhits?: number }; pages?: Array<QueryPage & { index?: number; imageinfo?: RawImageInfo[] }> };
  }>(env, COMMONS_HOST, {
    action: "query",
    generator: "search",
    gsrsearch: params.search,
    // Namespace 6 is File:. Without it a media search returns Commons project pages too.
    gsrnamespace: 6,
    gsrlimit: params.limit,
    gsroffset: params.offset,
    gsrinfo: "totalhits",
    prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata",
    iiextmetadatafilter: EXTMETADATA_FILTER,
    iiurlwidth: params.thumbnailWidth,
  });

  const pages = body.query?.pages ?? [];
  // `generator=` returns pages in an arbitrary order with the relevance rank in `index`; restore it
  // so paging through offsets yields a consistent sequence.
  const ordered = [...pages].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  return {
    rows: ordered.map((page) => ({
      title: page.title,
      ...(page.pageid !== undefined ? { pageid: page.pageid } : {}),
      info: page.imageinfo?.[0] ?? {},
    })),
    total_hits: body.query?.searchinfo?.totalhits ?? 0,
  };
}

export async function fetchMediaInfo(
  env: Env,
  params: { title: string; thumbnailWidth: number },
): Promise<{ title: string; pageid?: number; info: RawImageInfo }> {
  const body = await actionApi<{ query?: { pages?: Array<QueryPage & { imageinfo?: RawImageInfo[] }> } }>(env, COMMONS_HOST, {
    action: "query",
    prop: "imageinfo",
    titles: params.title,
    iiprop: "url|size|mime|extmetadata",
    iiextmetadatafilter: EXTMETADATA_FILTER,
    iiurlwidth: params.thumbnailWidth,
  });

  const page = body.query?.pages?.[0];
  if (!page || page.missing || page.invalid || !page.imageinfo?.[0]) {
    throw new PageNotFoundError(params.title);
  }
  return {
    title: page.title,
    ...(page.pageid !== undefined ? { pageid: page.pageid } : {}),
    info: page.imageinfo[0],
  };
}

/** Normalise a caller-supplied file name to the `File:`-prefixed title the API expects. */
export function normaliseFileTitle(title: string): string {
  const trimmed = title.trim();
  return /^(file|image):/i.test(trimmed) ? trimmed : `File:${trimmed}`;
}
