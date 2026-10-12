// tests/providers/softserve.test.mjs — provider-contract tests for SoftServe's
// careers API (providers/softserve.mjs).
//
// The fixtures reproduce the shape measured on the live API on 2026-10-11:
// `{ data: { vacancies: [...], filters }, links, meta }`, 12 vacancies per
// page, a short last page and an empty `vacancies` array past it. A vacancy
// carries `urlSegment` (the posting page slug), `name`, a `;`-separated `city`
// and `tags` such as "Remote/Office".
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — softserve');

const VACANCY = (n, over = {}) => ({
  id: 90000 + n,
  urlSegment: `senior-devops-engineer-${90000 + n}`,
  name: `Senior DevOps Engineer ${n}`,
  city: 'Ukraine',
  direction: 'Engineering & Technology',
  highlight: `Senior DevOps Engineer ${n}`,
  level: { id: 3, name: 'Senior' },
  tags: [{ id: 'remote', name: 'Remote/Office' }],
  ...over,
});
const PAGE = (vacancies, page = 1, meta = {}) => ({
  data: { vacancies, filters: { en: { filters: { locations: [] } } } },
  links: {},
  meta: { current_page: page, per_page: 12, total: 177, last_page: 15, ...meta },
});
const fullPage = (start, size = 12, page = 1, meta = {}) => PAGE(Array.from({ length: size }, (_, i) => VACANCY(start + i)), page, meta);
const API = (page) => `https://career.softserveinc.com/api/frontend/vacancies?page=${page}`;

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/softserve.mjs')).href);
  const provider = mod.default;
  const { isSoftServeUrl, parseVacanciesPage } = mod;
  const throws = (fn) => { try { fn(); return null; } catch (e) { return String(e && e.message); } };

  if (provider.id === 'softserve') pass('softserve.id is "softserve"');
  else fail(`softserve.id is ${JSON.stringify(provider.id)}`);

  // ── detect() ──
  const d = (e) => provider.detect(e);
  if (d({ careers_url: 'https://career.softserveinc.com/en-us/vacancies/country-ukraine' })?.url === 'https://career.softserveinc.com/en-us/vacancies'
      && d({ careers_url: 'https://career.softserveinc.com/es-mx/vacancies' }) !== null
      && d({ api: 'https://career.softserveinc.com/' }) !== null
      && d({ provider: 'softserve' }) !== null) {
    pass('detect() claims any https career.softserveinc.com URL, whatever country/language page, and provider:softserve');
  } else {
    fail('detect() missed a SoftServe careers URL');
  }
  const refused = ['https://career.softserveinc.com.evil.example/', 'https://softserveinc.com/en-us', 'http://career.softserveinc.com/', 'https://evil.example/career.softserveinc.com', 'not a url', ''];
  if (refused.every((u) => d({ careers_url: u }) === null)) pass('detect() refuses look-alike hosts, the corporate site, plain http and junk');
  else fail(`detect() claimed: ${refused.filter((u) => d({ careers_url: u }) !== null).join(', ')}`);
  if (d(null) === null && d(undefined) === null && d({}) === null && d({ careers_url: 7 }) === null && isSoftServeUrl('https://CAREER.softserveinc.com/x')) {
    pass('detect() returns null (no throw) on null, missing and non-string input; host match is case-insensitive');
  } else {
    fail('detect() threw or claimed junk');
  }

  // ── parseVacanciesPage() ──
  {
    const { jobs, rawCount } = parseVacanciesPage(PAGE([
      VACANCY(1, { city: 'Mexico;  Colombia; Chile', name: '  Lead   Data Engineer ' }),
      VACANCY(2, { city: '', tags: [] }),
      VACANCY(3, { urlSegment: '' }),
      VACANCY(4, { name: null }),
      VACANCY(5, { urlSegment: 'bad-\uD800-segment' }),
      null,
      VACANCY(6, { urlSegment: 'a/b?c' }),
      VACANCY(7, { urlSegment: '..' }),
      VACANCY(8, { urlSegment: ' . ' }),
    ]));
    if (rawCount === 9 && jobs.length === 3) pass('parseVacanciesPage(): rawCount is what the source returned (9); rows with no title, no slug, a dot-segment slug (. or ..) or a lone-surrogate slug dropped (3 kept)');
    else fail(`parse counts drift: raw ${rawCount}, kept ${jobs.length}`);
    const [a, b, c] = jobs;
    if (a?.title === 'Lead Data Engineer' && a.url === 'https://career.softserveinc.com/en-us/vacancies/senior-devops-engineer-90001'
        && a.company === 'SoftServe' && a.location === 'Mexico, Colombia, Chile · Remote/Office' && a.externalId === '90001') {
      pass('parseVacanciesPage(): title, posting URL from urlSegment, company, cities + tags as location, externalId');
    } else {
      fail(`first vacancy drift: ${JSON.stringify(a)}`);
    }
    if (b?.location === '' && c?.url === 'https://career.softserveinc.com/en-us/vacancies/a%2Fb%3Fc') {
      pass('parseVacanciesPage(): an empty city/tags gives an empty location; a slug with / or ? is encoded, not allowed to change the path');
    } else {
      fail(`edge rows drift: ${JSON.stringify([b, c])}`);
    }
  }
  if (parseVacanciesPage(PAGE([])).jobs.length === 0) pass('parseVacanciesPage(): a present-and-empty vacancies[] is an empty board → no postings');
  else fail('an empty vacancies[] must not throw');
  const bad = [null, '', 42, {}, { data: null }, { data: { vacancies: null } }, { data: { vacancies: {} } }, { data: { jobs: [] } }];
  if (bad.every((j) => /expected data\.vacancies\[\]/.test(throws(() => parseVacanciesPage(j)) ?? ''))) {
    pass('parseVacanciesPage() throws, naming what it got, on any envelope that is not data.vacancies[]');
  } else {
    fail(`envelope guard drift: ${bad.filter((j) => !throws(() => parseVacanciesPage(j))).map((j) => JSON.stringify(j)).join(', ')}`);
  }

  // ── fetch() ──
  const mkCtx = (map, seen, optsSeen = [], extra = {}) => ({
    sleep: async () => {},
    fetchJson: async (url, opts) => {
      seen.push(url);
      optsSeen.push(opts);
      return map[url] ?? PAGE([]);
    },
    ...extra,
  });

  {
    const seen = [];
    const optsSeen = [];
    const out = await provider.fetch({ name: 'SoftServe' }, mkCtx({ [API(1)]: fullPage(0), [API(2)]: fullPage(100), [API(3)]: fullPage(200, 9), [API(4)]: fullPage(300) }, seen, optsSeen));
    if (out.length === 33 && seen.length === 3) pass('fetch() walks pages until a short one (12 + 12 + 9) and does not request past it');
    else fail(`pagination drift: ${out.length} jobs, ${JSON.stringify(seen)}`);
    if (optsSeen.every((o) => o && o.redirect === 'error')) pass('fetch() passes redirect:error on every request');
    else fail(`redirect drift: ${JSON.stringify(optsSeen)}`);
  }
  {
    const seen = [];
    const out = await provider.fetch({}, mkCtx({ [API(1)]: fullPage(0), [API(2)]: PAGE([]) }, seen));
    if (out.length === 12 && seen.length === 2) pass('fetch(): an empty page after a full one ends the walk (board size a multiple of 12)');
    else fail(`empty-page stop drift: ${out.length}, ${seen.length}`);
  }
  {
    const seen = [];
    const rows = Array.from({ length: 12 }, (_, i) => (i === 5 ? VACANCY(i, { name: '' }) : VACANCY(i)));
    const out = await provider.fetch({}, mkCtx({ [API(1)]: PAGE(rows), [API(2)]: fullPage(100, 2) }, seen));
    if (seen.length === 2 && out.length === 13) pass('fetch(): the short-page stop uses the raw row count, so one bad row does not end the walk early');
    else fail(`raw-count stop drift: ${out.length} jobs, ${seen.length} requests`);
  }
  {
    const origWarn = console.warn;
    const warns = [];
    console.warn = (...args) => warns.push(args.join(' '));
    try {
      const seen = [];
      const endless = { sleep: async () => {}, fetchJson: async (url) => { seen.push(url); const p = Number(new URL(url).searchParams.get('page')); return fullPage(p * 100, 12, p, { last_page: 500 }); } };
      await provider.fetch({}, endless);
      const defaultStop = seen.length;
      const warned = warns.some((w) => /raise max_pages/.test(w));
      seen.length = 0;
      await provider.fetch({ max_pages: 999 }, endless);
      if (defaultStop === 30 && seen.length === 60) pass('fetch() stops at its own ceilings (30 by default, 60 for any max_pages), whatever meta.last_page says');
      else fail(`ceiling drift: ${defaultStop} / ${seen.length}`);
      if (warned) pass('fetch() warns "raise max_pages" when its own ceiling truncated the walk');
      else fail('truncation must warn');
      warns.length = 0;
      await provider.fetch({}, { ...endless, maxPages: 1 });
      if (!warns.some((w) => /raise max_pages/.test(w))) pass('fetch() does not warn about max_pages when a probe cap stopped it');
      else fail('a probe cap must not read as truncation');
    } finally {
      console.warn = origWarn;
    }
  }
  {
    // meta.last_page ends the walk at an exact boundary, with no truncation warning.
    const origWarn = console.warn;
    const warns = [];
    console.warn = (...args) => warns.push(args.join(' '));
    try {
      const seen = [];
      const m = { last_page: 2 };
      const out = await provider.fetch({ max_pages: 2 }, mkCtx({ [API(1)]: fullPage(0, 12, 1, m), [API(2)]: fullPage(100, 12, 2, m), [API(3)]: fullPage(200) }, seen));
      if (out.length === 24 && seen.length === 2 && warns.length === 0) pass('fetch(): meta.last_page ends the walk at an exact boundary without a max_pages warning');
      else fail(`last_page boundary drift: ${out.length} jobs, ${seen.length} requests, warns ${JSON.stringify(warns)}`);
      seen.length = 0;
      const out2 = await provider.fetch({}, mkCtx({ [API(1)]: fullPage(0, 12, 1, { last_page: 1 }), [API(2)]: fullPage(100) }, seen));
      if (out2.length === 12 && seen.length === 1) pass('fetch(): last_page 1 stops after page 1 even on a full page');
      else fail(`last_page 1 drift: ${seen.length} requests`);
      seen.length = 0;
      const out3 = await provider.fetch({}, mkCtx({ [API(1)]: fullPage(0, 5, 1, { per_page: 5, last_page: 3 }), [API(2)]: fullPage(100, 5, 2, { per_page: 5, last_page: 3 }), [API(3)]: fullPage(200, 3, 3, { per_page: 5, last_page: 3 }) }, seen));
      if (out3.length === 13 && seen.length === 3) pass('fetch(): meta.per_page drives the short-page test (5/page, not a hard-coded 12)');
      else fail(`per_page drift: ${out3.length} jobs, ${seen.length} requests`);
      warns.length = 0;
      seen.length = 0;
      await provider.fetch({ max_pages: 1 }, mkCtx({ [API(1)]: fullPage(0, 12, 1, { last_page: 5 }) }, seen));
      if (warns.some((w) => /raise max_pages/.test(w))) pass('fetch(): max_pages warning still fires when page < meta.last_page');
      else fail('truncation before last_page must warn');
    } finally {
      console.warn = origWarn;
    }
  }
  {
    const seen = [];
    await provider.fetch({}, mkCtx({ [API(1)]: fullPage(0) }, seen, [], { maxPages: 1 }));
    if (seen.length === 1) pass('fetch() under ctx.maxPages:1 issues exactly one list request');
    else fail(`probe issued ${seen.length} requests`);
    class ProbeStop extends Error {}
    const stop = new ProbeStop('budget');
    let caught = null;
    try { await provider.fetch({}, { maxPages: 1, sleep: async () => {}, fetchJson: async () => { throw stop; } }); } catch (e) { caught = e; }
    if (caught === stop) pass('fetch() propagates a ctx.fetchJson rejection unwrapped while probing');
    else fail(`rejection rewrapped: ${caught && caught.message}`);
  }
  {
    const sleeps = [];
    await provider.fetch({}, { sleep: async (ms) => { sleeps.push(ms); }, fetchJson: async (url) => (url === API(1) ? fullPage(0) : fullPage(50, 1)) });
    if (sleeps.length === 1 && sleeps[0] >= 250) pass('fetch() pauses between pages (not before the first)');
    else fail(`pacing drift: ${JSON.stringify(sleeps)}`);
  }
  {
    let msg = null;
    try { await provider.fetch({}, mkCtx({ [API(1)]: { message: 'Server Error' } }, [])); } catch (e) { msg = String(e && e.message); }
    if (msg && /expected data\.vacancies\[\], got: \[message\]/.test(msg)) pass('fetch() surfaces a changed envelope as an error naming the keys it got');
    else fail(`envelope drift not surfaced: ${msg}`);
  }
} catch (error) {
  fail(`softserve provider tests could not run: ${error.message}`);
}
