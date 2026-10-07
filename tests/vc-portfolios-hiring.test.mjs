import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYCPayload, SEED_SOURCES } from '../seeds/vc-portfolios.mjs';
import { parseArgs, runSeedScan } from '../scan-ats-full.mjs';

const payload = {
  companies: [
    { name: 'Acme', slug: 'acme', website: 'https://acme.example', batch: 'W24', teamSize: 12,
      badges: ['isHiring', 'highlightWomen'], locations: ['Buenos Aires, Argentina'], regions: ['South America'] },
    { name: 'Quiet', slug: 'quiet', website: 'https://quiet.example', badges: [] },
    { name: 'NoBadges', slug: 'nobadges', website: 'https://nobadges.example' },
  ],
};

test('parseYCPayload records hiring as an explicit boolean only when badges are present', () => {
  const [acme, quiet, nobadges] = parseYCPayload(payload);
  assert.equal(acme.hiring, true);
  assert.equal(quiet.hiring, false);
  assert.equal('hiring' in nobadges, false);
  assert.deepEqual(acme.locations, ['Buenos Aires, Argentina']);
  assert.deepEqual(acme.regions, ['South America']);
  assert.equal(acme.teamSize, 12);
  assert.equal('teamSize' in quiet, false);
});

test('parseArgs reads --hiring-only (off by default)', () => {
  assert.equal(parseArgs(['--seeds', 'yc']).hiringOnly, false);
  assert.equal(parseArgs(['--seeds', 'yc', '--hiring-only']).hiringOnly, true);
});

function yPage(slug, createdAt) {
  const data = { props: { jobPostings: [
    { id: 1, title: 'Backend Engineer', url: `/companies/${slug}/jobs/abc-backend-engineer`,
      location: 'Remote', companyName: slug, createdAt },
  ] } };
  const attr = JSON.stringify(data).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<div data-page="${attr}"></div>`;
}

async function scan(opts) {
  const requested = [];
  const ctx = {
    async fetchJson(url) { requested.push(url); const e = new Error('HTTP 404 Not Found'); e.status = 404; throw e; },
    async fetchText(url) {
      requested.push(url);
      const m = url.match(/companies\/([^/]+)\/jobs$/);
      if (!m) { const e = new Error('HTTP 404 Not Found'); e.status = 404; throw e; }
      return yPage(m[1], '2 days');
    },
    async fetchResponse(url) { return { ok: true, text: () => this.fetchText(url) }; },
    sleep: async () => {},
  };
  const original = SEED_SOURCES.yc.fetch;
  SEED_SOURCES.yc.fetch = async () => parseYCPayload(payload);
  try {
    const base = { ...parseArgs(['--seeds', 'yc']), titleFilter: () => true, locationFilter: () => true, contentFilter: () => true, blacklist: new Map(), ...opts };
    const res = await runSeedScan('yc', base, ctx, new Set(), 'Y Combinator Portfolio');
    return { res, requested };
  } finally {
    SEED_SOURCES.yc.fetch = original;
  }
}

test('--hiring-only skips companies YC does not flag as hiring', async () => {
  const { res, requested } = await scan({ hiringOnly: true });
  assert.equal(res.total, 2, 'Quiet is dropped; NoBadges has no signal and is kept');
  assert.equal(requested.some((u) => /quiet/.test(u)), false);
  assert.equal(requested.some((u) => /acme/.test(u)), true);
});

test('without --hiring-only every company is probed', async () => {
  const { res } = await scan({ hiringOnly: false });
  assert.equal(res.total, 3);
});

test('a hiring YC company with no public ATS board falls back to its YC jobs page, dated', async () => {
  const { res } = await scan({ hiringOnly: true });
  const acme = res.offers.filter((o) => /\/companies\/acme\//.test(o.url));
  assert.equal(acme.length, 1);
  assert.equal(acme[0].title, 'Backend Engineer');
  assert.ok(acme[0].postedAt, 'postedAt comes from the relative age, so the offer survives the recency filter');
});

test('a company not flagged as hiring never uses the YC fallback', async () => {
  const { res } = await scan({ hiringOnly: false });
  assert.equal(res.offers.some((o) => /\/companies\/quiet\//.test(o.url)), false);
  assert.equal(res.offers.some((o) => /\/companies\/nobadges\//.test(o.url)), false);
});
