// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Alternativa Teatral provider — "Castings y convocatorias", the performing-arts
// call board of Argentina's best-known theatre portal
// (https://www.alternativateatral.com/convocatorias.php). Casting calls and open
// calls for actors, singers, dancers, musicians, technical and production crew,
// festivals and companies. Wire in via a `job_boards:` entry with
// `provider: alternativateatral`.
//
// Optional per-entry filters mirror the board's own facets; each is an integer
// id taken from the links on the page itself:
//   pais:          country id (1 = Argentina, 160 = Mexico, …)
//   provincia:     province/state id, used together with `pais`
//                  (e.g. pais 1 + provincia 587 = Ciudad Autónoma de Buenos Aires)
//   tipo:          remuneration — 0 no remunerado, 1 cooperativa, 2 remunerado
//   clasificacion: 1 festivals/events, 2 people, 3 shows, 4 other
// The list payload carries no per-posting location (and a filtered page stops
// listing countries), so `location` comes from an optional `location:` string
// on the entry — set it to e.g. "Argentina" when you filter by `pais`, so your
// location_filter sees it. Left unset it stays empty, which passes every filter.
//
// SOURCE CHECK (measured 2026-10-04):
//   - listing pages are server-rendered HTML over plain HTTPS — no challenge,
//     no login, no JS needed to see the postings;
//   - robots.txt (`User-agent: *`) disallows `/imprimir_convocatoria.asp`,
//     `/i_convocatoria.asp` and the mail/print variants, none of which this
//     provider requests. It also sets `Crawl-delay: 600`. That is the reason
//     this provider reads EXACTLY ONE page per scan and never paginates: one
//     request per scan keeps a regular scan cadence far under the delay the
//     operator asks for. The newest ~30 calls come first, so a scan run every
//     few days does not miss anything it would have wanted.
//   - the list carries no employer name (the poster is on the detail page),
//     so `company` is empty by contract (see `Job.company` in _types.js).
//
// PARSING CONTRACT. Each posting is one `<li>` holding the remuneration icon
// (`img/iconos.svg#remunerado|cooperativa|adhonorem`) and an anchor
// `<a href="casting{id}-{slug}">DD/MM/YYYY - Title</a>`. The anchors used are
// the posting href shape and the date-prefixed text. When the page still holds
// posting links but none parse, or is not the listing page at all (a block page,
// an error page), `fetch()` THROWS — a broken parser must not look like a quiet
// board. A listing page that is well-formed and has no postings returns [].

import { fetchTextWithRetry } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

const ORIGIN = 'https://www.alternativateatral.com';
const LIST_PATH = '/convocatorias.php';

/** Largest id accepted for a numeric filter — a config typo guard, not a board limit. */
const MAX_FILTER_ID = 99_999;

/** `casting{numeric id}` optionally followed by a hyphenated lowercase slug. */
const POSTING_HREF_RE = /^casting(\d+)(?:-([a-z0-9-]*))?$/i;

/** Any posting-shaped link — the "is this still the listing page" signal. */
const ANY_POSTING_LINK_RE = /href=["']casting\d+[^"']*["']/i;

/** The page's own heading; present on a real listing page even when it has no rows. */
const LISTING_HEADING_RE = /Castings y convocatorias/i;

/** One list item: window between <li> and </li> (the rows are never nested). */
const LI_RE = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;

/** The remuneration icon inside a row. */
const ICON_RE = /iconos\.svg#([a-z]+)/i;

/** The posting anchor inside a row. */
const ANCHOR_RE = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i;

/** Leading "DD/MM/YYYY - " label on the anchor text. */
const DATE_PREFIX_RE = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*[-–—]\s*/;

/** Remuneration as the board's icons name it → label shown to the candidate. */
const PAY_LABELS = /** @type {Record<string, string>} */ ({
  remunerado: 'Remunerado',
  cooperativa: 'Cooperativa',
  adhonorem: 'No remunerado',
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
 * NaN-safe `DD/MM/YYYY` → epoch ms (UTC midnight). Impossible calendar dates
 * (31/02) round-trip to a different day and are rejected rather than rolled over.
 * @param {string|number} day
 * @param {string|number} month
 * @param {string|number} year
 * @returns {number | undefined}
 */
export function toEpochMs(day, month, year) {
  const d = Number(day);
  const m = Number(month);
  const y = Number(year);
  if (![d, m, y].every(Number.isInteger)) return undefined;
  const ms = Date.UTC(y, m - 1, d);
  if (Number.isNaN(ms)) return undefined;
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return undefined;
  return ms;
}

/**
 * Validate one optional integer filter from the entry.
 * @param {any} entry
 * @param {'pais'|'provincia'|'tipo'|'clasificacion'} key
 * @param {number} min
 * @returns {number | undefined}
 */
function readFilter(entry, key, min) {
  const v = entry?.[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (!Number.isInteger(v) || v < min || v > MAX_FILTER_ID) {
    throw new Error(
      `alternativateatral: invalid ${key} ${JSON.stringify(v)} — expected an integer id from the board's own filter links`,
    );
  }
  return v;
}

/**
 * Build the listing URL for an entry. Only integer filters reach the query
 * string, in a fixed order, so nothing from `portals.yml` is interpolated raw.
 * @param {any} [entry]
 * @returns {string}
 */
export function buildListUrl(entry) {
  const params = [];
  const pais = readFilter(entry, 'pais', 1);
  const provincia = readFilter(entry, 'provincia', 1);
  const clasificacion = readFilter(entry, 'clasificacion', 1);
  const tipo = readFilter(entry, 'tipo', 0);
  if (pais !== undefined) params.push(`pais=${pais}`);
  if (provincia !== undefined) params.push(`provincia=${provincia}`);
  if (clasificacion !== undefined) params.push(`clasificacion=${clasificacion}`);
  if (tipo !== undefined) params.push(`tipo=${tipo}`);
  return `${ORIGIN}${LIST_PATH}${params.length ? `?${params.join('&')}` : ''}`;
}

/**
 * Entry-supplied location label: a short plain string, or ''.
 * @param {any} entry
 * @returns {string}
 */
export function readLocation(entry) {
  const v = entry?.location;
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 100) : '';
}

/**
 * Parse one listing page into postings.
 *
 * @param {string} html
 * @param {{ location?: string }} [opts]
 * @returns {{title: string, url: string, company: string, location: string, description?: string, postedAt?: number}[]}
 */
export function parseListingPage(html, opts = {}) {
  const source = String(html ?? '');
  const location = String(opts.location ?? '');
  /** @type {Map<string, any>} */
  const byUrl = new Map();

  LI_RE.lastIndex = 0;
  let li;
  while ((li = LI_RE.exec(source)) !== null) {
    const row = li[1];
    const a = ANCHOR_RE.exec(row);
    if (!a) continue;
    const href = a[1].trim();
    // Only posting hrefs, and only their safe charset — facet/menu links in
    // other <li>s fall out here, and nothing unvetted reaches the URL.
    if (!POSTING_HREF_RE.test(href)) continue;

    let text = visibleText(a[2]);
    let postedAt;
    const dm = DATE_PREFIX_RE.exec(text);
    if (dm) {
      postedAt = toEpochMs(dm[1], dm[2], dm[3]);
      text = text.slice(dm[0].length).trim();
    }
    if (!text) continue;

    const url = `${ORIGIN}/${href}`;
    if (byUrl.has(url)) continue;

    const icon = ICON_RE.exec(row);
    const pay = icon && Object.hasOwn(PAY_LABELS, icon[1].toLowerCase()) ? PAY_LABELS[icon[1].toLowerCase()] : '';

    byUrl.set(url, {
      title: text,
      url,
      company: '',
      location,
      ...(pay ? { description: `Remuneración: ${pay}` } : {}),
      ...(postedAt !== undefined ? { postedAt } : {}),
    });
  }

  return [...byUrl.values()];
}

/**
 * Tell a quiet board from a broken one when nothing parsed.
 *   - posting links present, no rows built → markup changed → throw;
 *   - not the listing page at all (block/error page) → throw;
 *   - the listing page, just empty (e.g. a filter with no calls) → return.
 * @param {string} html
 * @param {string} url
 */
export function assertParsedSomething(html, url) {
  const source = String(html ?? '');
  if (ANY_POSTING_LINK_RE.test(source)) {
    throw new Error(`alternativateatral: ${url} still contains posting links but none could be parsed — the listing markup changed`);
  }
  if (!LISTING_HEADING_RE.test(source)) {
    throw new Error(`alternativateatral: ${url} did not return the convocatorias listing page — blocked or the page changed`);
  }
}

/** @type {Provider} */
export default {
  id: 'alternativateatral',

  // Board-wide, branded host: explicit `provider:` only (no URL-pattern claim).
  detect(entry) {
    if (entry?.provider !== 'alternativateatral') return null;
    try {
      return { url: buildListUrl(entry) };
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    // Host is the fixed literal above, so there is no allowlist to apply; the
    // request still refuses redirects. ONE request per scan — see the header
    // (robots.txt Crawl-delay: 600). `ctx.maxPages` therefore needs no handling:
    // a health probe and a real scan issue the same single list request.
    const url = buildListUrl(entry);
    const html = await fetchTextWithRetry(ctx, url, { redirect: 'error' });

    const jobs = parseListingPage(html, { location: readLocation(entry) });
    if (jobs.length === 0) assertParsedSomething(html, url);
    return jobs;
  },
};
