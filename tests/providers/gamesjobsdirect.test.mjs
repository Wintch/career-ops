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

  // Per-card parsing: a card without a date must not swallow the next one; long month names; '>' in title=""; extra classes.
  const odd = parseGamesJobsDirectPage(
    '<a href="/job/a/1" class="job-title" title="x > y">Tools &gt; Engineer</a><span class="job-location">Paris</span><span class="job-company">NoDate Co</span>'
    + card('/job/b/2', 'Next Role', 'Rome', 'Next Co', '3 Sept 2026')
    + '<a class="job-title bold" href="/job/c/3" title="t">Classy</a><span class="job-location">Oslo</span><span class="x job-company extra"><b>Nested Co</b></span><p class="job-posteddate">Posted - 12 September 2026</p>'
    + card('/job/d/4', 'Anon Role', 'Rome', 'Confidential', '3 Oct 2026')
    + '<a href="/job/e/5" class="job-title">No Employer</a><p class="job-posteddate">Posted - 3 Oct 2026</p>');
  if (odd.jobs.length === 3 && odd.jobs[0].title === 'Tools > Engineer' && odd.jobs[0].company === 'NoDate Co' && odd.jobs[0].postedAt === undefined) pass('a card without a date does not swallow the next card; ">" inside title="" is tolerated');
  else fail(`odd = ${JSON.stringify(odd.jobs)}`);
  if (odd.jobs[1].postedAt === Date.UTC(2026, 8, 3) && odd.jobs[2].postedAt === Date.UTC(2026, 8, 12) && odd.jobs[2].company === 'Nested Co') pass('accepts "Sept"/"September" month names and extra/nested company markup');
  else fail(`odd rows = ${JSON.stringify(odd.jobs.slice(1))}`);
  if (odd.dropped === 2) pass('drops (and counts) cards with an empty or placeholder employer');
  else fail(`dropped = ${odd.dropped}`);
  if (parseGamesJobsDirectPage(card('//evil.example/x', 'T', 'L', 'C', '1 Oct 2026').replace('//evil.example/x', '/job/..%2f/x')).jobs.length <= 1
      && parseGamesJobsDirectPage('<a href="/job/x/1&amp;a=2" class="job-title">T</a><span class="job-company">C</span>').jobs[0]?.url === 'https://www.gamesjobsdirect.com/job/x/1&a=2') pass('decodes entities in the href and resolves it against the origin');
  else fail('href decoding');

  // fetch(): fixed clock, hardcoded month names.
  const NOW = Date.parse('2026-10-07T12:00:00Z');
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmt = (ms) => { const d = new Date(ms); return `${String(d.getUTCDate()).padStart(2, '0')} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
  const mkCtx = (pageFn, extra = {}) => {
    const c = { now: NOW, requested: [], sleeps: [], opts: [], async fetchText(url, o) { c.requested.push(url); c.opts.push(o); return pageFn(Number(url.match(/page=(\d+)/)[1])); }, async sleep(ms) { c.sleeps.push(ms); }, ...extra };
    return c;
  };
  const warns = [];
  const origWarn = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    const c1 = mkCtx((n) => (n === 1 ? card('/job/new/a/10', 'New Role', 'Remote', 'NewCo', fmt(NOW)) : card('/job/old/b/11', 'Old Role', 'Remote', 'OldCo', fmt(NOW - 30 * 86_400_000))));
    const out = await p.fetch({ name: 'G', provider: 'gamesjobsdirect', maxAgeDays: 2, maxPages: 8 }, c1);
    if (c1.requested.length === 2 && out.length === 1 && out[0].title === 'New Role') pass('fetch() stops after the first page older than maxAgeDays and drops stale postings (fixed clock)');
    else fail(`fetch() requested ${c1.requested.length} pages, returned ${JSON.stringify(out.map((j) => j.title))}`);
    if (c1.sleeps.length >= 1 && c1.sleeps.every((ms) => ms >= 5000)) pass('fetch() waits at least the robots.txt Crawl-Delay (5 s) between pages');
    else fail(`fetch() sleeps = ${JSON.stringify(c1.sleeps)}`);
    if (c1.opts.length && c1.opts.every((o) => o?.redirect === 'error')) pass('fetch() requests with redirect:"error"');
    else fail(`opts = ${JSON.stringify(c1.opts)}`);

    // Boundary: day N (UTC midnight of today - N) is kept; N+1 is not.
    const c2 = mkCtx(() => card('/job/a/1', 'Edge', 'L', 'C', '5 Oct 2026') + card('/job/a/2', 'Past', 'L', 'C', '4 Oct 2026'));
    const edge = await p.fetch({ name: 'G', provider: 'gamesjobsdirect', maxAgeDays: 2 }, c2);
    if (edge.length === 1 && edge[0].title === 'Edge') pass('cutoff is UTC midnight of today - maxAgeDays (day N kept)');
    else fail(`edge = ${JSON.stringify(edge.map((j) => j.title))}`);

    // Aliases + default page budget.
    const c3 = mkCtx((n) => card(`/job/x/${n}`, `R${n}`, 'L', 'C', fmt(NOW)));
    warns.length = 0;
    await p.fetch({ name: 'G', provider: 'gamesjobsdirect', max_pages: 3, since_days: 2 }, c3);
    if (c3.requested.length === 3) pass('max_pages / since_days aliases are honoured');
    else fail(`alias requested ${c3.requested.length}`);
    if (warns.some((w) => /stopped at max_pages/.test(w) && /raise maxPages/.test(w))) pass('warns when the loop ends on the page budget still inside the window');
    else fail(`warns = ${JSON.stringify(warns)}`);
    const c4 = mkCtx((n) => card(`/job/x/${n}`, `R${n}`, 'L', 'C', fmt(NOW)));
    await p.fetch({ name: 'G', provider: 'gamesjobsdirect', maxAgeDays: 2 }, c4);
    if (c4.requested.length === 25) pass('default page budget is 25');
    else fail(`default pages = ${c4.requested.length}`);

    // Markup change on page 1 throws; later empty page just stops; no /job/ links is a quiet [].
    let threw = false;
    try { await p.fetch({ name: 'G', provider: 'gamesjobsdirect' }, mkCtx(() => '<a href="/job/x/1" class="renamed">T</a>')); } catch { threw = true; }
    if (threw) pass('throws when page 1 has /job/ links but zero cards parse');
    else fail('zero-card page 1 with /job/ hrefs must throw');
    const quiet = await p.fetch({ name: 'G', provider: 'gamesjobsdirect' }, mkCtx(() => '<html>no results</html>'));
    if (quiet.length === 0) pass('a page without /job/ links is an empty board');
    else fail('empty page should return []');
    const c5 = mkCtx((n) => (n === 1 ? card('/job/a/1', 'Keep', 'L', 'C', fmt(NOW)) : '<html>end</html>'));
    const later = await p.fetch({ name: 'G', provider: 'gamesjobsdirect' }, c5);
    if (later.length === 1 && c5.requested.length === 2) pass('an empty later page ends paging quietly');
    else fail('later empty page');

    // Page 2 failure keeps page 1 and warns.
    warns.length = 0;
    const c6 = mkCtx((n) => { if (n === 2) throw new Error('boom'); return card('/job/a/1', 'Keep', 'L', 'C', fmt(NOW)); });
    const partial = await p.fetch({ name: 'G', provider: 'gamesjobsdirect' }, c6);
    if (partial.length === 1 && warns.some((w) => /page 2 failed/.test(w))) pass('a page-2 failure keeps earlier pages and warns');
    else fail(`partial = ${partial.length}, warns = ${JSON.stringify(warns)}`);
    let p1threw = false;
    try { await p.fetch({ name: 'G', provider: 'gamesjobsdirect' }, mkCtx(() => { throw new Error('down'); })); } catch { p1threw = true; }
    if (p1threw) pass('a page-1 failure throws');
    else fail('page-1 failure must throw');

    // Unattributed cards are dropped with one warning.
    warns.length = 0;
    const c7 = mkCtx(() => card('/job/a/1', 'Anon', 'L', 'Confidential', fmt(NOW)) + card('/job/a/2', 'Named', 'L', 'Real Co', fmt(NOW)), { maxPages: 1 });
    const named = await p.fetch({ name: 'G', provider: 'gamesjobsdirect' }, c7);
    if (named.length === 1 && named[0].company === 'Real Co' && warns.filter((w) => /no identifiable employer/.test(w)).length === 1) pass('drops unattributed postings with one warning per fetch');
    else fail(`named = ${JSON.stringify(named)}, warns = ${JSON.stringify(warns)}`);

    const probed = mkCtx(() => card('/job/x/y/1', 'T', 'L', 'C', fmt(NOW)), { maxPages: 1 });
    await p.fetch({ name: 'G', provider: 'gamesjobsdirect', maxAgeDays: 400 }, probed);
    if (probed.requested.length === 1) pass('fetch() honours a health-probe maxPages of 1');
    else fail(`probe fetched ${probed.requested.length} pages`);
  } finally {
    console.warn = origWarn;
  }
} catch (e) {
  fail(`gamesjobsdirect tests threw: ${e.message}`);
}
