import { describe, expect, it } from "vitest";
import { filterCollections } from "../src/clients/archiveOrg.js";

describe("filterCollections", () => {
  it("drops fav-* entries from an array but keeps real collections", () => {
    expect(filterCollections(["movies", "fav-alice", "fav-bob", "nasa"])).toEqual(["movies", "nasa"]);
  });

  it("drops a scalar fav-* value entirely, not just array entries", () => {
    expect(filterCollections("fav-alice")).toBeUndefined();
  });

  it("keeps a scalar non-fav collection unchanged", () => {
    expect(filterCollections("nasa")).toBe("nasa");
  });

  it("passes undefined through unchanged", () => {
    expect(filterCollections(undefined)).toBeUndefined();
  });

  it("caps a long list of real collections", () => {
    const many = Array.from({ length: 30 }, (_, i) => `collection${i}`);
    expect(filterCollections(many)).toHaveLength(20);
  });
});
