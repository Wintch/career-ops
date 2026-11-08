// tests/providers/epam.test.mjs: EPAM provider (providers/epam.mjs).
// Offline only. The response shape is the one careers.epam.com's
// /api/jobs/v2/search/careers returns (offset paging by `from`, `size` capped
// at 50, `page` ignored); titles, ids and places are invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import provider, {
  buildPostingUrl, formatLocation, isEpamUrl, parseSearchResponse, resolveMaxPages,
} from '../../providers/epam.mjs';

const CAREERS = 'https://careers.epam.com/en/jobs';

function row(n, extra = {}) {
  const uid = `bltexample${String(n).padStart(6, '0')}`;
  return {
    uid,
    name: `Example Engineer ${n}`,
    posting_type: 'Standard',
    city: null,
    country: [{ id: '1', name: 'Argentina', type: null }, { id: '2', name: 'Chile', type: null }],
    vacancy_type: 'Remote',
    seniority: 'Senior',
    is_hidden: false,
    is_expired: false,
    description: '<p>Build <strong>things</strong> &amp; ship them.</p>',
    category: {
      responsibilities: ['Design services', 'Run on-call'],
      requirements: ['3+ years of Go'],
      nice_to_have: null,
    },
    seo: { url: `/en/vacancy/example-engineer-${n}-${uid}_en` },
    created_at: '2026-10-09T14:34:54.485Z',
    updated_at: '2026-10-10T10:00:00.000Z',
    sd_requisition_id: null,
    ...extra,
  };
}

/** A source of `total` rows served by `from` offset, 50 at most per answer. */
function source(total, make = row) {
  const all = Array.from({ length: total }, (_, i) => make(i + 1));
  return (from) => ({ data: { total, jobs: all.slice(from, from + 50), facets: {} }, meta: {} });
}

function makeCtx(handler, extra = {}) {
  const calls = [];
  const sleeps = [];
  return {
    calls,
    sleeps,
    ctx: {
      sleep: async (ms) => { sleeps.push(ms); },
      fetchJson: async (url, opts) => {
        const u = new URL(url);
        const from = Number(u.searchParams.get('from'));
        calls.push({ url, opts, from, size: u.searchParams.get('size') });
        const out = await handler(from, calls.length);
        if (out instanceof Error) throw out;
        return out;
      },
      ...extra,
    },
  };
}

async function captureErrors(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => { lines.push(args.join(' ')); };
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = orig;
  }
}

const entry = (extra = {}) => ({ name: 'EPAM Systems', careers_url: CAREERS, ...extra });

test('id is epam', () => {
  assert.equal(provider.id, 'epam');
});

test('detect() claims careers.epam.com only, anchored, and never throws', () => {
  for (const careers_url of [
    CAREERS,
    'https://careers.epam.com/',
    'https://CAREERS.EPAM.COM/en/vacancy/x',
  ]) {
    assert.deepEqual(provider.detect({ careers_url }), { url: careers_url }, careers_url);
  }
  assert.deepEqual(provider.detect({ api: 'https://careers.epam.com/api/jobs/v2/search/careers' }), { url: 'https://careers.epam.com/api/jobs/v2/search/careers' });
  for (const careers_url of [
    'http://careers.epam.com/en/jobs',
    'https://careers.epam.com.evil.example/en/jobs',
    'https://evilcareers.epam.com/en/jobs',
    'https://www.epam.com/careers',
    'https://epam.com/careers',
    'https://evil.example/?u=careers.epam.com',
    'https://careers.epam.com@evil.example/',
    '::',
    '',
  ]) {
    assert.equal(provider.detect({ careers_url }), null, careers_url);
  }
  assert.equal(provider.detect({}), null);
  assert.equal(provider.detect(null), null);
  assert.equal(provider.detect(undefined), null);
  assert.equal(provider.detect({ careers_url: ['x'] }), null);
  assert.equal(provider.detect({ careers_url: 42 }), null);
  assert.equal(isEpamUrl('https://careers.epam.com'), true);
  assert.equal(isEpamUrl(undefined), false);
});

test('fetch() refuses a foreign host before any request', async () => {
  for (const careers_url of ['https://evil.example/en/jobs', 'http://careers.epam.com/en/jobs', '::']) {
    const { ctx, calls } = makeCtx(() => { throw new Error('fetch must not be called'); });
    await assert.rejects(provider.fetch(entry({ careers_url }), ctx), /epam:/, careers_url);
    assert.equal(calls.length, 0, careers_url);
  }
});

test('resolveMaxPages: default, valid override, cap, junk ignored', () => {
  assert.equal(resolveMaxPages({}), 15);
  assert.equal(resolveMaxPages({ max_pages: 3 }), 3);
  assert.equal(resolveMaxPages({ max_pages: 9999 }), 60);
  for (const bad of [0, -1, 1.5, '3', null]) assert.equal(resolveMaxPages({ max_pages: bad }), 15, String(bad));
});

test('formatLocation: countries then work mode; cities win over countries', () => {
  assert.equal(formatLocation(row(1)), 'Argentina, Chile · Remote');
  assert.equal(formatLocation(row(1, { vacancy_type: 'Hybrid' })), 'Argentina, Chile · Hybrid');
  assert.equal(formatLocation(row(1, { vacancy_type: 'Office' })), 'Argentina, Chile');
  assert.equal(formatLocation(row(1, { vacancy_type: null })), 'Argentina, Chile');
  assert.equal(formatLocation(row(1, { vacancy_type: 'remote' })), 'Argentina, Chile · Remote');
  assert.equal(
    formatLocation(row(1, {
      vacancy_type: 'Hybrid',
      city: [{ name: 'Mexico City', country: { name: 'Mexico' }, state: { name: 'The Federal District' } }],
      country: [{ name: 'Mexico' }],
    })),
    'Mexico City, Mexico · Hybrid',
  );
  assert.equal(formatLocation(row(1, { country: [], city: null })), 'Remote');
  assert.equal(formatLocation(row(1, { country: [{ name: 'Poland' }, { name: 'Poland' }, {}], vacancy_type: 'Office' })), 'Poland');
  assert.equal(formatLocation(null), '');
});

test('buildPostingUrl: seo.url when it has the vacancy shape, uid form otherwise', () => {
  assert.equal(buildPostingUrl(row(7)), 'https://careers.epam.com/en/vacancy/example-engineer-7-bltexample000007_en');
  for (const seo of [undefined, null, {}, { url: '' }, { url: 'https://evil.example/en/vacancy/x' }, { url: '/en/application/x' }, { url: '/en/vacancy/a/b' }, { url: '//evil.example/en/vacancy/x' }]) {
    assert.equal(buildPostingUrl(row(7, { seo })), 'https://careers.epam.com/en/vacancy/bltexample000007_en', JSON.stringify(seo));
  }
  assert.equal(buildPostingUrl(row(7, { seo: null, uid: '' })), null);
  assert.equal(buildPostingUrl(row(7, { seo: null, uid: 5 })), null);
  assert.equal(buildPostingUrl(null), null);
});

test('parseSearchResponse: standard Job shape, description from the list payload', () => {
  const { jobs, rawCount, total } = parseSearchResponse({ data: { total: 2, jobs: [row(1), row(2, { sd_requisition_id: 12345 })] } });
  assert.equal(rawCount, 2);
  assert.equal(total, 2);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs[0], {
    title: 'Example Engineer 1',
    url: 'https://careers.epam.com/en/vacancy/example-engineer-1-bltexample000001_en',
    company: 'EPAM Systems',
    location: 'Argentina, Chile · Remote',
    postedAt: Date.UTC(2026, 9, 9, 14, 34, 54, 485),
    description: 'Build things & ship them. Responsibilities: Design services; Run on-call Requirements: 3+ years of Go',
  });
  assert.equal(jobs[1].requisitionId, '12345');
  assert.ok(!('requisitionId' in jobs[0]));
});

test('parseSearchResponse: a bad date or a bare row leaves the optional keys out', () => {
  const { jobs } = parseSearchResponse({ data: { total: 1, jobs: [row(1, { created_at: 'not a date', description: null, category: null })] } });
  assert.equal(jobs.length, 1);
  assert.ok(!('postedAt' in jobs[0]));
  assert.ok(!('description' in jobs[0]));
});

test('parseSearchResponse: malformed, expired and hidden rows are dropped, the rest stands', () => {
  const { jobs, rawCount } = parseSearchResponse({
    data: {
      total: 8,
      jobs: [
        null,
        'x',
        row(1, { name: '   ' }),
        row(2, { seo: null, uid: null }),
        row(3, { is_expired: true }),
        row(4, { is_hidden: true }),
        row(5, { uid: '\uD800', seo: null }),
        row(6),
      ],
    },
  });
  assert.equal(rawCount, 8);
  assert.deepEqual(jobs.map((j) => j.title), ['Example Engineer 6']);
});

test('parseSearchResponse: an empty jobs[] is an empty board, anything else throws', () => {
  assert.deepEqual(parseSearchResponse({ data: { total: 0, jobs: [] } }), { jobs: [], rawCount: 0, total: 0 });
  assert.equal(parseSearchResponse({ data: { jobs: [] } }).total, null);
  for (const bad of [{}, { data: {} }, { data: { jobs: null } }, { data: { jobs: {} } }, { jobs: [] }, { results: [] }, '', 5, true, null, undefined]) {
    assert.throws(() => parseSearchResponse(bad), /epam: unexpected response/, JSON.stringify(bad));
  }
});

test('fetch() walks by from offset at size 50 and stops at total', async () => {
  const src = source(120);
  const { ctx, calls, sleeps } = makeCtx((from) => src(from));
  const jobs = await provider.fetch(entry(), ctx);
  assert.equal(jobs.length, 120);
  assert.deepEqual(calls.map((c) => c.from), [0, 50, 100]);
  assert.ok(calls.every((c) => c.size === '50'));
  assert.ok(calls.every((c) => c.url.startsWith('https://careers.epam.com/api/jobs/v2/search/careers?')));
  assert.ok(calls.every((c) => c.opts.redirect === 'error'));
  assert.equal(sleeps.length, 2, 'a pause between pages, none before the first');
  assert.ok(sleeps.every((ms) => ms > 0));
  assert.equal(new Set(jobs.map((j) => j.url)).size, 120);
});

test('fetch() stops at total even when the last page is full, with no extra request', async () => {
  const src = source(100);
  const { ctx, calls } = makeCtx((from) => src(from));
  const jobs = await provider.fetch(entry(), ctx);
  assert.equal(jobs.length, 100);
  assert.deepEqual(calls.map((c) => c.from), [0, 50]);
});

test('fetch() with an empty board is one request and []', async () => {
  const { ctx, calls } = makeCtx(() => ({ data: { total: 0, jobs: [] } }));
  assert.deepEqual(await provider.fetch(entry(), ctx), []);
  assert.equal(calls.length, 1);
});

test('fetch() dedupes a posting the source repeats, and the short-page stop reads the raw count', async () => {
  // Page 1 is full but holds one repeat and one bad row: narrowing must not end the walk.
  const first = Array.from({ length: 50 }, (_, i) => row(i + 1));
  first[1] = row(1);
  first[2] = row(3, { name: '' });
  const second = [row(60), row(1)];
  const { ctx, calls } = makeCtx((from) => ({ data: { total: 52, jobs: from === 0 ? first : second } }));
  const jobs = await provider.fetch(entry(), ctx);
  assert.deepEqual(calls.map((c) => c.from), [0, 50]);
  assert.equal(jobs.length, 49 - 1 + 1, '50 rows - 1 repeat - 1 bad on page 1, +1 new on page 2');
  assert.equal(new Set(jobs.map((j) => j.url)).size, jobs.length);
});

test('fetch() ignoring `from` (same rows every time) ends at max_pages instead of looping', async () => {
  const same = { data: { total: 707, jobs: Array.from({ length: 50 }, (_, i) => row(i + 1)) } };
  const { ctx, calls } = makeCtx(() => same);
  const { result: jobs, lines } = await captureErrors(() => provider.fetch(entry({ max_pages: 4 }), ctx));
  assert.equal(calls.length, 4);
  assert.equal(jobs.length, 50);
  assert.match(lines.join('\n'), /truncated at max_pages=4 \(200 of 707/);
});

test('fetch() warns when max_pages truncates a longer list, and stays quiet otherwise', async () => {
  const src = source(160);
  let run = await captureErrors(() => provider.fetch(entry({ max_pages: 2 }), makeCtx((from) => src(from)).ctx));
  assert.equal(run.result.length, 100);
  assert.match(run.lines.join('\n'), /epam: truncated at max_pages=2 \(100 of 160/);
  run = await captureErrors(() => provider.fetch(entry({ max_pages: 4 }), makeCtx((from) => src(from)).ctx));
  assert.equal(run.result.length, 160);
  assert.deepEqual(run.lines, []);
  // A list that ends exactly on the cap is complete, not truncated.
  const exact = source(100);
  run = await captureErrors(() => provider.fetch(entry({ max_pages: 2 }), makeCtx((from) => exact(from)).ctx));
  assert.equal(run.result.length, 100);
  assert.deepEqual(run.lines, []);
});

test('fetch() under a probe budget reads one page and does not warn', async () => {
  const src = source(300);
  const { ctx, calls } = makeCtx((from) => src(from), { maxPages: 1 });
  const { result: jobs, lines } = await captureErrors(() => provider.fetch(entry(), ctx));
  assert.equal(calls.length, 1);
  assert.equal(jobs.length, 50);
  assert.deepEqual(lines, []);
});

test('fetch() throws on an envelope change and on a failed first page', async () => {
  await assert.rejects(provider.fetch(entry(), makeCtx(() => ({ results: [] })).ctx), /epam: unexpected response/);
  const boom = Object.assign(new Error('HTTP 404'), { status: 404 });
  await assert.rejects(provider.fetch(entry(), makeCtx(() => boom).ctx), /HTTP 404/);
});

test('fetch() works from an api: entry too', async () => {
  const { ctx } = makeCtx(source(3));
  const jobs = await provider.fetch({ name: 'EPAM', api: 'https://careers.epam.com/api/jobs/v2/search/careers' }, ctx);
  assert.equal(jobs.length, 3);
  assert.ok(jobs.every((j) => j.company === 'EPAM Systems'));
});
