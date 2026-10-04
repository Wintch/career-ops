// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Computrabajo provider — Latin America's largest generalist job board, one
// site per country (https://ar.computrabajo.com, mx., co., cl., pe., …). Wire
// in via a `job_boards:` entry; each entry is ONE country and one or more
// search keywords:
//
//   - name: Computrabajo — Argentina
//     careers_url: https://ar.computrabajo.com/       # country comes from the host
//     searchKeywords: [devops, sre, sysadmin]          # required, one pass each
//     searchLocation: capital-federal                  # optional location slug
//     max_pages: 3                                     # optional, default 5, cap 25
//
// `detect()` claims any `https://{cc}.computrabajo.com` URL; `provider:
// computrabajo` + `country: ar` also works. Only the HOST of `careers_url` is
// read — the path is discarded and rebuilt (`/trabajo-de-{keyword}[-en-{location}]`),
// the board's own search-URL shape.
//
// SOURCE CHECK (measured 2026-10-04, with the scanner's declared User-Agent):
//   - listing pages are server-rendered over plain HTTPS: 20 postings per page
//     in <article class="box_offer"> cards, no login, no JS, no challenge; page
//     N is `?p=N` and the last page is short (38 results → 20 + 18);
//   - robots.txt (`User-agent: *`) disallows the filter-parameter variants
//     (`/ofertas-de-trabajo/*dis=`, `*pubdate=`, `*sal=` …), `/hojas-de-vida/`,
//     `/curriculums/`, `/Ajax/`, `/_services/`, `/go/` and the print view. None
//     is requested here: only `/trabajo-de-{keyword}[-en-{location}]` and `?p=N`;
//   - 18 country hosts answered with real listings (the list below);
//   - the card carries employer, location, a relative "posted" label, and
//     optionally salary text and work modality.
//
// PARSING CONTRACT. Each posting is `<article class="box_offer …">` holding the
// title anchor (`/ofertas-de-trabajo/oferta-de-trabajo-de-{slug}-{32 hex id}`),
// the employer anchor (`offer-grid-article-company-url`), the location span and
// the posted label. A page that parses to nothing is told apart three ways: the
// board's own "no hay ofertas" notice → [] (a quiet query); a result-count
// heading or posting links but no cards parsed → THROW (markup changed); not a
// Computrabajo page at all (block / error page) → THROW. A broken parser must
// not read as a market with no jobs.

import { fetchTextWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

/** Country hosts that answered with real listings on 2026-10-04. */
const COUNTRIES = new Set([
  'ar', 'mx', 'co', 'cl', 'pe', 'ec', 'uy', 've', 'bo',
  'cr', 'do', 'gt', 'hn', 'ni', 'pa', 'py', 'sv', 'pr',
]);

/** The board serves 20 postings per page; a shorter page is the last one. */
const PAGE_SIZE = 20;
const DEFAULT_MAX_PAGES = 5;
/** Hard ceiling on a configured `max_pages` — independent of what the source reports. */
const MAX_PAGES_CAP = 25;
/** Keywords one entry may fan out over (each one costs up to `max_pages` requests). */
const MAX_KEYWORDS = 8;
/** Pause between ANY two requests to the board (pages and keyword passes alike). */
const REQUEST_DELAY_MS = 1500;
const MAX_SLUG_LENGTH = 60;

const CARD_RE = /<article\b[^>]*class=["'][^"']*\bbox_offer\b[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi;
const TITLE_ANCHOR_RE = /<h2\b[^>]*>\s*<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i;
const POSTING_PATH_RE = /^\/ofertas-de-trabajo\/oferta-de-trabajo-de-[a-z0-9-]+-[A-F0-9]{32}$/;
const ANY_POSTING_LINK_RE = /href=["'][^"']*\/ofertas-de-trabajo\/oferta-de-trabajo-de-[a-z0-9-]+-[A-F0-9]{32}/i;
const COMPANY_RE = /<a\b[^>]*offer-grid-article-company-url[^>]*>([\s\S]*?)<\/a>/i;
const COMPANY_RE_ATTR_FIRST = /<a\b[^>]*href=["'][^"']*["'][^>]*offer-grid-article-company-url[^>]*>([\s\S]*?)<\/a>/i;
/** Every `fs16` paragraph in a card; the employer line also carries one, so the location is picked by content. */
const FS16_PARAGRAPH_RE = /<p\b[^>]*class=["'][^"']*\bfs16\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/gi;
const POSTED_RE = /<p\b[^>]*class=["'][^"']*\bfc_aux\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i;
const SALARY_RE = /<span\b[^>]*class=["'][^"']*\bi_salary\b[^"']*["'][^>]*><\/span>([\s\S]*?)<\/span>/i;
const MODALITY_RE = /<span\b[^>]*class=["'][^"']*\bi_home\b[^"']*["'][^>]*><\/span>([\s\S]*?)<\/span>/i;
const RESULT_COUNT_H1_RE = /<h1\b[^>]*>[\s\S]*?<span\b[^>]*>\s*([\d.,]+)\s*<\/span>/i;
const NO_RESULTS_RE = /no\s+hay\s+ofertas\s+para\s+el\s+empleo/i;

const MONTHS = /** @type {Record<string, number>} */ ({
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
  julio: 6, agosto: 7, septiembre: 8, setiembre: 8, octubre: 9, noviembre: 10, diciembre: 11,
});

/**
 * Visible text of a markup fragment.
 * @param {string} fragment
 * @returns {string}
 */
export function visibleText(fragment) {
  return decodeEntities(String(fragment ?? '').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Lowercase ASCII slug as the board builds its own search URLs: accents
 * stripped, anything non-alphanumeric collapsed to a single hyphen.
 * Returns '' for input with nothing usable.
 * @param {any} value
 * @returns {string}
 */
export function slugify(value) {
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
 * Country code from a `{cc}.computrabajo.com` hostname, or null. Anchored on
 * the WHOLE host and the allowlist — `ar.computrabajo.com.evil.example` and
 * `notar.computrabajo.com` both fail.
 * @param {string} hostname
 * @returns {string | null}
 */
export function countryFromHost(hostname) {
  const m = /^([a-z]{2})\.computrabajo\.com$/.exec(String(hostname ?? '').toLowerCase());
  return m && COUNTRIES.has(m[1]) ? m[1] : null;
}

/**
 * Country from a `careers_url` / `api` value: https only, host-anchored, or null.
 * @param {any} raw
 * @returns {string | null}
 */
function countryFromUrl(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  return countryFromHost(parsed.hostname);
}

/**
 * Resolve the country for an entry: an explicit `country`, else the host of
 * `careers_url`. Throws on a configured value that is not a known country (a
 * typo must be loud) and returns null only when nothing was configured.
 * @param {any} entry
 * @returns {string | null}
 */
export function resolveCountry(entry) {
  if (entry?.country !== undefined && entry?.country !== null && entry?.country !== '') {
    const c = typeof entry.country === 'string' ? entry.country.trim().toLowerCase() : '';
    if (!COUNTRIES.has(c)) {
      throw new Error(`computrabajo: unknown country ${JSON.stringify(entry.country)} — expected one of ${[...COUNTRIES].join(', ')}`);
    }
    return c;
  }
  return countryFromUrl(entry?.careers_url) ?? countryFromUrl(entry?.api);
}

/**
 * Keywords to search, as slugs, deduped, in config order.
 * @param {any} entry
 * @returns {string[]}
 */
export function resolveKeywords(entry) {
  const raw = entry?.searchKeywords;
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const out = [];
  for (const k of list) {
    const slug = slugify(k);
    if (!slug) {
      throw new Error(`computrabajo: invalid searchKeywords entry ${JSON.stringify(k)} — expected a non-empty word or phrase`);
    }
    if (!out.includes(slug)) out.push(slug);
  }
  if (!out.length) {
    throw new Error('computrabajo: set `searchKeywords` (a word/phrase or a list) on the entry — the board has no keyword-less listing');
  }
  if (out.length > MAX_KEYWORDS) {
    throw new Error(`computrabajo: ${out.length} searchKeywords configured — cap is ${MAX_KEYWORDS} (each one costs up to max_pages requests)`);
  }
  return out;
}

/**
 * Listing URL for one keyword/page. The origin is rebuilt from the allowlisted
 * country code, never taken from config.
 * @param {string} country
 * @param {string} keywordSlug
 * @param {string} locationSlug
 * @param {number} page
 * @returns {string}
 */
export function buildListUrl(country, keywordSlug, locationSlug, page) {
  const path = `/trabajo-de-${keywordSlug}${locationSlug ? `-en-${locationSlug}` : ''}`;
  return `https://${country}.computrabajo.com${path}${page > 1 ? `?p=${page}` : ''}`;
}

/**
 * Parse a Spanish "posted" label into epoch ms. Relative labels are anchored
 * to `nowMs` (so they are as precise as the label: "hace 3 días" is ±1 day);
 * an absolute "25 de septiembre" assumes the current year, or the previous one
 * when that would be in the future. Unparseable → undefined (never invented).
 * @param {string} label
 * @param {number} [nowMs]
 * @returns {number | undefined}
 */
export function parsePostedAt(label, nowMs = Date.now()) {
  const t = String(label ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  if (/^(hoy|ahora)\b/.test(t)) return nowMs;
  if (/^ayer\b/.test(t)) return nowMs - 86_400_000;
  const rel = /^hace (\d+) (minuto|hora|d[ií]a|semana|mes)/.exec(t);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const ms = unit.startsWith('minuto') ? 60_000
      : unit.startsWith('hora') ? 3_600_000
      : unit.startsWith('d') ? 86_400_000
      : unit.startsWith('semana') ? 7 * 86_400_000
      : 30 * 86_400_000;
    return nowMs - n * ms;
  }
  const abs = /^(\d{1,2}) de ([a-záéíóú]+)/.exec(t);
  if (abs && Object.hasOwn(MONTHS, abs[2])) {
    const now = new Date(nowMs);
    let year = now.getUTCFullYear();
    let ms = Date.UTC(year, MONTHS[abs[2]], Number(abs[1]));
    if (ms > nowMs + 86_400_000) ms = Date.UTC(year - 1, MONTHS[abs[2]], Number(abs[1]));
    const back = new Date(ms);
    if (back.getUTCDate() !== Number(abs[1])) return undefined; // 31 de febrero etc.
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

/**
 * The card's location text: the `fs16` paragraph that is NOT the employer line
 * (which holds the company anchor and the star rating).
 * @param {string} card
 * @returns {string}
 */
function locationOf(card) {
  FS16_PARAGRAPH_RE.lastIndex = 0;
  let m;
  while ((m = FS16_PARAGRAPH_RE.exec(card)) !== null) {
    const inner = m[1];
    if (/<a\b/i.test(inner) || /class=["'][^"']*\bstar\b/i.test(inner)) continue;
    const text = visibleText(inner);
    if (text) return text;
  }
  return '';
}

/**
 * Parse one listing page into postings.
 *
 * @param {string} html
 * @param {string} country - allowlisted country code (builds the absolute URL)
 * @param {number} [nowMs]
 * @returns {{ jobs: {title: string, url: string, company: string, location: string, description?: string, postedAt?: number}[], rawCards: number }}
 *   `rawCards` is the number of cards the SOURCE returned — the short-page stop
 *   reads it, never the filtered count.
 */
export function parseListingPage(html, country, nowMs = Date.now()) {
  const source = String(html ?? '');
  /** @type {Map<string, any>} */
  const byUrl = new Map();
  let rawCards = 0;

  CARD_RE.lastIndex = 0;
  let m;
  while ((m = CARD_RE.exec(source)) !== null) {
    rawCards++;
    const card = m[1];
    const a = TITLE_ANCHOR_RE.exec(card);
    if (!a) continue;
    // Drop the tracking fragment (`#lc=ListOffers-…`) and any query: the path
    // alone identifies the posting, and only its exact shape reaches job.url.
    const path = a[1].trim().split('#')[0].split('?')[0];
    if (!POSTING_PATH_RE.test(path)) continue;
    const title = visibleText(a[2]);
    if (!title) continue;

    const url = `https://${country}.computrabajo.com${path}`;
    if (byUrl.has(url)) continue;

    const cm = COMPANY_RE_ATTR_FIRST.exec(card) ?? COMPANY_RE.exec(card);
    const location = locationOf(card);
    const pm = POSTED_RE.exec(card);
    const sm = SALARY_RE.exec(card);
    const mm = MODALITY_RE.exec(card);

    const notes = [];
    const salary = sm ? visibleText(sm[1]) : '';
    const modality = mm ? visibleText(mm[1]) : '';
    if (salary) notes.push(`Salario: ${salary}`);
    if (modality) notes.push(`Modalidad: ${modality}`);
    const postedAt = pm ? parsePostedAt(visibleText(pm[1]), nowMs) : undefined;

    byUrl.set(url, {
      title,
      url,
      company: cm ? visibleText(cm[1]) : '',
      location,
      ...(notes.length ? { description: notes.join(' | ') } : {}),
      ...(postedAt !== undefined ? { postedAt } : {}),
    });
  }

  return { jobs: [...byUrl.values()], rawCards };
}

/**
 * Tell a quiet query from a broken page when nothing parsed.
 * @param {string} html
 * @param {string} url
 */
export function assertParsedSomething(html, url) {
  const source = String(html ?? '');
  if (NO_RESULTS_RE.test(source)) return; // the board's own "no hay ofertas" notice
  const count = RESULT_COUNT_H1_RE.exec(source);
  if (ANY_POSTING_LINK_RE.test(source) || (count && Number(count[1].replace(/\D/g, '')) > 0)) {
    throw new Error(`computrabajo: ${url} still reports results but none could be parsed — the listing markup changed`);
  }
  throw new Error(`computrabajo: ${url} did not return a listing or a "no results" page — blocked or the page changed`);
}

/** @type {Provider} */
export default {
  id: 'computrabajo',

  detect(entry) {
    try {
      // Explicit selection may carry the country in `country:`; the URL-pattern
      // claim reads ONLY the host of careers_url/api, so an unrelated entry that
      // merely has a `country` key is never taken.
      const country = entry?.provider === 'computrabajo'
        ? resolveCountry(entry)
        : countryFromUrl(entry?.careers_url) ?? countryFromUrl(entry?.api);
      return country ? { url: `https://${country}.computrabajo.com` } : null;
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const country = resolveCountry(entry);
    if (!country) {
      throw new Error('computrabajo: no country — set `careers_url: https://{cc}.computrabajo.com/` or `country: ar`');
    }
    const locationSlug = entry?.searchLocation === undefined || entry?.searchLocation === null || entry?.searchLocation === ''
      ? ''
      : slugify(entry.searchLocation);
    if (entry?.searchLocation && !locationSlug) {
      throw new Error(`computrabajo: invalid searchLocation ${JSON.stringify(entry.searchLocation)}`);
    }

    let keywords = resolveKeywords(entry);

    const entryMax = Number.isInteger(entry?.max_pages) && entry.max_pages > 0
      ? Math.min(entry.max_pages, MAX_PAGES_CAP)
      : DEFAULT_MAX_PAGES;
    const ctxMax = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0 ? ctx.maxPages : Infinity;
    const probing = Number.isFinite(ctxMax);
    const maxPages = Math.min(entryMax, ctxMax);
    // A health probe reads one page of one keyword — the same request budget as any other provider.
    if (probing) keywords = keywords.slice(0, 1);

    /** @type {any[]} */
    const jobs = [];
    const seen = new Set();
    let requests = 0;
    /** @type {string[]} */
    const truncated = [];

    for (const keyword of keywords) {
      for (let page = 1; page <= maxPages; page++) {
        if (requests > 0) await sleep(REQUEST_DELAY_MS, ctx);
        requests++;

        const url = buildListUrl(country, keyword, locationSlug, page);
        const html = await fetchTextWithRetry(ctx, url, { redirect: 'error' });
        const { jobs: parsed, rawCards } = parseListingPage(html, country);

        if (rawCards === 0) {
          // First page of a pass: empty vs broken. A later page running dry is just the end.
          if (page === 1) assertParsedSomething(html, url);
          break;
        }
        if (parsed.length === 0) {
          // Cards present but none usable: the card markup moved.
          throw new Error(`computrabajo: ${url} returned ${rawCards} cards but none carried a valid posting link — the listing markup changed`);
        }
        for (const job of parsed) {
          if (seen.has(job.url)) continue;
          seen.add(job.url);
          jobs.push(job);
        }
        // Short page = the source's own last page (raw count, never the deduped one).
        if (rawCards < PAGE_SIZE) break;
        if (page === maxPages && !probing && entryMax === maxPages) truncated.push(keyword);
      }
    }

    if (truncated.length) {
      console.warn(`computrabajo: ${country} stopped at max_pages=${maxPages} for "${truncated.join('", "')}" with more results available — raise max_pages on this entry`);
    }
    return jobs;
  },
};
