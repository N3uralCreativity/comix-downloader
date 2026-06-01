'use strict';
/**
 * Node unit tests for cdl-features-core.js (run: `node tests/features-core.test.js`).
 * Pure logic — no DOM, no chrome shim. Not shipped (build allowlist excludes tests/).
 */

const C = require('../cdl-features-core.js');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; } else { fail++; console.error('FAIL:', name); }
}
const num = (x) => C.parseChapterNumber(x);
const keyOf = (x) => C.dedupeKey(C.parseChapterNumber(x));

// ── parseChapterNumber: textual forms ────────────────────────────────────────
check('Ch92 -> 92', num('Ch92').kind === 'num' && num('Ch92').value === 92);
check('Chapter 22 -> 22', num('Chapter 22').value === 22);
check('Ch.22 -> 22', num('Ch.22').value === 22);
check('ch22 -> 22', num('ch22').value === 22);
check('bare 22 -> 22', num('22').value === 22);
check('#7 -> 7', num('#7').value === 7);
check('Episode 5 -> 5', num('Episode 5').value === 5);

// Same-number invariant (the ch22-vs-22 dedupe requirement)
check('ch22 == 22 (key)', keyOf('ch22') === keyOf('22'));
check('Chapter 22 == 22 (key)', keyOf('Chapter 22') === keyOf('22'));
check('Ch.22 == 22 (key)', keyOf('Ch.22') === keyOf('22'));

// ── Decimals stay distinct ───────────────────────────────────────────────────
check('22.5 -> 22.5', num('22.5').value === 22.5);
check('Ch1.5 -> 1.5', num('Ch1.5').value === 1.5);
check('22.5 != 22 (key)', keyOf('22.5') !== keyOf('22'));

// ── URL forms (the -chapter- segment is authoritative) ───────────────────────
check('url -> 92', num('/title/solo-leveling/9517864-chapter-92').value === 92);
check('url decimal -> 22.5', num('https://comix.to/title/foo/55-chapter-22.5').value === 22.5);
check('url ignores leading id', num('/title/foo/9517864-chapter-92').value === 92);
check('url key == label key', keyOf('/title/foo/123-chapter-92') === keyOf('Ch92'));

// ── Volume / season / part prefixes are stripped ─────────────────────────────
check('Vol 2 Ch 3 -> 3', num('Vol 2 Ch 3').value === 3);
check('Volume 4 Chapter 10.5 -> 10.5', num('Volume 4 Chapter 10.5').value === 10.5);
check('Season 2 Ch 5 -> 5', num('Season 2 Ch 5').value === 5);
check('Part 3 - 12 -> 12', num('Part 3 - 12').value === 12);
check('not the old parseFloat bug (Vol2 Ch3 != 23)', num('Vol2 Ch3').value === 3);

// ── Specials ─────────────────────────────────────────────────────────────────
check('Extra -> special', num('Extra').kind === 'special' && num('Extra').special === 'extra');
check('Side Story -> special', num('Side Story').kind === 'special');
check('Omake -> special', num('Omake').kind === 'special');
check('Bonus -> special', num('Bonus').kind === 'special');
check('Extra 2 -> special w/ value 2', num('Extra 2').kind === 'special' && num('Extra 2').value === 2);

// ── Ranges & garbage never throw ─────────────────────────────────────────────
check('range 100-101 -> 100', num('100-101').value === 100);
check('garbage ??? -> unknown', num('???').kind === 'unknown');
check('empty -> unknown', num('').kind === 'unknown');
check('null -> unknown (no throw)', num(null).kind === 'unknown');
check('undefined -> unknown (no throw)', num(undefined).kind === 'unknown');

// ── sortChapters ─────────────────────────────────────────────────────────────
function labels(list) { return C.sortChapters(list).map((e) => e.chapterLabel); }
check('ascending numeric (the out-of-order bug)',
  JSON.stringify(labels([{ chapterLabel: 'Ch10' }, { chapterLabel: 'Ch2' }, { chapterLabel: 'Ch1' }, { chapterLabel: 'Ch3' }]))
  === JSON.stringify(['Ch1', 'Ch2', 'Ch3', 'Ch10']));
check('decimals interleave',
  JSON.stringify(labels([{ chapterLabel: 'Ch3' }, { chapterLabel: 'Ch2.5' }, { chapterLabel: 'Ch2' }, { chapterLabel: 'Ch10' }]))
  === JSON.stringify(['Ch2', 'Ch2.5', 'Ch3', 'Ch10']));
check('specials sort after numbers',
  JSON.stringify(labels([{ chapterLabel: 'Omake' }, { chapterLabel: 'Ch5' }, { chapterLabel: 'Ch1' }]))
  === JSON.stringify(['Ch1', 'Ch5', 'Omake']));
check('unknown sorts last',
  JSON.stringify(labels([{ chapterLabel: '???' }, { chapterLabel: 'Extra' }, { chapterLabel: 'Ch1' }]))
  === JSON.stringify(['Ch1', 'Extra', '???']));
check('stable for equal keys',
  JSON.stringify(C.sortChapters([{ chapterLabel: 'Ch100', id: 'a' }, { chapterLabel: 'Ch.100', id: 'b' }]).map((e) => e.id))
  === JSON.stringify(['a', 'b']));

// ── dedupeChapters ───────────────────────────────────────────────────────────
function dedupUrls(list) { return C.dedupeChapters(list).map((e) => e.chapterUrl); }
check('two sources of Ch22 -> first kept',
  JSON.stringify(dedupUrls([
    { chapterUrl: '/title/x/111-chapter-22' },
    { chapterUrl: '/title/x/222-chapter-22' }
  ])) === JSON.stringify(['/title/x/111-chapter-22']));
check('url + bare label collapse',
  C.dedupeChapters([{ chapterUrl: '/title/x/111-chapter-22' }, { chapterLabel: 'Ch.22' }]).length === 1);
check('22 and 22.5 stay distinct',
  C.dedupeChapters([{ chapterLabel: 'Ch22' }, { chapterLabel: 'Ch22.5' }]).length === 2);
check('3 sources of 50 + 1 of 51 -> 2',
  C.dedupeChapters([
    { chapterLabel: 'Ch50' }, { chapterLabel: 'Ch50' }, { chapterLabel: 'Ch50' }, { chapterLabel: 'Ch51' }
  ]).length === 2);
check('empty -> empty', C.dedupeChapters([]).length === 0);

// ── computeAdjacentChapter ───────────────────────────────────────────────────
const mk = (nums) => nums.map((n) => ({ chapterUrl: '/title/x/' + (1000 + Math.round(n * 10)) + '-chapter-' + n }));
function adj(list, cur, dir) {
  const node = C.computeAdjacentChapter(list, cur, dir);
  return node ? node.parsed.value : null;
}
check('contiguous next', adj(mk([1, 2, 3, 4]), '/title/x/1020-chapter-2', 1) === 3);
check('contiguous prev', adj(mk([1, 2, 3, 4]), '/title/x/1020-chapter-2', -1) === 1);
// The core requirement: a source-skip gap. Current source jumps 122 -> 125, but 123/124
// exist in other sources, so the full list contains them and next of 122 is 123.
check('gap / source-skip next is 123 not 125',
  adj(mk([121, 122, 123, 124, 125]), '/title/x/2220-chapter-122', 1) === 123);
check('next at max -> null', adj(mk([1, 2, 3]), '/title/x/1030-chapter-3', 1) === null);
check('prev at min -> null', adj(mk([1, 2, 3]), '/title/x/1010-chapter-1', -1) === null);
check('decimal neighbor', adj(mk([22, 22.5, 23]), '/title/x/1220-chapter-22', 1) === 22.5);
check('decimal neighbor 2', adj(mk([22, 22.5, 23]), '/title/x/1225-chapter-22.5', 1) === 23);
check('stale current snaps to nearest then steps',
  adj(mk([10, 20, 30]), '/title/x/9999-chapter-21', 1) === 30);
check('empty list -> null', C.computeAdjacentChapter([], '/title/x/1-chapter-1', 1) === null);

// ── pickCandidateUrl (source preference) ─────────────────────────────────────
const node123 = C.buildChapterIndex([
  { chapterUrl: '/title/x/500-chapter-123' },
  { chapterUrl: '/title/x/900-chapter-123' }
])[0];
check('prefers closest chapter-id source',
  C.pickCandidateUrl(node123, '/title/x/498-chapter-122') === '/title/x/500-chapter-123');
check('single candidate returned',
  C.pickCandidateUrl(C.buildChapterIndex([{ chapterUrl: '/title/x/1-chapter-1' }])[0], '/x') === '/title/x/1-chapter-1');
check('stable when no current id',
  C.pickCandidateUrl(node123, 'no-id-here') === '/title/x/500-chapter-123');

// ── extractChapterPaths ──────────────────────────────────────────────────────
check('extracts paths from text',
  JSON.stringify(C.extractChapterPaths('x /title/foo/12-chapter-3 y /title/foo/13-chapter-4 z'))
  === JSON.stringify(['/title/foo/12-chapter-3', '/title/foo/13-chapter-4']));
check('dedupes repeated paths',
  C.extractChapterPaths('/title/foo/12-chapter-3 /title/foo/12-chapter-3').length === 1);
check('empty text -> []', C.extractChapterPaths('').length === 0);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
