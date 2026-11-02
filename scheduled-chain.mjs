#!/usr/bin/env node
// scheduled-chain.mjs — one command for an external scheduler (cron, a Hermes
// --no-agent job, systemd): runs the zero-token scans in a fixed order, one at a
// time, and prints ONE JSON summary a scheduler can format into a notification.
//
//   node scheduled-chain.mjs                                  # scan.mjs --verify only
//   node scheduled-chain.mjs --with-navent --with-liveness    # + Bumeran/ZonaJobs, + tracker liveness
//   node scheduled-chain.mjs --step-timeout 1500              # kill any step that runs past 25 min
//   node scheduled-chain.mjs --help
//
// Steps, in order (each a child `node` process in the checkout, so every script
// resolves the data root exactly as it does when run by hand):
//   1. scan      node scan.mjs --verify
//   2. navent    node scan-navent.mjs                                    (--with-navent)
//   3. liveness  node check-liveness.mjs --no-fallback --tracker --status=Evaluated,Applied
//                                                                        (--with-liveness)
//   4. closing   node closing-soon.mjs                                   (always; no network)
//
// Headless and zero-token by construction: no step can open a visible browser
// (`--no-fallback` is fixed, `scan.mjs --headed-fallback` is never passed) and no
// step calls a model. Nothing is evaluated, applied to or sent.
//
// The whole chain holds one lock (`data/.scheduled-chain.lock`, lib/dir-lock.mjs),
// so two scheduled runs never overlap. A second run that finds it held prints
// {"status":"busy"} and exits 0: that is a skipped run, not a failure. scan.mjs
// still takes the pipeline lock itself, so an interactive edit is safe either way.
//
// Exit code: 2 only when every network step that ran failed (a total outage:
// scan.mjs exits 2 when no target could be read). One failed step among working
// ones exits 0 and shows `ok: false` on that step. check-liveness.mjs exiting 1
// means it found expired or uncertain postings, which is a result, not a failure.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { tryAcquireDirLockSync, releaseOrWarn } from './lib/dir-lock.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const CODE_ROOT = dirname(fileURLToPath(import.meta.url));
const LIVENESS_STATUSES = 'Evaluated,Applied';
const TAIL_LINES = 8;

const USAGE = `Usage: node scheduled-chain.mjs [--with-navent] [--with-liveness] [--step-timeout <seconds>]

Runs scan.mjs --verify, then optionally scan-navent.mjs and
check-liveness.mjs --no-fallback --tracker --status=${LIVENESS_STATUSES},
then closing-soon.mjs, one at a time under one lock, and prints one JSON summary.
Exit 2 only on a total outage; a busy lock prints {"status":"busy"} and exits 0.`;

/**
 * @param {string[]} argv
 * @returns {{withNavent: boolean, withLiveness: boolean, stepTimeoutSec: number, help: boolean}}
 */
export function parseArgs(argv) {
  const opts = { withNavent: false, withLiveness: false, stepTimeoutSec: 0, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--with-navent') opts.withNavent = true;
    else if (a === '--with-liveness') opts.withLiveness = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--step-timeout' || a.startsWith('--step-timeout=')) {
      const raw = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) throw new Error(`--step-timeout needs a number of seconds, got ${JSON.stringify(raw)}`);
      opts.stepTimeoutSec = n;
    } else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

/**
 * The steps a run will execute, in order.
 * @param {{withNavent: boolean, withLiveness: boolean}} opts
 * @returns {Array<{name: string, script: string, args: string[], network: boolean}>}
 */
export function planSteps({ withNavent, withLiveness }) {
  const steps = [{ name: 'scan', script: 'scan.mjs', args: ['--verify'], network: true }];
  if (withNavent) steps.push({ name: 'navent', script: 'scan-navent.mjs', args: [], network: true });
  if (withLiveness) {
    steps.push({ name: 'liveness', script: 'check-liveness.mjs', args: ['--no-fallback', '--tracker', `--status=${LIVENESS_STATUSES}`], network: true });
  }
  steps.push({ name: 'closing', script: 'closing-soon.mjs', args: [], network: false });
  return steps;
}

/** Unchecked inbox lines (`- [ ] ...`) in pipeline.md text. */
export function countPending(text) {
  return typeof text === 'string' ? (text.match(/^- \[ \] /gm) || []).length : 0;
}

/**
 * The `new_added` of the scan-runs.tsv row a run appended, or null when the
 * file gained no row (the scan crashed before writing one).
 * @param {string} before
 * @param {string} after
 * @returns {number | null}
 */
export function newAddedFromScanRuns(before, after) {
  const rows = (t) => (typeof t === 'string' ? t.split('\n').filter((l) => l.trim()) : []);
  const a = rows(after);
  if (a.length < 2 || a.length <= rows(before).length) return null;
  const col = a[0].split('\t').indexOf('new_added');
  if (col < 0) return null;
  const n = Number(a[a.length - 1].split('\t')[col]);
  return Number.isFinite(n) ? n : null;
}

/** The "New offers: N" count scan-navent.mjs prints, or null. */
export function parseNaventNew(stdout) {
  const m = typeof stdout === 'string' ? stdout.match(/^New offers:\s+(\d+)\s*$/m) : null;
  return m ? Number(m[1]) : null;
}

/**
 * Expired postings from check-liveness.mjs output: the `❌ expired` lines, each
 * with its tracker label and the indented reason line that follows it.
 * @param {string} stdout
 * @returns {Array<{label: string, url: string, reason: string}>}
 */
export function parseLivenessExpired(stdout) {
  const lines = typeof stdout === 'string' ? stdout.split('\n') : [];
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^❌ expired\s+(?:\(api\)\s+)?(.*?)\s*(https?:\/\/\S+)\s*$/);
    if (!m) continue;
    const next = lines[i + 1] ?? '';
    out.push({ label: m[1].trim(), url: m[2], reason: /^\s{4,}\S/.test(next) ? next.trim() : '' });
  }
  return out;
}

/** @param {string} text */
function tail(text) {
  return typeof text === 'string' ? text.trimEnd().split('\n').slice(-TAIL_LINES).join('\n') : '';
}

/**
 * Whether a finished step counts as failed for the outage rule.
 * @param {string} name
 * @param {{code: number | null, timedOut: boolean}} r
 */
function stepFailed(name, r) {
  if (r.timedOut || r.code === null) return true;
  if (name === 'liveness') return r.code !== 0 && r.code !== 1;
  return r.code !== 0;
}

/**
 * Run one script as a child `node` process. Resolves, never rejects.
 * @param {{script: string, args: string[]}} step
 * @param {{timeoutMs: number}} opts
 * @returns {Promise<{code: number | null, signal: string | null, timedOut: boolean, stdout: string, stderr: string, ms: number}>}
 */
export function runNodeScript(step, { timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(CODE_ROOT, step.script), ...step.args], {
      cwd: CODE_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    let killer = null;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    }, timeoutMs) : null;
    child.on('error', (err) => {
      stderr += `\n${err.message}`;
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (killer) clearTimeout(killer);
      resolve({ code, signal, timedOut, stdout, stderr, ms: Date.now() - started });
    });
  });
}

/**
 * Run the chain and build the summary. `run` is injectable for tests.
 * @param {{root: string, pipelinePath?: string, withNavent?: boolean, withLiveness?: boolean, stepTimeoutSec?: number,
 *          run?: typeof runNodeScript, now?: () => Date}} opts
 */
export async function runChain({ root, pipelinePath, withNavent = false, withLiveness = false, stepTimeoutSec = 0, run = runNodeScript, now = () => new Date() }) {
  const pipeline = pipelinePath || join(root, 'data', 'pipeline.md');
  const scanRuns = join(root, 'data', 'scan-runs.tsv');
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

  const startedAt = now().toISOString();
  const pendingBefore = countPending(read(pipeline));
  const summary = {
    status: 'ok',
    startedAt,
    finishedAt: '',
    newAdded: { scan: null, navent: null },
    newAddedTotal: 0,
    pendingBefore,
    pendingInbox: pendingBefore,
    expired: [],
    closingSoon: [],
    overdue: [],
    steps: [],
  };

  const networkOk = [];
  for (const step of planSteps({ withNavent, withLiveness })) {
    const runsBefore = step.name === 'scan' ? read(scanRuns) : '';
    const r = await run(step, { timeoutMs: stepTimeoutSec * 1000 });
    const failed = stepFailed(step.name, r);
    const entry = { name: step.name, ok: !failed, exitCode: r.code, signal: r.signal ?? null, timedOut: r.timedOut, seconds: Math.round(r.ms / 100) / 10 };
    if (failed) entry.stderrTail = tail(r.stderr) || tail(r.stdout);
    summary.steps.push(entry);
    if (step.network) networkOk.push(!failed);

    if (step.name === 'scan') summary.newAdded.scan = newAddedFromScanRuns(runsBefore, read(scanRuns));
    else if (step.name === 'navent') summary.newAdded.navent = parseNaventNew(r.stdout);
    else if (step.name === 'liveness') summary.expired = parseLivenessExpired(r.stdout);
    else if (step.name === 'closing' && !failed) {
      try {
        const report = JSON.parse(r.stdout);
        summary.closingSoon = Array.isArray(report.closingSoon) ? report.closingSoon : [];
        summary.overdue = Array.isArray(report.overdue) ? report.overdue : [];
      } catch {
        entry.ok = false;
        entry.stderrTail = 'closing-soon.mjs did not print JSON';
      }
    }
  }

  summary.newAddedTotal = (summary.newAdded.scan ?? 0) + (summary.newAdded.navent ?? 0);
  summary.pendingInbox = countPending(read(pipeline));
  if (networkOk.length > 0 && networkOk.every((ok) => !ok)) summary.status = 'outage';
  summary.finishedAt = now().toISOString();
  return summary;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`scheduled-chain: ${err.message}\n\n${USAGE}`);
    process.exit(1);
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  const root = getCareerOpsRoot();
  const lock = tryAcquireDirLockSync(join(root, 'data', '.scheduled-chain.lock'), {
    staleMs: 60_000,
    createParent: true,
    owner: { tool: 'scheduled-chain' },
  });
  if (!lock) {
    console.log(JSON.stringify({ status: 'busy', note: 'another scheduled-chain run holds data/.scheduled-chain.lock' }));
    return;
  }
  let summary;
  try {
    summary = await runChain({ root, pipelinePath: process.env.CAREER_OPS_PIPELINE, ...opts });
  } finally {
    releaseOrWarn(lock);
  }
  console.log(JSON.stringify(summary, null, 2));
  if (summary.status === 'outage') process.exitCode = 2;
}

if (isMainModule(import.meta.url)) await main();
