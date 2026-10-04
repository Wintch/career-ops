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
// Optional candidate-fit filter, for boards whose titles state who is wanted
// ("actor de 40 a 50 años", "actrices", "hombres mayores de 50"):
//   edad:   the candidate's age (integer, 14-99)
//   genero: 'hombre' | 'mujer'
// Postings whose TITLE explicitly excludes the candidate are dropped; a title
// that says nothing about age or gender is kept (the call may still suit them).
// Kept postings that state an age range get it noted in `description`. The
// values live in the user's own portals.yml — nothing personal ships here.
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

/** Lowercase, accent-free text for keyword matching. */
function fold(text) {
  return String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** A single stated age ("de 30 años") is read as a playing age of ±5 years. */
const SINGLE_AGE_SPREAD = 5;

/**
 * Who a posting title says it wants.
 *   age     — {min, max} (either may be absent) or null when no age is stated
 *   genders — subset of ['hombre','mujer']; empty when the title is silent
 * Only the title is read, and only explicit wording counts.
 * @param {string} title
 * @returns {{age: {min?: number, max?: number} | null, genders: string[]}}
 */
export function parseCastingProfile(title) {
  const t = fold(title);
  /** @type {{min?: number, max?: number} | null} */
  let age = null;
  let m;
  if ((m = /(?:de|entre)\s+(\d{1,2})\s*(?:a|y|-)\s*(\d{1,2})\s*anos/.exec(t))
      || (m = /(\d{1,2})\s*(?:a|-)\s*(\d{1,2})\s*anos/.exec(t))) {
    age = { min: Math.min(+m[1], +m[2]), max: Math.max(+m[1], +m[2]) };
  } else if ((m = /(?:mayor(?:es)?\s+de|mas\s+de|desde(?:\s+los)?)\s+(\d{1,2})\s*anos/.exec(t))) {
    age = { min: +m[1] };
  } else if ((m = /(?:menor(?:es)?\s+de|hasta(?:\s+los)?)\s+(\d{1,2})\s*anos/.exec(t))) {
    age = { max: +m[1] };
  } else if ((m = /(?:\bde|aparente)\s+(\d{1,2})\s*anos/.exec(t))) {
    age = { min: +m[1] - SINGLE_AGE_SPREAD, max: +m[1] + SINGLE_AGE_SPREAD };
  }

  const male = /\b(actor(?:es)?|hombres?|masculin\w*|varon(?:es)?|chicos?|muchachos?|senor(?:es)?)\b/.test(t);
  const female = /\b(actriz|actrices|mujeres?|femenin\w*|chicas?|senoras?|bailarinas?)\b/.test(t);
  const genders = [];
  if (male) genders.push('hombre');
  if (female) genders.push('mujer');
  return { age, genders };
}

/**
 * Does the candidate fit what the title asks for? `false` only on an explicit
 * mismatch (age outside the stated range, or a gender the title never names).
 * @param {string} title
 * @param {{edad?: number, genero?: string}} candidate
 * @returns {boolean}
 */
export function fitsCandidate(title, candidate) {
  const { age, genders } = parseCastingProfile(title);
  if (age && Number.isInteger(candidate.edad)) {
    if (age.min !== undefined && candidate.edad < age.min) return false;
    if (age.max !== undefined && candidate.edad > age.max) return false;
  }
  if (candidate.genero && genders.length > 0 && !genders.includes(candidate.genero)) return false;
  return true;
}

/**
 * Read and validate the optional candidate-fit keys of an entry.
 * @param {any} entry
 * @returns {{edad?: number, genero?: string}}
 */
export function readCandidate(entry) {
  const out = {};
  const edad = entry?.edad;
  if (edad !== undefined && edad !== null && edad !== '') {
    if (!Number.isInteger(edad) || edad < 14 || edad > 99) {
      throw new Error(`alternativateatral: invalid edad ${JSON.stringify(edad)} — expected an integer from 14 to 99`);
    }
    out.edad = edad;
  }
  const genero = entry?.genero;
  if (genero !== undefined && genero !== null && genero !== '') {
    if (genero !== 'hombre' && genero !== 'mujer') {
      throw new Error(`alternativateatral: invalid genero ${JSON.stringify(genero)} — expected 'hombre' or 'mujer'`);
    }
    out.genero = genero;
  }
  return out;
}

/** Posting detail path: the same safe shape the listing hrefs are held to. */
const DETAIL_URL_RE = /^https:\/\/www\.alternativateatral\.com\/casting\d+(?:-[a-z0-9-]*)?$/i;

/**
 * Is this URL a casting detail page this provider may read?
 * (`/i_convocatoria.asp` and the print variants are disallowed by robots.txt.)
 * @param {string} url
 */
export function isDetailUrl(url) {
  return DETAIL_URL_RE.test(String(url ?? ''));
}

/**
 * Parse one casting detail page: what the poster wrote and where to answer.
 * Missing parts come back empty rather than throwing; a page that is not a
 * casting page at all (no `id="nombre"` heading) throws.
 * @param {string} html
 * @returns {{title: string, description: string, contact: string, emails: string[], deadline: string, remuneration: string, categories: string[]}}
 */
export function parseCastingDetail(html) {
  const source = String(html ?? '');
  const h1 = /<h1\b[^>]*id=["']nombre["'][^>]*>([\s\S]*?)<\/h1>/i.exec(source);
  if (!h1) throw new Error('alternativateatral: not a casting detail page (no title heading) — blocked or the page changed');
  const title = visibleText(h1[1]);
  const desc = /<div class=["']descripcion["']>([\s\S]*?)<\/div>/i.exec(source);
  const description = desc ? visibleText(desc[1].replace(/<br\s*\/?>/gi, '\n')) : '';
  const contactLi = /<li id=["']contactar["']>([\s\S]*?)<\/li>/i.exec(source);
  const contact = contactLi ? visibleText(contactLi[1]) : '';
  const emails = [...new Set(
    [...source.matchAll(/href=["']mailto:([^"'?\s]+)/gi)].map((x) => decodeEntities(x[1]).toLowerCase()),
  )];
  const deadlineHit = /Vencimiento[\s\S]{0,300}?(\d{2}\/\d{2}\/\d{4})/i.exec(source);
  const remHit = /Tipo de Remuneraci[oó]n[\s\S]{0,300}?(No remunerado|Remunerado|Cooperativa)/i.exec(source);
  const rubros = /Rubros[\s\S]{0,600}?<\/li>/i.exec(source);
  const categories = rubros
    ? [...rubros[0].matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map((x) => visibleText(x[1])).filter(Boolean)
    : [];
  return {
    title,
    description,
    contact,
    emails,
    deadline: deadlineHit ? deadlineHit[1] : '',
    remuneration: remHit ? remHit[1] : '',
    categories,
  };
}

/**
 * Fetch and parse ONE casting detail page. The caller paces calls (the board
 * asks Crawl-delay 600) — this does exactly one request.
 * @param {string} url
 * @param {any} ctx
 */
export async function fetchCastingDetail(url, ctx) {
  if (!isDetailUrl(url)) throw new Error(`alternativateatral: refusing to fetch ${JSON.stringify(url)} — not a casting detail URL`);
  const html = await fetchTextWithRetry(ctx, url, { redirect: 'error' });
  return parseCastingDetail(html);
}

/** @type {Provider} */
export default {
  id: 'alternativateatral',

  // Board-wide, branded host: explicit `provider:` only (no URL-pattern claim).
  detect(entry) {
    if (entry?.provider !== 'alternativateatral') return null;
    try {
      readCandidate(entry);
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

    const candidate = readCandidate(entry);
    const all = parseListingPage(html, { location: readLocation(entry) });
    if (all.length === 0) assertParsedSomething(html, url);
    return all
      .filter((j) => fitsCandidate(j.title, candidate))
      .map((j) => {
        const { age } = parseCastingProfile(j.title);
        if (!age || (age.min === undefined && age.max === undefined)) return j;
        const range = age.min !== undefined && age.max !== undefined ? `${age.min}-${age.max}` : age.min !== undefined ? `${age.min}+` : `hasta ${age.max}`;
        return { ...j, description: [j.description, `Edad pedida: ${range} años`].filter(Boolean).join(' · ') };
      });
  },
};
