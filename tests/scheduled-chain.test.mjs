// tests/scheduled-chain.test.mjs — scheduled-chain.mjs runs the zero-token scans
// in order under one lock and prints one JSON summary for a scheduler.
//
// Run:  node --test tests/scheduled-chain.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const { parseArgs, planSteps, countPending, newAddedFromScanRuns, parseNaventNew, parseLivenessExpired, runChain,
  lastScanRunRow, buildTimingRow, appendTimingRow, TIMINGS_HEADER } =
  await import(pathToFileURL(join(ROOT, 'scheduled-chain.mjs')).href);
const { tryAcquireDirLockSync, releaseOrWarn } = await import(pathToFileURL(join(ROOT, 'lib/dir-lock.mjs')).href);

const RUNS_HEADER = 'timestamp\tstatus\tcompanies\tboards\tfound\tfiltered_title\tdupes\tnew_added\terrors\n';

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'scheduled-chain-'));
  mkdirSync(join(root, 'data'));
  writeFileSync(join(root, 'data', 'pipeline.md'), '# Pipeline\n\n- [x] https://a.example/1 | done\n- [ ] https://a.example/2 | open\n');
  writeFileSync(join(root, 'data', 'scan-runs.tsv'), `${RUNS_HEADER}2026-11-01T00:00:00Z\tcompleted\t1\t0\t5\t4\t0\t1\t0\n`);
  return root;
}

const ok = (stdout = '') => ({ code: 0, signal: null, timedOut: false, stdout, stderr: '', ms: 1500 });

/** A fake runner: records each step and lets a per-step handler simulate its effect. */
function fakeRunner(root, handlers = {}) {
  const calls = [];
  const run = async (step, opts) => {
    calls.push({ name: step.name, script: step.script, args: step.args, timeoutMs: opts.timeoutMs });
    const h = handlers[step.name];
    if (h) return h(root);
    if (step.name === 'closing') return ok(JSON.stringify({ closingSoon: [], overdue: [] }));
    return ok();
  };
  return { run, calls };
}

test('parseArgs reads the opt-in steps and the per-step timeout, and refuses anything else', () => {
  assert.deepEqual(parseArgs([]), { withNavent: false, withLiveness: false, stepTimeoutSec: 0, help: false });
  assert.deepEqual(parseArgs(['--with-navent', '--with-liveness', '--step-timeout', '90']),
    { withNavent: true, withLiveness: true, stepTimeoutSec: 90, help: false });
  assert.equal(parseArgs(['--step-timeout=30']).stepTimeoutSec, 30);
  assert.throws(() => parseArgs(['--step-timeout', 'soon']), /seconds/);
  assert.throws(() => parseArgs(['--headed-fallback']), /unknown argument/);
});

test('planSteps keeps the fixed order and always passes --verify and --no-fallback, never a headed flag', () => {
  assert.deepEqual(planSteps({ withNavent: false, withLiveness: false }).map((s) => s.name), ['scan', 'closing']);
  const all = planSteps({ withNavent: true, withLiveness: true });
  assert.deepEqual(all.map((s) => s.name), ['scan', 'navent', 'liveness', 'closing']);
  assert.deepEqual(all[0].args, ['--verify']);
  assert.ok(all[2].args.includes('--no-fallback') && all[2].args.includes('--tracker'));
  assert.ok(all.every((s) => !s.args.some((a) => /headed/.test(a))));
});

test('the small parsers read what the scripts actually print', () => {
  assert.equal(countPending('- [ ] a\n- [x] b\n- [!] c\n- [ ] d\n'), 2);
  assert.equal(newAddedFromScanRuns(`${RUNS_HEADER}r1\tc\t1\t0\t5\t4\t0\t1\t0\n`,
    `${RUNS_HEADER}r1\tc\t1\t0\t5\t4\t0\t1\t0\nr2\tc\t1\t0\t9\t2\t0\t7\t0\n`), 7);
  assert.equal(newAddedFromScanRuns(`${RUNS_HEADER}r1\tc\t1\t0\t5\t4\t0\t1\t0\n`, `${RUNS_HEADER}r1\tc\t1\t0\t5\t4\t0\t1\t0\n`), null,
    'no new row means the scan wrote nothing, not zero');
  assert.equal(parseNaventNew('Duplicates:         38\nNew offers:         3\n\nNew offers:\n  + x'), 3);
  assert.equal(parseNaventNew('no summary'), null);
  const live = [
    '✅ active     (api) #12 Acme · SRE (Applied)  https://jobs.example/1',
    '❌ expired    (api) #14 BigCo · DevOps (Evaluated)  https://jobs.example/2',
    '           closed: 404',
    '⚠️ uncertain        https://jobs.example/3',
    '           could not read',
    '❌ expired          https://jobs.example/4',
    '',
  ].join('\n');
  assert.deepEqual(parseLivenessExpired(live), [
    { label: '#14 BigCo · DevOps (Evaluated)', url: 'https://jobs.example/2', reason: 'closed: 404' },
    { label: '', url: 'https://jobs.example/4', reason: '' },
  ]);
});

test('runChain runs the steps in order and folds their results into one summary', async () => {
  const root = tempRoot();
  try {
    const { run, calls } = fakeRunner(root, {
      scan: (r) => {
        writeFileSync(join(r, 'data', 'scan-runs.tsv'), `${readFileSync(join(r, 'data', 'scan-runs.tsv'), 'utf8')}2026-11-02T04:00:00Z\tcompleted\t1\t0\t9\t2\t0\t2\t0\n`);
        writeFileSync(join(r, 'data', 'pipeline.md'), `${readFileSync(join(r, 'data', 'pipeline.md'), 'utf8')}- [ ] https://a.example/3 | new\n- [ ] https://a.example/4 | new\n`);
        return ok('scan output');
      },
      navent: () => ok('Navigations: 3\nNew offers:         1\n'),
      liveness: () => ({ ...ok('❌ expired    (api) #9 Acme · SRE (Applied)  https://jobs.example/9\n           closed\n'), code: 1 }),
      closing: () => ok(JSON.stringify({ closingSoon: [{ num: 9, date: '2026-11-05' }], overdue: [] })),
    });
    const s = await runChain({ root, withNavent: true, withLiveness: true, stepTimeoutSec: 60, run, now: () => new Date('2026-11-02T04:00:00Z') });
    assert.deepEqual(calls.map((c) => c.name), ['scan', 'navent', 'liveness', 'closing']);
    assert.ok(calls.every((c) => c.timeoutMs === 60_000));
    assert.equal(s.status, 'ok');
    assert.deepEqual(s.newAdded, { scan: 2, navent: 1 });
    assert.equal(s.newAddedTotal, 3);
    assert.equal(s.pendingBefore, 1);
    assert.equal(s.pendingInbox, 3);
    assert.equal(s.expired.length, 1);
    assert.equal(s.expired[0].url, 'https://jobs.example/9');
    assert.deepEqual(s.closingSoon, [{ num: 9, date: '2026-11-05' }]);
    assert.ok(s.steps.every((st) => st.ok), 'liveness exiting 1 (expired found) is a result, not a failure');
    assert.equal(s.steps[0].seconds, 1.5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('one failed step among working ones is not an outage; every network step failing is', async () => {
  const root = tempRoot();
  try {
    const partial = fakeRunner(root, { navent: () => ({ ...ok(), code: 1, stderr: 'HTTP 429, stopping' }) });
    const s1 = await runChain({ root, withNavent: true, run: partial.run });
    assert.equal(s1.status, 'ok');
    const navent = s1.steps.find((st) => st.name === 'navent');
    assert.equal(navent.ok, false);
    assert.match(navent.stderrTail, /429/);

    const down = fakeRunner(root, {
      scan: () => ({ ...ok(), code: 2, stderr: 'every target failed' }),
      navent: () => ({ ...ok(), code: null, signal: 'SIGTERM', timedOut: true }),
    });
    const s2 = await runChain({ root, withNavent: true, run: down.run });
    assert.equal(s2.status, 'outage');
    assert.equal(s2.newAdded.scan, null, 'a scan that wrote no scan-runs row reports null, not 0');
    assert.equal(s2.steps.find((st) => st.name === 'navent').timedOut, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the CLI prints {"status":"busy"} and exits 0 when another run holds the lock', () => {
  const root = tempRoot();
  const lock = tryAcquireDirLockSync(join(root, 'data', '.scheduled-chain.lock'), { staleMs: 60_000 });
  assert.ok(lock, 'test could not take the lock');
  try {
    const r = spawnSync(process.execPath, [join(ROOT, 'scheduled-chain.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, CAREER_OPS_ROOT: root },
      timeout: 30_000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).status, 'busy');
    assert.ok(existsSync(join(root, 'data', '.scheduled-chain.lock')), 'a busy run must not remove the holder\'s lock');
  } finally {
    releaseOrWarn(lock);
    rmSync(root, { recursive: true, force: true });
  }
});

test('lastScanRunRow returns the newest row only when this run wrote it', () => {
  const text = `${RUNS_HEADER}2026-11-01T00:00:00Z\tcompleted\t10\t2\t500\t400\t0\t7\t0\n2026-11-05T12:00:00Z\tcompleted\t215\t32\t37000\t34000\t9\t59\t1\n`;
  const row = lastScanRunRow(text, '2026-11-05T11:00:00Z');
  assert.equal(row.companies, '215');
  assert.equal(row.found, '37000');
  assert.equal(lastScanRunRow(text, '2026-11-05T13:00:00Z'), null, 'a row older than the run is not this run');
  assert.equal(lastScanRunRow(RUNS_HEADER), null);
  assert.equal(lastScanRunRow(undefined), null);
});

test('buildTimingRow lines up with the header and keeps a skipped step blank, not zero', () => {
  const summary = {
    status: 'ok', startedAt: '2026-11-05T10:00:00.000Z', finishedAt: '2026-11-05T10:22:00.000Z',
    steps: [
      { name: 'scan', ok: true, seconds: 767.8 },
      { name: 'liveness', ok: false, seconds: 334.8 },
      { name: 'closing', ok: true, seconds: 0.1 },
    ],
    newAddedTotal: 60, pendingInbox: 60,
  };
  const cells = buildTimingRow(summary, { companies: '215', found: '37422' }).split('\t');
  const cols = TIMINGS_HEADER.trim().split('\t');
  assert.equal(cells.length, cols.length);
  const at = Object.fromEntries(cols.map((c, i) => [c, cells[i]]));
  assert.equal(at.total_s, '1320');
  assert.equal(at.scan_s, '767.8');
  assert.equal(at.navent_s, '', 'navent did not run');
  assert.equal(at.liveness_s, '334.8');
  assert.equal(at.companies, '215');
  assert.equal(at.failed_steps, 'liveness');
  assert.equal(buildTimingRow(summary, null).split('\t')[7], '', 'no scan row, no company count');
});

test('appendTimingRow writes the header once and appends', () => {
  const root = tempRoot();
  try {
    const file = join(root, 'data', 'run-timings.tsv');
    appendTimingRow(file, 'a\tb');
    appendTimingRow(file, 'c\td');
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 3);
    assert.equal(lines[0] + '\n', TIMINGS_HEADER);
    assert.deepEqual(lines.slice(1), ['a\tb', 'c\td']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
