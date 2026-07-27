import { describe, expect, it } from "vitest";
import { summariseAssessment, summariseMaintenance } from "../src/quality.js";

describe("summariseMaintenance", () => {
  it("ignores hidden categories that are not maintenance issues", () => {
    // Every one of these is a hidden category on a healthy article — `Lake Taupō` carries 14 hidden
    // categories and not one of them is a maintenance problem. An `All `-prefix heuristic would
    // flag the New Zealand English one, which 38,000 articles carry.
    const maintenance = summariseMaintenance([
      { title: "Category:All Wikipedia articles written in New Zealand English", hidden: true },
      { title: "Category:Articles with short description", hidden: true },
      { title: "Category:Coordinates on Wikidata", hidden: true },
      { title: "Category:Webarchive template wayback links", hidden: true },
      { title: "Category:Supervolcanoes", hidden: false },
    ]);

    expect(maintenance).toEqual({ flags: [], is_stub: false });
  });

  it("maps the umbrella maintenance categories to flags", () => {
    const maintenance = summariseMaintenance([
      { title: "Category:All articles with unsourced statements", hidden: true },
      { title: "Category:All articles with dead external links", hidden: true },
      { title: "Category:All accuracy disputes", hidden: true },
    ]);

    expect(maintenance.flags).toEqual(["accuracy_disputes", "dead_external_links", "unsourced_statements"]);
  });

  it("reports the earliest month a still-open tag was added", () => {
    // The dated siblings are what make staleness visible: "disputed since July 2010" is a much
    // stronger signal than "disputed".
    const maintenance = summariseMaintenance([
      { title: "Category:All accuracy disputes", hidden: true },
      { title: "Category:Articles with disputed statements from July 2010", hidden: true },
      { title: "Category:Articles with unsourced statements from June 2026", hidden: true },
    ]);

    expect(maintenance.oldest_tag_month).toBe("2010-07");
  });

  it("detects a stub from the hidden category rather than page length", () => {
    // The category is produced by an actual {{foo-stub}} template in the article body. Page length
    // is a poor proxy — a 35-byte redirect is not a stub, and a 9 KB article can be Start class.
    expect(summariseMaintenance([{ title: "Category:All stub articles", hidden: true }]).is_stub).toBe(true);
    expect(summariseMaintenance([{ title: "Category:Birds of New Zealand", hidden: false }]).is_stub).toBe(false);
  });

  it("ignores a maintenance category that is not marked hidden", () => {
    expect(summariseMaintenance([{ title: "Category:All articles with unsourced statements" }]).flags).toEqual([]);
  });
});

describe("summariseAssessment", () => {
  it("prefers the project-independent grade", () => {
    // WP:PIQA introduced this in 2023 so an article has one grade rather than one per project.
    expect(
      summariseAssessment({
        Birds: { class: "B" },
        "New Zealand": { class: "Start" },
        "Project-independent assessment": { class: "C", importance: "" },
      }),
    ).toBe("C");
  });

  it("falls back to the most common project grade when there is no independent one", () => {
    expect(summariseAssessment({ Birds: { class: "B" }, Lakes: { class: "C" }, Volcanoes: { class: "C" } })).toBe("C");
  });

  it("treats an empty class as absent, which is what a disambiguation page reports", () => {
    // Live: `Java (disambiguation)` returns {"Disambiguation":{"class":"","importance":""}} — an
    // empty string, not "Disambig".
    expect(summariseAssessment({ Disambiguation: { class: "", importance: "" } })).toBeUndefined();
  });

  it("returns undefined for an unassessed page", () => {
    expect(summariseAssessment(undefined)).toBeUndefined();
    expect(summariseAssessment({})).toBeUndefined();
  });
});
