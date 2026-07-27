/**
 * Rendering Wikibase REST statement values.
 *
 * The shape of `value.content` is deliberately untyped in the REST OpenAPI spec; what it holds is
 * determined by the statement's `property.data_type`, per the live
 * `/w/rest.php/wikibase/v1/property-data-types` mapping. Switching on the declared type rather than
 * on which fields happen to be present is what stops a future datatype carrying a `text` field from
 * being silently rendered as monolingual text.
 *
 * Note the REST shapes differ from the Action API's documented JSON: entity references arrive as a
 * bare `"Q42"` string rather than `{entity-type, id, numeric-id}`, and `time` drops `timezone`,
 * `before` and `after`. Do not port Action-API parsing here.
 */

import type { RestStatement } from "./clients/wikidata.js";

/**
 * Wikibase time precision, from the Wikibase JSON documentation: "To what unit is the given
 * date/time significant?"
 *
 * This matters because the timestamp is always a full ISO-looking string. `+1986-00-00T00:00:00Z`
 * with precision 9 means **1986**, not 1 January 1986, and rendering it as a date invents a
 * specificity the data does not claim.
 */
const PRECISION_LABELS: Record<number, string> = {
  0: "billion years",
  1: "hundred million years",
  2: "ten million years",
  3: "million years",
  4: "hundred thousand years",
  5: "ten thousand years",
  6: "millennium",
  7: "century",
  8: "decade",
  9: "year",
  10: "month",
  11: "day",
  12: "hour",
  13: "minute",
  14: "second",
};

const CALENDAR_MODELS: Record<string, string> = {
  Q1985727: "proleptic Gregorian",
  Q1985786: "proleptic Julian",
};

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * `+1991-12-31T00:00:00Z`, but also `-4540000000-00-00T00:00:00Z`.
 *
 * Parsed with a regex and never with `Date`: month and day are legitimately `00` when unknown or
 * insignificant, the day may be up to 31 in any month to accommodate "leap dates" like 30 February,
 * and years run to ten digits — all three produce `Invalid Date`.
 */
const TIME_VALUE = /^([+-])(\d+)-(\d{2})-(\d{2})T/;

export type RenderedValue = {
  value: string;
  entity_id?: string;
  /** Time only: the unit the value is significant to. 9 is year, 10 month, 11 day. */
  precision?: number;
  precision_label?: string;
  calendar_model?: string;
  /** Quantity only. `unit_id` is absent for a unitless quantity, which the API reports as "1". */
  unit_id?: string;
  upper_bound?: string;
  lower_bound?: string;
  /** Monolingual text only. */
  language?: string;
  /** Globe coordinate only; `globe` is not always Earth. */
  globe?: string;
};

/** Format a Wikibase time to the precision it actually claims. */
export function formatTime(timestamp: string, precision: number | undefined): string {
  const match = TIME_VALUE.exec(timestamp);
  if (match === null) return timestamp;
  const [, sign, yearDigits, month, day] = match as unknown as [string, string, string, string, string];
  const year = Number(yearDigits);
  const era = sign === "-" ? " BCE" : "";

  if (precision === undefined || precision >= 12) return timestamp;
  if (precision >= 11) {
    const monthName = MONTH_NAMES[Number(month) - 1];
    // A day-precision value with a zeroed month or day is contradictory; report what is known.
    if (monthName === undefined || day === "00") return `${year}${era}`;
    return `${Number(day)} ${monthName} ${year}${era}`;
  }
  if (precision === 10) {
    const monthName = MONTH_NAMES[Number(month) - 1];
    return monthName === undefined ? `${year}${era}` : `${monthName} ${year}${era}`;
  }
  if (precision === 9) return `${year}${era}`;
  if (precision === 8) return `${Math.floor(year / 10) * 10}s${era}`;
  if (precision === 7) return `${Math.floor((year - 1) / 100) + 1}th century${era}`;
  if (precision === 6) return `${Math.floor((year - 1) / 1000) + 1}th millennium${era}`;
  // Coarser than a millennium: an order of magnitude is the only honest rendering.
  return `${year.toLocaleString("en-US")} years${era === "" ? " CE" : " BCE"}`;
}

/** `http://www.wikidata.org/entity/Q712226` -> `Q712226`; `"1"` (unitless) -> undefined. */
export function unitId(unit: unknown): string | undefined {
  if (typeof unit !== "string" || unit === "1") return undefined;
  return /\/entity\/([QP]\d+)$/.exec(unit)?.[1];
}

/**
 * Render one statement (or qualifier) value.
 *
 * `labels` resolves entity references, unit ids and anything else already fetched; `unitSymbols`
 * carries the P5061 "unit symbol" values, which are what a reader actually wants ("km²" rather than
 * "square kilometre").
 */
export function renderValue(
  statement: Pick<RestStatement, "property" | "value">,
  labels: Record<string, string>,
  unitSymbols: Record<string, string> = {},
): RenderedValue {
  const type = statement.value?.type;
  if (type === "novalue") return { value: "(no value)" };
  if (type === "somevalue") return { value: "(unknown value)" };

  const content = statement.value?.content;
  const dataType = statement.property?.data_type;

  if (dataType === "wikibase-item" || dataType === "wikibase-property" || dataType === "wikibase-lexeme" || dataType === "entity-schema") {
    if (typeof content !== "string") return { value: stringify(content) };
    return { value: labels[content] ?? content, entity_id: content };
  }

  if (dataType === "time" && isRecord(content)) {
    const timestamp = typeof content["time"] === "string" ? content["time"] : "";
    const precision = typeof content["precision"] === "number" ? content["precision"] : undefined;
    const calendar = unitId(content["calendarmodel"]);
    return {
      value: formatTime(timestamp, precision),
      ...(precision !== undefined ? { precision } : {}),
      ...(precision !== undefined && PRECISION_LABELS[precision] !== undefined ? { precision_label: PRECISION_LABELS[precision] as string } : {}),
      ...(calendar !== undefined ? { calendar_model: CALENDAR_MODELS[calendar] ?? calendar } : {}),
    };
  }

  if (dataType === "quantity" && isRecord(content)) {
    // Amounts are arbitrary-precision signed decimal strings. Never parseFloat them for display.
    const amount = typeof content["amount"] === "string" ? content["amount"] : "";
    const unit = unitId(content["unit"]);
    const symbol = unit === undefined ? undefined : (unitSymbols[unit] ?? labels[unit]);
    return {
      value: symbol === undefined ? amount : `${amount} ${symbol}`,
      ...(unit !== undefined ? { unit_id: unit } : {}),
      ...(typeof content["upperBound"] === "string" ? { upper_bound: content["upperBound"] } : {}),
      ...(typeof content["lowerBound"] === "string" ? { lower_bound: content["lowerBound"] } : {}),
    };
  }

  if (dataType === "monolingualtext" && isRecord(content)) {
    return {
      value: typeof content["text"] === "string" ? content["text"] : "",
      ...(typeof content["language"] === "string" ? { language: content["language"] } : {}),
    };
  }

  if (dataType === "globe-coordinate" && isRecord(content)) {
    const lat = content["latitude"];
    const lon = content["longitude"];
    const globe = unitId(content["globe"]);
    return {
      value: typeof lat === "number" && typeof lon === "number" ? `${lat}, ${lon}` : stringify(content),
      // Usually Q2 (Earth), but Wikidata carries coordinates on other bodies too.
      ...(globe !== undefined ? { globe: labels[globe] ?? globe } : {}),
    };
  }

  if (typeof content === "string") return { value: content };
  return { value: stringify(content) };
}

/** Every entity id a statement, its qualifiers and its units refer to, for one label batch. */
export function collectValueIds(statement: RestStatement): string[] {
  const ids = new Set<string>();
  const visit = (part: Pick<RestStatement, "property" | "value">) => {
    const dataType = part.property?.data_type;
    const content = part.value?.content;
    if (
      typeof content === "string" &&
      (dataType === "wikibase-item" || dataType === "wikibase-property" || dataType === "wikibase-lexeme" || dataType === "entity-schema") &&
      /^[QP]\d+$/.test(content)
    ) {
      ids.add(content);
    }
    if (isRecord(content)) {
      // Units, calendar models and globes are entity references too, and reading a bare Q-id for a
      // unit is exactly the ambiguity this is meant to remove.
      for (const key of ["unit", "globe"]) {
        const id = unitId(content[key]);
        if (id !== undefined) ids.add(id);
      }
    }
  };

  visit(statement);
  for (const qualifier of statement.qualifiers ?? []) visit(qualifier);
  return [...ids];
}

/** Just the unit entities, which need a P5061 lookup rather than a plain label. */
export function collectUnitIds(statement: RestStatement): string[] {
  const ids = new Set<string>();
  const visit = (part: Pick<RestStatement, "property" | "value">) => {
    if (part.property?.data_type !== "quantity") return;
    const content = part.value?.content;
    if (!isRecord(content)) return;
    const id = unitId(content["unit"]);
    if (id !== undefined) ids.add(id);
  };
  visit(statement);
  for (const qualifier of statement.qualifiers ?? []) visit(qualifier);
  return [...ids];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringify(content: unknown): string {
  if (content === undefined || content === null) return "";
  return typeof content === "object" ? JSON.stringify(content) : String(content);
}
