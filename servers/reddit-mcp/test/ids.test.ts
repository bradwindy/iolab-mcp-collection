import { describe, expect, it } from "vitest";
import {
  InvalidSubredditError,
  normaliseCommentId,
  normalisePostId,
  normaliseSubreddit,
  UnrecognisedPostReferenceError,
} from "../src/ids.js";

describe("normalisePostId", () => {
  it.each([
    ["bare id", "1abc2de"],
    ["uppercase bare id", "1ABC2DE"],
    ["fullname", "t3_1abc2de"],
    ["uppercase fullname", "T3_1ABC2DE"],
    ["canonical URL", "https://www.reddit.com/r/newzealand/comments/1abc2de/a_post_about_kiwi/"],
    ["old.reddit", "https://old.reddit.com/r/newzealand/comments/1abc2de/a_post_about_kiwi/"],
    ["np.reddit", "https://np.reddit.com/r/newzealand/comments/1abc2de/slug/"],
    ["no scheme", "reddit.com/r/newzealand/comments/1abc2de/slug/"],
    ["bare permalink", "/r/newzealand/comments/1abc2de/a_post_about_kiwi/"],
    ["no subreddit", "https://www.reddit.com/comments/1abc2de"],
    ["profile post", "https://www.reddit.com/user/someone/comments/1abc2de/slug/"],
    ["short link", "https://redd.it/1abc2de"],
    ["share query string", "https://www.reddit.com/r/nz/comments/1abc2de/slug/?utm_source=share&utm_medium=web2x"],
    ["fragment", "https://www.reddit.com/r/nz/comments/1abc2de/slug/#heading"],
    ["percent-encoded slug", "https://www.reddit.com/r/nz/comments/1abc2de/some%20title/"],
    ["trailing whitespace", "  1abc2de  "],
  ])("resolves the %s form", (_label, input) => {
    expect(normalisePostId(input).postId).toBe("1abc2de");
  });

  it("returns the t3_ fullname alongside the bare id, since morechildren needs the prefixed form", () => {
    expect(normalisePostId("1abc2de")).toEqual({ postId: "1abc2de", fullname: "t3_1abc2de", commentId: null });
  });

  it("picks up a focused comment id from a comment permalink", () => {
    const ref = normalisePostId("https://www.reddit.com/r/nz/comments/1abc2de/a_slug/h9k2j1a/");
    expect(ref.postId).toBe("1abc2de");
    expect(ref.commentId).toBe("h9k2j1a");
  });

  it("rejects a comment fullname with a message that says what to pass instead", () => {
    expect(() => normalisePostId("t1_h9k2j1a")).toThrow(UnrecognisedPostReferenceError);
    try {
      normalisePostId("t1_h9k2j1a");
    } catch (error) {
      expect((error as UnrecognisedPostReferenceError).hint).toContain("comment fullname");
    }
  });

  it("rejects a mobile share link explicitly rather than failing to parse it", () => {
    try {
      normalisePostId("https://www.reddit.com/r/newzealand/s/AbCdEf1234");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UnrecognisedPostReferenceError);
      expect((error as UnrecognisedPostReferenceError).hint).toContain("share link");
    }
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["non-reddit host", "https://example.com/r/nz/comments/1abc2de/slug/"],
    // The host check is anchored, so a suffix-spoofing domain must not be accepted.
    ["host-suffix spoof", "https://reddit.com.evil.test/r/nz/comments/1abc2de/slug/"],
    ["too short", "12"],
    ["a subreddit URL with no post", "https://www.reddit.com/r/newzealand/"],
  ])("rejects the %s case", (_label, input) => {
    expect(() => normalisePostId(input)).toThrow(UnrecognisedPostReferenceError);
  });
});

describe("normaliseSubreddit", () => {
  it.each([
    ["bare", "newzealand"],
    ["r/ prefix", "r/newzealand"],
    ["leading slash", "/r/newzealand"],
    ["full URL", "https://www.reddit.com/r/newzealand/"],
    ["old.reddit URL", "https://old.reddit.com/r/newzealand/hot"],
  ])("resolves the %s form", (_label, input) => {
    expect(normaliseSubreddit(input)).toBe("newzealand");
  });

  it("passes multireddit syntax through, since it is a legal listing target", () => {
    expect(normaliseSubreddit("askhistorians+history")).toBe("askhistorians+history");
  });

  it("passes the special feeds through", () => {
    expect(normaliseSubreddit("all")).toBe("all");
    expect(normaliseSubreddit("popular")).toBe("popular");
  });

  it("accepts a u_ profile subreddit", () => {
    expect(normaliseSubreddit("u_someone")).toBe("u_someone");
  });

  it.each([["empty", ""], ["a space", "new zealand"], ["punctuation", "new-zealand!"], ["too short", "a"]])(
    "rejects %s",
    (_label, input) => {
      expect(() => normaliseSubreddit(input)).toThrow(InvalidSubredditError);
    },
  );
});

describe("normaliseCommentId", () => {
  it("accepts both the bare and fullname forms", () => {
    expect(normaliseCommentId("h9k2j1a")).toBe("h9k2j1a");
    expect(normaliseCommentId("t1_h9k2j1a")).toBe("h9k2j1a");
    expect(normaliseCommentId("T1_H9K2J1A")).toBe("h9k2j1a");
  });

  it("rejects anything else", () => {
    expect(() => normaliseCommentId("https://example.com")).toThrow(UnrecognisedPostReferenceError);
  });
});
