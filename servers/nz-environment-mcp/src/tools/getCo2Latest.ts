import { z } from "zod";
import {
  attribution,
  CACHE_TTL,
  cached,
  jsonResult,
  missingCredentialError,
  UpstreamHttpError,
  upstreamError,
  type ToolTextResult,
} from "@iolab/mcp-kit";
import { getBaringHeadInfoText, parseInfoText } from "../clients/niwaCo2.js";
import { getNiwaApiKey } from "../clients/niwaCredentials.js";
import { NIWA_API_KEY_NAME, SERVER_SLUG } from "../constants.js";

export const getCo2LatestInputShape = {};

export const getCo2LatestOutputShape = {
  parsed: z.record(z.string(), z.string()),
  raw_text: z.string(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(getCo2LatestInputShape);

export async function getCo2LatestHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  inputSchema.parse(rawInput);

  const apiKey = await getNiwaApiKey(env);
  if (!apiKey) return missingCredentialError(SERVER_SLUG, NIWA_API_KEY_NAME, env.PORTAL_URL);

  try {
    const text = await cached(env.MCP_CACHE, "niwa:co2:baringhead-info", CACHE_TTL.SLOW_MOVING, () =>
      getBaringHeadInfoText(apiKey),
    );
    const parsed = parseInfoText(text);

    const notice =
      Object.keys(parsed).length > 0
        ? "`parsed` is a best-effort line-by-line reading of the upstream text; `raw_text` is the verbatim response " +
          "in case a field was missed or mislabelled (see README.md)."
        : "This server could not confirm the exact text format NIWA returns for this route ahead of time (see " +
          "README.md); `parsed` is empty because no 'key: value' style lines were found — use `raw_text`.";

    return jsonResult({
      parsed,
      raw_text: text,
      notice,
      attribution: attribution("NIWA CO2 API (Baring Head clean-air station)", {
        url: "https://developer.niwa.co.nz/docs/co2/1/overview",
      }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    throw error;
  }
}
