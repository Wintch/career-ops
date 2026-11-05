#!/usr/bin/env node
/**
 * prescreen-location.mjs — zero-token location pre-screen for pending
 * pipeline lines.
 *
 * A scan can leave hundreds of `- [ ]` lines in data/pipeline.md whose
 * location puts them out of reach: on-site in another country, or "remote"
 * but restricted to a region the candidate cannot work from. Reading those
 * costs triage tokens for nothing. This script marks them `- [x]` with a
 * reason and logs each one in data/discard.log, so the discard stays
 * auditable (see modes/pipeline.md → Discard log).
 *
 * Dry run by default: prints counts per reason and the lines that SURVIVE,
 * so the survivors can be read by hand before anything is written. Always do
 * that: a location written in an unusual shape ("Remote - Greece",
 * "IND-Work from Home-Remote", a US state list, a bare "Remote" whose URL
 * slug says Remote-US) can still pass; discard those by hand with a reason.
 *
 * The home region is NOT guessed. Terms that keep a posting come from
 * portals.yml → location_filter (always_allow + allow, minus the generic
 * "Remote"/"Hybrid"), plus worldwide terms, plus any --keep given on the
 * command line. With no terms at all the script stops instead of discarding
 * everything.
 *
 * Usage:
 *   node prescreen-location.mjs [--file data/pipeline.md] [--log data/discard.log]
 *                               [--keep "Argentina,LatAm"] [--date YYYY-MM-DD]
 *                               [--apply] [--json]
 *
 * Only `- [ ] ` lines are looked at. A line with no location passes (the
 * location is simply not declared; triage reads the posting).
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { loadYaml } from './lib/yaml-document.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { withPipelineLock } from './pipeline-lock.mjs';

export const REASON_ONSITE = 'on-site outside the target region';
export const REASON_RESTRICTED = 'remote restricted to another region';

/** Terms that always keep a posting: it is open to candidates anywhere. */
export const WORLDWIDE_TERMS = ['worldwide', 'anywhere', 'global'];

const REMOTE_RE = /remote|remoto|home ?office|work from home|teletrabajo/i;
const EMPTY_RE = /^(posted:.*|)$/i;
const MULTI_RE = /^\d+ locations?$/i;

const US_STATES = [
  'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware',
  'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky',
  'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi',
  'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico',
  'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania',
  'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont',
  'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming',
];
const REGION_WORDS = [
  'United States', 'Canada', 'Europe', 'EMEA', 'United Kingdom', 'India', 'Germany', 'France',
  'Poland', 'Spain', 'Brazil', 'Brasil', 'Mexico', 'Colombia', 'APAC', 'Asia', 'Australia',
  'Israel', 'Netherlands', 'Ireland', 'Portugal', 'Ukraine', 'Armenia', 'Greece', 'Bulgaria',
  'Nationwide', 'North America', 'Philippines', 'Romania', 'Turkey', 'Japan', 'China', 'Singapore',
];
// Short codes are only restrictions in capitals ("IN" the country code, not "in").
const REGION_CODES = ['US', 'USA', 'UK', 'EU', 'UA', 'IN', 'IND'];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORDS_ALT = [...REGION_WORDS, ...US_STATES].map(escapeRe).join('|');
const RESTRICT_WORDS_RE = new RegExp(`\\b(?:${WORDS_ALT})\\b`, 'i');
const RESTRICT_CODES_RE = new RegExp(`\\b(?:${REGION_CODES.join('|')})\\b`);
// "Remote---Greece", "Remote-US_JR02900", "Remote_Texas" in a URL path.
const SLUG_WORDS_RE = new RegExp(`\\bremote (?:${WORDS_ALT})\\b`, 'i');
const SLUG_CODES_RE = new RegExp(`\\b[Rr]emote (?:${REGION_CODES.join('|')})\\b`);

/** True when a location string names a region the candidate is excluded from. */
export function isRestricted(location) {
  return RESTRICT_WORDS_RE.test(location) || RESTRICT_CODES_RE.test(location);
}

function slugRestricted(url) {
  let path;
  try { path = decodeURIComponent(new URL(url).pathname); } catch { path = url; }
  const flat = path.replace(/[-_]+/g, ' ');
  return SLUG_WORDS_RE.test(flat) || SLUG_CODES_RE.test(flat);
}

/** Build the keep matcher from home-region terms (always plus worldwide terms). */
export function buildKeepRe(terms) {
  const all = [...terms, ...WORLDWIDE_TERMS].map((t) => String(t).trim()).filter(Boolean);
  if (!all.length) return null;
  return new RegExp(all.map(escapeRe).join('|'), 'i');
}

/**
 * Classify one pending line. Returns { reason: null } to keep it, or
 * { reason } with REASON_ONSITE / REASON_RESTRICTED to discard it.
 */
export function classifyLine(line, keepRe) {
  const parts = line.slice(6).split(' | ');
  const url = (parts[0] || '').trim();
  const loc = (parts[3] || '').trim();

  if (MULTI_RE.test(loc)) {
    // "3 Locations": the real places are not on the line; the URL slug may say.
    return { url, loc, reason: keepRe.test(url) || /remote/i.test(url) ? null : REASON_ONSITE };
  }
  if (keepRe.test(loc)) return { url, loc, reason: null };
  if (REMOTE_RE.test(loc)) {
    if (isRestricted(loc)) return { url, loc, reason: REASON_RESTRICTED };
    if (slugRestricted(url)) return { url, loc, reason: REASON_RESTRICTED };
    return { url, loc, reason: null };
  }
  if (EMPTY_RE.test(loc)) {
    return { url, loc, reason: slugRestricted(url) ? REASON_RESTRICTED : null };
  }
  return { url, loc, reason: REASON_ONSITE };
}

/** Screen every `- [ ] ` line. Pure: returns the new lines, log rows and stats. */
export function screenLines(lines, keepRe, date, now = new Date()) {
  const ts = now.toISOString().replace(/\.\d+Z$/, 'Z');
  const out = [];
  const log = [];
  const kept = [];
  const stats = {};
  for (const line of lines) {
    if (!line.startsWith('- [ ] ')) { out.push(line); continue; }
    const { url, reason } = classifyLine(line, keepRe);
    if (reason === null) {
      out.push(line);
      kept.push(line);
      stats.keep = (stats.keep || 0) + 1;
    } else {
      stats[reason] = (stats[reason] || 0) + 1;
      out.push(`- [x] ${line.slice(6)} | pre-screen: ${reason} (${date})`);
      log.push(`${ts}\t${url}\tpre-screen: ${reason}`);
    }
  }
  return { lines: out, log, kept, stats };
}

function parseArgs(argv) {
  const opts = { apply: false, json: false, keep: [], file: null, log: null, date: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--apply') opts.apply = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--file') opts.file = val();
    else if (a === '--log') opts.log = val();
    else if (a === '--date') opts.date = val();
    else if (a === '--keep') opts.keep.push(...val().split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

/** Home-region terms from portals.yml → location_filter (generic words removed). */
export function homeTermsFromPortals(root) {
  const p = join(root, 'portals.yml');
  if (!existsSync(p)) return [];
  let doc;
  try { doc = loadYaml(readFileSync(p, 'utf8')); } catch { return []; }
  const lf = doc?.location_filter || {};
  const terms = [...(lf.always_allow || []), ...(lf.allow || [])];
  return terms.map(String).filter((t) => !/^(remote|hybrid)$/i.test(t.trim()));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node prescreen-location.mjs [--file F] [--log F] [--keep "A,B"] [--date YYYY-MM-DD] [--apply] [--json]');
    return 0;
  }
  const root = getCareerOpsRoot();
  const file = opts.file || join(root, 'data', 'pipeline.md');
  const logFile = opts.log || join(root, 'data', 'discard.log');
  const date = opts.date || new Date().toISOString().slice(0, 10);
  if (!existsSync(file)) { console.error(`pipeline file not found: ${file}`); return 1; }

  const terms = [...opts.keep, ...homeTermsFromPortals(root)];
  const keepRe = buildKeepRe(terms);
  if (!terms.length) {
    console.error('No home-region terms: set portals.yml → location_filter.always_allow/allow or pass --keep "Country,City". Nothing was changed.');
    return 1;
  }

  const run = (text) => screenLines(text.split('\n'), keepRe, date);
  let result;
  if (opts.apply) {
    await withPipelineLock(file, async () => {
      result = run(readFileSync(file, 'utf8'));
      writeFileSync(file, result.lines.join('\n'), 'utf8');
      if (result.log.length) appendFileSync(logFile, result.log.join('\n') + '\n', 'utf8');
    });
  } else {
    result = run(readFileSync(file, 'utf8'));
  }

  if (opts.json) {
    console.log(JSON.stringify({ applied: opts.apply, stats: result.stats, kept: result.kept }, null, 2));
  } else {
    console.log(JSON.stringify(result.stats));
    for (const k of result.kept) console.log(k);
    console.log(opts.apply ? `APPLIED ${result.log.length}` : '(dry run: pass --apply to write; read the survivors above first)');
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  main().then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(1); });
}
