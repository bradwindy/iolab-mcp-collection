# MCP Servers for NZ Public-Data Research: Architecture & Best Practices

Research compiled July 2026. Covers the current MCP spec (2025-11-25, with the 2026-07-28 release candidate noted where relevant), Anthropic's engineering guidance, and Claude Code / Claude chat deployment realities. Scenario: 24 NZ public APIs, personal use, research-oriented (read-heavy) workloads.

---

## 1. The core architecture question: 1 per API, 1 giant, or clustered?

**Short answer: cluster by research domain. Aim for 3–6 servers, each with roughly 5–15 tools, and do not create 24 servers or one monolith.** The reasoning follows from how models actually select tools.

### Why not one giant server (24 APIs, ~50–150 tools)

- Tool selection accuracy degrades measurably as tool count grows. Published testing found ~30 tools is where descriptions start overlapping and confusing models, ~46 tools is a demonstrated failure point on benchmarks for some models, and 100+ tools makes selection failure near-guaranteed without mitigation. Keeping counts under ~30 via curation produced roughly 3x better selection accuracy in one study.
- Every tool definition is (by default) loaded into context before you type anything. A 3-server stack of ~80 tools has been measured at ~20k tokens of overhead. A 24-API monolith exposing even 3–5 tools per API would be 70–120 tools and likely 25–50k tokens before the conversation starts.
- Mitigations exist (Tool Search, code execution — see §6), and they raise the ceiling substantially, but they don't remove the design pressure: a well-scoped server is still better even with those features on.

### Why not 24 one-per-API servers

- 24 separate processes/deployments to configure, run, patch, and toggle. Claude Code and claude.ai both make you manage servers individually; 24 entries is real friction.
- Each server carries protocol overhead (initialization, capability exchange) and its own config entry. On claude.ai you enable/disable connectors per conversation — toggling 24 is unusable.
- Research questions rarely map to a single API. "How has population growth affected crash rates near new subdivisions?" spans a stats API, a transport API, and maybe a geospatial one. If those live in three servers you have to remember to enable all three; if they live in one "NZ demographics & transport" server, the model composes them naturally.
- Per-API servers push you toward 1:1 endpoint-to-tool wrapping, which Anthropic explicitly calls out as an anti-pattern (see §4).

### The clustered middle: group by research use case, not by API

The unit of design should be "a research domain I ask questions about," not "an upstream API." Heuristics from Workato, Anthropic, and community practice:

- **One-sentence test:** if you can't describe the server's purpose in one sentence, it's too broad.
- **Name test:** an LLM should be able to infer when to use the server from its name alone. `nz-geo-mcp` passes; `nz-everything-mcp` fails.
- **Completeness test:** 3–5 of your primary research workflows should each be completable with a single server. If most questions need 3+ servers, your clusters are too narrow.
- **Tool count signal:** 5–8 tools per server is the sweet spot; 8–15 is fine; past ~15, consider splitting.

Example clustering for a typical NZ public-API portfolio (adjust to your actual 24):

| Server | Might wrap | Example tools |
|---|---|---|
| `nz-stats-mcp` | Stats NZ, census/population data, economic indicators | `nz_stats_search_datasets`, `nz_stats_get_series`, `nz_stats_population_by_area` |
| `nz-geo-mcp` | LINZ, Koordinates-hosted layers, addresses, elevation | `nz_geo_search_addresses`, `nz_geo_get_parcel`, `nz_geo_query_layer` |
| `nz-transport-mcp` | NZTA/Waka Kotahi (CAS crash data, traffic counts), AT APIs | `nz_transport_search_crashes`, `nz_transport_get_traffic_counts` |
| `nz-environment-mcp` | Weather/climate, river flows, air quality, GeoNet | `nz_env_get_climate_records`, `nz_env_search_quakes` |
| `nz-govt-mcp` | Legislation, companies register, consents, parliamentary data | `nz_govt_search_companies`, `nz_govt_search_legislation` |

Multiple lightly-used APIs can share one server; a single heavy API (e.g., a big stats or geospatial API) can justify its own. 24 APIs does not mean 24 domains — in practice public-data portfolios collapse into 4–6 themes.

A secondary benefit of clustering: per-conversation control. In claude.ai you toggle connectors per chat; in Claude Code you can enable different servers per project. A crash-analysis project enables `nz-transport-mcp` + `nz-geo-mcp` and nothing else, keeping the active tool count tiny.

---

## 2. Design tools around research tasks, not endpoints (the single highest-leverage decision)

Anthropic's guidance ("Writing effective tools for agents") and every serious practitioner writeup converge on the same point: **do not convert REST endpoints 1:1 into tools.** Agents have different affordances than developers:

- A developer reads docs once and writes a script chaining `GET /users → GET /orders → GET /shipments`. An agent given those three tools must load three definitions, make three round trips, and carry every intermediate payload in context.
- The better tool is `track_order(email)` — orchestration happens in your server code, not in the model's context window.

For your research use case this means tools like:

- `nz_stats_population_trend(area, start_year, end_year)` — internally resolves area codes, fetches the series, returns a compact table — instead of `get_area_codes`, `get_dataset_list`, `get_observations`.
- `nz_transport_crashes_near(lat, lng, radius_m, years, severity?)` — instead of exposing the raw CAS query surface.
- Consolidate list+get pairs where the list is only ever used to feed the get.

Balance this against flexibility: workflow tools are convenient but rigid; comprehensive coverage lets agents compose novel queries. Anthropic's rule of thumb when uncertain is to prioritize coverage, but for *research agents doing repeated known workflows*, a small set of well-designed search/query tools plus one or two "escape hatch" tools (e.g., a raw `nz_geo_query_layer(layer_id, filter, limit)`) is the pattern that works. Prefer **search-shaped tools over list-all tools** in every case (`search_datasets(query)` not `list_all_datasets`).

---

## 3. Tool and server naming

- Server naming: `{domain}_mcp` (Python) or `{domain}-mcp-server` (TypeScript). Descriptive, no version numbers.
- Tool naming: `snake_case`, `{prefix}_{action}_{resource}`, verb-led: `nz_stats_get_series`, `nz_geo_search_addresses`.
- Always prefix, because your servers will run alongside each other and third-party servers. Generic names (`search`, `get_data`) force the model to guess. Note some clients auto-prefix with server name (Claude Code exposes tools as `mcp__servername__toolname`), but don't rely on it.
- Anthropic found namespacing choices have non-trivial, model-dependent effects on tool-selection evals — pick a scheme and verify with your own evals (§9).

---

## 4. Context efficiency inside each tool (where most servers fail)

Agents have limited context; your server's job is to protect it.

**Pagination — mandatory for anything list-shaped:**
- Respect a `limit` parameter; default 20–50 items.
- Return `total_count`, `has_more`, `next_offset`/`next_cursor`.
- Never dump full result sets.

**Response verbosity control:**
- Offer `response_format: "concise" | "detailed"` (default concise). Concise returns the fields a researcher actually needs; detailed includes metadata.
- Convert machine junk to human-meaningful values: names alongside IDs, ISO dates rendered readably, coordinates rounded sensibly.
- For geospatial APIs specifically: never return raw geometry by default. Full GeoJSON polygons for NZ meshblocks or parcels will obliterate a context window. Return centroids/bboxes/summaries; make full geometry opt-in.

**Truncation with guidance:** if a response would be huge, truncate and say so in the payload: "Showing 50 of 4,102 crashes. Narrow with `severity` or `years` parameters."

**Pagination must be stable — always pass an explicit sort:** `limit`/`offset` pagination is only
correct if the upstream call also carries a deterministic sort/orderBy. SQL, Elasticsearch, Solr, and
ArcGIS all make the same promise (or lack of one): without an explicit `ORDER BY`/`sort`, row order for
`LIMIT`/`OFFSET` is *undefined*, not merely "insertion order" or "whatever's fastest." In practice this
silently duplicates rows on one page and drops them from another — confirmed live against `nz-govt-mcp`'s
use of CKAN's `datastore_search` (a Postgres-backed full-text search with no default sort): the exact same
paginated query, re-run with an unchanged `offset`, returned a different slice of rows, and manually
paginating + deduplicating an entire dataset still undercounted the true total by ~10%. The fix costs one
line — pass a stable tiebreak field (an internal id, or `score desc, <field> asc` for a ranked search) —
and belongs in the client function itself, not something every tool author has to remember per call.
Before assuming an upstream is safe, verify rather than guess: some APIs reject a `sort` param outright
(confirmed for the ArcGIS Hub / OGC-API-Records search this collection's `nz-govt-mcp` Auckland open-data
tool hits — `sort` isn't a recognized queryable there), and some already default to a reasonable order
(CKAN's `package_search` defaults to `score desc, metadata_modified desc`) but still benefit from an
explicit tiebreak once you have two datasets that could tie on both. Test the specific upstream before
trusting or fixing it.

**Prefer structured filters over free text for fields with a small, fixed vocabulary:** if an upstream
field only ever takes one of a handful of known values (e.g. a school's funding authority, a charity's
registration status), expose it as a `z.enum([...])` parameter using the upstream's native exact-match
mechanism (SQL `filters`, OData `$filter ... eq`, etc.) rather than folding it into a free-text search
term. Free text is fine for names/titles where partial matches are the point, but folding a categorical
filter into full-text search means the agent can't reliably narrow to "exactly this category" — it's
scoped by relevance ranking, not a boolean AND — and answering a question like "how many state-integrated
schools are in Christchurch" then requires paginating through every record in the surrounding region and
filtering client-side, which is exactly the failure mode above. Confirm the vocabulary is actually
small and fixed against the live upstream (e.g. `SELECT DISTINCT` on the backing field) before hard-coding
an enum — don't guess at the value set from a handful of sample records.

**Structured output:** define `outputSchema` and return `structuredContent` (supported in current SDKs) so clients and code-execution harnesses can process results programmatically.

**Actionable errors:** errors are prompts. Return tool-execution errors (not protocol errors) with a specific fix: `"Unknown area code 'Coatsville'. Did you mean 'Coatesville' (SA2 117300)? Use nz_geo_search_addresses to resolve names."` The 2025-11-25 spec explicitly clarified that input-validation failures should be tool-execution errors so the model can self-correct.

---

## 5. Implementation stack (current recommendations)

- **Language:** TypeScript with the official MCP SDK is Anthropic's recommended default (strong SDK, models generate it well, works everywhere including MCPB bundles). Python + the official SDK/FastMCP is equally legitimate if that's your stack.
- **Schemas:** Zod (TS) or Pydantic (Python) for every input; constraints and examples in field descriptions.
- **Transport:**
  - `stdio` for local, single-user servers (Claude Code, Claude Desktop). Log to stderr only — stdout is the protocol channel.
  - Streamable HTTP for remote servers. **SSE transport is deprecated — do not build new servers on it.** Prefer stateless JSON over stateful sessions; the 2026-07-28 spec RC removes protocol-level sessions entirely, so stateless-by-design is future-proof.
- **Spec version:** current stable is **2025-11-25**. The **2026-07-28 RC** (final publication targeted late July 2026) brings a stateless core, an extensions framework, and deprecates Roots/Sampling/Logging. Practical takeaways for you: build stateless, don't depend on Sampling/Roots, and let the SDK handle version negotiation.
- **Annotations:** set `readOnlyHint: true` on everything (your servers are read-only research tools), `openWorldHint: true` (they hit external APIs), and include a `title` per tool. Clients use these for permission UX.
- **Testing:** MCP Inspector (`npx @modelcontextprotocol/inspector`) for protocol-level testing before wiring into a client.

**Public-API-specific concerns (very relevant to NZ government/CC-licensed data):**
- **API keys:** several NZ "public" APIs still require registration keys (LINZ/Koordinates, NZTA, etc.). Read them from environment variables; never hardcode. In Claude Code configs use `${env:VAR}` interpolation so nothing secret lands in a committed file.
- **Rate limits:** implement client-side throttling and backoff in the server. Agents retry enthusiastically; without server-side restraint you'll burn through quotas. Surface rate-limit errors as actionable messages ("Rate limited by LINZ; retry after 60s").
- **Caching:** public statistical/geospatial data changes slowly. An in-server cache (even a simple TTL on dataset metadata and area-code lookups) makes agent loops dramatically faster and kinder to the upstream API.
- **Attribution:** most NZ open data is CC-BY. Include the source and license in tool responses (a one-line `source` field) so citations flow into research output for free.

---

## 6. Scaling past the tool-count ceiling: Tool Search and code execution

These are the 2025–2026 developments that change the old "keep everything under 30 tools total" advice — they raise the ceiling but don't replace good scoping.

**Tool Search / deferred loading.** Instead of loading every tool definition upfront, the client loads a search tool and discovers tool definitions on demand. On the Claude API this is the Tool Search Tool with `defer_loading: true`; Anthropic measured ~85% token reduction and large accuracy gains on big tool libraries (Opus 4.5: 79.5% → 88.1% on MCP evals). Claude Code has this built in (since v2.1.7): MCP tools are dynamically loaded once they'd exceed ~10% of the context window. Consequence for you: with 4–6 well-named servers, Claude Code will handle the aggregate tool count gracefully — but discovery quality depends entirely on your tool names and descriptions, which is another argument for the naming discipline in §3.

**Code execution with MCP / Programmatic Tool Calling.** Anthropic's recommended pattern for heavy data workflows: the agent writes code that calls tools inside an execution environment, so intermediate results (a 5,000-row crash extract, a big GeoJSON) never transit the model's context — only the final filtered/aggregated answer does. Their worked example cut a task from ~150k to ~2k tokens. Claude Code effectively gives you this today (it can write scripts that hit your tools or the APIs directly); the API offers Programmatic Tool Calling. Design consequence: return `structuredContent` and machine-parseable JSON so code can consume your tools, not just the model.

**Honest alternative worth naming:** for Claude Code specifically, some practitioners (e.g., Simon Willison) skip MCP for research-style work and give Claude a CLI or a small client library per API, letting it write scripts. That's maximally token-efficient and zero-config, but you lose claude.ai/mobile access, per-conversation toggling, and the standardized interface. Given you want these in Claude chat as well, MCP is the right call — but nothing stops `nz-transport-mcp` from being a thin wrapper over the same internal library you also expose as a CLI.

---

## 7. Using the servers: what actually works in each Claude surface

This constraint should influence your architecture as much as tool-count research does.

**Claude Code (local, stdio — the easy path):**
- `claude mcp add nz-stats -- node /path/to/nz-stats-mcp/dist/index.js` (or `npx`/`uv` equivalents).
- Three scopes: `local` (default; just you, just this project, stored in `~/.claude.json`), `project` (`.mcp.json` in repo root, committed, approval-prompted), `user` (all your projects). For personal research servers, **user scope** is the natural home; use project scope in a dedicated "nz-research" repo if you want the config versioned.
- Config changes require a restart or `/mcp` reconnect. `claude mcp list` to verify.
- Tool Search (above) handles the context cost automatically.
- You can also constrain which servers/tools a given subagent sees — useful if you build research subagents per domain.

**claude.ai / Claude mobile (custom connectors — the constrained path):**
- Custom connectors require a **remote MCP server reachable from the public internet**; Claude connects from Anthropic's cloud, not your machine. `localhost` will never work, and this applies even in Claude Desktop's connector UI.
- Auth options: none (public server — risky, anyone with the URL can use it and your upstream API keys), OAuth, or the newer request-header auth (e.g., an `x-api-key` header, in beta). This collection supports both of the latter two at once on the same server: a static shared bearer token (the pragmatic choice for Claude Code, which connects server-to-server and can't complete an interactive login) and OAuth 2.1 + PKCE via `@cloudflare/workers-oauth-provider`, gated by Cloudflare Access, for claude.ai's custom-connector flow (which expects an interactive login) — see `docs/SETUP.md` §8. Use the bearer token alone if you only ever connect from Claude Code; add OAuth once you also want the server as a claude.ai/mobile connector.
- Practical hosting for your case: your Synology (Docker container + reverse proxy + a header token) or any small cloud host (Cloudflare Workers, Fly.io, Cloud Run). Streamable HTTP, stateless.
- Connectors are toggled per conversation via the "+" menu — another reason 4–6 servers beats 24.
- Plan limits apply to how many custom connectors you can add (free tier: one; paid tiers: multiple).

**Claude Desktop (local option for chat-like use):**
- Local stdio servers via `claude_desktop_config.json`, or package each server as an **MCPB desktop extension** (a `.mcpb` bundle: server + manifest, one-click install, no Node/Python setup). MCPB is the nicest local path if you want chat-style research on your Mac without hosting anything.
- Note: Advanced Research mode cannot invoke local MCP tools; deep-research runs need remote connectors.

**Suggested rollout:** build as stdio-first TypeScript servers → use daily in Claude Code (user scope) → when a server proves valuable in chat workflows, add a streamable-HTTP entrypoint and host it (NAS or Workers) as a custom connector. The official SDKs let one codebase serve both transports.

---

## 8. Skills as a complement (not a competitor)

MCP gives Claude *capabilities*; Skills teach Claude *procedures*. For research workflows, pair your servers with a skill (Claude Code `SKILL.md` or a claude.ai project instruction) that encodes NZ-specific craft: which server answers which kind of question, quirks of the data (e.g., CAS crash data caveats, census SA1/SA2 geographies, meshblock changes between censuses), preferred citation format, and known multi-server workflows ("for spatial crash analysis: resolve locality with nz_geo, then query nz_transport, then normalize by population from nz_stats"). This is cheap, lives in files, and improves results more than any additional tool would.

---

## 9. Evaluate before you polish

Anthropic's strongest process recommendation: build a quick prototype, then create ~10 realistic evaluation questions per server and measure whether an agent can answer them, before investing in refinement. Good eval questions are independent, read-only, multi-tool, realistic, and verifiable with a stable answer ("How many fatal crashes occurred on SH16 between Waimauku and Brigham Creek in 2020–2023?"). Run them, read the transcripts (with thinking on) to see *why* the agent picked wrong tools or flailed, then fix descriptions/consolidate tools and re-run. Agents themselves are good at analyzing their own failed transcripts and proposing description rewrites — use Claude Code for this loop.

---

## 10. Decision checklist

1. Map your 24 APIs into 3–6 research domains; kill or merge APIs you won't actually query.
2. One server per domain, 5–15 tools each, all read-only, all prefixed (`nz_{domain}_verb_noun`).
3. Design tools around research questions (search-shaped, workflow-consolidated), not endpoints; keep one raw-query escape hatch per server where the API warrants it.
4. Every list tool paginates; every response defaults concise; geometry and bulk data are opt-in; errors teach.
5. TypeScript + official SDK, Zod schemas, `outputSchema`/`structuredContent`, stateless design, stdio + streamable-HTTP entrypoints, env-var keys, TTL caching, rate-limit backoff, license attribution in responses.
6. Wire into Claude Code at user scope first; rely on built-in Tool Search; add remote hosting + header auth for claude.ai connectors only for the servers that earn it.
7. Add a skill/instructions file encoding NZ data craft and cross-server workflows.
8. Write 10 eval questions per server; iterate on descriptions until the agent passes; re-test after model or spec updates.

---

## Sources consulted

- Anthropic Engineering: "Writing effective tools for agents" (anthropic.com/engineering/writing-tools-for-agents)
- Anthropic Engineering: "Code execution with MCP" (anthropic.com/engineering/code-execution-with-mcp)
- Anthropic Engineering: "Introducing advanced tool use" — Tool Search Tool, Programmatic Tool Calling (anthropic.com/engineering/advanced-tool-use)
- Anthropic: "Building effective agents" (anthropic.com/research/building-effective-agents)
- MCP specification 2025-11-25 changelog and 2026-07-28 release-candidate announcement (modelcontextprotocol.io, blog.modelcontextprotocol.io)
- Anthropic mcp-builder skill reference (naming, pagination, transports, annotations, evaluation methodology)
- Claude Code MCP documentation (code.claude.com/docs/en/mcp) — scopes, transports, output limits, Tool Search behavior
- Claude Help Center / docs — custom connectors via remote MCP, network requirements, request-header auth, MCPB desktop extensions
- Speakeasy, "Why less is more for MCP" — tool-count experiments (30/46/100+ thresholds)
- Workato MCP server design docs — scope tests and tool-count signals
- Phil Schmid, "MCP is Not the Problem, It's Your Server"; Itential; getknit.dev — multi-server and curation practice
- Simon Willison and Daniel Miessler commentary on code execution vs direct MCP tool calls
