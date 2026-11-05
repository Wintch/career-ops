/**
 * postings-pool.mjs — a record of every posting a sweep has seen, before any
 * person's filter threw it away.
 *
 * `scan-ats-full.mjs` reads about 55,000 boards and keeps only what one person's
 * title filter wants, so the hours it costs serve one person. With `--pool <dir>` it
 * also writes each posting it reads here, and `pool-derive.mjs` then builds any
 * person's list from this file in seconds, without the network.
 *
 * The file is append-only TSV. A posting is written once, the first time its key is
 * seen, with that day as `first_seen`; later sweeps add only postings that are new.
 * That gives undated postings (iCIMS, some Workday tenants) a date of our own, which
 * the sweep alone cannot: it drops them.
 *
 * `baseline` marks postings written the first time a BOARD was seen. They are
 * "new" only because nobody had looked at that board before, so an undated one is
 * not reported as news (a dated one still is, by its own date).
 *
 * Columns: first_seen, baseline, source, company, title, location, posted_at, salary, key, url
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const POOL_FILE = 'postings.tsv';
export const POOL_HEADER = 'first_seen\tbaseline\tsource\tcompany\ttitle\tlocation\tposted_at\tsalary\tkey\turl\n';
const COLUMNS = POOL_HEADER.trim().split('\t');

/** Tabs and line breaks would break a row; collapse them. */
const clean = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();

/** @param {number | string | null | undefined} postedAt epoch ms or an ISO string */
export function postedDay(postedAt) {
  if (postedAt === null || postedAt === undefined || postedAt === '') return '';
  const ms = typeof postedAt === 'number' ? postedAt : Date.parse(postedAt);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
}

/** A parsed salary `{min, max, currency}` as one cell, `min|max|currency`; blank when there is none. */
export function salaryCell(salary) {
  if (!salary || typeof salary !== 'object') return '';
  const n = (v) => (Number.isFinite(v) && v > 0 ? String(Math.round(v)) : '');
  const min = n(salary.min);
  const max = n(salary.max);
  if (!min && !max) return '';
  const cur = typeof salary.currency === 'string' ? clean(salary.currency) : '';
  return `${min}|${max}|${cur}`;
}

/** @param {string} cell */
export function parseSalaryCell(cell) {
  if (!cell) return null;
  const [min, max, currency] = cell.split('|');
  const out = {};
  if (min) out.min = Number(min);
  if (max) out.max = Number(max);
  if (currency) out.currency = currency;
  return out.min || out.max ? out : null;
}

/** @param {string} line */
export function parsePoolLine(line) {
  const cells = line.split('\t');
  if (cells.length < COLUMNS.length) return null;
  return Object.fromEntries(COLUMNS.map((c, i) => [c, cells[i]]));
}

/**
 * Every row of a pool directory, oldest first.
 * @param {string} dir
 * @returns {Array<Record<string, string>>}
 */
export function readPool(dir) {
  const file = join(dir, POOL_FILE);
  if (!existsSync(file)) return [];
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line || line.startsWith('first_seen\t')) continue;
    const row = parsePoolLine(line);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * Open a pool for writing.
 * @param {string} dir
 * @param {{today: string, keyOf?: (job: object, source: string) => string}} opts
 *   today: the local calendar day to stamp as first_seen.
 *   keyOf: the identity of a posting (default its URL). A provider with a better
 *   key (Workday's requisition id) passes it so one posting served under several
 *   URLs is one row.
 */
export function openPool(dir, { today, keyOf = (job) => job.url }) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, POOL_FILE);
  if (!existsSync(file)) writeFileSync(file, POOL_HEADER, 'utf8');
  const known = new Set();
  const boards = new Set();
  for (const row of readPool(dir)) {
    known.add(row.key);
    boards.add(`${row.source}\u0000${row.company}`);
  }
  const pending = [];
  const stats = { added: 0, known: 0, skippedStale: 0, baseline: 0 };

  /**
   * @param {string} source e.g. "greenhouse"
   * @param {string} company the board's slug
   * @param {{url?: string, title?: string, location?: string, postedAt?: number | null}} job
   * @param {number} [cutoffMs] a dated posting older than this is not recorded
   * @param {boolean} [baseline] force the baseline flag (a board already counted this run)
   */
  function add(source, company, job, cutoffMs, baseline) {
    if (!job?.url || !job?.title) return false;
    if (cutoffMs && job.postedAt && job.postedAt < cutoffMs) { stats.skippedStale++; return false; }
    const key = clean(keyOf(job, source) || job.url);
    if (known.has(key)) { stats.known++; return false; }
    known.add(key);
    const flag = baseline ? 1 : 0;
    pending.push([
      today, flag, clean(source), clean(company), clean(job.title), clean(job.location),
      postedDay(job.postedAt), salaryCell(job.salary), key, clean(job.url),
    ].join('\t'));
    stats.added++;
    if (flag) stats.baseline++;
    return true;
  }

  /** Record a board's postings; the board's first appearance makes them baseline. */
  function addAll(source, company, jobs, cutoffMs) {
    const boardKey = `${source}\u0000${company}`;
    const baseline = !boards.has(boardKey);
    boards.add(boardKey);
    let n = 0;
    for (const job of Array.isArray(jobs) ? jobs : []) if (add(source, company, job, cutoffMs, baseline)) n++;
    return n;
  }

  function flush() {
    if (!pending.length) return 0;
    const n = pending.length;
    appendFileSync(file, `${pending.join('\n')}\n`, 'utf8');
    pending.length = 0;
    return n;
  }

  return { add, addAll, flush, stats, size: () => known.size };
}
