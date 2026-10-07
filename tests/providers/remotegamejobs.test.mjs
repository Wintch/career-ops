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
    item('Redirector Co is hiring Tester (Remote Job)', 'https://remotegamejobs.com/goto/redir-5', 'Tue, 06 Oct 2026 08:00:00 +0000'),
    item('Evil Co is hiring Hacker (Remote Job)', 'https://evil.example/jobs/6', 'Tue, 06 Oct 2026 08:00:00 +0000'),
    item('Lunacy Studios is hiring Unreal 5 Programmer (Gameplay, UI) (Remote Job)', 'https://remotegamejobs.com/jobs/lunacy-1', 'Tue, 06 Oct 2026 21:39:33 +0000'),
  ].join('')}</channel></rss>`;
  const jobs = parseRemoteGameJobsFeed(xml, { now: NOW });

  // /goto/ is robots-disallowed but is still a remotegamejobs.com https link, so it is kept
  // only if the feed emits it; the feed never does. Everything on the host passes; the other host does not.
  if (jobs.length === 4) pass('parseRemoteGameJobsFeed keeps 4 items (drops too-old, off-host and duplicate)');
  else fail(`parseRemoteGameJobsFeed returned ${jobs.length}: ${JSON.stringify(jobs.map((j) => j.url))}`);
  if (jobs[0]?.company === 'Lunacy Studios' && jobs[0]?.title === 'Unreal 5 Programmer (Gameplay, UI)' && jobs[0]?.location === 'Remote'
      && jobs[0]?.postedAt === Date.parse('2026-10-06T21:39:33Z')) {
    pass('splits "<Company> is hiring <Role> (Remote Job)", sets location Remote and postedAt');
  } else {
    fail(`row 0 = ${JSON.stringify(jobs[0])}`);
  }
  if (jobs[1]?.company === 'A & B Games') pass('decodes HTML entities in the title');
  else fail(`row 1 = ${JSON.stringify(jobs[1])}`);
  if (jobs[2]?.title === 'Odd title without the usual shape' && jobs[2]?.company === '') pass('keeps an unparseable title whole with an empty company');
  else fail(`row 2 = ${JSON.stringify(jobs[2])}`);
  if (parseRemoteGameJobsFeed(xml, { now: NOW, maxAgeDays: 4000 }).some((j) => j.url.endsWith('old-3'))) pass('maxAgeDays widens the window');
  else fail('maxAgeDays should widen the window');
  if (parseRemoteGameJobsFeed(null).length === 0 && parseRemoteGameJobsFeed('<rss></rss>').length === 0) pass('returns [] for empty or non-string input');
  else fail('must return [] for empty/non-string input');
} catch (e) {
  fail(`remotegamejobs tests threw: ${e.message}`);
}
