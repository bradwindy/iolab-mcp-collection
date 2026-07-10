import { z } from "zod";
import {
  attribution,
  CACHE_TTL,
  cached,
  jsonResult,
  toolError,
  UpstreamHttpError,
  upstreamError,
  type ToolTextResult,
} from "@nz-mcp/mcp-kit";
import { getQuakeHistory, type QuakeHistoryEntry } from "../clients/geonet.js";

const PUBLIC_ID_PATTERN = /^\d{4}p\d+$/i;

export const getQuakeRevisionHistoryInputShape = {
  public_id: z
    .string()
    .regex(PUBLIC_ID_PATTERN, "Expected a GeoNet public ID like '2013p407387' (year + 'p' + digits).")
    .describe(
      "The quake's GeoNet public ID, e.g. '2013p407387' — from nz_env_search_quakes or nz_env_search_quake_history.",
    ),
};

export const getQuakeRevisionHistoryOutputShape = {
  public_id: z.string(),
  revisions: z.array(z.record(z.string(), z.unknown())),
  revision_count: z.number(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(getQuakeRevisionHistoryInputShape);

function toRevision(entry: QuakeHistoryEntry) {
  return {
    time: entry.time,
    modification_time: entry.modificationTime,
    magnitude: entry.magnitude,
    depth_km: entry.depth,
    mmi: entry.mmi,
    locality: entry.locality,
    quality: entry.quality,
  };
}

export async function getQuakeRevisionHistoryHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  try {
    const cacheKey = `geonet:quake-history:${input.public_id}`;
    const history = await cached(env.MCP_CACHE, cacheKey, CACHE_TTL.SLOW_MOVING, () =>
      getQuakeHistory(input.public_id),
    );

    if (history.length === 0) {
      return toolError(
        `No location/magnitude history found for quake '${input.public_id}'.`,
        "Not all quakes have a revision history, or the public_id may be wrong — verify it with nz_env_search_quakes.",
      );
    }

    return jsonResult({
      public_id: input.public_id,
      revisions: history.map(toRevision),
      revision_count: history.length,
      notice: "Revisions are ordered as returned by GeoNet (typically most recent first).",
      attribution: attribution("GeoNet (GNS Science)", {
        license: "CC BY 3.0 NZ",
        url: "https://www.geonet.org.nz/data/policy",
      }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    throw error;
  }
}
