import { z } from "zod";
import {
  attribution,
  jsonResult,
  limitParam,
  offsetParam,
  paginate,
  responseFormatParam,
  selectFormat,
  truncationNotice,
  UpstreamHttpError,
  upstreamError,
  type ToolTextResult,
} from "@nz-mcp/mcp-kit";
import {
  getMortgageRates as getMortgageRatesClient,
  type MortgageInstitution,
  type MortgageRate,
} from "../clients/ratesApi.js";

export const getMortgageRatesInputShape = {
  institution: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe(
      "Free-text lender name, e.g. 'ANZ', 'Kiwibank', or 'Co-operative Bank'. Omit to list every " +
        "institution the Rates API tracks (currently ~35).",
    ),
  term_in_months: z
    .number()
    .int()
    .min(0)
    .max(120)
    .optional()
    .describe("Filter to a specific term length in months, e.g. 12 for a 1-year fixed rate. Omit for all terms."),
  limit: limitParam(200, 50),
  offset: offsetParam,
  response_format: responseFormatParam,
};

export const getMortgageRatesOutputShape = {
  items: z.array(z.record(z.string(), z.unknown())),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  data_last_updated: z.string(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(getMortgageRatesInputShape);

type MortgageRow = {
  institution: string;
  institution_id: string;
  product: string;
  product_id: string;
  term: string;
  term_in_months: number | null;
  rate_id: string;
  rate: MortgageRate;
};

function flatten(institutions: MortgageInstitution[]): MortgageRow[] {
  const rows: MortgageRow[] = [];
  for (const institution of institutions) {
    for (const product of institution.products) {
      for (const rate of product.rates) {
        rows.push({
          institution: institution.name,
          institution_id: institution.id,
          product: product.name,
          product_id: product.id,
          term: rate.term,
          term_in_months: rate.termInMonths,
          rate_id: rate.id,
          rate,
        });
      }
    }
  }
  return rows;
}

function toConcise(row: MortgageRow) {
  return {
    institution: row.institution,
    product: row.product,
    term: row.term,
    rate_percent: row.rate.rate,
  };
}

function toDetailed(row: MortgageRow) {
  return {
    ...toConcise(row),
    term_in_months: row.term_in_months,
    institution_id: row.institution_id,
    product_id: row.product_id,
    rate_id: row.rate_id,
  };
}

export async function getMortgageRatesHandler(rawInput: unknown): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  try {
    const envelope = await getMortgageRatesClient({
      ...(input.institution ? { institution: input.institution } : {}),
      ...(input.term_in_months !== undefined ? { termInMonths: input.term_in_months } : {}),
    });

    const rows = flatten(envelope.data);
    const page = paginate(rows, { limit: input.limit, offset: input.offset }, { defaultLimit: 50, maxLimit: 200 });
    const items = page.items.map((row) => selectFormat(input.response_format, toConcise(row), toDetailed(row)));

    return jsonResult({
      items,
      total_count: page.total_count,
      has_more: page.has_more,
      next_offset: page.next_offset,
      data_last_updated: envelope.lastUpdated,
      notice: truncationNotice(
        input.offset + page.items.length,
        page.total_count,
        "Narrow with `institution` or `term_in_months`, or page with `offset`.",
      ),
      attribution: attribution("Rates API (rates sourced hourly from interest.co.nz)", {
        url: "https://ratesapi.nz/",
      }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) {
      const hint =
        error.response.status === 404
          ? "Check the institution spelling, or omit `institution` to list every tracked lender and its exact name."
          : undefined;
      return upstreamError(error.source, error.response, hint);
    }
    throw error;
  }
}
