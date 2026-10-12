// tests/providers/remotegamejobs.test.mjs — Remote Game Jobs RSS provider.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — remotegamejobs');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/remotegamejobs.mjs')).href);
  const p = mod.default;
  const { parseRemoteGameJobsFeed } = mod;

  if (p.id === 'remotegamejobs') pass('remotegamejobs.id is "remotegamejobs"');
  else fail(`id is ${JSON.stringify(p.id)}`);
  if (p.detect({ name: 'R', provider: 'remotegamejobs' })?.url === 'https://remotegamejobs.com/feed.rss'
      && p.detect({ name: 'R', careers_url: 'https://remotegamejobs.com' }) === null) {
    pass('detect() is explicit-only (provider: remotegamejobs)');
  } else {
    fail('detect() must be explicit-only');
  }

  const NOW = Date.parse('2026-10-07T00:00:00Z');
  const item = (title, link, date) => `<item><title>${title}</title><link>${link}</link><pubDate>${date}</pubDate></item>`;
  const xml = `<?xml version="1.0"?><rss><channel><title>Remote Game Jobs</title>${[
    item('Lunacy Studios is hiring Unreal 5 Programmer (Gameplay, UI) (Remote Job)', 'https://remotegamejobs.com/jobs/lunacy-1', 'Tue, 06 Oct 2026 21:39:33 +0000'),
    item('A &amp; B Games is hiring Senior Artist (Remote Job)', 'https://remotegamejobs.com/jobs/ab-2', 'Mon, 05 Oct 2026 10:00:00 +0000'),
    item('Old Studio is hiring Animator (Remote Job)', 'https://remotegamejobs.com/jobs/old-3', 'Mon, 01 Jan 2024 10:00:00 +0000'),
    item('Odd title without the usual shape', 'https://remotegamejobs.com/jobs/odd-4', 'Tue, 06 Oct 2026 08:00:00 +0000'),
    item('Plural Co is hiring Artists (Remote Job)', 'https://remotegamejobs.com/jobs/plural-8', 'Tue, 06 Oct 2026 08:00:00 +0000'),
    item('Confidential is hiring a Producer (Remote Job)', 'https://remotegamejobs.com/jobs/conf-9', 'Tue, 06 Oct 2026 08:00:00 +0000'),
    item('Port Co is hiring Tester (Remote Job)', 'https://remotegamejobs.com:8443/jobs/port-10', 'Tue, 06 Oct 2026 08:00:00 +0000'),
    item('Redirector Co is hiring Tester (Remote Job)', 'https://remotegamejobs.com/goto/redir-5', 'Tue, 06 Oct 2026 08:00:00 +0000'),
    item('Evil Co is hiring Hacker (Remote Job)', 'https://evil.example/jobs/6', 'Tue, 06 Oct 2026 08:00:00 +0000'),
    item('Lunacy Studios is hiring Unreal 5 Programmer (Gameplay, UI) (Remote Job)', 'https://remotegamejobs.com/jobs/lunacy-1', 'Tue, 06 Oct 2026 21:39:33 +0000'),
  ].join('')}</channel></rss>`;
  const jobs = parseRemoteGameJobsFeed(xml, { now: NOW });

  // /goto/ (robots-disallowed), off-host, non-default-port, unattributed, stale and duplicate items are dropped.
  const warns = [];
  const origWarn = console.warn;
  console.warn = (m) => warns.push(String(m));
  let jobs2;
  try { jobs2 = parseRemoteGameJobsFeed(xml, { now: NOW }); } finally { console.warn = origWarn; }
  if (jobs.length === 3 && jobs.every((j) => j.url.includes('/jobs/') && !j.url.includes(':8443'))) pass('keeps 3 items (drops too-old, off-host, /goto/, odd port, unattributed and duplicate)');
  else fail(`parseRemoteGameJobsFeed returned ${jobs.length}: ${JSON.stringify(jobs.map((j) => j.url))}`);
  if (warns.length === 1 && /dropped 2 item/.test(warns[0]) && jobs2.length === 3) pass('counts unattributed items in one warning');
  else fail(`warns = ${JSON.stringify(warns)}`);
  if (jobs.some((j) => j.company === 'Plural Co' && j.title === 'Artists')) pass('accepts titles without an a/an article');
  else fail('plural title not parsed');
  if (jobs[0]?.company === 'Lunacy Studios' && jobs[0]?.title === 'Unreal 5 Programmer (Gameplay, UI)' && jobs[0]?.location === 'Remote'
      && jobs[0]?.postedAt === Date.parse('2026-10-06T21:39:33Z')) {
    pass('splits "<Company> is hiring <Role> (Remote Job)", sets location Remote and postedAt');
  } else {
    fail(`row 0 = ${JSON.stringify(jobs[0])}`);
  }
  if (jobs[1]?.company === 'A & B Games') pass('decodes HTML entities in the title');
  else fail(`row 1 = ${JSON.stringify(jobs[1])}`);
  if (!jobs.some((j) => j.url.endsWith('odd-4')) && !jobs.some((j) => j.url.endsWith('conf-9'))) pass('drops off-pattern and "Confidential" items (no identifiable employer)');
  else fail('unattributed items must be dropped');
  if (parseRemoteGameJobsFeed(xml, { now: NOW, maxAgeDays: 4000 }).some((j) => j.url.endsWith('old-3'))) pass('maxAgeDays widens the window');
  else fail('maxAgeDays should widen the window');
  const throws = (f) => { try { f(); return false; } catch { return true; } };
  if (parseRemoteGameJobsFeed('<rss><channel></channel></rss>').length === 0) pass('returns [] for a well-formed empty channel');
  else fail('empty channel must give []');
  if (throws(() => parseRemoteGameJobsFeed(null)) && throws(() => parseRemoteGameJobsFeed('<html>Just a moment...</html>')) && throws(() => parseRemoteGameJobsFeed(''))
      && throws(() => parseRemoteGameJobsFeed('<rss><channel><item><foo/></item></channel></rss>'))) pass('throws on non-RSS bodies and on items that all fail to parse');
  else fail('broken feeds must throw');

  // fetch(): redirect:'error', alias, and a throwing non-RSS body.
  const seen = [];
  const out = await p.fetch({ name: 'R', provider: 'remotegamejobs', since_days: 4000 }, { async fetchText(u, o) { seen.push([u, o]); return xml; } });
  if (seen.length === 1 && seen[0][1]?.redirect === 'error' && out.some((j) => j.url.endsWith('old-3'))) pass('fetch() uses redirect:"error" and honours the since_days alias');
  else fail(`fetch seen = ${JSON.stringify(seen)}`);
  let threw = false;
  try { await p.fetch({ name: 'R', provider: 'remotegamejobs' }, { async fetchText() { return '<html>challenge</html>'; } }); } catch { threw = true; }
  if (threw) pass('fetch() throws on a non-RSS body');
  else fail('fetch() must throw on a non-RSS body');

  // rssTag hygiene: CDATA description must not leak a <title>/<link>; <guid> permalink backs up a missing <link>.
  const tricky = `<rss><channel><item><description><![CDATA[<p><title>Fake</title><link>https://evil.example/</link></p>]]></description><titles>nope</titles><title>Real Co is hiring a Dev (Remote Job)</title><guid isPermaLink="true">https://remotegamejobs.com/jobs/guid-7</guid><pubDate>Tue, 06 Oct 2026 08:00:00 +0000</pubDate></item></channel></rss>`;
  const t = parseRemoteGameJobsFeed(tricky, { now: NOW });
  if (t.length === 1 && t[0].company === 'Real Co' && t[0].url === 'https://remotegamejobs.com/jobs/guid-7') pass('ignores CDATA description markup, exact tag names, and falls back to a permalink guid');
  else fail(`tricky = ${JSON.stringify(t)}`);
} catch (e) {
  fail(`remotegamejobs tests threw: ${e.message}`);
}
