/**
 * Converts archived HTML to text/markdown/links using `HTMLRewriter`
 * (https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/) — native to Workers,
 * streaming, zero bundle cost, no DOM dependency. Drops script/style/nav/footer/noscript;
 * markdown mode keeps heading structure (`#`..`######`).
 */

export type ExtractedLink = { text: string; href: string };

export type ExtractedContent = {
  text: string;
  markdown: string;
  links: ExtractedLink[];
};

const SKIP_SELECTOR = "script, style, nav, footer, noscript";
const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";
const BLOCK_SELECTOR = "p, div, br, li, tr";

export async function extractFromHtml(html: string, baseUrl: string): Promise<ExtractedContent> {
  let skipDepth = 0;
  const textParts: string[] = [];
  const markdownParts: string[] = [];
  const links: ExtractedLink[] = [];
  let currentLink: { href: string; textStart: number } | null = null;

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
        const level = Number(el.tagName.slice(1)) || 1;
        textParts.push("\n\n");
        markdownParts.push(`\n\n${"#".repeat(level)} `);
        el.onEndTag(() => {
          textParts.push("\n");
          markdownParts.push("\n");
        });
      },
    })
    .on(BLOCK_SELECTOR, {
      element() {
        if (skipDepth > 0) return;
        textParts.push("\n");
        markdownParts.push("\n");
      },
    })
    .on("a[href]", {
      element(el) {
        if (skipDepth > 0) return;
        const href = el.getAttribute("href");
        if (!href) return;
        let resolved: string;
        try {
          resolved = new URL(href, baseUrl).toString();
        } catch {
          return;
        }
        currentLink = { href: resolved, textStart: markdownParts.length };
        const link = currentLink;
        el.onEndTag(() => {
          const linkText = markdownParts.slice(link.textStart).join("").trim();
          if (linkText) links.push({ text: linkText, href: link.href });
          currentLink = null;
        });
      },
    })
    .on("*", {
      text(chunk) {
        if (skipDepth > 0) return;
        textParts.push(chunk.text);
        markdownParts.push(chunk.text);
      },
    });

  const transformed = rewriter.transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }));
  // HTMLRewriter only actually runs its handlers as the body is consumed.
  await transformed.text();

  return {
    text: collapseWhitespace(textParts.join("")),
    markdown: collapseWhitespace(markdownParts.join("")),
    links,
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
