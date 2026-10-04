// tests/skip-title-filter.test.mjs — `skip_title_filter: true` lets one entry
// (a casting board, a general job board) bypass the global tech title_filter,
// and changes nothing for any other entry.
import { pass, fail } from './helpers.mjs';
import { passesTitleFilter, buildTitleFilter } from '../scan.mjs';

console.log('\nscan — skip_title_filter');

const filter = buildTitleFilter({ positive: ['SRE', 'DevOps'], negative: ['Intern'] });
const casting = 'Se busca actor de 40 a 50 años para cortometraje';

const check = (label, got, want) => (got === want ? pass(label) : fail(`${label}: got ${got}, wanted ${want}`));

check('plain entry: a title outside the keyword net is filtered', passesTitleFilter({ name: 'x' }, casting, filter), false);
check('plain entry: a matching title passes', passesTitleFilter({ name: 'x' }, 'Senior SRE', filter), true);
check('skip_title_filter: true passes a title outside the net', passesTitleFilter({ skip_title_filter: true }, casting, filter), true);
check('skip_title_filter: true also bypasses the negative list', passesTitleFilter({ skip_title_filter: true }, 'Intern', filter), true);
check('only a literal true counts ("true" string does not bypass)', passesTitleFilter({ skip_title_filter: 'true' }, casting, filter), false);
check('skip_title_filter: false behaves like unset', passesTitleFilter({ skip_title_filter: false }, casting, filter), false);
check('a missing entry does not throw and filters normally', passesTitleFilter(undefined, casting, filter), false);
