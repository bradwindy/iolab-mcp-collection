import { CACHE_TTL, cached } from "@iolab/mcp-kit";
import { downloadItemFile, findFullTextFile, getItemMetadata } from "./clients/archiveOrg.js";

export class NoFullTextFileError extends Error {
  constructor(public readonly identifier: string) {
    super(`Item '${identifier}' has no recognisable full-text file in its files list.`);
    this.name = "NoFullTextFileError";
  }
}

/**
 * Resolves and downloads an item's full text, cached by identifier — item text is effectively
 * immutable once scanned/OCR'd, so a long TTL is safe and avoids re-downloading a large file on
 * every search-inside/read call. Never constructs the filename by convention (confirmed live:
 * sometimes `<id>_djvu.txt`, sometimes arbitrary, e.g. `b190w10.txt`) — always resolved from the
 * metadata `files[]` array. Surfaces the same 401-lending-restriction distinction the download
 * client already makes (confirmed live: in-copyright items 401, public-domain items 200).
 */
export async function getItemFullText(env: Env, identifier: string): Promise<string> {
  const cacheKey = `ia:fulltext:${identifier}`;
  return cached(env.MCP_CACHE, cacheKey, CACHE_TTL.METADATA, async () => {
    const item = await getItemMetadata(env, identifier);
    const textFile = findFullTextFile(item.files ?? []);
    if (!textFile) throw new NoFullTextFileError(identifier);
    return downloadItemFile(env, identifier, textFile.name);
  });
}
