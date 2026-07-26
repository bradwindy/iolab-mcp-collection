import { z } from "zod";
import { attribution, jsonResult, UpstreamHttpError, upstreamError, type ToolTextResult } from "@iolab/mcp-kit";
import { cdxTimestampToIso, queryCdx } from "../clients/wayback.js";

// CDX has no cheap way to report "how many captures exist" up front — this caps how many rows a
// single timeline call will pull. High enough for the vast majority of sites' Wayback history;
// truncation is disclosed via `notice`, never silent.
const MAX_CAPTURES_ANALYSED = 5000;
const TOP_GAPS_RETURNED = 5;

export const waybackGetCaptureTimelineInputShape = {
  url: z.string().min(1).describe("The URL to build a capture timeline for."),
  from: z.string().regex(/^\d{4,14}$/).optional().describe("Earliest capture to include, YYYY[MMDDHHMMSS]."),
  to: z.string().regex(/^\d{4,14}$/).optional().describe("Latest capture to include, same format as `from`."),
};

export const waybackGetCaptureTimelineOutputShape = {
  first_capture: z.object({ timestamp: z.string(), iso_date: z.string() }).nullable(),
  last_capture: z.object({ timestamp: z.string(), iso_date: z.string() }).nullable(),
  total_captures_analysed: z.number(),
  distinct_content_versions: z.number(),
  captures_per_year: z.record(z.string(), z.number()),
  largest_gaps: z.array(
    z.object({ from_iso: z.string(), to_iso: z.string(), gap_days: z.number() }),
  ),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(waybackGetCaptureTimelineInputShape);

export async function waybackGetCaptureTimelineHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  try {
    const { rows, hasMore } = await queryCdx(env, {
      url: input.url,
      matchType: "exact",
      from: input.from,
      to: input.to,
      limit: MAX_CAPTURES_ANALYSED,
      offset: 0,
    });

    if (rows.length === 0) {
      return jsonResult({
        first_capture: null,
        last_capture: null,
        total_captures_analysed: 0,
        distinct_content_versions: 0,
        captures_per_year: {},
        largest_gaps: [],
        notice: "No captures found for this URL in the requested range.",
        attribution: attribution("Internet Archive Wayback Machine", { url: "https://web.archive.org/" }),
      });
    }

    // CDX's default sort (for an exact-URL query) is chronological ascending — relied on here for
    // first/last and gap computation rather than re-sorting.
    const perYear: Record<string, number> = {};
    for (const row of rows) {
      const year = row.timestamp.slice(0, 4);
      perYear[year] = (perYear[year] ?? 0) + 1;
    }

    const gaps = [];
    for (let i = 1; i < rows.length; i++) {
      const prevRow = rows[i - 1];
      const currRow = rows[i];
      if (!prevRow || !currRow) continue;
      const prevMs = Date.parse(cdxTimestampToIso(prevRow.timestamp));
      const currMs = Date.parse(cdxTimestampToIso(currRow.timestamp));
      gaps.push({
        from_iso: cdxTimestampToIso(prevRow.timestamp),
        to_iso: cdxTimestampToIso(currRow.timestamp),
        gap_days: Math.round(((currMs - prevMs) / 86_400_000) * 10) / 10,
      });
    }
    gaps.sort((a, b) => b.gap_days - a.gap_days);

    const firstRow = rows[0];
    const lastRow = rows[rows.length - 1];

    return jsonResult({
      first_capture: firstRow ? { timestamp: firstRow.timestamp, iso_date: cdxTimestampToIso(firstRow.timestamp) } : null,
      last_capture: lastRow ? { timestamp: lastRow.timestamp, iso_date: cdxTimestampToIso(lastRow.timestamp) } : null,
      total_captures_analysed: rows.length,
      distinct_content_versions: new Set(rows.map((r) => r.digest)).size,
      captures_per_year: perYear,
      largest_gaps: gaps.slice(0, TOP_GAPS_RETURNED),
      notice: hasMore
        ? `Analysis is based on the first ${rows.length} captures (chronologically) — more exist beyond this cap, so \`last_capture\` and recent-year counts may be incomplete. Narrow with \`from\`/\`to\` for a more precise window.`
        : "",
      attribution: attribution("Internet Archive Wayback Machine", { url: "https://web.archive.org/" }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    throw error;
  }
}
