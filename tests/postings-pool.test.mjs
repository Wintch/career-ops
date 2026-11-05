import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describeSpawn, exitedNonZero } from './helpers/describe-spawn.mjs';
import { openPool, readPool, postedDay, salaryCell, parseSalaryCell, POOL_HEADER, POOL_FILE } from '../lib/postings-pool.mjs';
import { eligibleRows, rowToJob, derive } from '../pool-derive.mjs';
import { parseArgs } from '../scan-ats-full.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => mkdtempSync(join(tmpdir(), 'postings-pool-'));
const NOW = Date.parse('2026-11-05T12:00:00Z');
const job = (over = {}) => ({ url: 'https://x.example/jobs/1', title: 'DevOps Engineer', location: 'Remote', postedAt: NOW - 86_400_000, ...over });

test('a posting is written once, with its first-seen day, and reopening knows it', () => {
  const dir = tmp();
  try {
    const a = openPool(dir, { today: '2026-11-05' });
    assert.equal(a.add('lever', 'acme', job()), true);
    assert.equal(a.add('lever', 'acme', job()), false, 'same key again in one run');
    a.flush();
    const b = openPool(dir, { today: '2026-11-06' });
    assert.equal(b.add('lever', 'acme', job()), false, 'known from an earlier run');
    assert.equal(b.add('lever', 'acme', job({ url: 'https://x.example/jobs/2' })), true);
    b.flush();
    const rows = readPool(dir);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].first_seen, '2026-11-05');
    assert.equal(rows[1].first_seen, '2026-11-06');
    assert.equal(readFileSync(join(dir, POOL_FILE), 'utf8').split('\n').filter((l) => l.startsWith('first_seen')).length, 1, 'one header');
    assert.equal(readFileSync(join(dir, POOL_FILE), 'utf8').split('\n')[0] + '\n', POOL_HEADER);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stale dated postings and rows missing a url or title are not recorded', () => {
  const dir = tmp();
  try {
    const p = openPool(dir, { today: '2026-11-05' });
    const cutoff = NOW - 3 * 86_400_000;
    assert.equal(p.add('lever', 'acme', job({ postedAt: cutoff - 1 }), cutoff), false);
    assert.equal(p.stats.skippedStale, 1);
    assert.equal(p.add('lever', 'acme', job({ postedAt: null }), cutoff), true, 'undated is kept');
    assert.equal(p.add('lever', 'acme', { title: 'x' }), false);
    assert.equal(p.add('lever', 'acme', { url: 'https://x.example/3' }), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tabs and line breaks in a field cannot break a row', () => {
  const dir = tmp();
  try {
    const p = openPool(dir, { today: '2026-11-05' });
    p.add('lever', 'acme', job({ title: 'Dev\tOps\nEngineer', location: 'A\r\nB' }));
    p.flush();
    const [row] = readPool(dir);
    assert.equal(row.title, 'Dev Ops Engineer');
    assert.equal(row.location, 'A B');
    assert.equal(readFileSync(join(dir, POOL_FILE), 'utf8').trim().split('\n').length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the first appearance of a board is baseline; later arrivals on it are not', () => {
  const dir = tmp();
  try {
    const a = openPool(dir, { today: '2026-11-05' });
    a.addAll('bamboohr', 'newco', [job({ url: 'https://newco/1' }), job({ url: 'https://newco/2' })]);
    a.flush();
    const b = openPool(dir, { today: '2026-11-06' });
    b.addAll('bamboohr', 'newco', [job({ url: 'https://newco/1' }), job({ url: 'https://newco/3' })]);
    b.addAll('bamboohr', 'other', [job({ url: 'https://other/1' })]);
    b.flush();
    const by = Object.fromEntries(readPool(dir).map((r) => [r.url, r.baseline]));
    assert.deepEqual(by, { 'https://newco/1': '1', 'https://newco/2': '1', 'https://newco/3': '0', 'https://other/1': '1' });
    assert.equal(b.stats.baseline, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a provider key makes one posting under two URLs one row', () => {
  const dir = tmp();
  try {
    const p = openPool(dir, { today: '2026-11-05', keyOf: (j) => `req:${j.url.split('/').pop().split('_').pop()}` });
    assert.equal(p.add('workday', 't', job({ url: 'https://t/siteA/job/Senior_R100' })), true);
    assert.equal(p.add('workday', 't', job({ url: 'https://t/siteB/job/Senior_R100' })), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('postedDay and the salary cell round-trip', () => {
  assert.equal(postedDay(Date.parse('2026-11-03T23:59:00Z')), '2026-11-03');
  assert.equal(postedDay('2026-11-03T10:00:00Z'), '2026-11-03');
  assert.equal(postedDay(null), '');
  assert.equal(postedDay('garbage'), '');
  assert.equal(salaryCell({ min: 120000.4, max: 160000, currency: 'USD' }), '120000|160000|USD');
  assert.equal(salaryCell({ min: 0, max: 0 }), '');
  assert.deepEqual(parseSalaryCell('120000|160000|USD'), { min: 120000, max: 160000, currency: 'USD' });
  assert.deepEqual(parseSalaryCell('|90000|'), { max: 90000 });
  assert.equal(parseSalaryCell(''), null);
});

const row = (over) => ({ first_seen: '2026-11-05', baseline: '0', source: 'greenhouse', company: 'acme', title: 'DevOps Engineer', location: 'Remote', posted_at: '', salary: '', key: 'k', url: 'https://x/1', ...over });

test('eligibleRows: dated by its own date, undated by first_seen and never from a baseline', () => {
  const rows = [
    row({ url: 'a', posted_at: '2026-11-04' }),
    row({ url: 'b', posted_at: '2026-10-20' }),
    row({ url: 'c', posted_at: '', first_seen: '2026-11-05' }),
    row({ url: 'd', posted_at: '', first_seen: '2026-11-05', baseline: '1' }),
    row({ url: 'e', posted_at: '', first_seen: '2026-10-01' }),
    row({ url: 'f', posted_at: '2026-10-20', baseline: '1' }),
  ];
  assert.deepEqual(eligibleRows(rows, '2026-11-02').map((r) => r.url), ['a', 'c']);
});

test('rowToJob rebuilds the job the sweep filters expect', () => {
  const j = rowToJob(row({ posted_at: '2026-11-04', salary: '1|2|USD' }));
  assert.equal(j.postedAt, Date.parse('2026-11-04T00:00:00Z'));
  assert.deepEqual(j.salary, { min: 1, max: 2, currency: 'USD' });
  assert.equal(rowToJob(row({})).postedAt, null);
});

test('derive applies the person\'s title and location filters, their history and the blacklist', () => {
  const rows = [
    row({ url: 'https://x/1', title: 'Senior DevOps Engineer', location: 'Buenos Aires, Argentina', posted_at: '2026-11-04' }),
    row({ url: 'https://x/2', title: 'Graphic Designer', location: 'Buenos Aires, Argentina', posted_at: '2026-11-04' }),
    row({ url: 'https://x/3', title: 'DevOps Engineer', location: 'Berlin, Germany', posted_at: '2026-11-04' }),
    row({ url: 'https://x/4', title: 'DevOps Lead', location: 'Buenos Aires, Argentina', posted_at: '' }),
    row({ url: 'https://x/5', title: 'DevOps Lead', location: 'Buenos Aires, Argentina', posted_at: '', baseline: '1' }),
    row({ url: 'https://x/6', title: 'SRE DevOps', location: 'Buenos Aires, Argentina', posted_at: '2026-11-04' }),
  ];
  const config = {
    title_filter: { positive: ['DevOps'], negative: [] },
    location_filter: { allow: ['Argentina'] },
  };
  const seen = new Set(['https://x/6']);
  const out = derive({ rows, config, sinceDays: 3, today: '2026-11-05', seenUrls: seen, blacklist: new Map() });
  assert.deepEqual(out.offers.map((o) => o.url).sort(), ['https://x/1', 'https://x/4']);
  assert.equal(out.counts.alreadySeen, 1);
  assert.equal(out.counts.filtered, 2);
  assert.equal(out.counts.inWindow, 5, 'the baseline undated row is not in the window');
  assert.ok(out.offers.every((o) => o.source === 'greenhouse-full'));
  assert.equal(out.offers.find((o) => o.url === 'https://x/4').dateStatus, 'unknown');
  assert.equal(out.cutoffDay, '2026-11-02');
});

test('scan-ats-full reads --pool and CAREER_OPS_POOL_DIR', () => {
  assert.equal(parseArgs(['node', 'x', '--pool', '/p']).pool, '/p');
  assert.equal(parseArgs(['node', 'x', '--pool=/q']).pool, '/q');
  const saved = process.env.CAREER_OPS_POOL_DIR;
  process.env.CAREER_OPS_POOL_DIR = '/env';
  try {
    assert.equal(parseArgs(['node', 'x']).pool, '/env');
    assert.equal(parseArgs(['node', 'x', '--pool', '/flag']).pool, '/flag');
  } finally {
    if (saved === undefined) delete process.env.CAREER_OPS_POOL_DIR; else process.env.CAREER_OPS_POOL_DIR = saved;
  }
});

test('CLI: a dry run writes nothing, a real run fills the pipeline once, a missing pool is refused', () => {
  const dir = tmp();
  try {
    const data = join(dir, 'root');
    mkdirSync(join(data, 'data'), { recursive: true });
    writeFileSync(join(data, 'portals.yml'), 'title_filter:\n  positive: ["DevOps"]\n  negative: []\n');
    const pool = join(dir, 'pool');
    const p = openPool(pool, { today: new Date().toISOString().slice(0, 10) });
    p.add('lever', 'acme', { url: 'https://jobs.lever.co/acme/1', title: 'DevOps Engineer', company: 'acme', location: 'Remote', postedAt: Date.now() - 3_600_000 });
    p.flush();
    const run = (...a) => spawnSync('node', [join(ROOT, 'pool-derive.mjs'), '--pool', pool, ...a], { encoding: 'utf8', env: { ...process.env, CAREER_OPS_ROOT: data, CAREER_OPS_DATA_DIR: '', CAREER_OPS_PIPELINE: '', CAREER_OPS_PORTALS: '' } });

    const dry = run('--dry-run');
    assert.equal(dry.status, 0, describeSpawn(dry, 'dry run'));
    assert.equal(JSON.parse(dry.stdout).kept, 1);
    assert.equal(existsSync(join(data, 'data', 'pipeline.md')), false, 'a dry run leaves no pipeline');

    const real = run();
    assert.equal(real.status, 0, describeSpawn(real, 'real run'));
    assert.match(readFileSync(join(data, 'data', 'pipeline.md'), 'utf8'), /jobs\.lever\.co\/acme\/1/);

    const again = JSON.parse(run().stdout);
    assert.equal(again.kept, 0, 'a second run adds nothing');
    assert.equal(again.alreadySeen, 1);

    const missing = spawnSync('node', [join(ROOT, 'pool-derive.mjs'), '--pool', join(dir, 'nope')], { encoding: 'utf8', env: { ...process.env, CAREER_OPS_ROOT: data } });
    assert.ok(exitedNonZero(missing), describeSpawn(missing, 'a missing pool must be refused'));
    const noPool = spawnSync('node', [join(ROOT, 'pool-derive.mjs')], { encoding: 'utf8', env: { ...process.env, CAREER_OPS_ROOT: data, CAREER_OPS_POOL_DIR: '' } });
    assert.ok(exitedNonZero(noPool), describeSpawn(noPool, '--pool is required'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
