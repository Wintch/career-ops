// tests/providers/hackernews-jobs.test.mjs — HN "Jobs" (YC job posts) board-wide provider.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — hackernews-jobs');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/hackernews-jobs.mjs')).href);
  const hn = mod.default;
  const { parseHnJobItems } = mod;

  if (hn.id === 'hackernews-jobs') pass('hackernews-jobs.id is "hackernews-jobs"');
  else fail(`hackernews-jobs.id is ${JSON.stringify(hn.id)}`);

  if (hn.detect({ name: 'HN Jobs', provider: 'hackernews-jobs' })?.url) pass('detect() resolves provider:hackernews-jobs');
  else fail('detect() should resolve an explicit provider:hackernews-jobs');
  if (hn.detect({ name: 'X', careers_url: 'https://news.ycombinator.com/jobs' }) === null
      && hn.detect({ name: 'X', provider: 'hackernews' }) === null) {
    pass('detect() is explicit-only (does not claim news.ycombinator.com URLs or the "Who is hiring?" provider)');
  } else {
    fail('detect() must not claim URLs or provider:hackernews');
  }

  const items = [
    { id: 1, type: 'job', title: 'RetailReady (YC W24) Is Hiring', time: 1791046812,
      url: 'https://www.ycombinator.com/companies/retailready/jobs/bFcgIe4-implementations' },
    { id: 2, type: 'job', title: 'Quill (YC W20) Is Hiring a Fullstack SWE', time: 1790900000, text: 'We are hiring' },
    { id: 3, type: 'job', title: 'Telli (YC F24) is hiring engineers [Berlin, on-site]', time: 1790800000, url: 'http://careers.telli.com/' },
    { id: 4, type: 'job', title: 'Dead Co (YC W20) Is Hiring', time: 1790700000, url: 'https://dead.example/jobs', dead: true },
    { id: 5, type: 'story', title: 'Not a job', time: 1790600000, url: 'https://x.example' },
    { id: 6, type: 'job', title: '   ', time: 1790500000, url: 'https://blank.example' },
    { id: 7, type: 'job', title: 'Bad Url Co (YC S23) Is Hiring', time: 1790400000, url: 'javascript:alert(1)' },
    { id: 8, type: 'job', title: 'RetailReady (YC W24) Is Hiring', time: 1791046812,
      url: 'https://www.ycombinator.com/companies/retailready/jobs/bFcgIe4-implementations' }, // duplicate url
    null,
    { id: 9, type: 'job', title: 'Senior Engineer at Foo (YC W21) Is Hiring', time: 1790300000 },
    { id: 10, type: 'job', title: 'Hiring: Foo (YC W21)', time: 1790300000 },
    { id: 11, type: 'job', title: 'Plain Co is hiring a designer', time: 1790300000 },
    { id: 12, type: 'job', title: 'Ampersand &amp; Co (YC S22) Is Hiring', time: 1790200000, url: 'https://user:pw@amp.example/jobs' },
  ];
  const stats = { dropped: 0 };
  const jobs = parseHnJobItems(items, stats);
  if (stats.dropped === 3) pass('posts with no clean "Name (YC xx)" employer are dropped and counted');
  else fail(`dropped = ${stats.dropped} (expected 3)`);
  if (jobs[4]?.company === 'Ampersand & Co' && jobs[4]?.url === 'https://news.ycombinator.com/item?id=12') {
    pass('entities are decoded in the headline; a link with userinfo falls back to the HN page');
  } else fail(`row 4 = ${JSON.stringify(jobs[4])}`);

  if (jobs.length === 5) pass('parseHnJobItems keeps 5 live job items (drops dead / non-job / blank title / duplicate url / null / unattributed)');
  else fail(`parseHnJobItems returned ${jobs.length} (expected 5): ${JSON.stringify(jobs.map((j) => j.title))}`);

  if (jobs[0]?.company === 'RetailReady' && jobs[0]?.postedAt === 1791046812 * 1000
      && jobs[0]?.url === 'https://www.ycombinator.com/companies/retailready/jobs/bFcgIe4-implementations') {
    pass('parseHnJobItems maps company from "(YC <batch>)", exact postedAt (epoch s → ms) and the employer link');
  } else {
    fail(`parseHnJobItems row 0 = ${JSON.stringify(jobs[0])}`);
  }
  if (jobs[1]?.url === 'https://news.ycombinator.com/item?id=2') pass('a post with no link falls back to its Hacker News item page');
  else fail(`row 1 url = ${jobs[1]?.url}`);
  if (jobs[2]?.url === 'https://news.ycombinator.com/item?id=3') pass('an http employer link is not kept (HN page instead)');
  else fail(`row 2 url = ${jobs[2]?.url}`);
  if (jobs[3]?.url === 'https://news.ycombinator.com/item?id=7' && jobs[3]?.company === 'Bad Url Co') {
    pass('a non-http(s) link (javascript:) is never emitted; falls back to the HN page');
  } else {
    fail(`row 3 = ${JSON.stringify(jobs[3])}`);
  }

  // fetch(): bounded, tolerant of a failing item, honours maxItems.
  const calls = [];
  const opts = [];
  const ctx = {
    sleep: async () => {},
    async fetchJson(url, o) {
      calls.push(url);
      opts.push(o);
      if (url.endsWith('jobstories.json')) return [11, 12, 13, 14, 15, 16, 17];
      const id = Number(url.match(/item\/(\d+)\.json/)[1]);
      if (id === 12) throw new Error('HTTP 500');
      return { id, type: 'job', title: `Co${id} (YC W24) Is Hiring`, time: 1790000000 + id, url: `https://co${id}.example/jobs` };
    },
  };
  const origWarn = console.warn;
  const warns = [];
  console.warn = (m) => warns.push(String(m));
  try {
    const out = await hn.fetch({ name: 'HN', provider: 'hackernews-jobs', maxItems: 4 }, ctx);
    if (out.length === 3 && calls.length === 5) pass('fetch() reads at most maxItems posts and skips one that errors');
    else fail(`fetch() returned ${out.length} jobs with ${calls.length} requests (expected 3 jobs, 5 requests)`);
    if (warns.some((w) => /1 of 4/.test(w))) pass('partial item failures are counted in one warning');
    else fail(`warnings: ${JSON.stringify(warns)}`);
    if (opts.every((o) => o?.redirect === 'error')) pass('every request passes redirect:"error"');
    else fail('fetch() must pass redirect:"error" on every request');

    calls.length = 0;
    await hn.fetch({ name: 'HN', provider: 'hackernews-jobs', max_items: 2 }, ctx);
    if (calls.length === 3) pass('max_items is accepted as an alias');
    else fail(`max_items alias made ${calls.length} requests (expected 3)`);

    calls.length = 0;
    await hn.fetch({ name: 'HN', provider: 'hackernews-jobs' }, { ...ctx, maxPages: 1 });
    if (calls.length === 2) pass('ctx.maxPages bounds the items read');
    else fail(`ctx.maxPages=1 made ${calls.length} requests (expected 2)`);

    const bigCalls = [];
    await hn.fetch({ name: 'HN', provider: 'hackernews-jobs', maxItems: 5000 }, { sleep: async () => {}, fetchJson: async (u) => { bigCalls.push(u); return u.endsWith('jobstories.json') ? Array.from({ length: 200 }, (_, i) => i + 1) : null; } });
    if (bigCalls.length === 61) pass('fetch() clamps an oversized maxItems to 60 items (61 requests) and tolerates null items');
    else fail(`oversized maxItems made ${bigCalls.length} requests (expected 61)`);

    let threw = null;
    try { await hn.fetch({ name: 'HN', provider: 'hackernews-jobs' }, { fetchJson: async () => ({ error: 'x' }) }); } catch (e) { threw = e; }
    if (threw) pass('a non-array jobstories body throws'); else fail('a non-array jobstories body must throw');

    threw = null;
    try {
      await hn.fetch({ name: 'HN', provider: 'hackernews-jobs', maxItems: 3 }, { sleep: async () => {}, fetchJson: async (u) => { if (u.endsWith('jobstories.json')) return [1, 2, 3]; throw new Error('HTTP 503'); } });
    } catch (e) { threw = e; }
    if (threw) pass('fetch() throws when every item request failed'); else fail('every item failing must throw');

    class Sentinel extends Error {}
    const sentinel = new Sentinel();
    threw = null;
    try {
      await hn.fetch({ name: 'HN', provider: 'hackernews-jobs' }, { maxPages: 1, fetchJson: async (u) => { if (u.endsWith('jobstories.json')) return [1, 2]; throw sentinel; } });
    } catch (e) { threw = e; }
    if (threw === sentinel) pass('a probe sentinel propagates unwrapped'); else fail('the probe sentinel must be rethrown unwrapped');
  } finally {
    console.warn = origWarn;
  }
} catch (e) {
  fail(`hackernews-jobs provider tests threw: ${e.message}`);
}
