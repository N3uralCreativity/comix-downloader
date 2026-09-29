'use strict';

const assert = require('assert');
const Agenda = require('../core/cdl-agenda-core.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function event(iso, chapter, precision = 'instant', groupId = '') {
  return {
    chapterKey: `n:${chapter}`,
    chapterLabel: `Ch.${chapter}`,
    chapterUrl: `/title/example/${1000 + chapter}-chapter-${chapter}`,
    uploadedAt: Date.parse(iso),
    observedAt: Date.parse(iso),
    source: 'comix-history',
    precision,
    groupId,
  };
}

const weeklyMondays = [
  event('2026-07-20T12:00:00Z', 1),
  event('2026-07-27T12:00:00Z', 2),
  event('2026-08-03T12:00:00Z', 3),
  event('2026-08-10T12:00:00Z', 4),
  event('2026-08-17T12:00:00Z', 5),
  event('2026-08-24T12:00:00Z', 6),
];

test('relative labels preserve their real precision', () => {
  const now = Date.parse('2026-08-28T12:00:00Z');
  assert.deepEqual(Agenda.parseRelativeAge('4h ago', now), {
    uploadedAt: now - (4 * 60 * 60 * 1000), precision: 'hour',
  });
  assert.equal(Agenda.parseRelativeAge('2 days ago', now).precision, 'day');
  assert.equal(Agenda.parseRelativeAge('3w ago', now).precision, 'week');
  assert.equal(Agenda.parseRelativeAge('1mo ago', now).precision, 'week');
});

test('rendered comix rows become normalized history events', () => {
  const now = Date.parse('2026-08-28T12:00:00Z');
  const result = Agenda.extractChapterEvents({ items: [{
    chapterUrl: '/title/example/123-chapter-8',
    chapterLabel: 'Ch.8',
    createdAtFormatted: '2d ago',
    groupId: '42',
  }] }, { now });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].chapterKey, 'n:8');
  assert.equal(result.events[0].groupId, '42');
  assert.equal(result.events[0].precision, 'day');
  assert.deepEqual(result.tsFields, ['createdAtFormatted']);
});

test('scanlator duplicates use the earliest comix availability', () => {
  const late = event('2026-08-20T12:00:00Z', 10, 'instant', 'late');
  const early = event('2026-08-18T12:00:00Z', 10, 'instant', 'early');
  const merged = Agenda.mergeEventSources([late, early], []);
  const deduped = Agenda.dedupeByChapter(merged);
  assert.equal(merged.length, 2);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].groupId, 'early');
});

test('day-level first-seen evidence replaces a coarse history age for the same chapter', () => {
  const coarse = event('2026-08-17T12:00:00Z', 10, 'week', '42');
  const observed = {
    ...event('2026-08-18T09:00:00Z', 10, 'day'),
    source: 'first-seen',
    groupId: '',
  };
  const deduped = Agenda.dedupeByChapter(Agenda.mergeEventSources([coarse], [observed]));
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].source, 'first-seen');
  assert.equal(deduped[0].precision, 'day');
});

test('a catalogue backfill burst is removed from cadence evidence', () => {
  const burst = Array.from({ length: 7 }, (_, index) => event(
    `2026-06-01T12:${String(index).padStart(2, '0')}:00Z`,
    index + 1
  ));
  const result = Agenda.collapseReleaseEvents(burst);
  assert.equal(result.events.length, 0);
  assert.equal(result.droppedBackfill, 7);
});

test('a normal two-chapter release is one cadence event rather than a zero gap', () => {
  const result = Agenda.collapseReleaseEvents([
    event('2026-08-24T12:00:00Z', 20),
    event('2026-08-24T12:05:00Z', 21),
  ]);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].chapterCount, 2);
  assert.equal(result.droppedBackfill, 0);
});

test('a stable Monday history predicts the following Monday', () => {
  const result = Agenda.buildAgendaEntry(weeklyMondays, {
    now: Date.parse('2026-08-28T12:00:00Z'),
    zoneOffsetMinutes: 0,
    minEvents: 4,
  });
  assert.equal(result.model.cadenceClass, 'weekly');
  assert.equal(result.model.weekday, 1);
  assert.equal(result.prediction.level, 'on-schedule');
  assert.equal(result.prediction.instantUtc, '2026-08-31T12:00:00.000Z');
  assert.equal(result.prediction.inferred, true);
});

test('an overdue prediction remains late instead of rolling into a future cycle', () => {
  const result = Agenda.buildAgendaEntry(weeklyMondays, {
    now: Date.parse('2026-09-03T13:00:00Z'),
    zoneOffsetMinutes: 0,
    minEvents: 4,
  });
  assert.equal(result.prediction.level, 'late');
  assert.equal(result.prediction.instantUtc, '2026-08-31T12:00:00.000Z');
});

test('three missed cycles become hiatus instead of an invented future date', () => {
  const result = Agenda.buildAgendaEntry(weeklyMondays, {
    now: Date.parse('2026-09-21T12:00:00Z'),
    zoneOffsetMinutes: 0,
    minEvents: 4,
  });
  assert.equal(result.prediction.level, 'unscheduled');
  assert.equal(result.prediction.reason, 'hiatus');
  assert.equal(result.prediction.instantUtc, null);
});

test('coarse week labels retain broad uncertainty and a usable point estimate', () => {
  const coarse = weeklyMondays.map((item) => ({ ...item, precision: 'week' }));
  const result = Agenda.buildAgendaEntry(coarse, {
    now: Date.parse('2026-08-28T12:00:00Z'),
    zoneOffsetMinutes: 0,
    minEvents: 4,
  });
  assert.equal(result.prediction.precision, 'week');
  assert.equal(result.prediction.level, 'estimated');
  assert.equal(result.prediction.showTime, false);
  assert.equal(result.prediction.instantUtc, '2026-08-31T12:00:00.000Z');
  assert.ok(result.prediction.uncertaintyDays >= 3.5);
});

test('one day-level anchor can phase a regular coarse weekly history', () => {
  const anchored = weeklyMondays.map((item, index) => ({
    ...item,
    precision: index === weeklyMondays.length - 1 ? 'day' : 'week',
  }));
  const result = Agenda.buildAgendaEntry(anchored, {
    now: Date.parse('2026-08-28T12:00:00Z'),
    zoneOffsetMinutes: 0,
    minEvents: 4,
  });
  assert.equal(result.model.evidencePrecision, 'week');
  assert.equal(result.model.placementPrecision, 'day');
  assert.equal(result.prediction.precision, 'day');
  assert.equal(result.prediction.instantUtc, '2026-08-31T12:00:00.000Z');
  assert.equal(result.prediction.level, 'estimated');
});

test('a 6d then 3d title-page pattern estimates the next chapter today', () => {
  const now = Date.parse('2026-08-28T12:00:00Z');
  const result = Agenda.buildAgendaEntry([
    event('2026-08-22T12:00:00Z', 2, 'day'),
    event('2026-08-25T12:00:00Z', 3, 'day'),
  ], { now, zoneOffsetMinutes: 0 });
  assert.equal(result.model.eventCount, 2);
  assert.equal(result.model.cadenceMs, 3 * 24 * 60 * 60 * 1000);
  assert.equal(result.prediction.instantUtc, '2026-08-28T12:00:00.000Z');
  assert.equal(result.prediction.precision, 'day');
  assert.equal(result.prediction.level, 'estimated');
  assert.ok(result.prediction.uncertaintyDays >= 1);
});

test('recent day ages anchor older coarse history even without one stable weekday', () => {
  const history = [
    event('2026-08-10T12:00:00Z', 1, 'week'),
    event('2026-08-13T12:00:00Z', 2, 'week'),
    event('2026-08-16T12:00:00Z', 3, 'week'),
    event('2026-08-19T12:00:00Z', 4, 'week'),
    event('2026-08-22T12:00:00Z', 5, 'day'),
    event('2026-08-25T12:00:00Z', 6, 'day'),
  ];
  const result = Agenda.buildAgendaEntry(history, {
    now: Date.parse('2026-08-28T12:00:00Z'),
    zoneOffsetMinutes: 0,
  });
  assert.equal(result.model.weekday, null);
  assert.equal(result.model.evidencePrecision, 'week');
  assert.equal(result.model.placementPrecision, 'day');
  assert.equal(result.prediction.instantUtc, '2026-08-28T12:00:00.000Z');
  assert.equal(result.prediction.precision, 'day');
  assert.equal(result.prediction.level, 'estimated');
});

test('one release or a genuinely irregular history stays unscheduled', () => {
  const result = Agenda.buildAgendaEntry(weeklyMondays.slice(0, 1), {
    now: Date.parse('2026-08-28T12:00:00Z'),
  });
  assert.equal(result.prediction.level, 'unscheduled');
  assert.equal(result.prediction.reason, 'insufficient-history');

  const irregular = Agenda.buildAgendaEntry([
    event('2026-07-01T12:00:00Z', 1),
    event('2026-07-02T12:00:00Z', 2),
    event('2026-07-15T12:00:00Z', 3),
    event('2026-07-17T12:00:00Z', 4),
    event('2026-08-20T12:00:00Z', 5),
  ], { now: Date.parse('2026-08-21T12:00:00Z') });
  assert.equal(irregular.prediction.level, 'unscheduled');
  assert.equal(irregular.prediction.reason, 'irregular');
});

console.log(`\nRESULT: ${passed} passed, 0 failed`);
