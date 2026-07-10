import { describe, expect, it } from "vitest";
import { describePage, normalizeLimit, normalizeOffset, paginate } from "../src/pagination.js";

describe("normalizeLimit", () => {
  it("defaults when undefined", () => {
    expect(normalizeLimit(undefined)).toBe(20);
  });

  it("defaults when invalid", () => {
    expect(normalizeLimit(Number.NaN)).toBe(20);
    expect(normalizeLimit(-5)).toBe(20);
    expect(normalizeLimit(0)).toBe(20);
  });

  it("clamps to maxLimit", () => {
    expect(normalizeLimit(1000, { maxLimit: 50 })).toBe(50);
  });

  it("floors fractional input", () => {
    expect(normalizeLimit(10.9)).toBe(10);
  });

  it("respects custom defaultLimit", () => {
    expect(normalizeLimit(undefined, { defaultLimit: 5 })).toBe(5);
  });
});

describe("normalizeOffset", () => {
  it("defaults to 0 when undefined or invalid", () => {
    expect(normalizeOffset(undefined)).toBe(0);
    expect(normalizeOffset(-1)).toBe(0);
    expect(normalizeOffset(Number.NaN)).toBe(0);
  });

  it("floors fractional input", () => {
    expect(normalizeOffset(3.7)).toBe(3);
  });
});

describe("paginate", () => {
  const items = Array.from({ length: 105 }, (_, i) => i);

  it("returns first page by default", () => {
    const result = paginate(items, {});
    expect(result.items).toEqual(items.slice(0, 20));
    expect(result.total_count).toBe(105);
    expect(result.has_more).toBe(true);
    expect(result.next_offset).toBe(20);
  });

  it("respects limit and offset", () => {
    const result = paginate(items, { limit: 10, offset: 100 });
    expect(result.items).toEqual(items.slice(100, 105));
    expect(result.has_more).toBe(false);
    expect(result.next_offset).toBeNull();
  });

  it("handles offset past the end", () => {
    const result = paginate(items, { offset: 1000 });
    expect(result.items).toEqual([]);
    expect(result.has_more).toBe(false);
    expect(result.next_offset).toBeNull();
  });

  it("has_more is false when the last page is exactly full", () => {
    const exact = Array.from({ length: 20 }, (_, i) => i);
    const result = paginate(exact, { limit: 20, offset: 0 });
    expect(result.has_more).toBe(false);
    expect(result.next_offset).toBeNull();
  });
});

describe("describePage", () => {
  it("computes has_more and next_offset from server-reported counts", () => {
    const page = describePage({ returned: 50, total_count: 200, offset: 0 });
    expect(page).toEqual({ total_count: 200, has_more: true, next_offset: 50 });
  });

  it("is not has_more on the last page", () => {
    const page = describePage({ returned: 20, total_count: 200, offset: 180 });
    expect(page).toEqual({ total_count: 200, has_more: false, next_offset: null });
  });
});
