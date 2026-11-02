// tests/scan-workday-title-overrides.test.mjs — the title hint scan.mjs hands a
// provider as ctx.titleWanted must make the same decision as the filter that
// later drops postings, including the company's title_filter_overrides entry.
// It was built as titleFilter(title) without the company name, so a Workday
// tenant whose title passed only through an override never had its
// multi-location placeholder resolved and kept a location like "2 Locations".
//
// Same harness as scan-workday-placeholder-title-filter.test.mjs: the real
// scan.mjs (--dry-run) against a scratch data root, globalThis.fetch replaced by
// an --import preload that serves a fake tenant and logs each request.
//
// Run: node --test tests/scan-workday-title-overrides.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CXS = 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/acmecareers';

const PAGE = {
  total: 3,
  jobPostings: [
    { title: 'Platform Engineer', externalPath: '/job/USA---Austin-TX/Platform-Engineer_R1', locationsText: '3 Locations', postedOn: 'Posted Today' },
    { title: 'Staff Accountant', externalPath: '/job/USA---Austin-TX/Staff-Accountant_R2', locationsText: '2 Locations', postedOn: 'Posted Today' },
    { title: 'Payroll Specialist', externalPath: '/job/USA---Austin-TX/Payroll-Specialist_R3', locationsText: '4 Locations', postedOn: 'Posted Today' },
  ],
};
const DETAIL = { jobPostingInfo: { location: 'USA - Austin, TX', additionalLocations: ['USA - Remote'], startDate: '2026-10-15' } };

// Values come from the environment, never spliced into this source.
const PRELOAD = [
  "import { appendFileSync } from 'node:fs';",
  'const log = process.env.FAKE_WD_LOG;',
  'const cxs = process.env.FAKE_WD_CXS;',
  'const page = process.env.FAKE_WD_PAGE;',
  'const detail = process.env.FAKE_WD_DETAIL;',
  'globalThis.fetch = async (input, init = {}) => {',
  '  const url = String(input?.url ?? input);',
  "  appendFileSync(log, `${(init.method || 'GET').toUpperCase()} ${url}\\n`);",
  "  const json = (body) => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });",
  "  if (url === `${cxs}/jobs`) return json(page);",
  "  if (url.startsWith(`${cxs}/job/`)) return json(detail);",
  "  return new Response('not found', { status: 404 });",
  '};',
].join('\n');

function runScan(portalsYml) {
  const dir = mkdtempSync(join(tmpdir(), 'scan-wd-tfo-'));
  try {
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data', 'applications.md'), '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n');
    const portals = join(dir, 'portals.yml');
    writeFileSync(portals, portalsYml);
    const preload = join(dir, 'fake-workday.mjs');
    writeFileSync(preload, PRELOAD);
    const log = join(dir, 'requests.log');
    const env = { ...process.env };
    for (const name of ['CAREER_OPS_PORTALS', 'CAREER_OPS_PROFILE', 'CAREER_OPS_PIPELINE', 'CAREER_OPS_SCAN_HISTORY', 'CAREER_OPS_ROOT', 'CAREER_OPS_DATA_DIR']) delete env[name];
    const run = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, join(ROOT, 'scan.mjs'), '--dry-run'], {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 60_000,
      env: {
        ...env,
        CAREER_OPS_ROOT: dir,
        CAREER_OPS_PORTALS: portals,
        FAKE_WD_LOG: log,
        FAKE_WD_CXS: CXS,
        FAKE_WD_PAGE: JSON.stringify(PAGE),
        FAKE_WD_DETAIL: JSON.stringify(DETAIL),
      },
    });
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    const requests = existsSync(log) ? readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean) : [];
    return { out, status: run.status, details: requests.filter((r) => r.startsWith('GET ') && r.includes(`${CXS}/job/`)) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const base = 'title_filter:\n  positive:\n    - "Engineer"\n';
const company = `tracked_companies:
  - name: Acme
    careers_url: https://acme.wd5.myworkdayjobs.com/acmecareers
`;

test('a title that passes only through the company override still gets its placeholder resolved', () => {
  const { out, details } = runScan(`${base}title_filter_overrides:\n  - companies: ["acme"]\n    positive_extra: ["Accountant"]\n${company}`);
  assert.deepEqual(details, [
    `GET ${CXS}/job/USA---Austin-TX/Platform-Engineer_R1`,
    `GET ${CXS}/job/USA---Austin-TX/Staff-Accountant_R2`,
  ], out);
  assert.match(out, /resolved 2 of 2 multi-location placeholder\(s\).*1 skipped by the title filter/);
});

test('an override naming another company does not widen the hint', () => {
  const { out, details } = runScan(`${base}title_filter_overrides:\n  - companies: ["somebody else"]\n    positive_extra: ["Accountant"]\n${company}`);
  assert.deepEqual(details, [`GET ${CXS}/job/USA---Austin-TX/Platform-Engineer_R1`], out);
});
