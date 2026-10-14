// tests/providers/gamesworkshop.test.mjs — Games Workshop single-page listing provider.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — gamesworkshop');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/gamesworkshop.mjs')).href);
  const p = mod.default;
  const { parseGamesWorkshopListing } = mod;

  if (p.id === 'gamesworkshop') pass('gamesworkshop.id is "gamesworkshop"');
  else fail(`id is ${JSON.stringify(p.id)}`);
  if (p.detect({ name: 'GW', careers_url: 'https://jobs.games-workshop.com/search-and-apply' })
      && p.detect({ name: 'GW', provider: 'gamesworkshop' })
      && p.detect({ name: 'X', careers_url: 'https://jobs.games-workshop.com.evil.example/' }) === null
      && p.detect({ name: 'X', careers_url: 'https://example.com/' }) === null) {
    pass('detect() claims the careers host (anchored) or the explicit provider id only');
  } else {
    fail('detect() claims the wrong entries');
  }

  const card = (href, title, loc, closes) => `<div class="jobs-listing__list__item">
	<div class="jobs-listing__list__item__icon"><img alt="Design Icon" /></div>
	<div class="jobs-listing__list__item__title">
		<a href="${href}">${title}</a>
	</div>
	<div class="jobs-listing__list__item__location">
		${loc}	</div>
	<div class="jobs-listing__list__item__closes">
		Closes: ${closes}	</div>
</div>`;
  const html = `<div class="jobs-listing__list">${[
    card('https://jobs.games-workshop.com/search-and-apply/design-manager-warhammer-40000', 'Design Manager &#8211; Warhammer 40,000', 'Nottingham, UK', 'Oct 25, 2026'),
    card('https://jobs.games-workshop.com/search-and-apply/store-manager-duluth', 'Store Manager: Duluth', 'Minnesota,&nbsp;United States', 'Oct 22, 2026'),
    card('https://jobs.games-workshop.com/de/suchen-und-anwenden/warhammer-laden-manager', 'Laden-Manager (translated copy)', 'Germany', 'Oct 1, 2026'),
    card('https://elsewhere.example/search-and-apply/x', 'Off-site link', 'Nowhere', 'Oct 1, 2026'),
    card('https://jobs.games-workshop.com/search-and-apply/empty-title', '  ', 'Nottingham, UK', 'Oct 1, 2026'),
  ].join('')}</div>`;
  const jobs = parseGamesWorkshopListing(html);

  if (jobs.length === 2) pass('keeps same-site cards with a title, drops off-site links, translated copies and blank titles');
  else fail(`kept ${jobs.length}: ${JSON.stringify(jobs)}`);
  if (jobs[0].title === 'Design Manager – Warhammer 40,000' && jobs[0].company === 'Games Workshop'
      && jobs[0].url === 'https://jobs.games-workshop.com/search-and-apply/design-manager-warhammer-40000') {
    pass('maps title (entities decoded), company and absolute url');
  } else {
    fail(`row 0 = ${JSON.stringify(jobs[0])}`);
  }
  if (jobs[0].location === 'Nottingham, UK' && jobs[1].location === 'Minnesota, United States') pass('location is read per card, non-breaking space normalised');
  else fail(`locations = ${JSON.stringify(jobs.map((j) => j.location))}`);

  if (parseGamesWorkshopListing('<html>nothing here</html>').length === 0 && parseGamesWorkshopListing(null).length === 0) {
    pass('a page with no postings is an empty board');
  } else {
    fail('empty page must return []');
  }
  let threw = false;
  try { parseGamesWorkshopListing('<a href="/search-and-apply/x">x</a><div class="jobs-listing__list__item"><span>changed</span></div>'); } catch (e) { threw = /markup changed/.test(e.message); }
  if (threw) pass('posting links with no parsed card throw (markup changed)');
  else fail('markup change must throw');

  const live = await p.fetch({ provider: 'gamesworkshop' }, { fetchText: async () => html, sleep: async () => {} });
  if (live.length === 2) pass('fetch() reads the listing through ctx.fetchText');
  else fail(`fetch() returned ${live.length}`);
} catch (e) {
  fail(`gamesworkshop provider test crashed: ${e.message}`);
}
