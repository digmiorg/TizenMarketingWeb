'use strict';

/**
 * Seamless video playback on Samsung signage panels, through AVPlay.
 *
 * WHY THIS EXISTS
 * ---------------
 * An HTML5 `<video>` element tears its plane down between clips, and the
 * panel shows black for the length of the teardown. On a screen whose whole
 * job is to play a loop of adverts, that black frame is the product defect.
 *
 * The rules below are not design opinions. They were measured on a QB43C on
 * the bench with `lab/avplay-probe` (2026-11-05/06, 482 video->video seams in
 * one unbroken run), and three of them cost a wrong fix each before the
 * measurement found them.
 *
 * THE FIVE RULES
 * --------------
 * 1. ONE player. `webapis.avplaystore.getPlayer()` hands out a system
 *    resource, and this panel refuses to prepare a second instance while the
 *    first holds the decoder. MixedFrame is therefore unavailable here,
 *    whatever USE_VIDEOMIXER reports.
 *
 * 2. AVPlay draws BEHIND the web page. HTML5 `<video>` does the opposite --
 *    it punches a hole in the graphics plane and sits in front. So anything
 *    opaque in the DOM over the video HIDES it (the page's own background
 *    colour included), and conversely an opaque DOM layer is a free, perfect
 *    cover for a teardown. A mixed playlist is therefore EASIER than a
 *    video-only one, the opposite of the usual signage advice -- that advice
 *    assumes HTML5 compositing.
 *
 * 3. Leaving a video needs the frame frozen -- `setVideoStillMode("true")` --
 *    unless something opaque is already covering the plane.
 *
 * 4. The freeze must never be released until something live has replaced it.
 *    Releasing it at the seam hands the plane back to a stream that has
 *    already ended. Samsung's order puts the release between `prepare()` and
 *    `play()`, and that is where it goes -- never on a timer.
 *
 *    What an ended stream shows is NOT settled. This file was written saying
 *    "an ended stream is black", which is what the bench appeared to show.
 *    Samsung's guide says the opposite: "Failure to stop playback after the
 *    media has finished playing causes the media player window to show the
 *    final frame continuously." Nobody has measured which happens here, and
 *    the difference matters -- if the guide is right, the freeze on a stood
 *    down loop is belt and braces; if the bench is right, it is the only
 *    thing between a viewer and a black screen. It is kept either way.
 *
 * 5. `setVideoStillMode` takes a DOMString, not a boolean. A boolean raises
 *    TypeMismatchError, and from JavaScript a wrong argument type looks
 *    IDENTICAL to the method being absent. Never conclude a native binding is
 *    missing from a throw.
 *
 * WHAT THIS PANEL REFUSES
 * -----------------------
 * `changeURL` and both shapes of `setNextURI` answer TypeMismatchError on
 * this firmware, so the queue cannot carry a boundary. stop -> open ->
 * prepare -> play on the one player IS the path, and the freeze hides it.
 *
 * WHAT IS MEASURED, AND WHAT IS NOT
 * ---------------------------------
 * The call order and the freeze are measured. The display rect is measured in
 * exactly ONE form: `setDisplayRect(0, 0, window.innerWidth,
 * window.innerHeight)`, which is what the probe called on every seam of that
 * run, from the same 1080x1920 `config.xml` this app declares.
 *
 * And measured ONLY WITH THE PANEL DISPLAYING LANDSCAPE. The probe's own
 * readout said `screen 1920x1080`; the 482 seams never saw a rotated web
 * layer. On the bench with the panel set to portrait (2026-11-10) every
 * portrait clip came out sideways: the page is rotated by the panel, the
 * plane behind it is not. `setDisplayRotation` (Samsung, since 4.0) turns the
 * plane, and it has to come BEFORE the rect because it moves the coordinate
 * origin. The angle is taken from the web layer (`screen.orientation.angle`).
 * MEASURED 2026-11-10 on the bench QB43C set to portrait: with no override,
 * twelve portrait clips (606x1080 .. 1080x1920) came out upright, so on
 * this panel AVPlay counts the same way round as the web layer and the
 * derived value is the right one. The remote keys 5-9 (HUD open) remain for
 * a panel that reports angle 0 or counts the other way; neither has been
 * seen. The rect space after a turn was not cropped on that run. Samsung
 * also lists a B2B-only `setStreamingProperty('PORTRAIT_MODE', ...)` (since
 * 3.0) -- untried, unneeded so far.
 *
 * Samsung's guide says the parameters are interpreted in a space that "is
 * always treated as 1920x1080 px, regardless of the application resolution".
 * In landscape the probe's viewport WAS 1920x1080, so the measured form and
 * the document agree there, and the question never arose. In portrait the
 * viewport is 1080x1920 and the document says the rotation moves the
 * coordinate origin -- whether that space also swaps its axes is not stated
 * and not yet measured. The HUD shows the rect sent, so the bench can tell:
 * a clip cropped to 1080x1080 after a turn means the axes did not swap and
 * the rect must be 1920x1080 regardless. Only the full-screen form is used.
 * An earlier draft computed a letterboxed rect
 * and laid the blurred backdrop in the margins around it; that was removed,
 * because no non-full-screen rect has ever been measured here and, if the
 * document is right about the coordinate space, such a rect lands partly off
 * the screen.
 *
 * Aspect is left to `setDisplayMethod(PLAYER_DISPLAY_MODE_LETTER_BOX)`, which
 * matches the `object-fit: contain` the `<video>` path used. Its margins are
 * AVPlay's own black rather than the page's blurred backdrop -- a visible
 * change from the `<video>` path, and a deliberate one.
 *
 * This module holds no timers and no playlist. It plays one URL, reports when
 * that stream ends, and leaves sequencing to the caller.
 */
(function (root) {
  /**
   * What a seam needs, given what is leaving and what is arriving.
   *
   * `freeze` is rule 3: the plane is about to be torn down with nothing
   * opaque over it. `coverMustBePainted` says the arriving item is itself the
   * cover, so the caller must not touch the plane until that item is decoded
   * AND painted -- an image that has merely been asked for is transparent,
   * and the plane shows through for the whole decode.
   *
   * Leaving an image needs neither: there is no stream to tear down.
   *
   * @param {('video'|'image'|'none')} from
   * @param {('video'|'image'|'none')} to
   * @returns {{freeze: boolean, coverMustBePainted: boolean}}
   */
  function seamPlan(from, to) {
    const leavingVideo = from === 'video';
    const arrivingImage = to === 'image';
    return {
      // Leaving a video always needs the freeze EXCEPT when an opaque image
      // is arriving to cover the plane itself. A decoded, painted image is a
      // complete cover, and freezing as well would hold a frame nobody can
      // see while risking a stuck freeze on the error paths.
      freeze: leavingVideo && !arrivingImage,
      coverMustBePainted: arrivingImage && leavingVideo,
    };
  }

  /**
   * Is AVPlay usable in this runtime?
   *
   * Checked by NAME rather than by calling anything: rule 5 says a throw
   * cannot distinguish a missing binding from a bad argument, so a probe that
   * calls is a probe that lies. In a browser this is simply false and the
   * caller keeps its `<video>` path.
   *
   * The `<object type="application/avplayer">` element is NOT checked here --
   * see `createPlayer`, which refuses to start without it.
   *
   * @param {object} [scope] - defaults to the global; injectable for tests
   * @returns {boolean}
   */
  function isAvailable(scope) {
    const where = scope || root;
    return !!(
      where &&
      where.webapis &&
      where.webapis.avplaystore &&
      typeof where.webapis.avplaystore.getPlayer === 'function'
    );
  }

  /**
   * A player bound to one AVPlay instance.
   *
   * Every native call is wrapped: a signage screen that throws its way to a
   * black rectangle is worse than one that logs and carries on with the next
   * item. `lastError` carries the most recent failure so the caller can
   * decide to fall back to `<video>` for the rest of the session.
   *
   * @param {object} options
   * @param {object} [options.scope] - where to find `webapis`/`tizen`; tests
   * @param {object} [options.doc] - where to look for the avplayer element
   * @param {function(string): void} [options.log]
   * @param {function(): void} [options.onStreamCompleted]
   * @param {function(string): void} [options.onError]
   */
  function createPlayer(options) {
    const opts = options || {};
    const scope = opts.scope || root;
    const doc = opts.doc || (root && root.document);
    // Rotation of the video plane. The web layer follows the panel's
    // orientation setting; AVPlay draws behind the page and does NOT, so on a
    // portrait-mounted panel a clip comes out sideways unless the plane is
    // turned to match. Seen on the bench 2026-11-10: every portrait clip
    // landscape. The probe never hit this -- it only ever ran on a panel
    // displaying landscape (its own readout: `screen 1920x1080`), where NONE
    // happens to be right, and the value it sent by default
    // (`PLAYER_DISPLAY_ROTATION_0`) is not even one Samsung accepts.
    //
    // Derived from the web layer's own angle (`screen.orientation.angle`),
    // because that is the rotation the panel applied to the page. Whether
    // AVPlay counts the same way round is NOT measured: Samsung's own sample
    // binds remote keys for exactly that reason, so `opts.rotation` may
    // return an override ('NONE' | '90' | '180' | '270') and wins when it does.
    const rotationOverride = typeof opts.rotation === 'function' ? opts.rotation : () => null;
    const onRotation = typeof opts.onRotation === 'function' ? opts.onRotation : () => {};
    const ROTATIONS = ['NONE', '90', '180', '270'];
    // What a portrait viewport gets when the web layer reports angle 0 -- a
    // panel that rotates in its compositor can do exactly that. Set from the
    // bench with the remote keys, not derived: which way round AVPlay counts
    // is not knowable from the page. null until measured, and null means
    // "not turned, say so on the HUD".
    const PORTRAIT_FALLBACK = null;

    /**
     * @param {{width: number, height: number}} viewport
     * @return {{value: string, source: string}}
     */
    function resolveRotation(viewport) {
      const forced = rotationOverride();
      if (forced && ROTATIONS.indexOf(String(forced)) > -1) {
        return { value: String(forced), source: 'override' };
      }
      const scr = opts.screen || (scope && scope.screen);
      const orientation = scr && scr.orientation;
      const angle = orientation && typeof orientation.angle === 'number' ? orientation.angle : 0;
      const byAngle = { 90: '90', 180: '180', 270: '270' };
      if (byAngle[angle]) {
        return { value: byAngle[angle], source: 'screen' };
      }
      const portrait = !!viewport && viewport.height > viewport.width;
      if (portrait) {
        return PORTRAIT_FALLBACK
          ? { value: PORTRAIT_FALLBACK, source: 'viewport' }
          : { value: 'NONE', source: 'unmeasured' };
      }
      return { value: 'NONE', source: 'landscape' };
    }
    const log = opts.log || function () {};
    const api = {};

    let player = null;
    let stillHeld = false;
    let generation = 0;
    let lastError = null;
    let preparedDurationMs = null;
    // The TV's mute state as we found it, so playback can be silent without
    // permanently changing a setting that belongs to the panel.
    let mutedByUs = false;
    let muteWasOn = null;

    /** Why an exception happened, in one line, without assuming its shape. */
    function why(error) {
      if (!error) {
        return 'threw a falsy value';
      }
      const name = error.name ? String(error.name) : 'Error';
      const message = error.message ? String(error.message) : String(error);
      return name + ': ' + message;
    }

    /**
     * Run a native call, swallow and record a throw.
     *
     * @returns {{ok: boolean, value: *}}
     */
    function attempt(label, fn) {
      try {
        return { ok: true, value: fn() };
      } catch (error) {
        lastError = label + ' ' + why(error);
        log(lastError);
        return { ok: false, value: undefined };
      }
    }

    /**
     * The `<object type="application/avplayer">` the video plane is bound to.
     *
     * Samsung's first step in Playing Media is to create this element, and
     * the note under `setDisplayRect` says its `style` must be changed
     * alongside the rect -- the plane is composited against it.
     *
     * Without it, `open`/`prepare`/`play` can all answer OK and nothing is
     * drawn: every clip is a black screen, `lastError` stays null, and the
     * caller never falls back. On a panel where `dlogutil` yields no lines
     * that is invisible, so it is checked before anything else rather than
     * discovered in a salon.
     */
    function surface() {
      if (!doc || typeof doc.querySelector !== 'function') {
        return null;
      }
      return doc.querySelector('object[type="application/avplayer"]');
    }

    function acquire() {
      if (player) {
        return player;
      }
      if (!surface()) {
        lastError = 'no <object type="application/avplayer"> in the document';
        log(lastError);
        return null;
      }
      const got = attempt('getPlayer', () => scope.webapis.avplaystore.getPlayer());
      if (!got.ok || !got.value) {
        // The player is a SYSTEM resource, not a per-process one. Installing
        // over a running copy, or reloading the page without close(), kills
        // the page without releasing it, so the instance stays allocated to a
        // process that no longer exists. avplaystore offers only getPlayer(),
        // so nothing in this app can reclaim it -- the panel has to be
        // restarted. The raw name reads like a bug in this file, so say what
        // it actually is.
        if (lastError && lastError.indexOf('QuotaExceededError') > -1) {
          log('AVPlay is held by a dead instance (installed over a running app, ' +
              'or reloaded without close()). The panel has to be restarted.');
        }
        return null;
      }
      player = got.value;
      return player;
    }

    /**
     * Silence the panel for playback, remembering what it was.
     *
     * The `<video>` path set `muted` on the element, which is scoped to that
     * element. AVPlay has no equivalent: it offers `setSelectTrack` for
     * choosing BETWEEN audio tracks, not for choosing none. The nearest thing
     * is `tizen.tvaudiocontrol.setMute`, which is the TV's own mute.
     *
     * So the previous state is saved with `isMute()` and put back by
     * `restoreAudio()`. A signage panel left muted after the app exits would
     * be a setting this app had no business changing for good.
     *
     * Whether that state survives the app exiting is NOT documented by
     * Samsung and NOT measured here; restoring explicitly is what makes the
     * question moot. The privilege `http://tizen.org/privilege/tv.audio` is
     * declared in config.xml -- without it this throws SecurityError, which
     * is swallowed, and playback is merely audible rather than broken.
     */
    function muteAudio() {
      if (mutedByUs || !scope.tizen || !scope.tizen.tvaudiocontrol) {
        return;
      }
      const audio = scope.tizen.tvaudiocontrol;
      // The `mutedByUs` guard above is what keeps this read honest, and it is
      // the ONLY thing that does -- deliberately, because a second guard here
      // would make each of them untestable through the other. Once we have
      // muted the panel ourselves isMute() answers `true`, so reading it a
      // second time would record OUR mute as "how we found it" and
      // restoreAudio() would then refuse to undo it: a customer's TV silent
      // on every input until somebody finds the remote. The test
      // "muting twice does not record our own mute as the old state" fails if
      // that guard is removed.
      // A read that threw leaves this `null`: unknown. restoreAudio() treats
      // unknown the same as "it was off" and unmutes anyway, because we did
      // mute and leaving a panel silent for good is the harm this file
      // commits to avoiding.
      const was = attempt('isMute', () => audio.isMute());
      const found = was.ok ? !!was.value : null;
      const set = attempt('setMute(true)', () => audio.setMute(true));
      if (set.ok) {
        mutedByUs = true;
        muteWasOn = found;
      }
    }

    /**
     * Put the panel's mute back the way it was, if we changed it.
     *
     * Three cases, and the middle one is a judgement call:
     *
     *   it was OFF -> unmute. Undo our own change.
     *   UNKNOWN    -> unmute. isMute() threw, so we cannot know -- but we DID
     *                 mute, and leaving a panel silent for good is the harm
     *                 this file commits to avoiding. Undoing our own change
     *                 is the smaller risk.
     *   it was ON  -> leave it. Somebody muted it on purpose.
     *
     * ⚠️ One case this cannot reach. If `setMute(false)` throws on the LAST
     * close() before the page reloads, the panel stays muted and the next
     * page reads `isMute() === true` -- our own mute -- records it as the
     * setting it found, and never undoes it. A customer's TV silent on every
     * input until somebody finds the remote.
     *
     * Nothing inside this module can know better, but that is not the same
     * as unfixable: the app already uses localStorage (myUUID,
     * MediaStorage), so a flag written when a mute is taken and cleared only
     * when an unmute is CONFIRMED would let the next page read a bare
     * `isMute() === true` as probably its own. Not done here; it is a door,
     * not a wall.
     */
    function restoreAudio() {
      if (!mutedByUs) {
        return;
      }
      const audio = scope.tizen && scope.tizen.tvaudiocontrol;
      if (!audio || muteWasOn === true) {
        // Nothing to undo, or it was muted before we arrived. Done either way.
        mutedByUs = false;
        muteWasOn = null;
        return;
      }
      // The flag is cleared only by a call that did NOT throw -- the same
      // rule as release(), and for the same reason. Cleared first, a thrown
      // setMute would leave the panel muted with this file believing it had
      // handed the audio back; nothing would retry, and the NEXT session
      // would read isMute() as `true`, record OUR mute as "how we found it",
      // and refuse to unmute for ever. One swallowed throw, and the
      // customer's TV is silent on every input until somebody finds the
      // remote.
      const res = attempt('setMute(false)', () => audio.setMute(false));
      if (res.ok) {
        mutedByUs = false;
        muteWasOn = null;
      }
    }

    /**
     * Freeze the frame currently on the plane. Rule 3.
     *
     * `stillHeld` is set from the call's own result before anything else can
     * throw: if it were set afterwards and the logging threw, the freeze
     * would be genuinely held with the flag false, and every release path
     * would early-return -- leaving a frozen picture on the panel for the
     * rest of the session. That looks perfectly healthy and plays nothing,
     * which is worse than a visible fault.
     *
     * @returns {boolean} whether the plane is now frozen
     */
    function freeze() {
      const p = acquire();
      if (!p || stillHeld) {
        return stillHeld;
      }
      // Rule 5: the argument is a DOMString.
      const res = attempt('setVideoStillMode("true")', () => p.setVideoStillMode('true'));
      if (res.ok) {
        stillHeld = true;
      }
      return stillHeld;
    }

    /**
     * Release the freeze. Rule 4: only ever called with something live ready
     * to take the plane -- in practice between prepare() and play(), or on a
     * teardown where the plane is being given up anyway.
     *
     * The flag is cleared only on a call that did NOT throw. Clearing it
     * first is the mirror of the hazard freeze() guards against: the panel
     * would still be frozen while this file believed otherwise, and nothing
     * would ever try again.
     */
    function release() {
      if (!stillHeld) {
        return;
      }
      const p = player;
      if (!p) {
        stillHeld = false;
        return;
      }
      const res = attempt('setVideoStillMode("false")', () => p.setVideoStillMode('false'));
      if (res.ok) {
        stillHeld = false;
      }
    }

    function listener(mine) {
      return {
        onbufferingstart: function () {},
        onbufferingprogress: function () {},
        onbufferingcomplete: function () {},
        onstreamcompleted: function () {
          // A listener from a superseded open() must not advance the
          // playlist: it would skip an item for every stale player still
          // holding a reference.
          if (mine !== generation) {
            return;
          }
          log('stream completed');
          if (opts.onStreamCompleted) {
            opts.onStreamCompleted();
          }
        },
        onevent: function (type) {
          if (mine === generation) {
            log('avplay event ' + type);
          }
        },
        onerror: function (type) {
          if (mine !== generation) {
            return;
          }
          lastError = 'avplay error ' + type;
          log(lastError);
          if (opts.onError) {
            opts.onError(String(type));
          }
        },
      };
    }

    /**
     * Play one URL, taking over from whatever is on the plane.
     *
     * Samsung's order, and the freeze is released inside it rather than by
     * the caller, because rule 4 is about exactly this gap:
     *
     *   setVideoStillMode("true")   (by the caller, before this, if needed)
     *   stop -> open -> setListener -> prepare -> setDisplayRect
     *   setVideoStillMode("false") -> play
     *
     * `prepare()` is synchronous, and Samsung warns it "can take a long time"
     * and should not be called on the UI thread. It is called here anyway,
     * and the trade is deliberate: the frozen frame, or the opaque image that
     * replaced it, is what the viewer sees for that whole stretch, so the
     * hang is invisible on the glass. What it does cost is that the rotation
     * timer, the device-change poll and the key handler are all stalled for
     * the length of an open+prepare over the network, once per clip.
     * `prepareAsync()` would avoid that and is the obvious follow-up; it is
     * not used yet because holding the freeze across an asynchronous prepare
     * has not been measured on this panel.
     *
     * @param {string} url
     * @param {{width: number, height: number}} screen - CSS pixels
     * @returns {{ok: boolean, durationMs: (number|null)}}
     */
    function play(url, screen) {
      const p = acquire();
      if (!p) {
        return { ok: false, durationMs: null };
      }
      const mine = ++generation;
      preparedDurationMs = null;

      // Nothing to stop on the first item, and a throw here is not a reason
      // to abandon the seam.
      attempt('stop', () => p.stop());

      const opened = attempt('open', () => p.open(url));
      if (!opened.ok) {
        // The plane is already given up; holding the freeze would strand a
        // still picture on a screen that is not playing.
        release();
        return { ok: false, durationMs: null };
      }

      attempt('setListener', () => p.setListener(listener(mine)));

      const prepared = attempt('prepare', () => p.prepare());
      if (!prepared.ok) {
        release();
        return { ok: false, durationMs: null };
      }

      // Rotation BEFORE the rect. Samsung: "This API call will change the
      // origin of coordinates. So, Application should call setDisplayRect()
      // again after calling this API." Allowed in IDLE/READY/PLAYING/PAUSED;
      // after prepare() the player is READY. Since 4.0.
      // Defensive: `screen` used to be read only inside attempt(), where a
      // miss was caught. A caller without one must not throw here, after
      // prepare() with the freeze held and no release().
      const viewport = screen || { width: 1920, height: 1080 };
      const rotation = resolveRotation(viewport);
      let turnedState;
      if (rotation.value === 'NONE' && rotation.source !== 'override') {
        // Landscape, or portrait that nobody has measured yet: the plane is
        // NOT touched. The 482 measured seams ran without this call (the probe
        // sent an invalid value, so it never took), and a landscape fleet
        // must keep the exact sequence that was measured. An override of NONE
        // is different -- it exists to undo an earlier turn, so it is sent.
        turnedState = 'skipped';
        if (rotation.source === 'unmeasured') {
          log('portrait viewport but no rotation is known for this panel: press 7 or 9 on the remote with the HUD open');
        }
      } else if (typeof p.setDisplayRotation === 'function') {
        const turned = attempt('setDisplayRotation', () =>
          p.setDisplayRotation('PLAYER_DISPLAY_ROTATION_' + rotation.value),
        );
        turnedState = turned.ok ? 'applied' : 'refused';
        if (!turned.ok) {
          log('setDisplayRotation was refused: video will be drawn in the panel\'s PHYSICAL orientation');
        }
      } else {
        turnedState = 'absent';
        log('setDisplayRotation is absent: video will be drawn in the panel\'s PHYSICAL orientation');
      }
      // The HUD reads this. The state is part of it on purpose: a value that
      // was refused must not read as a value that took, in the middle of the
      // one measurement that decides the direction.
      onRotation(rotation.value, rotation.source, turnedState, {
        x: 0, y: 0, width: viewport.width, height: viewport.height,
      });

      // The rect, in the space the rotation just defined. Measured in ONE form
      // only, and only in landscape; see the note at the top of this file.
      attempt('setDisplayRect', () => p.setDisplayRect(0, 0, viewport.width, viewport.height));
      // Aspect inside that rect. Without it the default fills the area, which
      // stretches a 16:9 clip across a 9:16 panel.
      // Not measured on this panel -- it is not among the methods the probe
      // enumerated, and `typeof === 'function'` proves presence, not
      // acceptance (rule 5). A refusal is swallowed like any other, and the
      // result is a silently STRETCHED advert, so say so rather than letting
      // it pass as a routine line in the log.
      if (typeof p.setDisplayMethod === 'function') {
        const method = attempt('setDisplayMethod', () =>
          p.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX'),
        );
        if (!method.ok) {
          log('setDisplayMethod was refused: video will be STRETCHED to the full screen');
        }
      } else {
        log('setDisplayMethod is absent: video will be STRETCHED to the full screen');
      }

      // Read here, bound to THIS prepare() rather than to whenever the caller
      // happens to ask. The probe measured that the player's clock does not
      // necessarily belong to the new stream straight after a seam ("the new
      // stream's clock had not reset"), which is why this is not a live
      // getDuration() call made later from the rotation timer. Whether
      // getDuration() lags the same way is NOT measured, so the caller treats
      // this as a hint and keeps its own fallback.
      const got = attempt('getDuration', () => p.getDuration());
      preparedDurationMs =
        got.ok && typeof got.value === 'number' && got.value > 0 ? got.value : null;

      muteAudio();

      // Rule 4: here, between prepare and play -- not before, not on a timer.
      release();

      const played = attempt('play', () => p.play());
      if (!played.ok) {
        // Nothing is going to play, so nothing justifies holding the panel's
        // mute. The caller drops to the <video> path from here, and that path
        // never calls stop(), so this is the last chance to hand it back.
        restoreAudio();
        return { ok: false, durationMs: null };
      }
      return { ok: true, durationMs: preparedDurationMs };
    }

    /**
     * Give up the plane entirely, release any freeze, and put the audio back.
     *
     * Called on teardown, on unpairing, and whenever the next item is not a
     * video. Bumping the generation first makes every in-flight listener
     * inert, so a stream that completes during the stop cannot advance a
     * playlist that no longer exists.
     */
    function stop() {
      generation += 1;
      preparedDurationMs = null;
      const p = player;
      if (!p) {
        stillHeld = false;
        return;
      }
      attempt('stop', () => p.stop());
      // After the stop, so the plane is not handed back to an ended stream
      // while the page still expects a picture.
      release();
      // The mute is NOT restored here. stop() runs at every video->image
      // seam, so restoring would toggle the panel's mute once per boundary
      // in a mixed playlist -- and if this firmware shows its own OSD for a
      // programmatic mute, that is an icon blinking over the customer's
      // content all day. The mute belongs to the session, so close() is what
      // hands it back.
    }

    /**
     * Hand the AVPlay instance back to the system.
     *
     * Samsung: "To remove the AVPlay instance, call the close() method."
     * Skipping it leaves the player allocated to a process that no longer
     * exists -- after which `getPlayer()` answers QuotaExceededError for
     * every later run and only a panel restart clears it. This app reloads
     * itself from the RETURN key, so that is not a theoretical path.
     */
    function close() {
      stop();
      restoreAudio();
      const p = player;
      player = null;
      if (!p) {
        return;
      }
      attempt('close', () => p.close());
    }

    /** The millisecond position of the current stream, or null. */
    function currentTime() {
      const p = player;
      if (!p || typeof p.getCurrentTime !== 'function') {
        return null;
      }
      const got = attempt('getCurrentTime', () => p.getCurrentTime());
      return got.ok && typeof got.value === 'number' ? got.value : null;
    }

    api.play = play;
    api.stop = stop;
    api.close = close;
    api.freeze = freeze;
    api.release = release;
    api.currentTime = currentTime;
    api.durationMs = function () {
      return preparedDurationMs;
    };
    api.isFrozen = function () {
      return stillHeld;
    };
    api.lastError = function () {
      return lastError;
    };
    return api;
  }

  const moduleApi = {
    seamPlan: seamPlan,
    isAvailable: isAvailable,
    createPlayer: createPlayer,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = moduleApi;
  }
  if (root && typeof root.document !== 'undefined') {
    root.DigmiAvplay = moduleApi;
  }
})(typeof window !== 'undefined' ? window : this);
