/** Filter a known, fixed list of year codes (e.g. irregular census years) to a [start, end] range. */
export function filterKnownYears(available: string[], startYear?: number, endYear?: number): string[] {
  return available.filter((code) => {
    const year = Number(code);
    if (startYear !== undefined && year < startYear) return false;
    if (endYear !== undefined && year > endYear) return false;
    return true;
  });
}

/** Generate consecutive annual year codes within [min, max], narrowed by an optional [startYear, endYear]. */
export function consecutiveYearRange(min: number, max: number, startYear?: number, endYear?: number): string[] {
  const from = Math.max(min, startYear ?? min);
  const to = Math.min(max, endYear ?? max);
  const years: string[] = [];
  for (let year = from; year <= to; year++) years.push(String(year));
  return years;
}
