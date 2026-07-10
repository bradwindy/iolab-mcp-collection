import { afterEach, describe, expect, it, vi } from "vitest";
import { getConsumerLoanRatesHandler } from "../src/tools/getConsumerLoanRates.js";

const PERSONAL_LOAN_ENVELOPE = {
  type: "PersonalLoanRates",
  data: [
    {
      id: "institution:anz",
      name: "ANZ",
      products: [
        {
          id: "product:anz:personal-loan",
          name: "Personal Loan",
          rates: [{ id: "rate:anz:personal-loan:unsecured", plan: "Unsecured", condition: "$3,000 to $50,000", rate: 13.9 }],
        },
      ],
    },
  ],
  lastUpdated: "2026-07-09T08:31:47.692Z",
  termsOfUse: "Data is retrieved hourly from interest.co.nz.",
  timestamp: "2026-07-09T23:03:11.853Z",
};

const CREDIT_CARD_ENVELOPE = {
  type: "CreditCardRates",
  data: [
    {
      id: "issuer:amex",
      name: "Amex",
      plans: [
        {
          id: "plan:amex:airpoints-card",
          name: "Airpoints Card",
          interestFreePeriodInMonths: 55,
          primaryFeeNZD: 149,
          balanceTransferRate: 2.99,
          balanceTransferPeriod: "6 months",
          cashAdvanceRate: 21.95,
          purchaseRate: 19.95,
        },
      ],
    },
  ],
  lastUpdated: "2026-07-09T08:31:47.692Z",
  termsOfUse: "Data is retrieved hourly from interest.co.nz.",
  timestamp: "2026-07-09T23:03:11.853Z",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("nz_markets_get_consumer_loan_rates", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("flattens personal loan rows concisely", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(PERSONAL_LOAN_ENVELOPE)));

    const result = await getConsumerLoanRatesHandler({ product_type: "personal_loan" });

    expect(result.structuredContent?.items).toEqual([
      { institution: "ANZ", product: "Personal Loan", plan: "Unsecured", condition: "$3,000 to $50,000", rate_percent: 13.9 },
    ]);
  });

  it("flattens credit card rows with card-specific fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(CREDIT_CARD_ENVELOPE)));

    const result = await getConsumerLoanRatesHandler({ product_type: "credit_card" });

    expect(result.structuredContent?.items).toEqual([
      {
        institution: "Amex",
        plan: "Airpoints Card",
        purchase_rate_percent: 19.95,
        cash_advance_rate_percent: 21.95,
        balance_transfer_rate_percent: 2.99,
        balance_transfer_period: "6 months",
        interest_free_period_months: 55,
        annual_fee_nzd: 149,
      },
    ]);
  });

  it("includes ids in detailed format for both product shapes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(PERSONAL_LOAN_ENVELOPE)));
    const loanResult = await getConsumerLoanRatesHandler({ product_type: "personal_loan", response_format: "detailed" });
    expect((loanResult.structuredContent?.items as Array<Record<string, unknown>>)[0]?.rate_id).toBe(
      "rate:anz:personal-loan:unsecured",
    );

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(CREDIT_CARD_ENVELOPE)));
    const cardResult = await getConsumerLoanRatesHandler({ product_type: "credit_card", response_format: "detailed" });
    expect((cardResult.structuredContent?.items as Array<Record<string, unknown>>)[0]?.plan_id).toBe(
      "plan:amex:airpoints-card",
    );
  });

  it("uses an `institution:` id prefix for personal/car loans", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(PERSONAL_LOAN_ENVELOPE));
    vi.stubGlobal("fetch", fetchMock);

    await getConsumerLoanRatesHandler({ product_type: "personal_loan", institution: "ANZ" });

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.pathname).toBe("/api/v1/personal-loan-rates/institution:anz");
  });

  it("uses an `issuer:` id prefix for credit cards", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(CREDIT_CARD_ENVELOPE));
    vi.stubGlobal("fetch", fetchMock);

    await getConsumerLoanRatesHandler({ product_type: "credit_card", institution: "Amex" });

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.pathname).toBe("/api/v1/credit-card-rates/issuer:amex");
  });

  it("returns an actionable error with a spelling hint on a 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 404 }), { status: 404, statusText: "Not Found" })),
    );

    const result = await getConsumerLoanRatesHandler({ product_type: "car_loan", institution: "nope" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Check the institution spelling");
  });
});
