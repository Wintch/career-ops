// tests/scan-navent.test.mjs — tests for scan-navent.mjs, the standalone
// Playwright scanner for Bumeran and ZonaJobs (client-rendered boards that no
// providers/*.mjs module can read).
//
// No browser is launched: the page-facing steps take a page-like object, so the
// stubs below stand in for Playwright. The fixtures reproduce shapes measured on
// the live boards on 2026-10-04:
//
//   - the page's own results call is `POST /api/avisos/searchV2` and answers
//     `{ content: [...], total, size, number }`, 20 rows per page, each with
//     `id`, `titulo`, `detalle`, `empresa`, `confidencial`, `localizacion`,
//     `modalidadTrabajo` and a `DD-MM-YYYY HH:mm:ss` publication time;
//   - the rendered result links are `/empleos/{slug}-{id}.html`;
//   - robots.txt disallows `/*recientes=true`, `/*?localidades=*` and
//     `/empleos-busquedaext-`, none of which the scanner may request;
//   - this scanner is a light-touch, no-bypass tool: a challenge or refusal
//     STOPS the run, it is never solved or retried around.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nScanner — scan-navent');

const ROBOTS = `User-agent: *
Disallow: /*recientes=true
Disallow: /*relevantes=true
Disallow: /empleos.html/111
Disallow: /empleos-busquedaext-
Disallow: /*?localidades=*
Disallow: /*&localidades=*

Sitemap: https://www.bumeran.com.ar/sitemap_avisos_bum.xml
`;

const ROW = (id, extra = {}) => ({
  id,
  titulo: `Ingeniero DevOps ${id}`,
  detalle: 'Descripcion del puesto.',
  empresa: 'Acme S.A.',
  confidencial: false,
  localizacion: 'Capital Federal, Buenos Aires',
  modalidadTrabajo: 'Remoto',
  fechaHoraPublicacion: '14-09-2026 10:51:03',
  fechaPublicacion: '14-09-2026',
  ...extra,
});

const throwsMsg = (fn) => { try { fn(); return null; } catch (e) { return String(e && e.message); } };
const rejectsMsg = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

try {
  const mod = await import(pathToFileURL(join(ROOT, 'scan-navent.mjs')).href);
  const {
    SITES, PAGE_SIZE, DEFAULT_MAX_PAGES, MAX_PAGES_CAP, MAX_KEYWORDS, MAX_NAVIGATIONS, NAV_DELAY_MS,
    slugifyKeyword, buildSearchUrl, resolveSearches, parseRobots, isAllowedByRobots, detectChallenge,
    parsePublished, parseSearchResponse, loadSearchPage, runSearch, ChallengeError,
  } = mod;

  // Importing must never open a browser or touch the pipeline (the main-module guard).
  pass('importing scan-navent.mjs has no side effects (main-module guard)');

  // ── limits are the light-touch contract ──
  if (NAV_DELAY_MS >= 5000 && MAX_NAVIGATIONS <= 40 && MAX_PAGES_CAP <= 5 && MAX_KEYWORDS <= 8 && DEFAULT_MAX_PAGES <= 2 && PAGE_SIZE === 20) {
    pass('limits: >=5 s between navigations, <=40 navigations per run, <=5 pages and <=8 keywords per search');
  } else {
    fail('light-touch limits drifted');
  }
  if (SITES.bumeran.host === 'www.bumeran.com.ar' && SITES.zonajobs.host === 'www.zonajobs.com.ar') pass('SITES: two fixed literal hosts');
  else fail('SITES drift');

  // ── slugifyKeyword / buildSearchUrl ──
  if (slugifyKeyword('  DevOps / SRE ') === 'devops-sre' && slugifyKeyword('Ingeniería de Datos') === 'ingenieria-de-datos'
      && slugifyKeyword('') === '' && slugifyKeyword(7) === '') {
    pass('slugifyKeyword(): ASCII, accents stripped, punctuation collapsed, junk → ""');
  } else {
    fail('slugifyKeyword drift');
  }
  if (buildSearchUrl('bumeran', 'devops', 1) === 'https://www.bumeran.com.ar/empleos-busqueda-devops.html'
      && buildSearchUrl('zonajobs', 'devops', 3) === 'https://www.zonajobs.com.ar/empleos-busqueda-devops.html?page=3') {
    pass('buildSearchUrl(): /empleos-busqueda-{slug}.html with ?page=N from page 2, host from the fixed table');
  } else {
    fail('buildSearchUrl drift');
  }
  if (/unknown site/.test(throwsMsg(() => buildSearchUrl('evil.example', 'x', 1)) ?? '')) pass('buildSearchUrl() refuses a site that is not in the table');
  else fail('unknown site must throw');

  // ── resolveSearches() ──
  const r = resolveSearches([{ site: ' Bumeran ', keywords: ['DevOps', 'devops', 'SRE'], max_pages: 99 }, { site: 'zonajobs', query: 'Data Engineer' }]);
  if (r.length === 2 && r[0].site === 'bumeran' && JSON.stringify(r[0].keywords) === '["devops","sre"]' && r[0].maxPages === MAX_PAGES_CAP
      && r[1].site === 'zonajobs' && JSON.stringify(r[1].keywords) === '["data-engineer"]' && r[1].maxPages === DEFAULT_MAX_PAGES) {
    pass('resolveSearches(): normalizes site, slugs and dedupes keywords, clamps max_pages to the cap, defaults to 2');
  } else {
    fail(`resolveSearches drift: ${JSON.stringify(r)}`);
  }
  const bad = [
    [undefined, /no `navent_searches`/], [[], /no `navent_searches`/], [['x'], /must be a mapping/],
    [[{ site: 'evil', keywords: ['a'] }], /expected one of/], [[{ site: 'bumeran' }], /needs `keywords`/],
    [[{ site: 'bumeran', keywords: ['???'] }], /unusable keyword/],
    [[{ site: 'bumeran', keywords: Array.from({ length: 9 }, (_, i) => `k${i}`) }], /cap is 8/],
  ];
  if (bad.every(([input, re]) => re.test(throwsMsg(() => resolveSearches(input)) ?? ''))) pass('resolveSearches() throws a named error for no config, bad site, no/unusable keywords and >8 keywords');
  else fail('resolveSearches guards drift');

  // ── robots.txt: read on every run, honoured per path ──
  const allowed = (p) => isAllowedByRobots(ROBOTS, p);
  if (allowed('/empleos-busqueda-devops.html') && allowed('/empleos-busqueda-devops.html?page=2')) pass('isAllowedByRobots(): the search paths the scanner requests are allowed');
  else fail('the scanner’s own paths must be allowed by the real robots.txt');
  if (!allowed('/empleos-busqueda-devops.html?recientes=true') && !allowed('/empleos-busquedaext-devops') && !allowed('/empleos-busqueda-devops.html?localidades=5')
      && !allowed('/empleos-busqueda-devops.html?x=1&localidades=5') && !allowed('/empleos.html/111')) {
    pass('isAllowedByRobots(): wildcard and prefix Disallow rules (recientes=true, busquedaext, localidades, /111) are honoured');
  } else {
    fail('a disallowed path was allowed');
  }
  if (isAllowedByRobots('', '/anything') && isAllowedByRobots('User-agent: Googlebot\nDisallow: /', '/anything')) pass('isAllowedByRobots(): no robots / no applicable group → allowed');
  else fail('no applicable rules must allow');
  const grp = 'User-agent: *\nDisallow: /\n\nUser-agent: career-ops\nAllow: /\nDisallow: /private\n';
  if (isAllowedByRobots(grp, '/open') && !isAllowedByRobots(grp, '/private/x')) pass('isAllowedByRobots(): a group naming career-ops overrides the * group');
  else fail('own-agent group not preferred');
  const tie = 'User-agent: *\nDisallow: /a\nAllow: /a\n';
  const longer = 'User-agent: *\nDisallow: /a\nAllow: /a/b\n';
  if (isAllowedByRobots(tie, '/a') && isAllowedByRobots(longer, '/a/b/c') && !isAllowedByRobots(longer, '/a/x')) pass('isAllowedByRobots(): longest pattern wins, Allow wins a tie');
  else fail('precedence drift');
  if (isAllowedByRobots('User-agent: *\nDisallow: /*.pdf$', '/x.html') && !isAllowedByRobots('User-agent: *\nDisallow: /*.pdf$', '/x.pdf')
      && parseRobots('# only a comment\n').length === 0) {
    pass('parseRobots()/isAllowedByRobots(): `$` anchors, comments ignored');
  } else {
    fail('anchor/comment handling drift');
  }

  // ── detectChallenge(): named, never worked around ──
  if (detectChallenge({ status: 403 }) === 'HTTP 403' && detectChallenge({ status: 429 }) === 'HTTP 429' && detectChallenge({ status: 503 }) === 'HTTP 503') {
    pass('detectChallenge(): 403, 429 and 503 are refusals');
  } else {
    fail('refusal statuses not detected');
  }
  if (/Just a moment/i.test(detectChallenge({ status: 200, title: 'Just a moment...' }) ?? '')
      && detectChallenge({ text: 'Please verify you are human' }) && detectChallenge({ text: 'Enable JavaScript and cookies to continue' })
      && detectChallenge({ text: 'Attention Required! | Cloudflare' })) {
    pass('detectChallenge(): Cloudflare/CAPTCHA interstitial text is recognized from the title or the body');
  } else {
    fail('challenge text not recognized');
  }
  if (detectChallenge({ status: 200, title: 'Trabajo de devops | Bumeran', text: 'Buscar empleo por puesto o palabra clave' }) === null
      && detectChallenge() === null) {
    pass('detectChallenge(): a normal search page is not a challenge');
  } else {
    fail('false positive on a normal page');
  }

  // ── parsePublished(): Argentina wall clock (UTC-3), NaN-safe ──
  if (parsePublished('14-09-2026 10:51:03') === Date.UTC(2026, 8, 14, 13, 51, 3)
      && parsePublished('', '14-09-2026') === Date.UTC(2026, 8, 14, 3, 0, 0)
      && parsePublished('01-10-2026 11:41:25', '01-10-2026') === Date.UTC(2026, 9, 1, 14, 41, 25)) {
    pass('parsePublished(): DD-MM-YYYY HH:mm:ss at UTC-3, date-only fallback, dateTime preferred');
  } else {
    fail(`parsePublished drift: ${parsePublished('14-09-2026 10:51:03')}`);
  }
  if (parsePublished('31-02-2026 10:00:00') === undefined && parsePublished('x') === undefined && parsePublished(null, null) === undefined
      && parsePublished('14-13-2026') === undefined && parsePublished('14-09-2026 25:00:00') === undefined) {
    pass('parsePublished(): impossible dates and junk → undefined (never invented)');
  } else {
    fail('parsePublished must not invent dates');
  }

  // ── parseSearchResponse() ──
  const hrefs = new Map([['101', '/empleos/ingeniero-devops-acme-101.html']]);
  const parsed = parseSearchResponse({ content: [ROW(101), ROW(102, { titulo: 'Back &amp; Front', confidencial: true, modalidadTrabajo: '', detalle: '' })], total: 2 }, { site: 'bumeran', hrefById: hrefs });
  const a = parsed[0];
  if (a && a.title === 'Ingeniero DevOps 101' && a.url === 'https://www.bumeran.com.ar/empleos/ingeniero-devops-acme-101.html'
      && a.company === 'Acme S.A.' && a.location === 'Capital Federal, Buenos Aires (Remoto)' && a.source === 'bumeran'
      && a.description === 'Descripcion del puesto.' && a.postedAt === Date.UTC(2026, 8, 14, 13, 51, 3)) {
    pass('parseSearchResponse(): title, the page-rendered URL, employer, location (modality), description, source and publication time');
  } else {
    fail(`first row drift: ${JSON.stringify(a)}`);
  }
  const b = parsed[1];
  if (b && b.title === 'Back & Front' && b.company === '?' && b.url === 'https://www.bumeran.com.ar/empleos/back-front-102.html'
      && b.location === 'Capital Federal, Buenos Aires' && !('description' in b)) {
    pass('parseSearchResponse(): a confidential employer is "?", the URL falls back to slug+id, entities decoded, empty description omitted');
  } else {
    fail(`second row drift: ${JSON.stringify(b)}`);
  }
  // Only the exact /empleos/…-{id}.html shape from the page may become job.url.
  const hostile = new Map([['103', '//evil.example/empleos/x-103.html'], ['104', '/empleos/../admin-104.html'], ['105', 'https://evil.example/empleos/x-105.html']]);
  const safe = parseSearchResponse({ content: [ROW(103), ROW(104), ROW(105)] }, { site: 'zonajobs', hrefById: hostile });
  if (safe.length === 3 && safe.every((j) => j.url.startsWith('https://www.zonajobs.com.ar/empleos/') && !j.url.includes('evil.example') && !j.url.includes('..'))) {
    pass('parseSearchResponse(): rendered hrefs outside the /empleos/{slug}-{id}.html shape never reach job.url');
  } else {
    fail(`hostile hrefs leaked: ${JSON.stringify(safe.map((j) => j.url))}`);
  }
  const junk = parseSearchResponse({ content: [null, 'x', { id: 'abc', titulo: 'T' }, { id: 7 }, ROW(106), ROW(106)] }, { site: 'bumeran' });
  if (junk.length === 1 && junk[0].url.endsWith('-106.html')) pass('parseSearchResponse(): malformed rows are skipped and a repeated id is kept once');
  else fail(`malformed handling drift: ${JSON.stringify(junk)}`);
  if (parseSearchResponse({ content: [] }, { site: 'bumeran' }).length === 0) pass('parseSearchResponse(): a present-and-empty content[] is a quiet search → []');
  else fail('empty content must return []');
  const envs = [{}, { content: null }, { content: {} }, 'x', null, 5].map((e) => throwsMsg(() => parseSearchResponse(e, { site: 'bumeran' })) ?? '');
  if (envs.every((m) => /unexpected search response/.test(m)) && /got: \[results\]/.test(throwsMsg(() => parseSearchResponse({ results: [] }, { site: 'bumeran' })) ?? '')) {
    pass('parseSearchResponse(): a missing/wrong-typed envelope THROWS and names the keys it got (changed API ≠ empty board)');
  } else {
    fail(`envelope guard drift: ${JSON.stringify(envs)}`);
  }

  // ── page stub: stands in for Playwright ──
  const mkResp = (json, status = 200) => ({ url: () => 'https://www.bumeran.com.ar/api/avisos/searchV2?pageSize=20&page=0&sort=RELEVANTES', request: () => ({ method: () => 'POST' }), status: () => status, json: async () => json });
  /** @param {{json?: any, navStatus?: number, title?: string, text?: string, hrefs?: string[], respond?: boolean, respStatus?: number}} o */
  const mkPage = (o = {}) => {
    const log = { gotos: [], waits: 0 };
    return {
      log,
      goto: async (url) => { log.gotos.push(url); return { status: () => o.navStatus ?? 200 }; },
      waitForResponse: (pred) => {
        log.waits++;
        if (o.respond === false) return Promise.reject(new Error('Timeout 30000ms exceeded.\n  waiting for response'));
        const resp = mkResp(o.json ?? { content: [ROW(201)], total: 1 }, o.respStatus ?? 200);
        return Promise.resolve(pred(resp) ? resp : (() => { throw new Error('predicate'); })());
      },
      title: async () => o.title ?? 'Trabajo de devops | Bumeran',
      evaluate: async (fn) => (/innerText/.test(String(fn)) ? (o.text ?? 'Buscar empleo') : (o.hrefs ?? ['/empleos/ingeniero-devops-acme-201.html', '/empleos/ingeniero-devops-acme-201.html?x=1#y'])),
    };
  };

  // loadSearchPage(): happy path
  {
    const page = mkPage({ json: { content: [ROW(201)], total: 1 } });
    const res = await loadSearchPage(page, 'https://www.bumeran.com.ar/empleos-busqueda-devops.html', { site: 'bumeran' });
    if (res.postings.length === 1 && res.total === 1 && res.postings[0].url === 'https://www.bumeran.com.ar/empleos/ingeniero-devops-acme-201.html' && page.log.gotos.length === 1) {
      pass('loadSearchPage(): reads the response the page itself requested and the links it rendered (tracking fragment/query dropped)');
    } else {
      fail(`loadSearchPage drift: ${JSON.stringify(res)}`);
    }
  }
  // challenge by status / by title / by body / by the results call
  for (const [label, opts] of [
    ['a 403 page', { navStatus: 403 }], ['a Cloudflare title', { title: 'Just a moment...' }],
    ['CAPTCHA text in the body', { text: 'Please complete the CAPTCHA to continue' }], ['a 429 on the results call', { respStatus: 429 }],
  ]) {
    const err = await rejectsMsg(() => loadSearchPage(mkPage(opts), 'https://www.bumeran.com.ar/empleos-busqueda-devops.html', { site: 'bumeran' }));
    if (err instanceof ChallengeError && err.name === 'ChallengeError' && /Bumeran/.test(err.message)) pass(`loadSearchPage() raises ChallengeError on ${label} (named, never worked around)`);
    else fail(`${label} was not a ChallengeError: ${err && err.message}`);
  }
  {
    const err = await rejectsMsg(() => loadSearchPage(mkPage({ respond: false }), 'https://www.zonajobs.com.ar/empleos-busqueda-x.html', { site: 'zonajobs' }));
    if (err && !(err instanceof ChallengeError) && /never made its results request/.test(err.message) && /ZonaJobs/.test(err.message)) pass('loadSearchPage(): no results call and no challenge → a plain named error (page changed), not a ChallengeError');
    else fail(`missing-call handling drift: ${err && err.message}`);
    const err2 = await rejectsMsg(() => loadSearchPage(mkPage({ json: { nope: 1 } }), 'https://www.bumeran.com.ar/empleos-busqueda-x.html', { site: 'bumeran' }));
    if (err2 && /unexpected search response/.test(err2.message)) pass('loadSearchPage(): an unexpected response envelope surfaces as an error');
    else fail('envelope error not surfaced');
  }

  // ── runSearch(): pacing, caps, robots, stop-on-challenge ──
  const full = (start) => ({ content: Array.from({ length: PAGE_SIZE }, (_, i) => ROW(start + i)), total: 999 });
  const short = (start) => ({ content: Array.from({ length: 3 }, (_, i) => ROW(start + i)), total: 23 });
  const mkRunPage = (jsons) => {
    let n = 0;
    const page = mkPage();
    page.waitForResponse = () => Promise.resolve(mkResp(jsons[Math.min(n++, jsons.length - 1)]));
    return page;
  };
  const sleeps = [];
  const deps = (extra = {}) => ({ sleep: async (ms) => { sleeps.push(ms); }, budget: { left: MAX_NAVIGATIONS }, robotsText: ROBOTS, ...extra });

  {
    sleeps.length = 0;
    const page = mkRunPage([full(1000), short(2000)]);
    const out = await runSearch(page, { site: 'bumeran', keywords: ['devops'], maxPages: 5 }, deps());
    if (out.found.length === 23 && page.log.gotos.length === 2 && out.navigations === 2) pass('runSearch(): walks pages until the board’s own short page (20 + 3) and stops');
    else fail(`short-page stop drift: ${out.found.length} found, ${page.log.gotos.length} gotos`);
    if (sleeps.length === 1 && sleeps[0] === NAV_DELAY_MS) pass('runSearch(): waits NAV_DELAY_MS between navigations and not before the first');
    else fail(`pacing drift: ${JSON.stringify(sleeps)}`);
  }
  {
    const page = mkRunPage([full(1)]);
    const out = await runSearch(page, { site: 'bumeran', keywords: ['a', 'b'], maxPages: 2 }, deps());
    if (page.log.gotos.length === 4 && out.navigations === 4) pass('runSearch(): honours max_pages per keyword even when every page is full');
    else fail(`max_pages drift: ${page.log.gotos.length}`);
  }
  {
    const page = mkRunPage([full(1)]);
    const out = await runSearch(page, { site: 'bumeran', keywords: ['a', 'b', 'c'], maxPages: 5 }, deps({ budget: { left: 3 } }));
    if (page.log.gotos.length === 3 && out.errors.some((e) => /navigation cap/.test(e.error))) pass('runSearch(): the per-run navigation budget stops the walk and says so');
    else fail(`budget drift: ${page.log.gotos.length} gotos, ${JSON.stringify(out.errors)}`);
  }
  {
    const page = mkRunPage([short(1)]);
    const out = await runSearch(page, { site: 'bumeran', keywords: ['devops'], maxPages: 2 }, deps({ robotsText: 'User-agent: *\nDisallow: /empleos-busqueda-\n' }));
    if (page.log.gotos.length === 0 && out.errors.some((e) => /robots\.txt disallows/.test(e.error))) pass('runSearch(): a path robots.txt disallows is never navigated to');
    else fail(`robots not honoured: ${page.log.gotos.length} gotos`);
  }
  {
    const page = mkPage({ title: 'Just a moment...' });
    const err = await rejectsMsg(() => runSearch(page, { site: 'bumeran', keywords: ['a', 'b', 'c'], maxPages: 3 }, deps()));
    if (err instanceof ChallengeError && page.log.gotos.length === 1) pass('runSearch(): a challenge propagates and NOTHING further is requested (no retry, no next keyword)');
    else fail(`challenge handling drift: ${err && err.message}, ${page.log.gotos.length} gotos`);
  }
  {
    let calls = 0;
    const page = mkPage();
    page.waitForResponse = () => { calls++; return calls === 1 ? Promise.reject(new Error('Timeout 30000ms exceeded.')) : Promise.resolve(mkResp(short(3000))); };
    const out = await runSearch(page, { site: 'bumeran', keywords: ['a', 'b'], maxPages: 2 }, deps());
    if (out.errors.length === 1 && out.errors[0].keyword === 'a' && out.found.length === 3) pass('runSearch(): an ordinary failure on one keyword is recorded and the next keyword still runs');
    else fail(`per-keyword error handling drift: ${JSON.stringify(out.errors)} / ${out.found.length}`);
  }
} catch (error) {
  fail(`scan-navent tests could not run: ${error.stack || error.message}`);
}
