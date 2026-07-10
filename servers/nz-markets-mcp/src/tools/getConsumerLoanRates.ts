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
  getConsumerLoanRates as getConsumerLoanRatesClient,
  type CreditCardIssuer,
  type CreditCardPlan,
  type LoanInstitution,
  type LoanRate,
} from "../clients/ratesApi.js";

export const getConsumerLoanRatesInputShape = {
  product_type: z
    .enum(["personal_loan", "car_loan", "credit_card"])
    .describe("Which consumer lending product to list rates for."),
  institution: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe(
      "Free-text lender/issuer name, e.g. 'ANZ', 'Harmoney', or 'Amex'. Omit to list every " +
        "institution the Rates API tracks for this product type.",
    ),
  limit: limitParam(200, 50),
  offset: offsetParam,
  response_format: responseFormatParam,
};

export const getConsumerLoanRatesOutputShape = {
  items: z.array(z.record(z.string(), z.unknown())),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  data_last_updated: z.string(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(getConsumerLoanRatesInputShape);

type LoanRow = {
  kind: "loan";
  institution: string;
  institution_id: string;
  product: string;
  product_id: string;
  rate_id: string;
  rate: LoanRate;
};

type CreditCardRow = {
  kind: "credit_card";
  institution: string;
  institution_id: string;
  plan_id: string;
  plan: CreditCardPlan;
};

type Row = LoanRow | CreditCardRow;

function flattenLoans(institutions: LoanInstitution[]): LoanRow[] {
  const rows: LoanRow[] = [];
  for (const institution of institutions) {
    for (const product of institution.products) {
      for (const rate of product.rates) {
        rows.push({
          kind: "loan",
          institution: institution.name,
          institution_id: institution.id,
          product: product.name,
          product_id: product.id,
          rate_id: rate.id,
          rate,
        });
      }
    }
  }
  return rows;
}

function flattenCreditCards(issuers: CreditCardIssuer[]): CreditCardRow[] {
  const rows: CreditCardRow[] = [];
  for (const issuer of issuers) {
    for (const plan of issuer.plans) {
      rows.push({
        kind: "credit_card",
        institution: issuer.name,
        institution_id: issuer.id,
        plan_id: plan.id,
        plan,
      });
    }
  }
  return rows;
}

function toConcise(row: Row) {
  if (row.kind === "loan") {
    return {
      institution: row.institution,
      product: row.product,
      plan: row.rate.plan,
      condition: row.rate.condition,
      rate_percent: row.rate.rate,
    };
  }
  return {
    institution: row.institution,
    plan: row.plan.name,
    purchase_rate_percent: row.plan.purchaseRate,
    cash_advance_rate_percent: row.plan.cashAdvanceRate,
    balance_transfer_rate_percent: row.plan.balanceTransferRate,
    balance_transfer_period: row.plan.balanceTransferPeriod,
    interest_free_period_months: row.plan.interestFreePeriodInMonths,
    annual_fee_nzd: row.plan.primaryFeeNZD,
  };
}

function toDetailed(row: Row) {
  if (row.kind === "loan") {
    return {
      ...toConcise(row),
      institution_id: row.institution_id,
      product_id: row.product_id,
      rate_id: row.rate_id,
    };
  }
  return {
    ...toConcise(row),
    institution_id: row.institution_id,
    plan_id: row.plan_id,
  };
}

export async function getConsumerLoanRatesHandler(rawInput: unknown): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  try {
    const envelope = await getConsumerLoanRatesClient({
      productType: input.product_type,
      ...(input.institution ? { institution: input.institution } : {}),
    });

    const rows: Row[] =
      input.product_type === "credit_card"
        ? flattenCreditCards(envelope.data as CreditCardIssuer[])
        : flattenLoans(envelope.data as LoanInstitution[]);

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
        "Narrow with `institution`, or page with `offset`.",
      ),
      attribution: attribution("Rates API (rates sourced hourly from interest.co.nz)", {
        url: "https://ratesapi.nz/",
      }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) {
      const hint =
        error.response.status === 404
          ? "Check the institution spelling, or omit `institution` to list every tracked name for this product type."
          : undefined;
      return upstreamError(error.source, error.response, hint);
    }
    throw error;
  }
}
