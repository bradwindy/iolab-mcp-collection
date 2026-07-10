import { describe, expect, it } from "vitest";
import { jsonResult, selectFormat, truncationNotice } from "../src/response.js";

describe("selectFormat", () => {
  it("defaults to concise when format is undefined", () => {
    expect(selectFormat(undefined, "concise-value", "detailed-value")).toBe("concise-value");
  });

  it("returns detailed only when explicitly requested", () => {
    expect(selectFormat("detailed", "concise-value", "detailed-value")).toBe("detailed-value");
    expect(selectFormat("concise", "concise-value", "detailed-value")).toBe("concise-value");
  });
});

describe("jsonResult", () => {
  it("produces both text content and structuredContent from the same data", () => {
    const data = { total_count: 2, items: [1, 2] };
    const result = jsonResult(data);
    expect(result.structuredContent).toEqual(data);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual(data);
  });
});

describe("truncationNotice", () => {
  it("is empty when nothing was truncated", () => {
    expect(truncationNotice(10, 10, "narrow further")).toBe("");
  });

  it("explains the truncation with the given hint", () => {
    expect(truncationNotice(50, 4102, "Narrow with `severity`.")).toBe(
      "Showing 50 of 4102. Narrow with `severity`.",
    );
  });
});
