// tests/providers/mercor.test.mjs — direct provider-contract tests.
// work.mercor.com/explore server-renders the whole public inventory into
// __NEXT_DATA__ (React Query dehydrated state). The parser must fail CLOSED on a
// missing blob or query (a silent zero would look like an empty marketplace)
// while a present-and-empty listings array is [].
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — mercor');

/** A page carrying `data` as its __NEXT_DATA__ blob. */
function pageWith(data) {
  return `<!DOCTYPE html><html><head><title>Explore</title></head><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
}

/** The documented envelope around a listings array. */
function explore(listings, { key = 'listings-explore-page' } = {}) {
  return {
    props: {
      pageProps: {
        dehydratedState: {
          mutations: [],
          queries: [
            { queryKey: ['some-other-query'], state: { data: { listings: [] } } },
            { queryKey: [key, 'listingsPublicQuery', 'public-explore-page', ''], state: { data: { listings } } },
          ],
        },
      },
    },
  };
}

function listing(over = {}) {
  return {
    listingId: 'list_AAAAExampleId0001',
    title: 'Platform Engineer',
    description: '**About the Role**\nRun the platform.',
    status: 'active',
    deletedAt: null,
    isPrivate: false,
    disableApplications: false,
    location: 'Remote',
    workArrangement: 'remote',
    eligibleLocation: ['USA', 'ARG'],
    eligibleResidenceLocation: null,
    ineligibleLocation: null,
    ineligibleResidenceLocation: null,
    rateMin: 70,
    rateMax: 90,
    payRateFrequency: 'hourly',
    hoursPerWeek: 20,
    commitment: 'part-time',
    companyName: 'ExampleCo',
    companyBrandVisible: true,
    postedAt: '2026-10-07T18:10:15',
    createdAt: '2026-10-01T00:00:00',
    ...over,
  };
}

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/mercor.mjs')).href);
  const mercor = mod.default;
  const { parseMercorExplore } = mod;

  if (mercor.id === 'mercor') pass('mercor.id is "mercor"');
  else fail(`mercor.id is ${JSON.stringify(mercor.id)}`);

  // ── detect ──────────────────────────────────────────────────────────────
  const claims = [
    'https://work.mercor.com/explore',
    'https://work.mercor.com/',
    'https://work.mercor.com/jobs/list_AAAAExampleId0001/platform-engineer?ref=x',
  ];
  const missed = claims.filter((u) => mercor.detect({ name: 'M', careers_url: u })?.url !== 'https://work.mercor.com/explore');
  if (missed.length === 0) pass('mercor.detect() claims the explore page, the bare host and a posting permalink, always answering the fixed explore URL');
  else fail(`mercor.detect() missed: ${missed.join(', ')}`);

  if (mercor.detect({ name: 'M', api: 'https://work.mercor.com/explore', careers_url: 'https://example.com' })?.url === 'https://work.mercor.com/explore') {
    pass('mercor.detect() honours an explicit api: URL');
  } else fail('mercor.detect() api: not honoured');

  const rejects = [
    ['path-spoofed', 'https://evil.example/work.mercor.com/explore'],
    ['suffix-spoofed host', 'https://work.mercor.com.evil.example/explore'],
    ['prefix-spoofed host', 'https://evil-work.mercor.com/explore'],
    ['other mercor host', 'https://mercor.com/'],
    ['http', 'http://work.mercor.com/explore'],
    ['malformed', 'not a url'],
  ];
  const leaked = rejects.filter(([, u]) => mercor.detect({ name: 'X', careers_url: u }) !== null).map(([n]) => n);
  if (leaked.length === 0) pass('mercor.detect() rejects spoofed, other-host, non-HTTPS and malformed URLs');
  else fail(`mercor.detect() wrongly claimed: ${leaked.join(', ')}`);

  if (mercor.detect({ name: 'X', careers_url: null }) === null && mercor.detect({ name: 'X', careers_url: 7 }) === null && mercor.detect({ name: 'X' }) === null) {
    pass('mercor.detect() returns null for null / non-string / missing careers_url (no throw)');
  } else fail('mercor.detect() should treat junk careers_url as missing');

  // ── parseMercorExplore ──────────────────────────────────────────────────
  const html = pageWith(explore([
    listing(),
    listing({
      listingId: 'list_AAAAExampleId0002',
      title: '  Linux Expert  ',
      location: null,
      eligibleLocation: [],
      ineligibleLocation: ['IND'],
      rateMin: 200,
      rateMax: 200,
      hoursPerWeek: null,
      companyBrandVisible: false,
      postedAt: 'not a date',
      createdAt: '2026-09-13T08:00:00',
    }),
    listing({ listingId: 'list_AAAAExampleId0003', title: '   ' }),          // blank title → dropped
    listing({ listingId: undefined, title: 'No id' }),                       // no id → dropped
    listing({ listingId: 'list_bad id/../x', title: 'Unsafe id' }),          // id outside the base64url shape → dropped
    listing({ listingId: 'list_AAAAExampleId0004', status: 'closed' }),      // closed → dropped
    listing({ listingId: 'list_AAAAExampleId0005', isPrivate: true }),       // private → dropped
    listing({ listingId: 'list_AAAAExampleId0006', disableApplications: true }), // not accepting → dropped
    listing({ listingId: 'list_AAAAExampleId0007', deletedAt: '2026-10-10T00:00:00' }), // deleted → dropped
    null,                                                                    // junk row → dropped
  ]));
  const jobs = parseMercorExplore(html, { company: 'Mercor' });

  if (jobs.length === 2) pass('parseMercorExplore() keeps active public listings and drops malformed, closed, private, deleted and non-applicable ones');
  else fail(`parseMercorExplore() kept ${jobs.length} rows: ${JSON.stringify(jobs.map((j) => j.title))}`);

  const [a, b] = jobs;
  if (a?.url === 'https://work.mercor.com/jobs/list_AAAAExampleId0001' && a.company === 'Mercor'
      && a.title === 'Platform Engineer' && a.externalId === 'list_AAAAExampleId0001') {
    pass('parseMercorExplore() builds the slug-less posting URL, company, title and externalId');
  } else fail(`row 0 = ${JSON.stringify(a)}`);

  if (/^Remote \(eligible: United States, Argentina\)$/.test(a?.location ?? '')) pass('parseMercorExplore() expands eligible ISO alpha-3 codes into country names in the location');
  else fail(`row 0 location = ${JSON.stringify(a?.location)}`);

  if (b?.title === 'Linux Expert' && b.location === 'Remote') pass('parseMercorExplore() trims the title and falls back to the work arrangement when location is null');
  else fail(`row 1 = ${JSON.stringify(b)}`);

  if (!/India/.test(b?.location ?? '') && /^Not eligible: India$/m.test(b?.description ?? '')) {
    pass('parseMercorExplore() keeps ineligible countries out of the location and lists them in the description');
  } else fail(`row 1 location/description = ${JSON.stringify([b?.location, b?.description])}`);

  if (a?.postedAt === Date.parse('2026-10-07T18:10:15Z')) pass('parseMercorExplore() reads a zone-less timestamp as UTC');
  else fail(`row 0 postedAt = ${a?.postedAt}`);

  if (b?.postedAt === Date.parse('2026-09-13T08:00:00Z')) pass('parseMercorExplore() falls back to createdAt when postedAt is unparseable (NaN-safe)');
  else fail(`row 1 postedAt = ${b?.postedAt}`);

  if (/^Pay: USD 70-90\/hour, 20 h\/week$/m.test(a?.description ?? '') && /^Client: ExampleCo$/m.test(a.description)
      && /\*\*About the Role\*\*/.test(a.description)) {
    pass('parseMercorExplore() heads the description with the published pay and the visible client, then the listing text');
  } else fail(`row 0 description = ${JSON.stringify(a?.description)}`);

  if (/^Pay: USD 200\/hour$/m.test(b?.description ?? '') && !/Client:/.test(b.description)) {
    pass('parseMercorExplore() collapses an equal min/max and hides a client Mercor does not show');
  } else fail(`row 1 description = ${JSON.stringify(b?.description)}`);

  if (jobs.every((j) => !('salary' in j))) pass('parseMercorExplore() never maps an hourly rate to the annualized salary field');
  else fail('parseMercorExplore() set salary');

  // ── empty vs broken ─────────────────────────────────────────────────────
  const empty = parseMercorExplore(pageWith(explore([])), { company: 'Mercor' });
  if (Array.isArray(empty) && empty.length === 0) pass('parseMercorExplore() returns [] for a present-and-empty listings array');
  else fail(`empty listings = ${JSON.stringify(empty)}`);

  const broken = [
    ['no __NEXT_DATA__', '<html><body><a href="/jobs/list_AAAAExampleId0001">x</a></body></html>'],
    ['invalid JSON', '<script id="__NEXT_DATA__" type="application/json">{nope</script>'],
    ['no queries', pageWith({ props: { pageProps: {} } })],
    ['other query only', pageWith(explore([listing()], { key: 'something-else' }))],
    ['listings not an array', pageWith(explore(null))],
    ['empty body', ''],
  ];
  const silent = [];
  for (const [label, body] of broken) {
    try {
      parseMercorExplore(body, { company: 'Mercor' });
      silent.push(label);
    } catch { /* expected */ }
  }
  if (silent.length === 0) pass('parseMercorExplore() throws on a missing blob, bad JSON, missing query or non-array listings (never a silent zero)');
  else fail(`parseMercorExplore() did not throw for: ${silent.join(', ')}`);

  // ── fetch ───────────────────────────────────────────────────────────────
  const entry = { name: 'Mercor', careers_url: 'https://work.mercor.com/explore' };
  const seen = [];
  const fetched = await mercor.fetch(entry, { fetchText: async (url, opts) => { seen.push([url, opts?.redirect]); return html; } });
  if (fetched.length === 2 && seen.length === 1 && seen[0][0] === 'https://work.mercor.com/explore' && seen[0][1] === 'error') {
    pass("mercor.fetch() makes one request to the fixed explore URL with redirect: 'error'");
  } else fail(`fetch calls = ${JSON.stringify(seen)}, jobs = ${fetched.length}`);

  let touched = 0;
  let guardErr = null;
  try {
    await mercor.fetch({ name: 'Evil', careers_url: 'https://evil.example/explore' }, { fetchText: async () => { touched++; return html; } });
  } catch (e) { guardErr = e; }
  if (guardErr && touched === 0) pass('mercor.fetch() rejects an off-host entry before any network call');
  else fail(`off-host entry: err=${guardErr?.message} fetches=${touched}`);

  // Probe cooperation: ctx.maxPages set → still one request; a rejection propagates unwrapped.
  let probeCalls = 0;
  await mercor.fetch(entry, { maxPages: 1, fetchText: async () => { probeCalls++; return html; } });
  if (probeCalls === 1) pass('mercor.fetch() makes a single request under ctx.maxPages (probe)');
  else fail(`probe requests = ${probeCalls}`);

  class FakeSentinel extends Error {}
  let probeErr = null;
  try { await mercor.fetch(entry, { maxPages: 1, fetchText: async () => { throw new FakeSentinel(); } }); } catch (e) { probeErr = e; }
  if (probeErr instanceof FakeSentinel) pass('mercor.fetch() propagates a ctx.fetch* rejection unwrapped while probing');
  else fail(`probe error identity lost: ${probeErr?.constructor?.name}`);
} catch (e) {
  fail(`mercor provider test crashed: ${e.stack || e.message}`);
}
