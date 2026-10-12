// @ts-check
// Tiny RSS <item> reader shared by the feed providers (remotegamejobs,
// workwithindies). Files prefixed with _ are never loaded as providers.
// Kept dependency-free on purpose, like nodesk.mjs and larajobs.mjs.

import { decodeEntities } from './_html-entities.mjs';

/** Resolve a tag's inner text: unwrap a CDATA section, else decode entities. */
function extractText(inner) {
  const cdata = inner.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdata) return cdata[1].trim();
  return decodeEntities(inner).trim();
}

/** Drop CDATA-wrapped description/content blocks so their markup never leaks into tag lookups. */
function stripBodyBlocks(block) {
  return block.replace(/<(description|content:encoded)\b[^>]*>\s*<!\[CDATA\[[\s\S]*?\]\]>\s*<\/\1>/gi, '');
}

/**
 * Text of the first <tag>...</tag> in a block, '' when absent. CDATA-wrapped
 * <description>/<content:encoded> blocks are ignored; the tag name must be
 * followed by whitespace, `>` or `/` so `<titles>` never matches `title`.
 * @param {string} block
 * @param {string} tag
 */
export function rssTag(block, tag) {
  const m = stripBodyBlocks(block).match(new RegExp(`<${tag}(?=[\\s>/])[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? extractText(m[1]) : '';
}

/**
 * Read the <item> blocks of an RSS 2.0 feed as { title, link, pubDateMs }.
 * `pubDateMs` is undefined when the date is missing or unparseable. `link`
 * falls back to a permalink <guid>.
 *
 * Empty vs broken: a body without an <rss>/<channel> envelope (challenge page,
 * Atom, JSON error, empty body) THROWS, as does a feed whose <item> blocks
 * yield no usable row. [] means a well-formed channel with no items.
 * @param {unknown} xml
 * @returns {Array<{title: string, link: string, pubDateMs?: number}>}
 */
export function parseRssItems(xml) {
  if (typeof xml !== 'string' || !/<(rss|channel)\b/i.test(xml)) {
    throw new Error('feed is not RSS (no <rss>/<channel> envelope): markup changed or a challenge page was served');
  }
  const blocks = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || [];
  const out = [];
  for (const item of blocks) {
    const raw = rssTag(item, 'pubDate');
    const ms = raw ? Date.parse(raw) : NaN;
    let link = rssTag(item, 'link');
    if (!link) {
      const g = item.match(/<guid\b([^>]*)>([\s\S]*?)<\/guid>/i);
      const candidate = g && !/isPermaLink\s*=\s*["']false["']/i.test(g[1]) ? extractText(g[2]) : '';
      if (/^https?:\/\//i.test(candidate)) link = candidate;
    }
    const title = rssTag(item, 'title');
    if (!title || !link) continue;
    out.push({ title, link, ...(Number.isNaN(ms) ? {} : { pubDateMs: ms }) });
  }
  if (blocks.length > 0 && out.length === 0) {
    throw new Error(`feed has ${blocks.length} <item> blocks but none parsed (title/link missing): markup changed`);
  }
  return out;
}

/**
 * Return `value` as an absolute https href when its host is `host` or a
 * subdomain of it, the port is the default one and the path starts with
 * `pathPrefix` (when given); '' otherwise.
 * @param {string} value
 * @param {string} host
 * @param {string} [pathPrefix]
 */
export function trustedHttpsUrl(value, host, pathPrefix = '') {
  if (!value) return '';
  try {
    const u = new URL(value.trim());
    const h = u.hostname.toLowerCase();
    const okHost = h === host || h.endsWith(`.${host}`);
    return u.protocol === 'https:' && okHost && u.port === '' && u.pathname.startsWith(pathPrefix) ? u.href : '';
  } catch {
    return '';
  }
}

/** True when `company` is empty or a placeholder (no identifiable employer). */
export function isUnattributed(company) {
  const c = String(company || '').trim();
  return !c || /^(confidential|confidencial|anonymous|undisclosed)$/i.test(c);
}
