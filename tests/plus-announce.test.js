'use strict';
/**
 * Node unit tests for content/content_plus_announce.js (run: `node tests/plus-announce.test.js`).
 * Covers the decisions that keep the Plus announcement out of the way; the DOM is
 * exercised in a real browser.
 */
const A = require('../content/content_plus_announce.js');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name); }
}

const base = { enabled: true, member: false, kind: 'other', busy: false, seen: false, holdFull: false, autoOpened: false, userMode: '' };
const mode = (patch) => A.decideMode(Object.assign({}, base, patch));

// Page kinds
check('home is an ordinary page', A.pageKind('/home') === 'other');
check('a title page is recognised', A.pageKind('/title/the-spark-in-your-eyes') === 'title');
check('a title page with a trailing slash is recognised', A.pageKind('/title/the-spark-in-your-eyes/') === 'title');
check('a chapter is the reader', A.pageKind('/title/the-spark-in-your-eyes/8123-chapter-12') === 'reader');

// Where it may appear
check('first eligible visit opens full screen', mode({}) === 'full');
check('a seen revision stays in the corner', mode({ seen: true }) === 'mini');
check('the full screen opens once per page session', mode({ autoOpened: true }) === 'mini');
check('a warning on this page keeps it in the corner', mode({ holdFull: true }) === 'mini');
check('reopening from the corner shows full screen', mode({ seen: true, userMode: 'full' }) === 'full');
check('never in the reader', mode({ kind: 'reader', userMode: 'full' }) === 'hidden');
check('never while the Download All panel is open', mode({ busy: true }) === 'hidden');
check('never for Plus members', mode({ member: true }) === 'hidden');
check('never when the setting is off', mode({ enabled: false, userMode: 'full' }) === 'hidden');

// Plus membership comes from the TESTING/Plus build state; the public build has none.
check('no Plus state is not a member', A.isMemberState(undefined) === false);
check('a trial counts as a member', A.isMemberState({ account: { state: 'trial' } }) === true);
check('a cancelled but active subscription counts', A.isMemberState({ account: { state: 'cancelled_active' } }) === true);
check('expired is not a member', A.isMemberState({ account: { state: 'expired' } }) === false);

// The launch phase shows itself briefly, then shrinks into the corner on its own
check('launch opens briefly, then shrinks into the corner by itself', A.autoCloseDelay('launch', false) > 1500 && A.autoCloseDelay('launch', false) < 5000);
check('coming soon stays until the reader closes it', A.autoCloseDelay('soon', false) === 0);
check('a launch full screen the reader reopened stays until closed', A.autoCloseDelay('launch', true) === 0);

// Phases and destinations
check('an unknown phase is treated as coming soon', A.phaseOf({ phase: 'toString' }) === 'soon');
check('coming soon links to the Plus page', A.ctaUrl({ phase: 'soon' }) === 'https://n3uralcreativity.top/comix-downloader/plus.html');
check('launch starts the trial', A.ctaUrl({ phase: 'launch' }) === 'https://plus.n3uralcreativity.top/account?mode=create');
check('the notice can override the destination', A.ctaUrl({ phase: 'launch', ctaUrl: 'https://example.test/x' }) === 'https://example.test/x');
check('a new revision is a new full screen', A.revisionKey({ id: 'plus', updatedAt: '2026-10-01T00:00:00.000Z' }) !== A.revisionKey({ id: 'plus', updatedAt: '2026-10-20T00:00:00.000Z' }));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
