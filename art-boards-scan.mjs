#!/usr/bin/env node
// Local add-on (not part of upstream career-ops): polls art/games job boards (ArtStation, Games Jobs Direct, Games Workshop) that
// scan.mjs has no provider for, keeps titles passing portals.yml title_filter, and
// appends unseen ones to data/pipeline.md + data/scan-history.tsv.
//   node art-boards-scan.mjs [--dry-run] [--only artstation|gamesjobsdirect|gamesworkshop|publishers|remotegamejobs|workwithindies]
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import * as yaml from 'js-yaml';
import {
  PORTALS_PATH, buildTitleFilter, buildLocationFilter, loadSeenUrls, normalizeUrlForDedup,
  appendToPipeline, appendToScanHistory,
} from './scan.mjs';
import { localToday } from './lib/local-today.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ArtStation ignores search params and shows only the ~30 newest postings,
// so it needs a real browser and a frequent schedule.
async function artstation() {
  const raw = execFileSync(process.execPath, [
    path.join(ROOT, 'browser-extract.mjs'), 'https://www.artstation.com/jobs/all',
    '--mode', 'listing', '--max', '200', '--timeout', '40000',
  ], { cwd: ROOT, encoding: 'utf-8', timeout: 120000 });
  const links = JSON.parse(raw).jobs || [];
  const JOB_RE = /^https:\/\/www\.artstation\.com\/jobs\/[A-Za-z0-9]{4}$/;
  const COMPANY_RE = /^https:\/\/www\.artstation\.com\/jobs\/c\//;
  // A company link follows its first posting; the extractor dedups links, so later
  // postings in the same company's contiguous group inherit the last company seen.
  const out = [];
  let lastCompany = 'ArtStation (company unlisted)';
  for (let i = 0; i < links.length; i++) {
    if (COMPANY_RE.test(links[i].url)) { lastCompany = links[i].title.trim(); continue; }
    if (!JOB_RE.test(links[i].url)) continue;
    const next = links[i + 1];
    const company = next && COMPANY_RE.test(next.url) ? next.title.trim() : lastCompany;
    out.push({ url: links[i].url, title: links[i].title.trim(), company });
  }
  return out;
}

// Games Jobs Direct ignores search params in the URL but paginates every job
// newest-first (~100/day), as static HTML cards.
async function gamesjobsdirect({ maxPages = 25, maxAgeDays = 2 } = {}) {
  const base = 'https://www.gamesjobsdirect.com';
  const cutoff = Date.now() - maxAgeDays * 86400000;
  const text = s => s.replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  const field = (card, cls) => text((card.match(new RegExp(`class="${cls}">([^<]*)<`)) || [])[1] || '');
  const CARD_RE = /<a href="(\/job\/[^"]+)" class="job-title"[^>]*>([^<]*)<\/a>([\s\S]*?)class="job-posteddate">Posted - (\d{2} \w{3} \d{4})/g;
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetch(`${base}/results?page=${page}`, { headers: { 'User-Agent': 'Mozilla/5.0 (career-ops personal job search)' } });
    if (!res.ok) throw new Error(`page ${page}: HTTP ${res.status}`);
    const html = await res.text();
    let cards = 0;
    let newest = -Infinity;
    for (const [, href, rawTitle, card, posted] of html.matchAll(CARD_RE)) {
      cards++;
      const postedMs = Date.parse(`${posted} UTC`);
      newest = Math.max(newest, postedMs);
      out.push({
        url: base + href,
        title: text(rawTitle),
        company: field(card, 'job-company') || 'Games Jobs Direct (company unlisted)',
        location: field(card, 'job-location'),
        postedAt: new Date(postedMs).toISOString(),
      });
    }
    if (cards === 0 || newest < cutoff) break;
    await sleep(1000);
  }
  return out;
}

// Games Workshop's portal 403s plain requests, so it goes through the browser.
// Its art department page is curated (every role there is art/design), so those
// postings skip the positive keywords — "Warhammer 40,000 Artist" matches none —
// and only the negative vetoes apply. Miniature painters are not illustration.
// The company-wide page catches design roles elsewhere (e.g. Black Library) via
// the normal title filter.
async function gamesworkshop() {
  const base = 'https://jobs.games-workshop.com/search-and-apply';
  const listing = url => JSON.parse(execFileSync(process.execPath, [
    path.join(ROOT, 'browser-extract.mjs'), url, '--mode', 'listing', '--max', '400', '--timeout', '45000',
  ], { cwd: ROOT, encoding: 'utf-8', timeout: 120000 })).jobs || [];
  const JOB_RE = /^https:\/\/jobs\.games-workshop\.com\/search-and-apply\/(?!jobs-by-)[a-z0-9-]+$/;
  const toPosting = (link, curated) => ({ url: link.url, title: link.title.trim(), company: 'Games Workshop', curated });
  const art = listing(`${base}/jobs-by-department/illustration-painting-graphic-design`)
    .filter(l => JOB_RE.test(l.url) && !/painter/i.test(l.title))
    .map(l => toPosting(l, true));
  const all = listing(base).filter(l => JOB_RE.test(l.url)).map(l => toPosting(l, false));
  const curatedUrls = new Set(art.map(p => p.url));
  return [...art, ...all.filter(p => !curatedUrls.has(p.url))];
}

// Publishers title their art roles "Designer", "Senior Designer, <imprint>" or
// "Art Director", which the global title_filter can't take without flooding the
// queue with Product/UX/Game Designers from tech companies. scan.mjs has no
// per-company override (title_filter_overrides is scan-ats-full.mjs only), so
// these boards are re-read here with extra per-company keywords; global
// negatives still apply and anything already seen is skipped.
const PUBLISHER_EXTRAS = {
  'Scholastic': ['Designer', 'Art Director'],
  'Hachette Book Group': ['Designer', 'Art Director'],
  'HarperCollins': ['Designer', 'Art Director'],
  'The New York Times': ['Designer', 'Art Director'],
  'Hearst': ['Designer', 'Art Director'],
  'Vox Media': ['Art Director'],
  'Future plc': ['Designer', 'Art Director'],
  'Rebellion': ['Open Art Application', 'Art Director', 'UI Artist', 'Environment Artist'],
  'Disney (incl. Marvel, National Geographic)': ['Art Director', 'Visual Development'],
  'Warner Bros. Discovery (incl. DC)': ['Art Director', 'Visual Development', 'UI Artist'],
};

// Extras like "Designer" also hit product/UX roles and test postings; veto those here only.
const PUBLISHER_EXTRA_NEGATIVE = ['Product Designer', 'Content Designer', 'UX', 'word:TEST'];

async function publishers() {
  const { loadProviders, resolveProvider } = await import('./providers/_registry.mjs');
  const { makeHttpCtx } = await import('./providers/_http.mjs');
  const providers = await loadProviders(path.join(ROOT, 'providers'));
  const out = [];
  for (const [name, extras] of Object.entries(PUBLISHER_EXTRAS)) {
    const entry = (config.tracked_companies || []).find(c => c.name === name && c.enabled !== false);
    if (!entry) continue;
    const resolved = resolveProvider(entry, providers, { skipIds: ['local-parser'] });
    if (!resolved || resolved.error) { console.error(`publishers: ${name}: no provider`); continue; }
    let jobs;
    try {
      jobs = await resolved.provider.fetch(entry, { ...makeHttpCtx({}), includeUndated: true });
    } catch (err) {
      console.error(`publishers: ${name}: ${err.message}`);
      continue;
    }
    const extraMatch = buildTitleFilter({ positive: extras, negative: [...(config.title_filter?.negative || []), ...PUBLISHER_EXTRA_NEGATIVE] });
    for (const j of jobs) {
      if (!j?.url || !j?.title) continue;
      out.push({ url: j.url, title: j.title, company: name, location: j.location, postedAt: j.postedAt, extraMatch });
    }
  }
  return out;
}

// Public RSS feeds of remote game jobs. Titles carry company/role (and, for
// Work With Indies, "to work from <place>"); only recent items are kept because
// boards like these resurface years-old postings elsewhere on their sites.
async function rssFeed(url, parseTitle, { maxAgeDays = 10 } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (career-ops personal job search)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const unescape = s => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  const tag = (item, t) => unescape((item.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || '');
  const cutoff = Date.now() - maxAgeDays * 86400000;
  const out = [];
  for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const postedMs = Date.parse(tag(item, 'pubDate'));
    if (!Number.isNaN(postedMs) && postedMs < cutoff) continue;
    const parsed = parseTitle(tag(item, 'title'));
    const url = tag(item, 'link');
    if (!parsed || !url) continue;
    out.push({ url, ...parsed, postedAt: Number.isNaN(postedMs) ? undefined : new Date(postedMs).toISOString() });
  }
  return out;
}

const remotegamejobs = () => rssFeed('https://remotegamejobs.com/feed.rss', t => {
  const m = t.match(/^(.*?) is hiring (.*?)\s*\(Remote Job\)\s*$/);
  return m ? { company: m[1], title: m[2], location: 'Remote' } : null;
});

const workwithindies = () => rssFeed('https://www.workwithindies.com/careers/rss.xml', t => {
  const m = t.match(/^(.*?) is hiring an? (.*?) to work from (.*)$/);
  return m ? { company: m[1], title: m[2], location: m[3] } : null;
});

const SOURCES = { artstation, gamesjobsdirect, gamesworkshop, publishers, remotegamejobs, workwithindies };

const config = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {};
const titleFilter = buildTitleFilter(config.title_filter);
const vetoOnly = buildTitleFilter({ negative: config.title_filter?.negative });
const passesTitle = p => (p.curated ? vetoOnly(p.title)
  : titleFilter(p.title) || (p.extraMatch ? p.extraMatch(p.title) : false));
const locationFilter = buildLocationFilter(config.location_filter);
const passesLocation = p => locationFilter(p.location, p.url, p.title);
const { seen } = loadSeenUrls();
let failures = 0;

for (const [name, fetchSource] of Object.entries(SOURCES)) {
  if (only && only !== name) continue;
  let postings;
  try {
    postings = await fetchSource();
  } catch (err) {
    failures++;
    console.error(`${name}: FAILED — ${err.message}`);
    continue;
  }
  if (postings.length === 0) {
    failures++;
    console.error(`${name}: no postings parsed — page layout may have changed`);
    continue;
  }
  const byUrl = new Map(postings.map(p => [normalizeUrlForDedup(p.url), p]));
  const titled = [...byUrl.values()].filter(passesTitle);
  const matched = titled.filter(passesLocation);
  const fresh = matched.filter(p => !seen.has(normalizeUrlForDedup(p.url)));
  console.log(`${new Date().toISOString()} ${name}: ${byUrl.size} postings, ${titled.length} match title_filter, ${titled.length - matched.length} dropped by location_filter, ${fresh.length} new`);
  for (const p of fresh) console.log(`  + ${p.company} | ${p.title}${p.location ? ` | ${p.location}` : ''} | ${p.url}`);
  if (!dryRun && fresh.length > 0) {
    await appendToPipeline(fresh);
    await appendToScanHistory(fresh, localToday());
    for (const p of fresh) seen.add(normalizeUrlForDedup(p.url));
  }
}

process.exit(failures > 0 ? 1 : 0);
