// tests/providers/djinni.test.mjs — provider-contract tests for the Djinni
// board (providers/djinni.mjs).
//
// The fixtures reproduce shapes measured on the live board on 2026-10-11, and
// each one exists because it decides the parser's design:
//
//   - a listing page embeds ONE JSON-LD array of JobPosting objects (15 per
//     page) — the RSS feed names no employer, so this is what is read;
//   - an unknown `primary_keyword` silently serves the whole board; only the
//     page's canonical link (`/jobs/` instead of `/jobs/keyword-{slug}/`)
//     tells it apart, so it must throw rather than flood the pipeline;
//   - an empty category keeps its canonical and has no JSON-LD and no posting
//     links → []; posting links with no JSON-LD is a markup change → THROW;
//   - one page past the last, the board 302s back to `/jobs/` — the end of
//     the walk, not a failure;
//   - salaries are monthly USD ranges and must be annualized; `datePosted`
//     has no offset and must not depend on the machine's timezone.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — djinni');

/** One JobPosting object, trimmed from the live board; structure preserved. */
const POSTING = (n, over = {}) => ({
  '@context': 'https://schema.org/',
  '@type': 'JobPosting',
  title: `Senior DevOps Engineer ${n}`,
  url: `https://djinni.co/jobs/${800000 + n}-senior-devops-engineer-${n}/`,
  identifier: String(800000 + n),
  datePosted: '2026-10-10T15:55:42.429344',
  description: `We are looking for a DevOps engineer ${n}.\nAWS, Terraform.`,
  hiringOrganization: { '@type': 'Organization', name: 'Acme' },
  employmentType: 'FULL_TIME',
  jobLocationType: 'TELECOMMUTE',
  applicantLocationRequirements: { '@type': 'AdministrativeArea', address: { '@type': 'PostalAddress', addressRegion: 'Europe' } },
  ...over,
});

const CANON_DEVOPS = 'https://djinni.co/jobs/keyword-dev_ops/';
const PAGE = (postings, { canonical = CANON_DEVOPS, links = postings.map(p => p.url).filter(Boolean) } = {}) => `<!doctype html>
<html lang="en"><head><title>Jobs DevOps – Djinni</title>
<link rel="canonical" href="${canonical}">
${postings.length ? `<script type="application/ld+json">${JSON.stringify(postings)}</script>` : ''}
</head><body>${links.map(u => `<a class="job-item__title-link" href="${new URL(u).pathname}">x</a>`).join('\n')}</body></html>`;

const fullPage = (start, size = 15, opts) => PAGE(Array.from({ length: size }, (_, i) => POSTING(start + i)), opts);
const EMPTY_CATEGORY = PAGE([], { canonical: 'https://djinni.co/jobs/keyword-blazor/' });
const REFUSED_REDIRECT = () => Object.assign(new TypeError('fetch failed'), { cause: { message: 'unexpected redirect' } });

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/djinni.mjs')).href);
  const provider = mod.default;
  const { isDjinniUrl, resolveKeywords, buildListUrl, toEpochMs, locationOf, salaryOf, parseListingPage } = mod;
  const throws = (fn) => { try { fn(); return null; } catch (e) { return String(e && e.message); } };

  if (provider.id === 'djinni') pass('djinni.id is "djinni"');
  else fail(`djinni.id is ${JSON.stringify(provider.id)}`);

  // ── detect() ──
  const d = (e) => provider.detect(e);
  if (d({ careers_url: 'https://djinni.co/hire' })?.url === 'https://djinni.co/jobs/'
      && d({ careers_url: 'https://www.djinni.co/jobs/?primary_keyword=DevOps' })?.url === 'https://djinni.co/jobs/'
      && d({ api: 'https://djinni.co/' })?.url === 'https://djinni.co/jobs/'
      && d({ provider: 'djinni' })?.url === 'https://djinni.co/jobs/') {
    pass('detect() claims any https djinni.co URL (the /hire landing included) and an explicit provider:djinni');
  } else {
    fail('detect() missed a Djinni URL');
  }
  const refused = ['https://djinni.co.evil.example/', 'https://evildjinni.co/', 'http://djinni.co/jobs/', 'https://evil.example/djinni.co', 'not a url', ''];
  if (refused.every((u) => d({ careers_url: u }) === null)) pass('detect() refuses look-alike hosts, plain http and junk');
  else fail(`detect() claimed: ${refused.filter((u) => d({ careers_url: u }) !== null).join(', ')}`);
  if (d(null) === null && d(undefined) === null && d({}) === null && d({ careers_url: 42 }) === null) pass('detect() returns null (no throw) on null, missing and non-string input');
  else fail('detect() threw or claimed junk');
  if (isDjinniUrl('https://DJINNI.co/x') && !isDjinniUrl('https://djinni.com/')) pass('isDjinniUrl(): case-insensitive host, exact domain');
  else fail('isDjinniUrl drift');

  // ── helpers ──
  if (JSON.stringify(resolveKeywords({ searchKeywords: [' DevOps ', 'devops', 'Sysadmin'] })) === '["DevOps","Sysadmin"]'
      && JSON.stringify(resolveKeywords({ searchKeywords: 'QA' })) === '["QA"]'
      && JSON.stringify(resolveKeywords({})) === '[]') {
    pass('resolveKeywords(): string or list, trimmed, case-insensitively deduped; none → [] (the whole board)');
  } else {
    fail('resolveKeywords drift');
  }
  if (/invalid searchKeywords/.test(throws(() => resolveKeywords({ searchKeywords: ['ok', ' '] })) ?? '')
      && /cap is 8/.test(throws(() => resolveKeywords({ searchKeywords: Array.from({ length: 9 }, (_, i) => `k${i}`) })) ?? '')) {
    pass('resolveKeywords() throws on a blank keyword and above the 8-keyword cap');
  } else {
    fail('resolveKeywords guards drift');
  }
  if (buildListUrl('DevOps', 1) === 'https://djinni.co/jobs/?primary_keyword=DevOps'
      && buildListUrl('Hardware & Engineering', 3) === 'https://djinni.co/jobs/?primary_keyword=Hardware%20%26%20Engineering&page=3'
      && buildListUrl('', 1) === 'https://djinni.co/jobs/' && buildListUrl('', 2) === 'https://djinni.co/jobs/?page=2') {
    pass('buildListUrl(): fixed origin, encoded keyword, &page=N from page 2, bare /jobs/ for the whole board');
  } else {
    fail('buildListUrl drift');
  }
  if (toEpochMs('2026-10-10T15:55:42.429344') === Date.UTC(2026, 9, 10, 15, 55, 42, 429)
      && toEpochMs('2026-10-10T15:55:42+03:00') === Date.UTC(2026, 9, 10, 12, 55, 42)
      && toEpochMs('soon') === undefined && toEpochMs('') === undefined && toEpochMs(null) === undefined) {
    pass('toEpochMs(): an offset-less date reads as UTC (machine-independent), an explicit offset is honoured, junk → undefined');
  } else {
    fail(`toEpochMs drift: ${toEpochMs('2026-10-10T15:55:42.429344')}`);
  }
  if (locationOf(POSTING(1)) === 'Remote (Europe)'
      && locationOf(POSTING(2, { jobLocationType: undefined, applicantLocationRequirements: undefined, jobLocation: { '@type': 'Place', address: { addressCountry: 'Ukraine', addressLocality: ['Dnipro', 'Lviv'] } } })) === 'Dnipro, Lviv, Ukraine'
      && locationOf(POSTING(3, { applicantLocationRequirements: [{ address: { addressCountry: 'UKR' } }], jobLocation: { address: { addressCountry: 'Ukraine', addressLocality: 'Kyiv' } } })) === 'Kyiv, Ukraine · Remote (UKR)'
      && locationOf(POSTING(4, { applicantLocationRequirements: undefined })) === 'Remote'
      && locationOf({}) === '') {
    pass('locationOf(): office places, then Remote (with the applicant region/country when given)');
  } else {
    fail(`locationOf drift: ${locationOf(POSTING(3, { applicantLocationRequirements: [{ address: { addressCountry: 'UKR' } }], jobLocation: { address: { addressCountry: 'Ukraine', addressLocality: 'Kyiv' } } }))}`);
  }
  const monthly = { '@type': 'MonetaryAmount', currency: 'usd', value: { '@type': 'QuantitativeValue', minValue: 5500, maxValue: 6500, unitText: 'MONTH' } };
  if (JSON.stringify(salaryOf(monthly)) === JSON.stringify({ min: 66000, max: 78000, currency: 'USD' })
      && JSON.stringify(salaryOf({ currency: 'EUR', value: { maxValue: 90000, unitText: 'YEAR' } })) === JSON.stringify({ max: 90000, currency: 'EUR' })
      && salaryOf({ currency: 'USD', value: { minValue: 40, unitText: 'HOUR' } }) === undefined
      && salaryOf({ currency: 'USD', value: { minValue: 'lots', unitText: 'MONTH' } }) === undefined
      && salaryOf(undefined) === undefined) {
    pass('salaryOf(): monthly ranges annualized ×12, yearly kept, other units and non-numbers omitted');
  } else {
    fail(`salaryOf drift: ${JSON.stringify(salaryOf(monthly))}`);
  }

  // ── parseListingPage() ──
  {
    const page = PAGE([
      POSTING(1, { title: 'Back &amp; Front   Dev', baseSalary: monthly }),
      POSTING(2, { hiringOrganization: undefined, description: undefined, datePosted: undefined, jobLocationType: undefined, applicantLocationRequirements: undefined }),
      POSTING(3, { url: 'https://evil.example/jobs/800003-x/' }),
      POSTING(4, { url: 'https://djinni.co/jobs/../admin/' }),
      POSTING(5, { title: '   ' }),
      POSTING(1, { title: 'duplicate' }),
      { '@type': 'Organization', name: 'not a posting' },
    ]);
    const { jobs, rawCount, hasLd, canonical } = parseListingPage(page);
    if (rawCount === 6 && jobs.length === 2 && hasLd && canonical === CANON_DEVOPS) {
      pass('parseListingPage(): rawCount counts the JobPosting objects the source returned (6); hostile URLs, blank titles and repeats dropped (2 kept)');
    } else {
      fail(`parse counts drift: raw ${rawCount}, kept ${jobs.length}, ld ${hasLd}, canonical ${canonical}`);
    }
    const a = jobs[0];
    if (a && a.title === 'Back & Front Dev' && a.url === 'https://djinni.co/jobs/800001-senior-devops-engineer-1/'
        && a.company === 'Acme' && a.location === 'Remote (Europe)' && a.description === 'We are looking for a DevOps engineer 1.\nAWS, Terraform.'
        && a.postedAt === Date.UTC(2026, 9, 10, 15, 55, 42, 429) && a.salary?.min === 66000 && a.externalId === '800001') {
      pass('parseListingPage(): title decoded before any keyword match, posting URL, employer, location, description, postedAt, annual salary, externalId');
    } else {
      fail(`first posting drift: ${JSON.stringify(a)}`);
    }
    const b = jobs[1];
    if (b && b.company === '' && b.location === '' && !('description' in b) && !('postedAt' in b) && !('salary' in b)) {
      pass('parseListingPage(): a posting with no employer/location/date/description leaves them empty, never borrowed');
    } else {
      fail(`minimal posting drift: ${JSON.stringify(b)}`);
    }
  }
  if (parseListingPage('').rawCount === 0 && parseListingPage(undefined).jobs.length === 0
      && parseListingPage('<script type="application/ld+json">{not json</script>').hasLd === false) {
    pass('parseListingPage(): empty input and unparsable JSON-LD yield no postings, without throwing');
  } else {
    fail('parseListingPage must tolerate junk input');
  }

  // ── fetch() ──
  const mkCtx = (map, seen, optsSeen = [], extra = {}) => ({
    sleep: async () => {},
    fetchText: async (url, opts) => {
      seen.push(url);
      optsSeen.push(opts);
      const v = map[url];
      if (v instanceof Error) throw v;
      if (v === undefined) throw REFUSED_REDIRECT();
      return v;
    },
    ...extra,
  });
  const ENTRY = { careers_url: 'https://djinni.co/jobs/', searchKeywords: 'DevOps' };
  const U = (page) => buildListUrl('DevOps', page);

  // Pagination + short-page stop.
  {
    const seen = [];
    const optsSeen = [];
    const out = await provider.fetch(ENTRY, mkCtx({ [U(1)]: fullPage(100), [U(2)]: fullPage(200, 4), [U(3)]: fullPage(300) }, seen, optsSeen));
    if (out.length === 19 && seen.length === 2) pass('fetch() walks pages until a short one (15 + 4) and does not request past it');
    else fail(`pagination drift: ${out.length} jobs, requests ${JSON.stringify(seen)}`);
    if (optsSeen.every((o) => o && o.redirect === 'error')) pass('fetch() passes redirect:error on every request');
    else fail(`redirect drift: ${JSON.stringify(optsSeen)}`);
  }

  // A board that ends on a full page: the next page 302s to /jobs/ → end, not failure.
  {
    const seen = [];
    const out = await provider.fetch(ENTRY, mkCtx({ [U(1)]: fullPage(100), [U(2)]: fullPage(200) }, seen));
    if (out.length === 30 && seen.length === 3) pass('fetch(): the refused 302 one page past a full last page ends the walk and keeps what was read');
    else fail(`end-redirect drift: ${out.length} jobs, ${seen.length} requests`);
  }
  {
    let caught = null;
    try { await provider.fetch(ENTRY, mkCtx({}, [])); } catch (e) { caught = e; }
    if (caught && caught.cause?.message === 'unexpected redirect') pass('fetch(): a redirect on page 1 is a real failure and is rethrown');
    else fail(`page-1 redirect swallowed: ${caught && caught.message}`);
  }

  // The short-page stop reads the RAW count: a full page with one bad posting keeps walking.
  {
    const seen = [];
    const postings = Array.from({ length: 15 }, (_, i) => (i === 3 ? POSTING(150 + i, { url: 'https://djinni.co/nope' }) : POSTING(150 + i)));
    const out = await provider.fetch(ENTRY, mkCtx({ [U(1)]: PAGE(postings), [U(2)]: fullPage(400, 3) }, seen));
    if (seen.length === 2 && out.length === 17) pass('fetch(): the short-page stop uses the source’s raw count, so one bad posting does not end the walk early');
    else fail(`raw-count stop drift: ${out.length} jobs, ${seen.length} requests`);
  }

  // Own ceiling and the truncation warning.
  {
    const origWarn = console.warn;
    const warns = [];
    console.warn = (...args) => warns.push(args.join(' '));
    try {
      const seen = [];
      const endless = { sleep: async () => {}, fetchText: async (url) => { seen.push(url); const p = Number(new URL(url).searchParams.get('page') || '1'); return fullPage(p * 1000); } };
      await provider.fetch(ENTRY, endless);
      const defaultStop = seen.length;
      const warnedDefault = warns.some((w) => /raise max_pages/.test(w));
      seen.length = 0;
      await provider.fetch({ ...ENTRY, max_pages: 999 }, endless);
      if (defaultStop === 10 && seen.length === 40) pass('fetch() stops at its own ceilings: 10 pages by default, 40 for any max_pages');
      else fail(`ceiling drift: default ${defaultStop}, capped ${seen.length}`);
      if (warnedDefault) pass('fetch() warns "raise max_pages" when its own ceiling truncated a full-page walk');
      else fail('truncation by the page ceiling must warn');
    } finally {
      console.warn = origWarn;
    }
  }

  // Probe cooperation.
  {
    const seen = [];
    await provider.fetch({ ...ENTRY, searchKeywords: ['DevOps', 'Sysadmin'] }, mkCtx({ [U(1)]: fullPage(1) }, seen, [], { maxPages: 1 }));
    if (seen.length === 1 && seen[0] === U(1)) pass('fetch() under ctx.maxPages:1 issues exactly one list request (first keyword, first page)');
    else fail(`probe issued ${JSON.stringify(seen)}`);
    class ProbeStop extends Error {}
    const stop = new ProbeStop('budget');
    let caught = null;
    try { await provider.fetch(ENTRY, { maxPages: 1, sleep: async () => {}, fetchText: async () => { throw stop; } }); } catch (e) { caught = e; }
    if (caught === stop) pass('fetch() propagates a ctx.fetchText rejection unwrapped while probing');
    else fail(`rejection rewrapped: ${caught && caught.message}`);
  }

  // Keyword fan-out, cross-pass dedup, pacing.
  {
    const seen = [];
    const sleeps = [];
    const same = fullPage(500, 5);
    const ctx = { sleep: async (ms) => { sleeps.push(ms); }, fetchText: async (url) => { seen.push(url); return same; } };
    const out = await provider.fetch({ ...ENTRY, searchKeywords: ['DevOps', 'Sysadmin'] }, ctx);
    if (JSON.stringify(seen) === JSON.stringify([U(1), buildListUrl('Sysadmin', 1)]) && out.length === 5) {
      pass('fetch() runs one pass per keyword, and a posting returned by two passes is kept once');
    } else {
      fail(`fan-out drift: ${JSON.stringify(seen)} → ${out.length}`);
    }
    if (sleeps.length === 1 && sleeps[0] >= 1000) pass('fetch() waits 1 s between requests (and not before the first)');
    else fail(`pacing drift: ${JSON.stringify(sleeps)}`);
  }

  // No keyword → the whole board from bare /jobs/.
  {
    const seen = [];
    const out = await provider.fetch({ careers_url: 'https://djinni.co/hire' }, mkCtx({ 'https://djinni.co/jobs/': fullPage(1, 3, { canonical: 'https://djinni.co/jobs/' }) }, seen));
    if (seen[0] === 'https://djinni.co/jobs/' && out.length === 3) pass('fetch() with no searchKeywords walks the whole board from /jobs/');
    else fail(`whole-board drift: ${JSON.stringify(seen)} → ${out.length}`);
  }

  // Empty vs broken vs unknown keyword.
  {
    const empty = await provider.fetch({ ...ENTRY, searchKeywords: 'Blazor' }, mkCtx({ [buildListUrl('Blazor', 1)]: EMPTY_CATEGORY }, []));
    if (Array.isArray(empty) && empty.length === 0) pass('fetch() returns [] for an empty category (canonical kept, no JSON-LD, no posting links)');
    else fail('empty category must return []');

    const errOf = async (html, entry = ENTRY) => {
      try { await provider.fetch(entry, mkCtx({ [U(1)]: html, [buildListUrl('SRE', 1)]: html }, [])); return null; } catch (e) { return String(e && e.message); }
    };
    if (/not a Djinni category/.test(await errOf(fullPage(1, 15, { canonical: 'https://djinni.co/jobs/' }), { ...ENTRY, searchKeywords: 'SRE' }) ?? '')) {
      pass('fetch() throws on an unknown keyword (the board fell back to its unfiltered /jobs/ listing)');
    } else {
      fail('an unknown keyword must not flood the pipeline with the whole board');
    }
    if (/carries no JobPosting JSON-LD/.test(await errOf(PAGE([], { links: ['https://djinni.co/jobs/800001-x/'] })) ?? '')) {
      pass('fetch() throws when posting links are present but no JSON-LD is (markup change)');
    } else {
      fail('a markup change must surface as an error');
    }
    if (/none carried a valid title and posting URL/.test(await errOf(PAGE([POSTING(1, { url: 'https://djinni.co/x' })])) ?? '')) {
      pass('fetch() throws when JobPosting objects are present but none is usable');
    } else {
      fail('unusable JSON-LD must surface as an error');
    }
    if (/not a Djinni job listing/.test(await errOf('<html><title>Just a moment...</title></html>') ?? '')) {
      pass('fetch() throws on a block page instead of reporting no postings');
    } else {
      fail('a block page must surface as an error');
    }
  }

  // Config errors surface before any network call.
  for (const [label, entry] of [
    ['a blank keyword', { ...ENTRY, searchKeywords: [''] }],
    ['too many keywords', { ...ENTRY, searchKeywords: Array.from({ length: 9 }, (_, i) => `k${i}`) }],
  ]) {
    const seen = [];
    let threw = false;
    try { await provider.fetch(entry, mkCtx({}, seen)); } catch { threw = true; }
    if (threw && seen.length === 0) pass(`fetch() rejects ${label} before making any request`);
    else fail(`${label} reached the network (${seen.length} request(s)) or did not throw`);
  }
} catch (error) {
  fail(`djinni provider tests could not run: ${error.message}`);
}
