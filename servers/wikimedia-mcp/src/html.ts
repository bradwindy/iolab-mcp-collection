/**
 * HTML-to-text helpers.
 *
 * Two different jobs, deliberately kept separate:
 *
 * - `parsePageDocument` handles a whole rendered article (100 KB - 1 MB of legacy-parser output)
 *   via `HTMLRewriter` (https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/) —
 *   native to Workers, streaming, no DOM dependency. It splits the page into sections and harvests
 *   citations in the same pass.
 * - `stripInlineHtml` handles the short HTML fragments Wikimedia embeds in otherwise-plain fields
 *   (search snippets wrapped in `<span class="searchmatch">`, Commons `Artist` values that are a
 *   bare `<a>` tag). Those are one-liners; spinning up an async HTMLRewriter pass per row would be
 *   absurd, and a regex is sufficient for a fragment with no nesting to track.
 *
 * Why a whole-page parse rather than `action=parse&section=N`, which is the obvious thing:
 *
 * - `&section=N` renders that section **in isolation**, so a `<ref name="Lowe2021" />` whose
 *   definition lives in another section cannot resolve and MediaWiki renders
 *   `Cite error: The named reference Lowe2021 was invoked but never defined` directly into the
 *   prose. A whole-page parse has zero cite errors — confirmed live on `Taupō Volcano`,
 *   `Lake Taupō`, `World War II` and `New Zealand`.
 * - It appends a partial reference list to every section. On `Taupō Volcano` section 6 that was 56%
 *   of the payload.
 * - It takes one section per call (`section=1|2` is `invalidsection`), so reading three sections of
 *   an article costs three round trips against an API that permits one concurrent request.
 * - It breaks outright on transcluded sections, whose `index` is `"T-1"` rather than an integer.
 */

/**
 * A section's position in the table of contents, as `prop=tocdata` reports it.
 *
 * Declared structurally here rather than imported from the client, so this module stays free of any
 * dependency on it — `clients/wiki.ts` imports *this* file, and the reverse would be a cycle.
 */
export type SectionMeta = {
  index: string;
  level: number;
  number: string;
  title: string;
  anchor: string;
};

/**
 * Dropped wholesale from rendered wiki HTML, with the live symptom each one fixes.
 *
 * `style` matters more than it looks: section HTML embeds
 * `<style data-mw-deduplicate="TemplateStyles:...">` blocks containing whole CSS rulesets, which
 * would otherwise be emitted as body text.
 *
 * `.mw-references-wrap` / `ol.references` / `.reflist` are the reference list itself — note
 * `.reference` (the inline `[1]` marker) is a different class from `.references` (the list), and
 * only the former was previously handled. `.legend`/`.legend-color` are map legend colour keys, 21
 * of them on `Taupō Volcano`. `.mw-ext-cite-error`/`.error` are the cite-error strings.
 *
 * `[class~="x"]` rather than `.x` for the multi-class containers: MediaWiki emits
 * `class="infobox vcard"` and similar, and the attribute-contains-word form is the robust match.
 */
const SKIP_SELECTOR = [
  "noscript",
  ".mw-editsection",
  "sup.reference",
  ".mw-ref",
  ".reference",
  ".mw-cite-backlink",
  ".mw-references-wrap",
  "ol.references",
  '[class~="reflist"]',
  ".mw-ext-cite-error",
  ".error",
  '[class~="legend"]',
  '[class~="legend-color"]',
  '[class~="navbox"]',
  '[class~="vertical-navbox"]',
  '[class~="infobox"]',
  '[class~="metadata"]',
  '[class~="ambox"]',
  '[class~="mbox"]',
  '[class~="tmbox"]',
  '[class~="ombox"]',
  '[class~="sistersitebox"]',
  '[class~="side-box"]',
  '[class~="thumb"]',
  "figure",
  '[class~="thumbcaption"]',
  "figcaption",
  '[class~="gallery"]',
  '[class~="hatnote"]',
  '[class~="dablink"]',
  '[class~="shortdescription"]',
  '[class~="noprint"]',
  '[class~="nomobile"]',
  '[class~="noexcerpt"]',
  '[class~="mw-empty-elt"]',
  '[class~="mw-kartographer-map"]',
  '[class~="Z3988"]',
  "#coordinates",
].join(", ");

/** Never collected anywhere, not even into a reference's text. */
const HARD_SKIP_SELECTOR = "script, style";

const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";
const BLOCK_SELECTOR = "p, div, br, li, tr, h1, h2, h3, h4, h5, h6";

/** The lead section, which has no heading of its own and is not in `tocdata`. */
export const LEAD_SECTION_INDEX = "0";

export type ParsedSection = {
  index: string;
  level: number;
  number: string;
  title: string;
  anchor: string;
  text: string;
  chars: number;
};

export type ParsedReference = {
  ref_id: string;
  text: string;
  title?: string;
  publication?: string;
  year?: string;
  authors?: string[];
  doi?: string;
  pmid?: string;
  bibcode?: string;
  url?: string;
};

export type ParsedDocument = {
  sections: ParsedSection[];
  references: ParsedReference[];
};

/**
 * Convert one whole rendered article into per-section plain text plus structured citations.
 *
 * Sections are keyed off the heading's `id`, matched against `tocdata`'s `anchor`, rather than
 * counted positionally — a page can render a heading the TOC omits, and a positional match would
 * then shift every subsequent section by one.
 */
export async function parsePageDocument(html: string, outline: SectionMeta[]): Promise<ParsedDocument> {
  const byAnchor = new Map(outline.filter((section) => section.anchor.length > 0).map((section) => [section.anchor, section]));

  const lead: SectionBucket = { meta: null, parts: [] };
  const buckets: SectionBucket[] = [lead];
  let current = lead;

  let hardSkipDepth = 0;
  let skipDepth = 0;

  const references: ParsedReference[] = [];
  let currentRef: { id: string; parts: string[]; coins?: string } | null = null;

  const rewriter = new HTMLRewriter()
    .on(HARD_SKIP_SELECTOR, {
      element(el) {
        hardSkipDepth++;
        el.onEndTag(() => {
          hardSkipDepth--;
        });
      },
    })
    // Registered before the reference-list skip so it still sees its own start tag: element handlers
    // for one element run in registration order, and `skipDepth` only gates text, not elements.
    .on("li[id]", {
      element(el) {
        const id = el.getAttribute("id");
        if (id === null || !id.startsWith("cite_note")) return;
        const ref: { id: string; parts: string[]; coins?: string } = { id, parts: [] };
        currentRef = ref;
        el.onEndTag(() => {
          const text = collapseWhitespace(decodeEntities(ref.parts.join("")));
          if (text.length > 0 || ref.coins !== undefined) {
            references.push({ ref_id: id, text, ...parseCoins(ref.coins) });
          }
          if (currentRef === ref) currentRef = null;
        });
      },
    })
    .on('span[class~="Z3988"]', {
      element(el) {
        // COinS: every {{cite}} template renders an OpenURL 1.0 blob into this span's title. It is
        // the only machine-readable citation data Wikimedia exposes — there is no references API
        // (/api/rest_v1/page/references/ 404s, and /w/rest.php/v1/ has no equivalent).
        const coins = el.getAttribute("title");
        if (coins !== null && currentRef !== null) currentRef.coins = coins;
      },
    })
    .on(SKIP_SELECTOR, {
      element(el) {
        skipDepth++;
        el.onEndTag(() => {
          skipDepth--;
        });
      },
    })
    .on(HEADING_SELECTOR, {
      element(el) {
        if (skipDepth > 0) return;
        const anchor = el.getAttribute("id");
        const meta = anchor === null ? undefined : byAnchor.get(anchor);
        if (meta === undefined) return;
        current = { meta, parts: [] };
        buckets.push(current);
      },
    })
    .on(BLOCK_SELECTOR, {
      element() {
        if (skipDepth > 0) return;
        current.parts.push("\n");
      },
    })
    .on("*", {
      text(chunk) {
        if (hardSkipDepth > 0) return;
        // A reference's own text is inside the skipped reference list, so it is collected here and
        // nowhere else — the two destinations never both apply.
        if (currentRef !== null) {
          currentRef.parts.push(chunk.text);
          return;
        }
        if (skipDepth > 0) return;
        current.parts.push(chunk.text);
      },
    });

  const transformed = rewriter.transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }));
  // HTMLRewriter only actually runs its handlers as the body is consumed.
  await transformed.text();

  const sections = buckets.map((bucket) => {
    // Decoded exactly once, here. Decoding again downstream would turn a literal `&amp;#160;` — text
    // an editor deliberately wrote — into a non-breaking space.
    const text = collapseWhitespace(decodeEntities(bucket.parts.join("")));
    const meta = bucket.meta;
    return {
      index: meta?.index ?? LEAD_SECTION_INDEX,
      level: meta?.level ?? 1,
      number: meta?.number ?? "",
      title: meta?.title ?? "",
      anchor: meta?.anchor ?? "",
      text,
      chars: text.length,
    };
  });

  return { sections, references };
}

type SectionBucket = { meta: SectionMeta | null; parts: string[] };

/** Pull the useful fields out of a COinS OpenURL blob. */
function parseCoins(coins: string | undefined): Omit<ParsedReference, "ref_id" | "text"> {
  if (coins === undefined) return {};
  // `getAttribute` hands back the raw source slice, exactly like a text chunk, so the pair separators
  // are still `&amp;`. Entity-decoding has to happen before `URLSearchParams` or every key after the
  // first parses as `amp;rft.…` and silently reads as absent. The percent-escapes inside the values
  // are then URLSearchParams' job — two different encodings, unwound in the right order, once each.
  const fields = new URLSearchParams(decodeEntities(coins));
  const identifiers = fields.getAll("rft_id");
  const prefixed = (prefix: string) => identifiers.find((id) => id.startsWith(prefix))?.slice(prefix.length);
  const authors = fields.getAll("rft.au");
  const title = fields.get("rft.atitle") ?? fields.get("rft.btitle") ?? fields.get("rft.title");
  const publication = fields.get("rft.jtitle") ?? fields.get("rft.pub");
  // `rft.date` is anything from "2020" to "2020-10-15"; the year is the only part worth promoting.
  const year = /^(\d{4})/.exec(fields.get("rft.date") ?? "")?.[1];
  const url = identifiers.find((id) => id.startsWith("http"));

  return {
    ...(title !== null && title !== undefined ? { title } : {}),
    ...(publication !== null && publication !== undefined ? { publication } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(authors.length > 0 ? { authors } : {}),
    ...(prefixed("info:doi/") !== undefined ? { doi: prefixed("info:doi/") as string } : {}),
    ...(prefixed("info:pmid/") !== undefined ? { pmid: prefixed("info:pmid/") as string } : {}),
    ...(prefixed("info:bibcode/") !== undefined ? { bibcode: prefixed("info:bibcode/") as string } : {}),
    ...(url !== undefined ? { url } : {}),
  };
}

function collapseWhitespace(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  times: "×",
  deg: "°",
  minus: "−",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

/**
 * Decode HTML character references.
 *
 * `HTMLRewriter`'s text handlers hand back the raw source slice — character references are not
 * decoded — so this is what stops `25–30&#160;km` and `Water &amp; Atmosphere` reaching the caller.
 *
 * `&amp;` is decoded last so an escaped-then-decoded value can't smuggle a second entity back in
 * (`&amp;lt;` must end up as the literal `&lt;`, not `<`). The digit counts are bounded: an
 * unbounded `\d+` on attacker-influenced text is a needless CPU sink.
 */
export function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d{1,7});/g, (_match, code: string) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_match, code: string) => safeCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name: string) => {
      if (name.toLowerCase() === "amp") return match;
      return NAMED_ENTITIES[name.toLowerCase()] ?? match;
    })
    .replace(/&amp;/g, "&");
}

/**
 * Strip tags and decode entities from a short inline HTML fragment.
 */
export function stripInlineHtml(fragment: string): string {
  const withoutTags = fragment.replace(/<[^>]*>/g, "");
  return decodeEntities(withoutTags).replace(/\s+/g, " ").trim();
}

function safeCodePoint(code: number): string {
  // Surrogates are not standalone characters; String.fromCodePoint accepts them and produces a lone
  // surrogate that breaks JSON serialisation downstream.
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  if (code >= 0xd800 && code <= 0xdfff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}
