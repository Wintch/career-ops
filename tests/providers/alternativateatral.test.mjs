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

  // ── Candidate fit (edad / genero): explicit title mismatches only ──
  const { parseCastingProfile, fitsCandidate, readCandidate, isDetailUrl, parseCastingDetail, fetchCastingDetail } = mod;
  const man42 = { edad: 42, genero: 'hombre' };
  const cases = [
    ['Se busca actor de 40 a 50 años para cortometraje', true],
    ['Se busca actor y actriz de 40 a 50 años para corto', true],
    ['Se busca actor mayor de 30 años para corto', true],
    ['Se buscan hombres mayores de 50 años para proyecto fotográfico', false],
    ['Se buscan actores de 18 a 26 años para obra', false],
    ['Se buscan actrices de 38 a 47 años para proyecto', false],
    ['Se busca actriz de 38 a 47 años', false],
    ['Se busca voz femenina para película', false],
    ['Se buscan actores y actrices de 30 años para corto', false],
    ['Se busca actriz que aparente 18 años', false],
    ['Se buscan menores de 30 años', false],
    ['Se busca baterista para banda pop-rock', true],
    ['Se buscan animadores para fiestas infantiles', true],
    ['Se busca actor y actrices para cortometraje universitario', true],
  ];
  for (const [title, want] of cases) {
    if (fitsCandidate(title, man42) === want) pass(`fitsCandidate(42, hombre): ${want ? 'keeps' : 'drops'} "${title}"`);
    else fail(`fitsCandidate drift for "${title}" (wanted ${want})`);
  }
  if (fitsCandidate('Se buscan actrices de 20 a 25 años', {}) === true) pass('fitsCandidate(): no candidate keys → nothing is filtered');
  else fail('an empty candidate must keep everything');
  const prof = parseCastingProfile('Se buscan actores y actrices de 20 a 25 años');
  if (prof.age?.min === 20 && prof.age?.max === 25 && prof.genders.join() === 'hombre,mujer') pass('parseCastingProfile(): range and both genders');
  else fail(`profile drift: ${JSON.stringify(prof)}`);

  for (const bad of [{ edad: 13 }, { edad: 100 }, { edad: '42' }, { edad: 4.2 }, { genero: 'x' }]) {
    let threw = false;
    try { readCandidate(bad); } catch { threw = true; }
    if (threw) pass(`readCandidate() rejects ${JSON.stringify(bad)}`);
    else fail(`readCandidate() accepted ${JSON.stringify(bad)}`);
  }
  if (provider.detect({ provider: 'alternativateatral', edad: 'x' }) === null) pass('detect() returns null on an invalid edad');
  else fail('detect() accepted an invalid edad');

  const fitted = await provider.fetch({ provider: 'alternativateatral', ...man42 }, {
    ...ctx,
    fetchText: async () => `<html>${FACETS}<ul>`
      + ROW('adhonorem', 'casting1-actor-40-50', '01/10/2026 - Se busca actor de 40 a 50 años')
      + ROW('adhonorem', 'casting2-actrices', '01/10/2026 - Se buscan actrices de 20 a 25 años')
      + ROW('remunerado', 'casting3-bajista', '01/10/2026 - Se busca bajista')
      + `</ul></html>`,
  });
  if (fitted.length === 2 && fitted[0].description.includes('Edad pedida: 40-50 años') && fitted[1].title === 'Se busca bajista') {
    pass('fetch() drops explicit mismatches, notes the stated age range, keeps titles that say nothing');
  } else {
    fail(`fit filter drift: ${JSON.stringify(fitted)}`);
  }

  // ── Detail page ──
  if (isDetailUrl('https://www.alternativateatral.com/casting268535-actor-de-40-a-50-anos-para-cortometraje')
      && !isDetailUrl('https://www.alternativateatral.com/i_convocatoria.asp?id=1')
      && !isDetailUrl('https://evil.example/casting1')
      && !isDetailUrl('http://www.alternativateatral.com/casting1')) {
    pass('isDetailUrl(): only https casting pages on the board host');
  } else {
    fail('isDetailUrl accepted an unexpected URL');
  }
  const DETAIL = `<html><body><div class="izquierda"><ul><li><a href="mailto:Casting@Example.com">Enviar e-mail</a></li></ul>`
    + `<h1 id="nombre" codigo="1">Se busca actor de 40 a 50 años</h1>`
    + `<div class="descripcion">Persona que actúe como padre.<br>Con barba.</div>`
    + `<ul class="detalle"><li id="contactar"><svg></svg>casting@example.com</li>`
    + `<li><b>Rubros</b><ul><li><a href="x">Personas</a></li></ul></li>`
    + `<li><b>Tipo de Remuneración</b><span>No remunerado</span></li>`
    + `<li><b>Vencimiento</b><span>09/10/2026</span></li></ul></div></body></html>`;
  const d = parseCastingDetail(DETAIL);
  if (d.title.startsWith('Se busca actor') && d.description.includes('Con barba') && d.emails.join() === 'casting@example.com'
      && d.contact === 'casting@example.com' && d.deadline === '09/10/2026' && d.remuneration === 'No remunerado') {
    pass('parseCastingDetail(): title, description, contact, lower-cased email, deadline, remuneration');
  } else {
    fail(`detail drift: ${JSON.stringify(d)}`);
  }
  let notDetail = false;
  try { parseCastingDetail('<html><title>Just a moment...</title></html>'); } catch { notDetail = true; }
  if (notDetail) pass('parseCastingDetail() throws on a page that is not a casting page');
  else fail('a block page parsed as a casting');
  let refused = false;
  try { await fetchCastingDetail('https://evil.example/casting1', ctx); } catch { refused = true; }
  if (refused && seen.length === 0) pass('fetchCastingDetail() refuses a foreign URL before any request');
  else fail('fetchCastingDetail reached the network for a foreign URL');
} catch (error) {
  fail(`alternativateatral provider tests could not run: ${error.message}`);
}
