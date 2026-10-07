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
// are hiring for right now. It is NOT a complete inventory (HN keeps roughly
// the newest ~30), so use it to notice new openings; for one company's full
// list use the `yc-jobs` provider. One request for the id list plus one per
// post, in small batches, capped by `maxItems` (default 30, max 60).
//
// Mapping:
//   title    the HN headline as written. It rarely names a single role, since
//            posts often say just "Is Hiring"; the role lives behind the link.
//   url      the employer's own link when the post has an http(s) one (rule 2:
//            shortest path to the employer); otherwise the HN item page.
//   company  the name before "(YC <batch>)" in the headline, else ''.
//   postedAt the item's `time`, converted to epoch ms (exact, not estimated).

const IDS_URL = 'https://hacker-news.firebaseio.com/v0/jobstories.json';
const itemUrl = (/** @type {number} */ id) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;
const hnPage = (/** @type {number} */ id) => `https://news.ycombinator.com/item?id=${id}`;

const DEFAULT_MAX_ITEMS = 30;
const HARD_MAX_ITEMS = 60;
const BATCH_SIZE = 5;

/** @param {any} entry */
function maxItemsFor(entry) {
  const n = Number(entry?.maxItems);
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
    const ids = await ctx.fetchJson(IDS_URL);
    if (!Array.isArray(ids)) return [];
    const wanted = ids.filter((id) => Number.isInteger(id) && id > 0).slice(0, maxItemsFor(entry));

    /** @type {any[]} */
    const items = [];
    for (let i = 0; i < wanted.length; i += BATCH_SIZE) {
      const batch = wanted.slice(i, i + BATCH_SIZE);
      const got = await Promise.all(batch.map((id) => ctx.fetchJson(itemUrl(id)).catch(() => null)));
      items.push(...got);
    }
    return parseHnJobItems(items);
  },
};

/**
 * Map Hacker News job items to normalized Jobs. Exported for unit tests.
 * Rows that are not live `job` items, or have no usable title, are dropped.
 *
 * @param {unknown[]} items  Parsed `/v0/item/<id>.json` payloads (null allowed).
 * @returns {Array<{title: string, url: string, company: string, location: string, postedAt?: number}>}
 */
export function parseHnJobItems(items) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const jobs = [];
  for (const raw of items) {
    const it = /** @type {any} */ (raw);
    if (!it || it.type !== 'job' || it.dead || it.deleted) continue;
    if (!Number.isInteger(it.id) || it.id <= 0) continue;
    const title = typeof it.title === 'string' ? it.title.trim() : '';
    if (!title) continue;

    let url = hnPage(it.id);
    if (typeof it.url === 'string') {
      try {
        const u = new URL(it.url.trim());
        if (u.protocol === 'https:' || u.protocol === 'http:') url = u.href;
      } catch { /* keep the HN page */ }
    }
    if (seen.has(url)) continue;
    seen.add(url);

    const company = (title.match(/^(.+?)\s*\(YC\s[^)]*\)/)?.[1] || '').trim();
    /** @type {{title: string, url: string, company: string, location: string, postedAt?: number}} */
    const job = { title, url, company, location: '' };
    if (Number.isFinite(it.time) && it.time > 0) job.postedAt = it.time * 1000;
    jobs.push(job);
  }
  return jobs;
}
