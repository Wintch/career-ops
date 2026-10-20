// tests/providers/hibob.test.mjs — direct provider-contract tests.
//
// HiBob career sites serve the whole board from one same-origin request,
// `GET https://<tenant>.careers.hibob.com/api/job-ad` with a
// `companyIdentifier: <tenant>` header, as `{ filterGroups, jobAdDetails[] }` —
// see the header comment in providers/hibob.mjs. Fixtures here are synthetic
// (fictional "Acme" tenant, invented ids and text) in that real shape.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — hibob');

const ORIGIN = 'https://acme.careers.hibob.com';

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/hibob.mjs')).href);
  const hibob = mod.default;
  const { parseHibobResponse } = mod;

  if (hibob.id === 'hibob') pass('hibob.id is "hibob"');
  else fail(`hibob.id is ${JSON.stringify(hibob.id)}`);

  // detect(): URL-pattern on <tenant>.careers.hibob.com, any path.
  const hit = hibob.detect({ name: 'Acme', careers_url: 'https://acme.careers.hibob.com/jobs' });
  if (hit && hit.url === `${ORIGIN}/api/job-ad`) pass('hibob.detect() resolves <tenant>.careers.hibob.com → /api/job-ad');
  else fail(`hibob.detect() returned ${JSON.stringify(hit)}`);

  const bare = hibob.detect({ name: 'Acme', careers_url: 'https://acme-corp.careers.hibob.com' });
  if (bare && bare.url === 'https://acme-corp.careers.hibob.com/api/job-ad') pass('hibob.detect() accepts the bare landing URL and hyphenated tenants');
  else fail(`hibob.detect() bare landing returned ${JSON.stringify(bare)}`);

  const deep = hibob.detect({ name: 'Acme', careers_url: 'https://acme.careers.hibob.com:8443/jobs/abc?x=1#y' });
  if (deep && deep.url === `${ORIGIN}/api/job-ad`) pass('hibob.detect() rebuilds the origin from the hostname only (path and port discarded)');
  else fail(`hibob.detect() deep URL returned ${JSON.stringify(deep)}`);

  const viaApi = hibob.detect({ name: 'X', api: 'https://acme.careers.hibob.com/api/job-ad', careers_url: 'https://example.com' });
  if (viaApi && viaApi.url === `${ORIGIN}/api/job-ad`) pass('hibob.detect() honours an explicit api: URL over careers_url');
  else fail(`hibob.detect() api: returned ${JSON.stringify(viaApi)}`);

  const junk = [
    { name: 'X', careers_url: 'https://example.com/careers' },
    { name: 'X', careers_url: 'http://acme.careers.hibob.com/' },                       // not https
    { name: 'X', careers_url: 'https://careers.hibob.com/' },                           // vendor root, no tenant
    { name: 'X', careers_url: 'https://acme.careers.hibob.com.evil.example/' },         // suffix spoof
    { name: 'X', careers_url: 'https://evilcareers.hibob.com/' },                       // not a <tenant>.careers. label
    { name: 'X', careers_url: 'https://acme.careers.stage.hibob.com/' },                // stage host is not claimed
    { name: 'X', careers_url: 'https://evil.example/acme.careers.hibob.com/jobs' },     // path spoof
    { name: 'X', careers_url: '-acme.careers.hibob.com' },                              // malformed
    { name: 'X', careers_url: null },
    { name: 'X', careers_url: 7 },
    { name: 'X' },
    null,
  ];
  const claimed = junk.filter((e) => {
    try { return hibob.detect(e) !== null; } catch { return true; }
  });
  if (claimed.length === 0) pass('hibob.detect() returns null (never throws) for non-hibob, non-https, spoofed, malformed and junk input');
  else fail(`hibob.detect() wrongly claimed/threw on: ${JSON.stringify(claimed)}`);

  // ── parseHibobResponse ────────────────────────────────────────────────────
  const sample = {
    filterGroups: { departments: [], sites: [], jobTypes: [], workspaceTypes: [] },
    jobAdDetails: [
      {
        id: '11111111-aaaa-4bbb-8ccc-000000000001',
        title: '  Senior Payments Engineer  ',
        department: 'Engineering',
        employmentType: 'Permanent',
        site: 'Buenos Aires',
        country: 'Argentina',
        language: 'es',
        description: '<p>We build <strong>payments</strong> for ExampleCo &amp; friends.</p>',
        responsibilities: '<ul><li>Design APIs</li></ul>',
        requirements: '<ul><li>Node.js</li></ul>',
        benefits: null,
        publishedAt: '2026-09-15T19:22:14.562309703Z',
        workspaceTypeId: 'hybrid',
        payTransparencyMinSalary: null,
        payTransparencyMaxSalary: null,
        payTransparencySalaryCurrency: null,
        payTransparencySalaryPayPeriod: null,
      },
      {
        id: '11111111-aaaa-4bbb-8ccc-000000000002',
        title: 'Remote Data Analyst',
        site: 'Argentina',
        country: 'Argentina',
        language: 'en',
        description: 'Plain text body',
        publishedAt: 'not-a-date',
        workspaceTypeId: 'remote',
        payTransparencyMinSalary: 100000,
        payTransparencyMaxSalary: 140000,
        payTransparencySalaryCurrency: 'usd',
        payTransparencySalaryPayPeriod: 'Annual',
      },
      {
        id: '11111111-aaaa-4bbb-8ccc-000000000003',
        title: 'Country-Only Role',
        site: '',
        country: 'Mexico',
        publishedAt: '1970-01-01T00:00:00Z',
        payTransparencyMinSalary: 5000,
        payTransparencyMaxSalary: null,
        payTransparencySalaryCurrency: 'MXN',
        payTransparencySalaryPayPeriod: 'Monthly',
      },
      {
        id: '11111111-aaaa-4bbb-8ccc-000000000004',
        title: 'Hourly Contractor',
        site: 'Lima',
        country: 'Peru',
        payTransparencyMinSalary: 20,
        payTransparencyMaxSalary: 30,
        payTransparencySalaryCurrency: 'USD',
        payTransparencySalaryPayPeriod: 'Hourly',
      },
      { id: '11111111-aaaa-4bbb-8ccc-000000000005', title: '   ', site: 'Nowhere' },   // drop: blank title
      { title: 'No Id Role', site: 'Nowhere' },                                      // drop: no id
      { id: '   ', title: 'Blank Id Role' },                                         // drop: blank id
      null,                                                                          // drop: not an object
      'junk',                                                                        // drop: not an object
    ],
  };
  const jobs = parseHibobResponse(sample, 'Acme', ORIGIN);

  if (jobs.length === 4) pass('parseHibobResponse keeps 4 valid postings (drops blank title / missing id / junk rows)');
  else fail(`parseHibobResponse returned ${jobs.length} postings (expected 4)`);

  const j0 = jobs[0];
  if (j0?.title === 'Senior Payments Engineer'
      && j0.url === `${ORIGIN}/jobs/11111111-aaaa-4bbb-8ccc-000000000001`
      && j0.company === 'Acme'
      && j0.location === 'Buenos Aires, Argentina'
      && j0.externalId === '11111111-aaaa-4bbb-8ccc-000000000001'
      && j0.language === 'es') {
    pass('parseHibobResponse maps title (trimmed), canonical /jobs/<id> url, company, "site, country" location, externalId, language');
  } else {
    fail(`row 0 = ${JSON.stringify(j0)}`);
  }

  if (j0?.postedAt === Date.parse('2026-09-15T19:22:14.562Z')) pass('parseHibobResponse parses nanosecond-precision publishedAt → postedAt');
  else fail(`row 0 postedAt = ${JSON.stringify(j0?.postedAt)}`);

  if (j0?.description === 'We build payments for ExampleCo & friends. Design APIs Node.js') {
    pass('parseHibobResponse builds a plain-text description (entities decoded, markup stripped, null sections skipped)');
  } else {
    fail(`row 0 description = ${JSON.stringify(j0?.description)}`);
  }

  if (j0 && !('salary' in j0)) pass('parseHibobResponse omits salary when the tenant publishes no pay range');
  else fail(`row 0 salary should be absent, got ${JSON.stringify(j0?.salary)}`);

  const j1 = jobs[1];
  if (j1?.location === 'Argentina, Remote') pass('parseHibobResponse does not repeat a country the site already names, and appends Remote for remote ads');
  else fail(`row 1 location = ${JSON.stringify(j1?.location)}`);
  if (j1 && !('postedAt' in j1)) pass('parseHibobResponse omits postedAt for an unparseable publishedAt');
  else fail(`row 1 postedAt should be absent, got ${JSON.stringify(j1?.postedAt)}`);
  if (j1?.salary && j1.salary.min === 100000 && j1.salary.max === 140000 && j1.salary.currency === 'USD') {
    pass('parseHibobResponse reads an Annual pay-transparency range (currency upper-cased)');
  } else {
    fail(`row 1 salary = ${JSON.stringify(j1?.salary)}`);
  }

  const j2 = jobs[2];
  if (j2?.location === 'Mexico') pass('parseHibobResponse falls back to country when the site is blank');
  else fail(`row 2 location = ${JSON.stringify(j2?.location)}`);
  if (j2?.postedAt === 0) pass('parseHibobResponse keeps a valid epoch-0 publishedAt (NaN-safe, not falsy-dropped)');
  else fail(`row 2 postedAt = ${JSON.stringify(j2?.postedAt)}`);
  if (j2?.salary && j2.salary.min === 60000 && j2.salary.max === 60000 && j2.salary.currency === 'MXN') {
    pass('parseHibobResponse annualizes Monthly pay and fills a one-sided range from the other bound');
  } else {
    fail(`row 2 salary = ${JSON.stringify(j2?.salary)}`);
  }

  const j3 = jobs[3];
  if (j3 && !('salary' in j3)) pass('parseHibobResponse leaves salary off for a pay period it cannot annualize safely (Hourly)');
  else fail(`row 3 salary should be absent, got ${JSON.stringify(j3?.salary)}`);
  if (j3 && !('description' in j3) && !('language' in j3)) pass('parseHibobResponse omits description / language when the ad carries none');
  else fail(`row 3 should have no description/language, got ${JSON.stringify(j3)}`);

  // Host-controlled id is encoded into the URL path.
  const enc = parseHibobResponse({ jobAdDetails: [{ id: 'a/b c?d', title: 'Encoded' }] }, 'Acme', ORIGIN);
  if (enc[0]?.url === `${ORIGIN}/jobs/a%2Fb%20c%3Fd`) pass('parseHibobResponse percent-encodes the ad id into the url path');
  else fail(`encoded url = ${JSON.stringify(enc[0]?.url)}`);

  // Empty-vs-broken split.
  const empty = parseHibobResponse({ filterGroups: { departments: [], sites: [], jobTypes: [], workspaceTypes: [] }, jobAdDetails: [] }, 'Acme', ORIGIN);
  if (Array.isArray(empty) && empty.length === 0) pass('parseHibobResponse returns [] for a present-and-empty jobAdDetails[] (genuinely empty board)');
  else fail(`empty board = ${JSON.stringify(empty)}`);

  for (const bad of [{}, { jobAdDetails: null }, { jobAdDetails: {} }, { jobAdDetails: 'x' }, { jobs: [] }, [], null, '', 'not json', 42, true]) {
    let msg = '';
    try { parseHibobResponse(bad, 'X', ORIGIN); } catch (e) { msg = e.message; }
    if (!/hibob: unexpected response — expected jobAdDetails\[\], got: \[/.test(msg)) {
      fail(`parseHibobResponse should throw a descriptive error for ${JSON.stringify(bad)}, got ${JSON.stringify(msg)}`);
    }
  }
  pass('parseHibobResponse throws a descriptive error for a missing / wrong-typed container or a non-object body');

  let keysNamed = false;
  try { parseHibobResponse({ results: [] }, 'X', ORIGIN); } catch (e) { keysNamed = /got: \[results\]/.test(e.message); }
  if (keysNamed) pass('parseHibobResponse names the keys it did get in the error');
  else fail('parseHibobResponse error should name the keys it received');

  // ── fetch() ───────────────────────────────────────────────────────────────
  const entry = { name: 'Acme', careers_url: 'https://acme.careers.hibob.com/jobs' };
  const calls = [];
  const ctx = { fetchJson: async (url, opts) => { calls.push({ url, opts }); return sample; } };
  const fetched = await hibob.fetch(entry, ctx);

  if (calls.length === 1 && calls[0].url === `${ORIGIN}/api/job-ad`) pass('hibob.fetch() makes exactly one request, to <origin>/api/job-ad');
  else fail(`hibob.fetch() calls = ${JSON.stringify(calls.map((c) => c.url))}`);
  if (calls[0]?.opts?.redirect === 'error') pass('hibob.fetch() passes redirect:"error" (SSRF guard)');
  else fail(`hibob.fetch() redirect = ${JSON.stringify(calls[0]?.opts?.redirect)}`);
  if (calls[0]?.opts?.headers?.companyIdentifier === 'acme') pass('hibob.fetch() sends the companyIdentifier header with the tenant subdomain');
  else fail(`hibob.fetch() headers = ${JSON.stringify(calls[0]?.opts?.headers)}`);
  if (fetched.length === 4 && fetched[0]?.company === 'Acme' && fetched[0]?.url.startsWith(`${ORIGIN}/jobs/`)) {
    pass('hibob.fetch() returns normalized jobs on the tenant origin with company from the entry name');
  } else {
    fail(`hibob.fetch() returned ${fetched.length} jobs, row 0 = ${JSON.stringify(fetched[0])}`);
  }

  // A tenant host with a custom path/port still asks the rebuilt origin, with the right tenant label.
  const calls2 = [];
  await hibob.fetch(
    { name: 'Beta', api: 'https://beta-co.careers.hibob.com:9999/some/path' },
    { fetchJson: async (url, opts) => { calls2.push({ url, opts }); return { jobAdDetails: [] }; } },
  );
  if (calls2[0]?.url === 'https://beta-co.careers.hibob.com/api/job-ad' && calls2[0].opts.headers.companyIdentifier === 'beta-co') {
    pass('hibob.fetch() rebuilds the origin from the hostname and derives the header from it');
  } else {
    fail(`hibob.fetch() api: calls = ${JSON.stringify(calls2)}`);
  }

  // Allowlist guard: a config-derived URL on another host throws BEFORE any fetch.
  for (const bad of [
    { name: 'X', careers_url: 'https://example.com/careers' },
    { name: 'X', careers_url: 'http://acme.careers.hibob.com/' },
    { name: 'X', careers_url: 'https://acme.careers.hibob.com.evil.example/' },
    { name: 'X', api: 'https://169.254.169.254/latest/meta-data' },
    { name: 'X' },
  ]) {
    let entered = 0;
    let msg = '';
    try {
      await hibob.fetch(bad, { fetchJson: async () => { entered++; return { jobAdDetails: [] }; } });
    } catch (e) { msg = e.message; }
    if (entered === 0 && /cannot derive API URL/.test(msg)) continue;
    fail(`hibob.fetch() guard failed for ${JSON.stringify(bad)}: fetch entered ${entered}x, message ${JSON.stringify(msg)}`);
  }
  pass('hibob.fetch() throws before any network call when the entry is not a <tenant>.careers.hibob.com host');

  // fetch(): broken envelope surfaces as a throw, an empty board as [].
  let brokeLoud = false;
  try { await hibob.fetch(entry, { fetchJson: async () => ({ message: 'An unexpected error occurred' }) }); } catch (e) { brokeLoud = /unexpected response/.test(e.message); }
  if (brokeLoud) pass('hibob.fetch() throws on an envelope without jobAdDetails[] (a silent API change is not "0 jobs")');
  else fail('hibob.fetch() should throw on a changed envelope');

  const emptyFetched = await hibob.fetch(entry, { fetchJson: async () => ({ filterGroups: {}, jobAdDetails: [] }) });
  if (Array.isArray(emptyFetched) && emptyFetched.length === 0) pass('hibob.fetch() returns [] for a present-and-empty jobAdDetails[]');
  else fail(`hibob.fetch() empty board = ${JSON.stringify(emptyFetched)}`);

  // Probe cooperation: one list request, and a ctx.fetch* rejection propagates unwrapped.
  const probeCalls = [];
  await hibob.fetch(entry, { maxPages: 1, fetchJson: async (url, opts) => { probeCalls.push({ url, opts }); return sample; } });
  if (probeCalls.length === 1 && probeCalls[0].opts.redirect === 'error') pass('hibob.fetch() under ctx.maxPages=1 issues exactly one list request, still redirect:"error"');
  else fail(`hibob.fetch() probe calls = ${JSON.stringify(probeCalls)}`);

  class FakeProbeBudget extends Error {}
  let same = false;
  try {
    await hibob.fetch(entry, { maxPages: 1, fetchJson: async () => { throw new FakeProbeBudget('probe budget reached'); } });
  } catch (e) { same = e instanceof FakeProbeBudget; }
  if (same) pass('hibob.fetch() propagates a ctx.fetch* rejection unwrapped while ctx.maxPages is set');
  else fail('hibob.fetch() must not swallow or rewrap a rejection while probing');

  // An HTTP error (unknown tenant answers 401) is surfaced, not read as an empty board.
  let httpErr = null;
  try {
    await hibob.fetch(entry, {
      fetchJson: async () => { const e = new Error('HTTP 401 Unauthorized'); e.status = 401; throw e; },
    });
  } catch (e) { httpErr = e; }
  if (httpErr && httpErr.status === 401) pass('hibob.fetch() surfaces a 401 (unknown tenant) as an error, never as an empty board');
  else fail('hibob.fetch() should surface an HTTP error');
} catch (e) {
  fail(`hibob provider tests crashed: ${e.message}`);
}
