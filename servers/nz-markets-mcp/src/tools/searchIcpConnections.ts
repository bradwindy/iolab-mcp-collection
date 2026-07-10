import { z } from "zod";
import {
  attribution,
  jsonResult,
  limitParam,
  missingCredentialError,
  offsetParam,
  paginate,
  responseFormatParam,
  selectFormat,
  toolError,
  truncationNotice,
  UpstreamHttpError,
  upstreamError,
  type ToolTextResult,
} from "@nz-mcp/mcp-kit";
import { getCredential } from "@nz-mcp/credentials";
import { EA_ICP_API_KEY, SERVER_SLUG } from "../constants.js";
import {
  getIcpById,
  isValidIcpFormat,
  parseAddressQuery,
  searchIcpByAddress,
  type IcpAddress,
  type IcpDetails,
  type IcpSearchHit,
} from "../clients/electricityAuthority.js";

export const searchIcpConnectionsInputShape = {
  address_or_icp: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "Either an exact 15-character ICP identifier (10 digits + 2 letters + 3 hex characters, e.g. " +
        "'0000123456ZZAF0', found on any power bill), or a free-text NZ street address such as " +
        "'12 Queen Street, Auckland'. An exact ICP returns full connection/network/pricing/trader/metering " +
        "detail; an address only returns identifier, status, and address fields, and may match multiple ICPs.",
    ),
  limit: limitParam(50, 20),
  offset: offsetParam,
  response_format: responseFormatParam,
};

export const searchIcpConnectionsOutputShape = {
  items: z.array(z.record(z.string(), z.unknown())),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(searchIcpConnectionsInputShape);

function addressSummary(address: IcpAddress | null | undefined) {
  if (!address) return null;
  const line1 = [address.PhysicalAddressUnit, address.PhysicalAddressNumber, address.PhysicalAddressStreet]
    .filter(Boolean)
    .join(" ");
  return {
    line1: line1 || null,
    suburb: address.PhysicalAddressSuburb,
    town: address.PhysicalAddressTown,
    region: address.PhysicalAddressRegion,
    post_code: address.PhysicalAddressPostCode,
  };
}

function toConcise(row: IcpDetails | IcpSearchHit) {
  return {
    icp_identifier: row.ICPIdentifier,
    /** Numeric status code — the EA docs don't publish a lookup table for this, so it's raw. */
    icp_status: row.ICPStatus,
    address: addressSummary(row.Address),
  };
}

function toDetailed(row: IcpDetails | IcpSearchHit) {
  const details = row as Partial<IcpDetails>;
  return {
    ...toConcise(row),
    network: details.Network ?? null,
    pricing: details.Pricing ?? null,
    trader: details.Trader ?? null,
    metering: details.Metering ?? null,
    messages: row.Messages ?? [],
  };
}

/** `env` supplies the D1-backed credential lookup — the Electricity Authority requires a
 * subscription key for its "ICP connection data" product (separate from the dispatch key). */
export async function searchIcpConnectionsHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  const apiKey = await getCredential(env.CREDENTIALS_DB, SERVER_SLUG, EA_ICP_API_KEY, env.ENCRYPTION_KEY);
  if (!apiKey) return missingCredentialError(SERVER_SLUG, EA_ICP_API_KEY, env.PORTAL_URL);

  const trimmed = input.address_or_icp.trim();
  const isIcp = isValidIcpFormat(trimmed);

  let streetNumber: string | undefined;
  let streetName: string | undefined;
  let suburbOrTown: string | undefined;
  let region: string | undefined;

  if (!isIcp) {
    const parsed = parseAddressQuery(trimmed);
    streetNumber = parsed.streetNumber;
    streetName = parsed.streetName;
    suburbOrTown = parsed.suburbOrTown;
    region = parsed.region;
    if (!streetNumber || !streetName) {
      return toolError(
        "Could not find both a street number and a street name in that address.",
        "Provide it like '12 Queen Street, Auckland' — a leading street number, then the street name, " +
          "optionally followed by suburb/town and region — or pass an exact 15-character ICP number instead.",
      );
    }
  }

  try {
    const rows: Array<IcpDetails | IcpSearchHit> = isIcp
      ? await getIcpById({ apiKey, icp: trimmed })
      : await searchIcpByAddress({
          apiKey,
          streetNumber: streetNumber!,
          streetName: streetName!,
          ...(suburbOrTown ? { suburbOrTown } : {}),
          ...(region ? { region } : {}),
        });

    const page = paginate(rows, { limit: input.limit, offset: input.offset }, { defaultLimit: 20, maxLimit: 50 });
    const items = page.items.map((row) => selectFormat(input.response_format, toConcise(row), toDetailed(row)));

    const noticeParts = [
      truncationNotice(
        input.offset + page.items.length,
        page.total_count,
        "Narrow the address (add a suburb/region), or page with `offset`.",
      ),
    ];
    if (!isIcp) {
      noticeParts.push(
        "Address search only returns identifier/status/address fields. Pass the exact ICP number for full " +
          "connection, network, pricing, trader, and metering detail.",
      );
    }

    return jsonResult({
      items,
      total_count: page.total_count,
      has_more: page.has_more,
      next_offset: page.next_offset,
      notice: noticeParts.filter(Boolean).join(" "),
      attribution: attribution("Electricity Authority — Electricity Market Information (EMI), ICP connection data", {
        url: "https://www.ea.govt.nz/data-and-insights/tools-and-apis/",
      }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) {
      if (error.response.status === 404) {
        return upstreamError(
          error.source,
          error.response,
          "No ICP found with that identifier. Double-check the 15-character code, or search by address instead.",
        );
      }
      if (error.response.status === 400) {
        return upstreamError(
          error.source,
          error.response,
          "The upstream rejected the search filters — make sure both a street number and street name are present.",
        );
      }
      return upstreamError(error.source, error.response);
    }
    throw error;
  }
}
