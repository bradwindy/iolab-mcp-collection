import { fetchWithBackoff, UpstreamHttpError } from "@nz-mcp/mcp-kit";

const BASE_URL = "https://ratesapi.nz/api/v1";
const SOURCE = "Rates API";
const USER_AGENT = "nz-mcp-collection/nz-markets-mcp (+https://mcp.example.invalid)";

/**
 * Field shapes confirmed live against https://ratesapi.nz/api/v1/{mortgage,personal-loan,car-loan,
 * credit-card}-rates and cross-checked against the published OpenAPI spec at
 * https://ratesapi.nz/openapi/json (2026-07-09). No auth required.
 */
export type MortgageRate = {
  id: string;
  term: string;
  termInMonths: number | null;
  rate: number;
};
export type MortgageProduct = { id: string; name: string; rates: MortgageRate[] };
export type MortgageInstitution = { id: string; name: string; products: MortgageProduct[] };

export type LoanRate = {
  id: string;
  plan: string | null;
  condition: string | null;
  rate: number;
};
export type LoanProduct = { id: string; name: string; rates: LoanRate[] };
export type LoanInstitution = { id: string; name: string; products: LoanProduct[] };

export type CreditCardPlan = {
  id: string;
  name: string;
  interestFreePeriodInMonths: number | null;
  primaryFeeNZD: number | null;
  balanceTransferRate: number | null;
  balanceTransferPeriod: string | null;
  cashAdvanceRate: number | null;
  purchaseRate: number | null;
};
export type CreditCardIssuer = { id: string; name: string; plans: CreditCardPlan[] };

export type RatesEnvelope<T> = {
  type: string;
  data: T[];
  /** ISO timestamp of the underlying rate data (rates are scraped from interest.co.nz hourly). */
  lastUpdated: string;
  termsOfUse: string;
  /** ISO timestamp of when the Rates API served this response. */
  timestamp: string;
};

export type ConsumerLoanProductType = "personal_loan" | "car_loan" | "credit_card";

const CONSUMER_LOAN_PATHS: Record<ConsumerLoanProductType, string> = {
  personal_loan: "personal-loan-rates",
  car_loan: "car-loan-rates",
  credit_card: "credit-card-rates",
};

/** Credit card issuer ids are prefixed `issuer:`; every other product uses `institution:`. */
const CONSUMER_LOAN_ID_PREFIX: Record<ConsumerLoanProductType, "institution" | "issuer"> = {
  personal_loan: "institution",
  car_loan: "institution",
  credit_card: "issuer",
};

/**
 * Institution/issuer ids in this API are always `institution:kebab-case-slug` or
 * `issuer:kebab-case-slug` (confirmed across all 34+ mortgage institutions and 30+ credit-card
 * issuers returned live). Callers pass a human-friendly name ("ANZ", "Co-operative Bank"); this
 * normalizes it into that id form so the tool layer doesn't force the model to know exact slugs.
 */
export function normalizeInstitutionId(prefix: "institution" | "issuer", raw: string): string {
  const withoutPrefix = raw.trim().replace(/^(institution|issuer):/i, "");
  const slug = withoutPrefix
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-");
  return `${prefix}:${slug}`;
}

async function getJson<T>(path: string, searchParams: Record<string, string | undefined>): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(searchParams)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  const response = await fetchWithBackoff(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!response.ok) throw new UpstreamHttpError(SOURCE, response);
  return (await response.json()) as T;
}

export async function getMortgageRates(params: {
  institution?: string;
  termInMonths?: number;
}): Promise<RatesEnvelope<MortgageInstitution>> {
  const path = params.institution
    ? `/mortgage-rates/${normalizeInstitutionId("institution", params.institution)}`
    : "/mortgage-rates/";
  return getJson<RatesEnvelope<MortgageInstitution>>(path, {
    ...(params.termInMonths !== undefined ? { termInMonths: String(params.termInMonths) } : {}),
  });
}

export async function getConsumerLoanRates(params: {
  productType: ConsumerLoanProductType;
  institution?: string;
}): Promise<RatesEnvelope<LoanInstitution | CreditCardIssuer>> {
  const basePath = CONSUMER_LOAN_PATHS[params.productType];
  const prefix = CONSUMER_LOAN_ID_PREFIX[params.productType];
  const path = params.institution
    ? `/${basePath}/${normalizeInstitutionId(prefix, params.institution)}`
    : `/${basePath}/`;
  return getJson<RatesEnvelope<LoanInstitution | CreditCardIssuer>>(path, {});
}

export { SOURCE as RATES_API_SOURCE };
