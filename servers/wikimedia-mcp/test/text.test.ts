import { describe, expect, it } from "vitest";
import { foldDiacritics, hasFoldableDiacritic } from "../src/text.js";

describe("foldDiacritics", () => {
  it("folds the te reo Maori macron set, which is the case this exists for", () => {
    expect(foldDiacritics("Ōpepe")).toBe("Opepe");
    expect(foldDiacritics("Taupō")).toBe("Taupo");
    expect(foldDiacritics("Ngāti Tūwharetoa")).toBe("Ngati Tuwharetoa");
    expect(foldDiacritics("Māori")).toBe("Maori");
  });

  it("normalises the decomposed form identically to the precomposed one", () => {
    // MediaWiki stores titles as NFC, but a caller can easily pass NFD from a copy-paste.
    expect(foldDiacritics("Ōpepe")).toBe("Opepe");
    expect(foldDiacritics("Ōpepe".normalize("NFD"))).toBe("Opepe");
  });

  it("leaves a string alone rather than folding it only partially", () => {
    // These code points have no canonical decomposition, so there is no combining mark to strip:
    // "ø".normalize("NFD") is still the single code point U+00F8. Folding "Łódź" to "Łodz" would
    // produce a string matching neither the preserved original nor the folded index token, which is
    // strictly worse than leaving it be.
    expect(foldDiacritics("Łódź")).toBe("Łódź");
    expect(foldDiacritics("Bjørn")).toBe("Bjørn");
    expect(foldDiacritics("straße")).toBe("straße");
    expect(foldDiacritics("Đà Nẵng")).toBe("Đà Nẵng");
  });

  it("leaves non-Latin scripts untouched", () => {
    expect(foldDiacritics("東京")).toBe("東京");
    expect(foldDiacritics("Ελλάδα")).toBe("Ελλάδα");
  });

  it("passes plain ASCII through unchanged", () => {
    expect(foldDiacritics("Opepe, New Zealand")).toBe("Opepe, New Zealand");
    expect(foldDiacritics("")).toBe("");
  });
});

describe("hasFoldableDiacritic", () => {
  it("detects a macron in either normalisation form", () => {
    expect(hasFoldableDiacritic("Ōpepe Taupō")).toBe(true);
    expect(hasFoldableDiacritic("Ōpepe")).toBe(true);
  });

  it("is false for ASCII and for characters that cannot decompose", () => {
    expect(hasFoldableDiacritic("Opepe ambush 1869 Taupo")).toBe(false);
    expect(hasFoldableDiacritic("Bjørn")).toBe(false);
  });
});
