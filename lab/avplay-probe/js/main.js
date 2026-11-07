/**
 * Lab probe for a Samsung signage panel.
 *
 * Two questions, answered on the panel rather than from documentation:
 *
 *   1. Does `webapis.avplaystore` hand over between two players without the
 *      video plane going down? On this panel HTML5 <video> gives
 *      black -> blue -> black at every transition: the plane is torn down,
 *      the graphics plane shows through, then the plane comes back up empty.
 *      (That blue was the body colour of the A/B page. This build's body is
 *      transparent and the mask is #000, so BOTH states read as black here —
 *      the colour test is history, not something to look for on screen.)
 *      Those black phases sit UNDER the DOM and no page layer can cover them.
 *
 *   2. What does this firmware expose to a Partner-signed widget? The
 *      certificate in use until 2026-11-03 was Public, so `b2bcontrol` was
 *      never reachable.
 *
 * READ THIS BEFORE TRUSTING A NUMBER. The question is visual: a plane going
 * down is not observable from JavaScript. `getState()` can say PLAYING while
 * the plane is down, and the plane can be up and empty while time advances.
 * So the timings below are a SUPPORTING measure, and the proof is a phone
 * filming the panel at high frame rate. Every state change is timestamped so
 * the film and the log can be lined up.
 *
 * Nothing here reboots or changes a setting on its own.
 */
(function () {
  "use strict";

  /* ------------------------------------------------------------- logging */

  var maskEl = document.getElementById("mask");
  // ONE cover is in force at a time, and the MECHANISM holding it decides
  // which series its sample belongs to. A single shared timestamp could not
  // express that: under `still` in CAMPAIGN a stale freeze is held across the
  // whole card suite while the CARD covers the next seam, so the same slot
  // was closed by whichever function ran first — filing a video teardown as
  // a freeze and leaving the card's own measurement unclosed. With an owner,
  // every seam yields exactly one sample, in the series that matches what
  // actually covered it, which is what makes the three strategies comparable.
  // No `kind` here, deliberately. watchEnd() raises the cover PRE_MASK_MS
  // BEFORE the stream ends, while advance() — the only place that names the
  // coming seam — runs at onstreamcompleted, after. A seam type captured at
  // raise time is therefore the PREVIOUS seam's name under `mask`, and
  // advance()'s own cover() call takes raiseCover()'s early return, so it is
  // never corrected. It is read at close instead, where every path has
  // already named the seam it is in.
  // `dirty` lives ON the stamp, not beside it. Every raise and every reset
  // re-stamps the whole object, so a flag cannot outlive the window it
  // describes — an abandoned seam, a strategy change and a clock step all
  // drop it for free. A free-standing boolean leaked across all three.
  var cov = { at: null, how: "", dirty: false }; // how: "" | "freeze" | "cover"
  // TWO arrays, because a freeze and a DOM mask are different operations with
  // different costs, and one array made `mean` describe neither. A freeze is
  // released between prepare() and play(); a mask is a layer held for a fixed
  // MASK_HOLD_MS after the picture is back, so one tracks the teardown and
  // the other adds a constant to it — averaging them produced a number that
  // matched no seam on the panel.
  //
  // The magnitudes this comment used to quote (~130 and ~700) predate the
  // measurement and were wrong in both directions. Bench, 2026-11-06, 482
  // video>video seams in one unbroken run under `still`:
  //
  //   freeze  604 ms   (stop -> open -> prepare, released before play)
  //   GAP     826 ms   (end-of-stream -> 150 ms into the new stream's clock)
  //
  // Those two do NOT share an endpoint, so subtracting them is not an
  // uncovered window. GAP = X + 150 + tick(0..POLL_MS), both added terms
  // non-negative — the cost of reaching the base sample is already INSIDE X,
  // which is defined as endedAt to base, so adding it again would double
  // count — and the only safe subtraction is the gate: X <= 826 - 150 =
  // 676 ms, leaving <= 72 ms of that X window which the freeze does not
  // span — not the 222 ms the raw difference suggests.
  //
  // ⚠️ X is NOT the time the plane is down, and 72 is NOT a bound on the
  // uncovered window. Both ends of X sit INSIDE the dark interval:
  //
  //   - endedAt is stamped at onstreamcompleted which, as the note on
  //     PRE_MASK_MS records, fires AFTER the plane has already gone dark.
  //     The blink before the event is in neither series.
  //   - base is the first poll tick after play() returns, and watchStart()
  //     says getCurrentTime() moves when DECODING starts, "still not the
  //     plane". Nothing establishes a picture was up at base.
  //
  // So the real dark interval starts earlier and ends later than X measures,
  // and 676/72 UNDERSTATE it by two unmeasured terms. The probe cannot see
  // the plane at all — that is why this is the one number here that needs an
  // instrument outside the probe: a camera, or captureScreen timed into the
  // seam.
  //
  // Subtracting the tick as well (giving 660, and 56) is wrong and wrong in
  // the FLATTERING direction: an upper bound minus an upper bound is not a
  // bound. That error was in this comment for one commit.
  //
  // And both numbers come from MEANS over 482 seams, so neither bounds any
  // individual seam: for a seam whose GAP ran above the mean, 72 ms does not
  // bound its unspanned window in EITHER direction. (It does not follow that
  // the window is larger — GAP 900 with freeze 740 leaves 10 ms. A bound
  // that fails is not a quantity that grew; writing it as one is the same
  // fault this note exists to remove.) Nothing here has been measured
  // directly; until it is, do not quote any of it as a gap. No cover sample
  // was taken in that run, so the mask figure remains unmeasured.
  var freezeMs = [];
  var coverMs = [];
  // Which seam the current cover belongs to, carried onto the printed line.
  // freezeMs provably cannot hold `still>video`: raiseCover("freeze") has
  // one call site, in cover()'s still branch, reachable only from advance()
  // — and startBehindCard(), the only producer of `still>video`, raises
  // "cover". So freezeMs is {video>video, video>card} and only coverMs
  // mixes in the third. meanByKind() prints exactly that partition, so this
  // label is what keys it rather than a hint to read the mean carefully.
  var seamKind = "?";
  var MASK_HOLD_MS = 250;
  // AVPlay reports time in MILLISECONDS. The previous 0.15 was read as
  // seconds and so was true on the first tick, which made the progress guard
  // do nothing at all.
  // ⚠️ This constant is INSIDE every GAP number. The sample closes once the
  // new stream's clock has advanced past base + MASK_PROGRESS_MS, so a GAP
  // spans end-of-old-stream to 150 ms into the new stream, plus up to one
  // POLL_MS tick. (Not "plus the base sampling cost" — reaching the base
  // sample is already inside X, which is endedAt to base.) A GAP is
  // ⚠️ Under `mask` only, a GAP also carries the probe's own afterPaint()
  // — two rAF plus a setTimeout 0, ~33 ms — because that branch runs it
  // between the stamp and watchStart() while `still` and `none` do not. The
  // cost is known (the `none` baseline comment says so); it belongs here too,
  // or a mask GAP reads as 33 ms of panel that is 33 ms of instrument.
  //
  // It is therefore a bound on X — endedAt to base — and on NOTHING ELSE. It is
  // not a bound on the plane-down time: X sits INSIDE the dark interval —
  // the plane goes dark before endedAt, and nothing establishes a picture
  // was up at base —
  // so GAP minus the real dark time may be negative. See the ⚠️ in the
  // freezeMs/coverMs note; do not restate a bound here. The cover series
  // discloses its own +MASK_HOLD_MS constant, and this one went undisclosed
  // while being the headline.
  var MASK_PROGRESS_MS = 150;
  // Raised this long BEFORE the stream ends. onstreamcompleted fires after
  // the plane has already gone dark, so a mask raised there is always one
  // blink late — which is the blink that was left.
  // Keep in step with PRE_MASK_SEC in build.sh: the poster is the frame the
  // clip shows at exactly this distance from the end, so raising the mask
  // freezes the picture where it already was.
  var PRE_MASK_MS = 400;
  // A decode that has not settled by now is treated as one that never will:
  // the card goes up regardless, because a late picture beats a dead playlist.
  var PHOTO_DECODE_MS = 400;
  var endWatch = null;
  // Three ways to hide the teardown, cycled with 0 from the remote so one
  // bench session can judge all of them in a row:
  //   'still' setVideoStillMode("true") — Samsung's documented single-mode
  //           route: the platform holds the outgoing clip's last frame on
  //           the video plane itself. There is no second rendering path, so
  //           there is no colour or scaling to get wrong.
  //   'mask'  an opaque DOM layer carrying that frame as a PNG. Works on any
  //           firmware, but it IS a second rendering path, and the bench saw
  //           it shift colour and scale against the decoder.
  //   'none'  nothing — the bare seam, which is what the gap numbers mean.
  // 'still' leads because it is the better answer where it exists; cover()
  // falls back to 'mask' by itself on a panel that lacks the method.
  var COVERS = ["still", "mask", "none"];
  var coverAt = 0;
  var stillHeld = false;
  // full -> minimal (two lines) -> off. A transition cannot be judged in the
  // strip left between two readout panels.
  var hudStates = ["", "hud-min", "hud-off"];
  var hudAt = 2; // 0 full, 1 minimal, 2 off — judging a seam needs the screen
  try {
    var stored = localStorage.getItem("hud2");
    if (stored !== null) {
      var parsed = Number(stored);
      // NaN or out of range would give hudStates[NaN] === undefined and
      // (NaN + 1) % 3 === NaN, so the readout key would never work again.
      // The integer test is part of that, not pedantry: 1.5 passes a range
      // check, hudStates[1.5] is undefined and (1.5 + 1) % 3 is 2.5 — the
      // exact failure the range check was added to prevent.
      if (parsed === (parsed | 0) && parsed >= 0 && parsed < hudStates.length) {
        hudAt = parsed;
      }
    }
  } catch (e) {
    /* storage can be refused; the default is fine */
  }
  var logEl = document.getElementById("log");
  var capsEl = document.getElementById("caps");
  var lines = [];
  // Deliberately the WALL clock, unlike every measurement in this file:
  // this prefix lines a log line up against a recording or a phone photo,
  // which carry wall time. It is a timestamp, not a sample.
  var t0 = Date.now();

  function stamp() {
    var ms = Date.now() - t0;
    // Padded, never truncated. Any fixed width wraps eventually — seven
    // digits at 2 h 46 min — and a stamp that silently restarts at 0000000
    // is worse than a wide one when the whole point is to lay a soak
    // recording and this log side by side.
    // An NTP step after boot can take Date.now() backwards, and a negative
    // number padded by slice() comes out as "00000-5".
    if (ms < 0) return "-------";
    var s = String(ms);
    return s.length >= 7 ? s : ("000000" + s).slice(-7);
  }
  // Substituted from the SINK environment variable at packaging time, and
  // left as the placeholder in git so no bench address is committed. Empty
  // means off, which is the state any build without SINK= is in.
  var SINK = "@SINK@";
  var pending_lines = [];
  var sinkTimer = null;

  // The panel refuses `sdb shell` output and dlogutil returns nothing, so the
  // HUD is the only readout — and a twelve-line window that two seams wipe.
  // Posting the lines is the only way a run reaches another machine whole.
  //
  // Batched on a timer and fired and forgotten: this runs inside measured
  // intervals, and an instrument that perturbs what it measures is worse than
  // one with no remote log at all. Every failure is swallowed for the same
  // reason — a sink that is down must cost a run nothing.
  function ship() {
    sinkTimer = null;
    if (!pending_lines.length) return;
    var body = pending_lines.join("\n");
    pending_lines = [];
    try {
      var x = new XMLHttpRequest();
      x.open("POST", SINK, true);
      // The sibling in shipImage() states the rule: without this, ontimeout
      // is dead and the XHR default is "wait for ever". A sink that accepts
      // the connection and never answers would otherwise accumulate one
      // never-settling request every two seconds until the per-origin
      // connection cap fills — and the capture POST then queues behind them.
      x.timeout = 5000;
      x.send(body);
    } catch (e) {
      /* the bench is not the network's business */
    }
  }

  function log(s) {
    var line = stamp() + " " + s;
    lines.push(line);
    if (lines.length > 12) lines.shift();
    logEl.textContent = lines.join("\n");
    // Mirrored so the run survives the screen: `sdb dlog` or Web Inspector.
    if (window.console && console.log) console.log(line);
    if (SINK.charAt(0) === "h") {
      pending_lines.push(line);
      if (sinkTimer === null) sinkTimer = setTimeout(ship, 2000);
    }
  }
  var capsText = "";
  // Its own slot, because caps() ASSIGNS capsText: press 3 — the key the help
  // line offers for reading the capability panel — and describe() would wipe
  // a warning that says every cover number on screen is void. Prepended by
  // summary() instead, so nothing can overwrite it.
  var geomWarn = "";
  // A poster that 404s leaves the mask painting its own #000 through the
  // hole, which is indistinguishable from the black this probe measures.
  // TWO warnings, because they void different things. A missing POSTER only
  // breaks the mask: a freeze lives in the display buffer and touches no PNG.
  // A missing CARD IMAGE breaks every strategy — showCard() closes the sample
  // the moment the card paints, and a 404 paints black, so the freeze and the
  // cover series both record a black card as a clean cover. Sharing one
  // variable let the mask-only gate hide the strategy-independent fault,
  // which is the case the card warning was added for.
  var posterWarn = "";
  var cardWarn = "";
  var postersLoaded = 0;
  var posterTotal = 0;
  var photosLoaded = 0;
  var photoTotal = 0;
  var postersMissing = [];
  var cardsMissing = [];
  function countKeys(o) {
    var k,
      c = 0;
    for (k in o) {
      if (Object.prototype.hasOwnProperty.call(o, k)) c += 1;
    }
    return c;
  }
  // Lost samples, counted PER SERIES. A single counter printed beside one
  // mean could not say which mean was short — the same objection that split
  // freezeMs from coverMs, applied to the tally. Printed as (-n) next to the
  // series it belongs to, because a mean that quietly rests on fewer samples
  // than the seams you watched is the kind of lie this file exists to avoid.
  var lostGap = 0;
  var lostFreeze = 0;
  var lostCover = 0;
  var armText = "";
  // Bounded. armText sits ABOVE capsText in summary(), #caps is clipped at
  // 38vh, and the keydown handler echoes every press into here — so a dozen
  // presses pushed the capability answer, which key 3 exists to show, out of
  // the panel with no way to bring it back on a halted run. Oldest lines go
  // first: the newest arm lines are the ones being read.
  var ARM_LINES = 14;
  function armLog(s) {
    armText += s + "\n";
    var lines = armText.split("\n");
    if (lines.length > ARM_LINES) {
      armText = lines.slice(lines.length - ARM_LINES).join("\n");
    }
    if (window.console && console.log) console.log(s);
    summary();
  }
  function caps(s) {
    capsText = s;
    if (window.console && console.log) console.log(s);
    summary(); // never write the panel without the running total on top
  }
  // The arming lines are six per player and would scroll the result away, so
  // the running total lives in the panel that never scrolls.
  function lost(n) {
    return n ? " (-" + n + ")" : "";
  }

  // 0 means "not worked out yet", and a budget that cannot be worked out
  // stays 0 so the check simply never fires. It may under-report clipping;
  // it may not invent it.
  var capLineBudget = 0;
  // Attempted once, not once per summary(): if the ceiling turns out to be
  // unreadable the budget stays 0 forever, and keying the retry off that 0
  // would call getComputedStyle on every log line of every seam — a style
  // flush in the hot path, which is what budgeting was for.
  var capBudgetTried = false;
  // The CEILING, never the current height. #caps is `max-height: 38vh` with
  // overflow:hidden, so clientHeight tracks the CONTENT until it reaches
  // that ceiling — budget it from clientHeight and a short readout yields a
  // small budget, which a longer readout then exceeds while still fitting
  // on the panel. That is a banner on a readout nothing is wrong with: the
  // same class of lie as the clipping, pointing the other way. maxHeight
  // resolves to px (vh is viewport-relative, not parent-relative) and is
  // readable even in the two states that hide the panel outright.
  function measureCapLineBudget() {
    // Always writes. It is both the first measurement and the re-measurement
    // after a resize, and in the second role an early return below would
    // otherwise leave a budget computed for the OLD viewport standing — too
    // large after a shrink (a silent miss) or too small (a false banner).
    // Clearing first makes the promise above, "a budget that cannot be
    // worked out stays 0", true on both paths.
    capLineBudget = 0;
    var css = window.getComputedStyle(capsEl);
    // parseFloat cannot tell px from a percentage: `max-height: 38%` parses
    // as 38, passes the >0 guard, and budgets one line — which brands every
    // multi-line readout clipped, forever. Demand the unit.
    if (!/px$/.test(css.maxHeight)) return; // "none", "38%", unreadable
    var ceiling = parseFloat(css.maxHeight);
    if (!(ceiling > 0)) return;
    var lh = parseFloat(css.lineHeight);
    // A computed "normal" parses as NaN. Falling back to the stylesheet's
    // own 17px x 1.2 keeps the budget honest rather than disabling the
    // check silently, which would be the clipping problem over again.
    if (!(lh > 0)) lh = 17 * 1.2;
    // max-height caps the CONTENT box, but overflow:hidden clips at the
    // PADDING box — so the bottom padding is extra room the content may be
    // drawn into, not room taken away from it. An earlier version here
    // subtracted both paddings, which put the budget a full line under what
    // the panel really shows: at 1080x1920 it budgeted 35 lines against 36
    // visible, and printed CLIPPED over a readout with nothing cut off.
    // That is the banner lying in the one direction it must not.
    var padBottom = parseFloat(css.paddingBottom) || 0;
    // Floor: a partly visible last line is not a readable line.
    capLineBudget = Math.floor((ceiling + padBottom) / lh);
    if (capLineBudget < 1) capLineBudget = 1;
  }
  // A resize changes what 38vh is worth, and a stale budget would then
  // either cry clipping or miss it. Measured HERE rather than by clearing
  // the flag for the next summary() to pick up: that next summary() can be
  // the one inside a seam, which would move the style flush into the hot
  // path this is all arranged to keep it out of.
  window.addEventListener("resize", function () {
    capBudgetTried = true;
    measureCapLineBudget();
  });
  // Wrapped lines still count as one, so the budget is optimistic: a readout
  // can be clipped without this firing. It never fires when nothing is cut.
  function countLines(s) {
    var n = 1;
    for (var i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) === 10) n++;
    }
    return n;
  }
  function summary() {
    var text =
      geomWarn +
      clockWarn +
      cardWarn +
      posterWarn +
      // On the panel, not only in the log. A load that neither resolves nor
      // errors raises no banner at all, and "k of N" in a twelve-line window
      // is gone within two seams — so the one place that never scrolls says
      // standing, and a short count is visible for as long as it is true.
      "posters " +
      postersLoaded +
      "/" +
      posterTotal +
      "  cards " +
      photosLoaded +
      "/" +
      photoTotal +
      "\n" +
      armText +
      // `clean` and `all` are printed separately only when they can differ.
      // Nothing currently sets tag.synced, so cleanGaps is gaps, and two
      // equal means under "clean" and "all" invite the reader to conclude
      // the run excluded contaminated seams — a conclusion the readout
      // cannot support, because the thing that would mark one is not wired.
      // Restoring a caller that sets synced restores the split by itself.
      (cleanGaps.length === gaps.length
        ? "GAP mean " + mean(gaps) + " ms n=" + gaps.length + lost(lostGap)
        : "clean mean " +
          mean(cleanGaps) +
          " ms n=" +
          cleanGaps.length +
          lost(lostGap) +
          "   all " +
          mean(gaps) +
          " ms n=" +
          gaps.length) +
      // BEFORE the groups. The counter is per SERIES, but meanByKind ends
      // in a per-kind group, so trailing it read as "three lost video>video"
      // against a group showing n=1 — alarming and false. Ahead of the
      // groups it reads as what it is: lost across all kinds.
      "   freeze" +
      lost(lostFreeze) +
      " " +
      meanByKind(freezeMs) +
      "   cover" +
      lost(lostCover) +
      " " +
      meanByKind(coverMs) +
      "   cover=" +
      covering() +
      "   list=" +
      (list === CAMPAIGN ? "CAMPAIGN" : "UNIFORM") +
      "   rot=" +
      rotation.replace("PLAYER_DISPLAY_ROTATION_", "") +
      "\n" +
      capsText;
    // #caps is clipped at 38vh with overflow:hidden, and capsText sits LAST
    // — so the capability answer, the thing key 3 exists to show, is the
    // first thing a long readout loses, and it is lost SILENTLY. A readout
    // that looks complete and is not is the one failure this instrument may
    // not have. This does not fix the clipping; it refuses to hide it.
    //
    // Counted, NOT measured per call. summary() runs from log(), armLog()
    // and caps(), which fire inside the seams this file times to the
    // millisecond, and reading scrollHeight or clientHeight forces a
    // synchronous layout — so the obvious check would add its own cost to
    // the very numbers it sits beside. The ceiling and the line height are
    // both fixed, so one read of the computed style buys a line budget.
    if (!capBudgetTried) {
      capBudgetTried = true;
      measureCapLineBudget();
    }
    // Counted on the text BEFORE the banner, so switching it on cuts two
    // further lines off the end — off capsText, the capability answer. The
    // trade is deliberate: a short answer under a banner that says so beats
    // a whole answer that looks complete and is not.
    if (capLineBudget > 0 && countLines(text) > capLineBudget) {
      text =
        "*** PANEL CLIPPED — more here than the panel shows, and what is\n" +
        "    cut off is the END: the capability answer ***\n" +
        text;
    }
    capsEl.textContent = text;
  }
  // A thrown value tells you WHICH answer you got: SecurityError means the
  // certificate did not grant the privilege, NotSupportedError means the
  // firmware does not have it. Dropping the name loses the distinction.
  function why(e) {
    return (
      (e && e.name ? e.name : "Error") +
      ": " +
      (e && e.message ? e.message : String(e))
    );
  }
  window.onerror = function (msg, url, line) {
    log("window.onerror " + msg + " @" + line);
    return false;
  };

  /* -------------------------------------------------------- capabilities */

  function names(obj) {
    var out = [];
    try {
      for (var k in obj) out.push(k);
    } catch (e) {
      /* native bindings can refuse enumeration */
    }
    return out.sort();
  }
  // `for...in` misses non-enumerable native bindings, so an empty list is not
  // evidence of an empty object. Probe the expected names directly too.
  function present(obj, candidates) {
    var found = [];
    for (var i = 0; i < candidates.length; i++) {
      try {
        if (obj && typeof obj[candidates[i]] !== "undefined")
          found.push(candidates[i]);
      } catch (e) {
        /* accessing a guarded property can throw */
      }
    }
    return found;
  }

  var B2B_CANDIDATES = [
    "rebootDevice",
    "reboot",
    "captureScreen",
    "getCaptureScreen",
    "setPowerStatus",
    "getPowerStatus",
    "setPanelMute",
    "getPanelMute",
    "setDisplayOrientation",
    "getModelCode",
    "getSerialNumber",
    "getFirmwareVersion",
  ];

  // Three places it may live, and a bench may find a fourth. One function,
  // so that discovery is one edit rather than two that can drift apart.
  // Samsung documents two seamless modes. Mixer mode (two players) is
  // refused by this panel; single mode rests on setVideoStillMode, which the
  // bench has never called. `for...in` misses native bindings, so ask by name.
  var AVPLAY_CANDIDATES = [
    "setVideoStillMode",
    "getVideoStillMode",
    "setNextURI",
    "changeURL",
    "getVideoSeamlessInfo",
    "setStreamingProperty",
    "setDisplayRotation",
    "setDisplayRect",
    "suspend",
    "restore",
  ];

  function anyPlayer() {
    if (players.length) return players[0];
    try {
      // RECORDED, not merely returned. getPlayer() allocates, and the panel
      // has a hard ceiling: "QuotaExceededError: Max player count reached".
      // An instance handed out here and left out of `players` is one that
      // shutdown() cannot close and start() will not reuse — so it leaks,
      // once per call, every time this is reached before start() has
      // allocated. begin() runs describe() first, and describe() asks
      // covering() -> hasStill() -> anyPlayer(), so that is every boot.
      var got = webapis.avplaystore.getPlayer();
      // Checked, not assumed. A firmware that returns undefined WITHOUT
      // throwing would otherwise leave players = [undefined] for the rest of
      // the run: start()'s `if (!players.length)` is then false, stop() is
      // swallowed by its own catch, and the first real symptom is a
      // TypeError from open() — which reads as a broken probe rather than as
      // "this panel would not hand over a player".
      if (!got) return null;
      players = [got];
      return players[0];
    } catch (e) {
      return null;
    }
  }

  function b2bControl() {
    if (typeof webapis !== "undefined") {
      if (webapis.b2bapis && webapis.b2bapis.b2bcontrol)
        return webapis.b2bapis.b2bcontrol;
      if (webapis.b2bcontrol) return webapis.b2bcontrol;
    }
    if (typeof b2bapis !== "undefined" && b2bapis.b2bcontrol)
      return b2bapis.b2bcontrol;
    return null;
  }

  function describe() {
    var out = [];
    out.push(
      "webapis   : " +
        (typeof webapis === "undefined" ? "MISSING" : names(webapis).join(" ")),
    );
    out.push(
      "b2bapis   : " +
        (typeof b2bapis === "undefined"
          ? "MISSING (global)"
          : names(b2bapis).join(" ")),
    );
    if (typeof webapis !== "undefined") {
      [
        "avplaystore",
        "avplay",
        "b2bapis",
        "b2bcontrol",
        "productinfo",
        "network",
      ].forEach(function (k) {
        var v;
        try {
          v = webapis[k];
        } catch (e) {
          out.push("webapis." + k + " threw " + why(e));
          return;
        }
        if (typeof v !== "undefined")
          out.push("webapis." + k + " : " + names(v).join(" "));
      });
      var b2b = b2bControl();
      out.push(
        "b2bcontrol methods found: " +
          (b2b
            ? present(b2b, B2B_CANDIDATES).join(" ") ||
              "(none of the probed names)"
            : "NO b2bcontrol OBJECT"),
      );
      var ap = anyPlayer();
      out.push(
        "avplay methods found: " +
          (ap
            ? present(ap, AVPLAY_CANDIDATES).join(" ") ||
              "(none of the probed names)"
            : "NO PLAYER"),
      );
      // covering(), not COVERS[coverAt]: the strategy that will actually
      // run. Deciding this from hasStill() alone let the panel report "still"
      // after a still that THREW had fallen back to the mask — and an
      // operator would then film six mask seams and write them down as still.
      // Hoisted: calling covering() three times in one expression is the
      // pattern that leaked players before anyPlayer() started recording
      // what it allocates, and it has no business coming back.
      var runs = covering();
      var wanted = COVERS[coverAt];
      var note = "";
      if (runs !== wanted) {
        // "unavailable" would be a claim about the firmware. Only say that
        // when a player answered the question — and a player that THREW
        // answered it too, with "refused", which is a different answer.
        // stillBroken is set only from a throw, so it separates the two.
        // if/else, not a nested ternary: the project's own style rule, and
        // it asks stillSupport() once instead of twice.
        var support = stillSupport();
        if (support === "unknown") {
          note = "   (" + wanted + ": UNKNOWN, no player could be allocated)";
        } else if (stillBroken && support === "yes") {
          note =
            "   (" + wanted + " refused here: the method exists and threw)";
        } else {
          note = "   (" + wanted + " unavailable here)";
        }
      }
      out.push("cover strategy: " + runs + note);
      ["getModel", "getFirmware", "getDuid"].forEach(function (fn) {
        try {
          out.push("productinfo." + fn + "() = " + webapis.productinfo[fn]());
        } catch (e) {
          out.push("productinfo." + fn + "() " + why(e));
        }
      });
    }
    try {
      var info = tizen.application.getCurrentApplication().appInfo;
      out.push(
        "app: " + info.id + " pkg=" + info.packageId + " v" + info.version,
      );
    } catch (e) {
      out.push("appInfo " + why(e));
    }
    out.push("screen: " + window.innerWidth + "x" + window.innerHeight);
    // Which clock the stall window runs on. A fallback to Date.now()
    // means a clock step can still cost clean samples, and the reader of
    // these numbers is entitled to know which case this panel is.
    out.push(
      "stall clock: " +
        (monotonic ? "performance.now() (monotonic)" : "Date.now() — CAN STEP"),
    );
    caps(out.join("\n"));
  }

  /* --------------------------------------------------------- the players */

  // Packaged beside the widget by build.sh. Local files, like Samsung's own
  // seamless sample: streaming would put network time inside the measurement
  // and make UNIFORM-vs-MIXED a comparison of two variables at once.
  //
  // An item, not a filename: a campaign is videos AND stills, and a spine
  // that only knows how to hold a filename ends up deciding what kind of
  // thing it is in five places. `ms` is how long a still stays up; a video
  // is as long as it is.
  var UNIFORM = [
    { kind: "video", file: "u1.mp4" },
    { kind: "video", file: "u2.mp4" },
    { kind: "video", file: "u3.mp4" },
  ];
  // Every transition a real campaign has, in one loop, in this order:
  //   u1->u2 video->video    u2->card  video->still
  //   card->photo still->still   photo->card still->still
  //   card->u3  still->video     u3->u1  video->video (the wrap)
  var CAMPAIGN = [
    { kind: "video", file: "u1.mp4" },
    { kind: "video", file: "u2.mp4" },
    { kind: "card", id: "emoji", ms: 6000 },
    { kind: "photo", file: "p1.png", ms: 6000 },
    { kind: "card", id: "text", ms: 6000 },
    { kind: "video", file: "u3.mp4" },
  ];

  // Written here rather than drawn into a PNG at build time, deliberately:
  // whether this panel's Chromium renders an emoji at all — rather than a
  // tofu box — is a thing the product needs to know, and a pre-rendered
  // image would hide the answer.
  var CARDS = {
    emoji: {
      // Bench colours, deliberately bright: #1d1d1f is RGB(29,29,31), so a
      // card that arrived correctly was indistinguishable from an uncovered
      // plane. "Black between video and image" has to mean a gap, not a
      // dark card, before it is worth chasing.
      bg: "linear-gradient(160deg, #c8102e 0%, #f08a00 100%)",
      html:
        '<div class="kicker">Veckans erbjudande</div>' +
        '<div class="big">20&nbsp;%<br>på hårvård</div>' +
        '<div class="emoji">💇‍♀️ ✨ 🎉</div>',
    },
    text: {
      bg: "linear-gradient(160deg, #0e7a9c 0%, #39b6d8 100%)",
      html:
        '<div class="kicker">Boka online</div>' +
        '<div class="big">Alltid öppet<br>på digmi.se</div>' +
        '<div class="emoji">Gäller t.o.m. söndag</div>',
    },
  };

  // Derived from where this page was actually loaded from, which needs no
  // assumption about the package layout. The getAppSharedURI form is logged
  // beside it: if the two disagree that is itself an answer about firmware.
  function mediaRoot() {
    var here = location.href.replace(/[^/]*$/, "") + "media/";
    var shared = null;
    try {
      var pkg = tizen.application.getCurrentApplication().appInfo.packageId;
      shared =
        tizen.application
          .getAppSharedURI(pkg)
          .replace("/shared/", "/res/wgt/") + "media/";
    } catch (e) {
      log("getAppSharedURI " + why(e));
    }
    // Measured on a QB43C: location.href gives `file:///media/` here, not the
    // package path, and prepare() answers PLAYER_ERROR_INVALID_URI. The
    // getAppSharedURI form is the one that is right on this firmware. Both
    // are logged because it was the disagreement that found this.
    log(
      "media root: " +
        (shared || here) +
        (shared && shared !== here
          ? "   (location.href would have given " + here + ")"
          : ""),
    );
    return shared || here;
  }

  var list = UNIFORM;
  var cardEl = document.getElementById("card");
  var cardCovers = false; // a still held up ON PURPOSE, over a starting video
  var seamAt = 0; // start of the seam every trace line below is relative to
  var cardTimer = null;
  var root = "";
  var idx = 0;
  var players = [];
  var placed = [false, false];
  var rotation = "PLAYER_DISPLAY_ROTATION_0";
  var active = 0;
  var runId = 0; // a stale callback from a previous run must not act
  var consecutiveErrors = 0;
  var halted = false;
  var endedAt = null;
  // endedAt is written ONLY through setEnded(), so the stall flag clears on
  // every path that opens, closes or abandons the window — including the
  // key-0 strategy reset and showCard(), which both zero it directly and
  // would otherwise have carried a flag into an unrelated seam.
  var gapDirty = false;
  // The GAP sample is closed by this poll, not by an event, so it can only
  // ever be as sharp as this interval and a sub-tick stall is inside its own
  // quantisation. That argument is about GAP ALONE — freezeMs and coverMs are
  // closed by events at ~1 ms, so chargeStall() does not apply this floor to
  // them. Claiming it as a property of all three would be false.
  var POLL_MS = 16;
  // The point at which a seam stops being a seam and becomes a dead
  // panel. One constant, because chargeStall() uses it to tell a stall
  // from a clock step and the two must not drift apart.
  var GAP_DEADLINE_MS = 5000;
  // When the last shipping stall ended, and how long it was. A stall does
  // not only inflate the windows that are OPEN while it runs: it blocks the
  // thread that takes the stamps OPENING the next ones. onstreamcompleted
  // and the endWatch tick are both JS-thread events, so a stall straddling a
  // seam boundary makes both stamp late — and a late start measures a seam
  // SHORTER than the black the panel actually showed, with no open window at
  // the time to flag. That error flatters the result, which is the one
  // direction this file must never fail in. So the charge runs forward too.
  // A window [suspectFrom, suspectUntil), monotone in the end: a second,
  // shorter stall can no longer truncate an earlier, longer one's window.
  var suspectFrom = 0;
  var suspectUntil = 0;

  /**
   * The stall clock. Date.now() can step — NTP does it on a soak run, and
   * this file guards that in four other places — and every repair built on
   * it leaked: a monotone end paired with a fresh start after a backward
   * step turned a 20 ms stall into 45 s of suspicion, and a forward step
   * landing inside readBase64 reported a 50 ms block as 60 s. Those are the
   * same inflated `(-n)` the lost counters exist to prevent, so the window
   * is measured on a clock that cannot step. Reported at boot, because a
   * fallback to Date.now() changes what the numbers below are worth.
   *
   * @returns {number} milliseconds from an arbitrary origin, never backwards
   */
  var monotonic =
    typeof performance !== "undefined" &&
    performance &&
    typeof performance.now === "function"
      ? function () {
          return performance.now();
        }
      : null;
  function nowMs() {
    return monotonic ? monotonic() : Date.now();
  }

  // Only reachable on the fallback clock: performance.now() cannot go back.
  // Named rather than hidden inside the predicate below, which two callers
  // read as a question and which should not quietly rewrite state.
  function healClock(now) {
    if (now < suspectFrom) {
      // The stall is on the far side of the step, so the stored end means
      // nothing — keeping it paired a stale far-future end with a fresh
      // start, and a 20 ms stall then suspected 45 seconds of clean seams.
      suspectFrom = now;
      suspectUntil = 0;
    }
  }

  // A stamp taken within one stall-length of a stall is not trustworthy: it
  // could have been due at any point the thread was blocked. Conservative on
  // purpose — it costs at most one more named, counted drop per capture.
  function stampSuspect() {
    var now = nowMs();
    healClock(now);
    return suspectUntil > 0 && now < suspectUntil;
  }

  function chargeStall(startedAt) {
    var stall = nowMs() - startedAt;
    if (stall <= 0) return;
    // On the monotonic clock a long delta is definitionally a stall. Only the
    // fallback can report one that is really the wall clock moving, and even
    // then the windows that were open are poisoned either way — so this
    // decides the WORDING, never whether to charge. An earlier version
    // returned here instead, which handed the mean the very worst samples:
    // a 6700 ms cover printed as a measurement where it had been dropped.
    var stepped = !monotonic && stall > GAP_DEADLINE_MS;
    var now = nowMs();
    healClock(now);
    // healClock() may rewind this after a step; the authoritative start is
    // set here, and its call above is kept for the suspectUntil reset.
    suspectFrom = now;
    // Clamped to the deadline. Forward suspicion exists to catch a stamp the
    // stall delayed, and nothing legitimately waits longer than the point at
    // which this probe already declares the panel dead; without the clamp a
    // bogus 60 s would have voided a minute of clean seams.
    suspectUntil = Math.max(
      suspectUntil,
      now + Math.min(stall, GAP_DEADLINE_MS),
    );
    // The GAP close is a poll tick, so that sample already carries up to one
    // tick of quantisation and a sub-tick stall is inside its own noise.
    // freezeMs and coverMs are closed by EVENTS at ~1 ms, so POLL_MS is not a
    // property of those measurements and is deliberately not applied to them.
    var hitsGap = stall > POLL_MS;
    var hit = [];
    if (hitsGap && endedAt !== null) {
      gapDirty = true;
      hit.push("GAP");
    }
    if (cov.at !== null) {
      cov.dirty = true;
      hit.push(cov.how === "freeze" ? "frozen" : "covered");
    }
    if (!hitsGap && !hit.length) return; // below the floor and nothing open
    log(
      "capture shipping " +
        (stepped ? "reported " : "stalled ") +
        Math.round(stall) +
        " ms" +
        (stepped ? " (longer than the deadline — the clock stepped)" : "") +
        " — " +
        (hit.length
          ? hit.join(" and ") + " flagged"
          : "nothing open; a seam starting within " +
            // suspectUntil, not this stall's own length: a short stall after
            // a long one keeps the longer window, and naming 50 ms while
            // holding 2900 would understate it by a factor of 58.
            Math.round(suspectUntil - now) +
            " ms is suspect"),
    );
  }

  function setEnded(v) {
    // A non-null stamp over an open window throws that window away. This file
    // already contemplates the boundary arriving twice — "through onevent, or
    // not at all" — and an uncounted discard is the exact lie dropGap() was
    // added to remove. Unreachable on this panel, where every seam goes
    // through reopen(), but the invariant should not depend on firmware.
    if (v !== null && endedAt !== null) {
      // dropGap, not a bare increment: it was the only lost-counter site in
      // this file that would not repaint the panel, and a `(-n)` arriving a
      // seam late is the stale readout closeSample() and dropCover() both
      // argue against at length. It passes null, so it cannot re-enter here.
      dropGap("a second boundary arrived first");
    }
    endedAt = v;
    // Recomputed at every stamp, never merely cleared: closing or abandoning
    // the window drops the flag, and OPENING one inherits the suspicion of a
    // stall that may have delayed this very stamp.
    gapDirty = v !== null && stampSuspect();
  }
  var gaps = [];
  var poll = null;
  var watchdog = null;
  var lastStall = "";
  var clockWarn = "";
  var lastClock = null;
  var stuckTicks = 0;
  var lastStallAt = 0;
  // A synchronous arm happens INSIDE the measured interval, so its cost is
  // in the gap. Production would never do it, so those gaps are reported
  // separately rather than folded into the headline mean. The tag travels as
  // an argument, not as module state: every path that abandons a measurement
  // would otherwise have to remember to clear it, and two of them did not.
  var cleanGaps = [];

  function mean(a) {
    if (!a.length) return 0;
    var t = 0;
    for (var i = 0; i < a.length; i++) t += a[i];
    return Math.round(t / a.length);
  }

  /**
   * Per seam kind, because one mean over kinds closed by different events
   * describes none of them. For [604, 5, 604] tagged video>video,
   * video>card, video>video this emits
   * "video>video 604 ms n=2  video>card 5 ms n=1", where a single mean
   * printed 404 — a number that matched no seam on the panel.
   *
   * @param {Array<{ms: number, kind: string}>} a
   * @returns {string}
   */
  function meanByKind(a) {
    if (!a.length) return "0 ms n=0";
    var order = [];
    var sum = {};
    var cnt = {};
    for (var i = 0; i < a.length; i++) {
      var k = a[i].kind || "?";
      if (!Object.prototype.hasOwnProperty.call(sum, k)) {
        order.push(k);
        sum[k] = 0;
        cnt[k] = 0;
      }
      sum[k] += a[i].ms;
      cnt[k] += 1;
    }
    var out = [];
    for (var j = 0; j < order.length; j++) {
      var key = order[j];
      out.push(
        key + " " + Math.round(sum[key] / cnt[key]) + " ms n=" + cnt[key],
      );
    }
    return out.join("  ");
  }
  function rect(p, label) {
    var w = window.innerWidth;
    var h = window.innerHeight;
    try {
      armLog(
        "  rect " +
          label +
          " (" +
          w +
          "x" +
          h +
          ") = " +
          p.setDisplayRect(0, 0, w, h),
      );
    } catch (e) {
      armLog("  rect " + label + " " + why(e));
    }
  }

  // AVPlay draws behind the page on this panel, so an opaque layer in the
  // DOM hides the teardown; see the note on freezeMs/coverMs for what that
  // teardown costs. The poster is the OUTGOING clip's frame from PRE_MASK_MS
  // before its end — the -last.png name is shorthand, and the true last
  // frame would jump forward by that much. So the picture freezes on what it
  // was already showing, instead of cutting to an unrelated image and back.
  //
  // None of this would work with HTML5 video, which punches a hole in the
  // graphics plane and would sit in front of the mask.
  var posters = {};
  function preloadPosters() {
    var all = UNIFORM.concat(CAMPAIGN);
    for (var i = 0; i < all.length; i++) {
      if (all[i].kind !== "video") continue; // a still is its own cover
      var url = posterFor(all[i].file);
      if (posters[url]) continue;
      var img = new Image();
      // LOADED, not requested. The old line counted Object.keys(posters),
      // which is known before a byte arrives — so a build made without
      // ffmpeg (which this script permits, and warns about) packaged no
      // posters, the probe still printed "posters preloaded: 3", the mask
      // painted its #000 background through a 404, and every seam was
      // reported as covered while the screen was black for its whole
      // duration. The headline number would have reported the exact failure
      // this instrument exists to detect as a success.
      img.onload = function () {
        {
          // No clearing of posterWarn here: src is assigned once, so each
          // Image fires load OR error and never both. A branch that tried to
          // un-stick the banner could never run, and would have told the next
          // reader it self-heals.
          postersLoaded += 1;
          log("posters loaded: " + postersLoaded + " of " + posterTotal);
          summary();
        }
      };
      img.onerror = (function (u) {
        return function () {
          log("poster missing: " + u);
          postersMissing.push(u.replace(/^.*\//, ""));
          // Sticky AND forced open, exactly as the mask-geometry verdict is.
          // Two of the three readout states hide #caps outright, so writing
          // the one notice that invalidates the cover numbers into a hidden
          // panel would put it where nobody is looking — while the log line
          // saying the same thing is gone within a seam.
          posterWarn =
            "*** POSTER MISSING (" +
            postersMissing.join(" ") +
            ") — under `mask` the cover\n" +
            "    is then BLACK, so cover numbers measured that way are void ***\n";
          hudAt = 0;
          document.body.className = hudStates[hudAt];
          summary();
        };
      })(url);
      img.src = url;
      posters[url] = img;
    }
    posterTotal = countKeys(posters);
    log(
      "posters requested: " +
        posterTotal +
        " — loaded is reported as each arrives",
    );
  }

  // Three answers, not two. Without the third, a panel that simply could not
  // hand over a player (QuotaExceededError) was reported as a panel whose
  // FIRMWARE lacks still mode — a false statement about the hardware, written
  // into the one panel an operator reads the verdict off.
  function stillSupport() {
    var p = anyPlayer();
    if (!p) return "unknown";
    try {
      return typeof p.setVideoStillMode === "function" ? "yes" : "no";
    } catch (e) {
      return "unknown";
    }
  }

  function hasStill() {
    return stillSupport() === "yes";
  }

  // Which strategy this seam will actually use: 'still' degrades to 'mask'
  // rather than to nothing, so a panel without the method still looks right.
  // Set once a still attempt has THROWN. Without it, covering() keeps
  // answering "still" after cover() has quietly degraded to the mask, and the
  // two callers that ask a second time both do the wrong thing: advance()
  // skips afterPaint(), so the mask reaches the screen after the blocking
  // teardown it was raised to hide, and watchEnd() returns early, so no clip
  // gets its 400 ms lead at all. The bench would then read "the mask does not
  // work on this panel either" — a false answer to the probe's own question.
  var stillBroken = false;

  function covering() {
    var want = COVERS[coverAt];
    if (want === "still" && (stillBroken || !hasStill())) return "mask";
    return want;
  }

  // setVideoStillMode takes a DOMString, not a boolean: the IDL is
  // `void setVideoStillMode(DOMString mode)`, and the reference lists
  // TypeMismatchError for "an input parameter is not compatible with its
  // expected type". A boolean is refused by a panel that fully supports the
  // call, which reads exactly like a missing feature. It is not one.
  //
  // The two strategies need opposite timing, which is the whole reason this
  // is one function with a branch rather than one policy:
  //   'mask'  is a DOM layer, so it must be painted BEFORE the stream ends —
  //           stop/open/prepare are blocking, and nothing paints while they
  //           run. Hence watchEnd() and the 400 ms lead.
  //   'still' is instant and lives in the display buffer, below the JS
  //           thread, so blocking calls cannot uncover it. Samsung's own
  //           sample sets it at onstreamcompleted and releases it after
  //           prepare(), before play(). It needs no lead time at all, and
  //           giving it one re-freezes the stream that has just started.
  function posterFor(file) {
    return root + file.replace(".mp4", "-last.png");
  }

  // Not re-stamped while a cover is already up: watchEnd() raises the mask
  // PRE_MASK_MS before the stream ends and advance() then covers again, so
  // overwriting threw away the whole lead and under-reported by ~400 ms.
  function raiseCover(how) {
    if (cov.at !== null) return;
    // null, not 0: performance.now() is a float with no promise never to
    // return 0, and a falsy sentinel would read that as "no cover up".
    cov.at = nowMs();
    cov.how = how;
    cov.dirty = stampSuspect();
  }

  function closeSample() {
    if (cov.at === null) return;
    var ms = nowMs() - cov.at;
    cov.at = null;
    var freeze = cov.how === "freeze";
    var stalled = cov.dirty;
    // A clock stepped backwards by NTP makes this negative, and a negative
    // sample is plainly absurd in the log but INVISIBLE once it is inside a
    // mean. Dropped, with a reason.
    if (ms < 0) {
      if (freeze) {
        lostFreeze += 1;
      } else {
        lostCover += 1;
      }
      log((freeze ? "frozen" : "covered") + " sample dropped: clock went back");
      // The panel too. Leaving it untouched here is the same asymmetry the
      // summary() call below was added to remove: under `mask` the readout
      // would stand unchanged for a whole clip, and the log line saying why
      // is gone within a couple of seams.
      summary();
      return;
    }
    if (stalled) {
      if (freeze) {
        lostFreeze += 1;
      } else {
        lostCover += 1;
      }
      log(
        (freeze ? "frozen" : "covered") +
          " sample dropped: shipping a capture stalled this seam",
      );
      summary();
      return;
    }
    // Stored WITH its seam kind. The two-array split removed a mean that
    // spanned freeze and mask; this removes one that spans seam kinds inside
    // each. They are not merely costlier than one another — they are closed
    // by DIFFERENT events: video>video closes in releaseStill() after
    // stop/open/prepare (~604 ms here), video>card closes in showCard() the
    // moment a CSS card paints (single-digit ms). [604, 5, 604] printed
    // `freeze 404 ms`, which is no seam on this panel.
    var series = freeze ? freezeMs : coverMs;
    series.push({ ms: ms, kind: seamKind });
    log(
      (freeze ? "frozen " : "covered ") +
        Math.round(ms) +
        " ms " +
        seamKind +
        "   mean " +
        meanByKind(series),
    );
    // The panel is where these are read. Without this the mask strategy
    // closes its sample 250 ms AFTER the GAP line's summary() and the
    // non-scrolling panel shows n-1 for the whole next clip, while the still
    // strategy — which closes inside reopen(), just before an armLog() —
    // shows it at once. That asymmetry between strategies is the thing this
    // file exists to avoid.
    summary();
  }

  function cover(file) {
    var how = covering();
    if (how === "none") return "none";
    if (how === "still") {
      try {
        // ONLY the call, and stillHeld set from its result before anything
        // else can throw. A throw out of log() would otherwise be caught
        // below with the freeze genuinely held and stillHeld still false —
        // after which releaseStill() and uncover() both early-return and the
        // panel keeps a frozen frame for the rest of the run, which this file
        // calls worse than a visible fault.
        var stillRes = anyPlayer().setVideoStillMode("true");
        stillHeld = true;
        log('stillMode("true") = ' + stillRes);
        raiseCover("freeze");
        return "still";
      } catch (e) {
        // Not a reason to show black: fall through to the layer that works.
        log("stillMode(true) " + why(e) + " — falling back to the mask");
        stillBroken = true;
        // This is the third way into an effective mask, and it was the one
        // that announced nothing: the boot banner and the key-0 announce
        // both cover a mask the operator ASKED for, while this one arrives
        // mid-run. With a poster missing the fallback paints #000 through a
        // 404, and coverMs then fills with black screens recorded as clean
        // covers — in a readout the operator has legitimately closed,
        // because under `still` the lock does not apply.
        if (posterWarn) {
          hudAt = 0;
          document.body.className = hudStates[hudAt];
          log("still degraded to mask, and a poster is missing: cover void");
          // Repainted, or the panel this just forced open keeps saying
          // cover=still directly above a banner that begins "under `mask`" —
          // a warning that reads as not applying. The other three announce
          // sites all call this.
          summary();
        }
      }
    }
    maskEl.style.backgroundImage = "url('" + posterFor(file) + "')";
    maskEl.className = "on";
    raiseCover("cover");
    return "mask";
  }

  // Samsung's order, on one player because this panel refuses two:
  //   setVideoStillMode("true") -> stop -> open -> prepare
  //   -> setVideoStillMode("false") -> play
  // The release belongs between prepare() and play(), not on a timer after
  // the clock moves: by then the picture has been frozen for a whole clip.
  function releaseStill() {
    if (!stillHeld) return;
    stillHeld = false;
    try {
      log('stillMode("false") = ' + anyPlayer().setVideoStillMode("false"));
    } catch (e) {
      log("stillMode release " + why(e));
    }
    // Only a sample THIS freeze was measuring. Under `still` in CAMPAIGN the
    // freeze is still held across the card suite while the card covers the
    // next seam; closing that sample here would file the teardown as a
    // freeze and leave the card's measurement open.
    if (cov.how === "freeze") closeSample();
  }

  // Must run on every path that stops being mid-seam, including the ones
  // that give up: a cover left standing over a dead panel is a screen that
  // looks fine and shows nothing, which is worse than a visible fault.
  /**
   * @param {boolean} [abandoned] True when nothing took over: a restart, a
   *   stall deadline, or a halted run. Such a cover measured nothing, so its
   *   elapsed time must not reach the mean — one key press in the middle of a
   *   six-second card would otherwise write six seconds into it — and the
   *   handover line below would claim a handover that did not happen.
   */
  // Clearing cov.at makes closeSample() return early, so a window discarded
  // here vanished without touching freezeMs/coverMs OR lostFreeze/lostCover —
  // an `n` quietly shorter than the seams watched, which is the exact lie the
  // lost counters exist to remove. Surfaced by review; predates the capture
  // work.
  // The cover half of an abandoned seam has been counted since dropCover()
  // landed; the GAP half was not, on three paths, so the same abandoned seam
  // marked one series and left the other silently one sample short. Only the
  // deadline branch did it, by hand. Pre-existing.
  function dropGap(reason) {
    if (endedAt === null) return;
    setEnded(null);
    lostGap += 1;
    log("GAP sample dropped: " + reason);
    summary();
  }

  function dropCover(reason) {
    if (cov.at === null) return;
    var freeze = cov.how === "freeze";
    cov.at = null;
    if (freeze) {
      lostFreeze += 1;
    } else {
      lostCover += 1;
    }
    log((freeze ? "frozen" : "covered") + " sample dropped: " + reason);
    summary();
  }

  function uncover(abandoned) {
    if (abandoned) dropCover("the cover was abandoned");
    if (stillHeld) {
      stillHeld = false;
      // Dropped, not handed over: whatever this freeze was measuring
      // measured nothing.
      if (cov.how === "freeze") dropCover("the freeze measured nothing");
      try {
        log('stillMode("false") = ' + anyPlayer().setVideoStillMode("false"));
      } catch (e) {
        log("stillMode(false) " + why(e));
      }
    }
    maskEl.className = "";
    if (cardCovers) {
      cardCovers = false;
      cardEl.className = "";
      log(
        abandoned
          ? "cover dropped, nothing took over"
          : "still handed over to the video",
      );
    }
    closeSample();
  }

  function afterPaint(fn) {
    if (window.requestAnimationFrame) {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          setTimeout(fn, 0);
        });
      });
    } else {
      setTimeout(fn, 32);
    }
  }

  // The only way to cover the end of a stream is to be covering it before
  // the stream ends. Duration and position are both in milliseconds.
  function watchEnd() {
    clearInterval(endWatch);
    // Only the mask needs a lead. Arming this for still mode is what froze
    // the panel on a customer logo for a whole clip: the new stream's clock had
    // not reset, so `dur - now` was already inside the window and the freeze
    // went straight back up one tick after being released.
    if (covering() !== "mask") return;
    var raised = false;
    // A clock still reading the previous stream must not be allowed to raise
    // anything. Only after one sample has been seen mid-stream is the end of
    // THIS stream a thing that can be approached.
    var armed = false;
    endWatch = setInterval(function () {
      if (halted || !players.length) return;
      var p = players[0];
      var dur, now;
      try {
        dur = p.getDuration();
        now = p.getCurrentTime();
      } catch (e) {
        return;
      }
      if (!dur || dur <= 0) return;
      if (!armed) {
        if (dur - now > PRE_MASK_MS) armed = true;
        return;
      }
      if (list[idx].kind !== "video") {
        clearInterval(endWatch); // a card has no poster to pre-mask with
        return;
      }
      if (!raised && dur - now <= PRE_MASK_MS) {
        raised = true;
        clearInterval(endWatch);
        log("pre-mask at " + Math.round(now) + "/" + Math.round(dur) + " ms");
        cover(list[idx].file);
      }
    }, 40);
  }

  function state(p) {
    try {
      return p.getState();
    } catch (e) {
      return "state? " + why(e);
    }
  }

  // The plane cannot be observed from here, so watch the clock instead: the
  // moment the incoming stream's time starts advancing is the closest thing
  // JS has to "a frame was shown". It is still not the plane.
  function watchStart(tag) {
    // kind labels the seam: a mean over two different operations describes
    // neither of them.
    tag = tag || { synced: false, ms: 0, kind: "?" }; // a future caller cannot break the interval
    clearInterval(poll);
    var base = null;
    var since = nowMs();
    poll = setInterval(function () {
      // The deadline comes FIRST. Behind the halted guard, and behind the
      // catch below, it was unreachable — and this is the one case it exists
      // for: the run gives up mid-seam and the cover never comes down.
      if (nowMs() - since > GAP_DEADLINE_MS) {
        clearInterval(poll);
        log(
          "GAP >" +
            GAP_DEADLINE_MS +
            " ms — no picture within the deadline, state=" +
            state(players[active]),
        );
        // The stall costs the gap sample outright. Counted, or the panel
        // would show `n=5` after six seams with nothing to say why, and the
        // GAP >5000 line is out of the twelve-line window within two seams.
        //
        // The COVER half is NOT counted here: uncover(true) -> dropCover()
        // owns it now and names it in the log. This branch used to do it by
        // hand, which was right while uncover() only cleared cov.at — keeping
        // both charged one lost seam twice, and `(-n)` is the number that
        // exists to make a short `n` honest.
        uncover(true); // a stall must be visible, never covered up
        // Through dropGap, which no-ops when no window is open. start() arms
        // this poll with endedAt === null for the FIRST clip, and the bare
        // increment counted a lost sample there for a window that never
        // opened — nothing had ended, so nothing was lost.
        dropGap("the deadline");
        // The run does NOT continue from here. advance() is reached only
        // from onstreamcompleted and cardTimer, and the pathology this
        // branch exists for — a clock that never advances — never produces
        // either. Without this line the single "GAP > deadline" line reads
        // as one bad seam while the instrument sits there, and the watchdog
        // repeating STALLED every 30 s is the only hint. Not hanging is this
        // file's second principle; sitting silently is the quiet version.
        log("the run has stopped advancing — press 1 to restart it");
        return;
      }
      if (halted) {
        clearInterval(poll); // or uncover() runs every 16 ms for five seconds
        uncover(true);
        dropGap("the run was halted mid-seam");
        return;
      }
      var p = players[active];
      var t;
      try {
        t = p.getCurrentTime();
      } catch (e) {
        return;
      }
      // A stream whose clock never advances is the plane up and empty — the
      // exact pathology this probe hunts. Silence would be the one outcome
      // that does not appear, so it gets a deadline and a line of its own.
      // A clock that goes BACKWARDS was reading the previous stream when
      // base was taken. Keeping that base makes `t > base + …` unreachable
      // for the whole clip: a false GAP past the deadline, a cover pulled down
      // mid-clip and a measurement thrown away.
      if (base === null || t < base) {
        base = t;
        return;
      }
      // Not the first tick: wait until the new stream has actually advanced
      // through some content. getCurrentTime() moves when decoding starts,
      // which is earlier than a picture on the plane.
      if (t > base + MASK_PROGRESS_MS) {
        clearInterval(poll);
        setTimeout(function () {
          uncover(); // wrapped: an engine's lateness arg would read as abandoned
        }, MASK_HOLD_MS);
        if (endedAt !== null) {
          var ms = nowMs() - endedAt;
          if (ms < 0) {
            lostGap += 1;
            log("GAP sample dropped: clock went back");
            setEnded(null);
            summary();
          } else if (gapDirty) {
            lostGap += 1;
            log("GAP sample dropped: shipping a capture stalled this seam");
            setEnded(null);
            summary();
          } else {
            gaps.push(ms);
            if (!tag.synced) cleanGaps.push(ms);
            log(
              "GAP " +
                Math.round(ms) +
                " ms " +
                (tag.kind || "?") +
                (tag.synced
                  ? " (incl. sync arm " + tag.ms + " ms — NOT a clean seam)"
                  : "") +
                "   clean mean " +
                mean(cleanGaps) +
                " ms n=" +
                cleanGaps.length,
            );
            setEnded(null);
            summary();
          }
        }
      }
    }, POLL_MS);
  }

  function bumpError() {
    consecutiveErrors += 1;
    if (consecutiveErrors >= list.length * 3) {
      halted = true;
      clearInterval(poll);
      uncover(true); // never leave a frozen picture over a run that has given up
      dropGap("the run gave up mid-seam");
      log(
        "HALTED — " + consecutiveErrors + " consecutive failures, not looping",
      );
    }
  }

  // Every silent death found in review — a player left IDLE, a clock that
  // never advanced, a closed instance — shows up the same way: nothing is
  // playing and nothing says so. One timer catches all of them.
  function armWatchdog() {
    clearInterval(watchdog);
    // Module state, so without this a halted run leaves lastClock and
    // stuckTicks set and the NEXT run's first tick can compare against a
    // position from the old one — printing CLOCK FROZEN as fact, on tick 1,
    // about a run that is playing correctly. Worse, the remedy that line
    // prescribes ("press 1") is what re-arms the trap.
    lastClock = null;
    stuckTicks = 0;
    watchdog = setInterval(function () {
      if (halted || !players.length) return;
      // One player, by design — getPlayer() allocates against a system
      // ceiling and players is never longer than 1. Reading players[1] made
      // state() catch and stringify a TypeError into EVERY stalled line,
      // which reads as a probe bug on a perfectly healthy run.
      var s0 = state(players[0]);
      var now = "active=p" + active + " state " + s0;
      // The clock, not just the state. This file's own header says
      // getState() can report PLAYING while the plane is down — and from
      // ~MASK_PROGRESS_MS into a clip until onstreamcompleted, NOTHING
      // samples getCurrentTime(): watchEnd() returns early under still/none
      // and is cleared when the pre-mask fires under mask. So the pathology
      // the file names at onstreamcompleted ("may surface here, through
      // onevent, or not at all") produced no line, no verdict and no
      // advance, while the panel said PLAYING and the readout kept showing
      // the last mean. Not hanging is this file's second principle, and
      // sitting silently is the quiet version of hanging.
      // No players.length test: the caller returned on !players.length two
      // lines up, and state(players[0]) above dereferences it unguarded.
      var t0now = null;
      try {
        t0now = players[0].getCurrentTime();
      } catch (e) {
        t0now = null;
      }
      if (s0 === "PLAYING" && t0now !== null) {
        if (lastClock !== null && t0now === lastClock) {
          stuckTicks += 1;
          // Two ticks of the SAME stream: advance() and armWatchdog() both
          // clear the pair, so these are two readings of one clip. Without
          // that, three equal reads across a boundary would raise it with
          // the clock advancing normally — "cannot" was too strong, and the
          // guard that makes it true is the reset, not the count.
          // Re-logged, not once. STALLED — the weaker sibling — repeats
          // every 30 s, and onevent() can push a one-shot verdict out of the
          // twelve-line window within a seam while state stays PLAYING.
          if (stuckTicks === 2 || stuckTicks % 15 === 2) {
            clockWarn =
              "*** CLOCK FROZEN at " +
              t0now +
              " ms while state says PLAYING — the\n" +
              "    boundary did not arrive; this run is not advancing ***\n";
            hudAt = 0;
            document.body.className = hudStates[hudAt];
            log(
              "CLOCK FROZEN at " +
                t0now +
                " ms while state says PLAYING — the boundary did not arrive;" +
                " press 1 to restart",
            );
            summary();
          }
        } else {
          stuckTicks = 0;
          if (clockWarn) {
            clockWarn = "";
            log("clock is advancing again");
            summary();
          }
        }
        lastClock = t0now;
      } else {
        lastClock = null;
        stuckTicks = 0;
      }
      if (s0 !== "PLAYING") {
        // Once, then only when the picture changes or every 30 s: a soak
        // would otherwise push the HALTED or GAP line you are looking for
        // out of a twelve-line window.
        if (now !== lastStall || Date.now() - lastStallAt > 30000) {
          log("STALLED " + now);
          lastStall = now;
          lastStallAt = Date.now();
        }
      } else {
        lastStall = "";
      }
    }, 2000);
  }

  function start(which) {
    runId += 1;
    halted = false;
    consecutiveErrors = 0;
    clearInterval(poll);
    clearInterval(endWatch); // else it keeps ticking at 40 ms into the new run
    clearTimeout(cardTimer);
    cardCovers = false;
    cardEl.className = "";
    // Before anything else: the previous run may have a mask up or a frozen
    // frame held in the display buffer, and start() reaches neither of them.
    // A start() that then throws leaves a still picture on a panel that is
    // not playing — which looks perfectly healthy. Abandoned, so the time it
    // spent covering does not reach the mean.
    uncover(true);
    stillBroken = false; // a new run re-tests the method rather than assuming
    list = which === 2 ? CAMPAIGN : UNIFORM;
    gaps = [];
    cleanGaps = [];
    freezeMs = []; // or the covered/frozen mean spans runs AND strategies
    coverMs = [];
    seamKind = "first";
    cov = { at: null, how: "", dirty: false };
    lostGap = 0;
    lostFreeze = 0;
    lostCover = 0;
    idx = 0;
    setEnded(null);
    armText = "";
    placed = [false, false];
    summary();
    armLog("=== " + (which === 2 ? "CAMPAIGN" : "UNIFORM") + " ===");
    armWatchdog();
    try {
      // ONE player. Measured on a QB43C: a second AVPlay instance cannot
      // prepare while the first holds the decoder — p0 reached READY and p1
      // answered PLAYER_ERROR_INVALID_OPERATION, then
      // PLAYER_ERROR_NOT_SUPPORTED_FILE, on a file byte-identical in codec,
      // resolution and frame rate to the one p0 had just prepared. So
      // avplaystore's two-player MixedFrame is not available here, whatever
      // USE_VIDEOMIXER reports. setNextURI is what the panel offers instead,
      // and it keeps the plane alive by never ending the stream.
      if (!players.length) players = [webapis.avplaystore.getPlayer()];
      var p = players[0];
      active = 0;
      try {
        p.stop();
      } catch (e) {
        /* nothing to stop on the first run */
      }
      armLog("  open      = " + p.open(root + list[0].file));
      p.setListener(singleListener());
      armLog("  prepare   = " + p.prepare());
      armLog("  state     = " + state(p));
      if (!placed[0]) {
        placed[0] = true;
        try {
          armLog("  rotation  = " + p.setDisplayRotation(rotation));
        } catch (e) {
          armLog("  rotation  " + why(e));
        }
      }
      rect(p, "post-prepare");
      armLog("  play      = " + p.play());
      armLog("  duration  = " + p.getDuration() + " ms");
      queueNext();
      watchStart({ synced: false, ms: 0, kind: "first" });
      watchEnd();
    } catch (e) {
      armLog("  AVPlay start " + why(e));
      // The player is a SYSTEM resource, not a process one. Install over a
      // running copy and Tizen kills the page without firing unload, so
      // close() never runs and the player stays allocated to a process that
      // no longer exists — nothing in this app can reclaim it, because
      // avplaystore exposes only getPlayer(). The raw name reads like a bug
      // in the probe, so say what it is and what clears it.
      if (String(e && e.name) === "QuotaExceededError") {
        armLog("  the players are held by a DEAD instance (reinstall over a");
        armLog("  running app). Nothing here can reclaim them: press 5 then");
        armLog("  ENTER to reboot the panel, then start the probe again.");
      }
      // open() can throw on a bad root or URI, and this is the one path with
      // no watchStart() behind it — so nothing else would ever take the cover
      // down or count the failure.
      uncover(true);
      bumpError();
    }
  }

  // The point of the whole exercise: the next item is handed to the player
  // while the current one is still on screen, so the pipeline is never torn
  // down and there is no plane to lose.
  function queueNext() {
    var next = list[(idx + 1) % list.length];
    if (next.kind !== "video") return; // nothing to queue ahead of a still
    next = next.file;
    // Two shapes, because the firmware rejected the first with
    // TypeMismatchError and the reference does not say which it wants here.
    try {
      armLog("  setNextURI(uri) = " + players[0].setNextURI(root + next));
    } catch (e) {
      armLog("  setNextURI(uri) " + why(e));
      try {
        armLog(
          "  setNextURI(uri, cb) = " +
            players[0].setNextURI(root + next, function () {
              log("setNextURI callback fired");
            }),
        );
      } catch (e2) {
        armLog("  setNextURI(uri, cb) " + why(e2));
      }
    }
    try {
      if (players[0].getVideoSeamlessInfo) {
        armLog(
          "  seamlessInfo = " +
            JSON.stringify(players[0].getVideoSeamlessInfo()),
        );
      }
    } catch (e) {
      armLog("  seamlessInfo " + why(e));
    }
  }

  // Returns true when the source was swapped without a teardown.
  function changeTo(file) {
    var p = players[0];
    try {
      armLog("changeURL -> " + file);
      var r = p.changeURL(root + file);
      armLog("  changeURL = " + r);
      releaseStill();
      armLog("  state     = " + state(p));
      return true;
    } catch (e) {
      armLog("  changeURL " + why(e));
      return false;
    }
  }

  // The fallback path: stop, open, prepare, play on the same player.
  function reopen() {
    var p = players[0];
    try {
      armLog("reopen -> " + list[idx].file + "   (changeURL did not carry it)");
      armLog("  stop      = " + p.stop());
      armLog("  open      = " + p.open(root + list[idx].file));
      p.setListener(singleListener());
      armLog("  prepare   = " + p.prepare());
      rect(p, "reopen");
      releaseStill(); // after prepare, before play — Samsung's order
      armLog("  play      = " + p.play());
      armLog("  state     = " + state(p));
      watchEnd();
    } catch (e) {
      armLog("  reopen " + why(e));
      bumpError();
    }
  }

  // A still covers the video plane simply by being opaque and in the DOM —
  // AVPlay draws BEHIND the page. That is why a mixed playlist is EASIER
  // than a video-only one: the still IS the cover, so there is nothing to
  // freeze and no poster to match. HTML5 <video> could never do this; it
  // punches a hole in the graphics plane and would sit in front.
  // A photo has to be DECODED before the swap, not merely asked for. Wiping
  // the visible card and only then pointing the layer at a 1080p JPEG left
  // it black for the whole decode — which is why the bench showed black
  // between two stills and none at all between two videos. A video never
  // had the problem: watchStart() already waits for AVPlay's first frame.
  var photos = {};
  function preloadPhotos() {
    var all = UNIFORM.concat(CAMPAIGN);
    for (var i = 0; i < all.length; i++) {
      if (all[i].kind !== "photo") continue;
      var url = root + all[i].file;
      if (photos[url]) continue;
      var img = new Image();
      img.onload = function () {
        photosLoaded += 1;
        log("photos loaded: " + photosLoaded + " of " + photoTotal);
        summary();
      };
      img.onerror = (function (u) {
        return function () {
          log("photo missing: " + u);
          // Same treatment as a missing poster, for the same reason: #card
          // paints it as a CSS background-image, which has NO error event,
          // so a 404 is six seconds of black card that reads as a decode
          // failure on the panel. The log line saying otherwise is gone
          // within a seam, in a panel hidden by default.
          cardsMissing.push(u.replace(/^.*\//, ""));
          cardWarn =
            "*** CARD IMAGE MISSING (" +
            cardsMissing.join(" ") +
            ") — a card that cannot paint\n" +
            "    is BLACK, and EVERY series records it as a clean cover ***\n";
          hudAt = 0;
          document.body.className = hudStates[hudAt];
          summary();
        };
      })(url);
      img.src = url;
      photos[url] = img;
    }
    photoTotal = countKeys(photos);
    log(
      "photos requested: " +
        photoTotal +
        " — loaded is reported as each arrives",
    );
  }

  /**
   * Calls back once `item` can be painted without a gap: at once for a CSS
   * card, and for a photo once its bitmap is ready. decode() is asked on
   * every pass, not just at startup, because the cache may drop the decoded
   * form between loops while keeping the bytes.
   */
  function whenPaintable(item, paint) {
    if (item.kind !== "photo") {
      paint();
      return;
    }
    var img = photos[root + item.file];
    if (!img || typeof img.decode !== "function") {
      paint();
      return;
    }
    var since = nowMs();
    var settled = false;
    var timer = null;
    // then(ok, fail) covers resolve and reject but NOT a promise that never
    // settles. A decode that hangs would leave paint() uncalled, and with it
    // cardTimer unarmed and stop() never reached: the playlist simply dies on
    // a card, with the only trace in a readout that is hidden by default.
    var settle = function (how) {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      var waited = Math.round(nowMs() - since);
      if (waited > 16 || how !== "decoded") {
        log("photo " + how + " after " + waited + " ms");
      }
      paint();
    };
    timer = setTimeout(function () {
      settle("decode TIMED OUT");
    }, PHOTO_DECODE_MS);
    img.decode().then(
      function () {
        settle("decoded");
      },
      function () {
        settle("decode FAILED");
      },
    );
  }

  function showCard(item) {
    var mine = runId;
    whenPaintable(item, function () {
      if (mine !== runId || halted) return;
      // One synchronous block, so the outgoing card is erased and the
      // incoming one painted in the same frame.
      if (item.kind === "photo") {
        cardEl.style.background = "#000";
        cardEl.style.backgroundImage = "url('" + root + item.file + "')";
        cardEl.innerHTML = "";
      } else {
        var card = CARDS[item.id];
        cardEl.style.background = card.bg;
        cardEl.innerHTML = card.html;
      }
      cardEl.className = "on";
      cardCovers = false; // content now, not a cover held over a starting video
      // Both of these would otherwise be read as a seam that is still being
      // measured. endedAt survives until a GAP is logged, and the next one
      // logged is the one after the WHOLE card suite — eighteen seconds in
      // CAMPAIGN, pushed into cleanGaps and straight into the headline mean,
      // in the direction of a catastrophic seam. Zeroed without pushing: a
      // card deliberately on screen is content, not a gap.
      setEnded(null);
      // Stamped before anything is REPORTED. closeSample() writes the log and
      // repaints the capability panel, so measuring after it would fold this
      // probe's own reporting into the number it prints for the paint.
      var painted = nowMs();
      // The cover that carried video -> card has done its work the moment the
      // card is painted, so close it HERE, into whichever series held it.
      // Discarding it left that seam unmeasured under every strategy, and
      // left the stamp free for the next seam to inherit.
      closeSample();
      // The MASK comes down here, the still does not. The card is opaque and
      // sits above it, so the card IS what took over — and #mask carries a
      // 160 ms opacity transition that would otherwise fade the outgoing
      // clip's poster out over the NEXT video, 18 seconds later in CAMPAIGN.
      // A held still has no such tail and is released in reopen(), in
      // Samsung's order.
      maskEl.className = "";
      clearInterval(endWatch);
      clearInterval(poll);
      clearTimeout(cardTimer);
      cardTimer = setTimeout(advance, item.ms);
      // The card has to REACH THE SCREEN before the teardown, for the same
      // reason the mask does: AVPlay draws behind the page, so stopping it
      // while the card is still unpainted uncovers a torn-down video plane,
      // and stop() blocks long enough for that to be seen. Two frames of
      // video playing on behind an opaque card costs nothing; two frames of
      // black costs the whole seam.
      log("  paint   +" + Math.round(painted - seamAt) + " ms");
      afterPaint(function () {
        if (mine !== runId || halted || list[idx] !== item) return;
        // The cover STAYS UP until something live replaces it, which is not
        // here — it is reopen(), between prepare() and play(). Releasing it
        // on this seam handed the plane back to a stream that had already
        // ended, and an ended stream is black. Samsung's order never
        // releases into nothing, and neither did video -> video, which is
        // the only seam that was ever clean.
        log("  stop    +" + Math.round(nowMs() - seamAt) + " ms");
        var t = nowMs();
        try {
          // Stopped rather than left to run: a video behind an opaque card
          // is invisible but still holds the decoder and plays its audio.
          players[0].stop();
        } catch (e) {
          /* nothing to stop */
        }
        log("  stopped in " + Math.round(nowMs() - t) + " ms, cover still up");
      });
    });
  }

  // Starting a video while a still is up needs no cover of its own: the
  // still already covers the plane, so open/prepare/play happen behind it
  // and it comes down only once the new clock has actually moved.
  function startBehindCard() {
    cardCovers = true;
    seamKind = "still>video";
    // The card covers this seam. A freeze may still be held from the seam
    // BEFORE the card suite; it is released in reopen() without being
    // measured again, because it is not what is covering now.
    raiseCover("cover");
    // The seam being measured starts HERE, not where the last stream ended:
    // open + prepare + play until the first picture, with the card holding
    // the plane. Left unset, watchStart() would attribute the whole card
    // suite to this one gap.
    setEnded(nowMs());
    reopen();
    watchStart({ synced: false, ms: 0, kind: "still>video" });
  }

  // One place that moves the playlist on. It used to advance inside the
  // AVPlay listener, which meant the playlist could only move when a video
  // ended — and a still never ends.
  function advance() {
    // The two samples the clock test compares must come from the SAME
    // stream. advance() is the one place the playlist moves on, so clearing
    // here means a position repeated across a boundary — different clips,
    // same offset — can never be read as a frozen clock.
    lastClock = null;
    stuckTicks = 0;
    // A cardTimer that outlived a bumpError() halt would resume playback
    // after the log has already printed "HALTED — not looping", and the
    // recording would show a run the log says stopped.
    if (halted) return;
    clearTimeout(cardTimer);
    clearInterval(poll);
    clearInterval(endWatch);
    var outgoing = list[idx];
    idx = (idx + 1) % list.length;
    var next = list[idx];
    log("item " + (idx + 1) + "/" + list.length + " " + next.kind);
    if (next.kind !== "video") {
      // LEAVING a video is what needs the freeze, whatever comes next. A
      // card is opaque, but it is not opaque until it is PAINTED, and the
      // plane does not hold its last frame on its own: the bench showed
      // black here and none at all on video -> video, which is the same
      // boundary with cover() called. The still comes down in showCard,
      // once the card is actually on screen.
      seamAt = nowMs();
      if (outgoing.kind === "video") {
        seamKind = "video>card";
        var usedHere = cover(outgoing.file);
        log(
          "  cover   " +
            Math.round(nowMs() - seamAt) +
            " ms (" +
            usedHere +
            ")",
        );
      }
      showCard(next);
      return;
    }
    if (outgoing.kind !== "video") {
      startBehindCard();
      return;
    }
    // The strategy that ACTUALLY covered, not covering() asked a second
    // time: a still that threw has already fallen back to the mask, and the
    // mask needs the two frames below that the still must not have.
    seamKind = "video>video";
    var used = cover(outgoing.file);
    // The mask must reach the screen before the blocking teardown, so it
    // waits two frames. Still mode must NOT wait: the freeze is already on
    // the plane, and every millisecond spent here is a millisecond of frozen
    // picture nobody asked for.
    // watchEnd() after BOTH branches: reopen() arms it, a successful
    // changeTo() does not, so on firmware where changeURL works the mask
    // would be raised at onstreamcompleted from the second seam onward —
    // always, per this file's own words, one blink too late.
    if (used === "still") {
      if (!changeTo(list[idx].file)) reopen();
      watchStart({ synced: false, ms: 0, kind: "video>video" });
      watchEnd();
    } else if (used === "mask") {
      // Only the mask needs the two frames: it is a DOM layer that must
      // reach the screen before the blocking teardown. 'none' is the
      // BASELINE the other two are compared against, and paying ~33 ms of
      // rAF inside the measured interval made that baseline too high.
      // Guarded like every other async callback here. Press 1 or 2 inside
      // the ~33 ms rAF window and this would tear the NEW run down to swap
      // in the OLD run's next file — a spontaneous teardown inside a filmed
      // run, indistinguishable on the recording from a real seam.
      var mine = runId;
      afterPaint(function () {
        if (mine !== runId || halted) return;
        if (!changeTo(list[idx].file)) reopen();
        watchStart({ synced: false, ms: 0, kind: "video>video" });
        watchEnd();
      });
    } else {
      if (!changeTo(list[idx].file)) reopen();
      watchStart({ synced: false, ms: 0, kind: "video>video" });
      watchEnd();
    }
  }

  function singleListener() {
    var mine = runId;
    return {
      onbufferingstart: function () {},
      onbufferingprogress: function () {},
      onbufferingcomplete: function () {
        if (mine === runId) log("buffered");
      },
      // With a queued URI the boundary may surface here, through onevent, or
      // not at all. Everything is logged so the panel says which it is.
      onstreamcompleted: function () {
        if (mine !== runId || halted) return;
        setEnded(nowMs());
        consecutiveErrors = 0;
        armText = ""; // cleared once per boundary, so both attempts show
        log("stream completed");
        // Both setNextURI shapes answer TypeMismatchError on this firmware,
        // so the queue cannot carry the boundary, and changeURL is refused
        // too. advance() decides what the seam needs; this only reports that
        // one happened.
        advance();
      },
      onevent: function (type, data) {
        if (mine === runId)
          log("event " + type + (data === undefined ? "" : " " + data));
      },
      onerror: function (type) {
        if (mine !== runId) return;
        log("ERROR " + type);
        bumpError();
      },
    };
  }

  function shutdown(hard) {
    log("shutdown hard=" + hard + " — stopped, press 1 to resume");
    // FIRST: a stopped panel must not keep showing a frozen frame. The poll's
    // own halted branch cannot do it, because clearInterval(poll) below runs
    // before halted is set. visibilitychange can fire mid-seam — a source
    // menu, an overlay — and the panel would then hold the last frame for
    // good, looking perfectly healthy.
    uncover(true);
    dropGap("the run was stopped mid-seam");
    // uncover() only takes down a card that was acting as a COVER. A card
    // showing as content is left up by it, and a still picture over a
    // stopped panel is indistinguishable from a healthy run — the very
    // failure uncover(true) was put at the top of this function to close.
    cardEl.className = "";
    cardCovers = false;
    clearInterval(poll);
    clearInterval(endWatch);
    clearInterval(watchdog);
    clearTimeout(cardTimer);
    halted = true;
    for (var i = 0; i < players.length; i++) {
      try {
        players[i].stop();
      } catch (e) {
        /* already stopped */
      }
      if (hard) {
        try {
          players[i].close();
        } catch (e) {
          /* already closed */
        }
      }
    }
    if (hard) players = [];
  }

  /* ------------------------------------------------- signage control, safe */

  var pending = null;
  var pendingAt = 0;
  function askThenDo(name) {
    pending = name;
    pendingAt = Date.now();
    log("press ENTER within 5s to confirm: " + name);
  }
  // Calls a b2bcontrol method whose argument list is not documented anywhere
  // we can read: the panel refuses `sdb shell` output and refuses to let us
  // pull b2bapis.js, so the panel's own refusals are the only specification
  // available. It told us the first parameter is called `onsuccess` and must
  // be a SuccessCallback ("TypeMismatchError: Invalid ... SuccessCallback
  // type passed for 'onsuccess' parameter"), and Samsung's B2B modules take
  // `(SuccessCallback? onsuccess, ErrorCallback? onerror)` elsewhere. So:
  // try the shapes in order of likelihood and report which one the firmware
  // accepted — the same idiom queueNext() already uses for setNextURI.
  //
  // Stops at the first shape that does not throw. For reboot that is the
  // last line this log will ever print, which is the intended outcome.
  function callB2B(b2b, candidates, label) {
    var found = present(b2b, candidates);
    if (!found.length) {
      log(label + ": none of the probed names exist");
      return;
    }
    var fn = found[0];
    var ok = function (r) {
      // Arrives asynchronously, so it is NOT proof the synchronous call
      // below returned — and for capture it carries the result.
      log(label + " onsuccess: " + describeResult(r));
      // A path on the panel is not a screenshot in the portal. The remaining
      // question is whether this widget may READ what captureScreen wrote,
      // because that is the whole difference between a file on a TV and a
      // picture someone can look at. Answered here rather than assumed.
      if (label === "capture") inspectCapture(r);
    };
    var bad = function (e) {
      log(label + " onerror: " + why(e));
    };
    var shapes = [
      {
        how: "(onsuccess, onerror)",
        run: function () {
          return b2b[fn](ok, bad);
        },
      },
      {
        how: "(onsuccess)",
        run: function () {
          return b2b[fn](ok);
        },
      },
      {
        how: "()",
        run: function () {
          return b2b[fn]();
        },
      },
    ];
    for (var i = 0; i < shapes.length; i++) {
      var r;
      // Stamped OUTSIDE the try, with only the call inside it, because the
      // comment below is an invariant and not a note: an exception from the
      // timing would be caught as a refused shape and invoke the method a
      // SECOND time — two reboots, on the reboot path.
      var calledAt = nowMs();
      try {
        // ONLY the call in the try. A throw from log() or describeResult()
        // would otherwise read as a refused shape and send the loop round to
        // invoke the method a SECOND time — twice, for reboot.
        r = shapes[i].run();
      } catch (e) {
        log(label + " " + fn + shapes[i].how + " " + why(e));
        continue;
      }
      // Timed but NOT charged. Whether captureScreen blocks the thread
      // decides a real question — an unflagged 400 ms here would inflate the
      // cover sample that is open — and the onsuccess/onerror signature only
      // SUGGESTS the encode is off-thread. Charging on a suggestion could
      // void clean seams; printing the number costs nothing and settles it.
      // chargeStall() covers the read and the join, never this call.
      var blocked = Math.round(nowMs() - calledAt);
      // "returned without throwing", not "accepted": a B2B call can return
      // undefined synchronously and refuse through onerror on the next turn
      // of the event loop, so claiming acceptance would state something this
      // log does not yet know. The onerror line, if it comes, lands directly
      // beneath this one.
      log(
        label +
          " " +
          fn +
          shapes[i].how +
          " blocked " +
          blocked +
          " ms, returned without throwing -> " +
          describeResult(r),
      );
      return;
    }
    log(label + ": every shape was refused — see the lines above");
  }

  // A capture may answer with a path, a data URI thousands of characters
  // long, or an object. Printing it raw would push the whole log off a HUD
  // that does not scroll, so say what it IS and show only the head of it.
  function describeResult(r) {
    if (r === undefined) return "undefined";
    if (r === null) return "null";
    var t = typeof r;
    if (t === "string") {
      return r.length > 120
        ? "string[" + r.length + "] " + r.slice(0, 120) + "…"
        : r;
    }
    if (t === "object") {
      try {
        var j = JSON.stringify(r);
        return j.length > 120
          ? "object " + j.slice(0, 120) + "…"
          : "object " + j;
      } catch (e) {
        return "object (not serialisable)";
      }
    }
    return t + " " + r;
  }

  // captureScreen answers with a location. Everything after it — resolve,
  // size, read — is a separate set of permissions and APIs, and each step can
  // fail on its own, so each one reports for itself.
  function inspectCapture(r) {
    var path =
      typeof r === "string" ? r : r && (r.path || r.uri || r.filePath || "");
    if (!path) {
      log("capture: no path in the answer — nothing to chase");
      return;
    }
    if (typeof tizen === "undefined" || !tizen.filesystem) {
      log("capture: tizen.filesystem is missing, the file cannot be read here");
      return;
    }
    try {
      tizen.filesystem.resolve(
        path,
        function (file) {
          log(
            "capture file " + file.fullPath + "  " + file.fileSize + " bytes",
          );
          readHead(file);
        },
        function (e) {
          // The likely refusal, and the one that decides the design: if this
          // widget cannot resolve the path, the upload has to be done by
          // something that can, not by the page.
          log("capture resolve " + why(e));
        },
        "r",
      );
    } catch (e) {
      log("capture resolve threw " + why(e));
    }
  }

  // Base64 specifically, not text: it is what a POST body would carry, so a
  // success here is the last unknown between a capture and a screenshot in
  // the portal. Only the head — a 1080p PNG would bury the HUD.
  function readHead(file) {
    try {
      file.openStream(
        "r",
        function (fs) {
          try {
            log("capture base64 head " + fs.readBase64(48));
          } catch (e) {
            log("capture readBase64 " + why(e));
          }
          try {
            fs.close();
          } catch (e) {
            /* already closed */
          }
          // And, when there is somewhere to send it, the WHOLE picture. A
          // photograph of this panel cannot be measured and a base64 head
          // only proves the file is a JPEG; the screen itself is the
          // evidence, and this is the only way it leaves the panel.
          //
          // A FRESH stream, after this one is closed. The read above consumed
          // 48 bytes, and reusing the stream shipped a file with no JPEG
          // header at all — which arrived looking like a plausible 198 kB
          // picture and was unreadable.
          if (SINK.charAt(0) === "h") shipImage(file);
        },
        function (e) {
          log("capture openStream " + why(e));
        },
      );
    } catch (e) {
      log("capture openStream threw " + why(e));
    }
  }

  // A multiple of 3. Each chunk is base64-encoded on its own, so a size that
  // leaves a remainder ends the chunk with `=` padding and restarts the
  // alignment on the next one — concatenating those is NOT the base64 of the
  // file. 65536 is 3n+1, and it corrupted every chunk boundary.
  var SHIP_CHUNK = 65532;

  // Read to the end in chunks and posted in one body. The cost is readBase64
  // over a few hundred kilobytes plus the serialisation of one ~300 kB
  // string — enough to stall a seam, which is why a capture poisons the
  // sample it lands in (see `dirty`) rather than being quietly averaged in.
  function shipImage(file) {
    try {
      file.openStream("r", shipFromStream(file), function (e) {
        log("capture ship openStream " + why(e));
      });
    } catch (e) {
      // The sibling readHead() guards this and shipImage did not. openStream
      // throws synchronously on SecurityError — the exact privilege this
      // probe exists to survey — and the throw would have landed inside
      // readHead's success callback, losing the "capture ship" prefix on a
      // panel where the HUD is the only readout there is.
      log("capture ship openStream threw " + why(e));
    }
  }

  function shipFromStream(file) {
    return function (fs) {
      var startedAt = nowMs();
      // try/finally, not a charge at the end: EVERY validation exit below
      // happens AFTER the read loop and the join have already blocked the
      // thread. Charging only on the success path billed nothing for the
      // expensive failures — and on this panel those are the likely ones.
      try {
        shipBody(fs, file);
      } finally {
        chargeStall(startedAt);
      }
    };
  }

  function shipBody(fs, file) {
    var parts = [];
    var read = 0;
    var left = 0;
    // What the stream itself says it holds, read before anything consumes
    // it. file.fileSize was captured back at resolve() and may be a snapshot
    // of a file the firmware was still flushing; two independent sources
    // agreeing is a measurement, one cached number is not.
    var available = 0;
    try {
      available = fs.bytesAvailable;
      // Bounded by what the stream OFFERED, plus one. A flat 400 permitted
      // 26 MB of reads and ~70 MB of UTF-16 held live in `parts` before the
      // honest "stopped with N still available" line could print — on the
      // very firmware that line exists for, one whose bytesAvailable does
      // not decrement. Exhausting the widget heap there loses the run and
      // the diagnosis with it, and not hanging is this probe's second rule.
      var maxChunks = Math.ceil(Math.max(available, 0) / SHIP_CHUNK) + 1;
      var guard = 0;
      while (fs.bytesAvailable > 0 && guard < maxChunks) {
        guard += 1;
        var want = Math.min(SHIP_CHUNK, fs.bytesAvailable);
        parts.push(fs.readBase64(want));
        read += want;
      }
      left = fs.bytesAvailable;
    } catch (e) {
      log("capture ship " + why(e));
      return;
    } finally {
      try {
        fs.close();
      } catch (e) {
        /* already closed */
      }
    }
    if (left > 0) {
      // The observation, not the inference. A stream that returns 0 bytes
      // without throwing spins the guard out with `read` full of bytes
      // nobody delivered, and "longer than the chunk guard" would send the
      // reader to raise a limit that is not the problem.
      log(
        "capture ship: stopped with " +
          left +
          " still available after reading " +
          read +
          " of " +
          file.fileSize +
          " bytes — not sent",
      );
      return;
    }
    if (read === 0) {
      log("capture ship: nothing was read — not sent");
      return;
    }
    // The stream can end short of the file — a capture the firmware is still
    // flushing reports bytesAvailable 0 — and the base64 identity below
    // would still PASS, because every chunk came back whole. Whole chunks of
    // a truncated file is exactly the plausible-looking ruin this is here to
    // stop shipping. Both sources must agree, so a stale fileSize cannot
    // vouch for a short read and a short read cannot vouch for itself.
    if (read !== available || read !== file.fileSize) {
      log(
        "capture ship: read " +
          read +
          ", stream offered " +
          available +
          ", file is " +
          file.fileSize +
          " bytes — not sent",
      );
      return;
    }
    var body;
    var expect;
    try {
      body = parts.join("");
      expect = 4 * Math.ceil(read / 3);
    } catch (e) {
      log("capture ship join " + why(e));
      return;
    }
    // Padding before arithmetic, because the arithmetic cannot see this.
    // A chunk short by 1 or 2 bytes emits `=` and still occupies 4*ceil(n/3)
    // characters — 65531 and 65530 both encode to 87376, exactly like a
    // whole 65532 — so the length check below is blind to precisely the
    // short read that produces a mid-stream `=`. base64 -d stops there, and
    // the sink would receive a half-decodable JPEG.
    for (var i = 0; i < parts.length - 1; i++) {
      if (typeof parts[i] !== "string") {
        log(
          "capture ship: chunk " +
            (i + 1) +
            " of " +
            parts.length +
            " came back as " +
            typeof parts[i] +
            " — not sent",
        );
        return;
      }
      if (parts[i].indexOf("=") !== -1) {
        log(
          "capture ship: chunk " +
            (i + 1) +
            " of " +
            parts.length +
            " came back short (it carries base64 padding) — not sent",
        );
        return;
      }
    }
    // The LAST chunk legitimately carries padding, so it is skipped above —
    // and the length check is blind there for the same reason it was blind
    // mid-stream. Half of all short last chunks slipped through both: the
    // file's own 273068-byte case ends on want=10940, and 10939 and 10940
    // encode to the same 14588 characters with no mid-stream `=` anywhere.
    //
    // But the padding is fully determined by `read`, so this is exact rather
    // than another heuristic. SHIP_CHUNK is 3n, so read % 3 is the last
    // chunk's own remainder.
    var pad = (3 - (read % 3)) % 3;
    var last = parts[parts.length - 1];
    // This firmware already violates three specs the probe had to measure
    // around, so a readBase64 that returns a non-string is not a hypothetical
    // worth a TypeError escaping into a platform callback — on a panel whose
    // HUD is the only readout, that leaves the capture simply unexplained.
    if (typeof last !== "string") {
      log(
        "capture ship: chunk " +
          parts.length +
          " of " +
          parts.length +
          " (the last) came back as " +
          typeof last +
          " — not sent",
      );
      return;
    }
    var padAt = last.indexOf("=");
    if (pad === 0 ? padAt !== -1 : padAt !== last.length - pad) {
      log(
        "capture ship: the last chunk carries " +
          (padAt === -1 ? "no" : String(last.length - padAt)) +
          " padding chars, expected " +
          pad +
          " for " +
          read +
          " bytes — not sent",
      );
      return;
    }
    // `read` is what was ASKED for, not what came back: readBase64 returns no
    // count and the spec promises no exact length. Base64 of N bytes is
    // exactly 4*ceil(N/3) characters and every chunk but the last is a
    // multiple of 3, so this catches a wrong chunk size and a gross short
    // read. The padding scan above catches what it cannot see.
    if (body.length !== expect) {
      log(
        "capture ship: base64 is " +
          body.length +
          " chars, expected " +
          expect +
          " for " +
          read +
          " bytes — not sent",
      );
      return;
    }
    var x = new XMLHttpRequest();
    try {
      x.open("POST", SINK, true);
      // Without this ontimeout is dead code and the XHR default is "wait
      // forever": a sink that accepts the connection and never answers would
      // leave the posted line as the last word, which is the inference these
      // handlers were added to remove.
      x.timeout = 15000;
      x.setRequestHeader("Content-Type", "application/octet-stream");
      // Delivery is NOT known yet. send() returning says the request left,
      // nothing more: a refused connection, a dead sink or a 500 all land in
      // onload/onerror after this function has returned. Announcing arrival
      // here would be the same fault as printing file.fileSize — a number
      // that reads as measured and is an intent.
      x.onload = function () {
        log("capture sink HTTP " + x.status + " — " + read + " bytes");
      };
      x.onerror = function () {
        log("capture sink: the POST failed — the image did NOT arrive");
      };
      x.ontimeout = function () {
        log("capture sink: the POST timed out — delivery unknown");
      };
      x.send("IMG " + (file.name || "screen") + "\n" + body);
    } catch (e) {
      log("capture ship POST " + why(e));
      return;
    }
    // One number: the guard above makes read === file.fileSize a
    // precondition, so printing both read as a comparison that could fail.
    log("capture posted " + read + " bytes");
  }

  function confirmNow() {
    var age = Date.now() - pendingAt;
    if (!pending) return;
    if (age < 400 || age > 5000) {
      log("confirmation ignored (" + age + " ms) — press the key again");
      pending = null;
      return;
    }
    var name = pending;
    pending = null;
    var b2b = b2bControl();
    if (!b2b) {
      log(name + ": no b2bcontrol object — see the capability panel");
      return;
    }
    try {
      if (name === "capture") {
        callB2B(b2b, ["captureScreen", "getCaptureScreen"], "capture");
      } else if (name === "reboot") {
        callB2B(b2b, ["rebootDevice", "reboot"], "reboot");
      } else {
        // Falling through to reboot would make an unrecognised name restart
        // the panel. Bench code gets edited on the bench, under time
        // pressure, by someone holding a remote.
        log("unknown pending action: " + name);
      }
    } catch (e) {
      log(name + " " + why(e));
    }
  }

  function keys() {
    // Samsung delivers remote keys only to applications that ask for them.
    // Production gets away with a naked keydown because it never uses the
    // number keys; this probe is driven by them, and without registration
    // nothing arrived at all. Samsung's own sample registers them for the
    // same reason.
    try {
      var supported = tizen.tvinputdevice.getSupportedKeys();
      var want = [
        "0",
        "1",
        "2",
        "3",
        "4",
        "5",
        "6",
        "7",
        "8",
        "9",
        "Enter",
        "Return",
      ];
      var got = [];
      for (var i = 0; i < want.length; i++) {
        try {
          tizen.tvinputdevice.registerKey(want[i]);
          got.push(want[i]);
        } catch (e) {
          /* a key this panel does not offer is not an error worth stopping for */
        }
      }
      armLog(
        "registered keys: " +
          got.join(" ") +
          "   (panel offers " +
          supported.length +
          ")",
      );
    } catch (e) {
      armLog("registerKey " + why(e));
    }
    document.addEventListener("keydown", function (e) {
      // Every key, always, in the panel that does not scroll: if a button
      // does nothing this says whether the event even arrived.
      armLog("key " + e.keyCode + (e.repeat ? " (repeat)" : ""));
      if (e.repeat) return; // a held key must never confirm anything
      var k = e.keyCode;
      // Any key but ENTER cancels a pending confirmation. Otherwise a 5
      // pressed by mistake stays armed for five seconds, and an ENTER
      // pressed for any other reason inside that window reboots the panel —
      // the one irreversible action this file has.
      // 13 is the ONLY key confirmNow() answers to, so everything else
      // cancels — including BACK, which otherwise left a reboot armed while
      // the operator was only cycling the readout.
      if (pending && k !== 13) {
        log("pending " + pending + " cancelled by key " + k);
        pending = null;
      }
      if (k === 49) start(1);
      else if (k === 50) start(2);
      else if (k === 51) describe();
      else if (k === 52) askThenDo("capture");
      else if (k === 53) askThenDo("reboot");
      else if (k === 10009 || k === 8 || k === 27) {
        // posterWarn only voids the MASK strategy — a freeze lives in the
        // display buffer and touches no PNG — so pinning the readout open
        // under `still` would take away the fullscreen state that judging a
        // seam needs, for a fault that does not apply to it. Re-evaluated on
        // every press, because the strategy changes under key 0.
        //
        // cardWarn is NOT gated: a card that cannot paint is black under
        // every strategy.
        if (geomWarn || cardWarn || (posterWarn && covering() === "mask")) {
          // The readout is pinned open while the geometry verdict stands.
          // Both smaller states hide #caps, and the log line that says the
          // same thing scrolled away within a couple of seams — so one press
          // of the key the help line calls "fullscreen" would remove the only
          // notice that every number on screen is meaningless. There is
          // nothing worth filming in this state anyway.
          log(
            "readout locked: " +
              (geomWarn
                ? "the mask is not fullscreen, numbers are void"
                : cardWarn
                  ? "a card image is missing, every series is void"
                  : "a poster is missing, cover numbers are void"),
          );
          return;
        }
        hudAt = (hudAt + 1) % hudStates.length;
        document.body.className = hudStates[hudAt];
        try {
          localStorage.setItem("hud2", String(hudAt));
        } catch (e) {
          /* not worth failing a run over */
        }
        log("readout: " + (hudStates[hudAt] || "full"));
      } else if (k === 48) {
        uncover(true); // nothing took over: this cover measured nothing
        coverAt = (coverAt + 1) % COVERS.length;
        // Entering `mask` with a poster missing fills the one series this
        // panel left empty, with #mask's own #000 painted through a 404 —
        // a black screen recorded as a clean cover. The banner was raised at
        // boot, but the readout is unlocked under `still` (correctly, the
        // fault does not apply there), so by here it can be off-screen with
        // nothing to say why. Re-announce it, as img.onerror does.
        // covering(), not COVERS[coverAt]: on a panel without still mode
        // `still` DEGRADES to the mask, so gating on what was asked for
        // misses exactly the run that then paints #000 through the 404.
        // That case is handled by hasStill() alone — stillBroken is provably
        // false here, since every key-0 press resets it below and the only
        // place that sets it is reachable only while the effective want is
        // already `still`. The runtime degradation announces itself in
        // cover()'s catch instead.
        if (posterWarn && covering() === "mask") {
          hudAt = 0;
          document.body.className = hudStates[hudAt];
          log(
            "cover: mask — but a poster is missing, so cover numbers are void",
          );
        }
        // A mean that spans two strategies describes neither. The screen
        // calls this "the same transition, all three ways", so the series has
        // to start over with the strategy — otherwise three still seams at
        // 600 ms and three mask seams at a different cost are reported as
        // their average, which describes neither. (The 130/700 this comment
        // used to quote predate the measurement; see the freezeMs note.)
        gaps = [];
        cleanGaps = [];
        freezeMs = [];
        coverMs = [];
        seamKind = "?"; // start() resets it; these two sites must agree
        cov = { at: null, how: "", dirty: false };
        lostGap = 0;
        lostFreeze = 0;
        lostCover = 0;
        // The running stream was started under the OLD strategy, so the state
        // that measures its end belongs to that strategy too. Left behind,
        // the poll could push a gap measured ACROSS the switch as sample 1 of
        // the new series — and the series was just emptied, so that one bad
        // sample would BE the mean.
        setEnded(null);
        clearInterval(poll);
        // A new measurement of the method, not an inherited verdict on it.
        stillBroken = false;
        // Re-arm the end watch for the CURRENT stream. Under 'still' it was
        // never armed (watchEnd early-returns unless the strategy is mask),
        // so switching still->mask mid-clip would have raised the mask at
        // onstreamcompleted — always, in this file's own words, one blink too
        // late. watchEnd() is self-guarding: a no-op for still and none, and
        // it refuses to act on a clock still reading the previous stream.
        clearInterval(endWatch);
        watchEnd();
        var now = covering();
        log(
          "cover: " +
            now +
            (now !== COVERS[coverAt]
              ? " — " + COVERS[coverAt] + " NOT available here"
              : "") +
            "   (same transition, all three ways, counters reset)",
        );
        summary();
      } else if (k === 13)
        confirmNow(); // ENTER, deliberately not the same key
      else if (k >= 54 && k <= 57) {
        // 6/7/8/9 -> 0/90/180/270. Which one a portrait panel wants is not
        // knowable in advance; Samsung's sample binds keys for the same
        // reason. Takes effect on the next start().
        rotation = "PLAYER_DISPLAY_ROTATION_" + [0, 90, 180, 270][k - 54];
        log("rotation set to " + rotation + " — press 1 or 2 to apply");
        summary();
      }
    });
  }

  /* ------------------------------------------------------------ bootstrap */

  function begin() {
    root = mediaRoot();
    describe();
    // Falsifies the whole cover experiment in one line. Both layers are
    // `position: fixed` with four offsets; if this firmware dropped them the
    // layer is shrink-to-fit and covers nothing, and every "cover" number
    // this probe prints would be measuring a layer that was never there.
    // Cheaper to assert than to discover from a recording.
    try {
      var mr = maskEl.getBoundingClientRect();
      // innerWidth/innerHeight are rounded integers while the rect may be
      // fractional, so an exact >= can fail on a viewport of 1079.5 and print
      // a verdict that contradicts its own rounded numbers. One pixel of
      // slack: a dropped offset leaves the layer shrink-to-fit, not short by
      // a pixel. The quantity is right — setDisplayRect() uses exactly these.
      var ok =
        mr.width >= window.innerWidth - 1 &&
        mr.height >= window.innerHeight - 1;
      log(
        "mask " +
          Math.round(mr.width) +
          "x" +
          Math.round(mr.height) +
          " vs screen " +
          window.innerWidth +
          "x" +
          window.innerHeight +
          (ok ? "  OK" : "  *** NOT FULLSCREEN: cover numbers are void ***"),
      );
      // Also into the capability panel. log() is a twelve-line window that
      // the first couple of seams wipe, and the default readout hides it
      // entirely — so the one line that can invalidate every cover number
      // would be gone before anyone looked.
      if (!ok) {
        geomWarn =
          "*** mask is " +
          Math.round(mr.width) +
          "x" +
          Math.round(mr.height) +
          ", not fullscreen: every cover number below is void ***\n";
        // And force the readout open. The default state hides #caps outright,
        // so the one line that invalidates the whole experiment would have
        // been written where nobody was looking.
        hudAt = 0;
        document.body.className = hudStates[hudAt];
        summary();
      }
    } catch (e) {
      log("mask geometry " + why(e));
    }
    preloadPosters();
    preloadPhotos();
    start(1);
  }

  window.onload = function () {
    document.body.className = hudStates[hudAt];
    keys(); // registered FIRST: a probe that cannot be driven is useless
    // Every exit the platform actually gives us, and all of them hard. The
    // player is a system resource: hold it past our own death and the NEXT
    // instance gets QuotaExceededError and plays nothing. `unload` alone was
    // not enough — a reinstall over a running app killed the page without it.
    // `pagehide` fires in cases `unload` does not, and shutdown(true) is
    // idempotent: both firing just closes an already-closed player.
    window.addEventListener("unload", function () {
      shutdown(true);
    });
    window.addEventListener("pagehide", function () {
      shutdown(true);
    });
    document.addEventListener("visibilitychange", function () {
      // hard=true, deliberately. Being hidden is the common road to being
      // killed on this panel, and a player held across it is a player the
      // next run cannot have. start() calls getPlayer() again when
      // players is empty, so resuming costs one allocation and nothing else.
      if (document.hidden) shutdown(true);
      // Not resumed automatically: restarting in the middle of a filmed run
      // would corrupt the measurement more quietly than a stopped probe does.
      else log("visible again — press 1 to resume");
    });
    log(
      "RETURN fullscreen  0 cover still/mask/none  1 video-only  2 campaign  3 caps  6-9 rotate",
    );
    log("4 capture  5 reboot  ENTER confirm");
    // webapis may not be ready at load. Samsung's sample waits before it
    // initialises; concluding "MISSING" on the first tick would turn a
    // transient ordering into a permanent, wrong answer.
    var tries = 0;
    (function wait() {
      tries += 1;
      if (typeof webapis !== "undefined" && webapis.avplaystore) {
        log("webapis ready after " + tries + " tries");
        begin();
        return;
      }
      if (tries > 50) {
        log(
          "webapis still missing after " +
            tries +
            " tries — AVPlay cannot be tested",
        );
        describe();
        return;
      }
      setTimeout(wait, 200);
    })();
  };
})();
