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
 * Run: node select-portals.mjs --regions ar,latam --sectors tech          (plan, JSON)
 *      node select-portals.mjs --regions ar,latam --sectors tech --summary
 *      node select-portals.mjs ... --remote latam,worldwide,friendly
 *      node select-portals.mjs ... --enable-existing --disable-others
 *      node select-portals.mjs ... --into path/to/portals.yml --write   (apply; .bak first)
 *      node select-portals.mjs --list-tags                              (what the catalog offers)
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
const DEFAULT_REMOTE = ['latam', 'worldwide'];

const USAGE = `Usage: node select-portals.mjs --regions <a,b> --sectors <a,b> [options]
  --regions <list>     where the person lives plus its group, e.g. ar,latam
  --sectors <list>     fields to scan, e.g. tech,ai  (see --list-tags)
  --remote <list>      remote-hiring levels to accept (default latam,worldwide; friendly is opt-in)
  --enable-existing    also switch ON matching companies already in the file but disabled
  --disable-others     switch OFF catalog companies that do not match (default: only add)
  --into <file>        the person's portals.yml (default: <data root>/portals.yml)
  --catalog <file>     catalog to select from (default: templates/portals.example.yml)
  --write              apply the plan to --into (a .bak copy is written first)
  --summary            human-readable output instead of JSON
  --list-tags          print the regions, sectors and remote levels the catalog uses
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
    '--write', '--summary', '--list-tags', '--help', '-h',
  ], USAGE, { valueFlags: ['--regions', '--sectors', '--remote', '--into', '--catalog'] });

  const catalogPath = flagValue(args, '--catalog') || CATALOG_PATH;
  if (!existsSync(catalogPath)) { console.error(`catalog not found: ${catalogPath}`); process.exit(1); }
  const catalogText = readFileSync(catalogPath, 'utf8');

  if (hasFlag(args, '--list-tags')) {
    console.log(JSON.stringify(listTags(catalogText), null, 2));
    return;
  }

  const want = {
    regions: list(flagValue(args, '--regions')),
    sectors: list(flagValue(args, '--sectors')),
    remote: hasFlag(args, '--remote') ? list(flagValue(args, '--remote')) : DEFAULT_REMOTE,
  };
  if (!want.regions.length || !want.sectors.length) {
    console.error('--regions and --sectors are both required (see --list-tags)\n\n' + USAGE);
    process.exit(1);
  }

  const intoPath = flagValue(args, '--into') || join(getCareerOpsRoot(), 'portals.yml');
  if (!existsSync(intoPath)) { console.error(`portals file not found: ${intoPath}`); process.exit(1); }
  const baseText = readFileSync(intoPath, 'utf8');

  const p = plan({ catalogText, baseText, want, disableOthers: hasFlag(args, '--disable-others'), enableExisting: hasFlag(args, '--enable-existing') });
  const result = applyPlan(p, baseText);
  const write = hasFlag(args, '--write');
  let backup = null;
  if (write && (result.changed.enabled.length || result.changed.disabled.length || result.changed.added.length)) {
    backup = `${intoPath}.bak-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
    copyFileSync(intoPath, backup);
    const tmp = `${intoPath}.tmp-${process.pid}`;
    writeFileSync(tmp, result.text);
    renameSync(tmp, intoPath);
  }

  const out = {
    want,
    disableOthers: hasFlag(args, '--disable-others'),
    enableExisting: hasFlag(args, '--enable-existing'),
    written: write && backup !== null,
    backup,
    into: intoPath,
    counts: p.counts,
    wouldEnable: result.changed.enabled,
    wouldDisable: result.changed.disabled,
    wouldAdd: result.changed.added,
    alreadyAsWanted: result.changed.unchanged.length,
  };
  if (hasFlag(args, '--summary')) {
    const verb = out.written ? 'applied' : 'plan (nothing written; add --write)';
    console.log(`select-portals ${verb}: regions=${want.regions} sectors=${want.sectors} remote=${want.remote}`);
    console.log(`catalog ${p.counts.catalog} entries, ${p.counts.selected} match, ${p.counts.untagged} untagged; ${p.counts.own} entries in the file are the person's own and stay untouched`);
    console.log(`enable ${out.wouldEnable.length}, add ${out.wouldAdd.length}, disable ${out.wouldDisable.length}, already as wanted ${out.alreadyAsWanted}`);
    for (const [label, names] of [['add', out.wouldAdd], ['enable', out.wouldEnable], ['disable', out.wouldDisable]]) {
      if (names.length) console.log(`  ${label}: ${names.join(', ')}`);
    }
    if (backup) console.log(`backup: ${backup}`);
  } else {
    console.log(JSON.stringify(out, null, 2));
  }
}

if (isMainModule(import.meta.url)) main();
