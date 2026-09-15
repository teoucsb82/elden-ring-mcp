export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string) {
    super(`HTTP ${status} for ${url}`);
  }
}

export interface HttpOptions {
  userAgent: string;
  minIntervalMs?: number;
  retries?: number;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

/** GET-as-text with a per-client minimum interval and retries for 429, 5xx and network errors. */
export function createHttp(opts: HttpOptions): (url: string) => Promise<string> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const minInterval = opts.minIntervalMs ?? 1000;
  const retries = opts.retries ?? 3;
  let lastRequest = 0;

  return async function getText(url: string): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      const wait = lastRequest + minInterval - Date.now();
      if (wait > 0) await sleep(wait);
      lastRequest = Date.now();
      let res;
      try {
        res = await fetchImpl(url, { headers: { 'User-Agent': opts.userAgent } });
      } catch (error) {
        if (attempt >= retries) throw error;
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.status === 200) return res.text();
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= retries) throw new HttpError(res.status, url);
      const retryAfterHeader = res.headers.get('retry-after');
      const retryAfterSeconds = Number(retryAfterHeader);
      let retryDelay: number;
      if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
        retryDelay = retryAfterSeconds * 1000;
      } else {
        const retryAfterDate = retryAfterHeader ? Date.parse(retryAfterHeader) : NaN;
        if (Number.isFinite(retryAfterDate)) {
          retryDelay = Math.min(60_000, Math.max(0, retryAfterDate - Date.now()));
        } else {
          retryDelay = 1000 * 2 ** attempt;
        }
      }
      await sleep(retryDelay);
    }
  };
}
