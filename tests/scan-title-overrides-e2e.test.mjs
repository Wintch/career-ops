// tests/scan-title-overrides-e2e.test.mjs — `title_filter_overrides` through the real scan.
//
// buildTitleFilterWithOverrides is unit-tested elsewhere and scan-ats-full.mjs applies it, but
// scan.mjs built a plain title filter and never read the key, so a tracked company's own
// vocabulary ("Designer", "Art Director" at a publisher) could not be widened without loosening
// the global filter for every board. This runs scan.mjs against local-parser fixtures and asserts
// on what reached the pipeline.
import { pass, fail, ROOT, NODE } from './helpers.mjs';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';

console.log('\nscan.mjs — title_filter_overrides end to end');

function runScan(overrides) {
  const dir = mkdtempSync(join(tmpdir(), 'scan-tfo-'));
  try {
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data', 'applications.md'), `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
`);
    writeFileSync(join(dir, 'data', 'pipeline.md'), '# Pipeline\n\n');
    const portals = join(dir, 'portals.yml');
    const board = (name) => `  - name: ${name}
    careers_url: https://example.invalid/jobs
    parser:
      command: node
      script: tests/fixtures/publisher-board.mjs
`;
    writeFileSync(portals, `title_filter:
  positive:
    - "Illustrator"
  negative:
    - "Product Designer"
${overrides}tracked_companies:
${board('Publisher Fixture')}${board('Other Board')}`);
    execFileSync(NODE, [join(ROOT, 'scan.mjs')], {
      cwd: dir,
      env: { ...process.env, CAREER_OPS_ROOT: dir, CAREER_OPS_PORTALS: portals },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const p = join(dir, 'data', 'pipeline.md');
    return existsSync(p)
      ? readFileSync(p, 'utf-8').split('\n').filter((l) => /^- \[[ x]\]\s+https?:\/\//.test(l))
      : [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  // No override: both boards keep only the Illustrator title (same URL on both boards dedups to one).
  const plain = runScan('');
  if (plain.length === 1 && plain[0].includes('/jobs/5')) pass('without overrides only the global whitelist governs');
  else fail(`expected only /jobs/5, got ${JSON.stringify(plain)}`);

  // Override for one company: its Designer / Art Director titles pass, the global negative still vetoes
  // "Product Designer", and an unrelated title stays out. (Both boards serve the same URLs, which dedup
  // to one entry each, so which board let a posting through is not visible here; the third case below
  // shows an override that names nobody on the board changes nothing.)
  const widened = runScan(`title_filter_overrides:
  - companies: ["publisher fixture"]
    positive_extra: ["Designer", "Art Director"]
`);
  const ids = widened.map((u) => u.match(/\/jobs\/(\d)/)?.[1]).sort().join(',');
  if (ids === '1,2,5') pass('the named company passes Designer / Art Director and the Illustrator title');
  else fail(`expected jobs 1,2,5 (3 vetoed by the global negative, 4 unrelated), got ${ids}`);

  // Naming a company that is not on the board changes nothing.
  const other = runScan(`title_filter_overrides:
  - companies: ["somebody else"]
    positive_extra: ["Designer", "Art Director"]
`);
  if (other.length === 1 && other[0].includes('/jobs/5')) pass('an override for another company leaves the filter untouched');
  else fail(`expected only /jobs/5, got ${JSON.stringify(other)}`);
} catch (e) {
  fail(`title_filter_overrides e2e crashed: ${e.message}`);
}
