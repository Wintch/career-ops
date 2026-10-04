// tests/providers/alternativateatral.test.mjs — provider-contract tests for the
// Alternativa Teatral "Castings y convocatorias" board
// (providers/alternativateatral.mjs).
//
// The fixtures reproduce shapes measured on the live board on 2026-10-04, and
// each one exists because it decides the parser's design:
//
//   - a posting is one <li> holding a remuneration icon and an anchor
//     `<a href="casting{id}-{slug}">DD/MM/YYYY - Title</a>`; the same page also
//     carries facet <li>s (country / remuneration filters) with the same icon
//     and an anchor to `convocatorias.php?...` that must NOT become postings;
//   - the list carries no employer or location, so `company` is empty and
//     `location` comes only from the entry;
//   - robots.txt asks `Crawl-delay: 600`, so the provider reads ONE page per
//     scan and never paginates;
//   - a listing page that parses to nothing must THROW when it still holds
//     posting links or is not the listing page at all (a block page), while a
//     well-formed page with no postings returns [].
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — alternativateatral');

const ICON = (name) => `<svg role="img" viewBox="0 0 800 600" width="25" height="25"><use xlink:href="img/iconos.svg#${name}"></use></svg>`;
const ROW = (icon, href, text) => `<li>${ICON(icon)}<a href="${href}">${text}</a></li>`;

// Facet list (remuneration filter): same icon + anchor shape, but the link goes
// to convocatorias.php — it is a filter, not a posting.
const FACETS = `<h1>Castings y convocatorias</h1><ul class="filtro-remuneracion">`
  + `<li>${ICON('adhonorem')}<a href="convocatorias.php?tipo=0">No remunerado <strong>155</strong></a></li>`
  + `<li>${ICON('remunerado')}<a href="convocatorias.php?tipo=2">Remunerado <strong>96</strong></a></li></ul>`;

const PAGE = `<html><body>${FACETS}<ul class="lista-convocatorias">`
  + ROW('remunerado', 'casting900001-se-busca-sonidista-para-gira', '02/10/2026 - Se busca sonidista para gira')
  + ROW('adhonorem', 'casting900002-actores-y-actrices-para-cortometraje', '01/10/2026 - Actores &amp; actrices para cortometraje de dise&ntilde;o')
  + ROW('cooperativa', 'casting900003-banda-busca-baterista', 'Banda busca baterista sin fecha')
  + ROW('remunerado', 'casting900004-fecha-imposible', '31/02/2026 - Fecha imposible en el calendario')
  + ROW('remunerado', 'casting900001-se-busca-sonidista-para-gira', '02/10/2026 - Se busca sonidista para gira')
  + `</ul></body></html>`;

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/alternativateatral.mjs')).href);
  const provider = mod.default;
  const { parseListingPage, buildListUrl, assertParsedSomething, toEpochMs, readLocation, visibleText } = mod;

  if (provider.id === 'alternativateatral') pass('alternativateatral.id is "alternativateatral"');
  else fail(`alternativateatral.id is ${JSON.stringify(provider.id)}`);

  // ── detect(): explicit selection only; never throws on junk ──
  const hit = provider.detect({ name: 'Alternativa Teatral', provider: 'alternativateatral' });
  if (hit && hit.url === 'https://www.alternativateatral.com/convocatorias.php') {
    pass('detect() resolves provider:alternativateatral → the listing URL');
  } else {
    fail(`detect() returned ${JSON.stringify(hit)}`);
  }
  if (provider.detect({ name: 'x' }) === null
      && provider.detect({ careers_url: 'https://www.alternativateatral.com/convocatorias.php' }) === null) {
    pass('detect() returns null without provider:alternativateatral (no URL-pattern claim)');
  } else {
    fail('detect() must be explicit-only');
  }
  if (provider.detect(null) === null && provider.detect(undefined) === null && provider.detect({ provider: 'alternativateatral', pais: 'x' }) === null) {
    pass('detect() returns null on junk input and on an invalid filter, without throwing');
  } else {
    fail('detect() threw or claimed junk input');
  }

  // ── buildListUrl(): integer filters only, fixed order ──
  if (buildListUrl({}) === 'https://www.alternativateatral.com/convocatorias.php') pass('buildListUrl(): bare board has no query string');
  else fail(`bare URL drift: ${buildListUrl({})}`);
  if (buildListUrl({ tipo: 2, clasificacion: 2, provincia: 587, pais: 1 })
      === 'https://www.alternativateatral.com/convocatorias.php?pais=1&provincia=587&clasificacion=2&tipo=2') {
    pass('buildListUrl(): filters are emitted in a fixed order regardless of key order');
  } else {
    fail(`filter order drift: ${buildListUrl({ tipo: 2, clasificacion: 2, provincia: 587, pais: 1 })}`);
  }
  if (buildListUrl({ tipo: 0 }).endsWith('?tipo=0')) pass('buildListUrl(): tipo 0 (no remunerado) is a real filter, not "unset"');
  else fail('tipo 0 was dropped');
  for (const bad of [{ pais: '1&x=2' }, { pais: -1 }, { tipo: 1.5 }, { clasificacion: 'abc' }, { provincia: 1_000_000 }, { pais: 0 }]) {
    let threw = false;
    try { buildListUrl(bad); } catch (e) { threw = /invalid/.test(String(e && e.message)); }
    if (threw) pass(`buildListUrl() rejects ${JSON.stringify(bad)} instead of interpolating it`);
    else fail(`buildListUrl() accepted ${JSON.stringify(bad)}`);
  }

  // ── toEpochMs(): NaN-safe, no calendar rollover ──
  if (toEpochMs('02', '10', '2026') === Date.UTC(2026, 9, 2)) pass('toEpochMs(): DD/MM/YYYY → UTC midnight');
  else fail('toEpochMs drift');
  if (toEpochMs(31, 2, 2026) === undefined && toEpochMs('x', 1, 2026) === undefined) {
    pass('toEpochMs(): impossible and non-numeric dates → undefined, not a rolled-over date or NaN');
  } else {
    fail('toEpochMs accepted an impossible date');
  }

  // ── parseListingPage() ──
  const jobs = parseListingPage(PAGE, { location: 'Argentina' });
  if (jobs.length === 4) pass('parseListingPage(): 4 postings — facet <li>s ignored, the repeated href deduped');
  else fail(`parseListingPage returned ${jobs.length}: ${JSON.stringify(jobs.map((j) => j.url))}`);

  const first = jobs[0];
  if (first && first.title === 'Se busca sonidista para gira'
      && first.url === 'https://www.alternativateatral.com/casting900001-se-busca-sonidista-para-gira'
      && first.company === '' && first.location === 'Argentina'
      && first.postedAt === Date.UTC(2026, 9, 2)
      && first.description === 'Remuneración: Remunerado') {
    pass('parseListingPage(): title without the date prefix, absolute URL, empty company, entry location, postedAt, pay note');
  } else {
    fail(`first posting drift: ${JSON.stringify(first)}`);
  }

  // Entities decode BEFORE any downstream keyword match (#2923): `&amp;` must be `&`.
  const ent = jobs.find((j) => j.url.endsWith('casting900002-actores-y-actrices-para-cortometraje'));
  if (ent && ent.title === 'Actores & actrices para cortometraje de diseño' && ent.description === 'Remuneración: No remunerado') {
    pass('parseListingPage(): entities decoded in the title; the "adhonorem" icon reads "No remunerado"');
  } else {
    fail(`entity/pay drift: ${JSON.stringify(ent)}`);
  }

  // A row without a date prefix keeps its whole text and carries no postedAt.
  const nodate = jobs.find((j) => j.url.endsWith('casting900003-banda-busca-baterista'));
  if (nodate && nodate.title === 'Banda busca baterista sin fecha' && !('postedAt' in nodate) && nodate.description === 'Remuneración: Cooperativa') {
    pass('parseListingPage(): a row with no date has no postedAt (never invented)');
  } else {
    fail(`no-date drift: ${JSON.stringify(nodate)}`);
  }

  // An impossible date drops postedAt but keeps the posting.
  const bad = jobs.find((j) => j.url.endsWith('casting900004-fecha-imposible'));
  if (bad && bad.title === 'Fecha imposible en el calendario' && !('postedAt' in bad)) {
    pass('parseListingPage(): 31/02 is stripped from the title and gives no postedAt');
  } else {
    fail(`impossible-date drift: ${JSON.stringify(bad)}`);
  }

  // Only the charset of a real posting href reaches the URL: no path tricks, no schemes.
  const hostile = `<html>${FACETS}<ul>`
    + ROW('remunerado', '//evil.example/casting1-x', '02/10/2026 - Protocol-relative')
    + ROW('remunerado', 'https://evil.example/casting2-x', '02/10/2026 - Absolute')
    + ROW('remunerado', 'casting3-../../admin', '02/10/2026 - Traversal')
    + ROW('remunerado', 'casting4-ok-one', '02/10/2026 - The only real one')
    + `</ul></html>`;
  const safe = parseListingPage(hostile);
  if (safe.length === 1 && safe[0].url === 'https://www.alternativateatral.com/casting4-ok-one') {
    pass('parseListingPage(): hrefs outside the casting{id}-{slug} shape never reach job.url');
  } else {
    fail(`hostile hrefs leaked: ${JSON.stringify(safe.map((j) => j.url))}`);
  }

  if (parseListingPage('').length === 0 && parseListingPage(undefined).length === 0) pass('parseListingPage(): empty/undefined input → []');
  else fail('parseListingPage must tolerate empty input');

  if (readLocation({ location: '  Buenos   Aires ' }) === 'Buenos Aires' && readLocation({}) === '' && readLocation({ location: 5 }) === '') {
    pass('readLocation(): trims a string, ignores anything else');
  } else {
    fail('readLocation drift');
  }
  if (visibleText('<b>Hola&nbsp;&amp; <i>chau</i></b>') === 'Hola & chau') pass('visibleText(): strips tags and decodes entities once');
  else fail(`visibleText drift: ${visibleText('<b>Hola&nbsp;&amp; <i>chau</i></b>')}`);

  // ── assertParsedSomething(): empty board vs broken parser ──
  const throws = (fn) => { try { fn(); return null; } catch (e) { return String(e && e.message); } };
  if (/markup changed/.test(throws(() => assertParsedSomething('<a href="casting123-x">x</a>', 'u')) ?? '')) {
    pass('assertParsedSomething() throws when posting links exist but none parsed (markup changed)');
  } else {
    fail('posting links with zero parsed rows must throw');
  }
  if (/blocked or the page changed/.test(throws(() => assertParsedSomething('<html>Just a moment...</html>', 'u')) ?? '')) {
    pass('assertParsedSomething() throws on a page that is not the listing (a block page)');
  } else {
    fail('a block page must not read as an empty board');
  }
  if (throws(() => assertParsedSomething(`<html>${FACETS}<ul></ul></html>`, 'u')) === null) {
    pass('assertParsedSomething() allows a well-formed listing page with no postings');
  } else {
    fail('an empty filtered board must be allowed');
  }

  // ── fetch() ──
  /** @type {{url: string, opts: any}[]} */
  const seen = [];
  const ctx = {
    fetchText: async (url, opts) => { seen.push({ url, opts }); return PAGE; },
    sleep: async () => {},
  };
  const out = await provider.fetch({ provider: 'alternativateatral', location: 'Argentina' }, ctx);
  if (out.length === 4) pass('fetch() normalizes the listing page');
  else fail(`fetch() returned ${out.length}`);
  if (seen.length === 1) pass('fetch() issues exactly ONE request per scan (robots.txt Crawl-delay: 600), however long the board');
  else fail(`fetch() issued ${seen.length} requests`);
  if (seen.every((r) => r.opts && r.opts.redirect === 'error')) pass('fetch() passes redirect:error on every request');
  else fail(`redirect drift: ${JSON.stringify(seen.map((r) => r.opts))}`);

  // The health probe asks for one page; a one-request provider owes the same single call.
  seen.length = 0;
  await provider.fetch({ provider: 'alternativateatral' }, { ...ctx, maxPages: 1 });
  if (seen.length === 1) pass('fetch() under ctx.maxPages:1 still issues exactly one list request');
  else fail(`probe issued ${seen.length} requests`);

  // A ctx.fetch* rejection while probing propagates UNWRAPPED, so verify-portals can
  // recognize ProbePageBudgetReached by identity.
  class ProbeStop extends Error {}
  const stop = new ProbeStop('budget');
  let caught = null;
  try {
    await provider.fetch({ provider: 'alternativateatral' }, { maxPages: 1, sleep: async () => {}, fetchText: async () => { throw stop; } });
  } catch (e) { caught = e; }
  if (caught === stop) pass('fetch() propagates a ctx.fetchText rejection unwrapped while probing');
  else fail(`rejection was swallowed or rewrapped: ${caught && caught.message}`);

  // The filters shape the request.
  seen.length = 0;
  await provider.fetch({ provider: 'alternativateatral', pais: 1, tipo: 2 }, ctx);
  if (seen[0].url === 'https://www.alternativateatral.com/convocatorias.php?pais=1&tipo=2') pass('fetch() requests the filtered listing URL');
  else fail(`filtered URL drift: ${seen[0].url}`);

  // An invalid filter throws BEFORE any network call.
  seen.length = 0;
  let guarded = false;
  try { await provider.fetch({ provider: 'alternativateatral', pais: '1&evil=1' }, ctx); } catch { guarded = true; }
  if (guarded && seen.length === 0) pass('fetch() rejects an invalid filter before making any request');
  else fail(`invalid filter reached the network: ${seen.length} request(s)`);

  // Empty vs broken at the fetch() level.
  const emptyBoard = await provider.fetch({ provider: 'alternativateatral', tipo: 1 }, { ...ctx, fetchText: async () => `<html>${FACETS}<ul></ul></html>` });
  if (Array.isArray(emptyBoard) && emptyBoard.length === 0) pass('fetch() returns [] for a well-formed listing with no postings');
  else fail('empty board must return []');

  let markup = null;
  try {
    await provider.fetch({ provider: 'alternativateatral' }, { ...ctx, fetchText: async () => '<a href="casting555-new-markup">New</a>' });
  } catch (e) { markup = String(e && e.message); }
  if (markup && /markup changed/.test(markup)) pass('fetch() throws when posting links are present but unparseable');
  else fail('a markup change must surface as an error, not an empty board');

  let blocked = null;
  try {
    await provider.fetch({ provider: 'alternativateatral' }, { ...ctx, fetchText: async () => '<html><title>Just a moment...</title></html>' });
  } catch (e) { blocked = String(e && e.message); }
  if (blocked && /blocked or the page changed/.test(blocked)) pass('fetch() throws on a challenge/block page instead of reporting no postings');
  else fail('a block page must surface as an error');
} catch (error) {
  fail(`alternativateatral provider tests could not run: ${error.message}`);
}
