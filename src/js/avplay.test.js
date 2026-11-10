// Run: node --test src/js/avplay.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { seamPlan, isAvailable, createPlayer } = require('./avplay.js');

test('seamPlan: leaving a video for another video needs the freeze', () => {
  assert.deepEqual(seamPlan('video', 'video'), { freeze: true, coverMustBePainted: false });
});

test('seamPlan: an arriving image is the cover, and must be painted first', () => {
  // The decisive one. An image that has merely been asked for is transparent,
  // and the plane shows through for the whole decode.
  assert.deepEqual(seamPlan('video', 'image'), { freeze: false, coverMustBePainted: true });
});

test('seamPlan: leaving an image needs nothing - there is no stream to tear down', () => {
  assert.deepEqual(seamPlan('image', 'video'), { freeze: false, coverMustBePainted: false });
  assert.deepEqual(seamPlan('image', 'image'), { freeze: false, coverMustBePainted: false });
});

test('seamPlan: the first item of a playlist freezes nothing', () => {
  assert.deepEqual(seamPlan('none', 'video'), { freeze: false, coverMustBePainted: false });
});

test('isAvailable: answers by name, and is false in a plain browser', () => {
  assert.equal(isAvailable({}), false);
  assert.equal(isAvailable({ webapis: {} }), false);
  assert.equal(isAvailable({ webapis: { avplaystore: {} } }), false);
  assert.equal(isAvailable({ webapis: { avplaystore: { getPlayer: 'not a function' } } }), false);
  assert.equal(isAvailable({ webapis: { avplaystore: { getPlayer: () => ({}) } } }), true);
});

/**
 * A fake panel that records the ORDER of native calls and the RAW arguments.
 *
 * Raw, not interpolated. An earlier version of this file pushed
 * `${name}(${args.join(',')})`, which turns the boolean `true` and the string
 * `'true'` into the same text -- so the one assertion that exists to pin
 * rule 5 (setVideoStillMode takes a DOMString) passed with a boolean in the
 * code. A mutation proved it: swapping `'true'` for `true` kept the whole
 * suite green while, on a real panel, every seam would have been unprotected.
 */
function fakePanel(overrides) {
  const calls = [];
  const args = {};
  const behaviour = overrides || {};
  const record =
    (name) =>
    (...callArgs) => {
      calls.push(name);
      (args[name] = args[name] || []).push(callArgs);
      if (behaviour[name]) {
        return behaviour[name](...callArgs);
      }
      return 'OK';
    };
  const player = {
    stop: record('stop'),
    open: record('open'),
    prepare: record('prepare'),
    play: record('play'),
    close: record('close'),
    setDisplayRect: record('setDisplayRect'),
    setDisplayRotation: record('setDisplayRotation'),
    setDisplayMethod: record('setDisplayMethod'),
    setVideoStillMode: record('setVideoStillMode'),
    getDuration: () => 15000,
    getCurrentTime: () => 0,
    setListener: (listener) => {
      calls.push('setListener');
      player.listener = listener;
      return 'OK';
    },
  };
  const audio = {
    muted: false,
    isMute: record('isMute'),
    setMute: record('setMute'),
  };
  // isMute() MIRRORS setMute(), the way a real panel does. Without that the
  // worst mute bug there is cannot even be expressed in a test: muting twice
  // and recording our own mute as "how we found it".
  audio.muted = behaviour.isMuteValue === undefined ? false : !!behaviour.isMuteValue;
  audio.isMute = (...a) => {
    calls.push('isMute');
    (args.isMute = args.isMute || []).push(a);
    if (behaviour.isMuteThrows) {
      throw new Error('SecurityError');
    }
    return audio.muted;
  };
  audio.setMute = (...a) => {
    calls.push('setMute');
    (args.setMute = args.setMute || []).push(a);
    if (behaviour.setMute) {
      return behaviour.setMute(...a);
    }
    audio.muted = !!a[0];
    return 'OK';
  };
  // A document that HAS the avplayer surface, unless a test removes it.
  const doc = {
    querySelector: (selector) =>
      selector === 'object[type="application/avplayer"]' && !behaviour.noSurface
        ? { tagName: 'OBJECT' }
        : null,
  };
  return {
    calls,
    args,
    player,
    audio,
    doc,
    scope: {
      webapis: { avplaystore: { getPlayer: () => player } },
      tizen: { tvaudiocontrol: audio },
    },
  };
}

function makePlayer(panel, extra) {
  return createPlayer(Object.assign({ scope: panel.scope, doc: panel.doc }, extra || {}));
}

test('createPlayer: the native calls run in Samsung order, release between prepare and play', () => {
  const panel = fakePanel();
  const player = makePlayer(panel);

  player.freeze();
  const result = player.play('http://example/clip.mp4', { width: 1080, height: 1920 });

  assert.equal(result.ok, true);
  assert.deepEqual(panel.calls, [
    'setVideoStillMode',
    'stop',
    'open',
    'setListener',
    'prepare',
    'setDisplayRect',
    'setDisplayMethod',
    'isMute',
    'setMute',
    'setVideoStillMode',
    'play',
  ]);

  // Stated as an order, not just a membership: this is the rule that cost
  // three wrong fixes on the bench.
  const prepare = panel.calls.indexOf('prepare');
  const release = panel.calls.lastIndexOf('setVideoStillMode');
  const play = panel.calls.indexOf('play');
  assert.ok(prepare < release, 'the freeze was released before prepare()');
  assert.ok(release < play, 'the freeze was released after play() - a whole clip frozen');
});

test('createPlayer: the freeze argument is the STRING "true", never a boolean', () => {
  // Rule 5. A boolean raises TypeMismatchError, and from JavaScript that is
  // indistinguishable from the method being absent - so the freeze would
  // silently never happen and every seam would be black.
  const panel = fakePanel();
  const player = makePlayer(panel);

  player.freeze();
  player.release();

  const passed = panel.args.setVideoStillMode.map((call) => call[0]);
  assert.deepEqual(passed, ['true', 'false']);
  passed.forEach((value) => {
    assert.equal(typeof value, 'string', `setVideoStillMode got a ${typeof value}, not a string`);
  });
});

test('createPlayer: the display rect is the full screen - the only form measured here', () => {
  // Samsung's guide says the parameter space is always 1920x1080 and that an
  // app at another resolution must convert. The probe passed the viewport
  // unconverted and its video filled the screen for 482 seams. Only that form
  // has been seen to work, so only that form is used, and a letterboxed rect
  // computed in CSS pixels is exactly what this pins against coming back.
  const panel = fakePanel();
  const player = makePlayer(panel);

  player.play('http://example/clip.mp4', { width: 1080, height: 1920 });

  assert.deepEqual(panel.args.setDisplayRect[0], [0, 0, 1080, 1920]);
  assert.deepEqual(panel.args.setDisplayMethod[0], ['PLAYER_DISPLAY_MODE_LETTER_BOX']);
});

test('createPlayer: the plane is turned to the web layer\'s angle, and BEFORE the rect', () => {
  // Samsung: setDisplayRotation "will change the origin of coordinates. So,
  // Application should call setDisplayRect() again after calling this API."
  // The web layer on a portrait-mounted panel is rotated by the panel; the
  // plane is not, so without this every portrait clip comes out sideways --
  // seen on the bench 2026-11-10. The probe never met it: it only ever ran
  // with the panel displaying landscape.
  const panel = fakePanel();
  panel.scope.screen = { orientation: { angle: 90 } };
  const player = makePlayer(panel);

  player.play('http://example/clip.mp4', { width: 1080, height: 1920 });

  assert.deepEqual(panel.args.setDisplayRotation[0], ['PLAYER_DISPLAY_ROTATION_90']);
  const prepare = panel.calls.indexOf('prepare');
  const turned = panel.calls.indexOf('setDisplayRotation');
  const rect = panel.calls.indexOf('setDisplayRect');
  assert.ok(prepare < turned, 'the plane was turned before prepare()');
  assert.ok(turned < rect, 'the rect was set BEFORE the rotation changed its coordinate origin');
});

test('createPlayer: a landscape viewport leaves the plane untouched - the measured sequence, call for call', () => {
  // The 482 seams were measured with no rotation call taking effect (the
  // probe sent PLAYER_DISPLAY_ROTATION_0, which is not a value Samsung
  // accepts, so it never took). A landscape fleet keeps exactly that
  // sequence: no new native call between prepare() and the rect. fakePanel
  // has no `screen`, so there is no orientation API here either.
  const reported = [];
  const panel = fakePanel();
  const player = makePlayer(panel, { onRotation: (v, s, state) => reported.push(v + ':' + s + ':' + state) });

  player.play('http://example/clip.mp4', { width: 1920, height: 1080 });

  assert.equal(panel.calls.indexOf('setDisplayRotation'), -1, 'a landscape panel got a rotation call it was never measured with');
  assert.deepEqual(reported, ['NONE:landscape:skipped']);
});

test('createPlayer: a landscape fleet is SILENT about rotation, and the HUD gets the rect verbatim', () => {
  // The "press 7 or 9" line is for the one unmeasured case. A future change
  // that logs it on every skipped rotation would nag every landscape seam in
  // the field; nothing but this test would notice. And the rect handed to
  // the HUD is the line the bench reads to decide whether the rotated
  // coordinate space swaps its axes, so it must be the rect that was sent.
  const lines = [];
  const rects = [];
  const panel = fakePanel();
  panel.scope.screen = { orientation: { angle: 0 } };
  const player = makePlayer(panel, {
    log: (line) => lines.push(line),
    onRotation: (v, s, state, rect) => rects.push(rect),
  });

  player.play('http://example/clip.mp4', { width: 1920, height: 1080 });

  assert.deepEqual(lines.filter((line) => /portrait|press 7/i.test(line)), [], 'a landscape panel was told to press a key');
  assert.deepEqual(rects, [{ x: 0, y: 0, width: 1920, height: 1080, state: 'applied' }]);
  assert.deepEqual(panel.args.setDisplayRect[0], [0, 0, 1920, 1080]);
});

test('createPlayer: back to automatic after an override UNDOES the turn on the same instance', () => {
  // The same player carries the last turn into the next clip. Without this
  // a technician pressing 7 and then 5 leaves the plane at 90 degrees while
  // the HUD reads "NONE ... skipped". Only the first clip after the override
  // sends NONE; the ones after it are skipped like any landscape clip.
  const panel = fakePanel();
  let forced = '90';
  const player = makePlayer(panel, { rotation: () => forced });

  player.play('http://example/a.mp4', { width: 1920, height: 1080 });
  forced = null;
  player.play('http://example/b.mp4', { width: 1920, height: 1080 });
  player.play('http://example/c.mp4', { width: 1920, height: 1080 });

  assert.deepEqual(
    panel.args.setDisplayRotation.map((call) => call[0]),
    ['PLAYER_DISPLAY_ROTATION_90', 'PLAYER_DISPLAY_ROTATION_NONE'],
  );
});

test('createPlayer: the rect the HUD gets is reported AFTER the attempt, with its own outcome', () => {
  // The rect line is what decides whether the rotated coordinate space swaps
  // its axes. A rect that the panel refused must not be shown as the rect
  // that took.
  const rects = [];
  const panel = fakePanel({ setDisplayRect: () => { throw new Error('InvalidValuesError'); } });
  panel.scope.screen = { orientation: { angle: 90 } };
  const player = makePlayer(panel, { onRotation: (v, s, state, rect) => rects.push(rect.state) });

  const result = player.play('http://example/clip.mp4', { width: 1080, height: 1920 });

  assert.equal(result.ok, true, 'a refused rect must not abort the clip');
  assert.deepEqual(rects, ['refused']);
  assert.ok(panel.calls.indexOf('setDisplayRect') > -1, 'the rect was never attempted');
});

test('createPlayer: a portrait panel with NO orientation API is told apart from one reporting angle 0', () => {
  // Both end up "not turned", but a bench has to know which panel it is
  // measuring, and the portraitFallback option is how the measured value
  // comes back in -- as an option, so this test can pin it.
  const sources = [];
  const bare = fakePanel();
  makePlayer(bare, { onRotation: (v, s) => sources.push(s) })
    .play('http://example/a.mp4', { width: 1080, height: 1920 });

  const zero = fakePanel();
  zero.scope.screen = { orientation: { angle: 0 } };
  makePlayer(zero, { onRotation: (v, s) => sources.push(s) })
    .play('http://example/b.mp4', { width: 1080, height: 1920 });

  const measured = fakePanel();
  makePlayer(measured, { portraitFallback: '270', onRotation: (v, s) => sources.push(s) })
    .play('http://example/c.mp4', { width: 1080, height: 1920 });

  assert.deepEqual(sources, ['no-orientation-api', 'unmeasured', 'viewport']);
  assert.equal(bare.calls.indexOf('setDisplayRotation'), -1);
  assert.equal(zero.calls.indexOf('setDisplayRotation'), -1);
  assert.deepEqual(measured.args.setDisplayRotation[0], ['PLAYER_DISPLAY_ROTATION_270']);
});

test('createPlayer: a portrait viewport with angle 0 is reported as unmeasured, not silently turned', () => {
  // A panel that rotates in its compositor can report angle 0 for a portrait
  // page. Until the bench has measured which way AVPlay counts, the honest
  // answer is "not turned" on the HUD -- not a guess that comes out sideways.
  const reported = [];
  const panel = fakePanel();
  panel.scope.screen = { orientation: { angle: 0 } };
  const player = makePlayer(panel, { onRotation: (v, s, state) => reported.push(v + ':' + s + ':' + state) });

  player.play('http://example/clip.mp4', { width: 1080, height: 1920 });

  assert.equal(panel.calls.indexOf('setDisplayRotation'), -1);
  assert.deepEqual(reported, ['NONE:unmeasured:skipped']);
});

test('createPlayer: 180 and 270 map to their own values, and an override of NONE is SENT', () => {
  // 180/270 pin the mapping (a mutation folding 180 into NONE survived
  // before this). An override of NONE exists to undo an earlier turn, so
  // unlike the derived NONE it must reach the panel.
  const panel = fakePanel();
  panel.scope.screen = { orientation: { angle: 180 } };
  let forced = null;
  const player = makePlayer(panel, { rotation: () => forced });

  player.play('http://example/a.mp4', { width: 1080, height: 1920 });
  panel.scope.screen.orientation.angle = 270;
  player.play('http://example/b.mp4', { width: 1080, height: 1920 });
  forced = 'NONE';
  player.play('http://example/c.mp4', { width: 1080, height: 1920 });

  assert.deepEqual(
    panel.args.setDisplayRotation.map((call) => call[0]),
    ['PLAYER_DISPLAY_ROTATION_180', 'PLAYER_DISPLAY_ROTATION_270', 'PLAYER_DISPLAY_ROTATION_NONE'],
  );
});

test('createPlayer: a refused or absent setDisplayRotation still sets the rect and plays, and says so', () => {
  // The call is new on this firmware. If it throws, the clip must still be
  // placed and started -- sideways beats black -- and the HUD must not read
  // a value that never took.
  const reported = [];
  const refusing = fakePanel({ setDisplayRotation: () => { throw new Error('InvalidStateError'); } });
  refusing.scope.screen = { orientation: { angle: 90 } };
  const a = makePlayer(refusing, { onRotation: (v, s, state) => reported.push(state) });
  const resultA = a.play('http://example/clip.mp4', { width: 1080, height: 1920 });
  assert.equal(resultA.ok, true);
  ['setDisplayRect', 'setDisplayMethod', 'play'].forEach((name) => {
    assert.ok(refusing.calls.indexOf(name) > refusing.calls.indexOf('setDisplayRotation'), name + ' did not run after the refusal');
  });

  const absent = fakePanel();
  delete absent.player.setDisplayRotation;
  absent.scope.screen = { orientation: { angle: 90 } };
  const b = makePlayer(absent, { onRotation: (v, s, state) => reported.push(state) });
  const resultB = b.play('http://example/clip.mp4', { width: 1080, height: 1920 });
  assert.equal(resultB.ok, true);
  assert.ok(absent.calls.indexOf('play') > -1);

  assert.deepEqual(reported, ['refused', 'absent']);
});

test('createPlayer: a rotation override wins over the screen angle, and an invalid one does not', () => {
  // Which way round AVPlay counts is not knowable in advance; Samsung's own
  // sample binds remote keys for the same reason. The override is how the
  // bench finds out, so it has to win -- and a stray value must not.
  const reported = [];
  const panel = fakePanel();
  panel.scope.screen = { orientation: { angle: 90 } };
  let forced = '270';
  const player = makePlayer(panel, {
    rotation: () => forced,
    onRotation: (value, source) => reported.push(value + ':' + source),
  });

  player.play('http://example/clip.mp4', { width: 1080, height: 1920 });
  forced = '45';
  player.play('http://example/clip2.mp4', { width: 1080, height: 1920 });

  assert.deepEqual(
    panel.args.setDisplayRotation.map((call) => call[0]),
    ['PLAYER_DISPLAY_ROTATION_270', 'PLAYER_DISPLAY_ROTATION_90'],
  );
  assert.deepEqual(reported, ['270:override', '90:screen']);
});

test('createPlayer: without the avplayer <object> it refuses rather than playing nothing', () => {
  // The worst failure this file can have: open/prepare/play all answer OK and
  // nothing is drawn, so `ok` is true, the caller never falls back, and every
  // clip is a black screen with no error anywhere. dlogutil yields no lines
  // on this panel, so it would be invisible.
  const panel = fakePanel({ noSurface: true });
  const player = makePlayer(panel);

  const result = player.play('http://example/clip.mp4', { width: 1080, height: 1920 });

  assert.equal(result.ok, false, 'it reported success with no surface to draw on');
  assert.deepEqual(panel.calls, [], 'it touched the player without a surface');
  assert.match(player.lastError(), /application\/avplayer/);
});

test('createPlayer: playback is silent, and close() puts the mute back', () => {
  // The <video> element carried `muted`, scoped to the element. AVPlay has no
  // equivalent, so this reaches for the TV's own mute - which means it must
  // also hand it back, or a signage panel stays muted for good.
  const panel = fakePanel();
  const player = makePlayer(panel);

  player.play('http://example/clip.mp4', { width: 1080, height: 1920 });
  assert.deepEqual(panel.args.setMute[0], [true], 'playback was audible');
  assert.equal(panel.audio.muted, true);

  player.close();
  assert.equal(panel.audio.muted, false, 'the panel was left muted');
});

test('createPlayer: stop() does NOT toggle the mute - that is once per session', () => {
  // stop() runs at every video->image seam. Restoring there would flip the
  // panel's mute once per boundary in a mixed playlist, and if this firmware
  // shows an OSD for a programmatic mute that is an icon blinking over the
  // customer's content all day.
  const panel = fakePanel();
  const player = makePlayer(panel);

  player.play('http://example/a.mp4', { width: 1080, height: 1920 });
  player.stop();

  assert.equal(panel.audio.muted, true, 'stop() handed the audio back mid-playlist');
  assert.equal(panel.args.setMute.length, 1);
});

test('createPlayer: muting twice does not record our own mute as the old state', () => {
  // The bug this exists for: the second play() reads isMute(), which now says
  // `true` BECAUSE WE MUTED IT, records that as "how we found it", and then
  // refuses to unmute for ever. The customer's TV is silent on every input
  // until somebody picks up the remote.
  const panel = fakePanel();
  const player = makePlayer(panel);

  player.play('http://example/a.mp4', { width: 1080, height: 1920 });
  player.play('http://example/b.mp4', { width: 1080, height: 1920 });
  player.close();

  assert.equal(panel.audio.muted, false, 'the panel was left muted for good');
});

test('createPlayer: an unreadable mute state is still undone on the way out', () => {
  // isMute() threw, so we cannot know what it was - but we DID mute it, and
  // leaving a panel silent for good is the harm the docblock commits to
  // avoiding. Undoing our own change is the smaller risk.
  const panel = fakePanel({ isMuteThrows: true });
  const player = makePlayer(panel);

  player.play('http://example/a.mp4', { width: 1080, height: 1920 });
  assert.equal(panel.audio.muted, true);
  player.close();

  assert.equal(panel.audio.muted, false, 'an unreadable state left the panel muted');
});

test('createPlayer: a play that fails at the last step hands the mute back', () => {
  // The caller drops to the <video> path from here, and that path never
  // calls stop() or close() - so this is the last chance.
  const panel = fakePanel({
    play: () => {
      throw new Error('PLAYER_ERROR_INVALID_OPERATION');
    },
  });
  const player = makePlayer(panel);

  assert.equal(player.play('http://example/a.mp4', { width: 1080, height: 1920 }).ok, false);
  assert.equal(panel.audio.muted, false, 'the panel stayed muted with nothing playing');
});

test('createPlayer: a panel that was already muted is left muted', () => {
  // Somebody muted it on purpose. Unmuting it on our way out would be this
  // app changing a setting it never owned.
  const panel = fakePanel({ isMuteValue: true });
  const player = makePlayer(panel);

  player.play('http://example/clip.mp4', { width: 1080, height: 1920 });
  player.close();

  assert.equal(panel.audio.muted, true, 'it unmuted a panel it found muted');
});

test('createPlayer: close() stops, restores the audio and hands the instance back', () => {
  // Samsung: "To remove the AVPlay instance, call the close() method."
  // Without it the player stays allocated to a page that is going away, and
  // the next getPlayer() answers QuotaExceededError until the panel restarts.
  const panel = fakePanel();
  const player = makePlayer(panel);
  player.play('http://example/a.mp4', { width: 1080, height: 1920 });
  panel.calls.length = 0;

  player.close();

  assert.ok(panel.calls.indexOf('close') > -1, 'the instance was never handed back');
  assert.ok(
    panel.calls.indexOf('stop') < panel.calls.indexOf('close'),
    'it closed before stopping',
  );
  assert.equal(panel.audio.muted, false);
});

test('createPlayer: a freeze that throws leaves the player unfrozen, not stuck', () => {
  // If the flag were set before the call, every release path would
  // early-return and the panel would keep a frozen frame for the rest of the
  // session - a screen that looks healthy and plays nothing.
  const panel = fakePanel({
    setVideoStillMode: () => {
      throw new TypeError('TypeMismatchError');
    },
  });
  const player = makePlayer(panel);

  assert.equal(player.freeze(), false);
  assert.equal(player.isFrozen(), false);
  assert.match(player.lastError(), /setVideoStillMode/);
});

test('createPlayer: a release that throws keeps the player marked frozen', () => {
  // The mirror of the test above. Clearing the flag on a call that failed
  // would leave the panel genuinely frozen while this file believed
  // otherwise, and nothing would ever try again.
  let calls = 0;
  const panel = fakePanel({
    setVideoStillMode: (mode) => {
      calls += 1;
      if (mode === 'false') {
        throw new Error('PLAYER_ERROR_INVALID_OPERATION');
      }
      return 'OK';
    },
  });
  const player = makePlayer(panel);

  player.freeze();
  assert.equal(player.isFrozen(), true);
  player.release();

  assert.equal(player.isFrozen(), true, 'a failed release reported the plane as live');
  assert.equal(calls, 2);
});

test('createPlayer: a failed open releases the freeze rather than stranding a still', () => {
  const panel = fakePanel({
    open: () => {
      throw new Error('PLAYER_ERROR_NOT_SUPPORTED_FILE');
    },
  });
  const player = makePlayer(panel);

  player.freeze();
  assert.equal(player.isFrozen(), true);
  const result = player.play('http://example/bad.mp4', { width: 1080, height: 1920 });

  assert.equal(result.ok, false);
  assert.equal(player.isFrozen(), false, 'a still was left on a screen that is not playing');
});

test('createPlayer: a failed prepare also releases the freeze', () => {
  const panel = fakePanel({
    prepare: () => {
      throw new Error('PLAYER_ERROR_INVALID_OPERATION');
    },
  });
  const player = makePlayer(panel);
  player.freeze();
  assert.equal(player.play('http://example/x.mp4', { width: 1080, height: 1920 }).ok, false);
  assert.equal(player.isFrozen(), false);
});

test('createPlayer: stop releases the freeze, and only after stopping', () => {
  // Releasing first would hand the plane back to a stream that is about to
  // end, and an ended stream is black.
  const panel = fakePanel();
  const player = makePlayer(panel);
  player.play('http://example/a.mp4', { width: 1080, height: 1920 });
  panel.calls.length = 0;

  player.freeze();
  player.stop();

  assert.deepEqual(panel.calls, ['setVideoStillMode', 'stop', 'setVideoStillMode']);
  assert.equal(player.isFrozen(), false);
});

test('createPlayer: a superseded listener cannot advance the playlist', () => {
  // Every open() installs a new listener, and the old player object keeps
  // answering. Without the generation check a completed stream from a torn
  // down playlist would skip an item in the live one.
  const panel = fakePanel();
  let completions = 0;
  const player = makePlayer(panel, {
    onStreamCompleted: () => {
      completions += 1;
    },
  });

  player.play('http://example/a.mp4', { width: 1080, height: 1920 });
  const stale = panel.player.listener;
  player.play('http://example/b.mp4', { width: 1080, height: 1920 });
  const live = panel.player.listener;

  stale.onstreamcompleted();
  assert.equal(completions, 0, 'a superseded stream advanced the playlist');
  live.onstreamcompleted();
  assert.equal(completions, 1);

  player.stop();
  live.onstreamcompleted();
  assert.equal(completions, 1, 'a stream completed after stop() advanced the playlist');
});

test('createPlayer: the duration is the one read when THIS clip was prepared', () => {
  // Not a live getDuration() asked for later. The probe measured that the
  // player's clock does not necessarily belong to the new stream straight
  // after a seam, and a stale length sets the slot for the wrong clip: a 10 s
  // advert held for 60 s, or a 60 s one cut at 10. Nothing is black, so
  // nobody would look.
  const panel = fakePanel();
  const player = makePlayer(panel);

  assert.equal(player.durationMs(), null, 'a duration was reported before play()');

  const result = player.play('http://example/a.mp4', { width: 1080, height: 1920 });
  assert.equal(result.durationMs, 15000);
  assert.equal(player.durationMs(), 15000);

  // The panel starts answering with the NEXT clip's length only later; what
  // this reports must not change under it.
  panel.player.getDuration = () => 99999;
  assert.equal(player.durationMs(), 15000, 'the duration changed without a new prepare');

  player.stop();
  assert.equal(player.durationMs(), null, 'a stopped player still reported a duration');
});

test('createPlayer: an unusable duration is null rather than a guess', () => {
  // The caller falls back to the playlist's own duration when this is null,
  // so a wrong number is worse than no number.
  [0, -1, null, undefined, '15000', NaN].forEach((bad) => {
    const panel = fakePanel();
    panel.player.getDuration = () => bad;
    const player = makePlayer(panel);
    const result = player.play('http://example/a.mp4', { width: 1080, height: 1920 });
    assert.equal(result.durationMs, null, `${String(bad)} was taken as a duration`);
  });

  const panel = fakePanel();
  panel.player.getDuration = () => {
    throw new Error('not prepared');
  };
  const player = makePlayer(panel);
  assert.equal(player.play('http://example/a.mp4', { width: 1080, height: 1920 }).durationMs, null);
});

test('createPlayer: a panel with no AVPlay fails without throwing', () => {
  const player = createPlayer({ scope: {}, doc: { querySelector: () => ({}) } });
  assert.equal(player.play('http://example/a.mp4', { width: 1080, height: 1920 }).ok, false);
  assert.equal(player.freeze(), false);
  assert.doesNotThrow(() => player.stop());
  assert.doesNotThrow(() => player.close());
});

test('createPlayer: a player held by a dead instance says so in plain words', () => {
  // QuotaExceededError out of getPlayer() means a previous page died without
  // close(). The raw name reads like a bug in this file, and the only cure is
  // a panel restart.
  const lines = [];
  const player = createPlayer({
    doc: { querySelector: () => ({ tagName: 'OBJECT' }) },
    scope: {
      webapis: {
        avplaystore: {
          getPlayer: () => {
            const error = new Error('too many players');
            error.name = 'QuotaExceededError';
            throw error;
          },
        },
      },
    },
    log: (line) => lines.push(line),
  });

  assert.equal(player.play('http://example/a.mp4', { width: 1080, height: 1920 }).ok, false);
  assert.ok(
    lines.some((line) => /restarted/.test(line)),
    'nothing told the operator the panel has to be restarted',
  );
});

test('createPlayer: a missing tvaudiocontrol does not stop playback', () => {
  // A browser, or a panel without the privilege. Audible is wrong; not
  // playing at all is worse.
  const panel = fakePanel();
  delete panel.scope.tizen;
  const player = makePlayer(panel);
  assert.equal(player.play('http://example/a.mp4', { width: 1080, height: 1920 }).ok, true);
  assert.doesNotThrow(() => player.stop());
});

test('createPlayer: a mute that throws does not stop playback either', () => {
  // Without the tv.audio privilege setMute raises SecurityError. The screen
  // should play, loudly and wrongly, rather than show nothing.
  const panel = fakePanel({
    setMute: () => {
      throw new Error('SecurityError');
    },
  });
  const player = makePlayer(panel);
  assert.equal(player.play('http://example/a.mp4', { width: 1080, height: 1920 }).ok, true);
  player.close();
  // Never recorded as ours, so nothing tries to "restore" a mute that was
  // never set.
  assert.equal(panel.args.setMute.length, 1);
});

test('createPlayer: an unmute that throws is retried, not recorded as done', () => {
  // The mirror of "a release that throws keeps the player marked frozen", in
  // the twin function. Clearing the flag first means one swallowed throw ends
  // the matter: nothing retries, and the panel stays muted with this file
  // believing it handed the audio back.
  let failUnmute = true;
  const panel = fakePanel({
    setMute: (mute) => {
      if (mute === false && failUnmute) {
        throw new Error('UnknownError');
      }
      panel.audio.muted = !!mute;
      return 'OK';
    },
  });
  const player = makePlayer(panel);

  player.play('http://example/a.mp4', { width: 1080, height: 1920 });
  player.close();
  assert.equal(panel.audio.muted, true, 'the fake did not model a failed unmute');

  // The next teardown must try again rather than treat the matter as closed.
  failUnmute = false;
  player.close();

  assert.equal(panel.audio.muted, false, 'a swallowed throw ended the attempt for good');
});

test('createPlayer: a second session does not record our own mute as the panel\'s', () => {
  // The player is built once per PAGE, not once per playlist, because the
  // panel's mute belongs to the TV and outlives a playlist. This pins the
  // consequence of getting that wrong: a wrapper that starts fresh while the
  // panel is still muted by the previous one reads isMute() as `true`,
  // records it as the setting it found, and refuses to undo it for ever.
  //
  // One wrapper, two playlists: the record survives, and the panel comes back.
  const panel = fakePanel();
  const player = makePlayer(panel);

  player.play('http://example/a.mp4', { width: 1080, height: 1920 });
  player.stop(); // a playlist ends; stop() deliberately keeps the mute
  player.play('http://example/b.mp4', { width: 1080, height: 1920 });
  player.close();

  assert.equal(panel.audio.muted, false, 'the panel was left muted across playlists');
});

test('createPlayer: a close that cannot reach the audio API still gives up the player', () => {
  // restoreAudio() returning early must not skip close(): the AVPlay instance
  // is the thing a reload cannot reclaim.
  const panel = fakePanel();
  delete panel.scope.tizen;
  const player = makePlayer(panel);
  player.play('http://example/a.mp4', { width: 1080, height: 1920 });
  player.close();
  assert.ok(panel.calls.indexOf('close') > -1, 'the instance was never handed back');
});
