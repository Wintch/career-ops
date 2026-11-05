import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseCompanyBlocks, matches, plan, applyPlan, listTags } from '../select-portals.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'select-portals.mjs');

const CATALOG = `title_filter:
  positive: ["x"]

tracked_companies:
  # -- Section A --
  - name: Alpha Tech
    tags: {regions: [latam, ar], sectors: [tech], remote: latam}
    careers_url: https://jobs.lever.co/alpha
    enabled: false

  - name: Beta Studio
    tags: {regions: [br], sectors: [media, games]}
    careers_url: https://jobs.lever.co/beta
    notes: |
      First line.

      After a blank line inside the block scalar.
    enabled: false

  - name: Gamma Global
    tags: {regions: [global], sectors: [tech], remote: worldwide}
    careers_url: https://jobs.lever.co/gamma
    enabled: false

  - name: Delta Friendly
    tags: {regions: [us], sectors: [tech], remote: friendly}
    careers_url: https://jobs.lever.co/delta
    enabled: false

  - name: Untagged Co
    careers_url: https://jobs.lever.co/untagged
    enabled: false

job_boards: []
`;

const BASE = `# my own portals
title_filter:
  positive: ["devops"]

tracked_companies:
  # -- mine --
  - name: Own Only Co   # hand added
    careers_url: https://jobs.lever.co/own
    enabled: true

  - name: Delta Friendly
    tags: {regions: [us], sectors: [tech], remote: friendly}
    careers_url: https://jobs.lever.co/delta
    enabled: false

  - name: Beta Studio
    careers_url: https://jobs.lever.co/beta
    enabled: true

job_boards: []
location_filter:
  allow: ["Argentina"]
`;

const want = { regions: ['ar', 'latam'], sectors: ['tech'], remote: ['latam', 'worldwide'] };

test('matches: sector AND (region OR accepted remote level)', () => {
  assert.equal(matches({ regions: ['ar'], sectors: ['tech'] }, want), true);
  assert.equal(matches({ regions: ['global'], sectors: ['tech'], remote: 'worldwide' }, want), true);
  assert.equal(matches({ regions: ['us'], sectors: ['tech'], remote: 'friendly' }, want), false, 'friendly is opt-in');
  assert.equal(matches({ regions: ['ar'], sectors: ['media'] }, want), false, 'wrong sector');
  assert.equal(matches({ regions: ['us'], sectors: ['tech'] }, want), false, 'no region, no remote');
  assert.equal(matches(undefined, want), false);
});

test('parseCompanyBlocks keeps a blank line inside a block scalar within its entry', () => {
  const { blocks, lines } = parseCompanyBlocks(CATALOG);
  assert.deepEqual(blocks.map((b) => b.name), ['Alpha Tech', 'Beta Studio', 'Gamma Global', 'Delta Friendly', 'Untagged Co']);
  const beta = blocks[1];
  const text = lines.slice(beta.from, beta.to).join('\n');
  assert.match(text, /After a blank line inside the block scalar\./);
  assert.match(text, /enabled: false/);
});

test('default plan only adds the missing selected companies', () => {
  const p = plan({ catalogText: CATALOG, baseText: BASE, want });
  const out = applyPlan(p, BASE);
  assert.deepEqual(out.changed.added.sort(), ['Alpha Tech', 'Gamma Global']);
  assert.deepEqual(out.changed.enabled, []);
  assert.deepEqual(out.changed.disabled, []);
  assert.equal(p.counts.untagged, 1);
  assert.equal(p.counts.own, 1);
  const names = parseCompanyBlocks(out.text).blocks.map((b) => b.name);
  assert.deepEqual(names, ['Own Only Co', 'Delta Friendly', 'Beta Studio', 'Alpha Tech', 'Gamma Global']);
  // Added entries come over enabled, with their block scalar and tags intact.
  const added = out.text.slice(out.text.indexOf('- name: Alpha Tech'));
  assert.match(added, /tags: \{regions: \[latam, ar\]/);
  assert.match(added, /enabled: true/);
  assert.doesNotMatch(out.text.slice(out.text.indexOf('- name: Alpha Tech')), /enabled: false/);
  // Everything the person wrote is byte-for-byte where it was.
  assert.ok(out.text.startsWith('# my own portals\ntitle_filter:'));
  assert.ok(out.text.includes('  - name: Own Only Co   # hand added\n'));
  assert.ok(out.text.endsWith('job_boards: []\nlocation_filter:\n  allow: ["Argentina"]\n'));
});

test('a company the person switched off stays off unless --enable-existing is asked for', () => {
  const wantFriendly = { ...want, remote: ['friendly'] };
  const off = plan({ catalogText: CATALOG, baseText: BASE, want: wantFriendly });
  assert.deepEqual(applyPlan(off, BASE).changed.enabled, []);
  const on = plan({ catalogText: CATALOG, baseText: BASE, want: wantFriendly, enableExisting: true });
  const res = applyPlan(on, BASE);
  assert.deepEqual(res.changed.enabled, ['Delta Friendly']);
  assert.match(res.text, /name: Delta Friendly\n[^]*?enabled: true/);
});

test('--disable-others switches off non-matching catalog entries, never the person\'s own', () => {
  const p = plan({ catalogText: CATALOG, baseText: BASE, want, disableOthers: true });
  const res = applyPlan(p, BASE);
  assert.deepEqual(res.changed.disabled, ['Beta Studio']);
  const blocks = parseCompanyBlocks(res.text);
  const own = blocks.lines.slice(blocks.blocks[0].from, blocks.blocks[0].to).join('\n');
  assert.match(own, /enabled: true/, 'own entry untouched');
});

test('applying twice changes nothing the second time', () => {
  const p1 = plan({ catalogText: CATALOG, baseText: BASE, want, disableOthers: true, enableExisting: true });
  const once = applyPlan(p1, BASE).text;
  const p2 = plan({ catalogText: CATALOG, baseText: once, want, disableOthers: true, enableExisting: true });
  const twice = applyPlan(p2, once);
  assert.equal(twice.text, once);
  assert.deepEqual([twice.changed.added, twice.changed.enabled, twice.changed.disabled], [[], [], []]);
});

test('an entry without enabled: is on, and turning it off adds the line', () => {
  const base = BASE.replace('    enabled: true\n\n  - name: Delta', '\n  - name: Delta');
  const catalog = CATALOG.replace('name: Own Only Co', 'name: Own Only Co');
  const text = base.replace('name: Beta Studio\n    careers_url: https://jobs.lever.co/beta\n    enabled: true', 'name: Beta Studio\n    careers_url: https://jobs.lever.co/beta');
  const p = plan({ catalogText: catalog, baseText: text, want, disableOthers: true });
  const res = applyPlan(p, text);
  assert.deepEqual(res.changed.disabled, ['Beta Studio']);
  assert.match(res.text, /name: Beta Studio\n    careers_url: https:\/\/jobs\.lever\.co\/beta\n    enabled: false/);
});

test('a file with no tracked_companies is refused', () => {
  assert.throws(() => plan({ catalogText: CATALOG, baseText: 'title_filter: {}\n', want }), /no tracked_companies/);
});

test('listTags counts the vocabulary and the untagged', () => {
  const t = listTags(CATALOG);
  assert.equal(t.untagged, 1);
  assert.equal(t.regions.ar, 1);
  assert.equal(t.sectors.tech, 3);
  assert.equal(t.remote.latam, 1);
});

test('CLI: plan writes nothing, --write backs up first, rerun is a no-op', () => {
  const dir = mkdtempSync(join(tmpdir(), 'select-portals-'));
  try {
    const cat = join(dir, 'catalog.yml');
    const into = join(dir, 'portals.yml');
    writeFileSync(cat, CATALOG);
    writeFileSync(into, BASE);
    const run = (...extra) => JSON.parse(execFileSync('node', [SCRIPT, '--catalog', cat, '--into', into, '--regions', 'ar,latam', '--sectors', 'tech', ...extra], { encoding: 'utf8' }));

    const dry = run();
    assert.equal(dry.written, false);
    assert.equal(readFileSync(into, 'utf8'), BASE, 'a plan must not touch the file');
    assert.deepEqual(dry.wouldAdd.sort(), ['Alpha Tech', 'Gamma Global']);

    const real = run('--write');
    assert.equal(real.written, true);
    assert.equal(readFileSync(real.backup, 'utf8'), BASE, 'the backup is the original');
    assert.match(readFileSync(into, 'utf8'), /name: Alpha Tech/);

    const again = run('--write');
    assert.equal(again.written, false, 'nothing left to change, nothing written');
    assert.equal(readdirSync(dir).filter((f) => f.includes('.bak-')).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: missing --regions/--sectors and unknown flags fail', () => {
  const noArgs = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
  assert.notEqual(noArgs.status, 0);
  const bad = spawnSync('node', [SCRIPT, '--regions', 'ar', '--sectors', 'tech', '--bogus'], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
});

test('the shipped catalog is fully tagged and parses', () => {
  const text = readFileSync(join(ROOT, 'templates/portals.example.yml'), 'utf8');
  const t = listTags(text);
  assert.equal(t.untagged, 0, 'every tracked company in the example catalog carries tags');
  assert.ok(t.regions.latam > 0 && t.sectors.tech > 0);
});
