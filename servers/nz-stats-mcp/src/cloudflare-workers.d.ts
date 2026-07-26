// `McpAgent`/`Agent` (from the `agents` package) ultimately extend the Workers runtime's own
// `DurableObject` class, imported inside their own .d.ts from the ambient `cloudflare:workers`
// module — and that's genuinely the ONLY place `this.env` comes from; none of `McpAgent`, `Agent`,
// or the `partyserver` `Server` class it sits on redeclares an `env` member of its own. Normally
// that module's types come from `@cloudflare/workers-types` or a locally generated `wrangler types`
// output, and this repo intentionally has neither (see env.d.ts). So it's hand-declared here, with
// just the members this server's own code and tests actually use: `DurableObject` (for `this.env`
// on the agent) and the `env` export (for this package's own test files, which do
// `import { env } from "cloudflare:workers"` to reach the gateway's real MCP_CACHE/CREDENTIALS_DB
// bindings under vitest-pool-workers).
//
// This has to live in its own file, with no top-level import/export. A `declare module "..."`
// block written inside a file that's already an ES module (env.d.ts, because of its own
// `export {}`) is parsed as a *module augmentation*, which requires the named module to already
// exist elsewhere — it can't originate one. Declaring "cloudflare:workers" from scratch only works
// from an ambient *script* file like this one. Since this file supplies the module from scratch,
// it must include EVERY member this package references from "cloudflare:workers" — there's no
// other declaration merging in a partial one.
declare module "cloudflare:workers" {
  export abstract class DurableObject<TEnv = unknown> {
    env: TEnv;
  }

  export const env: Cloudflare.Env;
}
