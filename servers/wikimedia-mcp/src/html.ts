/**
 * HTML-to-text helpers.
 *
 * Two different jobs, deliberately kept separate:
 *
 * - `htmlToPlainText` handles whole rendered sections (tens of KB of Parsoid/legacy-parser output)
 *   via `HTMLRewriter` (https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/) —
 *   native to Workers, streaming, no DOM dependency. Adapted from servers/ia-mcp/src/htmlText.ts.
 * - `stripInlineHtml` handles the short HTML fragments Wikimedia embeds in otherwise-plain fields
 *   (search snippets wrapped in `<span class="searchmatch">`, Commons `Artist` values that are a
 *   bare `<a>` tag). Those are one-liners; spinning up an async HTMLRewriter pass per row would be
 *   absurd, and a regex is sufficient for a fragment with no nesting to track.
 */

/**
 * Dropped wholesale from rendered wiki HTML. Beyond the usual script/style noise this covers two
 * MediaWiki-specific sources of junk confirmed present in live `action=parse` output:
 * `.mw-editsection` (the "[edit]" link rendered beside every heading) and reference markers
 * (`sup.reference` / `.mw-ref`), which otherwise litter prose with bare "[1][2]" runs.
 *
 * `style` matters more than it looks: live section HTML embeds
 * `<style data-mw-deduplicate="TemplateStyles:...">` blocks containing whole CSS rulesets, which
 * would otherwise be emitted as body text.
 */
const SKIP_SELECTOR = "script, style, noscript, .mw-editsection, sup.reference, .mw-ref, .reference, .mw-cite-backlink";
const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";
const BLOCK_SELECTOR = "p, div, br, li, tr, h1, h2, h3, h4, h5, h6";

/** Convert one rendered wiki section (or page) of HTML into readable plain text. */
export async function htmlToPlainText(html: string): Promise<string> {
  let skipDepth = 0;
  const parts: string[] = [];

  const rewriter = new HTMLRewriter()
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
        parts.push("\n\n");
        el.onEndTag(() => {
          parts.push("\n");
        });
      },
    })
    .on(BLOCK_SELECTOR, {
      element() {
        if (skipDepth > 0) return;
        parts.push("\n");
      },
    })
    .on("*", {
      text(chunk) {
        if (skipDepth > 0) return;
        parts.push(chunk.text);
      },
    });

  const transformed = rewriter.transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }));
  // HTMLRewriter only actually runs its handlers as the body is consumed.
  await transformed.text();

  return collapseWhitespace(parts.join(""));
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
};

/**
 * Strip tags and decode entities from a short inline HTML fragment.
 *
 * `&amp;` is decoded last so an escaped-then-decoded value can't smuggle a second entity back in
 * (`&amp;lt;` must end up as the literal `&lt;`, not `<`).
 */
export function stripInlineHtml(fragment: string): string {
  const withoutTags = fragment.replace(/<[^>]*>/g, "");
  return withoutTags
    .replace(/&#(\d+);/g, (_match, code: string) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => safeCodePoint(Number.parseInt(code, 16)))
    .replace(/&(lt|gt|quot|apos|nbsp|ndash|mdash);/g, (_match, name: string) => NAMED_ENTITIES[name] ?? _match)
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}
