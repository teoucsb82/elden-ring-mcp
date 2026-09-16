import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttp, HttpError, type FetchLike } from '../src/sources/http.js';
import { createFandom } from '../src/sources/fandom.js';

const response = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  status,
  headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
const noSleep = async () => {};

test('http retries 429 honoring Retry-After, then succeeds', async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const fetchImpl: FetchLike = async () => (++calls === 1 ? response(429, '', { 'retry-after': '2' }) : response(200, 'ok'));
  const get = createHttp({ userAgent: 'ua', minIntervalMs: 0, fetchImpl, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(await get('https://x'), 'ok');
  assert.equal(calls, 2);
  assert.ok(sleeps.includes(2000));
});

test('http gives up after retries and does not retry 404', async () => {
  const get500 = createHttp({ userAgent: 'ua', minIntervalMs: 0, retries: 2, sleep: noSleep, fetchImpl: async () => response(503, '') });
  await assert.rejects(get500('https://x'), HttpError);
  let calls = 0;
  const get404 = createHttp({ userAgent: 'ua', minIntervalMs: 0, sleep: noSleep, fetchImpl: async () => { calls++; return response(404, ''); } });
  await assert.rejects(get404('https://x'), HttpError);
  assert.equal(calls, 1);
});

// The minimum interval is a promise to the wiki, so it has to hold for calls that overlap: two
// requests started before either finishes must not both read the same "last request" timestamp.
test('http reserves its slot before awaiting, so concurrent calls still space out', async () => {
  const sleeps: number[] = [];
  const get = createHttp({
    userAgent: 'ua', minIntervalMs: 1000,
    fetchImpl: async () => response(200, 'ok'),
    sleep: async (ms) => { sleeps.push(ms); },
  });
  await Promise.all([get('https://x/1'), get('https://x/2'), get('https://x/3')]);
  assert.equal(sleeps.length, 2, `expected the 2nd and 3rd calls to wait, got sleeps ${sleeps.join(',')}`);
  assert.ok(sleeps[0] >= 900 && sleeps[0] <= 1000, `first wait ${sleeps[0]}`);
  assert.ok(sleeps[1] >= 1900 && sleeps[1] <= 2000, `second wait ${sleeps[1]}`);
});

test('http retries thrown network errors', async () => {
  let calls = 0;
  const get = createHttp({ userAgent: 'ua', minIntervalMs: 0, sleep: noSleep, fetchImpl: async () => { if (++calls < 3) throw new Error('ECONNRESET'); return response(200, 'ok'); } });
  assert.equal(await get('https://x'), 'ok');
});

test('listRevisions follows continuation', async () => {
  const fetchImpl: FetchLike = async (url) => {
    const params = new URL(url).searchParams;
    if (!params.get('gapcontinue')) return response(200, { continue: { gapcontinue: 'B', continue: 'gapcontinue||' }, query: { pages: [{ title: 'A', lastrevid: 1 }] } });
    return response(200, { query: { pages: [{ title: 'B', lastrevid: 2 }] } });
  };
  const fandom = createFandom({ fetchImpl, sleep: noSleep, minIntervalMs: 0 });
  const seen = [];
  for await (const row of fandom.listRevisions()) seen.push(row);
  assert.deepEqual(seen, [{ title: 'A', revid: 1 }, { title: 'B', revid: 2 }]);
});

test('fetchPages batches by 50 and builds RawPage with provenance', async () => {
  const batches: number[] = [];
  const fetchImpl: FetchLike = async (url) => {
    const titles = new URL(url).searchParams.get('titles')!.split('|');
    batches.push(titles.length);
    return response(200, { query: { pages: titles.map((title) => (title === 'Gone' ? { title, missing: true } : { title, revisions: [{ revid: 7, slots: { main: { content: `text of ${title}` } } }] })) } });
  };
  const fandom = createFandom({ fetchImpl, sleep: noSleep, minIntervalMs: 0, now: () => new Date('2026-09-15T00:00:00Z') });
  const titles = [...Array.from({ length: 60 }, (_, i) => `P${i}`), 'Gone'];
  const pages = await fandom.fetchPages(titles);
  assert.deepEqual(batches, [50, 11]);
  assert.equal(pages.length, 60);
  assert.deepEqual(pages[0], { source: 'fandom', title: 'P0', url: 'https://eldenring.fandom.com/wiki/P0', revid: 7, fetchedAt: '2026-09-15T00:00:00.000Z', wikitext: 'text of P0', markdown: null, license: 'CC BY-SA 3.0 (eldenring.fandom.com)' });
});

// The live API rejects "redirects" alongside generator=allpages, so this mock refuses it the way
// MediaWiki does: enumerate the redirect titles first, then resolve them in a titles= batch.
const redirectApi = (targets: Record<string, { to: string; tofragment?: string }>, pageSize = 2): FetchLike => async (url) => {
  const params = new URL(url).searchParams;
  if (params.get('generator') === 'allpages' && params.get('redirects')) {
    return response(200, { error: { code: 'params', info: 'Use "gapfilterredir=nonredirects" instead of "redirects" when using "allpages" as a generator.' } });
  }
  const titles = Object.keys(targets);
  if (params.get('generator') === 'allpages') {
    assert.equal(params.get('gapfilterredir'), 'redirects');
    const from = params.get('gapcontinue') ? titles.indexOf(params.get('gapcontinue')!) : 0;
    const slice = titles.slice(from, from + pageSize);
    const next = titles[from + pageSize];
    return response(200, {
      query: { pages: slice.map((title) => ({ title })) },
      ...(next ? { continue: { gapcontinue: next, continue: 'gapcontinue||' } } : {}),
    });
  }
  assert.equal(params.get('redirects'), '1');
  const asked = params.get('titles')!.split('|');
  return response(200, { query: { redirects: asked.map((from) => ({ from, ...targets[from] })) } });
};

test('listRedirects enumerates redirect titles, then resolves them to from/to/fragment', async () => {
  const fandom = createFandom({
    fetchImpl: redirectApi({
      'Magma Wyrm Makar': { to: 'Magma Wyrm', tofragment: 'Bosses' },
      'Comet Azur': { to: "Azur's Glintstone Staff" },
      Sellen: { to: 'Sorceress Sellen' },
    }),
    sleep: noSleep,
    minIntervalMs: 0,
  });
  const rows = [];
  for await (const row of fandom.listRedirects()) rows.push(row);
  assert.deepEqual(rows, [
    { from: 'Magma Wyrm Makar', to: 'Magma Wyrm', fragment: 'Bosses' },
    { from: 'Comet Azur', to: "Azur's Glintstone Staff", fragment: null },
    { from: 'Sellen', to: 'Sorceress Sellen', fragment: null },
  ]);
});

test('listRedirects never sends the generator+redirects combination the live API rejects', async () => {
  const urls: string[] = [];
  const api = redirectApi({ Sellen: { to: 'Sorceress Sellen' } });
  const fandom = createFandom({ fetchImpl: async (url, init) => { urls.push(url); return api(url, init); }, sleep: noSleep, minIntervalMs: 0 });
  for await (const _ of fandom.listRedirects()) { /* drain */ }
  assert.ok(urls.length > 0);
  for (const url of urls) {
    const params = new URL(url).searchParams;
    assert.ok(!(params.get('generator') === 'allpages' && params.get('redirects')), `invalid combination in ${url}`);
  }
});

test('MediaWiki error payload throws', async () => {
  const fandom = createFandom({ fetchImpl: async () => response(200, { error: { code: 'badvalue', info: 'nope' } }), sleep: noSleep, minIntervalMs: 0 });
  await assert.rejects(fandom.fetchPages(['X']), /MediaWiki badvalue: nope/);
});

test('listRevisions throws instead of looping when the continuation repeats', async () => {
  const fetchImpl: FetchLike = async () => response(200, { continue: { gapcontinue: 'A', continue: 'gapcontinue||' }, query: { pages: [{ title: 'A', lastrevid: 1 }] } });
  const fandom = createFandom({ fetchImpl, sleep: noSleep, minIntervalMs: 0 });
  await assert.rejects(async () => { for await (const _ of fandom.listRevisions()) { /* drain */ } }, /pagination stalled/);
});

test('http honors a date-valued Retry-After', async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const when = new Date(Date.now() + 5000).toUTCString();
  const fetchImpl: FetchLike = async () => (++calls === 1 ? response(429, '', { 'retry-after': when }) : response(200, 'ok'));
  const get = createHttp({ userAgent: 'ua', minIntervalMs: 0, fetchImpl, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(await get('https://x'), 'ok');
  assert.ok(sleeps.some((ms) => ms > 3000 && ms <= 5000), `expected a ~5s sleep, got ${sleeps.join(',')}`);
});
