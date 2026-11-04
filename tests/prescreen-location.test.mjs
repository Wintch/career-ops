import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { pass, fail, ROOT, NODE } from './helpers.mjs';
import {
  buildKeepRe, classifyLine, screenLines, isRestricted, REASON_ONSITE, REASON_RESTRICTED,
} from '../prescreen-location.mjs';

console.log('\nprescreen-location (zero-token location pre-screen)');

function check(label, ok, detail = '') {
  if (ok) pass(label); else fail(`${label}${detail ? `: ${detail}` : ''}`);
}

const keepRe = buildKeepRe(['Argentina', 'Buenos Aires', 'LatAm']);
const line = (url, loc) => `- [ ] ${url} | Acme | SRE | ${loc} | posted: 2026-11-04`;
const reasonOf = (url, loc) => classifyLine(line(url, loc), keepRe).reason;

check('worldwide terms are always present', buildKeepRe([]) !== null);
check('home region is kept', reasonOf('https://x.test/a', 'Argentina') === null);
check('home region in a remote string is kept', reasonOf('https://x.test/a', 'Argentina - Remote') === null);
check('worldwide remote is kept', reasonOf('https://x.test/a', 'Remote - Global') === null);
check('bare remote is kept', reasonOf('https://x.test/a', 'Remote') === null);
check('on-site elsewhere is discarded', reasonOf('https://x.test/a', 'Chicago, IL') === REASON_ONSITE);
check('remote restricted by country is discarded', reasonOf('https://x.test/a', 'Remote - Greece') === REASON_RESTRICTED);
check('"Work from Home, Bulgaria" is discarded', reasonOf('https://x.test/a', 'Work from Home, Bulgaria') === REASON_RESTRICTED);
check('"IND-Work from Home-Remote" is discarded', reasonOf('https://x.test/a', 'IND-Work from Home-Remote') === REASON_RESTRICTED);
check('a US state list is discarded', reasonOf('https://x.test/a', 'Remote - Texas · Remote - Florida') === REASON_RESTRICTED);
check('lowercase "in" is not the country code', !isRestricted('Remote in the region'));
check('bare Remote with a restricting URL slug is discarded',
  reasonOf('https://acme.wd1.myworkdayjobs.com/x/job/Remote/Sr-SRE--Remote-US_JR1', 'Remote') === REASON_RESTRICTED);
check('slug "Remote---Greece" is discarded',
  reasonOf('https://acme.wd1.myworkdayjobs.com/x/job/Remote---Greece/SRE_JR2', 'Remote') === REASON_RESTRICTED);
check('undeclared location passes to triage', reasonOf('https://x.test/a', '') === null);
check('"N Locations" without a home hint is discarded', reasonOf('https://x.test/a', '3 Locations') === REASON_ONSITE);
check('"N Locations" with a home hint in the URL is kept', reasonOf('https://x.test/argentina/a', '3 Locations') === null);

const r = screenLines([
  '# Pipeline', '- [x] done', line('https://x.test/1', 'Argentina'), line('https://x.test/2', 'Berlin'),
], keepRe, '2026-11-04', new Date('2026-11-04T10:00:00Z'));
check('only the out-of-region line is marked', r.lines[3].startsWith('- [x] https://x.test/2')
  && r.lines[3].endsWith(`| pre-screen: ${REASON_ONSITE} (2026-11-04)`) && r.lines[2].startsWith('- [ ] '));
check('non-pending lines are untouched', r.lines[0] === '# Pipeline' && r.lines[1] === '- [x] done');
check('discard log row has timestamp, url and reason',
  r.log.length === 1 && r.log[0] === `2026-11-04T10:00:00Z\thttps://x.test/2\tpre-screen: ${REASON_ONSITE}`);

// CLI: dry run writes nothing, --apply writes the file and the log.
const dir = mkdtempSync(join(tmpdir(), 'prescreen-'));
try {
  const file = join(dir, 'pipeline.md');
  const logf = join(dir, 'discard.log');
  const body = ['## Pending', line('https://x.test/1', 'Argentina'), line('https://x.test/2', 'Berlin'), ''].join('\n');
  writeFileSync(file, body);
  const env = { ...process.env, CAREER_OPS_ROOT: dir };
  const base = ['prescreen-location.mjs', '--file', file, '--log', logf, '--keep', 'Argentina', '--date', '2026-11-04'];
  const dry = spawnSync(NODE, base, { cwd: ROOT, env, encoding: 'utf8' });
  check('dry run exits 0 and changes nothing', dry.status === 0 && readFileSync(file, 'utf8') === body, dry.stderr);
  const app = spawnSync(NODE, [...base, '--apply'], { cwd: ROOT, env, encoding: 'utf8' });
  const after = readFileSync(file, 'utf8');
  check('--apply marks the discarded line', app.status === 0 && after.includes('- [x] https://x.test/2') && after.includes('- [ ] https://x.test/1'), app.stderr);
  check('--apply writes one discard.log row', readFileSync(logf, 'utf8').trim().split('\n').length === 1);
  const none = spawnSync(NODE, ['prescreen-location.mjs', '--file', file, '--log', logf], { cwd: ROOT, env, encoding: 'utf8' });
  check('no home-region terms stops instead of discarding everything', none.status === 1 && /No home-region terms/.test(none.stderr));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
