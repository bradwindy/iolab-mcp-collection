export type Attribution = {
  source: string;
  license?: string;
  url?: string;
};

/** A one-line source/license note, per best-practice guidance for CC-licensed NZ open data. */
export function attribution(source: string, opts: { license?: string; url?: string } = {}): Attribution {
  return {
    source,
    ...(opts.license ? { license: opts.license } : {}),
    ...(opts.url ? { url: opts.url } : {}),
  };
}
