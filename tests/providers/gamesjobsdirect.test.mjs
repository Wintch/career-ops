// tests/providers/gamesjobsdirect.test.mjs — Games Jobs Direct paginated HTML provider.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — gamesjobsdirect');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/gamesjobsdirect.mjs')).href);
  const p = mod.default;
  const { parseGamesJobsDirectPage } = mod;

  if (p.id === 'gamesjobsdirect') pass('gamesjobsdirect.id is "gamesjobsdirect"');
  else fail(`id is ${JSON.stringify(p.id)}`);
  if (p.detect({ name: 'G', provider: 'gamesjobsdirect' }) && p.detect({ name: 'G', careers_url: 'https://www.gamesjobsdirect.com' }) === null) {
    pass('detect() is explicit-only (provider: gamesjobsdirect)');
  } else {
    fail('detect() must be explicit-only');
  }

  const card = (href, title, loc, co, posted, hot = false) => `
    <div class="row"><p><a href="${href}" class="job-title" title="${title}">${title}</a>
    ${hot ? '<span class="label job-status">Hot Job</span>' : ''}</p>
    <p class="job-info"><span class="job-location">${loc}</span><span class="job-company">${co}</span><span class="job-sector"> Art</span></p>
    <p class="job-description">text</p><p class="job-posteddate">Posted - ${posted}</p></div>`;
  const page1 = [
    card('/job/virtuos/ml-engineer/1', 'Senior ML Engineer', 'Shanghai, China', 'Virtuos', '24 Sep 2026', true),
    card('/job/larian/concept-artist/2', 'Concept &amp; 2D Artist', 'Ghent, Belgium', 'Larian Studios', '06 Oct 2026'),
    card('/job/acme/3d-artist/3', '3D Artist', 'Remote', 'Acme', '5 Oct 2026'),
  ].join('');
  const { jobs, newestMs } = parseGamesJobsDirectPage(page1);

  if (jobs.length === 3) pass('parseGamesJobsDirectPage reads every card');
  else fail(`read ${jobs.length} cards`);
  if (jobs[1]?.title === 'Concept & 2D Artist' && jobs[1]?.company === 'Larian Studios' && jobs[1]?.location === 'Ghent, Belgium'
      && jobs[1]?.url === 'https://www.gamesjobsdirect.com/job/larian/concept-artist/2' && jobs[1]?.postedAt === Date.parse('2026-10-06T00:00:00Z')) {
    pass('maps title (entities decoded), company, location, absolute url and postedAt');
  } else {
    fail(`row 1 = ${JSON.stringify(jobs[1])}`);
  }
  if (newestMs === Date.parse('2026-10-06T00:00:00Z')) pass('newestMs is the newest date on the page, not the first card (paid "Hot Job" is pinned on top)');
  else fail(`newestMs = ${new Date(newestMs).toISOString()}`);
  const empty = parseGamesJobsDirectPage('<html></html>');
  if (empty.jobs.length === 0 && empty.newestMs === -Infinity && parseGamesJobsDirectPage(null).jobs.length === 0) pass('returns no jobs for an empty or non-string page');
  else fail('must return no jobs for empty/non-string pages');

  // fetch(): paces at the robots.txt Crawl-Delay, stops once a page is older than the window.
  const requested = [];
  const sleeps = [];
  const today = new Date();
  const fmt = (d) => `${String(d.getUTCDate()).padStart(2, '0')} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} ${d.getUTCFullYear()}`;
  const old = new Date(today.getTime() - 30 * 86_400_000);
  const ctx = {
    async fetchText(url) {
      requested.push(url);
      const n = Number(url.match(/page=(\d+)/)[1]);
      return n === 1 ? card('/job/new/a/10', 'New Role', 'Remote', 'NewCo', fmt(today))
        : card('/job/old/b/11', 'Old Role', 'Remote', 'OldCo', fmt(old));
    },
    async sleep(ms) { sleeps.push(ms); },
  };
  const out = await p.fetch({ name: 'G', provider: 'gamesjobsdirect', maxAgeDays: 2, maxPages: 8 }, ctx);
  if (requested.length === 2 && out.length === 1 && out[0].title === 'New Role') pass('fetch() stops after the first page older than maxAgeDays and drops stale postings');
  else fail(`fetch() requested ${requested.length} pages, returned ${JSON.stringify(out.map((j) => j.title))}`);
  if (sleeps.length >= 1 && sleeps.every((ms) => ms >= 5000)) pass('fetch() waits at least the robots.txt Crawl-Delay (5 s) between pages');
  else fail(`fetch() sleeps = ${JSON.stringify(sleeps)}`);

  const probed = [];
  await p.fetch({ name: 'G', provider: 'gamesjobsdirect', maxAgeDays: 400 }, { maxPages: 1, async fetchText(u) { probed.push(u); return card('/job/x/y/1', 'T', 'L', 'C', fmt(today)); }, async sleep() {} });
  if (probed.length === 1) pass('fetch() honours a health-probe maxPages of 1');
  else fail(`probe fetched ${probed.length} pages`);
} catch (e) {
  fail(`gamesjobsdirect tests threw: ${e.message}`);
}
