import { z } from "zod";
import {
  attribution,
  jsonResult,
  limitParam,
  responseFormatParam,
  selectFormat,
  toolError,
  UpstreamHttpError,
  upstreamError,
  type ToolTextResult,
} from "@iolab/mcp-kit";
import { ArcgisQueryError, searchAddresses, type AddressCandidate } from "../clients/canterburyMaps.js";

export const searchCanterburyAddressesInputShape = {
  query: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "A street address or place name to geocode within Canterbury, e.g. '200 Tuam Street Christchurch' or 'Hagley Park'.",
    ),
  limit: limitParam(20, 5),
  response_format: responseFormatParam,
};

export const searchCanterburyAddressesOutputShape = {
  candidates: z.array(z.record(z.string(), z.unknown())),
  count: z.number(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(searchCanterburyAddressesInputShape);

function toConcise(candidate: AddressCandidate) {
  return {
    matched_address: candidate.matchedAddress,
    matched_by: candidate.matchedBy,
    score: candidate.score,
    lat: candidate.lat,
    lon: candidate.lon,
  };
}

function toDetailed(candidate: AddressCandidate) {
  return {
    ...toConcise(candidate),
    address_type: candidate.addressType,
    bbox: candidate.bbox,
  };
}

export async function searchCanterburyAddressesHandler(rawInput: unknown): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  try {
    const candidates = await searchAddresses(input.query, input.limit);

    return jsonResult({
      candidates: candidates.map((candidate) => selectFormat(input.response_format, toConcise(candidate), toDetailed(candidate))),
      count: candidates.length,
      notice:
        candidates.length === 0
          ? `No address or place match found for '${input.query}' within Canterbury. Try adding a suburb or town name.`
          : "Geocoding is scoped to the Canterbury region only (Environment Canterbury's public locators) — it will not resolve addresses elsewhere in NZ.",
      attribution: attribution("Canterbury Maps (Environment Canterbury) address locator", {
        url: "https://canterburymaps.govt.nz/",
      }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    if (error instanceof ArcgisQueryError) return toolError(error.message, "Try rephrasing `query` as a single-line address or place name.");
    throw error;
  }
}
