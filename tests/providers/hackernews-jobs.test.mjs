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
  ];
  const jobs = parseHnJobItems(items);

  if (jobs.length === 4) pass('parseHnJobItems keeps 4 live job items (drops dead / non-job / blank title / duplicate url / null)');
  else fail(`parseHnJobItems returned ${jobs.length} (expected 4): ${JSON.stringify(jobs.map((j) => j.title))}`);

  if (jobs[0]?.company === 'RetailReady' && jobs[0]?.postedAt === 1791046812 * 1000
      && jobs[0]?.url === 'https://www.ycombinator.com/companies/retailready/jobs/bFcgIe4-implementations') {
    pass('parseHnJobItems maps company from "(YC <batch>)", exact postedAt (epoch s → ms) and the employer link');
  } else {
    fail(`parseHnJobItems row 0 = ${JSON.stringify(jobs[0])}`);
  }
  if (jobs[1]?.url === 'https://news.ycombinator.com/item?id=2') pass('a post with no link falls back to its Hacker News item page');
  else fail(`row 1 url = ${jobs[1]?.url}`);
  if (jobs[2]?.url === 'http://careers.telli.com/') pass('an http employer link is kept');
  else fail(`row 2 url = ${jobs[2]?.url}`);
  if (jobs[3]?.url === 'https://news.ycombinator.com/item?id=7' && jobs[3]?.company === 'Bad Url Co') {
    pass('a non-http(s) link (javascript:) is never emitted; falls back to the HN page');
  } else {
    fail(`row 3 = ${JSON.stringify(jobs[3])}`);
  }

  // fetch(): bounded, tolerant of a failing item, honours maxItems.
  const calls = [];
  const ctx = {
    async fetchJson(url) {
      calls.push(url);
      if (url.endsWith('jobstories.json')) return [11, 12, 13, 14, 15, 16, 17];
      const id = Number(url.match(/item\/(\d+)\.json/)[1]);
      if (id === 12) throw new Error('HTTP 500');
      return { id, type: 'job', title: `Co${id} (YC W24) Is Hiring`, time: 1790000000 + id, url: `https://co${id}.example/jobs` };
    },
  };
  const out = await hn.fetch({ name: 'HN', provider: 'hackernews-jobs', maxItems: 4 }, ctx);
  if (out.length === 3 && calls.length === 5) pass('fetch() reads at most maxItems posts and skips one that errors');
  else fail(`fetch() returned ${out.length} jobs with ${calls.length} requests (expected 3 jobs, 5 requests)`);
  const capped = await hn.fetch({ name: 'HN', provider: 'hackernews-jobs', maxItems: 5000 }, { fetchJson: async (u) => u.endsWith('jobstories.json') ? Array.from({ length: 200 }, (_, i) => i + 1) : null });
  if (Array.isArray(capped)) pass('fetch() clamps an oversized maxItems and tolerates null items');
  else fail('fetch() must return an array');
} catch (e) {
  fail(`hackernews-jobs provider tests threw: ${e.message}`);
}
