// Research notes and provenance for every constant below are in README.md ("Research notes").
// Where a value could not be confirmed against a live authenticated response (no real
// subscription key was available while building this server), that is called out explicitly.

export const PORTAL_URL = "https://mcp.example.invalid";
export const CREDENTIAL_SERVER_SLUG = "nz-stats-mcp";
export const SUBSCRIPTION_KEY_NAME = "STATS_NZ_SUBSCRIPTION_KEY";

/**
 * SDMX REST base URL used by the Aotearoa Data Explorer "Developer API" query builder.
 * Confirmed live 2026-07-09: GET requests here return real dataflow catalogue data (some
 * structural metadata requests are edge-cached and briefly work without a key; data
 * requests reliably 401 without one). A documented alternate base,
 * http://apis.stats.govt.nz/ade-api/rest/, is interchangeable per Stats NZ's guide.
 * Source: https://www.stats.govt.nz/tools/aotearoa-data-explorer/ade-api-user-guide/
 */
export const SDMX_BASE_URL = "https://api.data.stats.govt.nz/rest";

/** The only SDMX agency ID Stats NZ publishes under in Aotearoa Data Explorer. */
export const AGENCY_ID = "STATSNZ";

export const SOURCE_NAME = "Stats NZ Aotearoa Data Explorer (SDMX API)";
export const SOURCE_URL = "https://explore.data.stats.govt.nz/";

/** Header Stats NZ's API Portal (Azure API Management) requires on every request. */
export const SUBSCRIPTION_KEY_HEADER = "Ocp-Apim-Subscription-Key";

// ---------------------------------------------------------------------------------
// Curated dataflow: subnational population estimates by area, age, and sex.
// ---------------------------------------------------------------------------------
// Confirmed live on 2026-07-09 via GET {SDMX_BASE_URL}/dataflow/STATSNZ/all (a cached,
// unauthenticated structural-metadata response returned the full 911-dataflow STATSNZ
// catalogue). This dataflow's own annotations state:
//   LAYOUT_ROW:    AREA_POPES_SUB_004,SEX_POPES_SUB_004,AGE_POPES_SUB_004
//   LAYOUT_COLUMN: YEAR_POPES_SUB_004
//   DEFAULT:       YEAR=1996+2001+2006+2013+2018+2023+2024+2025, SEX=3, AGE=999999,
//                  AREA=RC9999+01+02+03+04+05+06+07+08+09+16+17+18+12+13+14+15+99+NIRC+SIRC
// Stats NZ's own worked example (AGR_AGR_001, in the ADE API user guide) constructs a
// dot-separated `{key}` in the same order as a table's row dimension(s) followed by its
// column dimension(s) — that ordering has NOT been confirmed against a live authenticated
// response for POPES_SUB_004 specifically. If nz_stats_get_population_by_area ever returns
// an empty result set, fall back to nz_stats_query_dataflow with a dimension_key built from
// the ADE portal's own Developer API menu for this table, which is guaranteed correct.
export const POPULATION_DATAFLOW_ID = "POPES_SUB_004";
export const POPULATION_DATAFLOW_VERSION = "1.0";
export const POPULATION_DATAFLOW_NAME =
  "Subnational population estimates (RC, SA2), by age and sex, at 30 June 1996-2025 (2025 boundaries)";

/** Confirmed via the dataflow's own DEFAULT annotation (see above). */
export const POPULATION_SEX_TOTAL_CODE = "3";
/** Confirmed via the dataflow's own DEFAULT annotation (see above). */
export const POPULATION_AGE_TOTAL_CODE = "999999";
/** The exact set of YEAR codes this table has data for, per its DEFAULT annotation. */
export const POPULATION_AVAILABLE_YEARS = ["1996", "2001", "2006", "2013", "2018", "2023", "2024", "2025"];
/**
 * Default AREA codes (Stats NZ's own "opening view" of this table): the 16 Regional
 * Council codes, "99" (area outside region), the two island aggregates, and the NZ total.
 * Matches the DEFAULT annotation exactly, kept in that order.
 */
export const POPULATION_DEFAULT_AREA_CODES = [
  "RC9999",
  "01",
  "02",
  "03",
  "04",
  "05",
  "06",
  "07",
  "08",
  "09",
  "16",
  "17",
  "18",
  "12",
  "13",
  "14",
  "15",
  "99",
  "NIRC",
  "SIRC",
];

/**
 * Human-readable labels for the Regional Council 2023 classification codes, for use in
 * error messages / documentation only. Runtime tool output prefers the label Stats NZ's
 * own SDMX-JSON response embeds for whatever codes are actually returned (see
 * flattenSdmxJson in clients/statsNzSdmx.ts) — these are a fallback, not the source of truth.
 * Source: Stats NZ "Statistical standard for geographic areas 2023" and the Regional
 * Council 2023 classification (16 regions + "99 Area Outside Region" = 17 categories);
 * code numbers cross-checked against the live DEFAULT annotation above.
 * https://www.stats.govt.nz/assets/Methods/Statistical-standard-for-geographic-areas-2023/statistical-standard-for-geographic-areas-2023-updated-december-2023.pdf
 */
export const REGIONAL_COUNCIL_NAMES: Record<string, string> = {
  RC9999: "New Zealand",
  "01": "Northland region",
  "02": "Auckland region",
  "03": "Waikato region",
  "04": "Bay of Plenty region",
  "05": "Gisborne region",
  "06": "Hawke's Bay region",
  "07": "Taranaki region",
  "08": "Manawatu-Whanganui region",
  "09": "Wellington region",
  "12": "West Coast region",
  "13": "Canterbury region",
  "14": "Otago region",
  "15": "Southland region",
  "16": "Tasman region",
  "17": "Nelson region",
  "18": "Marlborough region",
  "99": "Area outside region",
  NIRC: "North Island regional councils",
  SIRC: "South Island regional councils",
};

// ---------------------------------------------------------------------------------
// Curated dataflow: business demography (enterprises by industry).
// ---------------------------------------------------------------------------------
// Confirmed live on 2026-07-09 the same way as above. This dataflow's annotations state:
//   LAYOUT_ROW:    YEAR_BDS_BDS_004
//   LAYOUT_COLUMN: ANZSIC06_BDS_BDS_004,MEASURE_BDS_BDS_004
//   DEFAULT:       ANZSIC06=TOTAL
// No DEFAULT code was published for MEASURE or for the YEAR range as an explicit code
// list (unlike POPES_SUB_004's YEAR codes, which the DEFAULT annotation did enumerate);
// the 2000-2025 year range is read off the dataflow's title text, not a fetched codelist,
// so annual codes "2000".."2025" are assumed to exist but not individually confirmed.
export const BUSINESS_DEMOGRAPHY_DATAFLOW_ID = "BDS_BDS_004";
export const BUSINESS_DEMOGRAPHY_DATAFLOW_VERSION = "1.0";
export const BUSINESS_DEMOGRAPHY_DATAFLOW_NAME = "Enterprises by industry 2000-2025";
export const BUSINESS_DEMOGRAPHY_INDUSTRY_TOTAL_CODE = "TOTAL";
export const BUSINESS_DEMOGRAPHY_YEAR_MIN = 2000;
export const BUSINESS_DEMOGRAPHY_YEAR_MAX = 2025;
