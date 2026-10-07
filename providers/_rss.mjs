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

/**
 * Text of the first <tag>...</tag> in a block, '' when absent.
 * @param {string} block
 * @param {string} tag
 */
export function rssTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? extractText(m[1]) : '';
}

/**
 * Read the <item> blocks of an RSS 2.0 feed as { title, link, pubDateMs }.
 * `pubDateMs` is undefined when the date is missing or unparseable.
 * @param {unknown} xml
 * @returns {Array<{title: string, link: string, pubDateMs?: number}>}
 */
export function parseRssItems(xml) {
  if (typeof xml !== 'string') return [];
  const out = [];
  for (const item of xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || []) {
    const raw = rssTag(item, 'pubDate');
    const ms = raw ? Date.parse(raw) : NaN;
    out.push({
      title: rssTag(item, 'title'),
      link: rssTag(item, 'link'),
      ...(Number.isNaN(ms) ? {} : { pubDateMs: ms }),
    });
  }
  return out;
}

/**
 * Return `value` as an absolute https href when its host is `host` or a
 * subdomain of it; '' otherwise.
 * @param {string} value
 * @param {string} host
 */
export function trustedHttpsUrl(value, host) {
  if (!value) return '';
  try {
    const u = new URL(value.trim());
    const h = u.hostname.toLowerCase();
    return u.protocol === 'https:' && (h === host || h.endsWith(`.${host}`)) ? u.href : '';
  } catch {
    return '';
  }
}
