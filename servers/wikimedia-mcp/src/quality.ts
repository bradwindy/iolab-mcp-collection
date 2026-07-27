/**
 * Article quality and maintenance signals.
 *
 * These exist so a caller can tell, without a second call and without reading the prose, when an
 * article is worth cross-checking harder. Everything here is derived from data the metadata query
 * already returns.
 */

/**
 * Hidden categories that actually signal a maintenance problem, mapped to the flag they set.
 *
 * An allow-list rather than an `All `-prefix heuristic, because the prefix is not a reliable
 * indicator: `Category:All Wikipedia articles written in New Zealand English` has 38,000 members and
 * means nothing about quality. Enumerated from `list=allcategories&acprefix=All%20articles` on
 * en.wikipedia.org, keeping the umbrella categories with meaningful membership.
 */
const MAINTENANCE_CATEGORIES: Record<string, string> = {
  "All articles with unsourced statements": "unsourced_statements",
  "All articles needing additional references": "needs_additional_references",
  "All articles with dead external links": "dead_external_links",
  "All articles lacking sources": "lacking_sources",
  "All articles lacking in-text citations": "lacking_in_text_citations",
  "All articles lacking reliable references": "lacking_reliable_references",
  "All articles with failed verification": "failed_verification",
  "All articles that may contain original research": "may_contain_original_research",
  "All articles with a promotional tone": "promotional_tone",
  "All articles with specifically marked weasel-worded phrases": "weasel_worded",
  "All articles with topics of unclear notability": "unclear_notability",
  "All articles needing rewrite": "needs_rewrite",
  "All articles with incomplete citations": "incomplete_citations",
  "All articles with self-published sources": "self_published_sources",
  "All articles containing circular references": "circular_references",
  "All articles with bare URLs for citations": "bare_urls",
  "All articles with empty sections": "empty_sections",
  "All accuracy disputes": "accuracy_disputes",
  "All pages needing factual verification": "needs_factual_verification",
  "All articles with minor POV problems": "pov_problems",
  "All Wikipedia articles in need of updating": "needs_updating",
  "All articles containing potentially dated statements": "potentially_dated_statements",
};

const STUB_CATEGORY = "All stub articles";

/** `Articles with unsourced statements from June 2026` and its many siblings. */
const DATED_CATEGORY = /\bfrom ([A-Z][a-z]+ \d{4})$/;

const MONTHS = [
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

export type Maintenance = {
  flags: string[];
  is_stub: boolean;
  /** Earliest month any still-open maintenance tag was added, as YYYY-MM. */
  oldest_tag_month?: string;
};

export type CategoryRow = { title: string; hidden?: boolean };

/** Reduce a page's hidden categories to the handful of signals worth acting on. */
export function summariseMaintenance(categories: CategoryRow[]): Maintenance {
  const hidden = categories.filter((row) => row.hidden === true).map((row) => stripNamespace(row.title));
  const flags = [...new Set(hidden.flatMap((name) => (MAINTENANCE_CATEGORIES[name] !== undefined ? [MAINTENANCE_CATEGORIES[name] as string] : [])))];
  flags.sort();

  const months = hidden.flatMap((name) => {
    const match = DATED_CATEGORY.exec(name);
    if (match === null) return [];
    const month = toIsoMonth(match[1] as string);
    return month === undefined ? [] : [month];
  });
  months.sort();

  return {
    flags,
    // The hidden category is the more reliable of the two signals: it is produced by a {{stub}}
    // template in the article body, whereas an assessment class lives on the talk page and drifts.
    is_stub: hidden.includes(STUB_CATEGORY),
    ...(months.length > 0 ? { oldest_tag_month: months[0] as string } : {}),
  };
}

export type AssessmentRow = Record<string, { class?: string; importance?: string }>;

/**
 * Reduce per-WikiProject assessments to one grade.
 *
 * `Project-independent assessment` is the pseudo-project WP:PIQA introduced in 2023 precisely so an
 * article has a single grade rather than one per project; prefer it, and fall back to the most
 * common class across the real projects. Note a disambiguation page reports an **empty-string**
 * class rather than "Disambig", so empty values are discarded rather than returned.
 */
export function summariseAssessment(assessments: AssessmentRow | undefined): string | undefined {
  if (assessments === undefined) return undefined;
  const independent = assessments["Project-independent assessment"]?.class;
  if (independent !== undefined && independent.length > 0) return independent;

  const counts = new Map<string, number>();
  for (const entry of Object.values(assessments)) {
    const grade = entry.class;
    if (grade === undefined || grade.length === 0) continue;
    counts.set(grade, (counts.get(grade) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [grade, count] of counts) {
    if (count > bestCount) {
      best = grade;
      bestCount = count;
    }
  }
  return best;
}

function stripNamespace(title: string): string {
  const colon = title.indexOf(":");
  return colon === -1 ? title : title.slice(colon + 1);
}

function toIsoMonth(monthYear: string): string | undefined {
  const [name, year] = monthYear.split(" ");
  const index = MONTHS.indexOf(name ?? "");
  if (index === -1 || year === undefined) return undefined;
  return `${year}-${String(index + 1).padStart(2, "0")}`;
}
