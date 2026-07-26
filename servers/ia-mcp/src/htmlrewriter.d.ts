// `HTMLRewriter` is a Workers-runtime global (https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/),
// not part of the DOM lib — normally typed via `@cloudflare/workers-types` or a locally generated
// `worker-configuration.d.ts`, neither of which this package has (see src/env.d.ts). Hand-typed
// here with only the surface src/htmlText.ts actually uses. Names are prefixed `HtmlRewriter*` to
// avoid colliding with the real DOM `Element` global this package also has via `"dom"` lib. Must
// live in its own ambient script file — see servers/*/src/cloudflare-workers.d.ts for why a
// `declare global` block can't share a file with an `export {}` module.
declare class HTMLRewriter {
  on(selector: string, handlers: HtmlRewriterElementHandlers): this;
  transform(response: Response): Response;
}

interface HtmlRewriterElementHandlers {
  element?(element: HtmlRewriterElement): void;
  text?(text: HtmlRewriterTextChunk): void;
}

interface HtmlRewriterElement {
  tagName: string;
  getAttribute(name: string): string | null;
  onEndTag(handler: () => void): void;
}

interface HtmlRewriterTextChunk {
  text: string;
  lastInTextNode: boolean;
}
