// Run: node --test src/js/timeguard.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const guard = require('./timeguard.js');

/** A WebAPIException stand-in: the Timer API throws objects with a `name`. */
function webApiError(name) {
  return { name: name, code: 0, message: 'Unable to Set' };
}

/** A fake webapis.timer whose setNTP refuses by a rule and remembers every call. */
function fakeTimer(options) {
  const opts = options || {};
  const calls = [];

  return {
    calls: calls,
    getNTP: () => {
      if (opts.getThrows) {
        throw webApiError(opts.getThrows);
      }

      return opts.ntp;
    },
    setNTP: (info) => {
      calls.push(info);
      const refusal = opts.refuse ? opts.refuse(info, calls.length) : null;
      if (refusal) {
        throw webApiError(refusal);
      }
    },
  };
}

/** A fetch stand-in answering with the given headers, or rejecting. */
function fakeFetch(headers, rejectWith) {
  return () => {
    if (rejectWith) {
      return Promise.reject(rejectWith);
    }

    return Promise.resolve({
      status: 200,
      headers: { get: (name) => (name === 'date' ? headers.date || null : null) },
    });
  };
}

/** A clock that returns the given readings in order, then keeps the last one. */
function fakeNow(readings) {
  let i = 0;

  return () => {
    const value = readings[Math.min(i, readings.length - 1)];
    i += 1;

    return value;
  };
}

test('candidates: every zone with the host name first, then every zone with the bare address', () => {
  const pairs = guard.candidates();
  assert.equal(pairs.length, 6);
  assert.deepEqual(pairs[0], { address: 'pool.ntp.org', timeZone: 'Europe/Stockholm', own: false });
  assert.deepEqual(pairs[1], { address: 'pool.ntp.org', timeZone: 'Europe/Amsterdam', own: false });
  assert.deepEqual(pairs[2], { address: 'pool.ntp.org', timeZone: 'Europe/Paris', own: false });
  assert.deepEqual(pairs[3], { address: '216.239.35.0', timeZone: 'Europe/Stockholm', own: false });
  assert.deepEqual(pairs[5], { address: '216.239.35.0', timeZone: 'Europe/Paris', own: false });
});

test('candidates: the zone the panel\'s wall clock has leads, the CET defaults follow, no duplicates', () => {
  // The certificate problem is a UTC problem; a Finnish panel keeps Helsinki.
  const pairs = guard.candidates(undefined, 'Europe/Helsinki');
  assert.equal(pairs.length, 8);
  assert.deepEqual(pairs[0], { address: 'pool.ntp.org', timeZone: 'Europe/Helsinki', own: true });
  assert.deepEqual(pairs[1], { address: 'pool.ntp.org', timeZone: 'Europe/Stockholm', own: false });
  assert.deepEqual(pairs[4], { address: '216.239.35.0', timeZone: 'Europe/Helsinki', own: true });
  assert.equal(guard.candidates(undefined, 'Europe/Paris').length, 6, 'a zone already in the defaults is not listed twice');
  assert.deepEqual(guard.candidates(undefined, 'Europe/Paris')[0], { address: 'pool.ntp.org', timeZone: 'Europe/Paris', own: false },
    'a default moved to the front is still a default: a refusal of it stops the search');
  assert.equal(guard.candidates(undefined, '').length, 6, 'an empty zone is no zone');
  assert.equal(guard.candidates(undefined, '   ').length, 6, 'a blank zone is no zone');
  assert.equal(guard.candidates({}).length, 6);
  assert.equal(guard.candidates(undefined).length, 6);
  assert.equal(guard.candidates(undefined, 42).length, 6, 'a non-string zone is no zone');
});

test('candidates: the zone getNTP() reports counts only while NTP is ON; OFF reports a placeholder', () => {
  // Measured on a QB43C 2026-11-11: NTP off, menu and tizen.time on
  // Europe/Stockholm, getNTP() said Africa/Casablanca. Applying THAT would
  // have moved the wall clock to Morocco.
  const off = guard.candidates({ use: 'OFF', address: '', timeZone: 'Africa/Casablanca' });
  assert.equal(off.length, 6);
  assert.equal(off.some((pair) => pair.timeZone === 'Africa/Casablanca'), false, 'the placeholder is never tried');
  assert.equal(guard.candidates({ timeZone: 'Africa/Casablanca' }).length, 6, 'no use field at all: the zone is not trusted either');
  assert.deepEqual(guard.candidates({ use: 'ON', address: 'pool.ntp.org', timeZone: 'Europe/Helsinki' })[0],
    { address: 'pool.ntp.org', timeZone: 'Europe/Helsinki', own: true }, 'NTP on: the reported zone is the one in force');
  assert.deepEqual(guard.candidates({ use: 'ON', address: 'pool.ntp.org', timeZone: 'Europe/Paris' }, 'Europe/Helsinki')[0],
    { address: 'pool.ntp.org', timeZone: 'Europe/Helsinki', own: true }, 'the wall clock beats what getNTP() says');
  assert.equal(guard.candidates({ use: 'ON', address: 'pool.ntp.org', timeZone: 'Europe/Paris' }, 'Europe/Helsinki').length, 8,
    'the getNTP() zone is not added as a second own zone');
});

test('readLocalZone: the Time API\'s zone, or nothing', () => {
  assert.equal(guard.readLocalZone({ getLocalTimezone: () => 'Europe/Stockholm' }), 'Europe/Stockholm');
  assert.equal(guard.readLocalZone({ getLocalTimezone: () => ' Europe/Stockholm ' }), 'Europe/Stockholm', 'trimmed');
  assert.equal(guard.readLocalZone({ getLocalTimezone: () => { throw webApiError('SecurityError'); } }), '');
  assert.equal(guard.readLocalZone({ getLocalTimezone: () => 42 }), '', 'a non-string is no zone');
  assert.equal(guard.readLocalZone({}), '');
  assert.equal(guard.readLocalZone(undefined), '');
});

test('candidates: an NTP server the panel already has leads too; a customer\'s internal server is kept', () => {
  // Outbound NTP blocked at the router, internal server set in the menu, a
  // power cut resets the clock below the floor: the guard must put THAT
  // server back, not an unreachable public one.
  const pairs = guard.candidates({ use: 'ON', address: '10.0.0.5', timeZone: 'Europe/Helsinki' });
  assert.equal(pairs.length, 12);
  assert.deepEqual(pairs[0], { address: '10.0.0.5', timeZone: 'Europe/Helsinki', own: true });
  assert.deepEqual(pairs[1], { address: '10.0.0.5', timeZone: 'Europe/Stockholm', own: true });
  assert.deepEqual(pairs[4], { address: 'pool.ntp.org', timeZone: 'Europe/Helsinki', own: true });
  assert.deepEqual(pairs[5], { address: 'pool.ntp.org', timeZone: 'Europe/Stockholm', own: false });
  assert.equal(guard.candidates({ use: 'ON', address: 'pool.ntp.org' }).length, 6, 'an own address already among the defaults is not listed twice');
  assert.deepEqual(guard.candidates({ use: 'ON', address: ' 10.0.0.5 ' })[0].address, '10.0.0.5', 'trimmed');
});

test('candidates: a stale address on a panel with NTP OFF is ignored; the wall-clock zone is still kept', () => {
  // Nobody chose that address while NTP was off; writing it back would make
  // the first try succeed and the defaults never run.
  const pairs = guard.candidates({ use: 'OFF', address: 'stale.example', timeZone: 'Africa/Casablanca' }, 'Europe/Helsinki');
  assert.equal(pairs.length, 8);
  assert.deepEqual(pairs[0], { address: 'pool.ntp.org', timeZone: 'Europe/Helsinki', own: true });
  assert.equal(pairs.some((pair) => pair.address === 'stale.example'), false);
  assert.equal(guard.candidates({ address: 'stale.example' }).length, 6, 'no use field at all: the address is not trusted');
});

test('candidates: every zone is CET/CEST, so whichever the firmware takes gives the same wall clock', () => {
  // A zone with a different offset would make "which one was accepted" matter.
  const probe = new Date('2026-01-15T12:00:00Z');
  const offsets = guard.TIME_ZONES.map((zone) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', hour12: false }).format(probe)
  );
  assert.deepEqual(offsets, ['13', '13', '13']);
});

test('driftFromDateHeader: the midpoint of the round trip stands in for the server stamp', () => {
  // Server says 12:00:00.000; local clock read 12:00:10.000 before and
  // 12:00:12.000 after: midpoint 12:00:11 => panel is 11 s ahead.
  const server = Date.parse('Thu, 12 Nov 2026 12:00:00 GMT');
  assert.equal(guard.driftFromDateHeader('Thu, 12 Nov 2026 12:00:00 GMT', server + 10000, server + 12000), 11);
});

test('driftFromDateHeader: the midpoint is rounded to the nearest second, not truncated', () => {
  // Midpoint 1.5 s ahead rounds to 2; 1.4 s rounds to 1; -1.5 s rounds to -1 (JS rounds half up).
  const server = Date.parse('Thu, 12 Nov 2026 12:00:00 GMT');
  assert.equal(guard.driftFromDateHeader('Thu, 12 Nov 2026 12:00:00 GMT', server + 1000, server + 2000), 2);
  assert.equal(guard.driftFromDateHeader('Thu, 12 Nov 2026 12:00:00 GMT', server + 1000, server + 1800), 1);
  assert.equal(guard.driftFromDateHeader('Thu, 12 Nov 2026 12:00:00 GMT', server - 1000, server - 2000), -1);
});

test('driftFromDateHeader: a panel behind the server reads negative', () => {
  const server = Date.parse('Thu, 12 Nov 2026 12:00:00 GMT');
  assert.equal(guard.driftFromDateHeader('Thu, 12 Nov 2026 12:00:00 GMT', server - 3600000, server - 3600000), -3600);
});

test('driftFromDateHeader: no header or an unparseable one is null, not zero', () => {
  // Zero would read as "clock is fine" on the one panel where nothing was measured.
  assert.equal(guard.driftFromDateHeader(null, 1000, 2000), null);
  assert.equal(guard.driftFromDateHeader('', 1000, 2000), null);
  assert.equal(guard.driftFromDateHeader('not a date', 1000, 2000), null);
});

test('readNtp: absent off a panel, unreadable on a throw, read with the info otherwise', () => {
  assert.deepEqual(guard.readNtp(undefined), { status: 'absent' });
  assert.deepEqual(guard.readNtp({}), { status: 'absent' });
  assert.deepEqual(guard.readNtp(fakeTimer({ getThrows: 'SecurityError' })), { status: 'unreadable', error: 'SecurityError' });
  const info = { use: 'ON', address: 'time.samsung.com', timeZone: 'Asia/Seoul' };
  assert.deepEqual(guard.readNtp(fakeTimer({ ntp: info })), { status: 'read', info: info });
  // A firmware that returns nothing at all still reads as "read", with an
  // empty info, so decide() sees "use unset" rather than a crash.
  assert.deepEqual(guard.readNtp(fakeTimer({ ntp: undefined })), { status: 'read', info: {} });
});

test('isClockImplausible: a clock before the day this file was written is wrong, without a network', () => {
  assert.equal(guard.EARLIEST_PLAUSIBLE_MS, Date.parse('2026-11-11T00:00:00Z'));
  assert.equal(guard.isClockImplausible(guard.EARLIEST_PLAUSIBLE_MS - 1), true);
  assert.equal(guard.isClockImplausible(guard.EARLIEST_PLAUSIBLE_MS), false);
  assert.equal(guard.isClockImplausible(Date.parse('2016-01-01T00:00:00Z')), true, 'the bench panel of 2026-11-10');
  assert.equal(guard.isClockImplausible(NaN), false, 'an unreadable clock is not evidence');
  assert.equal(guard.isClockImplausible(undefined), false);
});

test('decide: an implausible clock is applied over everything, even NTP on with no measurable drift', () => {
  // The exact bench case: clock years out, TLS fails, drift is null, NTP may
  // well say ON. Without this branch the guard leaves the panel alone.
  const on = { status: 'read', info: { use: 'ON', address: 'x', timeZone: 'y' } };
  assert.deepEqual(guard.decide(on, null, true), { action: 'apply', reason: 'the clock reads earlier than this build' });
  assert.equal(guard.decide(on, 0, true).action, 'apply');
  assert.equal(guard.decide(on, null, false).action, 'leave');
  assert.equal(guard.decide(on, null).action, 'leave', 'the flag defaults to plausible');
});

test('decide: a clock that agrees with the portal is left alone whatever getNTP says', () => {
  // NTP off with a clock somebody set right, or a firmware that spells `use`
  // oddly: neither may become a setNTP every hour for the life of the panel.
  assert.deepEqual(guard.decide({ status: 'read', info: { use: 'OFF' } }, 0), { action: 'leave', reason: 'the clock agrees with the portal' });
  assert.equal(guard.decide({ status: 'read', info: { use: 'on' } }, 30).action, 'leave');
  assert.equal(guard.decide({ status: 'read', info: {} }, -60).action, 'leave');
  assert.equal(guard.decide({ status: 'unreadable', error: 'UnknownError' }, 0).action, 'leave');
  assert.equal(guard.decide({ status: 'absent' }, 0).action, 'leave');
});

test('decide: NTP off, unset, unreadable or absent is applied when the drift is out or unknown', () => {
  assert.equal(guard.decide({ status: 'read', info: { use: 'OFF' } }, null).action, 'apply');
  assert.deepEqual(guard.decide({ status: 'read', info: { use: 'OFF' } }, 120).reason, 'ntp is OFF');
  assert.deepEqual(guard.decide({ status: 'read', info: {} }, 120).reason, 'ntp is unset');
  assert.equal(guard.decide({ status: 'unreadable', error: 'UnknownError' }, -120).action, 'apply');
  assert.deepEqual(guard.decide({ status: 'unreadable', error: 'UnknownError' }, null).reason, 'ntp setting unreadable');
  assert.equal(guard.decide({ status: 'absent' }, null).action, 'apply');
});

test('decide: NTP on with a small or unmeasured drift is left alone', () => {
  const on = { status: 'read', info: { use: 'ON', address: 'x', timeZone: 'y' } };
  assert.deepEqual(guard.decide(on, 0), { action: 'leave', reason: 'the clock agrees with the portal' });
  assert.deepEqual(guard.decide(on, null), { action: 'leave', reason: 'ntp is on' });
  assert.equal(guard.decide(on, 60).action, 'leave', 'the threshold itself is still fine');
  assert.equal(guard.decide(on, -60).action, 'leave');
  assert.equal(guard.decide(on, null).action, 'leave', 'an offline panel at boot is not evidence of a bad server');
});

test('decide: NTP on with a measured drift past the threshold is applied over', () => {
  const on = { status: 'read', info: { use: 'ON' } };
  assert.equal(guard.decide(on, 61).action, 'apply');
  assert.equal(guard.decide(on, -61).action, 'apply');
  assert.equal(guard.decide(on, 31536000).reason, 'ntp is on but the clock is 31536000 s out');
});

test('applyNtp: the first pair the firmware accepts wins, and the call carries use ON', () => {
  const timer = fakeTimer({});
  const result = guard.applyNtp(timer, guard.candidates());
  assert.deepEqual(result, { status: 'applied', address: 'pool.ntp.org', timeZone: 'Europe/Stockholm', attempts: 1 });
  assert.deepEqual(timer.calls, [{ use: 'ON', address: 'pool.ntp.org', timeZone: 'Europe/Stockholm' }]);
});

test('applyNtp: an InvalidValuesError moves to the next pair, in order', () => {
  // Stockholm is not on the zone list signageOS documents; Amsterdam is.
  const timer = fakeTimer({ refuse: (info) => (info.timeZone === 'Europe/Stockholm' ? 'InvalidValuesError' : null) });
  const result = guard.applyNtp(timer, guard.candidates());
  assert.deepEqual(result, { status: 'applied', address: 'pool.ntp.org', timeZone: 'Europe/Amsterdam', attempts: 2 });
});

test('applyNtp: a firmware that refuses every host name gets the bare address', () => {
  const timer = fakeTimer({ refuse: (info) => (info.address === 'pool.ntp.org' ? 'InvalidValuesError' : null) });
  const result = guard.applyNtp(timer, guard.candidates());
  assert.deepEqual(result, { status: 'applied', address: '216.239.35.0', timeZone: 'Europe/Stockholm', attempts: 4 });
});

test('applyNtp: every pair refused on value is reported as refused after all six', () => {
  const timer = fakeTimer({ refuse: () => 'InvalidValuesError' });
  assert.deepEqual(guard.applyNtp(timer, guard.candidates()), { status: 'refused', error: 'InvalidValuesError', attempts: 6 });
  assert.equal(timer.calls.length, 6);
});

test('applyNtp: an own zone the firmware refuses falls through to the CET defaults', () => {
  const timer = fakeTimer({ refuse: (info) => (info.timeZone === 'Europe/Helsinki' ? 'InvalidValuesError' : null) });
  const result = guard.applyNtp(timer, guard.candidates(undefined, 'Europe/Helsinki'));
  assert.deepEqual(result, { status: 'applied', address: 'pool.ntp.org', timeZone: 'Europe/Stockholm', attempts: 2 });
});

test('applyNtp: ANY refusal of a pair built from the panel\'s own values moves on; the defaults still get their turn', () => {
  // The firmware may reject what it reported itself with TypeMismatchError
  // or UnknownError; only a default pair refused that way means the CALL is refused.
  const timer = fakeTimer({ refuse: (info) => (info.address === '10.0.0.5' || info.timeZone === 'Nowhere/Odd' ? 'UnknownError' : null) });
  const result = guard.applyNtp(timer, guard.candidates({ use: 'ON', address: '10.0.0.5', timeZone: 'Nowhere/Odd' }));
  // 4 own-address pairs, then pool.ntp.org+Nowhere/Odd (own zone), then pool.ntp.org+Stockholm.
  assert.deepEqual(result, { status: 'applied', address: 'pool.ntp.org', timeZone: 'Europe/Stockholm', attempts: 6 });
});

test('applyNtp: a default pair refused with a non-value error still stops, even after own pairs moved on', () => {
  const timer = fakeTimer({ refuse: (info) => (info.address === '10.0.0.5' ? 'UnknownError' : 'SecurityError') });
  const result = guard.applyNtp(timer, guard.candidates({ use: 'ON', address: '10.0.0.5' }));
  assert.deepEqual(result, { status: 'refused', error: 'SecurityError', attempts: 4 });
});

test('applyNtp: the error types Samsung documents for setNTP (TypeMismatch, NotSupported) move on like InvalidValues', () => {
  // Which of the three a refused zone really produces is unmeasured; a
  // ladder that only moved on for the undocumented one would never fall back.
  ['TypeMismatchError', 'NotSupportedError'].forEach((name) => {
    const timer = fakeTimer({ refuse: (info) => (info.timeZone === 'Europe/Stockholm' ? name : null) });
    assert.deepEqual(guard.applyNtp(timer, guard.candidates()), { status: 'applied', address: 'pool.ntp.org', timeZone: 'Europe/Amsterdam', attempts: 2 }, name);
  });
});

test('applyNtp: own values that ARE our defaults (set by an earlier run) are not exempt from stopping', () => {
  const timer = fakeTimer({ refuse: () => 'SecurityError' });
  const pairs = guard.candidates({ use: 'ON', address: 'pool.ntp.org', timeZone: 'Europe/Stockholm' });
  assert.equal(pairs.length, 6);
  assert.equal(pairs.some((pair) => pair.own), false);
  assert.deepEqual(guard.applyNtp(timer, pairs), { status: 'refused', error: 'SecurityError', attempts: 1 });
});

test('applyNtp: SecurityError and an unknown error stop at the first try', () => {
  // The CALL is refused; the next value would be refused the same way, and a
  // package without the Partner privilege must not hammer the API six times.
  ['SecurityError', 'UnknownError'].forEach((name) => {
    const timer = fakeTimer({ refuse: () => name });
    assert.deepEqual(guard.applyNtp(timer, guard.candidates()), { status: 'refused', error: name, attempts: 1 }, name);
    assert.equal(timer.calls.length, 1, name);
  });
});

test('applyNtp: a throw without a name is reported as its text, not as "undefined"', () => {
  const timer = { setNTP: () => { throw 'boom'; } };
  assert.deepEqual(guard.applyNtp(timer, guard.candidates()), { status: 'refused', error: 'boom', attempts: 1 });
});

test('applyNtp: a Timer API with getNTP but no setNTP is reported as that, not as no API', () => {
  assert.deepEqual(guard.applyNtp({ getNTP: () => ({}) }, guard.candidates()), { status: 'absent', missing: 'setNTP' });
  assert.deepEqual(guard.applyNtp(undefined, guard.candidates()), { status: 'absent', missing: 'timer' });
});

test('measureDrift: a HEAD with no-store, timed on the local clock, read off the Date header', async () => {
  const requests = [];
  const server = Date.parse('Thu, 12 Nov 2026 12:00:00 GMT');
  const fetchFn = (url, options) => {
    requests.push({ url: url, options: options });

    return fakeFetch({ date: 'Thu, 12 Nov 2026 12:00:00 GMT' })();
  };
  const result = await guard.measureDrift(fetchFn, 'https://example.test/up', fakeNow([server + 100000, server + 100400]));
  assert.deepEqual(result, { status: 'measured', seconds: 100 });
  assert.equal(requests.length, 1);
  // The query carries the local send time: unique per probe, so a Chrome 63
  // engine that drops `cache: 'no-store'` still cannot be served a cached stamp.
  assert.equal(requests[0].url, 'https://example.test/up?t=' + (server + 100000));
  assert.equal(requests[0].options.method, 'HEAD');
  assert.equal(requests[0].options.cache, 'no-store');
  assert.ok(requests[0].options.signal instanceof AbortSignal, 'aborted on timeout where AbortController exists');
  const withQuery = await guard.measureDrift((url) => { requests.push({ url: url }); return fakeFetch({ date: 'Thu, 12 Nov 2026 12:00:00 GMT' })(); }, 'u?v=1', fakeNow([server, server]));
  assert.equal(withQuery.status, 'measured');
  assert.equal(requests[1].url, 'u?v=1&t=' + server);
});

test('measureDrift: the timeout aborts the request so the socket does not outlive the probe', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal = null;
  const pending = guard.measureDrift((url, options) => { signal = options.signal; return new Promise(() => {}); }, 'u', fakeNow([0, 0]));
  await Promise.resolve();
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(guard.PROBE_TIMEOUT_MS);
  await pending;
  assert.equal(signal.aborted, true);
});

test('measureDrift: a response without a readable Date header is unavailable, with the reason', async () => {
  assert.deepEqual(
    await guard.measureDrift(fakeFetch({}), 'u', fakeNow([0, 0])),
    { status: 'unavailable', reason: 'no Date header' }
  );
  assert.deepEqual(
    await guard.measureDrift(fakeFetch({ date: 'garbage' }), 'u', fakeNow([0, 0])),
    { status: 'unavailable', reason: 'unparseable Date header' }
  );
});

test('measureDrift: a failed request is unavailable, never a thrown promise', async () => {
  const result = await guard.measureDrift(fakeFetch({}, new TypeError('Failed to fetch')), 'u', fakeNow([0, 0]));
  assert.deepEqual(result, { status: 'unavailable', reason: 'TypeError' });
});

test('measureDrift: a fetch that THROWS instead of rejecting is unavailable too, not an exception in the caller', async () => {
  const result = await guard.measureDrift(() => { throw new RangeError('no fetch here'); }, 'u', fakeNow([0, 0]));
  assert.deepEqual(result, { status: 'unavailable', reason: 'RangeError' });
});

test('measureDrift: a request that never answers is given up on after the probe timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = guard.measureDrift(() => new Promise(() => {}), 'u', fakeNow([0, 0]));
  t.mock.timers.tick(guard.PROBE_TIMEOUT_MS - 1);
  let settled = false;
  pending.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, 'still waiting just under the timeout');
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, { status: 'unavailable', reason: 'TimeoutError' });
  assert.equal(guard.PROBE_TIMEOUT_MS, 15000);
});

test('run: NTP off and the clock two minutes out => set, warning on', async () => {
  const timer = fakeTimer({ ntp: { use: 'OFF', address: '', timeZone: '' } });
  const server = Date.parse('Thu, 12 Nov 2026 12:00:00 GMT');
  const report = await guard.run({
    timer: timer,
    fetchFn: fakeFetch({ date: 'Thu, 12 Nov 2026 12:00:00 GMT' }),
    url: 'u',
    now: fakeNow([server + 120000, server + 120000]),
  });
  assert.equal(report.decision.action, 'apply');
  assert.equal(report.result.status, 'applied');
  assert.equal(report.warn, true);
  assert.equal(guard.formatReport(report), 'NTP set (pool.ntp.org, Europe/Stockholm) · drift +120 s ⚠ clock is wrong');
});

test('run: NTP off but the clock agrees => left off, nothing written, no warning', async () => {
  const timer = fakeTimer({ ntp: { use: 'OFF', address: '', timeZone: '' } });
  const server = Date.parse('Thu, 12 Nov 2026 12:00:00 GMT');
  const report = await guard.run({
    timer: timer,
    fetchFn: fakeFetch({ date: 'Thu, 12 Nov 2026 12:00:00 GMT' }),
    url: 'u',
    now: fakeNow([server + 2000, server + 2000]),
  });
  assert.equal(report.result, null);
  assert.equal(timer.calls.length, 0);
  assert.equal(report.warn, false);
  assert.equal(guard.formatReport(report), 'NTP left as is (clock agrees) · drift +2 s');
});

test('run: NTP on and the clock agrees => left alone, and the panel is not written to', async () => {
  const timer = fakeTimer({ ntp: { use: 'ON', address: 'time.samsung.com', timeZone: 'Europe/Paris' } });
  const server = Date.parse('Thu, 12 Nov 2026 12:00:00 GMT');
  const report = await guard.run({
    timer: timer,
    fetchFn: fakeFetch({ date: 'Thu, 12 Nov 2026 12:00:00 GMT' }),
    url: 'u',
    now: fakeNow([server - 1000, server - 1000]),
  });
  assert.equal(report.result, null);
  assert.equal(timer.calls.length, 0);
  assert.equal(report.warn, false);
  assert.equal(guard.formatReport(report), 'NTP left on (time.samsung.com, Europe/Paris) · drift -1 s');
});

test('run: NTP on but the clock is a year AHEAD => re-applied with the panel\'s own server and zone, warning on', async () => {
  // Its own server first even here: a panel whose NTP simply has not synced
  // yet since boot must not lose a working internal server to a public one.
  const timer = fakeTimer({ ntp: { use: 'ON', address: 'ntp.customer.lan', timeZone: 'Europe/Paris' } });
  const server = Date.parse('Thu, 12 Nov 2026 12:00:00 GMT');
  const report = await guard.run({
    timer: timer,
    fetchFn: fakeFetch({ date: 'Thu, 12 Nov 2026 12:00:00 GMT' }),
    url: 'u',
    now: fakeNow([server + 31536000000, server + 31536000000]),
  });
  assert.equal(report.result.status, 'applied');
  assert.deepEqual(timer.calls, [{ use: 'ON', address: 'ntp.customer.lan', timeZone: 'Europe/Paris' }]);
  assert.equal(report.warn, true);
  assert.equal(report.clockImplausible, false);
  assert.equal(
    guard.formatReport(report),
    'NTP re-applied (ntp.customer.lan, Europe/Paris) · drift +31536000 s ⚠ clock is wrong'
  );
});

test('run: the bench case: clock years BEHIND => its own server re-applied without probing, warning on', async () => {
  // TLS would fail on such a clock anyway, and a probe timed across the step
  // setNTP is about to cause would read as years of drift. Not probed.
  const timer = fakeTimer({ ntp: { use: 'ON', address: 'ntp.customer.lan', timeZone: '' } });
  const clock = Date.parse('2016-01-01T10:00:00Z');
  let fetchStarted = false;
  const pending = guard.run({
    timer: timer,
    fetchFn: () => { fetchStarted = true; return new Promise(() => {}); },
    url: 'u',
    now: fakeNow([clock, clock]),
  });
  assert.equal(timer.calls.length, 1, 'setNTP was called synchronously, before any await');
  const report = await pending;
  assert.equal(fetchStarted, false, 'no probe at all below the floor');
  assert.equal(report.clockImplausible, true);
  assert.equal(report.decision.reason, 'the clock reads earlier than this build');
  assert.equal(report.result.status, 'applied');
  assert.deepEqual(timer.calls, [{ use: 'ON', address: 'ntp.customer.lan', timeZone: 'Europe/Stockholm' }],
    'the customer\'s own server is kept; an empty own zone is no zone');
  assert.equal(report.warn, true);
  assert.equal(
    guard.formatReport(report),
    'NTP re-applied (ntp.customer.lan, Europe/Stockholm) · drift unknown (not probed, clock below floor), clock reads 2016-01-01 ⚠ clock is wrong'
  );
});

test('run: the measured bench panel: NTP off, getNTP() zone a placeholder, Stockholm refused => Amsterdam, never Casablanca', async () => {
  // Everything in this test was read off a QB43C (Tizen 7.0) on 2026-11-11
  // with lab/clock-probe, with the clock put below the floor here.
  const timer = fakeTimer({
    ntp: { use: 'OFF', address: '', timeZone: 'Africa/Casablanca' },
    refuse: (info) => (info.timeZone === 'Europe/Stockholm' ? 'InvalidValuesError' : null),
  });
  const clock = Date.parse('2016-01-01T10:00:00Z');
  const report = await guard.run({
    timer: timer,
    time: { getLocalTimezone: () => 'Europe/Stockholm' },
    fetchFn: () => new Promise(() => {}),
    url: 'u',
    now: fakeNow([clock, clock]),
  });
  assert.deepEqual(timer.calls, [
    { use: 'ON', address: 'pool.ntp.org', timeZone: 'Europe/Stockholm' },
    { use: 'ON', address: 'pool.ntp.org', timeZone: 'Europe/Amsterdam' },
  ]);
  assert.deepEqual(report.result, { status: 'applied', address: 'pool.ntp.org', timeZone: 'Europe/Amsterdam', attempts: 2 });
  assert.equal(
    guard.formatReport(report),
    'NTP set (pool.ntp.org, Europe/Amsterdam) · drift unknown (not probed, clock below floor), clock reads 2016-01-01 ⚠ clock is wrong'
  );
});

test('run: the wall-clock zone from deps.time reaches the ladder: a Finnish panel with NTP off keeps Helsinki', async () => {
  // Stockholm leads the defaults anyway, so the bench test above would pass
  // with deps.time dropped on the floor. Helsinki would not.
  const timer = fakeTimer({ ntp: { use: 'OFF', address: '', timeZone: 'Africa/Casablanca' } });
  const clock = Date.parse('2016-01-01T10:00:00Z');
  const report = await guard.run({
    timer: timer,
    time: { getLocalTimezone: () => 'Europe/Helsinki' },
    fetchFn: () => new Promise(() => {}),
    url: 'u',
    now: fakeNow([clock, clock]),
  });
  assert.deepEqual(timer.calls, [{ use: 'ON', address: 'pool.ntp.org', timeZone: 'Europe/Helsinki' }]);
  assert.equal(report.result.timeZone, 'Europe/Helsinki');
});

test('run: applyAllowed false holds an apply and writes nothing to the panel', async () => {
  const timer = fakeTimer({ ntp: { use: 'OFF' } });
  const server = Date.parse('Thu, 12 Nov 2026 12:00:00 GMT');
  const report = await guard.run({
    timer: timer,
    fetchFn: fakeFetch({ date: 'Thu, 12 Nov 2026 12:00:00 GMT' }),
    url: 'u',
    now: fakeNow([server + 120000, server + 120000]),
    applyAllowed: false,
  });
  assert.equal(report.decision.action, 'apply');
  assert.deepEqual(report.result, { status: 'held' });
  assert.equal(timer.calls.length, 0);
  assert.equal(guard.formatReport(report), 'NTP apply held (tried under an hour ago) · drift +120 s ⚠ clock is wrong');
});

test('run: applyAllowed false does not hold a leave: nothing was going to be written anyway', async () => {
  const timer = fakeTimer({ ntp: { use: 'ON', address: 'a', timeZone: 'z' } });
  const server = Date.parse('Thu, 12 Nov 2026 12:00:00 GMT');
  const report = await guard.run({
    timer: timer,
    fetchFn: fakeFetch({ date: 'Thu, 12 Nov 2026 12:00:00 GMT' }),
    url: 'u',
    now: fakeNow([server, server]),
    applyAllowed: false,
  });
  assert.equal(report.result, null);
});

test('run: getNTP throws but setNTP works => set, reported without the before-info it never had', async () => {
  const timer = fakeTimer({ getThrows: 'UnknownError' });
  const server = Date.parse('Thu, 12 Nov 2026 12:00:00 GMT');
  const report = await guard.run({
    timer: timer,
    fetchFn: fakeFetch({ date: 'Thu, 12 Nov 2026 12:00:00 GMT' }),
    url: 'u',
    now: fakeNow([server - 120000, server - 120000]),
  });
  assert.equal(report.decision.reason, 'ntp setting unreadable');
  assert.equal(guard.formatReport(report), 'NTP set (pool.ntp.org, Europe/Stockholm) · drift -120 s ⚠ clock is wrong');
});

test('run: every pair refused => the plural is spelled out', async () => {
  const timer = fakeTimer({ ntp: { use: 'OFF' }, refuse: () => 'InvalidValuesError' });
  const server = Date.parse('Thu, 12 Nov 2026 12:00:00 GMT');
  const report = await guard.run({
    timer: timer,
    fetchFn: fakeFetch({ date: 'Thu, 12 Nov 2026 12:00:00 GMT' }),
    url: 'u',
    now: fakeNow([server + 120000, server + 120000]),
  });
  assert.equal(guard.formatReport(report), 'NTP refused: InvalidValuesError after 6 tries · drift +120 s ⚠ clock is wrong');
});

test('run: a Timer API without setNTP says so in the row', async () => {
  const server = Date.parse('Thu, 12 Nov 2026 12:00:00 GMT');
  const report = await guard.run({
    timer: { getNTP: () => ({ use: 'OFF' }) },
    fetchFn: fakeFetch({ date: 'Thu, 12 Nov 2026 12:00:00 GMT' }),
    url: 'u',
    now: fakeNow([server + 120000, server + 120000]),
  });
  assert.equal(guard.formatReport(report), 'Timer API has no setNTP · drift +120 s ⚠ clock is wrong');
});

test('run: NTP on with no address or zone reported => left alone and shown as unknown, not undefined', async () => {
  const timer = fakeTimer({ ntp: { use: 'ON' } });
  const server = Date.parse('Thu, 12 Nov 2026 12:00:00 GMT');
  const report = await guard.run({
    timer: timer,
    fetchFn: fakeFetch({ date: 'Thu, 12 Nov 2026 12:00:00 GMT' }),
    url: 'u',
    now: fakeNow([server, server]),
  });
  assert.equal(report.result, null);
  assert.equal(guard.formatReport(report), 'NTP left on (?, ?) · drift 0 s');
});

test('run: the privilege is missing => refused in words; the warning follows the drift, not the refusal', async () => {
  // A store package without the Partner privilege refuses on every panel. A
  // permanent warning there would be noise, and noise hides the one panel
  // whose clock is actually wrong. (With the clock agreeing, nothing is even
  // attempted; see the leave test above.)
  const timer = fakeTimer({ ntp: { use: 'OFF' }, refuse: () => 'SecurityError' });
  const server = Date.parse('Thu, 12 Nov 2026 12:00:00 GMT');
  const report = await guard.run({
    timer: timer,
    fetchFn: fakeFetch({}, new TypeError('Failed to fetch')),
    url: 'u',
    now: fakeNow([server, server]),
  });
  assert.equal(report.warn, false);
  assert.equal(guard.formatReport(report), 'NTP refused: SecurityError after 1 try · drift unknown (TypeError)');
});

test('run: offline at boot with NTP off and a plausible clock => set anyway, drift unknown, no warning', async () => {
  const timer = fakeTimer({ ntp: { use: 'OFF' } });
  const clock = Date.parse('Thu, 12 Nov 2026 12:00:00 GMT');
  const report = await guard.run({
    timer: timer,
    fetchFn: fakeFetch({}, new TypeError('Failed to fetch')),
    url: 'u',
    now: fakeNow([clock, clock]),
  });
  assert.equal(report.result.status, 'applied');
  assert.equal(report.warn, false);
  assert.equal(guard.formatReport(report), 'NTP set (pool.ntp.org, Europe/Stockholm) · drift unknown (TypeError)');
});

test('run: off a panel (no webapis) => no Timer API, and the drift is still reported', async () => {
  const server = Date.parse('Thu, 12 Nov 2026 12:00:00 GMT');
  const report = await guard.run({
    timer: undefined,
    fetchFn: fakeFetch({ date: 'Thu, 12 Nov 2026 12:00:00 GMT' }),
    url: 'u',
    now: fakeNow([server + 90000, server + 90000]),
  });
  assert.equal(report.warn, true);
  assert.equal(guard.formatReport(report), 'no Timer API · drift +90 s ⚠ clock is wrong');
});

test('isDriftWarning: only a MEASURED drift past the threshold warns', () => {
  assert.equal(guard.isDriftWarning({ status: 'measured', seconds: 60 }), false);
  assert.equal(guard.isDriftWarning({ status: 'measured', seconds: 61 }), true);
  assert.equal(guard.isDriftWarning({ status: 'measured', seconds: -61 }), true);
  assert.equal(guard.isDriftWarning({ status: 'unavailable', reason: 'x' }), false);
});
