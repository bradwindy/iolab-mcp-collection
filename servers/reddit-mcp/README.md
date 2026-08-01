# reddit-mcp

Read-only Reddit retrieval, so a discussion thread can be pulled into a Claude conversation as
reference material with its structure intact — who said what, in reply to what, and how the
community scored it.

Served at `/reddit/mcp` on the shared gateway. Five tools. Deliberately scoped to **search, browse,
and read**: there is no user-profile lookup, no comment history, no voting, no posting, no
messaging, and no moderation.

## Tools

| Tool | What it does |
|---|---|
| `reddit_search_posts` | Search posts across Reddit or within one subreddit. Supports Reddit's advanced query syntax (`subreddit:`, `author:`, `title:`, `selftext:`, `flair:`, `self:`, `site:`). Returns metadata plus a short body snippet, and the `t3_` id to open each hit with. |
| `reddit_get_post` | Read one post and its comment thread, rendered as an indented markdown tree. Accepts a URL, permalink, `t3_` fullname, or bare id. Anything truncated comes back as an expandable cursor. |
| `reddit_get_more_comments` | Expand a cursor from `reddit_get_post` — fetches the hidden comments and re-threads them into the tree. |
| `reddit_list_subreddit_posts` | A subreddit's hot / new / top / rising listing. Supports multireddits (`a+b`) and the `all` / `popular` feeds. |
| `reddit_search_subreddits` | Find communities by topic, or look one up by exact name for more detail. |

Every tool is read-only (`readOnlyHint`, `openWorldHint`), paginated by Reddit's own cursor, and
attributed to Reddit.

## Setup — credentials are required

Unlike every other server in this collection, **nothing here works without credentials.** Verified
live on 2026-08-01:

| Request | Result |
|---|---|
| `GET https://www.reddit.com/r/{sub}/hot.json` (anonymous) | 403 |
| `GET https://www.reddit.com/r/{sub}/comments/{id}.json` (anonymous) | 403 |
| `GET https://www.reddit.com/search.json?q=…` (anonymous) | 403 |
| `GET https://oauth.reddit.com/…` (no token) | 403 |

Reddit's own API wiki states it directly: *"Clients must authenticate with OAuth2."* There is no
anonymous path left to degrade to, so every tool returns a missing-credential error naming the
specific key until all three are set.

**Access must be approved by Reddit before credentials will work.** Reddit's
[Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy)
(updated 5 June 2026) opens with: *"Approval is required: You must request access and get explicit
approval before accessing any Reddit data through our API."* Attempting to create an app without it
returns a policy notice rather than credentials. This is free for non-commercial use, but it is an
application with an unknown turnaround, not a self-service form.

See [`docs/API_KEYS.md`](../../docs/API_KEYS.md#reddit_client_id--reddit_client_secret--reddit_username--reddit-data-api-reddit-mcp)
for the full sequence: request access → create a **script**-type app at
[old.reddit.com/prefs/apps](https://old.reddit.com/prefs/apps) → set `REDDIT_CLIENT_ID`,
`REDDIT_CLIENT_SECRET` and `REDDIT_USERNAME` in the portal at `/admin/servers/reddit-mcp`.

## How it talks to Reddit

- **Auth**: the OAuth 2.0 `client_credentials` grant ("application-only" auth), minted at
  `https://www.reddit.com/api/v1/access_token`. No user login is involved and no refresh token is
  issued, so the hour-long token is re-minted on expiry. It is cached in KV with a five-minute
  safety margin, keyed on a hash of the client id, and a mid-request 401 triggers exactly one
  re-mint before the error is allowed to surface.
- **Host**: every data request goes to `https://oauth.reddit.com`. `www.reddit.com` 403s API
  traffic and is used only for the token mint.
- **User-Agent**: `cloudflare-workers:iolab-reddit-mcp:v0.1.0 (by /u/<username>)`, matching the
  format Reddit's rules mandate. Generic User-Agents are, in Reddit's own words, "drastically
  limited".
- **Rate limit**: 60 requests per minute for OAuth2 clients, app-wide rather than per connection.
  Upstream calls are therefore issued serially, never as a `Promise.all` fan-out, and results are
  cached (60s for live listings and threads, 30min for subreddit metadata and long-window top
  listings).
- **`raw_json=1`** is forced on every request. Without it Reddit HTML-escapes every `&`, `<` and `>`
  in post and comment bodies, which silently corrupts any code block or quote.

## Things worth knowing

**Vote counts do not exist.** Reddit fuzzes `ups` to mirror `score` and pins `downs` to 0 as an
anti-manipulation measure. This server therefore returns only what is real — `score` on posts and
comments, `upvote_ratio` on posts — and never derives a "total votes" figure. That caveat is
repeated in the tool descriptions and in the rendered footer, deliberately, so a model that reads
only one of them still sees it.

**Comment scores are hidden for about an hour** after posting. Those come back as `null` rather than
as `0`, which would read as "downvoted".

**Two kinds of truncation, two different fixes.** A branch cut short by Reddit, by the depth limit,
or by the character budget returns an `expandable` cursor carrying real comment ids — feed those to
`reddit_get_more_comments`. A *"continue this thread"* marker returns a `continue_thread` cursor
with no ids at all; Reddit's expansion endpoint cannot reach those, so the only way in is
`reddit_get_post` with `comment` set to the branch's parent. Conflating the two is how you end up
calling the expansion endpoint with an empty list and concluding a thread has no more comments when
it has hundreds.

**Deleted and removed comments are kept, not dropped.** Their replies usually survive and often
explain what was there, so pruning the parent orphans a whole branch.

**The ~1,000-item ceiling is real.** Reddit stops serving a listing past roughly a thousand items
however far you page, with no workaround. Tools say so rather than appearing to stop for no reason.

**NSFW is excluded by default** from search and listings, with `include_nsfw: true` to opt in.
Filtering is done client-side as well as via Reddit's own parameter, because the parameter's
behaviour for app-only tokens is not something this server can verify and the listing endpoints do
not accept it at all. A post or community you name explicitly is always returned.

## Research notes

Two behaviours are written defensively against Reddit's documentation rather than verified against
a live token, per [`docs/ADDING_A_SERVER.md`](../../docs/ADDING_A_SERVER.md) §2:

- The comment `sort` vocabulary. Reddit documents `confidence|top|new|controversial|old|qa` for the
  comments endpoint; this server exposes `best` as the friendlier name and maps it to `confidence`.
- `include_over_18`'s effect on an app-only token. The client-side filter is the load-bearing half
  and works regardless.

Mobile share links (`/r/{sub}/s/{code}`) are rejected with instructions rather than followed. They
are opaque server-side redirects carrying no post id, and resolving one would need an
unauthenticated request to `www.reddit.com`, which 403s.

## Example questions this can answer

- "What do people on r/newzealand actually think about the new public transport fares?"
- "Find the r/rust thread where someone hit this exact compiler error, and show me the replies."
- "Summarise the top-voted arguments in this thread I'm looking at" — paste the URL straight in.
- "Which subreddits discuss New Zealand tramping, and how big are they?"
- "What was r/askhistorians' most significant thread this year?"
