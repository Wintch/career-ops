#!/usr/bin/env node

/**
 * scan-navent.mjs — Bumeran and ZonaJobs (Argentina) via a real browser
 *
 * Both boards run on the same platform and are client-rendered: a plain HTTPS
 * fetch returns an empty React shell, so no `providers/*.mjs` module can read
 * them (see the Bumeran / ZonaJobs row of docs/SUPPORTED_JOB_BOARDS.md).
 * This standalone scanner opens the PUBLIC search page the way a visitor does,
 * lets the page's own JavaScript load its results, and reads the response the
 * page itself requested (`POST /api/avisos/searchV2`, 20 postings per page,
 * title / employer / location / modality / full description / publication time).
 *
 * WHAT THIS DOES NOT DO — these are the conditions the project sets for a
 * browser scanner (providers/ADDING_A_PROVIDER.md, "Browser-based scanners"):
 *   - no login, no cookies of a real user, no authenticated area;
 *   - no forged tokens or headers: the page makes its own requests, nothing is
 *     replayed from outside it;
 *   - NO BYPASS. What it recognizes as a challenge or refusal (an HTTP
 *     401/403/429/451/5xx, a page whose title or first lines read "Just a
 *     moment" / CAPTCHA / "Access denied" / "Attention required") stops the
 *     WHOLE run with a named error; it is never solved, retried around or
 *     relayed. A results request that never happens, is not JSON or is not a
 *     2xx reply is treated as an inconclusive refusal: two in a row stop the
 *     run too. A challenge in a form this does not recognize is not detected.
 *
 * LIGHT TOUCH. One person looking for a job, not a crawler:
 *   - identifies itself with the shared career-ops User-Agent;
 *   - reads each site's robots.txt on every run (once per site) and skips any
 *     path it disallows (the board's own `/*recientes=true`, `/*?localidades=*`,
 *     `/empleos-busquedaext-` are never requested); the page's own results
 *     request (`/api/avisos/searchV2`) is checked against it too. On this fork
 *     a group naming ClaudeBot, anthropic-ai, Claude-Web or Claude-User also
 *     binds: if any of them disallows a path, it is not requested;
 *   - robots.txt record (measured 2026-10-12 with the scanner's DEFAULT_USER_AGENT):
 *     bumeran.com.ar and zonajobs.com.ar both serve only a `User-agent: *`
 *     group (Disallow /*recientes=true, /*relevantes=true, /empleos.html/111
 *     and /100, /empleos-area-*\/111 and /100, /en-*\/empleos.html/111 and /100,
 *     /empleos-busquedaext-, /*?localidades=*, /*&localidades=*; no
 *     Crawl-delay) and NO group naming ClaudeBot, anthropic-ai, Claude-Web or
 *     Claude-User. Result: /empleos-busqueda-{slug}.html[?page=N] is allowed;
 *   - postings with no identifiable employer (confidential, or a literal
 *     "Confidencial") are dropped and counted in the summary, never emitted;
 *   - one navigation every 6 s, at most 5 pages per keyword (default 2), at
 *     most 8 keywords per search, and a hard cap of 40 navigations per run;
 *   - images, media and fonts are not downloaded;
 *   - nothing is crawled beyond the search-result pages: no posting detail
 *     page is opened (the description already arrives with the results).
 * The board orders results by relevance and its "most recent" sort is a URL
 * parameter its robots.txt disallows, so use specific keywords: a broad one
 * ("analista") has ~1,000 results and this scanner reads only the first pages.
 *
 * Configure in portals.yml:
 *
 *   navent_searches:
 *     - site: bumeran             # bumeran | zonajobs
 *       keywords: [devops, sre]   # word or phrase, max 8, one search each
 *       max_pages: 2              # optional, 20 postings/page, default 2, cap 5
 *
 * Usage:
 *   node scan-navent.mjs
 *   node scan-navent.mjs --dry-run
 *   node scan-navent.mjs --site zonajobs
 *   node scan-navent.mjs --keyword "devops"
 *   node scan-navent.mjs --since 7          # only postings published in the last 7 days
 *   node scan-navent.mjs --help|-h
 */

import { readFileSync, existsSync, mkdirSync } from 'fs';
import { loadYaml } from './lib/yaml-document.mjs';
import {
  appendToPipeline, appendToScanHistory, loadSeenUrls, unrecordedOffers, PORTALS_PATH, SCAN_HISTORY_PATH,
  buildTitleFilter, buildLocationFilter, parseSinceDays, resolveEffectiveAfter, buildPostedDateFilter,
  companyRoleDedupKey,
} from './scan.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { localToday } from './lib/local-today.mjs';
import { printScanSummaryHeader } from './lib/scan-summary-marker.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { DEFAULT_USER_AGENT } from './user-agent.mjs';
import { decodeEntities } from './providers/_html-entities.mjs';
import { htmlToText } from './providers/_html-to-text.mjs';

// ── Constants ────────────────────────────────────────────────────────

/** The two Navent boards this scanner knows. Hosts are fixed literals — nothing from config reaches a URL host. */
export const SITES = /** @type {const} */ ({
  bumeran: { host: 'www.bumeran.com.ar', source: 'bumeran', label: 'Bumeran' },
  zonajobs: { host: 'www.zonajobs.com.ar', source: 'zonajobs', label: 'ZonaJobs' },
});

export const PAGE_SIZE = 20;
export const DEFAULT_MAX_PAGES = 2;
/** Hard ceiling on a configured `max_pages`, independent of the result count the board reports. */
export const MAX_PAGES_CAP = 5;
export const MAX_KEYWORDS = 8;
/** Hard ceiling on navigations in ONE run, however many searches are configured. */
export const MAX_NAVIGATIONS = 40;
/** Pause between two navigations (the first one is not delayed). */
export const NAV_DELAY_MS = 6000;
const MAX_SLUG_LENGTH = 60;
const MAX_DESCRIPTION_CHARS = 20_000;
const SEARCH_RESPONSE_TIMEOUT_MS = 30_000;
const MAX_CONSECUTIVE_REFUSALS = 2;

/** An employer the board hides: nothing to evaluate or apply against, so the posting is dropped (fork policy). */
const ANONYMOUS_EMPLOYER_RE = /^(?:empresa\s+)?confidencial$/i;
const SEARCH_API_RE = /\/api\/avisos\/searchV2\b/;
/** A posting link as the board renders it: `/empleos/{slug}-{numeric id}.html`. */
const POSTING_PATH_RE = /^\/empleos\/[a-z0-9-]*?-?(\d+)\.html$/;
/** Argentina has had no DST since 2009: wall-clock publication times are UTC-3. */
const AR_UTC_OFFSET_HOURS = 3;

// ── Pure helpers (exported for tests) ────────────────────────────────

/**
 * Lowercase ASCII slug as the board builds its own search URLs.
 * @param {any} value
 * @returns {string} '' when nothing usable is left.
 */
export function slugifyKeyword(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
}

/**
 * Search-results URL for one keyword/page — `/empleos-busqueda-{slug}.html`
 * with `?page=N` from page 2 (the only URL shapes this scanner requests).
 * @param {keyof typeof SITES} site
 * @param {string} keywordSlug
 * @param {number} page 1-based
 * @returns {string}
 */
export function buildSearchUrl(site, keywordSlug, page) {
  if (!Object.hasOwn(SITES, site)) throw new Error(`scan-navent: unknown site ${JSON.stringify(site)}`);
  return `https://${SITES[site].host}/empleos-busqueda-${keywordSlug}.html${page > 1 ? `?page=${page}` : ''}`;
}

/**
 * Validate and normalize the `navent_searches` section.
 * @param {any} raw
 * @returns {{site: keyof typeof SITES, keywords: string[], maxPages: number}[]}
 */
export function resolveSearches(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('scan-navent: no `navent_searches` configured in portals.yml (a site and 1-8 keywords per entry — see the header of scan-navent.mjs)');
  }
  return raw.map((entry, i) => {
    const where = `navent_searches[${i}]`;
    if (!entry || typeof entry !== 'object') throw new Error(`scan-navent: ${where} must be a mapping with site and keywords`);
    const site = typeof entry.site === 'string' ? entry.site.trim().toLowerCase() : '';
    if (!Object.hasOwn(SITES, site)) {
      throw new Error(`scan-navent: ${where}.site ${JSON.stringify(entry.site)} — expected one of ${Object.keys(SITES).join(', ')}`);
    }
    const list = Array.isArray(entry.keywords) ? entry.keywords : entry.keywords != null ? [entry.keywords] : entry.query != null ? [entry.query] : [];
    const keywords = [];
    for (const k of list) {
      const slug = slugifyKeyword(k);
      if (!slug) throw new Error(`scan-navent: ${where} has an unusable keyword ${JSON.stringify(k)}`);
      if (!keywords.includes(slug)) keywords.push(slug);
    }
    if (keywords.length === 0) throw new Error(`scan-navent: ${where} needs \`keywords\``);
    if (keywords.length > MAX_KEYWORDS) {
      throw new Error(`scan-navent: ${where} has ${keywords.length} keywords — cap is ${MAX_KEYWORDS}`);
    }
    const mp = entry.max_pages;
    const maxPages = Number.isInteger(mp) && mp > 0 ? Math.min(mp, MAX_PAGES_CAP) : DEFAULT_MAX_PAGES;
    return { site: /** @type {keyof typeof SITES} */ (site), keywords, maxPages };
  });
}

/**
 * Parse robots.txt into user-agent groups.
 * @param {string} text
 * @returns {{agents: string[], rules: {allow: boolean, pattern: string}[]}[]}
 */
export function parseRobots(text) {
  /** @type {{agents: string[], rules: {allow: boolean, pattern: string}[]}[]} */
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'disallow' || key === 'allow') && current) {
      lastWasAgent = false;
      if (value) current.rules.push({ allow: key === 'allow', pattern: value });
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

/** @param {string} pattern robots pattern: `*` wildcard, trailing `$` anchor */
function robotsPatternToRegExp(pattern) {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/** This scanner's own robots token (exact, case-insensitive match). */
export const OWN_ROBOTS_TOKEN = 'career-ops';
/** Anthropic crawler groups that also bind on this fork: a Disallow there is honoured. */
export const CLAUDE_ROBOTS_TOKENS = ['claudebot', 'anthropic-ai', 'claude-web', 'claude-user'];

/** Longest-match decision over the rules of some groups; no matching rule → allowed. */
function rulesAllow(groups, pathWithQuery) {
  let best = null;
  for (const rule of groups.flatMap((g) => g.rules)) {
    if (!robotsPatternToRegExp(rule.pattern).test(pathWithQuery)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) best = rule;
  }
  return best ? best.allow : true;
}

/**
 * Name of the robots group that forbids a path, or null when it is allowed.
 * Binding groups: this scanner's own token (exact match) else `*`, and — on
 * this fork — each Claude-named group (ClaudeBot, anthropic-ai, Claude-Web,
 * Claude-User). Longest matching pattern wins; Allow wins a tie.
 * @param {string} robotsText
 * @param {string} pathWithQuery e.g. `/empleos-busqueda-devops.html?page=2`
 * @returns {string | null}
 */
export function robotsBlockedBy(robotsText, pathWithQuery) {
  const groups = parseRobots(robotsText);
  const named = (token) => groups.filter((g) => g.agents.includes(token));
  const own = named(OWN_ROBOTS_TOKEN);
  const star = groups.filter((g) => g.agents.includes('*'));
  const base = own.length ? own : star;
  if (!rulesAllow(base, pathWithQuery)) return own.length ? OWN_ROBOTS_TOKEN : '*';
  for (const token of CLAUDE_ROBOTS_TOKENS) {
    const g = named(token);
    if (g.length && !rulesAllow(g, pathWithQuery)) return token;
  }
  return null;
}

/** @returns {boolean} whether a path may be fetched — see robotsBlockedBy(). */
export function isAllowedByRobots(robotsText, pathWithQuery) {
  return robotsBlockedBy(robotsText, pathWithQuery) === null;
}

/** Visible text inspected for challenge phrases: the top of the page, not the whole article. */
const CHALLENGE_TEXT_WINDOW = 600;

/** Signals that a response is an interstitial or a refusal, not the search page. */
const CHALLENGE_TEXT_RE = /just a moment|verify(?:ing)? you are (?:a )?human|checking your browser|attention required|captcha|access denied|enable javascript and cookies to continue/i;

/**
 * Name the reason a response is a challenge/refusal, or null when it is not.
 * A challenge is never solved or worked around — the caller stops the run.
 * @param {{status?: number|null, title?: string, text?: string}} observed
 * @returns {string | null}
 */
export function detectChallenge({ status = null, title = '', text = '' } = {}) {
  if (status === 401 || status === 403 || status === 429 || status === 451 || (status != null && status >= 500)) return `HTTP ${status}`;
  const hay = `${title ?? ''} ${String(text ?? '').slice(0, CHALLENGE_TEXT_WINDOW)}`;
  const m = CHALLENGE_TEXT_RE.exec(hay);
  return m ? `challenge page ("${m[0]}")` : null;
}

/**
 * Epoch ms from the board's `DD-MM-YYYY HH:mm:ss` publication time (Argentina
 * wall clock), falling back to a date-only `DD-MM-YYYY`. NaN-safe, no calendar
 * rollover: an impossible date returns undefined.
 * @param {any} dateTime
 * @param {any} [dateOnly]
 * @returns {number | undefined}
 */
export function parsePublished(dateTime, dateOnly) {
  const src = typeof dateTime === 'string' && dateTime.trim() ? dateTime : typeof dateOnly === 'string' ? dateOnly : '';
  const m = /^(\d{1,2})-(\d{1,2})-(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(src.trim());
  if (!m) return undefined;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [h, mi, s] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return undefined;
  const ms = Date.UTC(y, mo - 1, d, h + AR_UTC_OFFSET_HOURS, mi, s);
  if (Number.isNaN(ms)) return undefined;
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return undefined; // 31-02 etc.
  return ms;
}

/**
 * Convert one search response (the JSON the page itself requested) into postings.
 *
 * The envelope is checked, not assumed: a body without a `content` array is a
 * changed API and THROWS (it must not read as a board with no jobs); a present
 * but empty `content` is a quiet search and returns []. A malformed row is
 * skipped, never fatal to the page.
 *
 * @param {any} json
 * @param {{site: keyof typeof SITES, hrefById?: Map<string,string>}} ctx
 *   `hrefById` maps a posting id to the `/empleos/…-{id}.html` path the page
 *   itself rendered for it; a posting with no rendered link falls back to
 *   `/empleos/{slug of the title}-{id}.html`, which the board resolves by id.
 *   Postings with a hidden employer (`confidencial`, empty or "Confidencial"
 *   `empresa`) are NOT returned; their count is `result.anonymous`, and
 *   `result.rawCount` is the number of rows the page carried.
 * @returns {{title: string, url: string, company: string, location: string, description?: string, postedAt?: number, source: string}[] & {anonymous: number, rawCount: number}}
 */
export function parseSearchResponse(json, { site, hrefById = new Map() }) {
  const rows = json && Array.isArray(json.content) ? json.content : null;
  if (!rows) {
    const got = json && typeof json === 'object' ? Object.keys(json).join(', ') : typeof json;
    throw new Error(`scan-navent: unexpected search response — expected content[], got: [${got}]`);
  }
  const { host, source } = SITES[site];
  const out = [];
  let anonymous = 0;
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const idNum = Number(row.id);
    if (!Number.isInteger(idNum) || idNum <= 0) continue;
    const id = String(idNum);
    const title = typeof row.titulo === 'string' ? decodeEntities(row.titulo).replace(/\s+/g, ' ').trim() : '';
    if (!title) continue;

    const rendered = hrefById.get(id);
    const path = rendered && POSTING_PATH_RE.test(rendered) ? rendered : `/empleos/${slugifyKeyword(title) || 'aviso'}-${id}.html`;
    const url = `https://${host}${path}`;
    if (seen.has(url)) continue;
    seen.add(url);

    const company = typeof row.empresa === 'string' ? decodeEntities(row.empresa).replace(/\s+/g, ' ').trim() : '';
    if (row.confidencial === true || !company || ANONYMOUS_EMPLOYER_RE.test(company)) { anonymous++; continue; }
    const place = typeof row.localizacion === 'string' ? decodeEntities(row.localizacion).replace(/\s+/g, ' ').trim() : '';
    const mode = typeof row.modalidadTrabajo === 'string' ? row.modalidadTrabajo.trim() : '';
    const location = place && mode ? `${place} (${mode})` : place || mode;
    const detail = typeof row.detalle === 'string' ? htmlToText(row.detalle).trim() : '';
    const description = detail ? detail.slice(0, MAX_DESCRIPTION_CHARS) : undefined;
    const postedAt = parsePublished(row.fechaHoraPublicacion, row.fechaPublicacion);

    out.push({
      title, url, company, location, source,
      ...(description ? { description } : {}),
      ...(postedAt !== undefined ? { postedAt } : {}),
    });
  }
  if (rows.length > 0 && out.length === 0 && anonymous === 0) {
    throw new Error(`scan-navent: unexpected row shape — ${rows.length} rows, none with a usable id/titulo (fields renamed?)`);
  }
  return Object.assign(out, { anonymous, rawCount: rows.length });
}

// ── Browser-facing step (page-like object injected, so tests need no browser) ──

/** A challenge or refusal: the run stops, nothing is retried or worked around. */
export class ChallengeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChallengeError';
  }
}

/** The results call did not happen / was not JSON / was not a 2xx reply: inconclusive, two in a row stop the run. */
export class InconclusiveError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InconclusiveError';
  }
}

/**
 * Open one search page and return what the page itself loaded.
 *
 * @param {any} page Playwright Page (or a stub with the same four methods)
 * @param {string} url
 * @param {{site: keyof typeof SITES, robotsText?: string}} opts
 * @returns {Promise<{postings: ReturnType<typeof parseSearchResponse>, total: number|null, rawCount: number, anonymous: number}>}
 */
export async function loadSearchPage(page, url, { site, robotsText = '' }) {
  const label = SITES[site].label;
  // Registered BEFORE navigating: the page fires its own results call while it loads.
  const responsePromise = page.waitForResponse(
    (r) => SEARCH_API_RE.test(r.url()) && r.request().method() === 'POST',
    { timeout: SEARCH_RESPONSE_TIMEOUT_MS },
  ).catch((err) => err);

  const nav = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  const status = nav && typeof nav.status === 'function' ? nav.status() : null;

  const observe = async () => {
    const title = await page.title().catch(() => '');
    const text = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
    return detectChallenge({ status, title, text });
  };
  // Judged BEFORE waiting for the results call: a challenge page never fires it,
  // and waiting out the timeout first would only add 30 s of silence.
  const early = await observe();
  if (early) throw new ChallengeError(`${label}: ${early} at ${url}`);

  const reply = await responsePromise;
  if (reply instanceof Error) {
    const late = await observe();
    if (late) throw new ChallengeError(`${label}: ${late} at ${url}`);
    throw new InconclusiveError(`scan-navent: ${label} never made its results request at ${url} (${reply.message.split('\n')[0]}) — the page changed or did not load`);
  }
  // The page's own XHR is subject to robots.txt like any path the scanner requests.
  const apiPath = String(reply.url()).replace(/^https?:\/\/[^/]+/, '');
  const apiBlockedBy = robotsBlockedBy(robotsText, apiPath);
  if (apiBlockedBy) throw new ChallengeError(`${label}: robots.txt (group ${apiBlockedBy}) disallows the page's own results request ${apiPath.split('?')[0]} — stopped`);

  const replyStatus = typeof reply.status === 'function' ? reply.status() : 200;
  const refused = detectChallenge({ status: replyStatus });
  if (refused) throw new ChallengeError(`${label}: results request answered ${refused} at ${url}`);
  if (replyStatus < 200 || replyStatus >= 300) {
    throw new InconclusiveError(`scan-navent: ${label} results request answered HTTP ${replyStatus} at ${url}`);
  }
  let json;
  try {
    json = await reply.json();
  } catch {
    throw new InconclusiveError(`scan-navent: ${label} results request did not return JSON at ${url}`);
  }

  // The links the page rendered for these postings: only the exact path shape is kept.
  const hrefs = await page.evaluate(() => [...document.querySelectorAll('a[href*="/empleos/"]')].map((a) => a.getAttribute('href') || '')).catch(() => []);
  /** @type {Map<string,string>} */
  const hrefById = new Map();
  for (const href of hrefs) {
    const path = String(href).split('#')[0].split('?')[0];
    const m = POSTING_PATH_RE.exec(path);
    if (m && !hrefById.has(m[1])) hrefById.set(m[1], path);
  }

  const postings = parseSearchResponse(json, { site, hrefById });
  const total = json && Number.isInteger(json.total) ? json.total : null;
  return { postings, total, rawCount: postings.rawCount, anonymous: postings.anonymous };
}

/**
 * Run one site's searches, politely. Stops the whole walk by throwing
 * ChallengeError; returns what was collected for ordinary per-search errors.
 *
 * @param {any} page
 * @param {{site: keyof typeof SITES, keywords: string[], maxPages: number}} search
 * @param {{sleep: (ms: number) => Promise<void>, budget: {left: number}, robotsText: string, log?: (s: string) => void, refusals?: {n: number}}} deps
 *   `refusals` counts consecutive inconclusive results calls across the whole run.
 *   A ChallengeError thrown from here carries `found`, `errors`, `navigations`
 *   and `anonymous`: what was already collected is not lost.
 */
export async function runSearch(page, search, { sleep, budget, robotsText, log = () => {}, refusals = { n: 0 } }) {
  /** @type {ReturnType<typeof parseSearchResponse>} */
  const found = [];
  /** @type {{keyword: string, error: string}[]} */
  const errors = [];
  let navigations = 0;
  let anonymous = 0;
  const partial = (err) => Object.assign(err, { found, errors, navigations, anonymous });

  for (const keyword of search.keywords) {
    for (let pageNo = 1; pageNo <= search.maxPages; pageNo++) {
      const url = buildSearchUrl(search.site, keyword, pageNo);
      const pathWithQuery = url.replace(/^https:\/\/[^/]+/, '');
      const blockedBy = robotsBlockedBy(robotsText, pathWithQuery);
      if (blockedBy) {
        errors.push({ keyword, error: `robots.txt (group ${blockedBy}) disallows ${pathWithQuery} — skipped` });
        break;
      }
      if (budget.left <= 0) {
        errors.push({ keyword, error: `navigation cap (${MAX_NAVIGATIONS} per run) reached — stopped` });
        return { found, errors, navigations, anonymous };
      }
      if (budget.left < MAX_NAVIGATIONS) await sleep(NAV_DELAY_MS);
      budget.left--;
      navigations++;

      let result;
      try {
        result = await loadSearchPage(page, url, { site: search.site, robotsText });
      } catch (err) {
        if (err instanceof ChallengeError) throw partial(err);
        if (err instanceof InconclusiveError && ++refusals.n >= MAX_CONSECUTIVE_REFUSALS) {
          throw partial(new ChallengeError(`${SITES[search.site].label}: ${refusals.n} results requests in a row failed or were refused (last: ${err.message}) — treated as a refusal`));
        }
        errors.push({ keyword, error: err.message });
        break;
      }
      refusals.n = 0;
      anonymous += result.anonymous;
      log(`  ${SITES[search.site].label} "${keyword}" p${pageNo}: ${result.postings.length} postings${result.total != null ? ` (of ${result.total})` : ''}\n`);
      found.push(...result.postings);
      // The end of the results is judged on the rows the page carried, not on how
      // many survived parsing, and on the total the board reports.
      if (result.rawCount < PAGE_SIZE || (result.total != null && pageNo * PAGE_SIZE >= result.total)) break;
    }
  }
  return { found, errors, navigations, anonymous };
}

// ── CLI ──────────────────────────────────────────────────────────────

const KNOWN_FLAGS = ['--dry-run', '--site', '--keyword', '--since', '--help', '-h'];
const VALUE_FLAGS = ['--site', '--keyword', '--since'];

const USAGE = `Usage:
  node scan-navent.mjs
  node scan-navent.mjs --dry-run
  node scan-navent.mjs --site zonajobs        # bumeran | zonajobs
  node scan-navent.mjs --keyword "devops"
  node scan-navent.mjs --since 7              # only postings published in the last 7 days
  node scan-navent.mjs --help|-h              # print this usage block and exit`;

async function fetchRobots(context, site) {
  const url = `https://${SITES[site].host}/robots.txt`;
  const res = await context.request.get(url, { timeout: 20_000, maxRedirects: 0 });
  const status = res.status();
  if (status === 404) return '';
  // robots.txt is judged by its status only: its body legitimately says things like "Disallow: /captcha/".
  const blocked = detectChallenge({ status });
  if (blocked) throw new ChallengeError(`${SITES[site].label}: ${blocked} reading robots.txt`);
  if (status < 200 || status >= 300) throw new Error(`${SITES[site].label}: robots.txt answered HTTP ${status} — not scanning without knowing the rules`);
  return res.text();
}

async function main(args) {
  const DRY_RUN = hasFlag(args, '--dry-run');
  const onlySite = flagValue(args, '--site') ?? null;
  const onlyKeyword = flagValue(args, '--keyword') ?? null;
  const since = parseSinceDays(args);
  if (since.error) {
    console.error(`Error: ${since.error}`);
    process.exit(1);
  }
  if (onlySite && !Object.hasOwn(SITES, onlySite.toLowerCase())) {
    console.error(`Error: --site expects one of ${Object.keys(SITES).join(', ')}`);
    process.exit(1);
  }

  let config = {};
  if (existsSync(PORTALS_PATH)) config = loadYaml(readFileSync(PORTALS_PATH, 'utf-8')) || {};

  let searches = resolveSearches(config.navent_searches);
  if (onlySite) searches = searches.filter((s) => s.site === onlySite.toLowerCase());
  if (onlyKeyword) {
    const slug = slugifyKeyword(onlyKeyword);
    if (!slug) {
      console.error('Error: --keyword needs a word or phrase');
      process.exit(1);
    }
    searches = searches.map((s) => ({ ...s, keywords: [slug] }));
  }
  if (searches.length === 0) {
    console.error('Error: nothing to scan after --site/--keyword');
    process.exit(1);
  }

  const matchesTitle = buildTitleFilter(config.title_filter);
  const matchesLocation = buildLocationFilter(config.location_filter);
  const effectiveAfter = resolveEffectiveAfter(null, since.days);
  const matchesDate = buildPostedDateFilter(effectiveAfter, null);

  mkdirSync(`${getCareerOpsRoot()}/data`, { recursive: true });
  const { seen } = loadSeenUrls();
  const date = localToday();

  const newOffers = [];
  const titleSkipped = [];
  const locationSkipped = [];
  const dateSkipped = [];
  const dupeSkipped = [];
  const roleKeys = new Set();
  const seenInRun = new Set();
  const robotsCache = new Map();
  const refusals = { n: 0 };
  let anonymousDropped = 0;
  const errors = [];
  let totalFound = 0;
  let navigations = 0;
  let stopped = null;

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: DEFAULT_USER_AGENT,
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
  });
  const page = await context.newPage();
  // No images, media or fonts: the results come as JSON and the text is all that is read.
  await page.route('**/*', (route) => (['image', 'media', 'font'].includes(route.request().resourceType()) ? route.abort() : route.continue()));

  const budget = { left: MAX_NAVIGATIONS };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    for (const search of searches) {
      let robotsText = robotsCache.get(search.site);
      if (robotsText === undefined) {
        try {
          robotsText = await fetchRobots(context, search.site);
          robotsCache.set(search.site, robotsText);
        } catch (err) {
          if (err instanceof ChallengeError) throw err;
          errors.push({ keyword: SITES[search.site].label, error: err.message });
          continue;
        }
      }
      let result;
      let challenge = null;
      try {
        result = await runSearch(page, search, { sleep, budget, robotsText, refusals, log: (s) => process.stdout.write(s) });
      } catch (err) {
        if (!(err instanceof ChallengeError)) throw err;
        // Keep what was collected before the refusal.
        challenge = err;
        result = { found: err.found ?? [], errors: err.errors ?? [], navigations: err.navigations ?? 0, anonymous: err.anonymous ?? 0 };
      }
      navigations += result.navigations;
      errors.push(...result.errors);
      anonymousDropped += result.anonymous;

      for (const offer of result.found) {
        // One URL is one posting, however many keywords or pages returned it.
        if (seenInRun.has(offer.url)) continue;
        seenInRun.add(offer.url);
        totalFound++;
        if (!matchesTitle(offer.title)) { titleSkipped.push(offer); continue; }
        if (!matchesLocation(offer.location, offer.url, offer.title)) { locationSkipped.push(offer); continue; }
        if (!matchesDate(offer.postedAt)) { dateSkipped.push(offer); continue; }
        if (seen.has(offer.url)) { dupeSkipped.push(offer); continue; }
        seen.add(offer.url);
        // The same posting is often published on both boards, or once per branch:
        // one company + role is one entry in this run.
        const roleKey = companyRoleDedupKey(offer.company, offer.title);
        if (roleKeys.has(roleKey)) { dupeSkipped.push(offer); continue; }
        roleKeys.add(roleKey);
        newOffers.push(offer);
      }
      if (challenge) { stopped = challenge.message; break; }
    }
  } catch (err) {
    if (err instanceof ChallengeError) stopped = err.message;
    else throw err;
  } finally {
    await context.close();
    await browser.close();
  }

  if (!DRY_RUN) {
    if (newOffers.length > 0) await appendToPipeline(newOffers);
    if (newOffers.length > 0) await appendToScanHistory(newOffers, date, 'added');
    // title and date cuts are NOT recorded: scan-history treats most skipped_* rows as
    // "seen", and both cuts are ones the user edits (title_filter, --since), so a row
    // written under today's setting would bury the posting once it changes.
    // skipped_location is observational (no dedup weight) and, like skipped_dup,
    // is written once per URL rather than once per scan.
    const historyText = existsSync(SCAN_HISTORY_PATH) ? readFileSync(SCAN_HISTORY_PATH, 'utf-8') : '';
    const newLocationRows = unrecordedOffers(locationSkipped, 'skipped_location', historyText);
    const newDupeRows = unrecordedOffers(dupeSkipped, 'skipped_dup', historyText);
    if (newLocationRows.length > 0) await appendToScanHistory(newLocationRows, date, 'skipped_location');
    if (newDupeRows.length > 0) await appendToScanHistory(newDupeRows, date, 'skipped_dup');
  }

  printScanSummaryHeader('Navent Scan (Bumeran / ZonaJobs)', date);
  console.log(`Navigations:        ${navigations} (cap ${MAX_NAVIGATIONS})`);
  console.log(`Total found:        ${totalFound}`);
  console.log(`No employer (dropped): ${anonymousDropped}`);
  console.log(`Filtered by title:  ${titleSkipped.length}`);
  console.log(`Filtered location:  ${locationSkipped.length}`);
  console.log(`Filtered by date:   ${dateSkipped.length}`);
  console.log(`Duplicates:         ${dupeSkipped.length}`);
  console.log(`New offers:         ${newOffers.length}`);

  if (stopped) {
    console.log(`\nSTOPPED — ${stopped}`);
    console.log('The scanner does not solve or work around challenges. Nothing further was requested; try again later.');
  }
  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) console.log(`  ✗ "${e.keyword}": ${e.error}`);
  }
  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    console.log(DRY_RUN ? '\n(dry run — not saved)' : '\nSaved to data/pipeline.md');
  }
  console.log('\n→ Run /career-ops pipeline to evaluate new offers.');
  if (stopped) process.exitCode = 2;
}

// Guarded like every sibling scanner: merely importing this module (as the tests
// do) must never open a browser or touch the user's pipeline.
if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });
  main(args).catch((err) => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
