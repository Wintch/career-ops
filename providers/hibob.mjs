// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// HiBob career-site provider — single-company ATS adapter, for `tracked_companies:`
// entries. Reads the public JSON that HiBob's own career-site front end renders.
// Auto-detects from a careers_url like `https://<tenant>.careers.hibob.com[/...]`.
//
// Measured live (2026-10-20, against the tenants liquidia, pns, proveai, paradium
// and uala — the last is an Argentine fintech with 18 postings, 13 in Argentina
// and 5 in Mexico):
//   - `robots.txt`: the host has none. `GET /robots.txt` answers 200 with the
//     Angular SPA shell (text/html) for every tenant, i.e. no Disallow rule of any
//     kind. Single-company ATS adapters clear the Source Indexing Policy by
//     construction anyway (one employer's own postings, one source).
//   - Endpoint: `GET https://<tenant>.careers.hibob.com/api/job-ad`. No login, no
//     cookie, no token. The one thing the endpoint wants is a
//     `companyIdentifier: <tenant>` request header, which the career site's own
//     front end attaches to every call (it is the subdomain, see its HTTP
//     interceptor). Without it the answer is a bare 401 — a tenant selector, not
//     a credential: the value is the public subdomain. An unknown tenant also
//     answers 401.
//   - The response is the whole board in one request, no pagination:
//       { filterGroups: { departments[], sites[], jobTypes[], workspaceTypes[] },
//         jobAdDetails: [ { id (uuid), title, department, employmentType,
//                           siteId, site, country, language ("en", "es", ...),
//                           description, requirements, responsibilities, benefits
//                           (HTML strings, any of them null), sectionLabels,
//                           publishedAt (ISO-8601, nanosecond precision),
//                           workspaceTypeId ("on_site" | "hybrid" | "remote"),
//                           payTransparencyMin/MaxSalary, ...Currency, ...PayPeriod
//                           (null unless the tenant publishes pay) } ] }
//     A tenant with a career site and no open roles answers 200 with
//     `jobAdDetails: []` (paradium).
//   - Posting page: `https://<tenant>.careers.hibob.com/jobs/<id>` (deep link
//     verified in a browser; `/jobs/<id>/apply` is the form). The list page
//     `/jobs` opens a posting in a side panel without changing the URL, so the
//     per-id path is the only stable permalink. That is the canonical URL here.
//   - The SPA also calls `/api/career-site` and `/api/toggles`; neither is
//     needed. There is no per-id JSON endpoint (`/api/job-ad/<id>` is 404), and
//     none is needed: the list payload already carries the full description.
//
// Per-tenant subdomains are the variable part, so SSRF defence is an anchored
// regex over the whole hostname (`<tenant>.careers.hibob.com`), and only the
// hostname is ever taken from the entry: the origin is rebuilt as
// `https://${hostname}` and the fixed `/api/job-ad` path appended (same approach
// as the breezy / bamboohr providers). The stage / sandbox / dev career-site
// hosts the front end also knows about are not matched.

import { fetchJsonWithRetry } from './_http.mjs';
import { htmlToText } from './_html-to-text.mjs';
import { coerceId } from './_ids.mjs';
import { safeEncodeURIComponent } from './_safe-url.mjs';

const HIBOB_HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.careers\.hibob\.com$/;

/** @param {string} url */
function assertHibobUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`hibob: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`hibob: URL must use HTTPS: ${url}`);
  if (!HIBOB_HOST_RE.test(parsed.hostname)) {
    throw new Error(`hibob: untrusted hostname "${parsed.hostname}" — must match <tenant>.careers.hibob.com`);
  }
  return url;
}

/**
 * Resolve `{ origin, tenant }` from an entry: `https://<tenant>.careers.hibob.com`
 * and the bare `<tenant>` label. Honours an explicit `api:` URL, else parses
 * `careers_url`. Only the hostname is read; any path or port is discarded.
 * @param {import('./_types.js').PortalEntry} entry
 * @returns {{ origin: string, tenant: string } | null}
 */
function resolveTenant(entry) {
  const rawApi = typeof entry?.api === 'string' ? entry.api : '';
  const rawCareers = typeof entry?.careers_url === 'string' ? entry.careers_url : '';
  const raw = (rawApi || rawCareers).trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (!HIBOB_HOST_RE.test(parsed.hostname)) return null;
  return { origin: `https://${parsed.hostname}`, tenant: parsed.hostname.split('.')[0] };
}

/** @type {Provider} */
export default {
  id: 'hibob',

  detect(entry) {
    const t = resolveTenant(entry);
    return t ? { url: `${t.origin}/api/job-ad` } : null;
  },

  async fetch(entry, ctx) {
    const t = resolveTenant(entry);
    if (!t) throw new Error(`hibob: cannot derive API URL for ${entry.name}`);
    const apiUrl = `${t.origin}/api/job-ad`;
    assertHibobUrl(apiUrl);
    // redirect:'error' + the host check above keep the final hostname pinned to
    // the tenant — a server-side redirect can't bounce us off-domain (SSRF).
    // The whole board comes back in one response (no pagination), so there is
    // no page walk to cap and nothing extra for a health probe to skip.
    const json = await fetchJsonWithRetry(ctx, apiUrl, {
      redirect: 'error',
      headers: { companyIdentifier: t.tenant },
    });
    return parseHibobResponse(json, entry.name, t.origin);
  },
};

/**
 * Whole-word, case-insensitive containment (same check as breezy's), so
 * "Buenos Aires, Argentina" is seen to already name "Argentina".
 * @param {string} text
 * @param {string} word
 */
function containsWholeWord(text, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

/** @param {unknown} v */
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * NaN-safe ISO date → epoch ms. HiBob's `publishedAt` carries nanosecond
 * precision ("2026-09-15T19:22:14.562309703Z"), which V8's Date.parse accepts.
 * @param {unknown} value
 * @returns {number | undefined}
 */
function toEpochMs(value) {
  if (!value || typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

// Annualization multipliers for `payTransparencySalaryPayPeriod`. Only "Annual"
// has been observed live; "Monthly" is the obvious sibling. Any other period (or
// none) leaves the salary off — guessing one would turn an hourly figure into a
// wrong annual one.
const PERIOD_MULTIPLIERS = { annual: 1, yearly: 1, monthly: 12 };

/**
 * Annualized pay-transparency range, or null when the posting publishes none.
 * @param {any} j
 * @returns {{min: number, max: number, currency: string} | null}
 */
function parseSalary(j) {
  const period = str(j.payTransparencySalaryPayPeriod).toLowerCase();
  if (!Object.hasOwn(PERIOD_MULTIPLIERS, period)) return null;
  const mult = PERIOD_MULTIPLIERS[/** @type {keyof typeof PERIOD_MULTIPLIERS} */ (period)];
  /** @param {unknown} v */
  const num = (v) => {
    if (typeof v !== 'number' && typeof v !== 'string') return null;
    if (typeof v === 'string' && v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n * mult : null;
  };
  const min = num(j.payTransparencyMinSalary);
  const max = num(j.payTransparencyMaxSalary);
  if (min == null && max == null) return null;
  const low = /** @type {number} */ (min ?? max);
  const high = /** @type {number} */ (max ?? min);
  return { min: Math.min(low, high), max: Math.max(low, high), currency: str(j.payTransparencySalaryCurrency).toUpperCase() };
}

/**
 * Parse a HiBob `/api/job-ad` response. Exported for unit tests.
 *
 * The documented container is `jobAdDetails[]`: present-and-empty is a genuinely
 * empty board (`[]`); a missing / wrong-typed container or a bare non-object body
 * is not the documented envelope and throws, naming what arrived.
 *
 * Field mapping → the normalized Job shape:
 *   - title:       `title`, trimmed (rows without one are dropped).
 *   - url:         `${origin}/jobs/${id}` — the public posting page, built from
 *                  the tenant origin (the payload carries no URL). Rows without a
 *                  usable `id` are dropped.
 *   - company:     the portal entry name (the feed is per-tenant).
 *   - location:    `site`, plus `country` when the site name doesn't already
 *                  contain it, plus "Remote" when `workspaceTypeId` is `remote`.
 *   - postedAt:    `publishedAt`, NaN-safe.
 *   - description: description + responsibilities + requirements + benefits
 *                  (HTML in the list payload, free) as plain text.
 *   - salary:      only when the tenant publishes pay transparency figures.
 *   - language:    `language` as given ("en", "es"); each ad is one language.
 *   - externalId:  the ad's own uuid.
 *
 * @param {any} json
 * @param {string} companyName
 * @param {string} origin  `https://<tenant>.careers.hibob.com`
 * @returns {Array<import('./_types.js').Job>}
 */
export function parseHibobResponse(json, companyName, origin) {
  const rows = json && typeof json === 'object' && Array.isArray(json.jobAdDetails) ? json.jobAdDetails : null;
  if (!rows) {
    const got = json && typeof json === 'object' ? Object.keys(json).join(', ') : typeof json;
    throw new Error(`hibob: unexpected response — expected jobAdDetails[], got: [${got}]`);
  }
  /** @type {Array<import('./_types.js').Job>} */
  const out = [];
  for (const j of rows) {
    if (!j || typeof j !== 'object') continue;
    const title = str(j.title);
    if (!title) continue;
    const id = coerceId(j.id);
    const seg = id ? safeEncodeURIComponent(id) : null;
    if (!seg) continue;

    const site = str(j.site);
    const country = str(j.country);
    let location = site || country;
    if (site && country && !containsWholeWord(site, country)) location = `${site}, ${country}`;
    if (str(j.workspaceTypeId).toLowerCase() === 'remote' && !/remote/i.test(location)) {
      location = location ? `${location}, Remote` : 'Remote';
    }

    /** @type {import('./_types.js').Job} */
    const job = {
      title,
      url: `${origin}/jobs/${seg}`,
      company: companyName,
      location,
      externalId: id,
    };

    const postedAt = toEpochMs(j.publishedAt);
    if (postedAt !== undefined) job.postedAt = postedAt;

    const body = [j.description, j.responsibilities, j.requirements, j.benefits]
      .filter((s) => typeof s === 'string' && s)
      .join('\n');
    const description = htmlToText(body);
    if (description) job.description = description;

    const lang = str(j.language);
    if (lang) job.language = lang;

    const salary = parseSalary(j);
    if (salary) job.salary = salary;

    out.push(job);
  }
  return out;
}
