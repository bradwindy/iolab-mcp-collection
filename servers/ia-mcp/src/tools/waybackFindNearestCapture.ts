import { z } from "zod";
import { attribution, jsonResult, UpstreamHttpError, type ToolTextResult } from "@iolab/mcp-kit";
import { findInOtherArchives } from "../clients/otherArchives.js";
import { archivedUrl, cdxTimestampToIso, queryCdxRaw, waybackError } from "../clients/wayback.js";

export const waybackFindNearestCaptureInputShape = {
  url: z.string().min(1).describe("The URL to find a nearby capture of."),
  target_date: z.string().regex(/^\d{4,14}$/).describe("The date to find the closest capture to, YYYY[MMDDHHMMSS]."),
};

const captureFieldsShape = z.object({
  timestamp: z.string(),
  iso_date: z.string(),
  archived_url: z.string(),
  days_from_target: z.number(),
});

export const waybackFindNearestCaptureOutputShape = {
  target_date: z.string(),
  nearest_before: captureFieldsShape.nullable(),
  nearest_after: captureFieldsShape.nullable(),
  closest: z.enum(["before", "after", "none"]),
  source_archive: z.string(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(waybackFindNearestCaptureInputShape);

function daysBetween(targetMs: number, captureIso: string): number {
  return Math.round(Math.abs(Date.parse(captureIso) - targetMs) / 86_400_000);
}

export async function waybackFindNearestCaptureHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);
  const targetMs = Date.parse(cdxTimestampToIso(input.target_date));

  try {
    // Confirmed live: CDX's negative `limit` returns the last N rows of the matching set instead
    // of the first N — this is what makes "closest capture before" a single cheap request instead
    // of scanning every capture up to the target date. Not the Availability API (confirmed
    // unreliable — returned no snapshots for a URL with abundant captures).
    // Sequential, not Promise.all — see waybackDiffCaptures.ts.
    const beforeRows = await queryCdxRaw(env, { url: input.url, matchType: "exact", to: input.target_date, rawLimit: -1 });
    const afterRows = await queryCdxRaw(env, { url: input.url, matchType: "exact", from: input.target_date, rawLimit: 1 });

    const before = beforeRows[0];
    const after = afterRows[0];

    const nearestBefore = before
      ? {
          timestamp: before.timestamp,
          iso_date: cdxTimestampToIso(before.timestamp),
          archived_url: archivedUrl(before.timestamp, before.original),
          days_from_target: daysBetween(targetMs, cdxTimestampToIso(before.timestamp)),
        }
      : null;
    const nearestAfter = after
      ? {
          timestamp: after.timestamp,
          iso_date: cdxTimestampToIso(after.timestamp),
          archived_url: archivedUrl(after.timestamp, after.original),
          days_from_target: daysBetween(targetMs, cdxTimestampToIso(after.timestamp)),
        }
      : null;

    let closest: "before" | "after" | "none" = "none";
    if (nearestBefore && nearestAfter) {
      closest = nearestBefore.days_from_target <= nearestAfter.days_from_target ? "before" : "after";
    } else if (nearestBefore) {
      closest = "before";
    } else if (nearestAfter) {
      closest = "after";
    }

    return jsonResult({
      target_date: input.target_date,
      nearest_before: nearestBefore,
      nearest_after: nearestAfter,
      closest,
      source_archive: "Internet Archive Wayback Machine",
      notice: "",
      attribution: attribution("Internet Archive Wayback Machine", { url: "https://web.archive.org/" }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) {
      if (error.response.status === 429) {
        const fallback = await nearestFromOtherArchives(input.url, input.target_date, targetMs);
        if (fallback) return fallback;
      }
      return waybackError(error);
    }
    throw error;
  }
}

/**
 * While Wayback is rate-limiting us: other archives' replay only resolves "closest capture", not
 * a before/after pair, so this fills in whichever side that one capture lands on.
 */
async function nearestFromOtherArchives(url: string, targetDate: string, targetMs: number): Promise<ToolTextResult | null> {
  const capture = await findInOtherArchives(url, targetDate, { readBody: false });
  if (!capture) return null;

  const isoDate = cdxTimestampToIso(capture.actualTimestamp);
  const fields = {
    timestamp: capture.actualTimestamp,
    iso_date: isoDate,
    archived_url: capture.archivedUrl,
    days_from_target: daysBetween(targetMs, isoDate),
  };
  const isBefore = Date.parse(isoDate) <= targetMs;

  return jsonResult({
    target_date: targetDate,
    nearest_before: isBefore ? fields : null,
    nearest_after: isBefore ? null : fields,
    closest: isBefore ? "before" : "after",
    source_archive: capture.archive.name,
    notice: `The Wayback Machine is rate-limiting this server, so this is the closest capture in ${capture.archive.name} instead. Only one side (before or after) is known; the other being null does not mean no such capture exists.`,
    attribution: attribution(capture.archive.name, { url: capture.archive.homepage }),
  });
}
