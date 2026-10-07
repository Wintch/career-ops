// tests/providers/workwithindies.test.mjs — Work With Indies RSS provider.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — workwithindies');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/workwithindies.mjs')).href);
  const p = mod.default;
  const { parseWorkWithIndiesFeed } = mod;

  if (p.id === 'workwithindies') pass('workwithindies.id is "workwithindies"');
  else fail(`id is ${JSON.stringify(p.id)}`);
  if (p.detect({ name: 'W', provider: 'workwithindies' })?.url === 'https://www.workwithindies.com/careers/rss.xml'
      && p.detect({ name: 'W', careers_url: 'https://www.workwithindies.com' }) === null) {
    pass('detect() is explicit-only (provider: workwithindies)');
  } else {
    fail('detect() must be explicit-only');
  }

  const NOW = Date.parse('2026-10-07T00:00:00Z');
  const item = (title, link, date) => `<item><title>${title}</title><link>${link}</link><pubDate>${date}</pubDate></item>`;
  const xml = `<rss><channel>${[
    item('Lunacy Studios is hiring a Unreal 5 Programmer (Gameplay, UI) to work from Anywhere', 'https://www.workwithindies.com/careers/lunacy', 'Tue, 06 Oct 2026 20:33:14 GMT'),
    item('ambedo studios is hiring a 3D Game Artist to work from Vancouver, BC', 'https://www.workwithindies.com/careers/ambedo', 'Mon, 05 Oct 2026 20:33:14 GMT'),
    item('Pixel Co is hiring an Animator to work from Buenos Aires', 'https://www.workwithindies.com/careers/pixel', 'Sun, 04 Oct 2026 20:33:14 GMT'),
    item('Stale Co is hiring a Designer to work from Anywhere', 'https://www.workwithindies.com/careers/stale', 'Mon, 01 Jan 2024 20:33:14 GMT'),
    item('Not our shape', 'https://www.workwithindies.com/careers/odd', 'Tue, 06 Oct 2026 20:33:14 GMT'),
    item('Evil Co is hiring a Hacker to work from Anywhere', 'http://www.workwithindies.com/careers/insecure', 'Tue, 06 Oct 2026 20:33:14 GMT'),
  ].join('')}</channel></rss>`;
  const jobs = parseWorkWithIndiesFeed(xml, { now: NOW });

  if (jobs.length === 4) pass('parseWorkWithIndiesFeed keeps 4 items (drops too-old and non-https)');
  else fail(`returned ${jobs.length}: ${JSON.stringify(jobs.map((j) => j.url))}`);
  if (jobs[0]?.company === 'Lunacy Studios' && jobs[0]?.title === 'Unreal 5 Programmer (Gameplay, UI)' && jobs[0]?.location === 'Anywhere') {
    pass('splits company, role and "to work from <place>" location');
  } else {
    fail(`row 0 = ${JSON.stringify(jobs[0])}`);
  }
  if (jobs[1]?.location === 'Vancouver, BC' && jobs[2]?.title === 'Animator' && jobs[2]?.location === 'Buenos Aires') {
    pass('handles "a" / "an" and multi-part places');
  } else {
    fail(`rows 1-2 = ${JSON.stringify(jobs.slice(1, 3))}`);
  }
  if (jobs[3]?.title === 'Not our shape' && jobs[3]?.company === '' && jobs[3]?.location === '') pass('keeps an unparseable title whole');
  else fail(`row 3 = ${JSON.stringify(jobs[3])}`);
  if (parseWorkWithIndiesFeed(undefined).length === 0) pass('returns [] for non-string input');
  else fail('must return [] for non-string input');
} catch (e) {
  fail(`workwithindies tests threw: ${e.message}`);
}
