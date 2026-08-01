import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { READ_ONLY_OPEN_WORLD_ANNOTATIONS, type OAuthProps } from "@iolab/mcp-kit";
import { searchPostsHandler, searchPostsInputShape, searchPostsOutputShape } from "./tools/searchPosts.js";
import { getPostHandler, getPostInputShape, getPostOutputShape } from "./tools/getPost.js";
import { getMoreCommentsHandler, getMoreCommentsInputShape, getMoreCommentsOutputShape } from "./tools/getMoreComments.js";
import { listSubredditPostsHandler, listSubredditPostsInputShape, listSubredditPostsOutputShape } from "./tools/listSubredditPosts.js";
import { searchSubredditsHandler, searchSubredditsInputShape, searchSubredditsOutputShape } from "./tools/searchSubreddits.js";

export class RedditMcp extends McpAgent<Env, Record<string, never>, OAuthProps> {
  server = new McpServer({ name: "reddit-mcp", version: "0.1.0" });

  async init() {
    this.server.registerTool(
      "reddit_search_posts",
      {
        description:
          "Search Reddit for posts, across all of Reddit or within one subreddit — this is how you find what people " +
          "actually said about a product, an error message, a company, or an event, in their own words. Returns each " +
          "hit's title, community, score, comment count, and a snippet of its text, together with the `t3_` id you " +
          "pass to reddit_get_post to read the full discussion. Beyond plain terms, `query` accepts Reddit's advanced " +
          "syntax (`subreddit:`, `author:`, `title:`, `selftext:`, `flair:`, `self:yes`, `site:`) combined with " +
          "AND/OR/NOT. Reddit reports only a net `score` per post plus an `upvote_ratio`; raw upvote and downvote " +
          "counts are deliberately fuzzed and are not available from any endpoint, so never infer or state them. " +
          "Over-18 results are excluded unless `include_nsfw` is set. Results are cursor-paginated with no total " +
          "available, and Reddit stops serving results past roughly 1,000 items however far you page — narrow with " +
          "`subreddit` or `time` rather than paging deep.",
        inputSchema: searchPostsInputShape,
        outputSchema: searchPostsOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Search Reddit Posts" },
      },
      (rawInput) => searchPostsHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "reddit_get_post",
      {
        description:
          "Read one Reddit post and its comment thread: the post's own text plus a threaded, indented view of the " +
          "discussion, with each comment's author, score, and age. This is the tool for 'what did people actually say " +
          "about X' once reddit_search_posts or reddit_list_subreddit_posts has given you a post. `post` accepts a " +
          "full reddit.com URL, a permalink, a `t3_` fullname, or a bare post id, so a URL pasted from a browser works " +
          "directly. By default it returns up to 50 top-level comments to a depth of 3 within a character budget; " +
          "anything cut off — by depth, by the budget, or by Reddit itself — comes back as an explicit cursor you can " +
          "expand with reddit_get_more_comments, so nothing is dropped silently. Deleted and moderator-removed " +
          "comments are kept in place as placeholders, because their replies usually survive and often explain what " +
          "was there. Reddit reports only a net `score` per comment and an `upvote_ratio` on the post; raw upvote and " +
          "downvote counts are fuzzed and unobtainable, so never infer or state them. Scores on comments less than " +
          "about an hour old are hidden by Reddit and come back as null.",
        inputSchema: getPostInputShape,
        outputSchema: getPostOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Read Reddit Post and Comments" },
      },
      (rawInput) => getPostHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "reddit_get_more_comments",
      {
        description:
          "Expand a collapsed branch of a Reddit comment thread. reddit_get_post returns cursors wherever the thread " +
          "was cut off — by Reddit itself ('load more comments'), by the depth limit, or by the character budget — " +
          "and this tool fetches those comments and re-threads them into a readable tree. Pass the `post` and the " +
          "`children` id list from one `more_cursors` entry, keeping `sort` the same as the call that produced it. " +
          "Reddit's expansion endpoint returns a flat list rather than a tree and accepts at most 100 ids per " +
          "request; both are handled here. One cursor kind cannot be expanded by this tool: a `continue_thread` " +
          "cursor carries no ids at all — reach that branch with reddit_get_post instead, passing its " +
          "`parent_comment_id` as `comment`.",
        inputSchema: getMoreCommentsInputShape,
        outputSchema: getMoreCommentsOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Expand Reddit Comments" },
      },
      (rawInput) => getMoreCommentsHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "reddit_list_subreddit_posts",
      {
        description:
          "List the posts currently on a subreddit's front page — hot, new, top, or rising. Use this to survey what a " +
          "community is discussing right now, or with `sort: 'top'` and `time: 'year'` to find its most significant " +
          "threads. Each row carries the `t3_` id you pass to reddit_get_post to read the discussion. `subreddit` also " +
          "accepts multireddit syntax ('askhistorians+history') and the special feeds 'all' and 'popular'. " +
          "Cursor-paginated with no total available; Reddit stops serving a listing past roughly 1,000 items. Over-18 " +
          "posts are filtered out unless `include_nsfw` is set, which can make a page return fewer rows than `limit`. " +
          "If you are unsure of the exact subreddit name, find it with reddit_search_subreddits first. As everywhere " +
          "on Reddit, only a net `score` is real — upvote and downvote counts are fuzzed and unavailable.",
        inputSchema: listSubredditPostsInputShape,
        outputSchema: listSubredditPostsOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "List Subreddit Posts" },
      },
      (rawInput) => listSubredditPostsHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "reddit_search_subreddits",
      {
        description:
          "Find Reddit communities by topic, or look one up by exact name. Search mode (`query`) returns matching " +
          "subreddits with subscriber counts, one-line descriptions, and whether each is public, restricted, or " +
          "private — which is how you decide where to search or whose opinion you actually want. Lookup mode " +
          "(`subreddit`) returns one community in more detail, including its current online count and creation date. " +
          "Use this before reddit_list_subreddit_posts or reddit_search_posts when you are not certain a community " +
          "exists or is named what you think. Supply exactly one of `query` or `subreddit`. Over-18 communities are " +
          "excluded from search unless `include_nsfw` is set; a community you name explicitly is always returned.",
        inputSchema: searchSubredditsInputShape,
        outputSchema: searchSubredditsOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Search Subreddits" },
      },
      (rawInput) => searchSubredditsHandler(rawInput, this.env),
    );
  }
}
