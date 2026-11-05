#!/usr/bin/env node
/**
 * union-portals.mjs — one portals.yml that covers several people's scans
 *
 * A shared fetcher (docs/SHARED_FETCH.md) reads each job site once for everyone and
 * keeps the responses; each person's own scan then parses them. The fetcher has to
 * ask for the union of what the people ask for, so this script folds several
 * portals.yml files into one:
 *
 *   - Enabled `tracked_companies` and `job_boards` entries are de-duplicated by what
 *     they ask for (everything except name, notes, tags and enabled). Two people who
 *     track the same board produce one request, whatever they named it.
 *   - Entries that differ only in their keyword list (`keywords`, `searchKeywords`)
 *     are merged into one with the union of the words. `searchKeywords` is split
 *     again into groups of 8, which is the most a Computrabajo entry accepts.
 *   - `navent_searches` are merged per site, keywords unioned.
 *   - `title_filter.positive` is the union and `negative` what every file rejects:
 *     a few providers build their requests from the positive words, so a person's
 *     words must be in the union for that person's requests to be in the store.
 *   - Entries that need an agent (`scan_method: websearch`) are skipped: a headless
 *     fetcher cannot run them.
 *
 * The output says nothing about who asked for what: no names, no counts per file.
 *
 * Run: node union-portals.mjs --from a/portals.yml,b/portals.yml --out union.yml
 *      node union-portals.mjs --from a.yml,b.yml            (summary only, writes nothing)
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { dump } from 'js-yaml';
import { loadYaml } from './lib/yaml-document.mjs';
import { flagValue, validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const USAGE = `Usage: node union-portals.mjs --from <a.yml,b.yml,...> [--out <file>]
  --from <list>   the portals.yml files to fold together (at least one)
  --out <file>    write the union here (default: print a summary and write nothing)
  --help          print this usage block`;

const SEARCH_KEYWORD_CAP = 8;
const KEYWORD_FIELDS = ['keywords', 'searchKeywords'];
const IGNORED_FOR_IDENTITY = new Set(['name', 'notes', 'tags', 'enabled', 'max_pages', ...KEYWORD_FIELDS]);

/** Stable JSON of a value: object keys sorted, so field order never splits a group. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

const norm = (w) => String(w).trim().toLowerCase();

/** @param {Array<object>} entries enabled entries, in order */
export function mergeEntries(entries) {
  const groups = new Map();
  for (const e of entries) {
    if (!e || typeof e !== 'object' || e.enabled === false || e.scan_method === 'websearch') continue;
    const identity = {};
    for (const [k, v] of Object.entries(e)) if (!IGNORED_FOR_IDENTITY.has(k) && v !== undefined) identity[k] = v;
    const key = stable(identity);
    let g = groups.get(key);
    if (!g) {
      g = { base: { ...e, name: String(e.name ?? '').replace(/\s*\(\d+\/\d+\)\s*$/, '') }, words: Object.fromEntries(KEYWORD_FIELDS.map((f) => [f, new Map()])), maxPages: 0 };
      delete g.base.tags; delete g.base.notes; delete g.base.enabled;
      groups.set(key, g);
    }
    for (const f of KEYWORD_FIELDS) for (const w of Array.isArray(e[f]) ? e[f] : []) if (!g.words[f].has(norm(w))) g.words[f].set(norm(w), w);
    if (Number.isInteger(e.max_pages)) g.maxPages = Math.max(g.maxPages, e.max_pages);
  }
  const out = [];
  for (const g of groups.values()) {
    const entry = { ...g.base };
    delete entry.keywords; delete entry.searchKeywords; delete entry.max_pages;
    if (g.maxPages) entry.max_pages = g.maxPages;
    if (g.words.keywords.size) entry.keywords = [...g.words.keywords.values()];
    const search = [...g.words.searchKeywords.values()];
    if (search.length <= SEARCH_KEYWORD_CAP) {
      if (search.length) entry.searchKeywords = search;
      out.push({ ...entry, enabled: true });
    } else {
      const parts = Math.ceil(search.length / SEARCH_KEYWORD_CAP);
      for (let i = 0; i < parts; i++) {
        out.push({ ...entry, name: `${entry.name} (${i + 1}/${parts})`, searchKeywords: search.slice(i * SEARCH_KEYWORD_CAP, (i + 1) * SEARCH_KEYWORD_CAP), enabled: true });
      }
    }
  }
  return out;
}

/** @param {Array<Array<object>>} lists navent_searches of each file */
export function mergeNavent(lists) {
  const bySite = new Map();
  for (const list of lists) {
    for (const s of Array.isArray(list) ? list : []) {
      if (!s?.site) continue;
      const g = bySite.get(s.site) || { site: s.site, words: new Map(), max_pages: 0 };
      for (const w of s.keywords || []) if (!g.words.has(norm(w))) g.words.set(norm(w), w);
      if (Number.isInteger(s.max_pages)) g.max_pages = Math.max(g.max_pages, s.max_pages);
      bySite.set(s.site, g);
    }
  }
  return [...bySite.values()].map((g) => ({ site: g.site, keywords: [...g.words.values()], max_pages: g.max_pages || 1 }));
}

/** @param {Array<object>} docs parsed portals files */
export function unionPortals(docs) {
  const tracked = mergeEntries(docs.flatMap((d) => (Array.isArray(d?.tracked_companies) ? d.tracked_companies : [])));
  const boards = mergeEntries(docs.flatMap((d) => (Array.isArray(d?.job_boards) ? d.job_boards : [])));
  const positive = new Map();
  for (const d of docs) for (const w of d?.title_filter?.positive || []) {
    const k = norm(String(w).replace(/^(?:word|stem):/i, ''));
    if (!positive.has(k)) positive.set(k, w);
  }
  const negLists = docs.map((d) => (d?.title_filter?.negative || []).map((w) => norm(w)));
  const negative = (docs[0]?.title_filter?.negative || []).filter((w) => negLists.every((l) => l.includes(norm(w))));
  const out = {
    title_filter: { positive: [...positive.values()], negative },
    tracked_companies: tracked,
    job_boards: boards,
  };
  const navent = mergeNavent(docs.map((d) => d?.navent_searches));
  if (navent.length) out.navent_searches = navent;
  const overrides = docs.flatMap((d) => (Array.isArray(d?.title_filter_overrides) ? d.title_filter_overrides : []));
  if (overrides.length) out.title_filter_overrides = overrides;
  return out;
}

function main() {
  const args = process.argv.slice(2);
  validateFlags(args, ['--from', '--out', '--help', '-h'], USAGE, { valueFlags: ['--from', '--out'], requireOperand: true });
  const files = String(flagValue(args, '--from') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!files.length) { console.error('--from needs at least one portals.yml\n\n' + USAGE); process.exit(1); }
  const docs = files.map((f) => {
    if (!existsSync(f)) { console.error(`not found: ${f}`); process.exit(1); }
    return loadYaml(readFileSync(f, 'utf8')) || {};
  });
  const union = unionPortals(docs);
  const countIn = (key) => docs.reduce((n, d) => n + (Array.isArray(d[key]) ? d[key].filter((e) => e?.enabled !== false && e?.scan_method !== 'websearch').length : 0), 0);
  const summary = {
    files: files.length,
    trackedIn: countIn('tracked_companies'), trackedOut: union.tracked_companies.length,
    boardsIn: countIn('job_boards'), boardsOut: union.job_boards.length,
    naventSites: (union.navent_searches || []).length,
    titleKeywords: union.title_filter.positive.length,
    written: false,
  };
  const out = flagValue(args, '--out');
  if (out) {
    const header = '# Generated by union-portals.mjs for the shared fetcher. Do not edit; rebuild it.\n';
    const tmp = `${out}.tmp-${process.pid}`;
    writeFileSync(tmp, header + dump(union, { lineWidth: -1, noRefs: true }));
    renameSync(tmp, out);
    summary.written = true;
  }
  console.log(JSON.stringify(summary, null, 2));
}

if (isMainModule(import.meta.url)) main();
