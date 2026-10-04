// tests/providers/computrabajo.test.mjs — provider-contract tests for the
// Computrabajo country boards (providers/computrabajo.mjs).
//
// The fixtures reproduce shapes measured on the live boards on 2026-10-04, and
// each one exists because it decides the parser's design:
//
//   - a posting is an <article class="box_offer"> card; the EMPLOYER line and
//     the LOCATION line are both `fs16` paragraphs, and the employer line holds
//     the star rating, so the location must be picked by content, not position;
//   - the title anchor carries a `#lc=…` tracking fragment that must not reach
//     job.url, and only the exact `/ofertas-de-trabajo/oferta-de-trabajo-de-
//     {slug}-{32 hex}` path shape may;
//   - pages hold 20 cards; a shorter page is the source's own last page, and
//     that stop reads the RAW card count, never a count already narrowed;
//   - "posted" is a Spanish relative label ("Ayer", "Hace  3  días" with
//     padding and an entity) or an absolute "25 de septiembre";
//   - an empty query renders the board's own "no hay ofertas" notice, which is
//     [] — a page with a result-count heading but no parsed cards is a markup
//     change and a page that is neither is a block page; both THROW.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — computrabajo');

const hex = (n) => n.toString(16).toUpperCase().padStart(32, '0');

/** One full card, trimmed from the live board; structure preserved. */
const CARD = (n, {
  title = `Ingeniero DevOps ${n}`,
  href = `/ofertas-de-trabajo/oferta-de-trabajo-de-ingeniero-devops-${n}-${hex(n)}#lc=ListOffers-Score4-0`,
  company = 'Acme S.A.',
  location = 'Recoleta, Capital Federal',
  posted = 'Ayer',
  salary = '$ 2.222,00 (Mensual)',
  modality = 'Remoto',
  withCompany = true,
} = {}) => `<article class="box_offer sel " data-id='${hex(n)}' data-blind="false" id="${hex(n)}">
  <h2 class="fs18 fwB prB"><a class="js-o-link fc_base" href="${href}">
    ${title}
  </a></h2>
  <p class="dFlex vm_fx fs16 fc_base mt5">
    <span class="fx_none mr10"><span class="fwB">3,6</span><span class="star"></span></span>
    ${withCompany ? `<a class="fc_base t_ellipsis" href="https://ar.computrabajo.com/empresas/ofertas-de-trabajo-de-acme-83C9" target='_blank' offer-grid-article-company-url>
      ${company}
    </a>` : ''}
  </p>
  ${location ? `<p class="fs16 fc_base mt5"><span class="mr10">
    ${location}
  </span></p>` : ''}
  <div class="fs13 mt15">
    ${salary ? `<span class="dIB mr10"><span class="icon i_salary"></span>
      ${salary}
    </span>` : ''}
    ${modality ? `<span class="dIB mr10"><span class="icon i_home"></span>
      ${modality}
    </span>` : ''}
  </div>
  <p class="fs13 fc_aux mt15">
    ${posted}
  </p>
</article>`;

const PAGE = (cards, total = cards.length) => `<html><head><title>Trabajo de devops | Computrabajo</title></head><body>
<h1 class="title_page"><span class="fwB"> ${total} </span> Ofertas de trabajo de devops </h1>${cards.join('\n')}</body></html>`;

const NO_RESULTS = `<html><head><title>Trabajo de devops | Empleo Computrabajo Uruguay</title></head><body>
<div class="box_border"><p class="fs24 tc pAll30 fwB mbB">¡Ups! Parece que no hay ofertas para el empleo que buscas.<br />¿Probamos de nuevo?</p></div></body></html>`;

const fullPage = (start, size = 20) => PAGE(Array.from({ length: size }, (_, i) => CARD(start + i)), 999);

const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/computrabajo.mjs')).href);
  const provider = mod.default;
  const { slugify, countryFromHost, resolveCountry, resolveKeywords, buildListUrl, parsePostedAt, parseListingPage, assertParsedSomething, visibleText } = mod;

  if (provider.id === 'computrabajo') pass('computrabajo.id is "computrabajo"');
  else fail(`computrabajo.id is ${JSON.stringify(provider.id)}`);

  // ── detect(): URL-pattern claim, anchored on the whole host ──
  const d = (e) => provider.detect(e);
  if (d({ careers_url: 'https://mx.computrabajo.com/' })?.url === 'https://mx.computrabajo.com'
      && d({ careers_url: 'https://ar.computrabajo.com/trabajo-de-devops' })?.url === 'https://ar.computrabajo.com'
      && d({ api: 'https://co.computrabajo.com' })?.url === 'https://co.computrabajo.com') {
    pass('detect() claims https://{cc}.computrabajo.com on careers_url or api, whatever the path');
  } else {
    fail('detect() missed a country host');
  }
  const refused = [
    'https://ar.computrabajo.com.evil.example/', 'https://notar.computrabajo.com/', 'https://xx.computrabajo.com/',
    'https://evil.example/ar.computrabajo.com', 'http://ar.computrabajo.com/', 'https://computrabajo.com/', 'not a url', '',
  ];
  if (refused.every((u) => d({ careers_url: u }) === null)) pass('detect() refuses look-alike hosts, unknown countries, plain http and junk');
  else fail(`detect() claimed: ${refused.filter((u) => d({ careers_url: u }) !== null).join(', ')}`);
  if (d(null) === null && d(undefined) === null && d({}) === null && d({ careers_url: 42 }) === null && d({ provider: 'computrabajo', country: 'zz' }) === null) {
    pass('detect() returns null (no throw) on null, missing, non-string and unknown-country input');
  } else {
    fail('detect() threw or claimed junk');
  }
  if (d({ provider: 'computrabajo', country: 'ar' })?.url === 'https://ar.computrabajo.com' && d({ country: 'ar' }) === null) {
    pass('detect(): `country:` counts only with an explicit provider:computrabajo — an unrelated entry with a country key is never claimed');
  } else {
    fail('country-key claim drift');
  }

  // ── helpers ──
  if (countryFromHost('AR.Computrabajo.com') === 'ar' && countryFromHost('ar.computrabajo.com.evil') === null) pass('countryFromHost(): case-insensitive, whole-host anchored');
  else fail('countryFromHost drift');
  if (slugify('  DevOps / SRE  ') === 'devops-sre' && slugify('Ingeniería de Datos') === 'ingenieria-de-datos' && slugify('') === '' && slugify(5) === '') {
    pass('slugify(): ASCII, accents stripped, punctuation collapsed, non-string → ""');
  } else {
    fail(`slugify drift: ${slugify('  DevOps / SRE  ')} / ${slugify('Ingeniería de Datos')}`);
  }
  const throws = (fn) => { try { fn(); return null; } catch (e) { return String(e && e.message); } };
  if (resolveCountry({ country: ' MX ' }) === 'mx' && resolveCountry({ careers_url: 'https://cl.computrabajo.com/x' }) === 'cl' && resolveCountry({}) === null) {
    pass('resolveCountry(): explicit country wins, else the careers_url host, else null');
  } else {
    fail('resolveCountry drift');
  }
  if (/unknown country/.test(throws(() => resolveCountry({ country: 'ar/../x' })) ?? '')) pass('resolveCountry() throws on a configured unknown country (a typo is loud)');
  else fail('unknown country must throw');
  if (JSON.stringify(resolveKeywords({ searchKeywords: ['DevOps', 'devops', 'SRE'] })) === '["devops","sre"]' && JSON.stringify(resolveKeywords({ searchKeywords: 'Data Engineer' })) === '["data-engineer"]') {
    pass('resolveKeywords(): string or list, slugged and deduped in config order');
  } else {
    fail('resolveKeywords drift');
  }
  if (/set `searchKeywords`/.test(throws(() => resolveKeywords({})) ?? '')
      && /invalid searchKeywords/.test(throws(() => resolveKeywords({ searchKeywords: ['ok', '???'] })) ?? '')
      && /cap is 8/.test(throws(() => resolveKeywords({ searchKeywords: Array.from({ length: 9 }, (_, i) => `k${i}`) })) ?? '')) {
    pass('resolveKeywords() throws on none, on an unusable keyword, and above the 8-keyword cap');
  } else {
    fail('resolveKeywords guards drift');
  }
  if (buildListUrl('ar', 'devops', '', 1) === 'https://ar.computrabajo.com/trabajo-de-devops'
      && buildListUrl('mx', 'devops', 'ciudad-de-mexico', 3) === 'https://mx.computrabajo.com/trabajo-de-devops-en-ciudad-de-mexico?p=3') {
    pass('buildListUrl(): /trabajo-de-{kw}[-en-{loc}] with ?p=N from page 2');
  } else {
    fail('buildListUrl drift');
  }

  // ── parsePostedAt(): Spanish labels, never invented ──
  const day = 86_400_000;
  if (parsePostedAt('Hoy', NOW) === NOW && parsePostedAt('Ayer', NOW) === NOW - day
      && parsePostedAt('Hace  3  días', NOW) === NOW - 3 * day && parsePostedAt('Hace 2 semanas', NOW) === NOW - 14 * day
      && parsePostedAt('hace 5 horas', NOW) === NOW - 5 * 3_600_000 && parsePostedAt('Hace 1 mes', NOW) === NOW - 30 * day) {
    pass('parsePostedAt(): hoy / ayer / hace N (horas, días, semanas, mes) relative to now');
  } else {
    fail('relative parsePostedAt drift');
  }
  if (parsePostedAt('25 de septiembre', NOW) === Date.UTC(2026, 8, 25)
      && parsePostedAt('3 de diciembre', NOW) === Date.UTC(2025, 11, 3)) {
    pass('parsePostedAt(): "25 de septiembre" is this year; a month still ahead of today is last year');
  } else {
    fail(`absolute parsePostedAt drift: ${parsePostedAt('25 de septiembre', NOW)} / ${parsePostedAt('3 de diciembre', NOW)}`);
  }
  if (parsePostedAt('31 de febrero', NOW) === undefined && parsePostedAt('algun dia', NOW) === undefined
      && parsePostedAt('', NOW) === undefined && parsePostedAt(undefined, NOW) === undefined) {
    pass('parsePostedAt(): impossible dates and unrecognized labels → undefined');
  } else {
    fail('parsePostedAt must not invent dates');
  }

  // ── parseListingPage() ──
  const page = PAGE([
    CARD(1, { title: 'Back &amp; Front Dev', posted: 'Hace  3  d&#xED;as' }),
    CARD(2, { withCompany: false, location: '', salary: '', modality: '', posted: '25 de septiembre' }),
    CARD(3, { href: '//evil.example/ofertas-de-trabajo/oferta-de-trabajo-de-x-1-' + hex(3) }),
    CARD(4, { href: '/ofertas-de-trabajo/oferta-de-trabajo-de-../../admin-' + hex(4) }),
    CARD(5, { href: 'https://evil.example/ofertas-de-trabajo/oferta-de-trabajo-de-x-5-' + hex(5) }),
    CARD(1, { title: 'Back &amp; Front Dev (dup)' }),
  ]);
  const { jobs, rawCards } = parseListingPage(page, 'ar', NOW);
  if (rawCards === 6 && jobs.length === 2) pass('parseListingPage(): rawCards counts what the source returned (6); hostile hrefs dropped, repeat deduped (2 kept)');
  else fail(`parse counts drift: raw ${rawCards}, kept ${jobs.length}: ${JSON.stringify(jobs.map((j) => j.url))}`);

  const a = jobs[0];
  if (a && a.title === 'Back & Front Dev'
      && a.url === `https://ar.computrabajo.com/ofertas-de-trabajo/oferta-de-trabajo-de-ingeniero-devops-1-${hex(1)}`
      && a.company === 'Acme S.A.' && a.location === 'Recoleta, Capital Federal'
      && a.description === 'Salario: $ 2.222,00 (Mensual) | Modalidad: Remoto'
      && a.postedAt === NOW - 3 * day) {
    pass('parseListingPage(): decoded title, fragment-free absolute URL, employer, location (not the rating), pay/modality note, postedAt');
  } else {
    fail(`first card drift: ${JSON.stringify(a)}`);
  }
  const b = jobs[1];
  if (b && b.company === '' && b.location === '' && !('description' in b) && b.postedAt === Date.UTC(2026, 8, 25)) {
    pass('parseListingPage(): a card with no employer/location/salary/modality leaves them empty, never borrowed from a neighbour');
  } else {
    fail(`minimal card drift: ${JSON.stringify(b)}`);
  }
  if (parseListingPage('', 'ar').jobs.length === 0 && parseListingPage(undefined, 'ar').rawCards === 0) pass('parseListingPage(): empty/undefined input → no postings');
  else fail('parseListingPage must tolerate empty input');
  if (visibleText('<b>Hola&nbsp;&amp; <i>chau</i></b>') === 'Hola & chau') pass('visibleText(): strips tags and decodes entities once');
  else fail('visibleText drift');

  // ── assertParsedSomething(): quiet query vs markup change vs block page ──
  if (throws(() => assertParsedSomething(NO_RESULTS, 'u')) === null) pass('assertParsedSomething() accepts the board’s own "no hay ofertas" notice');
  else fail('a quiet query must not throw');
  if (/markup changed/.test(throws(() => assertParsedSomething(PAGE([]).replace('<span class="fwB"> 0 </span>', '<span class="fwB"> 38 </span>'), 'u')) ?? '')
      && /markup changed/.test(throws(() => assertParsedSomething(`<a href="/ofertas-de-trabajo/oferta-de-trabajo-de-x-1-${hex(1)}">x</a>`, 'u')) ?? '')) {
    pass('assertParsedSomething() throws when the page reports results (heading count or posting links) but no cards parsed');
  } else {
    fail('a markup change must throw');
  }
  if (/blocked or the page changed/.test(throws(() => assertParsedSomething('<html><title>Just a moment...</title></html>', 'u')) ?? '')) {
    pass('assertParsedSomething() throws on a page that is neither a listing nor "no results" (block page)');
  } else {
    fail('a block page must not read as an empty board');
  }

  // ── fetch() ──
  /** @param {Record<string,string>} map @param {string[]} seen @param {any[]} [optsSeen] */
  const mkCtx = (map, seen, optsSeen = [], extra = {}) => ({
    sleep: async () => {},
    fetchText: async (url, opts) => {
      seen.push(url);
      optsSeen.push(opts);
      return map[url] ?? NO_RESULTS;
    },
    ...extra,
  });
  const ENTRY = { careers_url: 'https://ar.computrabajo.com/', searchKeywords: 'devops' };

  // Pagination + short-page stop on the page-two 18 of a 38-result query.
  {
    const seen = [];
    const out = await provider.fetch(ENTRY, mkCtx({
      'https://ar.computrabajo.com/trabajo-de-devops': fullPage(100, 20),
      'https://ar.computrabajo.com/trabajo-de-devops?p=2': fullPage(200, 18),
      'https://ar.computrabajo.com/trabajo-de-devops?p=3': fullPage(300, 20),
    }, seen));
    if (out.length === 38 && seen.length === 2) pass('fetch() walks pages until a short one (20 + 18) and does not request past it');
    else fail(`pagination drift: ${out.length} jobs, requests ${JSON.stringify(seen)}`);
  }

  // The short-page stop reads the RAW count: a full page with one unusable card keeps walking.
  {
    const seen = [];
    const cards = Array.from({ length: 20 }, (_, i) => (i === 3 ? CARD(150 + i, { href: '/nope' }) : CARD(150 + i)));
    const out = await provider.fetch(ENTRY, mkCtx({
      'https://ar.computrabajo.com/trabajo-de-devops': PAGE(cards, 999),
      'https://ar.computrabajo.com/trabajo-de-devops?p=2': fullPage(400, 3),
    }, seen));
    if (seen.length === 2 && out.length === 22) pass('fetch(): the short-page stop uses the source’s raw card count, so one bad card does not end the walk early');
    else fail(`raw-count stop drift: ${out.length} jobs, ${seen.length} requests`);
  }

  // Own ceiling: DEFAULT_MAX_PAGES when the entry sets none, MAX_PAGES_CAP above it, whatever the source claims.
  {
    const origWarn = console.warn;
    const warns = [];
    console.warn = (...args) => warns.push(args.join(' '));
    try {
      const seen = [];
      const endless = (n) => ({ sleep: async () => {}, fetchText: async (url) => { seen.push(url); const p = Number(new URL(url).searchParams.get('p') || '1'); return fullPage(p * 1000 + n * 100000); } });
      await provider.fetch(ENTRY, endless(1));
      const defaultStop = seen.length;
      const warnedDefault = warns.some((w) => /raise max_pages/.test(w));
      seen.length = 0;
      await provider.fetch({ ...ENTRY, max_pages: 999 }, endless(2));
      const capStop = seen.length;
      if (defaultStop === 5 && capStop === 25) pass('fetch() stops at its own ceilings: 5 pages by default, 25 for any max_pages, however many full pages the board has');
      else fail(`ceiling drift: default ${defaultStop}, capped ${capStop}`);
      if (warnedDefault) pass('fetch() warns "raise max_pages" when its own ceiling truncated a full-page walk');
      else fail('truncation by the page ceiling must warn');
    } finally {
      console.warn = origWarn;
    }
  }

  // Probe cooperation: ctx.maxPages:1 → one request, first keyword only.
  {
    const seen = [];
    await provider.fetch({ ...ENTRY, searchKeywords: ['devops', 'sre', 'sysadmin'] }, mkCtx({ 'https://ar.computrabajo.com/trabajo-de-devops': fullPage(1, 20) }, seen, [], { maxPages: 1 }));
    if (seen.length === 1 && seen[0] === 'https://ar.computrabajo.com/trabajo-de-devops') pass('fetch() under ctx.maxPages:1 issues exactly one list request (first keyword, first page)');
    else fail(`probe issued ${JSON.stringify(seen)}`);
  }

  // A ctx.fetchText rejection while probing is not swallowed or rewrapped.
  {
    class ProbeStop extends Error {}
    const stop = new ProbeStop('budget');
    let caught = null;
    try { await provider.fetch(ENTRY, { maxPages: 1, sleep: async () => {}, fetchText: async () => { throw stop; } }); } catch (e) { caught = e; }
    if (caught === stop) pass('fetch() propagates a ctx.fetchText rejection unwrapped while probing');
    else fail(`rejection rewrapped: ${caught && caught.message}`);
  }

  // Keyword fan-out: separate passes, cross-pass dedup, location slug, pacing.
  {
    const seen = [];
    const sleeps = [];
    const same = fullPage(500, 5);
    const ctx = {
      sleep: async (ms) => { sleeps.push(ms); },
      fetchText: async (url) => { seen.push(url); return same; },
    };
    const out = await provider.fetch({ ...ENTRY, searchKeywords: ['devops', 'SRE'], searchLocation: 'Capital Federal' }, ctx);
    if (JSON.stringify(seen) === JSON.stringify([
      'https://ar.computrabajo.com/trabajo-de-devops-en-capital-federal',
      'https://ar.computrabajo.com/trabajo-de-sre-en-capital-federal',
    ]) && out.length === 5) {
      pass('fetch() runs one pass per keyword with the location slug, and a posting returned by two passes is kept once');
    } else {
      fail(`fan-out drift: ${JSON.stringify(seen)} → ${out.length}`);
    }
    if (sleeps.length === 1 && sleeps[0] >= 1500) pass('fetch() waits 1.5 s between requests (and not before the first)');
    else fail(`pacing drift: ${JSON.stringify(sleeps)}`);
  }

  // SSRF/redirect: every request refuses redirects; the origin is rebuilt from the allowlist, not the config.
  {
    const seen = [];
    const optsSeen = [];
    await provider.fetch({ careers_url: 'https://ar.computrabajo.com:8443/some/path?x=1#y', searchKeywords: 'devops' }, mkCtx({}, seen, optsSeen));
    if (seen.every((u) => u.startsWith('https://ar.computrabajo.com/trabajo-de-')) && optsSeen.every((o) => o && o.redirect === 'error')) {
      pass('fetch() rebuilds https://{cc}.computrabajo.com itself (config path/port discarded) and passes redirect:error on every request');
    } else {
      fail(`origin/redirect drift: ${JSON.stringify(seen)} ${JSON.stringify(optsSeen)}`);
    }
  }

  // Config errors surface BEFORE any network call.
  for (const [label, entry] of [
    ['no country', { searchKeywords: 'devops' }],
    ['unknown country', { country: 'zz', searchKeywords: 'devops' }],
    ['no keywords', { careers_url: 'https://ar.computrabajo.com/' }],
    ['unusable location', { ...ENTRY, searchLocation: '???' }],
  ]) {
    const seen = [];
    let threw = false;
    try { await provider.fetch(entry, mkCtx({}, seen)); } catch { threw = true; }
    if (threw && seen.length === 0) pass(`fetch() rejects ${label} before making any request`);
    else fail(`${label} reached the network (${seen.length} request(s)) or did not throw`);
  }

  // Empty vs broken at the fetch() level.
  {
    const empty = await provider.fetch(ENTRY, mkCtx({}, []));
    if (Array.isArray(empty) && empty.length === 0) pass('fetch() returns [] for the board’s own "no hay ofertas" page');
    else fail('empty board must return []');

    let markup = null;
    try { await provider.fetch(ENTRY, mkCtx({ 'https://ar.computrabajo.com/trabajo-de-devops': PAGE([]).replace('<span class="fwB"> 0 </span>', '<span class="fwB"> 38 </span>') }, [])); } catch (e) { markup = String(e && e.message); }
    if (markup && /markup changed/.test(markup)) pass('fetch() throws when page 1 reports results but no card parses');
    else fail('a markup change must surface as an error');

    let cardsNoLinks = null;
    try { await provider.fetch(ENTRY, mkCtx({ 'https://ar.computrabajo.com/trabajo-de-devops': PAGE([CARD(9, { href: '/changed/shape' })]) }, [])); } catch (e) { cardsNoLinks = String(e && e.message); }
    if (cardsNoLinks && /none carried a valid posting link/.test(cardsNoLinks)) pass('fetch() throws when cards are present but none carries a valid posting link');
    else fail('cards without valid links must surface as an error');

    let blocked = null;
    try { await provider.fetch(ENTRY, mkCtx({ 'https://ar.computrabajo.com/trabajo-de-devops': '<html><title>Just a moment...</title></html>' }, [])); } catch (e) { blocked = String(e && e.message); }
    if (blocked && /blocked or the page changed/.test(blocked)) pass('fetch() throws on a block page instead of reporting no postings');
    else fail('a block page must surface as an error');
  }
} catch (error) {
  fail(`computrabajo provider tests could not run: ${error.message}`);
}
