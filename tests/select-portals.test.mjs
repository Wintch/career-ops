import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { describeSpawn, exitedNonZero } from './helpers/describe-spawn.mjs';
import { parseCompanyBlocks, matches, plan, applyPlan, listTags, loadRoleFamilies, mergeTitlePositives } from '../select-portals.mjs';
import { buildTitleFilter } from '../scan.mjs';

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
  assert.ok(exitedNonZero(noArgs), describeSpawn(noArgs, 'no arguments must be refused'));
  const bad = spawnSync('node', [SCRIPT, '--regions', 'ar', '--sectors', 'tech', '--bogus'], { encoding: 'utf8' });
  assert.ok(exitedNonZero(bad), describeSpawn(bad, 'an unknown flag must be refused'));
});

test('the shipped catalog is fully tagged and parses', () => {
  const text = readFileSync(join(ROOT, 'templates/portals.example.yml'), 'utf8');
  const t = listTags(text);
  assert.equal(t.untagged, 0, 'every tracked company in the example catalog carries tags');
  assert.ok(t.regions.latam > 0 && t.sectors.tech > 0);
});

const FILTER_BLOCK = `title_filter:
  # comment before the list
  positive:
    - "DevOps"
    - word:Colorist
    # a comment between items
    - 'SRE'

  negative:
    - "Junior"
location_filter:
  allow: ["Argentina"]
`;

test('mergeTitlePositives appends to a block list after its last item and keeps everything else', () => {
  const r = mergeTitlePositives(FILTER_BLOCK, ['Graphic Designer', 'colorist', 'sre', 'Video Editor']);
  assert.deepEqual(r.added, ['Graphic Designer', 'Video Editor']);
  assert.deepEqual(r.skipped, ['colorist', 'sre'], 'compared without word:, ignoring case');
  const lines = r.text.split('\n');
  const at = lines.indexOf("    - 'SRE'");
  assert.equal(lines[at + 1], '    - "Graphic Designer"');
  assert.equal(lines[at + 2], '    - "Video Editor"');
  assert.equal(lines[at + 3], '');
  assert.equal(lines[at + 4], '  negative:');
  assert.ok(r.text.includes('    # a comment between items\n'));
  assert.ok(r.text.endsWith('location_filter:\n  allow: ["Argentina"]\n'));
});

test('mergeTitlePositives handles a one-line flow list and refuses a multi-line one', () => {
  const flow = 'title_filter:\n  positive: ["DevOps", SRE]   # mine\n  negative: []\n';
  const r = mergeTitlePositives(flow, ['Linux', 'devops']);
  assert.deepEqual(r.added, ['Linux']);
  assert.match(r.text, /^  positive: \["DevOps", SRE, "Linux"\]\s+# mine$/m);
  const multi = 'title_filter:\n  positive: [\n    "a",\n  ]\n';
  assert.throws(() => mergeTitlePositives(multi, ['x']), /multi-line flow list/);
  assert.throws(() => mergeTitlePositives('other: 1\n', ['x']), /no title_filter/);
  assert.throws(() => mergeTitlePositives('title_filter:\n  negative: []\n', ['x']), /no title_filter\.positive/);
});

test('mergeTitlePositives is idempotent and returns the same text when nothing is new', () => {
  const once = mergeTitlePositives(FILTER_BLOCK, ['Graphic Designer']).text;
  const again = mergeTitlePositives(once, ['Graphic Designer']);
  assert.equal(again.text, once);
  assert.deepEqual(again.added, []);
});

test('the shipped role families are well-formed and the scanner filter accepts their titles', () => {
  const fams = loadRoleFamilies(readFileSync(join(ROOT, 'templates/role-families.yml'), 'utf8'));
  const names = Object.keys(fams);
  assert.ok(names.includes('sysadmin-devops') && names.includes('graphic-design'));
  for (const [name, fam] of Object.entries(fams)) {
    assert.ok(fam.label, `${name} needs a label`);
    assert.ok(Array.isArray(fam.positive) && fam.positive.length > 0, `${name} needs keywords`);
    const keys = fam.positive.map((k) => k.replace(/^(?:word|stem):/i, '').toLowerCase());
    assert.equal(new Set(keys).size, keys.length, `${name} repeats a keyword`);
  }
  const filter = buildTitleFilter({ positive: Object.values(fams).flatMap((f) => f.positive), negative: ['Junior'] });
  assert.equal(filter('Senior Graphic Designer'), true);
  assert.equal(filter('Diseñador Gráfico Sr'), true);
  assert.equal(filter('Administrador de Sistemas Linux'), true);
  assert.equal(filter('Junior Graphic Designer'), false);
  assert.equal(filter('Payroll Accountant'), false);
});

test('CLI: --roles alone edits only the title filter; unknown families are refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'select-portals-roles-'));
  try {
    const into = join(dir, 'portals.yml');
    writeFileSync(into, BASE.replace('positive: ["devops"]', 'positive:\n    - "devops"'));
    const before = readFileSync(into, 'utf8');
    const dry = JSON.parse(execFileSync('node', [SCRIPT, '--into', into, '--roles', 'graphic-design'], { encoding: 'utf8' }));
    assert.equal(dry.written, false);
    assert.equal(readFileSync(into, 'utf8'), before);
    assert.ok(dry.titleKeywordsAdded.includes('Graphic Designer'));
    assert.equal(dry.counts.catalog, 0, 'no employers were picked');
    const real = JSON.parse(execFileSync('node', [SCRIPT, '--into', into, '--roles', 'graphic-design', '--write'], { encoding: 'utf8' }));
    assert.equal(real.written, true);
    const after = readFileSync(into, 'utf8');
    assert.match(after, /- "Graphic Designer"/);
    assert.ok(after.includes('name: Own Only Co   # hand added'), 'companies untouched');
    const bad = spawnSync('node', [SCRIPT, '--into', into, '--roles', 'astronaut'], { encoding: 'utf8' });
    assert.ok(exitedNonZero(bad), describeSpawn(bad, 'an unknown role family must be refused'));
    assert.match(bad.stderr, /unknown role family: astronaut/);
    const half = spawnSync('node', [SCRIPT, '--into', into, '--regions', 'ar'], { encoding: 'utf8' });
    assert.ok(exitedNonZero(half), describeSpawn(half, '--regions without --sectors must be refused'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
