'use strict';

const assert = require('assert');
const ReviewPrompt = require('../core/review-prompt.js');

class MemoryStorage {
  constructor() {
    this.values = {};
  }

  async get(key) {
    await Promise.resolve();
    return { [key]: this.values[key] };
  }

  async set(values) {
    await Promise.resolve();
    Object.assign(this.values, JSON.parse(JSON.stringify(values)));
  }
}

(async () => {
  const storage = new MemoryStorage();

  const first = await ReviewPrompt.recordSuccessfulDownload(storage);
  assert.strictEqual(first.successfulDownloads, 1);
  assert.strictEqual(first.eligible, false);

  await Promise.all([
    ReviewPrompt.recordSuccessfulDownload(storage),
    ReviewPrompt.recordSuccessfulDownload(storage),
  ]);
  const eligible = await ReviewPrompt.readState(storage);
  assert.strictEqual(eligible.successfulDownloads, ReviewPrompt.SUCCESS_THRESHOLD);
  assert.strictEqual(eligible.eligible, true);
  assert.strictEqual(eligible.shown, false);

  const claims = await Promise.all([
    ReviewPrompt.claimPrompt(storage, '4.2.14', 12345),
    ReviewPrompt.claimPrompt(storage, '4.2.14', 12346),
  ]);
  assert.deepStrictEqual(claims.map((claim) => claim.show), [true, false]);

  const shown = await ReviewPrompt.readState(storage);
  assert.strictEqual(shown.eligible, false);
  assert.strictEqual(shown.shown, true);
  assert.strictEqual(shown.shownAt, 12345);
  assert.strictEqual(shown.shownVersion, '4.2.14');

  await ReviewPrompt.recordSuccessfulDownload(storage);
  const unchanged = await ReviewPrompt.readState(storage);
  assert.strictEqual(unchanged.successfulDownloads, ReviewPrompt.SUCCESS_THRESHOLD);
  assert.strictEqual(unchanged.shown, true);

  const legacy = ReviewPrompt.normalizeState({ successfulDownloads: 8 });
  assert.strictEqual(legacy.eligible, true);
  assert.strictEqual(legacy.shown, false);

  console.log('review-prompt.test.js: all tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
