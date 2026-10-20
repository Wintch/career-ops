// tests/liveness-api-djinni.test.mjs — the Djinni rung of the liveness ladder.
//
// Djinni has no JSON endpoint for one posting, and the page answers 200 whether
// the ad is open or gone, so the verdict comes from the body:
//
//   JobPosting for this id, open                      -> active
//   JobPosting for this id, validThrough in the past  -> expired
//   no JobPosting + "The job ad is no longer active"  -> expired
//   anything else (another id, a challenge page)      -> null, the browser decides
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAtsApi, checkLivenessViaApi, classifyDjinniPosting, isAtsPosting } from '../liveness-api.mjs';

const ID = '800000';
const URL_ = `https://djinni.co/jobs/${ID}-senior-devops-engineer/`;
const NOW = Date.parse('2026-10-20T00:00:00Z');

const page = (jsonLd, extra = '') => `<html><head><title>Senior DevOps Engineer at Example – Djinni</title>` +
  (jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : '') +
  `</head><body>${extra}</body></html>`;
const posting = (over = {}) => ({ '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Senior DevOps Engineer', identifier: ID, url: URL_, validThrough: '2026-11-04T10:00:00', ...over });

async function withFetch(mock, run) {
  const previous = globalThis.fetch;
  globalThis.fetch = mock;
  try { return await run(); } finally { globalThis.fetch = previous; }
}

test('a Djinni posting URL resolves to its own page', () => {
  const resolved = resolveAtsApi(URL_);
  assert.equal(resolved.ats, 'djinni');
  assert.equal(resolved.apiUrl, URL_);
  assert.deepEqual(resolved.parts, { id: ID, slug: 'senior-devops-engineer' });
  assert.equal(resolveAtsApi(`https://djinni.co/jobs/${ID}-senior-devops-engineer`).apiUrl, URL_);
});

test('list pages, disallowed paths and lookalike hosts do not resolve', () => {
  for (const url of [
    'https://djinni.co/jobs/',
    'https://djinni.co/jobs/?primary_keyword=DevOps',
    `https://djinni.co/jobs2/${ID}-x/`,
    `https://djinni.co.evil.test/jobs/${ID}-x/`,
    `https://notdjinni.co/jobs/${ID}-x/`,
    `http://djinni.co/jobs/${ID}-x/`,
    'https://djinni.co/jobs/not-an-id/',
  ]) {
    assert.equal(isAtsPosting(url), false, url);
  }
});

test('an open ad (JobPosting for this id, validThrough ahead) is active', () => {
  const v = classifyDjinniPosting(page(posting()), ID, NOW);
  assert.equal(v.result, 'active');
  assert.equal(v.code, 'djinni_jobposting_ok');
});

test('a JobPosting whose validThrough has passed is expired', () => {
  const v = classifyDjinniPosting(page(posting({ validThrough: '2026-09-01T00:00:00' })), ID, NOW);
  assert.equal(v.result, 'expired');
  assert.equal(v.code, 'djinni_valid_through_passed');
});

test('a closed ad shows the inactive notice and no JobPosting', () => {
  const v = classifyDjinniPosting(page(null, '<div class="alert"><div class="fw-medium"> The job ad is no longer active </div></div>'), ID, NOW);
  assert.equal(v.result, 'expired');
  assert.equal(v.code, 'djinni_ad_inactive');
});

test('another id, a challenge page or an empty body is left to the browser', () => {
  assert.equal(classifyDjinniPosting(page(posting({ identifier: '1' })), ID, NOW), null);
  assert.equal(classifyDjinniPosting('<html><body>Just a moment...</body></html>', ID, NOW), null);
  assert.equal(classifyDjinniPosting('', ID, NOW), null);
  assert.equal(classifyDjinniPosting('<script type="application/ld+json">{not json</script>', ID, NOW), null);
});

test('the request asks for HTML and refuses redirects, and the verdict follows the body', async () => {
  const calls = [];
  const verdict = await withFetch(async (url, opts) => {
    calls.push([String(url), opts.redirect, opts.headers.accept]);
    return new Response(page(null, 'The job ad is no longer active'), { status: 200 });
  }, () => checkLivenessViaApi(URL_));
  assert.equal(verdict.result, 'expired');
  assert.deepEqual(calls, [[URL_, 'error', 'text/html']]);
});
