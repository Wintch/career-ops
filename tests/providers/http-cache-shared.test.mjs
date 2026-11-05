// A shared fetch store: one fetcher fills it, several people's scans read it.
// cacheOnly makes a read that is not fresh in the store fail without touching the
// network; storeNoStore lets the fetcher keep a body the server marked no-store
// (Workday does), which the cache otherwise refuses to keep.
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fail, pass, ROOT, withLocalServerAs } from '../helpers.mjs';

const { fetchJson, fetchText } = await import(pathToFileURL(join(ROOT, 'providers/_http.mjs')).href);
const { withHttpCache, httpCacheStats } = await import(pathToFileURL(join(ROOT, 'providers/_http-cache.mjs')).href);

const hits = [];
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    hits.push({ url: req.url, method: req.method, body: Buffer.concat(chunks).toString('utf8') });
    const base = { 'content-type': 'application/json' };
    if (req.url === '/nostore') {
      res.writeHead(200, { ...base, 'cache-control': 'no-store, no-cache' });
      res.end('{"jobs":[{"t":"SRE"}]}');
      return;
    }
    res.writeHead(200, { ...base, etag: '"v1"' });
    res.end('{"jobs":[{"t":"Platform Engineer"}]}');
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://boards.example.test';
const local = `http://127.0.0.1:${server.address().port}`;
const via = (fn) => withLocalServerAs(origin, local, fn);
const dir = mkdtempSync(join(tmpdir(), 'co-http-cache-shared-'));
let now = 100_000;
const TTL = 60_000;

const fetcher = (fn, extra = {}) => withHttpCache({ dir, ttlMs: TTL, now: () => now, write: true, ...extra }, fn);
const reader = (fn) => withHttpCache({ dir, ttlMs: TTL, now: () => now, write: false, cacheOnly: true }, fn);

async function code(fn) {
  try { await fn(); return null; } catch (err) { return err.code || err.message; }
}

try {
  {
    const before = hits.length;
    const c = await via(() => reader(() => code(() => fetchJson(`${origin}/empty`))));
    if (c === 'cache_only_miss' && hits.length === before) pass('cache-only: a board nobody fetched fails and makes no request');
    else fail(`empty store gave ${c} with ${hits.length - before} requests`);
  }

  {
    await via(() => fetcher(() => fetchJson(`${origin}/board`)));
    const before = hits.length;
    const got = await via(() => reader(() => fetchJson(`${origin}/board`)));
    if (got.jobs[0].t === 'Platform Engineer' && hits.length === before) pass('cache-only: a fresh response written by the fetcher is served with no request');
    else fail(`fresh read made ${hits.length - before} requests: ${JSON.stringify(got)}`);
  }

  {
    now += TTL + 1;
    const before = hits.length;
    const c = await via(() => reader(() => code(() => fetchJson(`${origin}/board`))));
    now -= TTL + 1;
    if (c === 'cache_only_miss' && hits.length === before) pass('cache-only: a stale response is a miss, not a conditional request');
    else fail(`stale read gave ${c} with ${hits.length - before} requests`);
  }

  {
    const before = hits.length;
    const absent = await via(() => reader(async () => {
      await code(() => fetchJson(`${origin}/never-1`));
      await code(() => fetchText(`${origin}/never-2`));
      return httpCacheStats().absent;
    }));
    if (absent === 2 && hits.length === before) pass('cache-only: misses are counted in stats.absent');
    else fail(`absent=${absent} requests=${hits.length - before}`);
  }

  {
    const url = `${origin}/nostore`;
    const before = hits.length;
    await via(() => fetcher(() => fetchJson(url)));
    await via(() => fetcher(() => fetchJson(url)));
    const plainHits = hits.slice(before).filter((h) => h.url === '/nostore').length;
    if (plainHits === 2) pass('a no-store body is not kept by default');
    else fail(`no-store was requested ${plainHits} times, expected 2`);

    const before2 = hits.length;
    await via(() => fetcher(() => fetchJson(url), { storeNoStore: true }));
    const mid = hits.length;
    const got = await via(() => reader(() => fetchJson(url)));
    if (mid - before2 === 1 && hits.length === mid && got.jobs[0].t === 'SRE') {
      pass('storeNoStore keeps a no-store body, and a cache-only reader then gets it with no request');
    } else {
      fail(`storeNoStore: fetch=${mid - before2} read=${hits.length - mid} got=${JSON.stringify(got)}`);
    }
  }

  {
    const post = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"offset":0}' };
    await via(() => fetcher(() => fetchJson(`${origin}/jobs`, post)));
    const before = hits.length;
    const same = await via(() => reader(() => fetchJson(`${origin}/jobs`, post)));
    const other = await via(() => reader(() => code(() => fetchJson(`${origin}/jobs`, { ...post, body: '{"offset":20}' }))));
    if (same.jobs && other === 'cache_only_miss' && hits.length === before) pass('cache-only: a POST is keyed by its body');
    else fail(`post same=${JSON.stringify(same)} other=${other} requests=${hits.length - before}`);
  }

  {
    const before = hits.length;
    const c = await via(() => reader(() => code(() => fetchJson(`${origin}/buf`, { method: 'POST', body: Buffer.from('x'), headers: {} }))));
    if (hits.length === before && c !== null) pass('cache-only: a request the cache cannot key is refused, not sent');
    else fail(`unkeyable request: code=${c} requests=${hits.length - before}`);
  }
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}
