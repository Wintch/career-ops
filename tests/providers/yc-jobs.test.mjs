// tests/providers/yc-jobs.test.mjs — YC Jobs (Work at a Startup) per-company provider.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — yc-jobs');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/yc-jobs.mjs')).href);
  const ycJobs = mod.default;
  const { parseYcJobsPage, parseYcSlug, parseRelativeAgeMs } = mod;

  if (ycJobs.id === 'yc-jobs') pass('yc-jobs.id is "yc-jobs"');
  else fail(`yc-jobs.id is ${JSON.stringify(ycJobs.id)}`);

  // detect(): every accepted spelling resolves to the same per-company jobs page.
  const want = 'https://www.ycombinator.com/companies/cyble/jobs';
  const accepted = [
    'https://www.workatastartup.com/companies/cyble',
    'https://workatastartup.com/companies/cyble/',
    'https://www.ycombinator.com/companies/cyble',
    'https://www.ycombinator.com/companies/cyble/jobs',
    'https://www.ycombinator.com/companies/Cyble/jobs',
  ];
  const bad = accepted.filter((u) => ycJobs.detect({ name: 'Cyble', careers_url: u })?.url !== want);
  if (bad.length === 0) pass('yc-jobs.detect() resolves workatastartup.com and ycombinator.com company URLs to /companies/<slug>/jobs');
  else fail(`yc-jobs.detect() did not resolve: ${JSON.stringify(bad)}`);

  // detect(): refuses anything that is not a single YC company page.
  const rejected = [
    'https://www.workatastartup.com/jobs',
    'https://www.ycombinator.com/jobs/role/software-engineer',
    'https://www.ycombinator.com/companies?batch=W21',
    'https://www.ycombinator.com/companies',
    'http://www.ycombinator.com/companies/cyble',
    'https://evil.example/www.ycombinator.com/companies/cyble',
    'https://www.ycombinator.com.evil.example/companies/cyble',
    'https://www.ycombinator.com/companies/cy%2Fble',
    'https://www.ycombinator.com/companies/cyble/jobs/abc-engineer',
    '',
    null,
    7,
  ];
  const leaked = rejected.filter((u) => ycJobs.detect({ name: 'X', careers_url: u }) !== null);
  if (leaked.length === 0) pass('yc-jobs.detect() rejects board-wide pages, search queries, non-https, spoofed hosts and malformed slugs');
  else fail(`yc-jobs.detect() wrongly claimed: ${JSON.stringify(leaked)}`);

  if (parseYcSlug('https://www.ycombinator.com/companies/open-ai') === 'open-ai') pass('parseYcSlug keeps internal hyphens');
  else fail('parseYcSlug should keep internal hyphens');

  // parseYcJobsPage — deterministic fixture shaped like the live data-page payload.
  const payload = {
    component: 'WaasShowJobsPage',
    props: {
      jobPostings: [
        { id: 1, title: 'DevOps Engineer', url: '/companies/cyble/jobs/murTsCP-devops-engineer',
          applyUrl: 'https://account.ycombinator.com/authenticate?continue=x',
          location: 'Bengaluru, KA, IN / Bengaluru, Karnataka, IN', companyName: 'Cyble' },
        { id: 2, title: '  Founding Engineer & "Architect"  ', url: '/companies/cyble/jobs/abc123-founding-engineer',
          location: 'Remote', companyName: 'Cyble', createdAt: 'about 10 hours' },
        { id: 3, title: 'No Company Name Role', url: '/companies/cyble/jobs/zzz-role' },
        { id: 4, title: 'DevOps Engineer', url: '/companies/cyble/jobs/murTsCP-devops-engineer' }, // duplicate url
        { id: 5, title: '', url: '/companies/cyble/jobs/empty-title' },                              // no title
        { id: 6, title: 'No Url Role' },                                                              // no url
        { id: 7, title: 'Off Site Role', url: 'https://evil.example/companies/cyble/jobs/x' },        // not a site path
        { id: 8, title: 'Wrong Path Role', url: '/companies/cyble' },                                 // not a job path
      ],
    },
  };
  // Encode like the page does: JSON inside an HTML attribute.
  const attr = JSON.stringify(payload).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const html = `<html><body><div id="root" data-page="${attr}"></div></body></html>`;
  const NOW = 1_800_000_000_000;
  const jobs = parseYcJobsPage(html, 'Cyble (entry)', NOW);

  if (jobs.length === 3) pass('parseYcJobsPage keeps 3 valid postings (drops duplicate / no title / no url / off-site / non-job path)');
  else fail(`parseYcJobsPage returned ${jobs.length} postings (expected 3): ${JSON.stringify(jobs)}`);

  if (jobs[0] && Object.keys(jobs[0]).sort().join(',') === 'company,location,title,url') {
    pass('parseYcJobsPage returns the normalized { title, url, company, location } shape and no date when the age is missing');
  } else {
    fail(`parseYcJobsPage row 0 keys = ${JSON.stringify(jobs[0] && Object.keys(jobs[0]))}`);
  }

  if (jobs[0]?.url === 'https://www.ycombinator.com/companies/cyble/jobs/murTsCP-devops-engineer'
      && jobs[0]?.company === 'Cyble'
      && jobs[0]?.location === 'Bengaluru, KA, IN / Bengaluru, Karnataka, IN') {
    pass('parseYcJobsPage builds an absolute posting URL (not the login applyUrl) and keeps company/location');
  } else {
    fail(`parseYcJobsPage row 0 = ${JSON.stringify(jobs[0])}`);
  }

  if (jobs[1]?.title === 'Founding Engineer & "Architect"') pass('parseYcJobsPage trims titles and decodes HTML entities');
  else fail(`parseYcJobsPage row 1 title = ${JSON.stringify(jobs[1]?.title)}`);

  if (jobs[2]?.company === 'Cyble (entry)' && jobs[2]?.location === '') {
    pass('parseYcJobsPage falls back to the entry name for company and "" for location');
  } else {
    fail(`parseYcJobsPage row 2 = ${JSON.stringify(jobs[2])}`);
  }

  // Relative age → postedAt.
  if (jobs[1]?.postedAt === NOW - 10 * 3_600_000) pass('parseYcJobsPage derives postedAt from the relative age ("about 10 hours")');
  else fail(`parseYcJobsPage row 1 postedAt = ${jobs[1]?.postedAt}`);
  if (parseYcJobsPage(html, 'X')[1]?.postedAt === undefined) pass('parseYcJobsPage omits postedAt when no clock is supplied');
  else fail('parseYcJobsPage must not set postedAt without a now argument');

  const D = 86_400_000;
  const ages = [['20 days', 20 * D], ['about 1 month', 30 * D], ['3 months', 90 * D], ['over 2 years', 730 * D],
    ['almost 3 years', 1095 * D], ['about 22 hours', 22 * 3_600_000], ['a day', D], ['less than a minute', 0]];
  const badAge = ages.filter(([t, ms]) => parseRelativeAgeMs(t) !== ms);
  if (badAge.length === 0) pass('parseRelativeAgeMs handles Rails time-ago phrases (hours, days, months, years, "about/over/almost")');
  else fail(`parseRelativeAgeMs wrong for: ${JSON.stringify(badAge)}`);
  if (['', 'soon', '3 fortnights', null, 7].every((t) => parseRelativeAgeMs(t) === null)) pass('parseRelativeAgeMs returns null for unrecognised phrases');
  else fail('parseRelativeAgeMs must return null for unrecognised phrases');

  // Degenerate inputs never throw and never invent postings.
  const empties = [parseYcJobsPage('', 'X'), parseYcJobsPage('<html></html>', 'X'),
    parseYcJobsPage('<div data-page="{not json"></div>', 'X'),
    parseYcJobsPage('<div data-page="{}"></div>', 'X'), parseYcJobsPage(null, 'X')];
  if (empties.every((r) => Array.isArray(r) && r.length === 0)) pass('parseYcJobsPage returns [] for empty, malformed or posting-less pages');
  else fail('parseYcJobsPage must return [] for empty/malformed/posting-less input');
} catch (e) {
  fail(`yc-jobs provider tests threw: ${e.message}`);
}
