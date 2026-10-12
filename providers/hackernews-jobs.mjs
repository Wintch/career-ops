// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Hacker News "Jobs" provider — the YC-run job posts on https://news.ycombinator.com/jobs
// ("Acme (YC W24) Is Hiring a Founding Engineer"). Board-wide feed, so it
// belongs under `job_boards:` and is selected with an explicit
// `provider: hackernews-jobs` (a news.ycombinator.com host is not claimed by
// URL, to keep it separate from the monthly "Who is hiring?" provider).
//
// Source: the official, public, zero-auth Hacker News Firebase API.
//   https://hacker-news.firebaseio.com/v0/jobstories.json   → newest-first ids
//   https://hacker-news.firebaseio.com/v0/item/<id>.json    → one post
// Each item is { type: 'job', title, url?, text?, time (epoch s), by, id }.
//
// What this is for: a small, dated, employer-linked stream of what YC startups
// are hiring for right now. It is NOT a complete inventory: Firebase returns the
// current list (up to ~200 ids) and this provider reads only the newest
// `maxItems` (default 30, max 60; `max_items` is accepted as an alias), so use
// it to notice new openings; for one company's full list use the `yc-jobs`
// provider. One request for the id list plus one per post, in small batches
// with a short sleep between them. A health probe (ctx.maxPages) reads at most
// that many posts.
//
// robots.txt, measured 2026-10-12 with the scanner's DEFAULT_USER_AGENT.
// hacker-news.firebaseio.com: `User-agent: *` Allow /*.json$ and /*.json?*$,
// Disallow / — every URL this provider fetches is a .json path, so allowed.
// news.ycombinator.com: `User-Agent: *` Crawl-delay: 30 and Disallow on
// /collapse? /context? /fave? /flag? /hide? /login /logout /r? /reply?
// /submitlink? /vote? /x? — this provider only LINKS item pages there
// (item?id=N, never fetched), so neither the delay nor the Disallow applies.
// Groups checked: `*` on both hosts; no group names ClaudeBot, anthropic-ai,
// Claude-Web or Claude-User. Result: allowed.
//
// Mapping:
//   title    the HN headline as written. It rarely names a single role, since
//            posts often say just "Is Hiring"; the role lives behind the link.
//   url      the employer's own link when the post has an https one without
//            userinfo (rule 2: shortest path to the employer); otherwise the
//            HN item page.
//   company  the name before "(YC <batch>)" in the headline. A post whose
//            headline has no clean `Name (YC xx)` prefix (no YC tag, a role
//            prefix like "Senior Engineer at Foo", "Hiring: Foo") has no
//            identifiable employer and is DROPPED (counted, one warning per
//            fetch). Entities in the headline are decoded first.
//   postedAt the item's `time`, converted to epoch ms (exact, not estimated).

import { decodeEntities } from './_html-entities.mjs';
import { sleep } from './_http.mjs';

const IDS_URL = 'https://hacker-news.firebaseio.com/v0/jobstories.json';
const itemUrl = (/** @type {number} */ id) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;
const hnPage = (/** @type {number} */ id) => `https://news.ycombinator.com/item?id=${id}`;

const DEFAULT_MAX_ITEMS = 30;
const HARD_MAX_ITEMS = 60;
const BATCH_SIZE = 5;
const INTER_BATCH_DELAY_MS = 200;

const HIRING_VERB_RE = /^(?:hiring|hire|hires|join|joins|seeking|looking|we|now)\b/i;

/** @param {any} entry */
function maxItemsFor(entry) {
  const n = Number(entry?.maxItems ?? entry?.max_items);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_MAX_ITEMS;
  return Math.min(n, HARD_MAX_ITEMS);
}

/** @type {Provider} */
export default {
  id: 'hackernews-jobs',

  // Explicit-only: reachable via `provider: hackernews-jobs`, never by URL.
  detect(entry) {
    return entry?.provider === 'hackernews-jobs' ? { url: IDS_URL } : null;
  },

  async fetch(entry, ctx) {
    const ids = await ctx.fetchJson(IDS_URL, { redirect: 'error' });
    if (!Array.isArray(ids)) throw new Error('hackernews-jobs: jobstories.json is not an array — API changed?');
    // Health probe (verify-portals) sets ctx.maxPages: read at most that many
    // items and let every rejection (its ProbePageBudgetReached sentinel
    // included) propagate unwrapped.
    const ctxMax = Number(ctx?.maxPages);
    const probing = ctxMax > 0;
    const limit = probing ? Math.min(ctxMax, maxItemsFor(entry)) : maxItemsFor(entry);
    const wanted = ids.filter((id) => Number.isInteger(id) && id > 0).slice(0, limit);

    /** @type {any[]} */
    const items = [];
    let failed = 0;
    for (let i = 0; i < wanted.length; i += BATCH_SIZE) {
      if (i > 0) await sleep(INTER_BATCH_DELAY_MS, ctx);
      const batch = wanted.slice(i, i + BATCH_SIZE);
      const got = await Promise.all(batch.map((id) => {
        const p = ctx.fetchJson(itemUrl(id), { redirect: 'error' });
        return probing ? p : p.catch(() => { failed++; return null; });
      }));
      items.push(...got);
    }
    if (wanted.length > 0 && failed === wanted.length) {
      throw new Error(`hackernews-jobs: all ${failed} item requests failed`);
    }
    if (failed > 0) console.warn(`hackernews-jobs: ${failed} of ${wanted.length} item requests failed`);
    const stats = { dropped: 0 };
    const jobs = parseHnJobItems(items, stats);
    if (stats.dropped > 0) console.warn(`hackernews-jobs: dropped ${stats.dropped} post(s) with no identifiable employer`);
    return jobs;
  },
};

/**
 * Map Hacker News job items to normalized Jobs. Exported for unit tests.
 * Rows that are not live `job` items, or have no usable title, are dropped.
 *
 * @param {unknown[]} items  Parsed `/v0/item/<id>.json` payloads (null allowed).
 * @param {{dropped: number}} [stats]  Incremented per live job post dropped for
 *   lack of an identifiable employer.
 * @returns {Array<{title: string, url: string, company: string, location: string, postedAt?: number}>}
 */
export function parseHnJobItems(items, stats) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const jobs = [];
  for (const raw of items) {
    const it = /** @type {any} */ (raw);
    if (!it || it.type !== 'job' || it.dead || it.deleted) continue;
    if (!Number.isInteger(it.id) || it.id <= 0) continue;
    const title = typeof it.title === 'string' ? decodeEntities(it.title).trim() : '';
    if (!title) continue;
    const company = (title.match(/^(.+?)\s*\(YC\s[^)]*\)/)?.[1] || '').trim();
    if (!company || / at /i.test(company) || company.includes(':') || HIRING_VERB_RE.test(company)) {
      if (stats) stats.dropped++;
      continue;
    }

    let url = hnPage(it.id);
    if (typeof it.url === 'string') {
      try {
        const u = new URL(it.url.trim());
        if (u.protocol === 'https:' && !u.username && !u.password) url = u.href;
      } catch { /* keep the HN page */ }
    }
    if (seen.has(url)) continue;
    seen.add(url);

    /** @type {{title: string, url: string, company: string, location: string, postedAt?: number}} */
    const job = { title, url, company, location: '' };
    if (Number.isFinite(it.time) && it.time > 0) job.postedAt = it.time * 1000;
    jobs.push(job);
  }
  return jobs;
}
