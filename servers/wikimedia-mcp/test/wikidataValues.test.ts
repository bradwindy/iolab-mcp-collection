import { describe, expect, it } from "vitest";
import { collectUnitIds, collectValueIds, formatTime, renderValue, unitId } from "../src/wikidataValues.js";

const time = (timestamp: string, precision: number) => ({
  property: { id: "P585", data_type: "time" },
  value: { type: "value", content: { time: timestamp, precision, calendarmodel: "http://www.wikidata.org/entity/Q1985727" } },
});

describe("formatTime", () => {
  it("renders to the precision the value actually claims", () => {
    // The timestamp is always a full ISO-looking string, so rendering it verbatim invents a
    // specificity the data does not assert: precision 9 means "1986", not 1 January 1986.
    expect(formatTime("+1986-12-13T00:00:00Z", 11)).toBe("13 December 1986");
    expect(formatTime("+1986-12-00T00:00:00Z", 10)).toBe("December 1986");
    expect(formatTime("+1986-00-00T00:00:00Z", 9)).toBe("1986");
    expect(formatTime("+1980-00-00T00:00:00Z", 8)).toBe("1980s");
    expect(formatTime("+1901-00-00T00:00:00Z", 7)).toBe("20th century");
  });

  it("handles the zeroed month and day the format explicitly allows", () => {
    // "Month and day may be 00 if they are unknown or insignificant" — new Date() gives Invalid Date.
    expect(formatTime("+1000-00-00T00:00:00Z", 11)).toBe("1000");
    expect(formatTime("+1000-00-00T00:00:00Z", 9)).toBe("1000");
  });

  it("handles years far outside the JavaScript Date range", () => {
    // A real Wikidata value on Q2 (Earth): -4540000000, at precision 2.
    expect(formatTime("-4540000000-00-00T00:00:00Z", 2)).toContain("4,540,000,000");
    expect(formatTime("-4540000000-00-00T00:00:00Z", 2)).toContain("BCE");
  });

  it("marks BCE from the sign rather than the year", () => {
    expect(formatTime("-0044-03-15T00:00:00Z", 11)).toBe("15 March 44 BCE");
  });

  it("returns the raw timestamp when precision is finer than a day or missing", () => {
    expect(formatTime("+1986-12-13T10:30:00Z", 14)).toBe("+1986-12-13T10:30:00Z");
    expect(formatTime("+1986-12-13T00:00:00Z", undefined)).toBe("+1986-12-13T00:00:00Z");
  });
});

describe("unitId", () => {
  it("treats the API's unitless marker as no unit", () => {
    expect(unitId("1")).toBeUndefined();
  });

  it("extracts the entity id from a unit URI", () => {
    expect(unitId("http://www.wikidata.org/entity/Q712226")).toBe("Q712226");
  });
});

describe("renderValue", () => {
  it("keeps a time's precision and calendar alongside the formatted value", () => {
    expect(renderValue(time("+1991-12-31T00:00:00Z", 11), {})).toEqual({
      value: "31 December 1991",
      precision: 11,
      precision_label: "day",
      calendar_model: "proleptic Gregorian",
    });
  });

  it("attaches the unit symbol to a quantity", () => {
    // "+268021" alone is unusable: it could be square kilometres or square miles. P5061 gives the
    // symbol a reader wants; the label ("square kilometre") is the fallback.
    const statement = {
      property: { id: "P2046", data_type: "quantity" },
      value: { type: "value", content: { amount: "+268021", unit: "http://www.wikidata.org/entity/Q712226" } },
    };

    expect(renderValue(statement, { Q712226: "square kilometre" }, { Q712226: "km²" })).toEqual({
      value: "+268021 km²",
      unit_id: "Q712226",
    });
    expect(renderValue(statement, { Q712226: "square kilometre" }).value).toBe("+268021 square kilometre");
  });

  it("leaves a unitless quantity unadorned", () => {
    const statement = {
      property: { id: "P1082", data_type: "quantity" },
      value: { type: "value", content: { amount: "+3516000", unit: "1" } },
    };
    expect(renderValue(statement, {})).toEqual({ value: "+3516000" });
  });

  it("keeps quantity bounds as strings rather than parsing them", () => {
    // Amounts are arbitrary-precision decimals; parseFloat would silently lose digits.
    const statement = {
      property: { id: "P1102", data_type: "quantity" },
      value: {
        type: "value",
        content: { amount: "+0.0033528", unit: "1", upperBound: "+0.0033529", lowerBound: "+0.0033527" },
      },
    };
    expect(renderValue(statement, {})).toEqual({
      value: "+0.0033528",
      upper_bound: "+0.0033529",
      lower_bound: "+0.0033527",
    });
  });

  it("reports which language a monolingual text is in", () => {
    const statement = {
      property: { id: "P1843", data_type: "monolingualtext" },
      value: { type: "value", content: { text: "kiwi", language: "mi" } },
    };
    expect(renderValue(statement, {})).toEqual({ value: "kiwi", language: "mi" });
  });

  it("resolves an entity reference to its label", () => {
    const statement = { property: { id: "P31", data_type: "wikibase-item" }, value: { type: "value", content: "Q5" } };
    expect(renderValue(statement, { Q5: "human" })).toEqual({ value: "human", entity_id: "Q5" });
  });

  it("switches on the declared data type, not on which fields happen to be present", () => {
    // A catalogue code that reads "Q42" must not be rendered as an entity label, and must not be
    // handed back a `entity_id` the caller is told they can fetch.
    const statement = { property: { id: "P528", data_type: "external-id" }, value: { type: "value", content: "Q42" } };
    expect(renderValue(statement, { Q42: "Douglas Adams" })).toEqual({ value: "Q42" });
  });

  it("does not assume a coordinate is on Earth", () => {
    const statement = {
      property: { id: "P625", data_type: "globe-coordinate" },
      value: { type: "value", content: { latitude: 1.5, longitude: 2.5, globe: "http://www.wikidata.org/entity/Q111" } },
    };
    expect(renderValue(statement, { Q111: "Mars" })).toEqual({ value: "1.5, 2.5", globe: "Mars" });
  });

  it("distinguishes no-value from unknown-value", () => {
    expect(renderValue({ value: { type: "novalue" } }, {}).value).toBe("(no value)");
    expect(renderValue({ value: { type: "somevalue" } }, {}).value).toBe("(unknown value)");
  });
});

describe("collectValueIds / collectUnitIds", () => {
  it("collects ids from qualifiers as well as the statement value", () => {
    const statement = {
      property: { id: "P1082", data_type: "quantity" },
      value: { type: "value", content: { amount: "+3516000", unit: "http://www.wikidata.org/entity/Q712226" } },
      qualifiers: [
        { property: { id: "P459", data_type: "wikibase-item" }, value: { type: "value", content: "Q791801" } },
        { property: { id: "P585", data_type: "time" }, value: { type: "value", content: { time: "+1991-12-31T00:00:00Z", precision: 11 } } },
      ],
    };

    expect(collectValueIds(statement).sort()).toEqual(["Q712226", "Q791801"]);
    expect(collectUnitIds(statement)).toEqual(["Q712226"]);
  });

  it("does not send an external-id that looks like a Q-id to the label batch", () => {
    const statement = { property: { id: "P528", data_type: "external-id" }, value: { type: "value", content: "Q42" } };
    expect(collectValueIds(statement)).toEqual([]);
  });
});
