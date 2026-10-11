#!/usr/bin/env node

/**
 * scan-navent.mjs — Bumeran and ZonaJobs (Argentina) via a real browser
 *
 * Both boards run on the same platform and are client-rendered: a plain HTTPS
 * fetch returns an empty React shell, so no `providers/*.mjs` module can read
 * them (see "Evaluated, not supported" history in docs/SUPPORTED_JOB_BOARDS.md).
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
 *   - NO BYPASS. A challenge page (Cloudflare "Just a moment", a CAPTCHA, a
 *     403/429/503) stops the WHOLE run with a named error; it is never solved,
 *     retried around or relayed.
 *
 * LIGHT TOUCH. One person looking for a job, not a crawler:
 *   - identifies itself with the shared career-ops User-Agent;
 *   - reads each site's robots.txt on every run and skips any path it
 *     disallows (the board's own `/*recientes=true`, `/*?localidades=*`,
 *     `/empleos-busquedaext-` are never requested);
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
import * as yaml from 'js-yaml';
import {
  appendToPipeline, appendToScanHistory, loadSeenUrls, PORTALS_PATH,
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

/**
 * Whether a path (with query) may be fetched under a robots.txt, for this
 * scanner's own token (`career-ops`), falling back to the `*` group. Longest
 * matching pattern wins; Allow wins a tie; no matching rule → allowed.
 * @param {string} robotsText
 * @param {string} pathWithQuery e.g. `/empleos-busqueda-devops.html?page=2`
 * @returns {boolean}
 */
export function isAllowedByRobots(robotsText, pathWithQuery) {
  const groups = parseRobots(robotsText);
  const own = groups.filter((g) => g.agents.some((a) => a !== '*' && 'career-ops'.includes(a)));
  const star = groups.filter((g) => g.agents.includes('*'));
  const rules = (own.length ? own : star).flatMap((g) => g.rules);
  let best = null;
  for (const rule of rules) {
    if (!robotsPatternToRegExp(rule.pattern).test(pathWithQuery)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) best = rule;
  }
  return best ? best.allow : true;
}

/** Signals that a response is an interstitial or a refusal, not the search page. */
const CHALLENGE_TEXT_RE = /just a moment|verify(?:ing)? you are (?:a )?human|checking your browser|attention required|captcha|access denied|enable javascript and cookies to continue/i;

/**
 * Name the reason a response is a challenge/refusal, or null when it is not.
 * A challenge is never solved or worked around — the caller stops the run.
 * @param {{status?: number|null, title?: string, text?: string}} observed
 * @returns {string | null}
 */
export function detectChallenge({ status = null, title = '', text = '' } = {}) {
  if (status === 403 || status === 429 || status === 503) return `HTTP ${status}`;
  const hay = `${title ?? ''} ${String(text ?? '').slice(0, 4000)}`;
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
 * @returns {{title: string, url: string, company: string, location: string, description?: string, postedAt?: number, source: string}[]}
 */
export function parseSearchResponse(json, { site, hrefById = new Map() }) {
  const rows = json && Array.isArray(json.content) ? json.content : null;
  if (!rows) {
    const got = json && typeof json === 'object' ? Object.keys(json).join(', ') : typeof json;
    throw new Error(`scan-navent: unexpected search response — expected content[], got: [${got}]`);
  }
  const { host, source } = SITES[site];
  const out = [];
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

    const confidential = row.confidencial === true;
    const company = !confidential && typeof row.empresa === 'string' && row.empresa.trim() ? row.empresa.replace(/\s+/g, ' ').trim() : '?';
    const place = typeof row.localizacion === 'string' ? row.localizacion.replace(/\s+/g, ' ').trim() : '';
    const mode = typeof row.modalidadTrabajo === 'string' ? row.modalidadTrabajo.trim() : '';
    const location = place && mode ? `${place} (${mode})` : place || mode;
    const description = typeof row.detalle === 'string' && row.detalle.trim()
      ? row.detalle.trim().slice(0, MAX_DESCRIPTION_CHARS)
      : undefined;
    const postedAt = parsePublished(row.fechaHoraPublicacion, row.fechaPublicacion);

    out.push({
      title, url, company, location, source,
      ...(description ? { description } : {}),
      ...(postedAt !== undefined ? { postedAt } : {}),
    });
  }
  return out;
}

// ── Browser-facing step (page-like object injected, so tests need no browser) ──

/**
 * Open one search page and return what the page itself loaded.
 *
 * @param {any} page Playwright Page (or a stub with the same four methods)
 * @param {string} url
 * @param {{site: keyof typeof SITES}} opts
 * @returns {Promise<{postings: ReturnType<typeof parseSearchResponse>, total: number|null}>}
 */
export async function loadSearchPage(page, url, { site }) {
  // Registered BEFORE navigating: the page fires its own results call while it loads.
  const responsePromise = page.waitForResponse(
    (r) => SEARCH_API_RE.test(r.url()) && r.request().method() === 'POST',
    { timeout: SEARCH_RESPONSE_TIMEOUT_MS },
  ).catch((err) => err);

  const nav = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  const status = nav && typeof nav.status === 'function' ? nav.status() : null;

  const reply = await responsePromise;
  const title = await page.title().catch(() => '');
  const text = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
  const blocked = detectChallenge({ status, title, text });
  if (blocked) throw new ChallengeError(`${SITES[site].label}: ${blocked} at ${url}`);

  if (reply instanceof Error) {
    throw new Error(`scan-navent: ${SITES[site].label} never made its results request at ${url} (${reply.message.split('\n')[0]}) — the page changed or did not load`);
  }
  const replyStatus = typeof reply.status === 'function' ? reply.status() : 200;
  if (replyStatus === 403 || replyStatus === 429 || replyStatus === 503) {
    throw new ChallengeError(`${SITES[site].label}: results request answered HTTP ${replyStatus} at ${url}`);
  }
  const json = await reply.json();

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
  return { postings, total };
}

/** A challenge or refusal: the run stops, nothing is retried or worked around. */
export class ChallengeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChallengeError';
  }
}

/**
 * Run one site's searches, politely. Stops the whole walk by throwing
 * ChallengeError; returns what was collected for ordinary per-search errors.
 *
 * @param {any} page
 * @param {{site: keyof typeof SITES, keywords: string[], maxPages: number}} search
 * @param {{sleep: (ms: number) => Promise<void>, budget: {left: number}, robotsText: string, log?: (s: string) => void}} deps
 */
export async function runSearch(page, search, { sleep, budget, robotsText, log = () => {} }) {
  /** @type {ReturnType<typeof parseSearchResponse>} */
  const found = [];
  /** @type {{keyword: string, error: string}[]} */
  const errors = [];
  let navigations = 0;

  for (const keyword of search.keywords) {
    for (let pageNo = 1; pageNo <= search.maxPages; pageNo++) {
      const url = buildSearchUrl(search.site, keyword, pageNo);
      const pathWithQuery = url.replace(/^https:\/\/[^/]+/, '');
      if (!isAllowedByRobots(robotsText, pathWithQuery)) {
        errors.push({ keyword, error: `robots.txt disallows ${pathWithQuery} — skipped` });
        break;
      }
      if (budget.left <= 0) {
        errors.push({ keyword, error: `navigation cap (${MAX_NAVIGATIONS} per run) reached — stopped` });
        return { found, errors, navigations };
      }
      if (budget.left < MAX_NAVIGATIONS) await sleep(NAV_DELAY_MS);
      budget.left--;
      navigations++;

      let result;
      try {
        result = await loadSearchPage(page, url, { site: search.site });
      } catch (err) {
        if (err instanceof ChallengeError) throw err;
        errors.push({ keyword, error: err.message });
        break;
      }
      log(`  ${SITES[search.site].label} "${keyword}" p${pageNo}: ${result.postings.length} postings${result.total != null ? ` (of ${result.total})` : ''}\n`);
      found.push(...result.postings);
      // The page's own short page is the end of the results.
      if (result.postings.length < PAGE_SIZE) break;
    }
  }
  return { found, errors, navigations };
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
  const body = await res.text();
  const blocked = detectChallenge({ status, text: body });
  if (blocked) throw new ChallengeError(`${SITES[site].label}: ${blocked} reading robots.txt`);
  if (status < 200 || status >= 300) throw new Error(`${SITES[site].label}: robots.txt answered HTTP ${status} — not scanning without knowing the rules`);
  return body;
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
  if (existsSync(PORTALS_PATH)) config = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {};

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
      let robotsText;
      try {
        robotsText = await fetchRobots(context, search.site);
      } catch (err) {
        if (err instanceof ChallengeError) throw err;
        errors.push({ keyword: SITES[search.site].label, error: err.message });
        continue;
      }
      const result = await runSearch(page, search, { sleep, budget, robotsText, log: (s) => process.stdout.write(s) });
      navigations += result.navigations;
      errors.push(...result.errors);
      totalFound += result.found.length;

      for (const offer of result.found) {
        if (!matchesTitle(offer.title)) { seen.add(offer.url); titleSkipped.push(offer); continue; }
        if (!matchesLocation(offer.location, offer.url, offer.title)) { seen.add(offer.url); locationSkipped.push(offer); continue; }
        if (!matchesDate(offer.postedAt)) { seen.add(offer.url); dateSkipped.push(offer); continue; }
        if (seen.has(offer.url)) { dupeSkipped.push(offer); continue; }
        seen.add(offer.url);
        // The same posting is often published on both boards, or once per branch:
        // one company + role is one entry in this run (unknown employers `?` are never merged).
        if (offer.company !== '?') {
          const roleKey = companyRoleDedupKey(offer.company, offer.title);
          if (roleKeys.has(roleKey)) { dupeSkipped.push(offer); continue; }
          roleKeys.add(roleKey);
        }
        newOffers.push(offer);
      }
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
    if (titleSkipped.length > 0) await appendToScanHistory(titleSkipped, date, 'skipped_title');
    if (locationSkipped.length > 0) await appendToScanHistory(locationSkipped, date, 'skipped_location');
    if (dateSkipped.length > 0) await appendToScanHistory(dateSkipped, date, 'skipped_date');
    if (dupeSkipped.length > 0) await appendToScanHistory(dupeSkipped, date, 'skipped_dup');
  }

  printScanSummaryHeader('Navent Scan (Bumeran / ZonaJobs)', date);
  console.log(`Navigations:        ${navigations} (cap ${MAX_NAVIGATIONS})`);
  console.log(`Total found:        ${totalFound}`);
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
