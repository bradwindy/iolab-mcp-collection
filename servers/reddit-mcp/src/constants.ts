/** The credentials-table partition key — must exactly match apps/portal/src/manifest.ts's `slug`. */
export const SERVER_SLUG = "reddit-mcp";

/** OAuth client id of the operator's Reddit "script" app (old.reddit.com/prefs/apps). */
export const REDDIT_CLIENT_ID = "REDDIT_CLIENT_ID";
/** OAuth client secret of the same app. */
export const REDDIT_CLIENT_SECRET = "REDDIT_CLIENT_SECRET";
/**
 * The operator's Reddit username. Not used to authenticate — the app-only `client_credentials`
 * grant never touches an account — but required by Reddit's User-Agent rules, which mandate
 * `<platform>:<app id>:<version> (by /u/<username>)`. It lives in the credential store rather than
 * in source because this repo treats operator identity as a secret (see BASE_DOMAIN, ACCESS_EMAIL).
 */
export const REDDIT_USERNAME = "REDDIT_USERNAME";

/** Where the OAuth access token is minted. Note: www, not oauth — the one call that is not on the API host. */
export const REDDIT_TOKEN_URL = "https://www.reddit.com/api/v1/access_token";

/** Every data request goes here. www.reddit.com returns 403 for API traffic. */
export const REDDIT_API_BASE = "https://oauth.reddit.com";

/** Human-facing base, used only to build permalinks in output. */
export const REDDIT_WEB_BASE = "https://www.reddit.com";

/** Named in UpstreamHttpError so tool errors say which upstream failed. */
export const UPSTREAM_NAME = "Reddit API";

/**
 * Reddit caps a Listing at 100 items per request and refuses to page beyond roughly 1,000 items
 * in total — a hard architectural limit with no workaround, so tools surface it rather than
 * appearing to stop for no reason.
 */
export const MAX_LISTING_LIMIT = 100;
export const LISTING_CEILING = 1000;

/** `/api/morechildren` accepts at most this many comment ids per call. */
export const MORECHILDREN_BATCH_SIZE = 100;
