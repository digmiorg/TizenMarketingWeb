'use strict';

/**
 * The panel's clock, kept honest.
 *
 * A Samsung signage panel with a wrong clock cannot validate a TLS certificate,
 * and everything this widget does goes over https to portal.digmi.eu. Measured
 * on the bench on 2026-11-10: a TBM "Custom App (URL)" install failed with
 * "Unable to connect to server" until the panel's clock was corrected by hand,
 * and then it installed and played. A screen in a salon has nobody to correct
 * it by hand, and TBM's profile JSON has no clock or NTP key to push.
 *
 * This module does two things at start, and reports both into the INFO panel:
 *
 *   1. It MEASURES the drift between the panel's clock and the portal's, from
 *      the `Date` header of a response to a cheap request. The portal's clock
 *      is the one that matters: it is what the certificate is checked against.
 *      A clock that is YEARS out never gets that far: TLS fails first and the
 *      request rejects. So the clock is also held against a floor that needs
 *      no network at all: a reading earlier than the day this file was written
 *      is wrong by definition, whatever the server would have said.
 *   2. It turns on NTP with our server and time zone through Samsung's Timer
 *      API (`webapis.timer.setNTP`, B2B, Partner privilege, since Tizen 6.5),
 *      unless NTP is already on AND the drift is small. A refusal is reported,
 *      never retried in a loop: on a package without the Partner privilege the
 *      call throws SecurityError on every panel, and the report says so.
 *
 * Everything that touches the panel or the network is injected, so the
 * decisions are tested under node without a panel (src/js/timeguard.test.js).
 */
(function (root) {
  /**
   * A measured drift past this is reported as a warning. Certificate validity
   * is checked to the second, but a panel that is a minute out is not what
   * breaks installs; one that is hours or years out is. Sixty seconds also
   * sits well above the resolution of the measurement (the `Date` header is
   * whole seconds, plus one round trip).
   */
  const DRIFT_WARN_SECONDS = 60;

  /**
   * No panel's clock can honestly read earlier than the day this constant
   * was written. A reading before it is a wrong clock, measured without a
   * network: the bench panel of 2026-11-10 could not reach the portal at all,
   * because its clock was outside the certificate's validity window, which is
   * exactly the panel the drift measurement cannot see. It never needs
   * bumping: it is a floor, not an expiry. A clock far in the FUTURE breaks
   * TLS the same way and is not caught here; that needs a server to compare
   * against, and this file cannot reach one in that state.
   */
  const EARLIEST_PLAUSIBLE_MS = Date.parse('2026-11-11T00:00:00Z');

  /**
   * NTP servers, in the order they are tried. Samsung documents the field as
   * "format 00.00.00.00", and panels are configured with host names from the
   * menu every day, so the host name goes first and a bare address second.
   * The address is time.google.com's published anycast address; it exists so
   * that a firmware which really does refuse a host name still gets a server.
   */
  const NTP_ADDRESSES = ['pool.ntp.org', '216.239.35.0'];

  /**
   * Time zones tried when the panel has none of its own. Tizen's zone list is
   * shorter than the IANA one. Measured on a QB43C (Tizen 7.0) on
   * 2026-11-11 with lab/clock-probe: Europe/Stockholm is refused with
   * InvalidValuesError code 26 "Unable to Set", Europe/Amsterdam and
   * Europe/Paris are accepted, and the accepted zone becomes the panel's
   * wall-clock zone (tizen.time.getLocalTimezone() follows it). All three
   * are CET/CEST, so whichever the firmware takes gives the same wall
   * clock. Stockholm stays first in case another firmware's list has it;
   * the refusal costs one synchronous call.
   *
   * A zone the panel ALREADY has is tried before any of these (see
   * candidates()): the certificate problem is a UTC problem and needs no
   * zone at all, and a Finnish panel on Europe/Helsinki should keep it.
   * Should, not must: if the firmware refuses that zone too, the ladder
   * falls through to these and the wall clock lands an hour west (see
   * candidates() for why that is accepted).
   */
  const TIME_ZONES = ['Europe/Stockholm', 'Europe/Amsterdam', 'Europe/Paris'];

  /**
   * Error names from the Timer API that mean "this VALUE was refused, try the
   * next one". Samsung's setNTP reference lists TypeMismatchError and
   * NotSupportedError (and SecurityError); a forum report shows the firmware
   * answering a bad value with InvalidValuesError, which the reference does
   * not list. Measured 2026-11-11 on a QB43C: a refused zone produces
   * InvalidValuesError (code 26, "Unable to Set"), for ON and OFF alike.
   * All three still move on: six synchronous calls at worst, and a ladder
   * that stops on the one error the reference ties to a value would have
   * its fallbacks never run. SecurityError and anything unknown mean
   * the CALL is refused, and the next value would be refused the same way.
   * A pair built from the panel's OWN values is exempt either way (see
   * applyNtp()).
   */
  const VALUE_REFUSALS = ['InvalidValuesError', 'TypeMismatchError', 'NotSupportedError'];

  /**
   * How long the drift probe may take before it is given up on. A stalled
   * TCP connection or a proxy that never answers must not hold the NTP
   * decision, and must not pile up one hung run per tick.
   */
  const PROBE_TIMEOUT_MS = 15000;

  /**
   * Every (address, zone) pair in the order they are tried: all zones with the
   * first address, then all zones with the second. Address-major because a
   * refused address is the rarer case and should not be tried before every
   * zone has had its chance with the ordinary host name.
   *
   * What the panel ALREADY has leads both lists. A customer whose router
   * blocks outbound NTP and points the panel at an internal server has a
   * working setup; a power cut that resets the clock below the floor must
   * not make this file replace that server with an unreachable public one.
   * Pairs made from the panel's own values are marked `own`, and applyNtp()
   * treats any refusal of them as a reason to move on, not to stop.
   *
   * The own ADDRESS counts only while NTP is ON: "the customer has a working
   * setup" is the whole argument for keeping it, and a panel with NTP off may
   * still report some stale address nobody chose.
   *
   * The own ZONE is the panel's wall-clock zone, read from tizen.time (see
   * readLocalZone()), and only as a fallback the zone getNTP() reports, and
   * that only while NTP is ON. Measured 2026-11-11 on a QB43C: with NTP OFF
   * getNTP() reported timeZone "Africa/Casablanca" on a panel whose menu
   * and tizen.time both said Europe/Stockholm: a placeholder, not a
   * setting. Whether the firmware accepts it is not measured; a zone name
   * from its own list probably is, and that would move the panel's wall
   * clock to Morocco.
   *
   * A panel outside CET whose own zone is refused still falls through to
   * the CET defaults and gets a wall clock an hour out; measured today,
   * the firmware CAN refuse a valid IANA name (Stockholm). Accepted as the
   * lesser harm against a certificate failure that blanks the screen, and
   * not measured on any non-CET panel.
   *
   * @param {{use?: string, address?: string, timeZone?: string}} [own] What getNTP() reported.
   * @param {string} [localZone] What readLocalZone() reported; '' or missing when nothing.
   * @returns {Array<{address: string, timeZone: string, own: boolean}>}
   */
  function candidates(own, localZone) {
    const ntpOn = Boolean(own) && own.use === 'ON';
    const ownAddress = ntpOn ? cleanValue(own.address) : '';
    const ownZone = cleanValue(localZone) || (ntpOn ? cleanValue(own.timeZone) : '');
    const addresses = withOwnFirst(ownAddress, NTP_ADDRESSES);
    const zones = withOwnFirst(ownZone, TIME_ZONES);
    // `own` exempts a pair from stopping the search. A panel value that is
    // one of our own defaults (this widget set it on an earlier run) is a
    // default, and a refusal of it means what a refusal of a default means.
    const customAddress = ownAddress && NTP_ADDRESSES.indexOf(ownAddress) === -1 ? ownAddress : '';
    const customZone = ownZone && TIME_ZONES.indexOf(ownZone) === -1 ? ownZone : '';

    const out = [];
    addresses.forEach((address) => {
      zones.forEach((timeZone) => {
        out.push({
          address: address,
          timeZone: timeZone,
          own: (customAddress !== '' && address === customAddress) || (customZone !== '' && timeZone === customZone),
        });
      });
    });

    return out;
  }

  /**
   * @param {*} value A string from the firmware, or anything else.
   * @returns {string} The trimmed string, or '' for anything that is not one.
   */
  function cleanValue(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  /**
   * @param {string} own '' when the panel has none.
   * @param {string[]} defaults
   * @returns {string[]} own first (when set), then the defaults it is not already among.
   */
  function withOwnFirst(own, defaults) {
    const out = own ? [own] : [];
    defaults.forEach((value) => {
      if (out.indexOf(value) === -1) {
        out.push(value);
      }
    });

    return out;
  }

  /**
   * The network-free check: is the panel's clock earlier than this file?
   *
   * @param {number} nowMs The panel's clock.
   * @returns {boolean}
   */
  function isClockImplausible(nowMs) {
    return typeof nowMs === 'number' && nowMs < EARLIEST_PLAUSIBLE_MS;
  }

  /**
   * The drift in whole seconds between the panel's clock and a server's, from
   * the `Date` header of a response. Positive means the panel is AHEAD of the
   * server. The local clock is read before and after the request, and the
   * midpoint stands in for the moment the server stamped the header; the
   * header is whole seconds and the round trip is milliseconds, so this is as
   * good as the measurement gets without NTP itself.
   *
   * @param {string|null} dateHeader The `Date` header, or null when absent.
   * @param {number} sentAtMs Local clock when the request went out.
   * @param {number} receivedAtMs Local clock when the response arrived.
   * @returns {number|null} Seconds, or null when the header is absent or unparseable.
   */
  function driftFromDateHeader(dateHeader, sentAtMs, receivedAtMs) {
    if (!dateHeader) {
      return null;
    }

    const serverMs = Date.parse(dateHeader);
    if (Number.isNaN(serverMs)) {
      return null;
    }

    const localMs = (sentAtMs + receivedAtMs) / 2;

    return Math.round((localMs - serverMs) / 1000);
  }

  /**
   * Reads what the panel says about its own NTP setting.
   *
   * @param {object|undefined} timer `webapis.timer`, or undefined off a panel.
   * @returns {{status: 'absent'}|{status: 'unreadable', error: string}|{status: 'read', info: {use?: string, address?: string, timeZone?: string}}}
   */
  function readNtp(timer) {
    if (!timer || typeof timer.getNTP !== 'function') {
      return { status: 'absent' };
    }

    try {
      const info = timer.getNTP();

      return { status: 'read', info: info || {} };
    } catch (error) {
      return { status: 'unreadable', error: errorName(error) };
    }
  }

  /**
   * Reads the panel's wall-clock zone from the Tizen Time API. Measured
   * 2026-11-11 on a QB43C: tizen.time.getLocalTimezone() returned
   * Europe/Stockholm with NTP off, and followed every accepted setNTP zone.
   *
   * @param {object|undefined} time `tizen.time`, or undefined off a panel.
   * @returns {string} The zone, or '' when there is no API or it fails.
   */
  function readLocalZone(time) {
    if (!time || typeof time.getLocalTimezone !== 'function') {
      return '';
    }

    try {
      return cleanValue(time.getLocalTimezone());
    } catch (error) {
      return '';
    }
  }

  /**
   * Whether to apply our NTP setting, given what the panel reports and what
   * was measured. The one case that LEAVES the panel alone is NTP already on
   * with a clock that agrees with the portal, or with a drift that could not
   * be measured (an offline panel at boot is not evidence of a bad server).
   * NTP on with a large measured drift is applied again: the panel's own
   * server first (it may simply not have synced since boot), the defaults
   * if the firmware refuses it. A dead own server is NOT escalated past;
   * that would trade a customer's deliberate setting for a guess.
   *
   * @param {{status: string, info?: {use?: string}}} ntp From readNtp().
   * @param {number|null} driftSeconds From driftFromDateHeader(), or null.
   * @param {boolean} [clockImplausible] From isClockImplausible(): the clock is before this file.
   * @returns {{action: 'apply'|'leave', reason: string}}
   */
  function decide(ntp, driftSeconds, clockImplausible) {
    if (clockImplausible) {
      return { action: 'apply', reason: 'the clock reads earlier than this build' };
    }

    // A clock that agrees with the portal is left alone whatever getNTP()
    // says about itself: a firmware that reports `use` oddly, or NTP off
    // with a clock somebody set correctly, must not become a write every
    // hour for the life of the panel. The clock is what matters.
    if (driftSeconds !== null && Math.abs(driftSeconds) <= DRIFT_WARN_SECONDS) {
      return { action: 'leave', reason: 'the clock agrees with the portal' };
    }

    if (ntp.status !== 'read') {
      return { action: 'apply', reason: 'ntp setting ' + ntp.status };
    }

    if (ntp.info.use !== 'ON') {
      return { action: 'apply', reason: 'ntp is ' + (ntp.info.use || 'unset') };
    }

    if (driftSeconds !== null && Math.abs(driftSeconds) > DRIFT_WARN_SECONDS) {
      return { action: 'apply', reason: 'ntp is on but the clock is ' + driftSeconds + ' s out' };
    }

    return { action: 'leave', reason: 'ntp is on' };
  }

  /**
   * Turns NTP on with the first (address, zone) pair the firmware accepts.
   * A value refusal moves to the next pair; any other refusal stops, because
   * it is the CALL being refused and the next pair would fare the same. A
   * pair carrying the panel's own values is never the one that stops the
   * search: the firmware may reject what it reported in any way it likes,
   * and the defaults still deserve their turn.
   *
   * Measured 2026-11-11 on a QB43C: a call refused over its zone had still
   * written its ADDRESS (getNTP() reported it afterwards). Harmless here,
   * since the next pair carries the same address or a default, but a
   * refusal is not a no-op on the panel.
   *
   * @param {object|undefined} timer `webapis.timer`, or undefined off a panel.
   * @param {Array<{address: string, timeZone: string, own?: boolean}>} pairs From candidates().
   * @returns {{status: 'absent'}|{status: 'applied', address: string, timeZone: string, attempts: number}|{status: 'refused', error: string, attempts: number}}
   */
  function applyNtp(timer, pairs) {
    if (!timer) {
      return { status: 'absent', missing: 'timer' };
    }

    if (typeof timer.setNTP !== 'function') {
      return { status: 'absent', missing: 'setNTP' };
    }

    let attempts = 0;
    let lastError = 'no candidates';
    for (let i = 0; i < pairs.length; i += 1) {
      attempts += 1;
      try {
        timer.setNTP({ use: 'ON', address: pairs[i].address, timeZone: pairs[i].timeZone });

        return { status: 'applied', address: pairs[i].address, timeZone: pairs[i].timeZone, attempts: attempts };
      } catch (error) {
        lastError = errorName(error);
        const callRefused = VALUE_REFUSALS.indexOf(lastError) === -1 && !pairs[i].own;
        if (callRefused) {
          return { status: 'refused', error: lastError, attempts: attempts };
        }
      }
    }

    return { status: 'refused', error: lastError, attempts: attempts };
  }

  /**
   * Measures the drift against one URL. Any response with a `Date` header
   * counts, whatever its status: a 500 is stamped by the same clock as a 200.
   * A URL the portal answers without cookies or a body is the right one; the
   * caller chooses it.
   *
   * @param {function(string, object): Promise<{headers: {get: function(string): (string|null)}}>} fetchFn `fetch` or a stand-in.
   * @param {string} url The request to time.
   * @param {function(): number} now `Date.now` or a stand-in.
   * @returns {Promise<{status: 'measured', seconds: number}|{status: 'unavailable', reason: string}>}
   */
  function measureDrift(fetchFn, url, now) {
    const sentAt = now();
    // `cache: 'no-store'` arrived in Chrome 64 and the oldest engine this
    // widget runs on is 63, where the member is dropped silently; the query
    // string is the defence that works everywhere. A cached Date header
    // would read as drift equal to the cache's age.
    const probeUrl = url + (url.indexOf('?') === -1 ? '?' : '&') + 't=' + sentAt;
    // AbortController is Chrome 66+; without it a stalled probe holds its
    // socket until the engine gives up, which is survivable, and with it the
    // timeout below closes the socket so the next tick does not stack one
    // more hung request onto the per-host connection limit.
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const options = { method: 'HEAD', cache: 'no-store' };
    if (controller) {
      options.signal = controller.signal;
    }
    // Started inside a promise so that a fetchFn that THROWS rather than
    // rejects still lands in the catch below, not in the caller's lap.
    const request = Promise.resolve().then(() => fetchFn(probeUrl, options));
    const abort = () => {
      if (controller) {
        controller.abort();
      }
    };

    return withTimeout(request, PROBE_TIMEOUT_MS, abort)
      .then((response) => {
        const receivedAt = now();
        const header = response && response.headers ? response.headers.get('date') : null;
        const seconds = driftFromDateHeader(header, sentAt, receivedAt);
        if (seconds === null) {
          return { status: 'unavailable', reason: header ? 'unparseable Date header' : 'no Date header' };
        }

        return { status: 'measured', seconds: seconds };
      })
      .catch((error) => ({ status: 'unavailable', reason: errorName(error) }));
  }

  /**
   * A promise that settles like `promise`, or rejects with a TimeoutError
   * once `ms` have passed without it settling.
   *
   * @template T
   * @param {Promise<T>} promise
   * @param {number} ms
   * @returns {Promise<T>}
   */
  function withTimeout(promise, ms, onTimeout) {
    return new Promise((resolve, reject) => {
      const handle = setTimeout(() => {
        if (typeof onTimeout === 'function') {
          onTimeout();
        }
        reject({ name: 'TimeoutError', message: 'no answer within ' + ms + ' ms' });
      }, ms);
      promise.then(
        (value) => { clearTimeout(handle); resolve(value); },
        (error) => { clearTimeout(handle); reject(error); }
      );
    });
  }

  /**
   * Measures, reads, decides, applies. The report is what the INFO panel
   * shows. `warn` is true on a MEASURED drift past the threshold or a clock
   * below the floor: a refusal is reported in words, but a package without
   * the privilege would otherwise carry a permanent warning on every panel,
   * which is noise, and noise is what hides the one panel whose clock is
   * actually wrong.
   *
   * A clock below the floor is decided and applied BEFORE the probe goes
   * out: that verdict needs no network, and the probe is what cannot be
   * trusted to come back on such a panel. Otherwise the probe comes first,
   * because its reading is part of the decision.
   *
   * `applyAllowed` is the caller's back-off: false means a decision to apply
   * is reported as held rather than carried out. The caller runs this every
   * ten minutes for the life of the panel, and a router that blocks NTP must
   * not turn that into a setNTP every ten minutes forever.
   *
   * @param {{timer: object|undefined, time?: object|undefined, fetchFn: function, url: string, now: function(): number, applyAllowed?: boolean}} deps `time` is `tizen.time`.
   * @returns {Promise<{drift: object, clockMs: number, clockImplausible: boolean, before: object, decision: object, result: object|null, warn: boolean}>}
   */
  function run(deps) {
    const clockMs = deps.now();
    const clockImplausible = isClockImplausible(clockMs);
    const applyAllowed = deps.applyAllowed !== false;
    const before = readNtp(deps.timer);

    const settle = (drift, decision) => {
      let result = null;
      if (decision.action === 'apply') {
        // The zone is read here, at the moment it is used, not on every tick.
        result = applyAllowed ? applyNtp(deps.timer, candidates(before.info, readLocalZone(deps.time))) : { status: 'held' };
      }

      return {
        drift: drift,
        clockMs: clockMs,
        clockImplausible: clockImplausible,
        before: before,
        decision: decision,
        result: result,
        warn: isDriftWarning(drift) || clockImplausible,
      };
    };

    if (clockImplausible) {
      // Not probed: setNTP was just told to step the clock, and a round
      // trip timed across that step reads as years of drift. The next tick
      // measures against a clock that has settled, one way or the other.
      const decision = decide(before, null, true);

      return Promise.resolve(settle({ status: 'unavailable', reason: 'not probed, clock below floor' }, decision));
    }

    return measureDrift(deps.fetchFn, deps.url, deps.now).then((drift) => {
      const driftSeconds = drift.status === 'measured' ? drift.seconds : null;

      return settle(drift, decide(before, driftSeconds, false));
    });
  }

  /**
   * @param {{status: string, seconds?: number}} drift From measureDrift().
   * @returns {boolean}
   */
  function isDriftWarning(drift) {
    return drift.status === 'measured' && Math.abs(drift.seconds) > DRIFT_WARN_SECONDS;
  }

  /**
   * One line for the INFO panel. What was done to NTP, then the drift.
   *
   * @param {{drift: object, before: object, decision: object, result: object|null}} report From run().
   * @returns {string}
   */
  function formatReport(report) {
    return ntpText(report) + ' · ' + driftText(report.drift) + clockText(report);
  }

  function clockText(report) {
    if (!report.clockImplausible) {
      return '';
    }

    return ', clock reads ' + new Date(report.clockMs).toISOString().slice(0, 10) + ' ⚠ clock is wrong';
  }

  function ntpText(report) {
    const result = report.result;
    if (result === null) {
      const info = report.before.info || {};
      if (report.before.status === 'read' && info.use === 'ON') {
        return 'NTP left on (' + (info.address || '?') + ', ' + (info.timeZone || '?') + ')';
      }

      return 'NTP left as is (clock agrees)';
    }

    if (result.status === 'applied') {
      const verb = report.before.status === 'read' && report.before.info.use === 'ON' ? 'NTP re-applied' : 'NTP set';

      return verb + ' (' + result.address + ', ' + result.timeZone + ')';
    }

    if (result.status === 'refused') {
      return 'NTP refused: ' + result.error + ' after ' + result.attempts + (result.attempts === 1 ? ' try' : ' tries');
    }

    if (result.status === 'held') {
      return 'NTP apply held (tried under an hour ago)';
    }

    if (result.missing === 'setNTP') {
      return 'Timer API has no setNTP';
    }

    return 'no Timer API';
  }

  function driftText(drift) {
    if (drift.status !== 'measured') {
      return 'drift unknown (' + drift.reason + ')';
    }

    const sign = drift.seconds > 0 ? '+' : '';
    const warning = isDriftWarning(drift) ? ' ⚠ clock is wrong' : '';

    return 'drift ' + sign + drift.seconds + ' s' + warning;
  }

  /**
   * @param {*} error Whatever was thrown; a WebAPIException has `name`.
   * @returns {string}
   */
  function errorName(error) {
    if (error && typeof error.name === 'string' && error.name) {
      return error.name;
    }

    return String(error);
  }

  const moduleApi = {
    DRIFT_WARN_SECONDS: DRIFT_WARN_SECONDS,
    NTP_ADDRESSES: NTP_ADDRESSES,
    TIME_ZONES: TIME_ZONES,
    candidates: candidates,
    driftFromDateHeader: driftFromDateHeader,
    readNtp: readNtp,
    readLocalZone: readLocalZone,
    decide: decide,
    applyNtp: applyNtp,
    measureDrift: measureDrift,
    run: run,
    isDriftWarning: isDriftWarning,
    isClockImplausible: isClockImplausible,
    EARLIEST_PLAUSIBLE_MS: EARLIEST_PLAUSIBLE_MS,
    PROBE_TIMEOUT_MS: PROBE_TIMEOUT_MS,
    formatReport: formatReport,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = moduleApi;
  } else {
    root.DigmiTimeGuard = moduleApi;
  }
})(typeof window !== 'undefined' ? window : this);
