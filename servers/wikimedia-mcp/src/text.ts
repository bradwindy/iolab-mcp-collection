/**
 * Diacritic handling for CirrusSearch queries.
 *
 * Read this before adding folding anywhere else: CirrusSearch already folds diacritics on the
 * fields that matter, and folding the wrong thing loses recall rather than gaining it.
 *
 * From the live `action=cirrus-schema-dump` on en.wikipedia.org, the `text` and `text_search`
 * analyzers both end in `icu_folding`, so free-text search is already symmetric — `Ōpepe` and
 * `Opepe` produce the identical token and return the identical 20 hits. Folding a free-text query
 * client-side gains nothing and actively *costs* ranking signal (with the macron the NZ article
 * ranks #2, without it #4).
 *
 * The `plain` field is the exception, and it is what quoted phrases and `insource:` search. Its
 * index side folds *and* keeps the original (`preserve_original`), but `plain_search` has no
 * `icu_folding` at all — so a macronised phrase only ever matches the preserved original. Confirmed
 * live:
 *
 *   intitle:"Ōpepe"   ->  0 hits          insource:"Ōpepe"  ->  4 hits
 *   intitle:"Opepe"   ->  2 hits          insource:"Opepe"  -> 20 hits
 *
 * A folded phrase is therefore a strict superset of the unfolded one, which is why folding is
 * applied to `in_title` and `in_source` (both of which this server quotes) and to nothing else.
 */

/**
 * Strip combining marks, but only when that leaves nothing behind.
 *
 * `\p{M}` rather than `\p{Diacritic}`: the former is exactly "combining mark", while the latter also
 * covers spacing modifier letters that are not what we mean here.
 *
 * The all-or-nothing rule is the load-bearing part. Characters like ø, ß, ł, đ, æ have **no
 * canonical decomposition** — `"ø".normalize("NFD")` is still the single code point U+00F8 — so a
 * naive fold turns `Łódź` into `Łodz`, a string that matches neither the preserved original
 * (`łódź`) nor the folded index token (`lodz`). Partial folding is worse than none. Every macron in
 * te reo Māori (ā ē ī ō ū) does decompose, so the intended case always folds completely.
 */
export function foldDiacritics(value: string): string {
  const folded = value.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC");
  return hasNonAsciiLetter(folded) ? value : folded;
}

/** True when folding would change the string — i.e. it carries at least one decomposable diacritic. */
export function hasFoldableDiacritic(value: string): boolean {
  return value.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC") !== value;
}

/**
 * A letter outside Basic Latin surviving a fold means the fold was only partial.
 *
 * Deliberately letters only: CJK, Cyrillic and Greek text is not something ASCII folding can or
 * should flatten, and a query in those scripts is left exactly as the caller wrote it.
 */
function hasNonAsciiLetter(value: string): boolean {
  return /[^\p{ASCII}]/u.test(value) && /\p{L}/u.test(value.replace(/\p{ASCII}/gu, ""));
}
