/**
 * cdl-agenda-core.js — release-cadence inference for the Followed Series Agenda.
 *
 * Pure, DOM-free and network-free so it unit-tests without a browser, in the same
 * shape as cdl-features-core.js / cdl-home-core.js.
 *
 * WHAT THIS PREDICTS: when the next chapter is likely to become available ON
 * COMIX.TO. That is deliberately not the publisher's official publication date —
 * comix mirrors uploads on its own lag, and the reader only cares when they can
 * actually download. Nothing here is ever an announced or official date, and
 * `level` never carries a value that would let the UI claim otherwise.
 *
 * WHY THE TIMESTAMP READ IS FIELD-AGNOSTIC: background.js currently regexes
 * chapter path strings out of the /_next/data/<buildId>/title/<slug>.json payload
 * and discards the enclosing objects, so no field name in that payload has ever
 * been read by this codebase. Rather than hard-code a guess, readTimestamp()
 * sniffs candidate keys by name AND value shape, and reports which key it used
 * via `tsField` so a schema change surfaces as a diagnostic instead of silently
 * producing garbage dates.
 */
(function (global, factory) {
  'use strict';
  var api = factory(global);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.CDLAgendaCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (global) {
  'use strict';

  var HOUR = 3600000, DAY = 24 * HOUR, WEEK = 7 * DAY;

  // Ordered by how well the name implies "when this chapter became available".
  // publish/upload/release beat created; created beats updated (a row edit).
  var TS_KEYS = [
    'publishat', 'publishedat', 'publish', 'published',
    'uploadat', 'uploadedat', 'uploaded',
    'releaseat', 'releasedat', 'released', 'releasedate',
    'availableat', 'readableat',
    'createdat', 'created', 'createdatformatted',
    'chapterupdatedat', 'updatedat', 'updated', 'updatedatformatted',
    'date', 'time', 'timestamp', 'at'
  ];
  var CHAPTER_PATH_RE = /\/title\/[^/\s"']+\/\d+-chapter-[\w.-]+/i;
  var PRECISION_MS = { instant: 60000, hour: HOUR, day: DAY, week: WEEK };
  var REL_UNITS = {
    s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
    m: 60000, min: 60000, mins: 60000, minute: 60000, minutes: 60000,
    h: HOUR, hr: HOUR, hrs: HOUR, hour: HOUR, hours: HOUR,
    d: DAY, day: DAY, days: DAY,
    w: WEEK, wk: WEEK, wks: WEEK, week: WEEK, weeks: WEEK,
    mo: 30 * DAY, mon: 30 * DAY, month: 30 * DAY, months: 30 * DAY,
    y: 365 * DAY, yr: 365 * DAY, year: 365 * DAY, years: 365 * DAY
  };

  function featuresCore() {
    if (global.CDLFeaturesCore) return global.CDLFeaturesCore;
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      try { return require('./cdl-features-core.js'); } catch (_) { /* browser build */ }
    }
    return null;
  }

  // ── chapter identity ────────────────────────────────────────────────────────
  // Reuses CDLFeaturesCore so ch22 / 22 / Chapter 22 collapse exactly as they do
  // everywhere else, and 22.5 stays distinct. Falls back to the raw path segment
  // only if the core module is genuinely unavailable.
  function chapterKeyFor(labelOrUrl) {
    var core = featuresCore();
    if (core && core.parseChapterNumber && core.dedupeKey) {
      return core.dedupeKey(core.parseChapterNumber(labelOrUrl));
    }
    var seg = String(labelOrUrl || '').match(/-chapter-([\w.]+)/i);
    return seg ? 'n:' + parseFloat(seg[1]) : 'u:' + String(labelOrUrl || '').toLowerCase().trim();
  }

  function chapterLabelFor(url) {
    var seg = String(url || '').match(/-chapter-([\w.-]+)/i);
    return seg ? 'Ch. ' + seg[1].replace(/-+$/, '') : '';
  }

  // ── timestamp reading ───────────────────────────────────────────────────────

  /**
   * Parse a human relative age ("3 days ago", "12h ago", "just now", "yesterday")
   * into { uploadedAt, precision }. Precision degrades with the unit, because a
   * value rendered as "2 months ago" carries roughly +/-15 days of real error and
   * must never be treated as if it pinned a day.
   */
  function parseRelativeAge(text, nowMs) {
    var s = String(text == null ? '' : text).toLowerCase().trim();
    if (!s) return null;
    var now = nowMs == null ? Date.now() : nowMs;
    if (/^(just now|now|moments? ago)$/.test(s)) return { uploadedAt: now, precision: 'hour' };
    if (/^yesterday$/.test(s)) return { uploadedAt: now - DAY, precision: 'day' };
    var m = s.match(/^(?:about\s+|~\s*)?(\d+(?:\.\d+)?)\s*([a-z]+)\.?\s*(?:ago)?$/);
    if (!m) return null;
    var unit = REL_UNITS[m[2]];
    if (!unit) return null;
    var uploadedAt = now - parseFloat(m[1]) * unit;
    var precision = unit <= HOUR ? 'hour' : unit <= DAY ? 'day' : 'week';
    return { uploadedAt: uploadedAt, precision: precision };
  }

  /**
   * Interpret one candidate value as an instant. Handles ISO-8601, epoch seconds,
   * epoch milliseconds, bare YYYY-MM-DD, and relative-age strings. Returns null
   * for anything it cannot read confidently — a wrong date is worse than none.
   */
  function readTimestampValue(value, nowMs) {
    if (value == null) return null;
    if (typeof value === 'number' && isFinite(value)) {
      if (value > 1e12 && value < 4e12) return { uploadedAt: value, precision: 'instant' };
      if (value > 1e9 && value < 4e9) return { uploadedAt: value * 1000, precision: 'instant' };
      return null;
    }
    if (typeof value !== 'string') return null;
    var s = value.trim();
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      var d = Date.parse(s + 'T00:00:00Z');
      return isFinite(d) ? { uploadedAt: d, precision: 'day' } : null;
    }
    if (/^\d{4}-\d{2}-\d{2}[T ]/.test(s)) {
      var t = Date.parse(s);
      return isFinite(t) ? { uploadedAt: t, precision: 'instant' } : null;
    }
    if (/^\d{10}$|^\d{13}$/.test(s)) return readTimestampValue(Number(s), nowMs);
    return parseRelativeAge(s, nowMs);
  }

  /**
   * Find the best timestamp on a chapter object without knowing the schema.
   * Returns { uploadedAt, precision, tsField } or null. tsField is reported so the
   * caller can log which key actually carried the date on this build of the site.
   */
  function readTimestamp(node, nowMs) {
    if (!node || typeof node !== 'object') return null;
    var keys = Object.keys(node), lower = {}, i;
    for (i = 0; i < keys.length; i++) lower[keys[i].toLowerCase()] = keys[i];
    for (i = 0; i < TS_KEYS.length; i++) {
      var real = lower[TS_KEYS[i]];
      if (!real) continue;
      var hit = readTimestampValue(node[real], nowMs);
      if (hit) { hit.tsField = real; return hit; }
    }
    // Nothing matched by name — accept any key whose VALUE is unambiguously an
    // ISO instant, so an unexpected field name still yields a usable date.
    for (i = 0; i < keys.length; i++) {
      var v = node[keys[i]];
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:/.test(v)) {
        var got = readTimestampValue(v, nowMs);
        if (got) { got.tsField = keys[i]; return got; }
      }
    }
    return null;
  }

  function firstChapterUrl(node) {
    var keys = Object.keys(node);
    for (var i = 0; i < keys.length; i++) {
      var v = node[keys[i]];
      if (typeof v === 'string' && CHAPTER_PATH_RE.test(v)) return (v.match(CHAPTER_PATH_RE) || [''])[0];
    }
    return '';
  }

  function readGroupId(node) {
    var keys = Object.keys(node);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i].toLowerCase();
      if (k !== 'groupid' && k !== 'group_id' && k !== 'teamid') continue;
      var v = node[keys[i]];
      if (v != null && (typeof v === 'string' || typeof v === 'number')) return String(v);
    }
    var g = node.group || node.team || node.scanlator;
    if (g && typeof g === 'object' && g.id != null) return String(g.id);
    return '';
  }

  /**
   * Walk a parsed _next/data payload (or a JSON string) and pull one raw event per
   * chapter object that carries both a chapter path and a readable timestamp.
   * Never throws; returns { events, tsFields, scanned } so a caller can tell
   * "no dates in this payload" apart from "payload did not parse".
   */
  function extractChapterEvents(payload, options) {
    var opts = options || {};
    var nowMs = opts.now == null ? Date.now() : opts.now;
    var data = payload;
    if (typeof payload === 'string') {
      try { data = JSON.parse(payload); } catch (_) { return { events: [], tsFields: [], scanned: 0, parsed: false }; }
    }
    var events = [], fields = {}, scanned = 0, seenNodes = 0;
    var MAX_NODES = 200000;

    (function walk(node) {
      if (!node || typeof node !== 'object' || seenNodes > MAX_NODES) return;
      seenNodes += 1;
      if (Array.isArray(node)) { for (var i = 0; i < node.length; i++) walk(node[i]); return; }
      var url = firstChapterUrl(node);
      if (url) {
        scanned += 1;
        var ts = readTimestamp(node, nowMs);
        if (ts) {
          fields[ts.tsField] = (fields[ts.tsField] || 0) + 1;
          events.push({
            chapterKey: chapterKeyFor(url),
            chapterLabel: chapterLabelFor(url),
            chapterUrl: url,
            uploadedAt: ts.uploadedAt,
            observedAt: nowMs,
            source: 'comix-history',
            precision: ts.precision,
            groupId: readGroupId(node)
          });
        }
      }
      var keys = Object.keys(node);
      for (var k = 0; k < keys.length; k++) walk(node[keys[k]]);
    })(data);

    return {
      events: events,
      tsFields: Object.keys(fields).sort(function (a, b) { return fields[b] - fields[a]; }),
      scanned: scanned,
      parsed: true
    };
  }

  // ── normalisation ───────────────────────────────────────────────────────────

  /**
   * One canonical chapter can appear once per scanlation group in comix's
   * "All groups" view. Collapse to a single event: the preferred group when the
   * reader has one, otherwise the EARLIEST upload — that is the instant the
   * chapter actually became available to them.
   */
  function dedupeByChapter(events, options) {
    var opts = options || {};
    var preferred = opts.preferredGroupId == null ? '' : String(opts.preferredGroupId);
    var best = Object.create(null);
    (events || []).forEach(function (ev) {
      if (!ev || !isFinite(ev.uploadedAt)) return;
      var cur = best[ev.chapterKey];
      if (!cur) { best[ev.chapterKey] = ev; return; }
      var evPref = preferred && ev.groupId === preferred;
      var curPref = preferred && cur.groupId === preferred;
      if (evPref && !curPref) { best[ev.chapterKey] = ev; return; }
      if (curPref && !evPref) return;
      // A first-seen observation can pin a day that an older "2w ago" history
      // label cannot. Prefer it only when its precision is genuinely finer;
      // equal-precision scanlator rows still use the earliest availability.
      if (ev.source !== cur.source) {
        var evRank = PRECISION_MS[ev.precision] == null ? Infinity : PRECISION_MS[ev.precision];
        var curRank = PRECISION_MS[cur.precision] == null ? Infinity : PRECISION_MS[cur.precision];
        if (evRank < curRank) { best[ev.chapterKey] = ev; return; }
        if (curRank < evRank) return;
      }
      if (ev.uploadedAt < cur.uploadedAt) best[ev.chapterKey] = ev;
    });
    return Object.keys(best).map(function (k) { return best[k]; })
      .sort(function (a, b) { return a.uploadedAt - b.uploadedAt; });
  }

  /**
   * Group chapters published together into single RELEASE EVENTS, and drop
   * back-catalogue dumps entirely.
   *
   * A group posting ch.41 and ch.42 in one sitting performed one publishing act;
   * counting two creates a spurious near-zero gap that drags every statistic
   * downstream. A burst larger than backfillMin is not a release at all — it is a
   * series being seeded onto the site — so it is excluded rather than collapsed,
   * otherwise the seed date becomes a fake "release" anchoring the cadence.
   */
  function collapseReleaseEvents(events, options) {
    var opts = options || {};
    var burst = opts.burstWindowMs == null ? 12 * HOUR : opts.burstWindowMs;
    var backfillMin = opts.backfillMin == null ? 6 : opts.backfillMin;
    var backfillWindow = opts.backfillWindowMs == null ? 6 * HOUR : opts.backfillWindowMs;
    var sorted = (events || []).slice().sort(function (a, b) { return a.uploadedAt - b.uploadedAt; });
    var out = [], dropped = 0, i = 0;
    while (i < sorted.length) {
      var cluster = [sorted[i]], j = i + 1;
      while (j < sorted.length && sorted[j].uploadedAt - cluster[0].uploadedAt <= burst) {
        cluster.push(sorted[j]); j += 1;
      }
      var span = cluster[cluster.length - 1].uploadedAt - cluster[0].uploadedAt;
      if (cluster.length >= backfillMin && span <= backfillWindow) {
        dropped += cluster.length;
      } else {
        var head = cluster[0];
        out.push({
          chapterKey: head.chapterKey,
          chapterLabel: head.chapterLabel,
          uploadedAt: head.uploadedAt,
          observedAt: head.observedAt,
          source: head.source,
          precision: cluster.reduce(function (worst, e) {
            return PRECISION_MS[e.precision] > PRECISION_MS[worst] ? e.precision : worst;
          }, 'instant'),
          groupId: head.groupId,
          chapterCount: cluster.length
        });
      }
      i = j;
    }
    return { events: out, droppedBackfill: dropped };
  }

  // ── statistics ──────────────────────────────────────────────────────────────

  function median(values) {
    if (!values.length) return NaN;
    var s = values.slice().sort(function (a, b) { return a - b; }), mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function localParts(ms, offsetMinutes) {
    // offsetMinutes === null means "use the host's local zone"; a number pins the
    // zone so tests are deterministic and so a caller can pin a source zone.
    var d = new Date(offsetMinutes == null ? ms : ms + offsetMinutes * 60000);
    return offsetMinutes == null
      ? { weekday: d.getDay(), minutes: d.getHours() * 60 + d.getMinutes() }
      : { weekday: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
  }

  /**
   * Circular mean of times-of-day. A naive arithmetic mean of 23:50 and 00:10
   * returns 12:00 — the single worst answer available — so this projects each
   * time onto the unit circle. Returns { minutes, spreadMinutes, strength }.
   */
  function circularTimeOfDay(minuteValues) {
    if (!minuteValues.length) return null;
    var sx = 0, sy = 0;
    minuteValues.forEach(function (m) {
      var a = (m / 1440) * 2 * Math.PI;
      sx += Math.cos(a); sy += Math.sin(a);
    });
    sx /= minuteValues.length; sy /= minuteValues.length;
    var R = Math.sqrt(sx * sx + sy * sy);
    if (R < 1e-6) return { minutes: null, spreadMinutes: 1440, strength: 0 };
    var ang = Math.atan2(sy, sx);
    if (ang < 0) ang += 2 * Math.PI;
    var spreadRad = Math.sqrt(Math.max(0, -2 * Math.log(Math.min(1, R))));
    return {
      minutes: Math.round((ang / (2 * Math.PI)) * 1440) % 1440,
      spreadMinutes: Math.round((spreadRad / (2 * Math.PI)) * 1440),
      strength: R
    };
  }

  function classifyCadence(ms) {
    if (!isFinite(ms)) return 'irregular';
    if (ms <= 30 * HOUR) return 'daily';
    if (ms <= 10 * DAY) return 'weekly';
    if (ms <= 18 * DAY) return 'biweekly';
    if (ms <= 45 * DAY) return 'monthly';
    return 'irregular';
  }

  /**
   * Estimate the release model from collapsed events.
   *
   * MEDIAN, NOT MEAN, and MAD, NOT STANDARD DEVIATION: manga release histories are
   * long-tailed and punctuated by illness breaks, Golden Week, New Year and
   * volume-prep weeks. A single 90-day hiatus pulls the mean of a 12-gap window
   * from 7 days to roughly 14 — a 100% error that would place every card in the
   * wrong week, on exactly the popular series a reader checks first.
   */
  function estimateCadence(events, options) {
    var opts = options || {};
    var now = opts.now == null ? Date.now() : opts.now;
    var offset = opts.zoneOffsetMinutes === undefined ? null : opts.zoneOffsetMinutes;
    var windowSize = opts.windowSize == null ? 12 : opts.windowSize;
    // Two distinct release events are enough to form one tentative interval.
    // More observations improve confidence, but making readers wait for five
    // chapters defeats title-page backfill: a visible "6d ago -> 3d ago" pattern
    // already supports a useful, clearly estimated next-day placement.
    var minEvents = opts.minEvents == null ? 2 : Math.max(2, opts.minEvents);

    var all = (events || []).slice().sort(function (a, b) { return a.uploadedAt - b.uploadedAt; });
    var recent = all.slice(-windowSize);
    if (recent.length < minEvents) {
      return { ok: false, reason: 'insufficient-history', eventCount: recent.length, needed: minEvents };
    }

    var gaps = [], i;
    for (i = 1; i < recent.length; i++) gaps.push(recent[i].uploadedAt - recent[i - 1].uploadedAt);

    var m0 = median(gaps);
    var accepted = gaps.filter(function (g) { return g >= 0.5 * m0 && g <= 2 * m0; });
    var hiatusGaps = gaps.filter(function (g) { return g > 2 * m0; });
    // A two-event history necessarily has one gap. Once multiple gaps exist,
    // require at least two of them to agree so one accidental interval cannot
    // schedule an otherwise irregular title.
    if (accepted.length < (gaps.length === 1 ? 1 : 2)) {
      return { ok: false, reason: 'irregular', eventCount: recent.length, cadenceClass: 'irregular' };
    }

    // Changepoint: a series that switched cadence mid-run should converge on its
    // NEW rhythm rather than being anchored by two-year-old behaviour.
    var cadenceChanged = false;
    if (accepted.length >= 6) {
      var half = accepted.slice(Math.ceil(accepted.length / 2));
      var older = accepted.slice(0, Math.floor(accepted.length / 2));
      var mRecent = median(half), mOlder = median(older);
      if (isFinite(mOlder) && mOlder > 0 && Math.abs(mRecent - mOlder) > 0.5 * mOlder && half.length >= 3) {
        accepted = half; cadenceChanged = true;
      }
    }

    var cadenceMs = median(accepted);
    var mad = median(accepted.map(function (g) { return Math.abs(g - cadenceMs); }));
    var regularity = cadenceMs > 0 ? 1 - Math.min(1, mad / cadenceMs) : 0;
    // A single gap has no variance by definition, not proof of perfect
    // regularity. Keep it useful while capping its confidence until more
    // releases corroborate the interval.
    if (accepted.length === 1) regularity *= 0.65;
    else if (accepted.length === 2) regularity *= 0.82;
    var cadenceClass = classifyCadence(cadenceMs);

    // Weekday and time-of-day are only meaningful for sub-monthly rhythms.
    var weekdayCounts = {}, minuteValues = [], modalWeekday = null, weekdayShare = 0;
    var datedEvents = recent.filter(function (e) { return PRECISION_MS[e.precision] <= DAY; });
    datedEvents.forEach(function (e) {
      var p = localParts(e.uploadedAt, offset);
      weekdayCounts[p.weekday] = (weekdayCounts[p.weekday] || 0) + 1;
      if (PRECISION_MS[e.precision] <= HOUR) minuteValues.push(p.minutes);
    });
    Object.keys(weekdayCounts).forEach(function (w) {
      if (weekdayCounts[w] > weekdayShare) { weekdayShare = weekdayCounts[w]; modalWeekday = Number(w); }
    });
    var weekdayStability = datedEvents.length ? weekdayShare / datedEvents.length : 0;
    if (cadenceClass === 'monthly' || cadenceClass === 'irregular') weekdayStability = 0.5;
    if (weekdayStability < 0.6 || cadenceClass === 'monthly' || cadenceClass === 'irregular') modalWeekday = null;

    var tod = minuteValues.length >= 3 ? circularTimeOfDay(minuteValues) : null;
    var last = recent[recent.length - 1];
    var sinceLast = now - last.uploadedAt;
    var overdueCycles = cadenceMs > 0 ? sinceLast / cadenceMs : 0;
    var recency = overdueCycles <= 1.5 ? 1 : overdueCycles >= 3 ? 0 : 1 - (overdueCycles - 1.5) / 1.5;
    var depth = Math.max(0, Math.min(1, (recent.length - 4) / 8));

    // Hiatus is REVERSIBLE and is never recorded as a permanent classification —
    // it is recomputed from the current clock on every call, so one new chapter
    // clears it immediately.
    var onHiatus = overdueCycles >= 3 && sinceLast > 21 * DAY;

    var score = 0.40 * regularity + 0.20 * depth + 0.20 * weekdayStability + 0.20 * recency;
    var evidencePrecision = recent.reduce(function (worst, e) {
      return PRECISION_MS[e.precision] > PRECISION_MS[worst] ? e.precision : worst;
    }, 'instant');
    var placementPrecision = evidencePrecision;
    // Older 1w/2w labels widen uncertainty, but they must not erase the phase
    // supplied by the latest 3d/6d-style rows. Once the newest release is known
    // to day precision, adding the inferred median interval produces a useful
    // most-likely day even when releases move across weekdays (for example a
    // chapter every three days). It remains "estimated" until enough precise
    // observations support a stronger label.
    if (evidencePrecision === 'week'
      && PRECISION_MS[last.precision] <= DAY
      && regularity >= 0.45
      && cadenceClass !== 'irregular') {
      placementPrecision = 'day';
    }

    var sourceUncertaintyMs = evidencePrecision === 'week'
      ? 3.5 * DAY
      : evidencePrecision === 'day' ? 0.5 * DAY
        : evidencePrecision === 'hour' ? 0.5 * HOUR : 60000;
    var sampleUncertaintyMs = recent.length <= 2
      ? cadenceMs * 0.25
      : recent.length <= 4 ? cadenceMs * 0.125 : 0;
    var uncertaintyMs = Math.max(sourceUncertaintyMs, mad || 0, sampleUncertaintyMs);

    return {
      ok: true,
      eventCount: recent.length,
      cadenceMs: cadenceMs,
      cadenceClass: cadenceClass,
      madMs: mad,
      regularity: regularity,
      depth: depth,
      weekday: modalWeekday,
      weekdayStability: weekdayStability,
      timeOfDay: tod && tod.minutes != null ? tod.minutes : null,
      timeSpreadMinutes: tod ? tod.spreadMinutes : null,
      recency: recency,
      overdueCycles: overdueCycles,
      onHiatus: onHiatus,
      cadenceChanged: cadenceChanged,
      hiatusGapCount: hiatusGaps.length,
      lastEventAt: last.uploadedAt,
      score: score,
      preciseEventCount: datedEvents.length,
      uncertaintyMs: uncertaintyMs,
      // Keep both values: evidencePrecision describes the raw history, while
      // placementPrecision may use a precise recent anchor to phase a regular
      // weekly rhythm without pretending every historical date was exact.
      evidencePrecision: evidencePrecision,
      placementPrecision: placementPrecision
    };
  }

  /**
   * Turn a model into a placement. Levels are exactly: on-schedule | estimated |
   * unscheduled, plus the derived `late`. There is deliberately NO "announced"
   * level — no reachable source publishes forward manga chapter dates, so the
   * vocabulary offers no way to render an inferred date as an official one.
   */
  function predictNext(model, options) {
    var opts = options || {};
    var now = opts.now == null ? Date.now() : opts.now;
    var offset = opts.zoneOffsetMinutes === undefined ? null : opts.zoneOffsetMinutes;
    // An observation that came from polling can never be sharper than the poll.
    var pollMs = (opts.pollIntervalMinutes == null ? 360 : opts.pollIntervalMinutes) * 60000;

    if (!model || !model.ok) {
      return { level: 'unscheduled', reason: (model && model.reason) || 'insufficient-history', instantUtc: null, precision: null };
    }
    if (model.onHiatus) {
      return { level: 'unscheduled', reason: 'hiatus', instantUtc: null, precision: null, lastEventAt: model.lastEventAt };
    }
    if (model.cadenceClass === 'irregular' || model.score < 0.45) {
      return { level: 'unscheduled', reason: 'irregular', instantUtc: null, precision: null, score: model.score };
    }

    var next = model.lastEventAt + model.cadenceMs;
    // Snap to the modal weekday when the rhythm supports it, but only by up to
    // half a cadence so snapping can never move a card into the wrong week.
    if (model.weekday != null && (model.cadenceClass === 'weekly' || model.cadenceClass === 'biweekly')) {
      var p = localParts(next, offset);
      var delta = model.weekday - p.weekday;
      if (delta > 3) delta -= 7;
      if (delta < -3) delta += 7;
      if (Math.abs(delta * DAY) <= model.cadenceMs / 2) next += delta * DAY;
    }
    var precision = model.placementPrecision || model.evidencePrecision;
    // Never print a time the evidence cannot support: a time-of-day is only
    // rendered when the observed spread is tighter than the sampling interval
    // that produced it, otherwise the "cluster" is an artefact of the poll rhythm.
    var canShowTime = precision === 'instant'
      && model.timeSpreadMinutes != null
      && model.timeSpreadMinutes * 60000 < Math.max(pollMs, HOUR)
      && model.timeOfDay != null;
    if (!canShowTime && PRECISION_MS[precision] < DAY) precision = 'day';

    var level = (model.score >= 0.75
      && model.eventCount >= 6
      && model.regularity >= 0.7
      && model.preciseEventCount >= 3)
      ? 'on-schedule' : 'estimated';
    var late = next < now && (now - next) > Math.min(2 * DAY, model.cadenceMs / 2);

    return {
      level: late ? 'late' : level,
      baseLevel: level,
      instantUtc: new Date(next).toISOString(),
      instantMs: next,
      precision: precision,
      evidencePrecision: model.evidencePrecision,
      uncertaintyDays: Math.round((model.uncertaintyMs / DAY) * 2) / 2,
      showTime: canShowTime,
      timeOfDayMinutes: canShowTime ? model.timeOfDay : null,
      weekday: model.weekday,
      score: model.score,
      cadenceClass: model.cadenceClass,
      // Always true for every value this function can return. Callers render it
      // as an estimate; nothing here is announced by a publisher.
      inferred: true
    };
  }

  /**
   * One-call pipeline: raw events (history + first-seen) -> placement.
   * `merge` keeps backfilled history and locally observed first-seen stamps in one
   * ordered series, preferring the recorded upload time when both describe the
   * same chapter, since first-seen carries the poll interval as error.
   */
  function buildAgendaEntry(rawEvents, options) {
    var opts = options || {};
    var deduped = dedupeByChapter(rawEvents, opts);
    var collapsed = collapseReleaseEvents(deduped, opts);
    var model = estimateCadence(collapsed.events, opts);
    var prediction = predictNext(model, opts);
    return {
      events: collapsed.events,
      droppedBackfill: collapsed.droppedBackfill,
      model: model,
      prediction: prediction
    };
  }

  function mergeEventSources(historyEvents, observedEvents) {
    // Keep scanlator variants until dedupeByChapter runs. Collapsing here by
    // chapter key would make the last rendered group win, even though the first
    // group to upload is what defines availability on comix.to.
    return (historyEvents || []).concat(observedEvents || [])
      .filter(function (event) { return event && event.chapterKey && isFinite(event.uploadedAt); })
      .sort(function (a, b) { return a.uploadedAt - b.uploadedAt; });
  }

  return {
    PRECISION_MS: PRECISION_MS,
    parseRelativeAge: parseRelativeAge,
    readTimestampValue: readTimestampValue,
    readTimestamp: readTimestamp,
    extractChapterEvents: extractChapterEvents,
    chapterKeyFor: chapterKeyFor,
    dedupeByChapter: dedupeByChapter,
    collapseReleaseEvents: collapseReleaseEvents,
    estimateCadence: estimateCadence,
    predictNext: predictNext,
    buildAgendaEntry: buildAgendaEntry,
    mergeEventSources: mergeEventSources,
    __test: { median: median, circularTimeOfDay: circularTimeOfDay, classifyCadence: classifyCadence, localParts: localParts }
  };
});
