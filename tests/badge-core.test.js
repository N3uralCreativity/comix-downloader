'use strict';
/**
 * Node unit tests for cdl-badge-core.js (run: `node tests/badge-core.test.js`).
 * Pure logic — no DOM, no chrome, no crypto. Not shipped (build allowlist excludes tests/).
 */
const C = require('../core/cdl-badge-core.js');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; } else { fail++; console.error('FAIL:', name); } }

// ── profileHashFromPath / isProfilePath ──────────────────────────────────────
check('profile path → hashId', C.profileHashFromPath('/u/l0v2e') === 'l0v2e');
check('profile path trailing slash', C.profileHashFromPath('/u/l0v2e/') === 'l0v2e');
check('profile path with -slug suffix', C.profileHashFromPath('/u/l0v2e-yse3ra') === 'l0v2e');
check('profile path alphanumeric', C.profileHashFromPath('/u/abc123') === 'abc123');
check('home is not a profile', C.profileHashFromPath('/home') === null);
check('root is not a profile', C.profileHashFromPath('/') === null);
check('title is not a profile', C.profileHashFromPath('/title/dkgd8-x') === null);
check('nested /u/ path is not a profile', C.profileHashFromPath('/u/l0v2e/settings') === null);
check('empty/null (no throw)', C.profileHashFromPath('') === null && C.profileHashFromPath(null) === null);
check('isProfilePath true', C.isProfilePath('/u/l0v2e') === true);
check('isProfilePath false', C.isProfilePath('/home') === false);

// ── formatTenure ─────────────────────────────────────────────────────────────
const DAY = 86400000;
const now = Date.parse('2026-06-28T12:00:00Z');
const ago = (days) => new Date(now - days * DAY).toISOString();
check('0 days → today', C.formatTenure(ago(0), now) === 'today');
check('1 day singular', C.formatTenure(ago(1), now) === '1 day');
check('6 days', C.formatTenure(ago(6), now) === '6 days');
check('7 days → 1 week', C.formatTenure(ago(7), now) === '1 week');
check('20 days → 3 weeks', C.formatTenure(ago(20), now) === '3 weeks');
check('59 days → ~8 weeks (still weeks)', /week/.test(C.formatTenure(ago(59), now)));
check('60 days → 2 months', C.formatTenure(ago(60), now) === '2 months');
check('30 days → 1 month boundary is weeks', /week/.test(C.formatTenure(ago(30), now)));
check('180 days → 6 months', C.formatTenure(ago(180), now) === '6 months');
check('364 days → still months', /month/.test(C.formatTenure(ago(364), now)));
check('365 days → 1 year', C.formatTenure(ago(365), now) === '1 year');
check('800 days → 2 years', C.formatTenure(ago(800), now) === '2 years');
check('accepts epoch ms', C.formatTenure(now - 365 * DAY, now) === '1 year');
check('future date → today (no negative)', C.formatTenure(ago(-5), now) === 'today');
check('empty/garbage → empty string', C.formatTenure('', now) === '' && C.formatTenure(null, now) === '' && C.formatTenure('not-a-date', now) === '');

// ── specialBadge (hardcoded role badges, no backend) ─────────────────────────
const dev = C.specialBadge('l0v2e');
check('specialBadge: l0v2e is a dev', dev && dev.kind === 'dev');
check('specialBadge: label states Comix-Downloader Dev', dev && dev.label === 'Comix-Downloader Dev');
check('specialBadge: has a short chip label', dev && dev.short === 'DEV');
check('specialBadge: unknown user → null', C.specialBadge('zzzzz') === null);
check('specialBadge: empty/null → null', C.specialBadge('') === null && C.specialBadge(null) === null);
check('specialBadge: l0v2e present in SPECIAL_BADGES map', !!C.SPECIAL_BADGES && !!C.SPECIAL_BADGES.l0v2e);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
