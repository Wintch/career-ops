#!/usr/bin/env node
/**
 * pool-derive.mjs — build one person's new-postings list from the shared pool
 *
 * `scan-ats-full.mjs --pool <dir>` records every posting a sweep reads, once per
 * machine. This script is the other half: it applies the data root's own
 * `portals.yml` filters to that pool and writes the survivors to the person's
 * `data/pipeline.md` and `data/scan-history.tsv`, exactly where a sweep of their
 * own would have. No network, and it takes seconds instead of hours.
 *
 * A posting is considered when
 *   - it carries a posting date inside the window (--since, default 3 days), or
 *   - it carries none and the pool first saw it inside the window, and not as part
 *     of a board's first appearance (those are "new" only because nobody had looked).
 *
 * Applied: title filter (with `title_filter_overrides` and `title_filter_full`),
 * `location_filter`, the do-not-apply blacklist, and the person's own scan history.
 * NOT applied, because the pool keeps no posting body and no board context:
 * `content_filter` and `domain_filter`. A person who relies on either should expect
 * more candidates than a sweep of their own would give.
 *
 * Run: node pool-derive.mjs --pool /shared/pool            (JSON summary, writes)
 *      node pool-derive.mjs --pool /shared/pool --dry-run  (writes nothing)
 *      node pool-derive.mjs --pool /shared/pool --since 7 --summary
 * The pool directory can also come from CAREER_OPS_POOL_DIR.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { loadYaml } from './lib/yaml-document.mjs';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { localToday } from './lib/local-today.mjs';
import { readPool, parseSalaryCell } from './lib/postings-pool.mjs';
import {
  buildLocationFilter, buildTitleFilterOverrides, buildTitleFilterWithOverrides,
  loadSeenUrls, appendToPipeline, appendToScanHistory, loadBlacklist,
  PORTALS_PATH, PIPELINE_PATH,
} from './scan.mjs';
import {
  resolveTitleFilterConfig, passesFilters, dedupTokenFor, providerForSource, filterBlacklistedOffers,
} from './scan-ats-full.mjs';

const USAGE = `Usage: node pool-derive.mjs --pool <dir> [options]
  --pool <dir>   the pool a sweep wrote with scan-ats-full.mjs --pool (or CAREER_OPS_POOL_DIR)
  --since <n>    window in days (default 3)
  --dry-run      report what would be added, write nothing
  --summary      human-readable output instead of JSON
  --help         print this usage block`;

const DAY_MS = 86_400_000;

/**
 * Pool rows that are news inside the window.
 * @param {Array<Record<string, string>>} rows
 * @param {string} cutoffDay YYYY-MM-DD
 */
export function eligibleRows(rows, cutoffDay) {
  return rows.filter((r) => (r.posted_at ? r.posted_at >= cutoffDay : r.baseline !== '1' && r.first_seen >= cutoffDay));
}

/** A pool row as the job object the sweep's filters expect. */
export function rowToJob(row) {
  const ms = row.posted_at ? Date.parse(`${row.posted_at}T00:00:00Z`) : null;
  return {
    url: row.url, title: row.title, company: row.company, location: row.location || '',
    postedAt: Number.isFinite(ms) ? ms : null,
    ...(row.salary ? { salary: parseSalaryCell(row.salary) } : {}),
  };
}

/**
 * @param {{rows: Array<Record<string, string>>, config: object, sinceDays: number, today: string,
 *          seenUrls: Set<string>, blacklist: Map<string, any>}} o
 */
export function derive({ rows, config, sinceDays, today, seenUrls, blacklist }) {
  const cutoffDay = new Date(Date.parse(`${today}T00:00:00Z`) - sinceDays * DAY_MS).toISOString().slice(0, 10);
  const titleConfig = resolveTitleFilterConfig(config);
  const titleFilter = buildTitleFilterWithOverrides(titleConfig, buildTitleFilterOverrides(config?.title_filter_overrides));
  const locationFilter = buildLocationFilter(config?.location_filter);
  const counts = { pool: rows.length, inWindow: 0, filtered: 0, alreadySeen: 0, blacklisted: 0, kept: 0 };
  const kept = [];
  for (const row of eligibleRows(rows, cutoffDay)) {
    counts.inWindow++;
    const job = rowToJob(row);
    if (!passesFilters(job, { titleFilter, locationFilter, contentFilter: null, titleFilterConfig: titleConfig, companySlug: row.company })) {
      counts.filtered++;
      continue;
    }
    const token = dedupTokenFor(job, providerForSource(row.source));
    if (seenUrls.has(token)) { counts.alreadySeen++; continue; }
    seenUrls.add(token);
    kept.push({ ...job, source: `${row.source}-full`, dateStatus: job.postedAt ? 'dated' : 'unknown' });
  }
  const live = filterBlacklistedOffers(kept, blacklist, { includeBlacklisted: false });
  counts.blacklisted = kept.length - live.offers.length;
  counts.kept = live.offers.length;
  return { offers: live.offers, counts, cutoffDay };
}

async function main() {
  const args = process.argv.slice(2);
  validateFlags(args, ['--pool', '--since', '--dry-run', '--summary', '--help', '-h'], USAGE, {
    valueFlags: ['--pool', '--since'], requireOperand: true,
  });
  const poolDir = flagValue(args, '--pool') || process.env.CAREER_OPS_POOL_DIR;
  if (!poolDir) { console.error('--pool (or CAREER_OPS_POOL_DIR) is required\n\n' + USAGE); process.exit(1); }
  if (!existsSync(path.resolve(poolDir))) { console.error(`pool not found: ${poolDir}`); process.exit(1); }
  if (!existsSync(PORTALS_PATH)) { console.error(`portals.yml not found at ${PORTALS_PATH}`); process.exit(1); }

  const sinceDays = hasFlag(args, '--since') ? Number(flagValue(args, '--since')) : 3;
  if (!Number.isFinite(sinceDays) || sinceDays <= 0) { console.error('--since needs a number of days above 0'); process.exit(1); }
  const config = loadYaml(readFileSync(PORTALS_PATH, 'utf-8')) || {};
  const today = localToday();
  const { seen } = loadSeenUrls({}, {
    extraTokensFor: (url, portal) => providerForSource(portal)?.dedupKey?.({ url }),
  });
  const { offers, counts, cutoffDay } = derive({
    rows: readPool(path.resolve(poolDir)), config, sinceDays, today, seenUrls: seen, blacklist: loadBlacklist(),
  });

  const dryRun = hasFlag(args, '--dry-run');
  if (offers.length && !dryRun) {
    if (!existsSync(PIPELINE_PATH)) {
      mkdirSync(path.dirname(PIPELINE_PATH), { recursive: true });
      writeFileSync(PIPELINE_PATH, '# Pipeline\n\n## Pendientes\n', 'utf-8');
    }
    await appendToPipeline(offers);
    await appendToScanHistory(offers, today);
  }
  const out = { today, sinceDays, cutoffDay, written: offers.length > 0 && !dryRun, ...counts };
  if (hasFlag(args, '--summary')) {
    console.log(`pool-derive ${out.written ? 'wrote' : 'would write (dry run)'}: ${counts.kept} new posting(s)`);
    console.log(`pool ${counts.pool} rows, ${counts.inWindow} in the last ${sinceDays} day(s), ${counts.filtered} dropped by your filters, ${counts.alreadySeen} already in your history, ${counts.blacklisted} blacklisted`);
    for (const o of offers.slice(0, 25)) console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    if (offers.length > 25) console.log(`  ... and ${offers.length - 25} more`);
  } else {
    console.log(JSON.stringify(out, null, 2));
  }
}

if (isMainModule(import.meta.url)) await main();
