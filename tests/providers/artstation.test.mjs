// tests/providers/artstation.test.mjs — ArtStation Jobs board-wide JSON feed provider.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — artstation');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/artstation.mjs')).href);
  const p = mod.default;
  const { parseArtStationJobs } = mod;

  if (p.id === 'artstation') pass('artstation.id is "artstation"');
  else fail(`id is ${JSON.stringify(p.id)}`);
  if (p.detect({ name: 'A', provider: 'artstation' }) && p.detect({ name: 'A', careers_url: 'https://www.artstation.com/jobs' }) === null) {
    pass('detect() is explicit-only (provider: artstation)');
  } else {
    fail('detect() must be explicit-only');
  }

  const row = (over = {}) => ({
    hash_id: 'dd47', title: 'Lead Character Artist', job_state: 'approved', deleted_at: null,
    company_name: 'Acme Studio', apply_link: 'https://acme.example/careers/84',
    work_remotely: true, offer_relocation: false,
    created_at: '2026-07-23T10:00:00+00:00', listing_placement: { posted_at: '2026-10-14T03:29:55+00:00' },
    description: '<p>Paint &amp; lead.</p><ul><li>Concept</li></ul>',
    recruitment_localities: [{ locality: { city_name: 'Lyon', country_name: 'France' } }, { locality: { country_name: 'France' } }],
    ...over,
  });
  const jobs = parseArtStationJobs([
    row(),
    row({ hash_id: 'ab12', title: 'Illustrator', apply_link: 'mailto:jobs@acme.example', work_remotely: false, offer_relocation: true, recruitment_localities: [] }),
    row({ hash_id: 'zz99', title: 'Closed', deleted_at: '2026-10-01T00:00:00+00:00' }),
    row({ hash_id: 'yy88', title: 'Pending', job_state: 'pending' }),
    row({ hash_id: 'no title', title: 'Bad id' }),
    row({ hash_id: 'cc33', title: '', }),
    row({ hash_id: 'ee55', title: 'No company', company_name: '', recruitment_company: undefined }),
    null, 'junk',
  ]);

  if (jobs.length === 2) pass('skips deleted, unapproved, untitled, bad-id, unattributed and non-object rows');
  else fail(`kept ${jobs.length}: ${JSON.stringify(jobs.map((j) => j.title))}`);
  if (jobs[0].url === 'https://acme.example/careers/84' && jobs[0].company === 'Acme Studio') pass('prefers the employer https apply_link');
  else fail(`row 0 = ${JSON.stringify(jobs[0])}`);
  if (jobs[1].url === 'https://www.artstation.com/jobs/ab12') pass('falls back to the ArtStation page when apply_link is not an https URL');
  else fail(`row 1 url = ${jobs[1].url}`);
  if (jobs[0].location === 'Remote · Lyon, France · France' && jobs[1].location === 'Relocation offered') {
    pass('location carries Remote / Relocation offered / localities');
  } else {
    fail(`locations = ${JSON.stringify([jobs[0].location, jobs[1].location])}`);
  }
  if (jobs[0].postedAt === Date.parse('2026-10-14T03:29:55+00:00')) pass('postedAt uses the placement date');
  else fail(`postedAt = ${jobs[0].postedAt}`);
  if (jobs[0].description === 'Paint & lead.\nConcept') pass('description is plain text with entities decoded');
  else fail(`description = ${JSON.stringify(jobs[0].description)}`);

  // fetch(): envelope guard and paging on the source's own short page
  const calls = [];
  const ctx = (pages) => ({ fetchJson: async (url) => { calls.push(url); return pages.shift(); }, sleep: async () => {} });
  const full = { data: Array.from({ length: 100 }, (_, i) => row({ hash_id: `a${String(i).padStart(3, '0')}`, apply_link: '' })) };
  const got = await p.fetch({ provider: 'artstation', maxPages: 5 }, ctx([full, { data: [row({ hash_id: 'zzzz', apply_link: '' })] }, { data: [] }]));
  if (got.length === 101 && calls.length === 2) pass('pages until the source returns a short page');
  else fail(`got ${got.length} rows in ${calls.length} calls`);

  let threw = false;
  try { await p.fetch({ provider: 'artstation' }, ctx([{ jobs: [] }])); } catch (e) { threw = /unexpected response/.test(e.message); }
  if (threw) pass('throws when the envelope has no data[] (API changed)');
  else fail('envelope change must throw');
  const empty = await p.fetch({ provider: 'artstation' }, ctx([{ data: [] }]));
  if (Array.isArray(empty) && empty.length === 0) pass('data: [] is an empty board, not an error');
  else fail('empty board must return []');
} catch (e) {
  fail(`artstation provider test crashed: ${e.message}`);
}
