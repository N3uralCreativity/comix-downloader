'use strict';

const assert = require('assert');
const View = require('../core/cdl-agenda-view.js');

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

function entry(name, at, prediction = {}, extra = {}) {
  return {
    mangaName: name,
    titleUrl: `https://comix.to/title/${name.toLowerCase()}`,
    expectedChapterLabel: 'Ch.12',
    eventCount: 6,
    cadenceDays: 7,
    confidence: 82,
    historyStatus: 'ok',
    prediction: {
      level: 'on-schedule',
      instantUtc: at ? at.toISOString() : null,
      precision: 'day',
      uncertaintyDays: 0,
      showTime: false,
      ...prediction,
    },
    ...extra,
  };
}

// Wednesday, September 23 2026, 15:00 local time.
const NOW = new Date(2026, 8, 23, 15, 0);

test('only the /agenda path opens the Agenda page', () => {
  assert.equal(View.PATH, '/agenda');
  assert.equal(View.isAgendaPath('/agenda'), true);
  assert.equal(View.isAgendaPath('/agenda/'), true);
  assert.equal(View.isAgendaPath('/agenda/extra'), false);
  assert.equal(View.isAgendaPath('/title/agenda'), false);
  assert.equal(View.isAgendaPath(''), false);
});

test('weeks start on Monday at local midnight', () => {
  const start = View.startOfWeek(NOW, 0);
  assert.equal(start.getDay(), 1);
  assert.equal(start.getDate(), 21);
  assert.equal(start.getHours(), 0);
  assert.equal(View.startOfWeek(NOW, 1).getDate(), 28);
  assert.equal(View.startOfWeek(NOW, -1).getDate(), 14);
});

test('each entry lands on its day, outside the week, or unscheduled, exactly once', () => {
  const alpha = entry('Alpha', new Date(2026, 8, 24, 18, 0));
  const beta = entry('Beta', new Date(2026, 8, 24, 9, 0));
  const gamma = entry('Gamma', new Date(2026, 8, 30, 12, 0));
  const delta = entry('Delta', null, { level: 'unscheduled', reason: 'irregular' });
  const epsilon = entry('Epsilon', new Date(2026, 8, 25, 12, 0), { level: 'unscheduled' });

  const week = View.buildWeek([alpha, gamma, delta, beta, epsilon], 0, NOW);
  assert.deepEqual(week.days.map((day) => day.entries.map((item) => item.mangaName)),
    [[], [], [], ['Beta', 'Alpha'], [], [], []]);
  assert.deepEqual(week.days.map((day) => day.isToday), [false, false, true, false, false, false, false]);
  assert.deepEqual(week.outside.map((item) => item.mangaName), ['Gamma']);
  assert.deepEqual(week.unscheduled.map((item) => item.mangaName), ['Delta', 'Epsilon']);

  const next = View.buildWeek([alpha, gamma], 1, NOW);
  assert.deepEqual(next.days[2].entries.map((item) => item.mangaName), ['Gamma']);
  assert.deepEqual(next.outside.map((item) => item.mangaName), ['Alpha']);
  assert.equal(next.days.some((day) => day.isToday), false);
});

test('estimate wording never claims more certainty than the model has', () => {
  const day = entry('Alpha', new Date(2026, 8, 24, 18, 0), { uncertaintyDays: 2 });
  assert.match(View.predictionText(day, 'en-US'), /^Most likely Thu, Sep 24 \(\+\/- 2 days\)$/);
  const broad = entry('Beta', new Date(2026, 8, 24), { precision: 'week', uncertaintyDays: 3 });
  assert.match(View.predictionText(broad, 'en-US'), /\(broad estimate, \+\/- 3 days\)$/);
  const undated = entry('Gamma', null, { level: 'unscheduled', reason: 'irregular' });
  assert.equal(View.predictionText(undated), 'Recent releases do not follow one stable interval.');

  assert.equal(View.statusLabel(day), 'On schedule');
  assert.equal(View.statusLabel(entry('Late', NOW, { level: 'late' })), 'Late');
  assert.equal(View.statusLabel(entry('Odd', NOW, { level: 'unknown-level' })), 'Estimated');

  assert.equal(View.timeLabel(broad), 'Broad estimate');
  assert.equal(View.timeLabel(day), '+/- 2 days');
  assert.equal(View.timeLabel(entry('One', NOW, { uncertaintyDays: 1 })), '+/- 1 day');
  assert.equal(View.timeLabel(entry('Exact', NOW)), 'Estimated');
  assert.match(View.timeLabel(entry('Timed', new Date(2026, 8, 24, 18, 0), { showTime: true }), 'en-US'), /^~6:00\sPM$/);
  assert.equal(View.timeLabel(undated), 'Unscheduled');
  assert.equal(View.pattern(day), '7-day pattern / 82% confidence / +/- 2 days');
});

test('title links stay on the comix domain the reader is using', () => {
  assert.equal(View.titlePath({ titleUrl: 'https://comix.to/title/abc-123' }), '/title/abc-123');
  assert.equal(View.titlePath({ titleUrl: 'https://comix.ws/title/abc?group=2' }), '/title/abc?group=2');
  assert.equal(View.titlePath({ titleUrl: '/title/relative' }), '/title/relative');
  assert.equal(View.titlePath({ titleUrl: 'https://evil.example/title/abc' }), null);
  assert.equal(View.titlePath({ titleUrl: 'javascript:alert(1)' }), null);
  assert.equal(View.titlePath({ titleUrl: 'https://comix.to/user' }), null);
  assert.equal(View.titlePath({}), null);
});

test('placeholders and refresh summaries are readable', () => {
  assert.equal(View.initials('solo leveling ragnarok'), 'SL');
  assert.equal(View.initials(''), 'CD');
  assert.equal(View.refreshMessage({ requested: 0, cached: 4 }),
    'Agenda history is current. 4 followed title(s) reused from local history.');
  assert.equal(View.refreshMessage({ requested: 3, analyzed: 3, covers: 1, blocked: 1 }),
    '3 title(s) refreshed / 1 cover(s) recovered / 1 title(s) waiting for access.');
  assert.equal(View.refreshMessage(null), '');
  assert.equal(View.weekLabel(View.startOfWeek(NOW, 0), 'en-US'), 'Sep 21 - Sep 27, 2026');
});

console.log(`agenda-view.test.js: ${passed} tests passed`);
