#!/usr/bin/env node
/**
 * select-portals.mjs — pick which catalog employers a person's portals.yml scans
 *
 * `templates/portals.example.yml` is the catalog: every tracked company carries
 * `tags: {regions: [...], sectors: [...], remote: ...}`. A person only needs the
 * slice that fits them (a graphic designer has no use for the sysadmin boards a
 * night scan would read). This script turns "where I live, what field I work in"
 * into a deterministic edit of that person's own `portals.yml`, so nothing has to
 * ask an agent to rewrite the file — an agent rewriting it once collapsed a list
 * of 151 companies to 11 without anyone noticing.
 *
 * Tag vocabulary (all lowercase):
 *   regions  ISO country codes (ar, br, mx, us, ...) and groups (latam, eu, dach,
 *            nordics, africa); `global` = no specific region, so it only matches
 *            through `remote`.
 *   sectors  tech, ai, security, media, games, finance, commerce, telecom,
 *            consulting, logistics, education, public, ...
 *   remote   latam | worldwide | friendly — whether the employer hires a remote
 *            candidate from outside its own region. `friendly` means remote roles
 *            exist but each posting's country eligibility still has to be read.
 *
 * An entry is selected when its sectors meet --sectors AND (its regions meet
 * --regions OR its `remote` is one of --remote, default `latam,worldwide`).
 * Entries with no `tags` are never selected and are only counted.
 *
 * The edit is text-level, so comments, ordering and every line the person wrote
 * stay as they are. By default it only ADDS: a selected company missing from the
 * file is appended (copied from the catalog, enabled) and nothing else changes.
 * A company that is in the file but switched off stays off, because the person
 * may have turned it off on purpose; `--enable-existing` switches those on.
 * `--disable-others` switches OFF catalog companies that do not match, which is
 * how a person stops scanning a field that is not theirs. Companies the person
 * added themselves (not in the catalog) are never touched, and nothing is ever
 * deleted.
 *
 * The roles a person keeps come from the title filter, not from the employers, so
 * `--roles sysadmin-devops,ai-ml` also appends that family's keywords
 * (`templates/role-families.yml`) to the file's `title_filter.positive`. It only
 * adds: a keyword already there (compared without its `word:`/`stem:` prefix and
 * ignoring case) is skipped, and nothing in the filter is edited or removed.
 *
 * Run: node select-portals.mjs --regions ar,latam --sectors tech          (plan, JSON)
 *      node select-portals.mjs --regions ar,latam --sectors tech --summary
 *      node select-portals.mjs ... --remote latam,worldwide,friendly
 *      node select-portals.mjs ... --enable-existing --disable-others
 *      node select-portals.mjs ... --into path/to/portals.yml --write   (apply; .bak first)
 *      node select-portals.mjs --roles sysadmin-devops,ai-ml            (titles only, no employers)
 *      node select-portals.mjs --list-tags                              (what the catalog offers)
 *      node select-portals.mjs --list-roles                             (the role families)
 *      node select-portals.mjs --catalog path/to/catalog.yml ...
 *
 * Zero network, zero LLM. Without --write nothing is written.
 */

import { readFileSync, writeFileSync, existsSync, renameSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadYaml } from './lib/yaml-document.mjs';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

const CODE_ROOT = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = join(CODE_ROOT, 'templates/portals.example.yml');
const ROLES_PATH = join(CODE_ROOT, 'templates/role-families.yml');
const DEFAULT_REMOTE = ['latam', 'worldwide'];

const USAGE = `Usage: node select-portals.mjs --regions <a,b> --sectors <a,b> [options]
  --regions <list>     where the person lives plus its group, e.g. ar,latam (needs --sectors)
  --sectors <list>     fields to scan, e.g. tech,ai  (see --list-tags)
  --remote <list>      remote-hiring levels to accept (default latam,worldwide; friendly is opt-in)
  --enable-existing    also switch ON matching companies already in the file but disabled
  --disable-others     switch OFF catalog companies that do not match (default: only add)
  --roles <list>       role families whose title keywords are appended to title_filter.positive
  --into <file>        the person's portals.yml (default: <data root>/portals.yml)
  --catalog <file>     catalog to select from (default: templates/portals.example.yml)
  --write              apply the plan to --into (a .bak copy is written first)
  --summary            human-readable output instead of JSON
  --list-tags          print the regions, sectors and remote levels the catalog uses
  --list-roles         print the role families and how many keywords each carries
  --help               print this usage block`;

/** @param {string|undefined} v */
const list = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
/** @param {string} name */
const keyOf = (name) => String(name || '').trim().toLowerCase();

/**
 * Split a portals file into its top lines, the tracked_companies entry blocks
 * (raw text, with their line span) and the rest.
 * @param {string} text
 */
export function parseCompanyBlocks(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^tracked_companies:\s*(#.*)?$/.test(l));
  if (start === -1) return { lines, start: -1, end: -1, blocks: [] };
  let end = lines.findIndex((l, i) => i > start && /^[A-Za-z_][\w-]*:/.test(l));
  if (end === -1) end = lines.length;
  const blocks = [];
  for (let i = start + 1; i < end; i++) {
    const m = lines[i].match(/^ {2}- name:\s*(.*?)\s*$/);
    if (!m) continue;
    let j = i + 1;
    while (j < end) {
      if (/^ {4,}\S/.test(lines[j])) { j++; continue; }
      if (lines[j].trim() === '') {
        // A blank line stays inside the entry only when the next text line is
        // still indented under it (a `notes: |` block scalar can hold blanks).
        let k = j + 1;
        while (k < end && lines[k].trim() === '') k++;
        if (k < end && /^ {4,}\S/.test(lines[k])) { j = k; continue; }
      }
      break;
    }
    const raw = m[1].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '');
    blocks.push({ name: raw, key: keyOf(raw), from: i, to: j });
    i = j - 1;
  }
  return { lines, start, end, blocks };
}

/**
 * @param {object} tags
 * @param {{regions: string[], sectors: string[], remote: string[]}} want
 */
export function matches(tags, want) {
  if (!tags || typeof tags !== 'object') return false;
  const sectors = (tags.sectors || []).map(keyOf);
  const regions = (tags.regions || []).map(keyOf);
  if (!sectors.some((s) => want.sectors.includes(s))) return false;
  if (regions.some((r) => want.regions.includes(r))) return true;
  return tags.remote ? want.remote.includes(keyOf(tags.remote)) : false;
}

/** @param {string[]} blockLines @param {boolean} value */
function setEnabled(blockLines, value) {
  const at = blockLines.findIndex((l) => /^ {4}enabled:\s*(true|false)\b/.test(l));
  if (at !== -1) {
    const was = /true/.test(blockLines[at].match(/^ {4}enabled:\s*(true|false)/)[1]);
    if (was === value) return false;
    blockLines[at] = blockLines[at].replace(/(enabled:\s*)(true|false)/, `$1${value}`);
    return true;
  }
  if (value) return false; // absent means enabled
  blockLines.push('    enabled: false');
  return true;
}

/**
 * Work out the edit without applying it.
 * @param {{catalogText: string, baseText: string, want: {regions: string[], sectors: string[], remote: string[]}, disableOthers?: boolean, enableExisting?: boolean}} o
 */
export function plan({ catalogText, baseText, want, disableOthers = false, enableExisting = false }) {
  const catalog = loadYaml(catalogText);
  const entries = Array.isArray(catalog?.tracked_companies) ? catalog.tracked_companies : [];
  const catBlocks = parseCompanyBlocks(catalogText);
  const catText = new Map(catBlocks.blocks.map((b) => [b.key, catBlocks.lines.slice(b.from, b.to)]));
  const base = parseCompanyBlocks(baseText);
  if (base.start === -1) throw new Error('--into file has no tracked_companies list');
  const baseByKey = new Map(base.blocks.map((b) => [b.key, b]));

  const selected = [];
  const unselectedTagged = [];
  let untagged = 0;
  for (const e of entries) {
    if (!e?.name) continue;
    if (!e.tags) { untagged++; continue; }
    (matches(e.tags, want) ? selected : unselectedTagged).push(e);
  }

  const toEnable = [], toDisable = [], toAdd = [];
  for (const e of selected) {
    const b = baseByKey.get(keyOf(e.name));
    if (b) { if (enableExisting) toEnable.push({ name: e.name, block: b }); }
    else toAdd.push(e);
  }
  if (disableOthers) {
    for (const e of unselectedTagged) {
      const b = baseByKey.get(keyOf(e.name));
      if (b) toDisable.push({ name: e.name, block: b });
    }
  }
  const catalogKeys = new Set(entries.map((e) => keyOf(e?.name)));
  const own = base.blocks.filter((b) => !catalogKeys.has(b.key)).length;
  return { base, toEnable, toDisable, toAdd, catText, counts: { catalog: entries.length, selected: selected.length, untagged, own } };
}

/** Apply a plan to the base text; returns the new text and what really changed. */
export function applyPlan(p, baseText) {
  const lines = baseText.split('\n');
  const changed = { enabled: [], disabled: [], added: [], unchanged: [] };
  // Edit from the bottom up so earlier line numbers stay valid.
  const edits = [
    ...p.toEnable.map((x) => ({ ...x, value: true })),
    ...p.toDisable.map((x) => ({ ...x, value: false })),
  ].sort((a, b) => b.block.from - a.block.from);
  for (const ed of edits) {
    const slice = lines.slice(ed.block.from, ed.block.to);
    if (setEnabled(slice, ed.value)) {
      lines.splice(ed.block.from, ed.block.to - ed.block.from, ...slice);
      (ed.value ? changed.enabled : changed.disabled).push(ed.name);
    } else changed.unchanged.push(ed.name);
  }
  if (p.toAdd.length) {
    // Insert after the last non-blank line of the tracked_companies section.
    const after = parseCompanyBlocks(lines.join('\n'));
    let at = after.end;
    while (at > after.start + 1 && lines[at - 1].trim() === '') at--;
    const chunk = [];
    for (const e of p.toAdd) {
      const src = p.catText.get(keyOf(e.name));
      if (!src) continue;
      const copy = [...src];
      setEnabled(copy, true);
      chunk.push('', ...copy);
      changed.added.push(e.name);
    }
    lines.splice(at, 0, ...chunk);
  }
  return { text: lines.join('\n'), changed };
}

/** @param {string} text templates/role-families.yml */
export function loadRoleFamilies(text) {
  const fams = loadYaml(text)?.families;
  if (!fams || typeof fams !== 'object') throw new Error('role-families file has no `families` map');
  return fams;
}

/** `word:`/`stem:` prefix off, lowercased: the keyword's identity for de-duplication. */
const kwKey = (k) => String(k).trim().replace(/^(?:word|stem):/i, '').toLowerCase();

/**
 * Append keywords to `title_filter.positive`, text-level. Handles a block list
 * (`    - x` lines) and a one-line flow list (`positive: [a, b]`); a flow list that
 * spans several lines is refused rather than guessed at.
 * @param {string} text
 * @param {string[]} words
 * @returns {{text: string, added: string[], skipped: string[]}}
 */
export function mergeTitlePositives(text, words) {
  const lines = text.split('\n');
  const tf = lines.findIndex((l) => /^title_filter:\s*(#.*)?$/.test(l));
  if (tf === -1) throw new Error('--into file has no title_filter');
  let tfEnd = lines.findIndex((l, i) => i > tf && /^[A-Za-z_][\w-]*:/.test(l));
  if (tfEnd === -1) tfEnd = lines.length;
  const pos = lines.findIndex((l, i) => i > tf && i < tfEnd && /^ {2}positive:/.test(l));
  if (pos === -1) throw new Error('--into file has no title_filter.positive');

  const inline = lines[pos].replace(/^ {2}positive:\s*/, '').replace(/\s+#.*$/, '').trim();
  let existing = [];
  let lastItem = -1;
  let indent = '    ';
  if (inline.startsWith('[')) {
    if (!inline.endsWith(']')) throw new Error('title_filter.positive is a multi-line flow list; rewrite it as a block list first');
    existing = loadYaml(`x: ${inline}`)?.x || [];
  } else {
    for (let i = pos + 1; i < tfEnd; i++) {
      const m = lines[i].match(/^(\s{3,})-\s+(.*?)\s*(?:#.*)?$/);
      if (m) { lastItem = i; indent = m[1]; existing.push(loadYaml(`x: ${m[2]}`)?.x ?? m[2]); continue; }
      if (/^\s*(#.*)?$/.test(lines[i])) continue; // blank or comment between items
      break; // the next key (negative:, ...)
    }
    if (lastItem === -1) throw new Error('title_filter.positive has no items to extend');
  }

  const have = new Set(existing.map(kwKey));
  const added = [], skipped = [];
  for (const w of words) {
    if (have.has(kwKey(w))) { skipped.push(w); continue; }
    have.add(kwKey(w));
    added.push(w);
  }
  if (!added.length) return { text, added, skipped };
  if (inline.startsWith('[')) {
    const trail = lines[pos].match(/(\s+#.*)$/)?.[1] || '';
    const body = inline.slice(1, -1).trim();
    lines[pos] = `  positive: [${[body, ...added.map((a) => JSON.stringify(a))].filter(Boolean).join(', ')}]${trail}`;
  } else {
    lines.splice(lastItem + 1, 0, ...added.map((a) => `${indent}- ${JSON.stringify(a)}`));
  }
  return { text: lines.join('\n'), added, skipped };
}

/** @param {string} catalogText */
export function listTags(catalogText) {
  const entries = loadYaml(catalogText)?.tracked_companies || [];
  const tally = { regions: {}, sectors: {}, remote: {}, untagged: 0 };
  for (const e of entries) {
    if (!e?.tags) { tally.untagged++; continue; }
    for (const r of e.tags.regions || []) tally.regions[r] = (tally.regions[r] || 0) + 1;
    for (const s of e.tags.sectors || []) tally.sectors[s] = (tally.sectors[s] || 0) + 1;
    if (e.tags.remote) tally.remote[e.tags.remote] = (tally.remote[e.tags.remote] || 0) + 1;
  }
  return tally;
}

function main() {
  const args = process.argv.slice(2);
  validateFlags(args, [
    '--regions', '--sectors', '--remote', '--disable-others', '--enable-existing', '--into', '--catalog',
    '--write', '--summary', '--list-tags', '--list-roles', '--roles', '--help', '-h',
  ], USAGE, { valueFlags: ['--regions', '--sectors', '--remote', '--into', '--catalog', '--roles'] });

  const catalogPath = flagValue(args, '--catalog') || CATALOG_PATH;
  if (!existsSync(catalogPath)) { console.error(`catalog not found: ${catalogPath}`); process.exit(1); }
  const catalogText = readFileSync(catalogPath, 'utf8');

  if (hasFlag(args, '--list-tags')) {
    console.log(JSON.stringify(listTags(catalogText), null, 2));
    return;
  }
  const families = loadRoleFamilies(readFileSync(ROLES_PATH, 'utf8'));
  if (hasFlag(args, '--list-roles')) {
    const out = Object.fromEntries(Object.entries(families).map(([k, v]) => [k, { label: v.label, keywords: (v.positive || []).length }]));
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const roles = list(flagValue(args, '--roles'));
  const unknownRoles = roles.filter((r) => !families[r]);
  if (unknownRoles.length) {
    console.error(`unknown role family: ${unknownRoles.join(', ')} (see --list-roles)`);
    process.exit(1);
  }
  const want = {
    regions: list(flagValue(args, '--regions')),
    sectors: list(flagValue(args, '--sectors')),
    remote: hasFlag(args, '--remote') ? list(flagValue(args, '--remote')) : DEFAULT_REMOTE,
  };
  const pickEmployers = want.regions.length > 0 || want.sectors.length > 0;
  if (pickEmployers && !(want.regions.length && want.sectors.length)) {
    console.error('--regions and --sectors go together (see --list-tags)\n\n' + USAGE);
    process.exit(1);
  }
  if (!pickEmployers && !roles.length) {
    console.error('give --regions and --sectors, --roles, or both\n\n' + USAGE);
    process.exit(1);
  }

  const intoPath = flagValue(args, '--into') || join(getCareerOpsRoot(), 'portals.yml');
  if (!existsSync(intoPath)) { console.error(`portals file not found: ${intoPath}`); process.exit(1); }
  const baseText = readFileSync(intoPath, 'utf8');

  let text = baseText;
  let p = { counts: { catalog: 0, selected: 0, untagged: 0, own: 0 } };
  let changed = { enabled: [], disabled: [], added: [], unchanged: [] };
  if (pickEmployers) {
    p = plan({ catalogText, baseText, want, disableOthers: hasFlag(args, '--disable-others'), enableExisting: hasFlag(args, '--enable-existing') });
    const result = applyPlan(p, baseText);
    text = result.text;
    changed = result.changed;
  }
  const titles = { added: [], skipped: [] };
  if (roles.length) {
    const words = [...new Set(roles.flatMap((r) => families[r].positive || []))];
    const merged = mergeTitlePositives(text, words);
    text = merged.text;
    titles.added = merged.added;
    titles.skipped = merged.skipped;
  }

  const write = hasFlag(args, '--write');
  const dirty = text !== baseText;
  let backup = null;
  if (write && dirty) {
    backup = `${intoPath}.bak-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
    copyFileSync(intoPath, backup);
    const tmp = `${intoPath}.tmp-${process.pid}`;
    writeFileSync(tmp, text);
    renameSync(tmp, intoPath);
  }

  const out = {
    want: pickEmployers ? want : null,
    roles,
    disableOthers: hasFlag(args, '--disable-others'),
    enableExisting: hasFlag(args, '--enable-existing'),
    written: backup !== null,
    backup,
    into: intoPath,
    counts: p.counts,
    wouldEnable: changed.enabled,
    wouldDisable: changed.disabled,
    wouldAdd: changed.added,
    alreadyAsWanted: changed.unchanged.length,
    titleKeywordsAdded: titles.added,
    titleKeywordsAlreadyThere: titles.skipped.length,
  };
  if (hasFlag(args, '--summary')) {
    const verb = out.written ? 'applied' : 'plan (nothing written; add --write)';
    console.log(`select-portals ${verb}`);
    if (pickEmployers) {
      console.log(`regions=${want.regions} sectors=${want.sectors} remote=${want.remote}`);
      console.log(`catalog ${p.counts.catalog} entries, ${p.counts.selected} match, ${p.counts.untagged} untagged; ${p.counts.own} entries in the file are the person's own and stay untouched`);
      console.log(`enable ${out.wouldEnable.length}, add ${out.wouldAdd.length}, disable ${out.wouldDisable.length}, already as wanted ${out.alreadyAsWanted}`);
      for (const [label, names] of [['add', out.wouldAdd], ['enable', out.wouldEnable], ['disable', out.wouldDisable]]) {
        if (names.length) console.log(`  ${label}: ${names.join(', ')}`);
      }
    }
    if (roles.length) {
      console.log(`roles=${roles}: ${titles.added.length} title keywords added, ${titles.skipped.length} already there`);
      if (titles.added.length) console.log(`  add: ${titles.added.join(', ')}`);
    }
    if (backup) console.log(`backup: ${backup}`);
  } else {
    console.log(JSON.stringify(out, null, 2));
  }
}

if (isMainModule(import.meta.url)) main();
