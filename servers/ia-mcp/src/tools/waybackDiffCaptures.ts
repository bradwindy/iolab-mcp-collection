import { z } from "zod";
import { attribution, jsonResult, UpstreamHttpError, upstreamError, type ToolTextResult } from "@iolab/mcp-kit";
import { queryCdx } from "../clients/wayback.js";
import { fetchAndExtractPage } from "../pageFetch.js";

export const waybackDiffCapturesInputShape = {
  url: z.string().min(1).describe("The URL to compare two captures of."),
  timestamp_a: z.string().regex(/^\d{14}$/).describe("The earlier (or first) capture's exact 14-digit timestamp."),
  timestamp_b: z.string().regex(/^\d{14}$/).describe("The later (or second) capture's exact 14-digit timestamp."),
  max_chars: z.number().int().min(500).max(50000).default(5000).describe("Max characters of diff output to return."),
};

export const waybackDiffCapturesOutputShape = {
  url: z.string(),
  timestamp_a: z.string(),
  timestamp_b: z.string(),
  identical: z.boolean(),
  chars_added: z.number(),
  chars_removed: z.number(),
  diff: z.string(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(waybackDiffCapturesInputShape);

/** Cheap pre-check: CDX's own digest for this exact capture, with no page fetch. */
async function getCaptureDigest(env: Env, url: string, timestamp: string): Promise<string | null> {
  const { rows } = await queryCdx(env, { url, matchType: "exact", from: timestamp, to: timestamp, limit: 1, offset: 0 });
  return rows[0]?.digest ?? null;
}

function lineDiff(textA: string, textB: string): { diff: string; charsAdded: number; charsRemoved: number } {
  const linesA = textA.split("\n");
  const linesB = textB.split("\n");
  const setA = new Set(linesA);
  const setB = new Set(linesB);

  const removed = linesA.filter((line) => !setB.has(line));
  const added = linesB.filter((line) => !setA.has(line));

  const diffLines = [...removed.map((l) => `- ${l}`), ...added.map((l) => `+ ${l}`)];
  return {
    diff: diffLines.join("\n"),
    charsAdded: added.join("\n").length,
    charsRemoved: removed.join("\n").length,
  };
}

export async function waybackDiffCapturesHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  try {
    const [digestA, digestB] = await Promise.all([
      getCaptureDigest(env, input.url, input.timestamp_a),
      getCaptureDigest(env, input.url, input.timestamp_b),
    ]);

    if (digestA && digestB && digestA === digestB) {
      return jsonResult({
        url: input.url,
        timestamp_a: input.timestamp_a,
        timestamp_b: input.timestamp_b,
        identical: true,
        chars_added: 0,
        chars_removed: 0,
        diff: "",
        notice: "Both captures have the same CDX content digest — identical content, no page fetch needed.",
        attribution: attribution("Internet Archive Wayback Machine", { url: "https://web.archive.org/" }),
      });
    }

    const [pageA, pageB] = await Promise.all([
      fetchAndExtractPage(env, input.url, input.timestamp_a),
      fetchAndExtractPage(env, input.url, input.timestamp_b),
    ]);

    const { diff, charsAdded, charsRemoved } = lineDiff(pageA.text, pageB.text);
    const truncated = diff.length > input.max_chars;

    return jsonResult({
      url: input.url,
      timestamp_a: pageA.actualTimestamp,
      timestamp_b: pageB.actualTimestamp,
      identical: diff.length === 0,
      chars_added: charsAdded,
      chars_removed: charsRemoved,
      diff: diff.slice(0, input.max_chars),
      notice: truncated ? `Diff truncated to ${input.max_chars} characters; narrow the comparison or raise \`max_chars\`.` : "",
      attribution: attribution("Internet Archive Wayback Machine", { url: "https://web.archive.org/" }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    throw error;
  }
}
