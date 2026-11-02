// tests/providers/entertainmentcareers.test.mjs — provider-contract tests for
// EntertainmentCareers.net (providers/entertainmentcareers.mjs).
//
// Fixtures are trimmed from the live board (checked 2026-10-24):
//   - a card opens at `class="result_title"`, alternating `result_block` /
//     `result_altblock` wrappers (zebra striping) — the split keys on the
//     inner marker so either wrapper is covered;
//   - a `members-only-badge` span marks a card paywalled-for-candidates in
//     the site's own UI; such cards must never reach fetch()'s output
//     (Source Indexing Policy rule 1), even though the raw markup still
//     carries the text;
//   - robots.txt blocks `/2/search/` (the site's own pagination target) under
//     `User-agent: *`, so this provider only ever requests page 1 of each
//     keyword — there is no pagination to test.
import { pass, fail } from '../helpers.mjs';
import entertainmentcareers, { buildSearchUrl, parseSearchPage, parsePostedAt } from '../../providers/entertainmentcareers.mjs';

console.log('\nProvider — entertainmentcareers');

// ── id ──
if (entertainmentcareers.id === 'entertainmentcareers') pass('entertainmentcareers.id is "entertainmentcareers"');
else fail(`entertainmentcareers.id is ${JSON.stringify(entertainmentcareers.id)}`);

// ── detect(): explicit selection only — a branded single host, no vendor pattern to auto-claim ──
{
  const hit = entertainmentcareers.detect({ name: 'EntertainmentCareers.net', provider: 'entertainmentcareers' });
  if (hit && hit.url === 'https://www.entertainmentcareers.net/jobs/s/editor') {
    pass('detect() resolves provider:entertainmentcareers → a listing URL');
  } else {
    fail(`detect() returned ${JSON.stringify(hit)}`);
  }
  if (entertainmentcareers.detect({ name: 'EntertainmentCareers.net' }) === null) {
    pass('detect() returns null without provider:entertainmentcareers');
  } else {
    fail('detect() must require provider:entertainmentcareers');
  }
  if (entertainmentcareers.detect(null) === null && entertainmentcareers.detect(undefined) === null) {
    pass('detect() never throws on junk input');
  } else {
    fail('detect() must tolerate null/undefined entries');
  }
}

// ── buildSearchUrl(): keyword slugging ──
if (buildSearchUrl('video editor') === 'https://www.entertainmentcareers.net/jobs/s/video-editor') {
  pass('buildSearchUrl(): spaces become hyphens');
} else {
  fail(`buildSearchUrl drift: ${buildSearchUrl('video editor')}`);
}
if (buildSearchUrl('  Colorist  ') === 'https://www.entertainmentcareers.net/jobs/s/colorist') {
  pass('buildSearchUrl(): trims and lowercases');
} else {
  fail(`buildSearchUrl case/trim drift: ${buildSearchUrl('  Colorist  ')}`);
}

// ── parsePostedAt(): relative labels, no fabricated dates ──
{
  const now = Date.parse('2026-10-24T12:00:00Z');
  const cases = [
    ['12 hours ago (PT)', now - 12 * 3_600_000],
    ['3 days ago', now - 3 * 86_400_000],
    ['2 weeks ago', now - 14 * 86_400_000],
  ];
  let ok = true;
  for (const [label, want] of cases) {
    const got = parsePostedAt(label, now);
    if (typeof got !== 'number' || got !== want) { ok = false; fail(`parsePostedAt("${label}") => ${got}, want ${want}`); }
  }
  if (ok) pass('parsePostedAt() maps every relative label the board emits');

  if (parsePostedAt('NEW', now) === undefined) pass('parsePostedAt(): "NEW" with no "ago" clause yields undefined, not a fabricated date');
  else fail('an unparseable label must omit postedAt');
}

// ── parseSearchPage(): the real card shapes ──
const FREE_CARD = `
    <div class="result_altblock">
      <div class="result_title">
        <b>3.</b>&nbsp;
        <a href="/sinclair/news-video-editor/job/534677/">News <span class="highlight">Video</span> <span class="highlight">Editor</span></a>
      </div>
      <div class="result-company">Sinclair</div>
      <div class="result-location">
<span class="loc-label">Market:</span> Portland <span class="loc-label">Location:</span> Portland, ME
      </div>
      <div class="result-dateline">
        2 days ago (PT)
      </div>
      <div class="context">Full Time Job&hellip;</div>
    </div>`;

const MEMBERS_ONLY_CARD = `
    <div class="result_block">
      <div class="result_title">
        <b>1.</b>&nbsp;
<span class="members-only-badge">Members Only</span>
        <a href="/hearst-television/photographer-and-video-editor/job/534842/">Photographer and <span class="highlight">Video</span> <span class="highlight">Editor</span></a>
      </div>
      <div class="result-company">Hearst Television</div>
      <div class="result-location">
<span class="loc-label">Market:</span> Sacramento <span class="loc-label">Location:</span> Sacramento, CA
      </div>
      <div class="result-dateline">
        12 hours ago (PT) <span class="new-badge">NEW</span>
      </div>
    </div>`;

const ENTITY_CARD = `
    <div class="result_altblock">
      <div class="result_title">
        <b>4.</b>&nbsp;
        <a href="/am-ent/editor-ae/job/999999/">Editor &amp; Producer</a>
      </div>
      <div class="result-company">A &amp; E Networks</div>
      <div class="result-location">
<span class="loc-label">Location:</span> New York, NY
      </div>
    </div>`;

const OFFSITE_CARD = `
    <div class="result_altblock">
      <div class="result_title">
        <b>5.</b>&nbsp;
        <a href="https://evil.example/job/1/">Off-host posting</a>
      </div>
      <div class="result-company">Nobody</div>
    </div>`;

const PAGE = `<div class="summary"><b>3</b> jobs found.</div>${MEMBERS_ONLY_CARD}${FREE_CARD}${ENTITY_CARD}`;

{
  const { jobs, cardCount } = parseSearchPage(PAGE);
  if (cardCount === 3) pass('parseSearchPage(): counts every result_title window, including members-only');
  else fail(`cardCount drift: ${cardCount}`);

  if (jobs.length === 2) pass('parseSearchPage(): drops the members-only card from the output');
  else fail(`parseSearchPage() returned ${jobs.length} jobs: ${JSON.stringify(jobs)}`);

  const sinclair = jobs.find((j) => j.url.includes('/sinclair/'));
  if (sinclair && sinclair.title === 'News Video Editor' && sinclair.company === 'Sinclair' && sinclair.location === 'Portland, ME') {
    pass('parseSearchPage(): title/company/location read correctly, "Market:"/"Location:" labels stripped');
  } else {
    fail(`sinclair card drift: ${JSON.stringify(sinclair)}`);
  }
  if (sinclair && sinclair.requisitionId === '534677') pass('parseSearchPage(): requisitionId is the numeric /job/{id}/ segment');
  else fail(`requisitionId drift: ${JSON.stringify(sinclair && sinclair.requisitionId)}`);
  if (sinclair && typeof sinclair.postedAt === 'number') pass('parseSearchPage(): postedAt derived from the dateline');
  else fail('sinclair card should carry a parsed postedAt');

  const entityJob = jobs.find((j) => j.url.includes('/am-ent/'));
  if (entityJob && entityJob.title === 'Editor & Producer' && entityJob.company === 'A & E Networks') {
    pass('parseSearchPage(): HTML entities decoded once in title and company');
  } else {
    fail(`entity card drift: ${JSON.stringify(entityJob)}`);
  }
}

{
  const { jobs } = parseSearchPage(OFFSITE_CARD);
  if (jobs.length === 0) pass('parseSearchPage(): a card whose href resolves off-origin is dropped');
  else fail(`off-origin card leaked through: ${JSON.stringify(jobs)}`);
}

// ── fetch(): dedup across keywords, members-only exclusion, SSRF pinning ──
{
  const pages = new Map([
    ['https://www.entertainmentcareers.net/jobs/s/video-editor', PAGE],
    ['https://www.entertainmentcareers.net/jobs/s/colorist', `<div class="summary"><b>1</b> jobs found.</div>${FREE_CARD}`], // same Sinclair posting again
  ]);
  /** @type {any[]} */
  const opts = [];
  let slept = 0;
  const ctx = {
    sleep: async (ms) => { slept += ms; },
    fetchText: async (url, o) => { opts.push(o); return pages.get(url) ?? '<div class="summary"><b>0</b> jobs found.</div>'; },
  };
  const jobs = await entertainmentcareers.fetch({ name: 'EntertainmentCareers.net', searchKeywords: ['video editor', 'colorist'] }, ctx);
  if (jobs.length === 2) pass('fetch(): members-only card excluded, repeated posting deduped across keywords');
  else fail(`fetch() returned ${jobs.length} jobs: ${JSON.stringify(jobs.map((j) => j.url))}`);
  if (slept >= 250) pass('fetch(): paces between successive keyword searches');
  else fail(`fetch() slept only ${slept}ms between keywords`);
  const pinned = opts.length > 0 && opts.every((o) => o && o.redirect === 'error' && typeof o.headers?.['User-Agent'] === 'string' && o.headers['User-Agent'].length > 0);
  if (pinned) pass('fetch(): every request carries redirect:error and a browser-like User-Agent');
  else fail(`request options drift: ${JSON.stringify(opts)}`);
}

// ── fetch(): empty vs broken ──
{
  const emptyCtx = { sleep: async () => {}, fetchText: async () => '<div class="summary"><b>0</b> jobs found.</div>' };
  const jobs = await entertainmentcareers.fetch({ searchKeywords: ['nonexistent role xyz'] }, emptyCtx);
  if (Array.isArray(jobs) && jobs.length === 0) pass('fetch(): a genuinely empty search ("0 jobs found") returns [], not a throw');
  else fail(`expected [] for an empty search, got ${JSON.stringify(jobs)}`);
}
{
  const noSummaryCtx = { sleep: async () => {}, fetchText: async () => '<html><body>Access Denied</body></html>' };
  try {
    await entertainmentcareers.fetch({ searchKeywords: ['editor'] }, noSummaryCtx);
    fail('fetch() must throw when the "jobs found" summary marker is absent entirely');
  } catch {
    pass('fetch() throws on a page with no "jobs found" summary (block page / markup change)');
  }
}
{
  const markupChangedCtx = { sleep: async () => {}, fetchText: async () => '<div class="summary"><b>5</b> jobs found.</div>' };
  try {
    await entertainmentcareers.fetch({ searchKeywords: ['editor'] }, markupChangedCtx);
    fail('fetch() must throw when the summary reports jobs but no cards parsed');
  } catch {
    pass('fetch() throws when "N jobs found" (N>0) but zero result_title cards parsed — a broken selector, not an empty board');
  }
}

// ── fetch(): the health probe gets exactly one request, and its rejection propagates unwrapped ──
{
  /** @type {string[]} */
  const asked = [];
  const probeCtx = {
    maxPages: 1,
    sleep: async () => {},
    fetchText: async (url) => { asked.push(url); return PAGE; },
  };
  await entertainmentcareers.fetch({ searchKeywords: ['video editor', 'colorist', 'editor'] }, probeCtx);
  if (asked.length === 1) pass('fetch(): ctx.maxPages (health probe) caps the run to one keyword search');
  else fail(`probe not capped: requested ${JSON.stringify(asked)}`);
}
{
  class ProbeBudget extends Error {}
  const rejectingProbeCtx = {
    maxPages: 1,
    sleep: async () => {},
    fetchText: async () => { throw new ProbeBudget('budget'); },
  };
  try {
    await entertainmentcareers.fetch({ searchKeywords: ['video editor'] }, rejectingProbeCtx);
    fail('fetch() must propagate a ctx.fetchText rejection while probing, not swallow it');
  } catch (err) {
    if (err instanceof ProbeBudget) pass('fetch(): a ctx.fetchText rejection during a probe propagates unwrapped');
    else fail(`rejection was rewrapped: ${err}`);
  }
}

// ── fetch(): outside a probe, one bad keyword doesn't lose the others (recall-first) ──
{
  const pages = new Map([
    ['https://www.entertainmentcareers.net/jobs/s/colorist', `<div class="summary"><b>1</b> jobs found.</div>${FREE_CARD}`],
  ]);
  const flakyCtx = {
    sleep: async () => {},
    fetchText: async (url) => {
      if (url.includes('video-editor')) { const e = new Error('not found'); e.status = 404; throw e; }
      return pages.get(url) ?? '<div class="summary"><b>0</b> jobs found.</div>';
    },
  };
  const jobs = await entertainmentcareers.fetch({ searchKeywords: ['video editor', 'colorist'] }, flakyCtx);
  if (jobs.length === 1 && jobs[0].company === 'Sinclair') {
    pass('fetch(): a non-probing run keeps results from keywords that succeeded despite one that failed');
  } else {
    fail(`recall-first drift: ${JSON.stringify(jobs)}`);
  }
}

// ── fetch(): rejects a config with no usable searchKeywords ──
{
  try {
    await entertainmentcareers.fetch({ name: 'EntertainmentCareers.net' }, { sleep: async () => {}, fetchText: async () => PAGE });
    fail('fetch() must reject an entry with no searchKeywords');
  } catch {
    pass('fetch() throws loudly when entry.searchKeywords is missing/empty');
  }
}
