const appVersion = '1.0.13';
const baseUrl = 'https://portal.digmi.eu';
// Shared tablet bearer. /api/v1/devices needs it (401 without); verify-device
// does not, so it is no longer sent there. It lives in one place now because
// rotating it means rebuilding this widget in lockstep with the other clients
// that carry the same token.
const apiAuthorization = 'Bearer DzQ7bhe9mt32FrGQXdhH5JrKesmrVcf40QwXiR2z8nvMaCePKskZP76ZqHEKoRNFtWpYCYR7VYeJgyTh';
let lastGeneratedUrl = null; // Store the last generated URL outside the function to track changes.
let checkInterval;

/**
 * Pixel size to RENDER the QR at. The box it sits in is sized in vmin by
 * brand.css and the canvas is stretched to fill it, so this is about
 * resolution, not layout: a 360px canvas blown up to 46vmin on a 4K panel is
 * a blurry QR, and a blurry QR is one a phone gives up on. Same function
 * signature and same shares as signage.digmi.eu, so the two screens scan
 * alike. Falls back to the old fixed 360 if brand.js did not load - a
 * small QR beats no QR on the one screen whose entire job is to be scanned.
 */
function qrPixelSize() {
  if (!window.DigmiBrand || typeof window.DigmiBrand.qrRenderSize !== 'function') {
    return 360;
  }
  return window.DigmiBrand.qrRenderSize(
    window.innerWidth,
    window.innerHeight,
    window.devicePixelRatio || 1
  );
}

// Guarded, because this runs at module level and a throw here takes the
// REST of this file with it: window.onload is never assigned, checkDevice()
// never starts, and the panel stops polling before it has polled once -
// a screen showing a blank white plate that can never discover it was
// paired, until someone power-cycles it. Measured by serving the page
// without js/vendor/qrcode.min.js: zero verify-device calls.
// The placeholder itself is worth little; keeping the rest of the file
// alive is worth everything.
//
// What this does NOT do is recover the QR. generateQRCode() throws the same
// ReferenceError when it runs, and it is async, so that one becomes an
// unhandled rejection with nowhere to surface on the panel: the white plate
// stays empty until someone reinstalls. What survives is the polling, which
// is the half that matters - the screen can still be paired from the portal
// using the uuid on the debug panel. signage.digmi.eu has a scheduleQrRetry()
// for the other half; porting it is the fix, and it is not done here.
try {
  new QRCode(document.getElementById('qrcode'), {
    text: baseUrl,
    width: qrPixelSize(),
    height: qrPixelSize(),
    colorDark: '#000000',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.H,
  });
} catch (error) {
  if (window.console && console.error) {
    console.error('QR placeholder failed to render:', error);
  }
}

/**
 * Covers the screen with the "Startar om…" modal and reloads the widget 1.5 s
 * later. The delay is the whole point: it gives the modal time to fade in so
 * the panel shows a reason for going blank rather than just going blank.
 */
function showReloadModal() {
  const modal = document.getElementById('reload-modal');
  modal.style.display = 'flex';
  modal.style.opacity = '0';

  setTimeout(() => {
    modal.style.transition = 'opacity 0.3s ease-in-out';
    modal.style.opacity = '1';
  }, 0);

  setTimeout(() => {
    // AVPlay is a SYSTEM resource and a reload does not fire unload, so
    // without this the instance stays allocated to the page that is going
    // away: every getPlayer() after the reload answers QuotaExceededError,
    // the widget falls back to <video> for the rest of the panel's uptime,
    // and only a restart clears it. The RETURN key is a documented, working
    // key on this app, so this is a path a person takes, not a corner case.
    if (window.stopAvplayPlayback) {
      window.stopAvplayPlayback(true);
    }
    window.location.reload();
  }, 1500);
}

/**
 * Asks the panel for the remote keys this file handles but does not receive
 * by default.
 *
 * Samsung delivers only a small set of keys to an application that has not
 * asked for anything: the four arrows, ENTER and RETURN. Those are the keys
 * the handler below has always acted on, which is why stepping a campaign and
 * reloading have always worked without a line like this one. Everything else
 * arrives only after `registerKey()` -- `lab/avplay-probe` is driven by the
 * number keys and received nothing at all until it registered them.
 *
 * INFO is not in that set, so the case naming it below is very likely dead on
 * a panel today. "Very likely" is honest: that is read off Samsung's rule and
 * the probe's measurement of the number keys, not measured for INFO itself.
 *
 * EXIT is deliberately NOT registered, and must never be. Samsung's User
 * Interaction Q&A: "To follow the policy, unregister the 'Exit' key and do not
 * handle it in your application. The key's default behavior implements the
 * policy", and "Do not open a popup after the 'Exit' key click ... any other
 * behavior causes your application to fail its certification checks."
 * Registering it would also take away the only way off a kiosk screen from the
 * remote, recoverable only by another store release.
 *
 * The list is registered one key at a time and a failure is swallowed: a panel
 * that does not offer a key throws, and that must not cost the others their
 * registration -- nor take the rest of this file down, since this runs at
 * module level.
 */
// With the HUD open, 6-9 turn the video plane (NONE/90/180/270) on the next
// clip and 5 goes back to automatic -- the probe's own bench control, kept
// because which way a portrait panel wants is not knowable in advance. Read
// back on the HUD's Stage line. Only with the HUD open: a customer leaning on
// the remote must not be able to turn every advert sideways for weeks.
const REMOTE_KEYS_TO_REGISTER = ['Info', '5', '6', '7', '8', '9'];

REMOTE_KEYS_TO_REGISTER.forEach((keyName) => {
  try {
    window.tizen.tvinputdevice.registerKey(keyName);
  } catch (error) {
    if (window.console && console.warn) {
      console.warn(`registerKey(${keyName}) failed:`, error);
    }
  }
});

document.addEventListener('keydown', function (e) {
  let deviceInfoElement;

  // Digits 5-9 with the HUD open: 5 = automatic, 6-9 = NONE/90/180/270 for
  // the AVPlay plane. Takes effect when the next clip starts; the current one
  // is not touched. Survives a playlist change on purpose (that is what a
  // bench measurement needs) and a reload clears it.
  if (e.keyCode >= window.tvKey.NUM_5 && e.keyCode <= window.tvKey.NUM_9) {
    if (e.repeat) {
      return;
    }
    const hud = document.querySelector('.device-info');
    if (!hud || !hud.classList.contains('visible')) {
      return;
    }
    window.avplayRotationOverride = [null, 'NONE', '90', '180', '270'][e.keyCode - window.tvKey.NUM_5];
    console.log('[avplay] rotation override: ' + (window.avplayRotationOverride || 'automatic') + ' - applies on the next clip');
    updateStageGeometry();
    e.preventDefault();
    return;
  }

  switch (e.keyCode) {
    case window.tvKey.ENTER:
    case window.tvKey.INFO:
      deviceInfoElement = document.querySelector('.device-info');
      if (deviceInfoElement) {
        // One mechanism, the `.visible` class. This assigned `style.display`
        // inline in two separate copies, which silently beats any stylesheet
        // rule and made the panel's state depend on which key opened it.
        deviceInfoElement.classList.toggle('visible');
        // The rotation override lives exactly as long as the HUD is open.
        // Set with it open, cleared when it closes: a technician who presses
        // 8 to look and then closes the panel must not leave every advert
        // turned 180 degrees with no hint on screen.
        if (!deviceInfoElement.classList.contains('visible') && window.avplayRotationOverride) {
          window.avplayRotationOverride = null;
          console.log('[avplay] rotation override cleared with the HUD - back to automatic on the next clip');
        }
        updateStageGeometry();
      }
      e.preventDefault();
      break;
    case window.tvKey.LEFT:
      if (window.currentMediaIndex !== undefined && window.displayMedia) {
        // Null it, don't just clear it. A cleared timer id is still a number,
        // so playlistIsOnScreen() went on reporting a live playlist and
        // checkDevice stayed gated - which is why stepping with the remote
        // used to park the screen on one slide with no content polls at all,
        // indefinitely. Nulled, the next pairing poll re-fetches and the
        // rotation resumes within the backoff.
        clearInterval(window.rotationInterval);
        window.rotationInterval = null;
        window.currentMediaIndex =
          (window.currentMediaIndex - 1 + window.mediaLength) % window.mediaLength;
        window.displayMedia(window.currentMediaIndex);
      }
      e.preventDefault();
      break;
    case window.tvKey.RIGHT:
      if (window.currentMediaIndex !== undefined && window.displayMedia) {
        // See the LEFT case above for why the handle is nulled.
        clearInterval(window.rotationInterval);
        window.rotationInterval = null;
        window.currentMediaIndex = (window.currentMediaIndex + 1) % window.mediaLength;
        window.displayMedia(window.currentMediaIndex);
      }
      e.preventDefault();
      break;
    case window.tvKey.RETURN:
      showReloadModal();
      e.preventDefault();
      break;
  }
});

/**
 * Builds a v4-shaped UUID from `crypto.getRandomValues`. Used only as the
 * fallback identity when Tizen's own device id is unavailable.
 *
 * @returns {string} A v4-shaped UUID.
 */
function generateUUID() {
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
  );
}

/**
 * Reads the panel's Tizen device id from the `tizenid` capability.
 *
 * The legacy `getCapabilities().duid` below it is near-unreachable: it is only
 * tried when `getCapability` RESOLVES falsy, and a panel without the
 * capability throws instead, which goes straight to the catch. Documented as
 * found, not as intended.
 *
 * Never rejects: anything that fails yields the literal string
 * 'Not available', which is what the INFO panel then displays.
 *
 * @returns {Promise<string>} The device id, or 'Not available'.
 */
async function getDUID() {
  try {
    // Method 1: Recommended way - using getCapability for tizenid
    const tizenId = await tizen.systeminfo.getCapability('http://tizen.org/system/tizenid');
    if (tizenId) {
      return tizenId;
    }

    // Method 2: Legacy way - using SystemInfoDeviceCapability
    const systemInfo = tizen.systeminfo.getCapabilities();
    if (systemInfo && systemInfo.duid) {
      return systemInfo.duid;
    }

    throw new Error('No DUID/TizenID methods available');
  } catch (error) {
    return 'Not available';
  }
}

/**
 * Resolves this screen's stable identity and persists it under the
 * `myUUID` localStorage key, so the id survives a reload and a power cut.
 *
 * Order: an id already in localStorage, else Tizen's `tizenid`, else a
 * generated one. Note the loose `uuid == false` guard, which also regenerates
 * for '' and '0' - deliberately left as-is, since neither is a usable id.
 *
 * @returns {Promise<string>} The persisted device identity.
 */
async function getUUID() {
  let uuid;
  uuid = localStorage.getItem('myUUID');
  if (!uuid) {
    try {
      uuid = await tizen.systeminfo.getCapability('http://tizen.org/system/tizenid');
      document.getElementById('device-systeminfo-caps').textContent = uuid;
    } catch (error) {
      uuid = generateUUID();
    }
  }
  if (uuid == false) {
    uuid = generateUUID();
  }
  localStorage.setItem('myUUID', uuid);
  return uuid;
}

/**
 * Renders the pairing QR for this screen, pointing at
 * `/register-device/{uuid}/{model}`. Falls back to a literal 'unknown' model
 * segment when Tizen will not report one, because a QR that pairs without a
 * model beats no QR at all.
 *
 * The `lastGeneratedUrl` guard around the re-render is vestigial: both call
 * sites are in `window.onload`, in a then/catch pair, so this runs exactly
 * once per page load. The guard is still evaluated and always lets that one
 * render through (`null !== qrUrl`); what it can never do is suppress a
 * re-render, because there is never a second one. Left in place rather than
 * removed in a commit about review findings.
 *
 * @returns {Promise<void>}
 */
async function generateQRCode() {
  let qrUrl;
  const qrContainer = document.getElementById('qrcode');
  let uuid = localStorage.getItem('myUUID');
  if (!uuid) {
    uuid = await getUUID();
    checkDevice(uuid);
  }

  try {
    const deviceModel = await getDeviceModel();
    // set text in span id device-model to deviceModel
    document.getElementById('device-model').textContent = deviceModel;
    const safeDeviceModel = encodeURIComponent(deviceModel);
    qrUrl = `${baseUrl}/register-device/${uuid}/${safeDeviceModel}`;
  } catch (error) {
    qrUrl = `${baseUrl}/register-device/${uuid}/unknown`;
  }

  // Check if the QR code needs to be regenerated
  if (lastGeneratedUrl !== qrUrl) {
    qrContainer.innerHTML = ''; // Clear the previous QR code if URL has changed
    new QRCode(qrContainer, {
      text: qrUrl,
      width: qrPixelSize(),
      height: qrPixelSize(),
      colorDark: '#000000',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.H,
    });
    lastGeneratedUrl = qrUrl; // Update the last generated URL
  }
}

/**
 * Promisifies Tizen's callback-style `getPropertyValue('BUILD')` to read the
 * panel's model name.
 *
 * @returns {Promise<string>} The model name. Rejects if the call itself
 * throws - but never settles at all if Tizen's success callback does not
 * fire, or if reading `build.model` throws inside it, since by then the `try`
 * has already returned. `generateQRCode` awaits this, so that case draws no
 * QR at all.
 */
function getDeviceModel() {
  return new Promise((resolve, reject) => {
    try {
      tizen.systeminfo.getPropertyValue('BUILD', function (build) {
        resolve(build.model);
      });
    } catch (e) {
      reject(e);
    }
  });
}

const MediaStorage = {
  STORAGE_KEY: 'digmi_cached_media',
  TTL: 10000, // 10 s, not an hour: a cold-start accelerator, not a change detector

  save: function(uuid, data) {
    const storage = {
      timestamp: Date.now(),
      uuid: uuid,
      data: data
    };
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(storage));
  },

  load: function(uuid) {
    try {
      const storage = JSON.parse(localStorage.getItem(this.STORAGE_KEY));
      if (!storage || storage.uuid !== uuid) return null;

      if (Date.now() - storage.timestamp > this.TTL) {
        this.clear();
        return null;
      }

      return storage.data;
    } catch (error) {
      return null;
    }
  },

  clear: function() {
    localStorage.removeItem(this.STORAGE_KEY);
  }
};

/**
 * Fetches this screen's planned content, displaying any cached payload first,
 * then caching and displaying the fresh one.
 *
 * How much that cache covers is limited: `MediaStorage.TTL` is 10 seconds
 * despite its `1 hours` comment, so after a cold boot `load()` has almost
 * always expired it and returns null. Treat the first display as a bonus, not
 * as cover for a slow network.
 *
 * The return value distinguishes three outcomes the caller has to tell apart:
 * the fresh payload, the cached payload when the request failed, and `null`
 * when it failed with nothing cached. A cached payload is not a promise of
 * anything playable - its `campaign_media` may be empty too. What `null`
 * specifically does NOT mean is "nothing is planned"; an empty
 * `campaign_media` array means that.
 *
 * Schedules no retry of its own; `checkDevice`'s capped backoff owns retrying.
 *
 * @param {string} uuid This screen's device identity.
 * @returns {Promise<object|null>} Fresh payload, cached payload, or null.
 */
async function fetchDeviceMedia(uuid) {
  // Try to load cached media first
  const cachedData = MediaStorage.load(uuid);
  if (cachedData) {
    displayMediaContent(cachedData);
  }

  const url = `${baseUrl}/api/v1/devices/${uuid}`;
  const options = {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: apiAuthorization,
    },
  };

  try {
    const response = await fetch(url, options);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    // The fetch worked, so whatever this function's catch last put on the
    // screen is now stale. Cleared HERE, by the function that wrote it,
    // because the alternative - leaving it to displayMediaContent() - only
    // fires when the payload CHANGED: a blip during a playing campaign,
    // followed by an identical payload, left "Kunde inte hämta innehåll"
    // standing over the customer's content with nothing left to clear it.
    // Before the display call below, so anything that screen decides to say
    // for itself still wins.
    showStatus('');

    // Update device info
    document.getElementById('device-uuid').textContent = uuid;
    if (data.location) {
      document.getElementById('checkdevice-response').textContent = `Connected to ${data.location}`;
    }

    // Cache the new data
    MediaStorage.save(uuid, data);

    // Display new content if it's different from cache
    if (!cachedData || JSON.stringify(cachedData) !== JSON.stringify(data)) {
      displayMediaContent(data);
    }

    return data;
  } catch (error) {
    // Swedish, like the rest of the screen. These strings belong in
    // brand.js with the others, but js/brand.js here is a byte-for-byte copy
    // of DigmiMarketing - adding keys means adding them THERE first, then
    // re-copying. Until then they live here rather than staying English on a
    // screen that is otherwise Swedish.
    showStatus('Kunde inte hämta innehåll: ' + (error && error.message ? error.message : error));

    // If we have cached data, keep using it during error
    if (cachedData) {
      return cachedData;
    }

    // No retry of its own. checkDevice()'s capped backoff is the single retry
    // owner: this used to schedule a 5 s chain here, and now that checkDevice
    // keeps polling on an empty playlist, every failed poll would have stacked
    // another chain on top of the last. Returning null also lets the caller
    // tell a failed fetch apart from a genuinely empty playlist.
    return null;
  }
}

/**
 * Where the slide actually landed, in the panel.
 *
 * A portrait Samsung showed a landscape slide in the bottom-right corner
 * instead of filling the screen (Hair & Co, 2026-09-04) and nothing on the TV
 * could tell us the geometry, so it stayed a guess. Chrome places this element
 * at 0,0 with and without `inset`, so the corner placement is engine-specific
 * and has to be read off the panel that actually shows it.
 */
function updateStageGeometry() {
  const readout = document.getElementById('stage-geometry');
  if (!readout) {
    return;
  }

  const slide = document.querySelector('.media-player video, .media-player img.main-media');
  const viewport = window.innerWidth + 'x' + window.innerHeight;

  // A clip on the video plane has NO element to measure: AVPlay lives outside
  // the DOM, behind the page. Reporting "no slide" for it would be true of
  // the markup and wrong about the screen, on the one panel that exists to
  // tell an engineer what is actually being shown. The rect is not reported
  // because this file no longer chooses one -- it is always the full screen,
  // with setDisplayMethod deciding the letterbox inside it.
  if (window.avplayOnPlane) {
    readout.textContent = 'viewport ' + viewport + ', avplay rect ' + (window.avplayRect || '?') +
      ' (letterboxed), rotation ' + (window.avplayRotation || 'unset') +
      (window.avplayRotationOverride ? ', next: ' + window.avplayRotationOverride : ', next: automatic') +
      ' [5=auto 6=none 7=90 8=180 9=270; cleared when HUD closes]';

    return;
  }

  if (!slide) {
    readout.textContent = 'viewport ' + viewport + ', no slide';

    return;
  }

  const box = slide.getBoundingClientRect();
  readout.textContent = 'viewport ' + viewport +
    ', slide ' + Math.round(box.width) + 'x' + Math.round(box.height) +
    ' at ' + Math.round(box.left) + ',' + Math.round(box.top) +
    ', natural ' + (slide.naturalWidth || slide.videoWidth || '?') +
    'x' + (slide.naturalHeight || slide.videoHeight || '?');
}

/**
 * Everything that makes up the pre-pairing screen, hidden as one unit.
 *
 * One element, not a list of ids. The list form hid exactly the five things
 * that were on the screen the day it was written, so anything added to the
 * screen afterwards stayed on top of the customer's campaign - and the
 * failure is silent, because the campaign does start playing, underneath.
 * #content-reg is the whole activation view, so nothing can be left behind.
 */
function hideRegistrationScreen() {
  const screen = document.getElementById('content-reg');
  if (screen) {
    screen.style.display = 'none';
  }
}

/**
 * Tears the playlist down and forgets it: the timers, the rendered nodes, the
 * globals the remote reads, and the generation every rotation chain is stamped
 * with.
 *
 * One function for all of it because the pieces drifted apart when they were
 * separate. `checkDeviceDataChanges()` cleared `mediaPlayer.innerHTML` and the
 * interval but left `window.displayMedia` and `window.mediaLength` pointing at
 * a playlist that no longer existed, so LEFT/RIGHT on the remote still wrote
 * the previous campaign's name and "(1/2)" into #media-playing-info on a screen
 * playing nothing -- the debug panel lying to whoever is trying to diagnose the
 * screen.
 *
 * Bumping the generation is what actually stops a chain. Clearing the handle is
 * not enough on its own: `startRotationTimer()` registers a `loadedmetadata`
 * listener when a video's duration is not known yet, and that listener builds a
 * fresh interval when it fires -- after this ran, and pause() does not stop
 * metadata loading. Every tick, every continuation and that listener check
 * their captured generation against this counter and return if it moved, so
 * nothing from a torn-down playlist can resurrect itself or outlive it.
 */
function stopPlayback() {
  window.rotationGeneration = (window.rotationGeneration || 0) + 1;

  if (window.rotationInterval) {
    clearInterval(window.rotationInterval);
  }
  window.rotationInterval = null;

  // `displayMedia` null, not just a stale closure: the remote's LEFT/RIGHT
  // handler guards on `window.displayMedia` being truthy, so this is what
  // makes those keys inert instead of rendering into a detached node.
  window.displayMedia = null;
  window.mediaLength = 0;
  window.currentMediaIndex = 0;

  // AVPlay is a SYSTEM resource and lives entirely outside the DOM, so
  // emptying the container below does not touch it. Left running, a stream
  // would keep playing behind the pairing screen -- and a freeze left held
  // would strand a still picture on a panel that has stopped. Before the
  // teardown, because stopAvplayPlayback is defined per playlist and the
  // container is what holds the closure alive.
  if (window.stopAvplayPlayback) {
    window.stopAvplayPlayback(true);
    window.stopAvplayPlayback = null;
    window.avplayDurationMs = null;
    window.avplayNoteSlot = null;
  }

  const campaignContainer = document.getElementById('campaign-container');
  if (campaignContainer) {
    // Pause before detaching. Whether a `display: none` ancestor or a removed
    // node stops the decoder is per-platform and NOT measured on Tizen, so
    // this does not rely on either: an unpaired panel can sit for days.
    const videos = campaignContainer.querySelectorAll('video');
    for (let i = 0; i < videos.length; i++) {
      videos[i].pause();
    }
    campaignContainer.innerHTML = '';
  }

  const playingInfo = document.getElementById('media-playing-info');
  if (playingInfo) {
    playingInfo.textContent = '';
  }
}

/**
 * Whether a non-empty playlist is on screen right now.
 *
 * Derived from the globals rather than kept as its own flag, because a flag
 * desynced: `checkDeviceDataChanges()` empties the playlist when a campaign is
 * unplanned and sets `mediaLength` to 0, but it cannot reach a local in
 * checkDevice -- so a flag stayed true, the media branch stayed skipped, and
 * nothing ever looked for content again. That is the Hair & Co state reached
 * through the commonest door of all: a campaign unplanned on a screen that was
 * already playing it.
 *
 * A LIVE rotation is part of it, not just a non-empty playlist. Slides that
 * have stopped advancing are not "on screen" in any sense this gate cares
 * about, and treating them as such is what made a stalled chain permanent:
 * the gate kept checkDevice from re-fetching the very content that would have
 * rebuilt the chain. Measured: pressing LEFT/RIGHT on the remote clears the
 * rotation without restarting it, and the screen then sat on one slide with
 * zero content polls for as long as it was watched. With the rotation in the
 * gate, the next pairing poll re-fetches and the playlist resumes within the
 * backoff instead of never.
 */
function playlistIsOnScreen() {
  return typeof window.mediaLength === 'number'
    && window.mediaLength > 0
    && window.rotationInterval !== null
    && window.rotationInterval !== undefined;
}

/**
 * The screen's language, re-resolved rather than remembered.
 *
 * window.onload resolves it from the same two inputs and keeps no copy of it.
 * resolveLanguage() is pure, so asking again gives the same answer without
 * adding a global.
 *
 * The Swedish fallback is belt-and-braces and not reached from the caller
 * below, which has already returned if the brand layer is absent. It would
 * take a DigmiBrand carrying `t` but not `resolveLanguage`, which the
 * module's own export literal rules out - and `t()` falls back to the Swedish
 * table anyway.
 *
 * @returns {string} One of the brand layer's language codes.
 */
function currentLanguage() {
  if (!window.DigmiBrand || typeof window.DigmiBrand.resolveLanguage !== 'function') {
    return 'sv';
  }

  return window.DigmiBrand.resolveLanguage(window.location.search, navigator.language);
}

/**
 * Whether a QR code is the right answer to this `verify-device` reply.
 *
 * `device_exists: false` covers both a screen nobody has paired and one whose
 * account the portal has switched off, and scanning a code only helps with
 * the first. The portal now says which through `reason`
 * (digmi-web-admin#1649), where `unknown` is the one value meaning "nobody
 * has paired this".
 *
 * Anything that is not a definite other reason keeps the QR: a portal from
 * before the field sends no `reason` at all, and the QR was the only
 * behaviour there was. Any OTHER non-empty string hides it - not just the
 * `switched-off` this widget can see today. It sends no bearer to
 * verify-device (see `apiAuthorization`), so the portal withholds which
 * switch-off it was; should that change, `suspended` and the two billing
 * reasons arrive here instead, and a code helps with none of them.
 *
 * @param {unknown} reason The payload's `reason`, in whatever shape it arrived.
 * @returns {boolean} True when the activation view should show its QR code.
 */
function pairingWouldHelp(reason) {
  if (typeof reason !== 'string' || reason === '') {
    return true;
  }

  return reason === 'unknown';
}

/**
 * Points the activation view at either its pairing face or its switched-off
 * face, and hides the QR code for the latter.
 *
 * Both faces keep the help line with the phone number and the support URL. On
 * a switched-off screen that is the only thing on the page that leads
 * anywhere, and it is the one thing the salon actually needs.
 *
 * Re-run on every poll that reaches showRegistrationScreen(), and reversible
 * on purpose. Not because a resumed account comes back through here - that
 * one answers `device_exists: true` and never reaches this function at all -
 * but because a screen can be switched off and THEN deleted in the portal,
 * which answers `unknown`. The QR has to come back for that without anyone
 * power-cycling the panel.
 *
 * @param {unknown} reason The payload's `reason`, passed straight through.
 */
function renderActivationCopy(reason) {
  // Without the brand layer there are no strings to swap in, and half a
  // switch - the QR hidden with "Aktivera skärmen" still written above the
  // gap - reads worse than today's behaviour. Leave the view as the markup
  // has it. t() returns the KEY for anything it cannot find, so a missing
  // layer would otherwise write `off.title` across the screen.
  if (!window.DigmiBrand || typeof window.DigmiBrand.t !== 'function') {
    return;
  }

  const pairing = pairingWouldHelp(reason);
  const lang = currentLanguage();

  // The `hidden` attribute, like every other toggle on this page
  // (brand.js setHidden, the [data-box-only] pair). It beats
  // .digmi-qr-column's `display: flex` not by luck but because brand.css
  // carries an author rule for exactly this - `.digmi-page [hidden]`,
  // specificity (0,2,0) against (0,1,0) - put there with a comment saying
  // why. That makes it deterministic in the Chrome 63 the panels run, not
  // only in a desktop browser.
  const qrColumn = document.getElementById('reg-qr-column');
  const stage = document.getElementById('reg-stage');

  // The whole face or none of it. Hiding the column without collapsing the
  // stage is the unreadable state measured below, and a renamed id in the
  // markup is all it would take to arrive there silently. Returning leaves
  // every part of the view as the markup has it, which is the pairing face:
  // the wrong face for a switched-off screen, but a legible one, and that is
  // the better of the two failures. Swapping only the text would read as a
  // screen that says it shows nothing while offering a code that cannot help.
  if (!qrColumn || !stage) {
    return;
  }

  qrColumn.hidden = !pairing;

  // Taking the QR column out of the layout is not enough on its own. In
  // landscape brand.css gives .digmi-stage `grid-template-columns: auto
  // minmax(0, 1fr)`, and .digmi-copy is a `container-type: inline-size`
  // container with no intrinsic width - the trap brand.css spells out at the
  // .digmi-copy rule. The copy then sits alone in the `auto` track, which
  // sizes to nothing, and the `cqi` caps on .digmi-title and .digmi-lead take
  // the text down with it. Measured at 1920x1080: the copy column 616px ->
  // 60px, #reg-title 77.45px -> 7.51px, #reg-lead 25.86px -> 2.50px. The
  // message this function exists to show, rendered unreadable.
  //
  // One track restores it, and `minmax(0, 1fr)` is the value brand.css already
  // uses in portrait - one declaration out of that rule, not the rule: the
  // landscape switched-off face stays left-aligned with its `margin-left:
  // 6vmin` and does not pick up portrait's centring. Set from here rather
  // than added to brand.css because
  // that file is byte-identical to DigmiMarketing's copy (verified by
  // sha256), and a rule added on one side only would drift the two screens
  // apart.
  stage.style.gridTemplateColumns = pairing ? '' : 'minmax(0, 1fr)';

  setBrandText('reg-title', lang, pairing ? 'reg.title.generic' : 'off.title');
  setBrandText('reg-title-em', lang, pairing ? 'reg.title_em.generic' : 'off.title_em');
  setBrandText('reg-lead', lang, pairing ? 'reg.body' : 'off.body');
}

/**
 * Writes one translated string into one element by id, and does nothing at all
 * if that element is not on the page.
 *
 * @param {string} id The element's id.
 * @param {string} lang The language code to translate into.
 * @param {string} key The brand layer's message key.
 */
function setBrandText(id, lang, key) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = window.DigmiBrand.t(lang, key);
  }
}

/**
 * Brings the pre-pairing screen back and takes the campaign container down
 * with it.
 *
 * Clears the inline `display` rather than setting a value, so the layout comes
 * from the stylesheet and this function does not have to know which one.
 *
 * Hiding the container matters as much as showing the view: media from a
 * pairing that no longer exists would otherwise keep playing behind the
 * activation screen. stopPlayback() is what makes that true - hiding alone
 * leaves the rotation chain rendering and still polling /api/v1/devices for a
 * pairing that is gone.
 */
function showRegistrationScreen(reason) {
  const screen = document.getElementById('content-reg');
  if (screen) {
    screen.style.display = '';
  }

  const campaignContainer = document.getElementById('campaign-container');
  if (campaignContainer) {
    campaignContainer.style.display = 'none';
  }

  // No ordering subtlety here - this whole function is one synchronous block,
  // so nothing is painted between the display reset above and this call.
  //
  // What DOES show the wrong face is a cold start or a RETURN reload:
  // the markup carries the pairing face, so a switched-off screen shows the
  // QR code until the first verify-device answer lands, and keeps showing it
  // for as long as that answer does not come. That is inherent - the screen
  // cannot know before it asks.
  renderActivationCopy(reason);

  stopPlayback();
}

/**
 * One place for anything this screen needs to be able to tell a human. Writes
 * to the on-screen status line and to the device panel, so the message is
 * readable both from across the salon and with the panel open.
 */
function showStatus(text) {
  const debugLine = document.getElementById('checkdevice-response');
  if (debugLine) {
    debugLine.textContent = text;
  }

  const statusLine = document.getElementById('status-line');
  if (statusLine) {
    statusLine.textContent = text;
    // 'flex', not 'block'. #status-line is a .digmi-chip, which brand.css
    // lays out as flex; an inline `display: block` beats the stylesheet and
    // turns the chip's ::before dot into an inline box with no width or
    // height, so the dot silently disappears - measured, the text shifts
    // 15px left and nothing is drawn.
    statusLine.style.display = text ? 'flex' : 'none';
  }
}

/**
 * Replaces the contents of `#campaign-container` with the payload's media and
 * starts the rotation timer, hiding the pairing screen first.
 *
 * Does nothing at all when `campaign_media` is absent or empty, which is why
 * the caller - not this function - is responsible for saying so on screen.
 *
 * @param {object} data A device payload with a `campaign_media` array.
 */
/**
 * How close to the end of a slot a completed stream stops looping itself.
 *
 * The slot is usually set from the clip's own duration, so the stream ending
 * and the rotation timer firing are the same moment give or take scheduling
 * jitter. Within this window the timer is trusted to advance the playlist,
 * and the loop stands down rather than paying for a second seam.
 */
const LOOP_GRACE_MS = 400;

/**
 * How long the playlist-change poll may hang before the rotation gives up on
 * it. Generous: the poll is a nicety, and the screen keeps rotating without
 * it. What it must not do is hold the render path open indefinitely.
 */
const DEVICE_POLL_TIMEOUT_MS = 15000;

/**
 * A clock that does not step. The loop gate compares against a 400 ms window,
 * and an NTP correction after boot routinely moves the wall clock by more
 * than that. The probe used a monotonic clock for the same reason.
 */
function monotonicNow() {
  return window.performance && typeof window.performance.now === 'function'
    ? window.performance.now()
    : Date.now();
}

/**
 * The one AVPlay wrapper for this page, and the per-playlist hooks it calls.
 *
 * Rule 1 says the panel hands out ONE player, and the panel's mute is just as
 * singular: it belongs to the TV, not to a playlist. A wrapper built per
 * playlist remembered "how we found the mute" per playlist, so the second
 * playlist read back OUR OWN mute, recorded it as the panel's own setting,
 * and then refused to undo it -- a customer's TV silent on every input until
 * somebody finds the remote. Measured in a test, not reasoned about.
 *
 * So the wrapper lives as long as the page. The hooks are what changes with
 * each playlist, and they are read through this object at call time rather
 * than captured, so a torn-down playlist cannot answer for a live one.
 */
let sharedAvplay = null;
const avplayHooks = { onStreamCompleted: null, onError: null };

/** The page's AVPlay wrapper, built on first use. Null where AVPlay is not. */
function getSharedAvplay() {
  if (sharedAvplay) {
    return sharedAvplay;
  }
  if (!window.DigmiAvplay || !window.DigmiAvplay.isAvailable()) {
    return null;
  }
  sharedAvplay = window.DigmiAvplay.createPlayer({
    log: (line) => console.log('[avplay] ' + line),
    rotation: () => window.avplayRotationOverride || null,
    // Measured on the bench, never derived. null until a portrait panel that
    // reports angle 0 (or no orientation API) has been seen and turned by
    // hand; the QB43C reports its angle and needs none.
    portraitFallback: null,
    onRotation: (value, source, state, rect) => {
      window.avplayRotation = value + ' (' + source + ', ' + state + ')';
      window.avplayRect = rect
        ? rect.width + 'x' + rect.height + ' at ' + rect.x + ',' + rect.y + ' (' + rect.state + ')'
        : '?';
    },
    onStreamCompleted: () => {
      if (avplayHooks.onStreamCompleted) {
        avplayHooks.onStreamCompleted();
      }
    },
    onError: (type) => {
      if (avplayHooks.onError) {
        avplayHooks.onError(type);
      }
    },
  });
  return sharedAvplay;
}

/**
 * Hand the player back to the system and forget it.
 *
 * Only on a real teardown -- unpairing, or the reload the RETURN key does.
 * A playlist being replaced calls stop(), not this: close() would make the
 * next playlist ask for a fresh instance, and it would also hand the mute
 * back and take it again a moment later.
 */
function closeSharedAvplay() {
  avplayHooks.onStreamCompleted = null;
  avplayHooks.onError = null;
  // A bench override must not outlive the player it was measured on.
  window.avplayRotationOverride = null;
  if (sharedAvplay) {
    sharedAvplay.close();
    sharedAvplay = null;
  }
}

function displayMediaContent(data) {
  if (data.campaign_media && data.campaign_media.length > 0) {
    const campaignContainer = document.getElementById('campaign-container');

    hideRegistrationScreen();
    showStatus('');

    // Show campaign container
    if (campaignContainer) {
      campaignContainer.style.display = 'block';
      campaignContainer.innerHTML = ''; // Clear existing content

      // Create media player container
      const mediaPlayer = document.createElement('div');
      mediaPlayer.className = 'media-player';

      // Make these available globally for keyboard navigation
      window.currentMediaIndex = 0;
      window.mediaLength = data.campaign_media.length;

      // CLEAR before dropping the handle. This used to assign null straight
      // over a live interval id, which made that chain unreachable forever:
      // nothing else holds the handle, so every later clearInterval - here, in
      // checkDeviceDataChanges(), in stopPlayback() - looked at the global and
      // saw only the newest chain. Two renders in a row therefore left an
      // immortal interval behind, ticking against the previous playlist's
      // length while window.displayMedia pointed at the new, shorter one:
      // campaign_media[4] of a 2-item playlist is undefined, and displayMedia
      // empties the stage BEFORE it reads `.video`, so the throw landed after
      // the screen went black and before any clearInterval. One orphan per
      // unpair/re-pair cycle.
      clearInterval(window.rotationInterval);
      window.rotationInterval = null;

      // Stamp this playlist. Every tick, continuation and `loadedmetadata`
      // listener below captures it and bails if the counter has moved on, so a
      // torn-down playlist cannot rebuild its own interval behind the live one.
      window.rotationGeneration = (window.rotationGeneration || 0) + 1;
      const generation = window.rotationGeneration;
      const isCurrentGeneration = () => generation === window.rotationGeneration;

      // What is on the plane right now, so a seam knows what it is leaving.
      // 'none' until the first item renders. Reset with the playlist, not
      // with the generation: a new playlist starts from a blank stage.
      let onScreenKind = 'none';
      // Guards the asynchronous half of a render. An image has to be DECODED
      // before the stage is swapped, and two renders can overlap across that
      // await -- a rotation tick landing on a remote key press, say. The
      // later render wins and the earlier one must not paint over it.
      let renderToken = 0;

      /**
       * The AVPlay-backed player, or null when this runtime has no AVPlay
       * (a browser, or a panel that refused it). Built once per playlist.
       *
       * Falling back is permanent for the playlist rather than per item: a
       * panel that cannot open one clip will not open the next either, and
       * flipping between two playback engines mid-rotation is its own class
       * of fault.
       */
      // A second playlist must not abandon the first one's player. AVPlay is
      // a system resource outside the DOM, so emptying the container does not
      // touch it: the old stream would keep playing -- audibly -- behind the
      // new one, and a held freeze would strand a still picture. The hook is
      // overwritten a few lines below, so this is the last moment it exists.
      if (window.stopAvplayPlayback) {
        window.stopAvplayPlayback();
      }

      // Captured, unlike the hooks, which are read at call time. The
      // asymmetry is deliberate but it rests on an invariant worth stating:
      // after closeSharedAvplay() this reference points at a wrapper whose
      // player is null, and a play() through it would acquire a fresh native
      // instance that nothing tracks and nothing can close -- the leak that
      // close() exists to prevent, through a side door.
      //
      // What keeps it shut is that closeSharedAvplay() is only reached from
      // stopPlayback(), which nulls window.displayMedia first, and from
      // showReloadModal(), where the close and the reload are adjacent
      // statements. No playlist is alive to call through this afterwards.
      // Break either of those and this has to become getSharedAvplay() at
      // each use.
      const avplay = getSharedAvplay();
      let avplayFailed = false;
      // The slot the rotation timer is currently counting down, so a stream
      // that completes at the very end of its slot does not restart itself a
      // few milliseconds before the timer advances the playlist -- which
      // would be two full stop/open/prepare/play seams back to back.
      let slotEndsAt = 0;
      let loopsDisabledUntilNextPlay = false;
      let avplayDurationMs = null;
      // Whether AVPlay currently holds the video plane. Not the same question
      // as "was the previous item a video": two images in quick succession
      // used to leave the plane held, because the FIRST image's deferred stop
      // was skipped by the render guard while the SECOND saw the previous
      // item as an image and scheduled nothing. Tracking the plane itself
      // makes the second image take the job over.
      let planeHeld = false;
      if (avplay) {
        Object.assign(avplayHooks, {
          onStreamCompleted: () => {
            // Loop the current clip, matching what `<video loop>` did before:
            // an ended stream is black, so the plane must never be left
            // showing one.
            //
            // But NOT when the rotation timer is about to advance anyway. The
            // slot is usually set from this very clip's duration, so both
            // fall due in the same instant and the order between them is
            // undefined -- loop first and the panel pays for two complete
            // stop/open/prepare/play seams, back to back, every single lap.
            if (!isCurrentGeneration() || loopsDisabledUntilNextPlay) {
              return;
            }
            if (slotEndsAt && monotonicNow() > slotEndsAt - LOOP_GRACE_MS) {
              // Standing down is not the same as doing nothing. The stream
              // has ended and the rotation tick may be milliseconds away or,
              // on the last item of a playlist, a whole network round trip
              // away -- checkDeviceDataChanges() runs a fetch with no timeout
              // before the next render. Freeze the plane so it holds the last
              // frame for however long that takes; play() releases it between
              // prepare and play, and avplay.stop() releases it if an image
              // comes next, so no path leaves it held.
              //
              // This is also what the probe did: it set the still AT
              // onstreamcompleted, not on a timer.
              avplay.freeze();
              return;
            }
            const item = data.campaign_media[window.currentMediaIndex];
            if (item && item.video) {
              window.displayMedia(window.currentMediaIndex);
            }
          },
          onError: () => {
            // Reported, not acted on: the rotation timer will move off this
            // item by itself, and tearing the stage down here would turn one
            // bad clip into a black screen. The loop stands down though --
            // a surviving listener re-rendering the item would restart it
            // from zero in the middle of its slot.
            avplayFailed = true;
            loopsDisabledUntilNextPlay = true;
          },
        });
      }

      /** Everything on the stage, removed. */
      function clearStage() {
        mediaPlayer.innerHTML = '';
      }

      /**
       * Let the video plane through the page, or close it off again.
       *
       * The page paints its own opaque background colour, and AVPlay is
       * behind the page -- so with the colour in place the panel shows dark
       * grey and no video, which reads as a broken screen rather than a
       * styling choice. Switched off again for stills and for the pairing
       * view, where a transparent page would show whatever the plane last
       * held.
       *
       * @param {boolean} open
       */
      function setPlaneVisible(open) {
        const root = document.documentElement;
        if (!root || !root.classList) {
          return;
        }
        if (open) {
          root.classList.add('avplay-video');
          window.avplayOnPlane = true;
        } else {
          root.classList.remove('avplay-video');
          // Cleared with the plane, so the debug panel cannot keep claiming a
          // clip is on the video plane after it stopped.
          window.avplayOnPlane = false;
        }
      }

      /**
       * Take the still down once the new stream's clock has moved.
       *
       * The probe's watchStart(), ported: poll getCurrentTime() every 16 ms,
       * remember the first reading as the base, and when the clock is more
       * than 150 ms past it the picture is live -- hold the cover 250 ms
       * more (an engine can report a clock a frame before it paints), then
       * clear the stage. Numbers are the probe's, measured; not retuned.
       *
       * The deadline is the one case a cover must NOT win: a clock that never
       * moves is a dead plane, and a still that hides it forever is a screen
       * nobody knows is broken. After 5 s the still comes down and the log
       * says so. The error path does not come here: a refused play() falls
       * to the <video> branch, which clears the stage itself.
       *
       * Guarded on the render token and the generation on every tick, so a
       * newer render or a teardown owns the stage from then on.
       */
      function dropStillWhenClockMoves(token) {
        const gate = window.DigmiAvplay.coverGate();
        const since = monotonicNow();
        const drop = () => {
          if (token !== renderToken || !isCurrentGeneration()) {
            return;
          }
          // Same paint: the page goes transparent as the still goes away.
          setPlaneVisible(true);
          clearStage();
          updateStageGeometry();
        };
        const poll = setInterval(() => {
          if (token !== renderToken || !isCurrentGeneration()) {
            clearInterval(poll);
            return;
          }
          // One read per tick. A clock that throws is reported by attempt()
          // once and then answers null, which the gate turns into a drop after
          // the hold -- so a missing clock costs one log line, not three
          // hundred, and not five seconds of hidden video per seam.
          const decision = gate.tick(avplay.currentTime(), monotonicNow() - since);
          if (decision === 'wait') {
            return;
          }
          clearInterval(poll);
          if (decision === 'drop-now') {
            console.log('[avplay] no picture within the deadline: dropping the still over a plane that never moved');
            drop();
            return;
          }
          setTimeout(drop, gate.holdMs);
        }, 16);
      }

      /** Two frames, so the browser has actually painted before we continue. */
      function afterPaint() {
        return new Promise((resolve) => {
          if (window.requestAnimationFrame) {
            requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)));
          } else {
            setTimeout(resolve, 32);
          }
        });
      }

      /**
       * An image that is decoded and ready to paint opaquely.
       *
       * `decode()` matters: an <img> that has merely been given a src is
       * transparent until the decode finishes, and on a 1080p JPEG that is
       * long enough to show the plane -- or black -- through it. Measured on
       * the bench as black between two stills while two videos were clean.
       *
       * A decode failure resolves rather than rejects: a missing image should
       * cost one blank slide, not the rotation.
       *
       * @param {string} src
       * @param {string} className
       * @returns {Promise<HTMLImageElement>}
       */
      function decodedImage(src, className) {
        const img = document.createElement('img');
        img.className = className;
        img.src = src;
        if (typeof img.decode !== 'function') {
          return Promise.resolve(img);
        }
        return img.decode().then(
          () => img,
          () => img,
        );
      }

      // Make displayMedia available globally
      window.displayMedia = function(index) {
        window.currentMediaIndex = index;
        const mediaItem = data.campaign_media[index];
        if (!mediaItem) {
          return;
        }
        const mine = ++renderToken;
        // Per render, before anything can return early. Left standing, the
        // previous clip's slot end sits in the past and the loop gate below
        // reads it as "the timer is about to advance anyway" for the whole of
        // the next clip. Walking that path gives a 10 s video holding a dead
        // plane for 20 s behind a 30 s slot -- derived from the code, not
        // seen on a panel.
        slotEndsAt = 0;
        const isVideo = !!mediaItem.video;
        const fullsize = mediaItem.fullsize_url || mediaItem.fullsize;
        // The blurred backdrop behind the slide. It is NOT one source for both
        // kinds, and collapsing it into one was a regression shipped in 1.0.13:
        //
        //   a video -> the thumbnail, because the fullsize is the clip itself
        //   an image -> the fullsize, the very picture shown in front of it
        //
        // A thumbnail is small and often cropped to a different aspect ratio,
        // so `object-fit: cover` across a 1080x1920 panel lands it at a
        // different scale AND a different crop than the `contain`-fitted slide
        // in front. During the fade the slide is translucent, so both are
        // visible at once -- on a text-heavy slide that reads as the same
        // heading printed twice in two sizes. Filmed on the bench 2026-11-10;
        // the version in the field, which uses the fullsize, does not do it.
        const poster = isVideo
          ? (mediaItem.thumbnail_url || mediaItem.thumbnail)
          : fullsize;
        const useAvplay = !!avplay && !avplayFailed;
        // Keyed on whether AVPlay is actually driving, not merely present.
        // On the <video> path there is no video plane, so the plan carries no
        // freeze and nothing to cover. (The fade this once protected is gone
        // from the image path; see the className note below.)
        const seam = useAvplay
          ? window.DigmiAvplay.seamPlan(onScreenKind, isVideo ? 'video' : 'image')
          : { freeze: false, coverMustBePainted: false };

        /** The caption, which is independent of how the media is rendered. */
        function updateCaption() {
          if (mediaItem.campaign_name || mediaItem.campaignName) {
            const mediaPlayingInfoElement = document.getElementById('media-playing-info');
            if (mediaPlayingInfoElement) {
              mediaPlayingInfoElement.textContent = `${mediaItem.campaign_name || mediaItem.campaignName} (${index + 1}/${data.campaign_media.length}) - ${mediaItem.media_name || mediaItem.name}`;
            }
          }
        }

        if (useAvplay && isVideo) {
          // Freeze BEFORE the stage is touched. The frozen frame is what the
          // viewer sees for the length of stop/open/prepare, and the player
          // releases it between prepare() and play().
          if (seam.freeze) {
            avplay.freeze();
          }
          // A still on the stage is NOT cleared here. It is the cover: the
          // page is opaque under it, so open/prepare/play happen behind it,
          // and it comes down only once the new stream's clock has actually
          // moved (the probe's startBehindCard). Clearing first showed the
          // page's dark background until the first frame -- black at every
          // image->video seam on the bench, 2026-11-10. Video->video has no
          // still to keep, and the freeze covers that seam.
          const stillCovers = onScreenKind === 'image';
          if (!stillCovers) {
            clearStage();
          }
          const result = avplay.play(fullsize, {
            width: window.innerWidth,
            height: window.innerHeight,
          });
          if (!result.ok) {
            // One failed open should not blank the screen for good. Drop to
            // the <video> path for the rest of this playlist.
            avplayFailed = true;
            console.log('[avplay] falling back to <video>: ' + avplay.lastError());
          } else {
            // No blurred backdrop behind an AVPlay clip: behind the video is
            // in FRONT of it, and the margins belong to
            // setDisplayMethod(LETTER_BOX) instead. Deliberate, and visible.
            avplayDurationMs = result.durationMs;
            planeHeld = true;
            loopsDisabledUntilNextPlay = false;
            // With a still covering, the page stays OPAQUE until the still
            // comes down: the blurred backdrop has soft edges, and a
            // transparent page under it would show the plane through them.
            // The drop makes the page transparent and empties the stage in
            // the same paint, revealing a plane that is already live.
            if (stillCovers) {
              dropStillWhenClockMoves(mine);
            } else {
              setPlaneVisible(true);
            }
            // The Stage readout is the line a bench reads to see which
            // rotation and rect THIS clip got (onRotation has already run
            // inside play()). Nothing else refreshes it on a clip start, so
            // with the HUD open it kept showing the previous clip's values
            // until an image or a key press came along -- stale in exactly
            // the measurement it exists for.
            updateStageGeometry();
            onScreenKind = 'video';
            updateCaption();
            return;
          }
        }

        if (isVideo) {
          // No AVPlay: the original path, seams and all. A browser, or a
          // panel that refused the player.
          clearStage();
          if (poster) {
            const backgroundImg = document.createElement('img');
            backgroundImg.className = 'background';
            backgroundImg.src = poster;
            mediaPlayer.appendChild(backgroundImg);
          }
          const video = document.createElement('video');
          video.className = 'video fade-in';
          video.src = fullsize;
          video.autoplay = true;
          video.loop = true;
          video.muted = true;
          video.playsInline = true;
          mediaPlayer.appendChild(video);
          setPlaneVisible(false);
          onScreenKind = 'video';
          updateCaption();
          return;
        }

        // An image. Decode first, swap second: the stage is not touched until
        // there is something opaque to put on it.
        //
        // No `fade-in`, ever, on this path. The version in the field has the
        // class, but there it is applied to an <img> that is appended BEFORE it
        // has loaded, so the 0.5 s animation runs on an empty box and the
        // picture arrives opaque once the bytes do: the fade is never seen.
        // Decoding first moves the insertion to AFTER the bytes, so the same
        // class fades a finished picture -- and for that half second the slide
        // is translucent over its own blurred `object-fit: cover` backdrop,
        // which sits at a different scale and crop. On a text slide that reads
        // as the heading printed twice. Filmed on the bench 2026-11-10
        // (IMG_4494/4495); the field build, same CSS, does not show it. The
        // decoded swap is already instantaneous, which is the effect the fade
        // was there to soften.
        const className = 'main-media';
        // Rule 1, before anything asynchronous: the decode below takes
        // hundreds of milliseconds, and a stream that ends inside that window
        // leaves a black plane behind a transparent page. Freezing here holds
        // the last frame until the image is painted over it, whatever the
        // stream does meanwhile. stop() under the cover releases it.
        if (useAvplay && seam.freeze && planeHeld) {
          avplay.freeze();
        }
        Promise.all([
          decodedImage(fullsize, className),
          poster ? decodedImage(poster, 'background') : Promise.resolve(null),
        ]).then(([main, background]) => {
          if (mine !== renderToken || !isCurrentGeneration()) {
            return; // a later render, or a teardown, took over during the decode
          }
          clearStage();
          if (background) {
            mediaPlayer.appendChild(background);
          }
          mediaPlayer.appendChild(main);
          // In the same paint as the image itself. Restoring the colour makes
          // the page opaque again, which covers the plane a moment before
          // avplay.stop() tears it down -- the cover arriving early rather
          // than late.
          setPlaneVisible(false);
          onScreenKind = 'image';
          updateCaption();

          if (useAvplay && planeHeld) {
            // The image is on the stage but not yet on the glass. Stopping
            // the player before it has been painted would show the teardown
            // through a transparent layer -- rule 3 on the bench, and the
            // reason this waits two frames rather than calling stop() here.
            afterPaint().then(() => {
              // Still guarded: a NEWER render that is a video has already
              // taken the plane through its own stop/open/prepare/play, and
              // stopping here would kill it. A newer render that is an image
              // leaves `planeHeld` true and schedules this itself, which is
              // what keeps the plane from being left held.
              if (mine === renderToken && planeHeld) {
                // Cleared after the call, like release() and restoreAudio().
                // stop() swallows a throw, and a flag that says the plane is
                // free while it is not is a state nothing comes back from.
                avplay.stop();
                planeHeld = false;
              }
            });
          }
        });
      };

      // A playlist being replaced must not leave a stream running behind the
      // next one, nor a frozen frame on a screen that stopped playing.
      window.stopAvplayPlayback = function(andClose) {
        loopsDisabledUntilNextPlay = true;
        slotEndsAt = 0;
        avplayDurationMs = null;
        planeHeld = false;
        if (andClose) {
          // Hands the instance back to the system. Without it the player
          // stays allocated to a page that is going away, and the next
          // getPlayer() answers QuotaExceededError until the panel restarts.
          closeSharedAvplay();
        } else if (avplay) {
          avplay.stop();
        }
        setPlaneVisible(false);
        onScreenKind = 'none';
      };

      /**
       * The current clip's length, as read when it was prepared.
       *
       * Not a live getDuration(): the probe measured that the player's clock
       * does not necessarily belong to the new stream straight after a seam,
       * and a stale length here sets the slot for the WRONG clip -- a 10 s
       * advert held for 60 s, or a 60 s one cut at 10. Nothing is black, so
       * nobody would look.
       */
      window.avplayDurationMs = function() {
        return avplayFailed ? null : avplayDurationMs;
      };

      /** Told by the rotation timer, so the loop above can stand down. */
      window.avplayNoteSlot = function(endsAt) {
        slotEndsAt = endsAt;
      };

      // Initial display
      window.displayMedia(0);
      updateStageGeometry();

      // Function to check for device data changes and handle accordingly
      /**
       * Polls the device endpoint for a changed playlist.
       *
       * ⚠️ This sits ON the render path: on the LAST item of a playlist the
       * rotation tick calls this and only renders the next item from its
       * `.then`/`.catch`. A request that hangs therefore holds the screen on
       * whatever is up -- and on a single-video playlist every item is the
       * last one, so it happens every lap.
       *
       * Before AVPlay that meant a dead `<video>`; now it means a frozen last
       * frame, which looks healthier and is therefore worse to diagnose. The
       * deadline below is what bounds it: an unanswered request fails after
       * DEVICE_POLL_TIMEOUT_MS and the rotation carries on, rather than
       * waiting out a TCP stack that may never give up on a Wi-Fi that drops
       * packets without a reset.
       *
       * Aborting is not a lost poll: the next lap asks again.
       *
       * ⚠️ Best effort. `AbortController` arrived in Chrome 66 and this
       * widget's floor is Tizen 5.0 (M63), so on a panel older than roughly
       * Tizen 6 there is NO deadline and the behaviour is the old unbounded
       * one. The served model groups are Tizen 8.0, so in practice the
       * deadline is there -- but the sideload channel reaches further back.
       *
       * Why a deadline and not "render first, then poll": in the changed
       * case this function OWNS the render. It calls displayMedia(0) and
       * startRotationTimer() itself and returns `true` to say so. Rendering
       * before it would therefore render twice whenever the playlist had
       * changed -- which under AVPlay is a double seam, the very thing
       * LOOP_GRACE_MS exists to avoid. Reordering means rebuilding that
       * branch, in a function with nine documented continuation hazards.
       */
      function checkDeviceDataChanges() {
        return getUUID().then(uuid => {
          const url = `${baseUrl}/api/v1/devices/${uuid}`;
          const controller =
            typeof AbortController === 'function' ? new AbortController() : null;
          const options = {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              Authorization: apiAuthorization,
            },
          };
          if (controller) {
            options.signal = controller.signal;
          }
          // Cleared on both settle paths below, so a completed request does
          // not leave a timer that aborts the NEXT one.
          const deadline = controller
            ? setTimeout(() => controller.abort(), DEVICE_POLL_TIMEOUT_MS)
            : null;
          const clearDeadline = (value) => {
            if (deadline !== null) {
              clearTimeout(deadline);
            }
            return value;
          };

          return fetch(url, options)
            .then(response => {
              if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
              }
              return response.json();
            })
            // AFTER the body, not after the headers. `fetch` settles as soon
            // as the response header arrives, so clearing there leaves a
            // connection that delivers the header and then stalls mid-body
            // with nothing to abort -- the same unbounded hold, through a
            // narrower door. abort() cancels a body read in progress too, so
            // waiting costs nothing.
            .then(clearDeadline, (error) => {
              clearDeadline();
              throw error;
            })
            .then(currentData => {
              // The NINTH continuation, and the last one. This handler runs
              // after a network round trip too, and its change branch is its
              // own hazard: it clears and nulls `window.rotationInterval`
              // (which by then holds the CURRENT generation's handle) and then
              // calls window.displayMedia(0) + startRotationTimer() out of a
              // stale closure, where the guard returns early. The pattern
              // continueRotation() replaced is not present here -- the clear
              // sits 27 lines above the render -- which is exactly why
              // searching for that pattern missed it.
              //
              // `return true`, not false: false means "nothing changed, carry
              // on rotating" to the caller, and a stale generation must not say
              // that about a playlist it no longer owns.
              //
              // Measured before this guard: an unpairing while this request was
              // in flight, with the cache expired so the change branch ran,
              // left `rotationInterval` null on a live generation and stalled
              // the screen for 8.6 s - and up to the 30 s backoff cap on a
              // screen that had been paired for hours - before the
              // rotation-liveness gate re-fetched and rebuilt the chain. Bounded
              // and self-healing, because of that gate, but the campaign also
              // jumped back to slide 1. And this branch is the NORMAL case in
              // production, not the rare one: MediaStorage.TTL is 10 s while
              // real slides are 10 s+, so the cache has almost always expired
              // by the time this resolves.
              if (!isCurrentGeneration()) {
                return true;
              }

              // Compared against what is ON SCREEN -- this closure's `data`,
              // which the branch below mutates in place -- and not against
              // MediaStorage. That cache has a 10 s TTL while slides are
              // 10 s or longer, so by the time this resolved it had almost
              // always expired and answered null, which read as "changed":
              // every lap re-rendered slide 0 from scratch and reset the
              // index, and a one-picture campaign went the whole
              // decode-and-swap every slot. The single-image guard in
              // continueRotation() was never even consulted at the default
              // 15 s; a reviewer's simulation put 10 of 10 laps through this
              // branch. Only what the branch applies is compared: the media
              // list, and the location when the server sends one.
              const fetchedMedia = currentData.campaign_media || [];
              const mediaChanged = JSON.stringify(data.campaign_media) !== JSON.stringify(fetchedMedia);
              const locationChanged = !!currentData.location && currentData.location !== data.location;

              if (mediaChanged || locationChanged) {
                // `|| []`, because the line below reads `.length` off this.
                // A 200 without `campaign_media` threw here -- BEFORE the
                // `mediaLength === 0` branch could run -- which left
                // `window.mediaLength` at its old value, so
                // playlistIsOnScreen() stayed true and checkDevice stayed
                // gated. displayMediaContent() guards this; this did not.
                data.campaign_media = currentData.campaign_media || [];

                // Update other properties if needed
                if (currentData.location) {
                  data.location = currentData.location;
                  document.getElementById('checkdevice-response').textContent = `Connected to ${currentData.location}`;
                }

                // Save the new data to cache
                MediaStorage.save(uuid, currentData);

                // Reset media index to start from the beginning
                window.currentMediaIndex = 0;
                window.mediaLength = data.campaign_media.length;

                clearInterval(window.rotationInterval);
                window.rotationInterval = null;

                if (window.mediaLength === 0) {
                  // A campaign can be unplanned while the screen is playing it.
                  // displayMedia() and startRotationTimer() both read
                  // campaign_media[0] without a guard and threw a TypeError
                  // here, which killed the very poll that would have picked the
                  // next campaign up.
                  //
                  // stopPlayback() rather than `mediaPlayer.innerHTML = ''`:
                  // emptying that node left `window.displayMedia`,
                  // `window.mediaLength` and #media-playing-info pointing at a
                  // playlist that no longer existed, so LEFT/RIGHT on the
                  // remote still wrote the gone campaign's name and "(2/2)"
                  // onto a screen playing nothing. Measured: that stale line
                  // survived here until checkDevice's next poll cleaned it up,
                  // which at the backoff cap is up to 30 s of a debug panel
                  // contradicting the screen.
                  stopPlayback();
                  showStatus('Ansluten till ' + (data.location || 'DIGMI') +
                    ' — inget innehåll är planerat för den här skärmen än.');

                  return true;
                }

                // Immediately display the first item of the new content
                window.displayMedia(0);
                startRotationTimer();
                updateStageGeometry();

                return true; // Data changed and updated
              }
              return false; // No change detected
            });
        });
      }

      // One place for "show the next item, then schedule the one after it",
      // and the ONLY place that is allowed to do it.
      //
      // The generation is checked here, at the top, because the four
      // checkDeviceDataChanges() continuations below cannot lean on
      // startRotationTimer()'s own guard: the two statements that used to sit
      // in front of it ran FIRST. A continuation resolving after a teardown
      // therefore called clearInterval() on `window.rotationInterval` -- which
      // by then held the handle of the CURRENT generation's live chain -- and
      // only then hit the guard and returned. The new chain was dead and
      // nothing restarted it.
      //
      // That froze a customer's screen on one slide permanently and silently:
      // `mediaLength` stayed > 0, so playlistIsOnScreen() stayed true, so
      // checkDevice refused to re-fetch, and the rotation chain was the only
      // caller of checkDeviceDataChanges(). Measured in lab/checkdevice-probe:
      // the index stood still at 0 for 4 s with 700 ms slides and
      // `rotationInterval` held an already-cleared handle. main did not have
      // this: there the stale continuation RESTARTED the chain, loudly and
      // wrongly, with a TypeError. Guarding only startRotationTimer() traded
      // loud-and-recovering for silent-and-permanent, which is worse.
      /**
       * True when the one slide of a single-item playlist is an image that is
       * already on screen and loaded. Repainting it would re-run the whole
       * decode-and-swap for nothing -- on the bench that was a visible blink
       * every 15 s on a one-picture campaign (2026-11-10), the same fault
       * signage.digmi.eu fixed in its own rotation. A video is excluded: it
       * has to be restarted to loop. An image that failed to load is excluded
       * too, so a screen that started offline still heals itself.
       */
      function singleImageAlreadyShowing() {
        if (data.campaign_media.length !== 1 || data.campaign_media[0].video) {
          return false;
        }
        const shown = mediaPlayer.querySelector('img.main-media');
        return !!shown && shown.complete && shown.naturalWidth > 0;
      }

      const continueRotation = () => {
        if (!isCurrentGeneration()) {
          return;
        }

        // The timer is still rearmed below: the wrap-around poll in the tick
        // has to keep running so a switched-off campaign is noticed.
        if (!singleImageAlreadyShowing()) {
          window.displayMedia(window.currentMediaIndex);
        }

        // Null it, not just clear it. If startRotationTimer() returns without
        // building a chain - its own generation guard, or a throw - the handle
        // would otherwise keep a cleared timer id, and a cleared id is still a
        // number, so playlistIsOnScreen() would report a live playlist and the
        // self-healing re-fetch would never happen. Nulling makes that healing
        // an invariant instead of a coincidence. Same argument as the key
        // handler.
        clearInterval(window.rotationInterval);
        window.rotationInterval = null;

        startRotationTimer();
      };

      /**
       * Every slot length passes through here before it reaches setInterval.
       *
       * Floor 1 s: a unit mistake upstream is a flashing screen in a salon,
       * and this is the cheapest thing that makes the next one harmless.
       * Ceiling 1 h: setInterval stores its delay as a 32-bit integer, so a
       * value past 2^31-1 ms wraps and fires at once -- a strobe again, from
       * the other direction. Non-finite: a live stream reports Infinity for
       * `videoElement.duration`, and Infinity * 1000 is Infinity, which
       * setInterval treats as 0.
       *
       * @param {number} ms
       * @return {number}
       */
      function clampSlotMs(ms) {
        if (!Number.isFinite(ms) || ms <= 0) {
          return 10000;
        }
        return Math.min(3600000, Math.max(1000, ms));
      }

      // Set up rotation interval
      function startRotationTimer() {
        // Second line of defence, not the only one. continueRotation() guards
        // the rotation continuations and checkDeviceDataChanges() guards its
        // own resolver; this catches a direct call from a stale generation --
        // the `loadedmetadata` path, and the change branch inside
        // checkDeviceDataChanges() -- and stops it building a chain. Catching
        // that second one is why a missed guard there stalled the screen
        // rather than freezing it for good. An earlier comment here claimed
        // this single check was sufficient for every continuation; it was not.
        if (!isCurrentGeneration()) {
          return;
        }

        const currentMedia = data.campaign_media[window.currentMediaIndex];
        // `duration` arrives in SECONDS -- the API builds it from
        // `secondsForEachImageOnScreensaver`, default 15 -- and setInterval
        // wants milliseconds. This line used to pass the value straight
        // through, so every image slot was 15 ms: the stage re-rendered at
        // ~66 Hz, which a camera integrates into a double exposure and an eye
        // reads as a strobe. Measured on the bench 2026-11-10 (QB43C, the
        // Default campaign, HUD open). The bundle in the field (1.0.10 as
        // uploaded to Seller Office) never read this field at all and so
        // never showed it; the pass-through came in with 707f5ac on
        // 2026-09-05 and shipped in 1.0.12, which was never released.
        // signage.digmi.eu multiplies by 1000; this is the same contract.
        let duration = clampSlotMs(Number(currentMedia.duration) * 1000);

        // For videos, get the length from the player.
        //
        // Read when the clip was prepared, not asked for now: the probe
        // measured that the player's clock does not necessarily belong to the
        // new stream straight after a seam. Whether getDuration() lags the
        // same way is NOT measured.
        //
        // The fallback when AVPlay will not say a length is NOT the <video>
        // branch below -- that branch looks for a `.media-player video`
        // element, and on the AVPlay path there never is one, so it always
        // keeps the server-side `duration` (in seconds, clamped above). A 45 s
        // clip with no server-side duration is therefore cut at the 10 s
        // default. Worth knowing before trusting the number.
        const avplayMs = window.avplayDurationMs ? window.avplayDurationMs() : null;
        if (currentMedia.video && avplayMs) {
          duration = clampSlotMs(avplayMs);
          // Tell the player when this slot ends, so a stream completing at
          // the same moment does not restart the clip just before the timer
          // advances the playlist.
          if (window.avplayNoteSlot) {
            window.avplayNoteSlot(monotonicNow() + duration);
          }
        } else if (currentMedia.video) {
          const videoElement = document.querySelector('.media-player video');

          if (videoElement) {
            // Check if duration is already available
            if (videoElement.duration && videoElement.duration > 0) {
              duration = clampSlotMs(videoElement.duration * 1000);
            } else {
              // Wait for metadata to load to get duration
              videoElement.addEventListener('loadedmetadata', function onMetadataLoaded() {
                // The generation check has to come first. The same-item guard
                // below compares against this closure's own `currentMedia`, so
                // it is still TRUE after a teardown - index untouched, same
                // closure - and this listener would then build a brand new
                // interval out of a playlist that is gone. pause() does not
                // cancel metadata loading, so on a slow salon WLAN this is the
                // likeliest resurrection path of the lot.
                if (!isCurrentGeneration()) {
                  return;
                }

                // Only update if we're still on the same media item
                if (data.campaign_media[window.currentMediaIndex] === currentMedia) {
                  clearInterval(window.rotationInterval);
                  const videoDuration = clampSlotMs(videoElement.duration * 1000);

                  // Set new interval with correct duration
                  window.rotationInterval = setInterval(() => {
                    // A tick that fires after a teardown must not render, must not
                    // poll, and must not reschedule. Returning WITHOUT clearing is
                    // deliberate: stopPlayback() already cleared the handle, and
                    // clearing here would reach for whatever interval is current now.
                    if (!isCurrentGeneration()) {
                      return;
                    }

                    // Check if we're at the last media item before incrementing the index
                    const isLastMediaItem = window.currentMediaIndex === data.campaign_media.length - 1;

                    // Increment to next media item
                    window.currentMediaIndex = (window.currentMediaIndex + 1) % data.campaign_media.length;

                    // If we just finished displaying the last item (now looped back to first)
                    if (isLastMediaItem) {
                      checkDeviceDataChanges()
                        .then(dataChanged => {
                          // Only continue rotation if data didn't change (which would restart rotation)
                          if (!dataChanged) {
                            continueRotation();
                          }
                        })
                        .catch(() => {
                          // Continue with normal rotation despite the error.
                          // Deliberately swallowed and unnamed: the only thing
                          // this level can do about a failed content poll is
                          // keep showing what is already on screen.
                          continueRotation();
                        });
                    } else {
                      // Normal rotation for non-last items
                      continueRotation();
                    }
                  }, videoDuration);
                }

                // Remove the event listener after it fires once
                videoElement.removeEventListener('loadedmetadata', onMetadataLoaded);
              });
            }
          }
        }

        clearInterval(window.rotationInterval);
        window.rotationInterval = setInterval(() => {
          // A tick that fires after a teardown must not render, must not
          // poll, and must not reschedule. Returning WITHOUT clearing is
          // deliberate: stopPlayback() already cleared the handle, and
          // clearing here would reach for whatever interval is current now.
          if (!isCurrentGeneration()) {
            return;
          }

          // Check if we're at the last media item before incrementing the index
          const isLastMediaItem = window.currentMediaIndex === data.campaign_media.length - 1;

          // Increment to next media item
          window.currentMediaIndex = (window.currentMediaIndex + 1) % data.campaign_media.length;

          // If we just finished displaying the last item (now looped back to first)
          if (isLastMediaItem) {
            checkDeviceDataChanges()
              .then(dataChanged => {
                // Only continue rotation if data didn't change (which would restart rotation)
                if (!dataChanged) {
                  continueRotation();
                }
              })
              .catch(() => {
                // Continue with normal rotation despite the error.
                // Deliberately swallowed and unnamed - see the sibling handler.
                continueRotation();
              });
          } else {
            // Normal rotation for non-last items
            continueRotation();
          }
        }, duration);
      }

      startRotationTimer();

      // Add media player to container
      campaignContainer.appendChild(mediaPlayer);
    }
  }
}

/**
 * Polls `/api/verify-device/{uuid}` until this screen is paired, then takes
 * over fetching its content.
 *
 * Polls forever with a capped backoff rather than giving up after a fixed
 * number of attempts, and keeps polling once paired if the playlist is empty,
 * so a screen can notice both its own pairing and content appearing later
 * without anyone power-cycling the panel.
 *
 * @param {string} uuid This screen's device identity.
 */
function checkDevice(uuid) {
  let attempt = 0;
  // The previous poll's answer, so the backoff is reset on the TRANSITION to
  // unpaired rather than on every unpaired poll. See where it is read.
  let wasPaired = false;
  // Was `MAX_ATTEMPTS = 300` with an uncapped `attempt * 1000` backoff: the
  // interval grew without bound and the client stopped asking entirely after
  // ~12.5 h. A screen that had been parked on the QR page could not notice its
  // own registration, so re-pairing from the portal changed nothing until
  // someone power-cycled the TV (Hair & Co, 2026-09-04). Poll forever, capped.
  const MAX_DELAY_MS = 30000;
  const countdownElement = document.getElementById('check-countdown');

  // Vestigial: `checkInterval` is declared and never assigned - the backoff is
  // a setTimeout chain, not an interval - so this cannot de-duplicate anything,
  // and clearInterval(undefined) is a no-op. It matters more now than it looks:
  // the chain no longer ends when a campaign starts, so a second checkDevice()
  // would poll forever alongside the first and this guard would not stop it.
  // Nothing calls checkDevice() twice today, but NOT because there is only one
  // call site - there are two. window.onload calls it, and so does
  // generateQRCode() when `localStorage.getItem('myUUID')` is falsy. The second
  // is unreachable in practice for a different reason: getUUID() writes
  // `myUUID` to localStorage before it returns, and window.onload awaits it
  // before calling generateQRCode(), so by the time that read happens the key
  // is set. Reorder window.onload and the second call becomes live - two
  // chains polling forever, which this guard cannot stop. The conclusion is
  // sound; the reason it used to give was not.
  if (checkInterval) {
    clearInterval(checkInterval);
  }

  const updateCountdown = (seconds) => {
    countdownElement.textContent = seconds;
  };

  const check = async () => {
    try {
      // verify-device is unauthenticated. Sending Authorization here bought
      // nothing and forced a CORS preflight on every poll.
      const response = await fetch(`${baseUrl}/api/verify-device/${uuid}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });

      // verify-device sits behind its own nginx rate limit, and a 429 or a 500
      // still answers with a JSON body - `{"message":"Too Many Attempts."}`.
      // Unchecked, that body fell through as a successful poll carrying no
      // `device_exists`, and the clear below then wiped the only explanation
      // readable from across the salon, leaving it in the INFO panel where it
      // needs someone standing at the screen with a remote. Throwing hands it
      // to the catch, which puts it on the status line instead.
      if (!response.ok) {
        throw new Error('HTTP ' + response.status);
      }

      const data = await response.json();

      // `=== false`, not `!data.device_exists`: only a poll that explicitly
      // answers "not paired" may clear the screen. A payload with no such
      // field is not an answer about pairing at all, and treating it as one is
      // exactly how a rate-limited poll blanked the status line.
      if (data.device_exists === false) {
        // Anything already on the status line is now untrue: a
        // `Kontrollen misslyckades` from the catch below, a `Kunde inte hämta
        // innehåll` from fetchDeviceMedia, or an `Ansluten till …` from a
        // pairing since removed in the portal. Without this, one blip before
        // pairing leaves a false error standing over the QR screen for as long
        // as the panel is on, because nothing else writes that line here.
        //
        // BEFORE the `data.message` write below, not after the branch:
        // showStatus() writes `#checkdevice-response` as well as the status
        // line, so clearing afterwards blanked the `( 👎 ) …` diagnostic that
        // the INFO panel exists to show.
        showStatus('');

        // Back to a fast poll - but ONLY on the transition from paired to
        // unpaired. This branch is true on EVERY poll while a screen is
        // unpaired, so resetting unconditionally disabled the backoff outright:
        // with `attempt++` in the tail, `attempt` just oscillated 0 -> 1 and
        // nextDelay was pinned at 1000 ms. Measured: 12 s unpaired produced 9
        // polls, every delay 1000, never 2000. That is 86 400 verify-device
        // calls a day for one unpaired screen instead of ~2 880 - 60 of the
        // limiter's 120/min per deviceId held permanently, for a panel still in
        // its box or a showroom TV left switched on. This file's own design is
        // "Poll forever, capped" and the reset undid the cap.
        //
        // The reset is still worth having: a screen paired for hours sits at
        // the 30 s cap, and a salon re-pairing from the portal would otherwise
        // stare at the QR for another half minute after the portal was done.
        if (wasPaired) {
          attempt = 0;
        }

        wasPaired = false;

        // Puts the pairing view back AND tears the playlist down - see
        // stopPlayback(). Nothing used to do either: hideRegistrationScreen()
        // runs the moment a screen pairs and had no counterpart, so a screen
        // removed in the portal kept the activation view hidden for good and
        // kept playing content it no longer had any right to.
        //
        // Nothing is re-rendered here. The code already in the DOM encodes
        // this uuid and is still the right pairing URL - UNLESS
        // getDeviceModel() never settled, in which case the module-level
        // placeholder is still in the box and encodes bare `baseUrl`, sending
        // a scan to the portal front page. Re-rendering would not help,
        // because generateQRCode() would hang on the same await; see
        // scheduleQrRetry, still not ported (lines 40-46). Measured: with a
        // getPropertyValue that never calls back, the two QR bitmaps differ.
        showRegistrationScreen(data.reason);
      }

      // Unguarded on purpose, now that this poll outlives the campaign's
      // start: it keeps a live pairing indicator in the panel, which is worth
      // more than what it replaces. On a freshly paired screen it replaces an
      // empty string - fetchDeviceMedia() writes `Connected to {location}`
      // here, but displayMediaContent() then calls showStatus(''), which
      // writes BOTH the status line and this field, so the location is gone
      // within the same tick. Measured at initial pairing, and that wipe is
      // its own bug, tracked separately.
      //
      // NOT an empty string in every case, though: checkDeviceDataChanges()
      // writes `Connected to {location}` straight into this field whenever it
      // picks up a content change, and does not clear it afterwards. So on a
      // screen that has had a campaign change, this write does overwrite a
      // location within 30 s. The field lives in `.device-info`, hidden until
      // someone opens the panel with the remote, so the cost is a support
      // detail rather than anything a salon sees.
      if (data.device_exists) {
        wasPaired = true;
      }

      if (data.message) {
        // `reason` appended because `message` is byte-identical for all of
        // them - `deviceMissing()` serves one sentence - so without it
        // someone holding the remote in front of a screen showing the wrong
        // face cannot see what the portal actually sent.
        document.getElementById('checkdevice-response').textContent =
          (data.device_exists ? '( 👍 ) ' : '( 👎 ) ') + data.message +
          (data.reason ? ' [' + data.reason + ']' : '');
      }
      // `!playlistIsOnScreen()`: while a campaign is up, this poll is only
      // here to notice an unpairing. Fetching the playlist again would
      // re-render and restart it from the first item every 30 s. Derived from
      // window.mediaLength rather than a local flag so that a campaign
      // unplanned mid-playback - which empties the playlist from inside
      // checkDeviceDataChanges(), out of reach of anything in this function -
      // puts this branch back in play instead of silencing it forever.
      if (data.device_exists && !playlistIsOnScreen()) {
        // Start fetching and displaying media
        const media = await fetchDeviceMedia(uuid);

        // A null payload means the media fetch failed, which is not the same
        // thing as a screen with nothing planned. Leave the registration
        // screen up rather than blanking it, keep the reason fetchDeviceMedia
        // already put on screen, and fall through to the backoff below.
        if (media) {
          // Hide the whole registration screen, not just the QR square. Only
          // the QR itself used to go, so a device that was registered but had
          // no slides yet kept showing "Scan the QR-code to connect this TV"
          // and read to the salon as still broken (Hair & Co, 2026-09-04).
          hideRegistrationScreen();

          // Show campaign container
          const campaignContainer = document.getElementById('campaign-container');
          campaignContainer.style.display = 'block';

          if (media.campaign_media && media.campaign_media.length > 0) {
            // Clear the status line BEFORE giving up. A failed media fetch
            // that fell back on cached content leaves its reason on screen
            // (see fetchDeviceMedia's catch), and this branch is the last
            // thing that runs - the `return` below ends the backoff chain,
            // and nothing else would ever write over that line. Without
            // this, "Kunde inte hämta innehåll: …" sits on a paying
            // customer's screen, on top of their campaign, until someone
            // power-cycles the panel.
            showStatus('');

            // No `return` here, which is the whole point: this used to end
            // the backoff chain for good, and that is why an unpairing was
            // invisible to a playing screen. The only poll left alive was
            // checkDeviceDataChanges(), which asks what to PLAY, never whether
            // this device still exists - so showRegistrationScreen() was
            // unreachable in precisely the state a salon would call about.
            // Falling through to the backoff keeps asking; playlistIsOnScreen()
            // is now true, so the branch above stops re-fetching the playlist.
            //
            // The cost is one unauthenticated GET per screen per 30 s at the
            // backoff cap. verify-device is rate-limited 120/min per deviceId
            // (`RateLimiter::for('verify-device')` in the portal's
            // AppServiceProvider - its own comment reads "120/min (was 60)"),
            // so a screen uses 2 of 120. Prod nginx additionally puts the path
            // on a relaxed 30 r/s-per-IP zone according to the signage client
            // sync spec; prod nginx is hand-edited and was not read for this,
            // so treat that figure as the spec's and not as measured. A
            // nine-panel store behind one NAT address contributes 0.3 r/s.
          } else {
            // `else`, now that the branch above no longer returns. Measured
            // without it: a screen playing a two-item campaign had "inget
            // innehåll är planerat för den här skärmen än" written across it
            // on the first poll - the exact sentence that says the opposite of
            // what the screen is doing, over a paying customer's content.
            //
            // Clear whatever an earlier playlist left rendered.
            // fetchDeviceMedia() renders the cache before it fetches, and
            // displayMediaContent() does nothing at all for an empty payload,
            // so a screen whose campaign was unplanned kept the old campaign's
            // last frame with the chip below contradicting it. Measured: the
            // container displayed `block` holding its one `.media-player`,
            // which still held two children (the background img and the main
            // media element), under "inget innehåll är planerat".
            //
            // stopPlayback(), not `campaignContainer.innerHTML = ''`:
            // checkDeviceDataChanges() handles the same situation by emptying
            // `mediaPlayer` - a DIFFERENT node, which survives, keeping its
            // closure valid - so the two are not equivalent and the earlier
            // comment here claiming they were was wrong. Emptying the
            // container destroys `mediaPlayer`, which is only safe alongside
            // clearing the globals that point at it.
            stopPlayback();

            // Paired, but nothing planned yet. Keep asking: the media poll is
            // set up inside displayMediaContent(), which only runs when there
            // is media, so a screen that paired into an empty playlist had
            // nothing watching for content to appear. That is the state
            // Hair & Co's TV sat in.
            showStatus('Ansluten till ' + (media.location || 'DIGMI') +
              ' — inget innehåll är planerat för den här skärmen än.');
          }
        }
      }
    } catch (error) {
      // This catch used to be empty, which is why a week of this outage left
      // no trace on the screen at all. Say what went wrong - but say it in the
      // right place.
      const reason = 'Kontrollen misslyckades: ' + (error && error.message ? error.message : error);

      if (playlistIsOnScreen()) {
        // Panel only, never the status line, while a campaign is up. The chip
        // is `position: fixed; z-index: 10000` in brand.css against the video
        // layer's z-index 10, so it draws ON TOP of a paying customer's
        // content - and now that this catch outlives the campaign's start,
        // nothing would ever clear it: a successful poll while playing writes
        // #checkdevice-response, not the status line. One 429 out of ~2880
        // polls a day (verify-device IS rate-limited, which is why the
        // response.ok check above exists at all) would have parked
        // "Kontrollen misslyckades: HTTP 429" over the campaign until someone
        // power-cycled the panel, with the panel and the chip contradicting
        // each other. A transient poll failure on a screen that is playing
        // correctly is a diagnostic, not something to show the salon.
        const debugLine = document.getElementById('checkdevice-response');
        if (debugLine) {
          debugLine.textContent = '( ⚠️ ) ' + reason;
        }
      } else {
        showStatus(reason);
      }
    }

    attempt++;
    const nextDelay = Math.min(attempt * 1000, MAX_DELAY_MS);

    // Start countdown
    let countdown = Math.floor(nextDelay / 1000);
    updateCountdown(countdown);

    const countdownInterval = setInterval(() => {
      countdown--;
      if (countdown >= 0) {
        updateCountdown(countdown);
      } else {
        clearInterval(countdownInterval);
      }
    }, 1000);

    // Schedule next check with increasing delay
    setTimeout(check, nextDelay);
  };

  // Start first check immediately
  check();
}

/**
 * Writes the device identity into the INFO panel.
 *
 * @param {string} uuid This screen's device identity.
 */
function displayUUID(uuid) {
  document.getElementById('device-uuid').textContent = uuid;
}

/**
 * Writes the widget's `appVersion` into the INFO panel, if that field exists.
 */
function displayAppVersion() {
  const appVersionElement = document.getElementById('app-version-text');
  if (appVersionElement) {
    appVersionElement.textContent = `${appVersion}`;
  }
}
window.onload = function () {
  // Before the QR and before any status text: this swaps the page's Swedish
  // defaults for the screen's own language and hides the [data-box-only]
  // parts. Guarded rather than assumed - if brand.js failed to load, the
  // markup's Swedish still reads correctly, which is why the defaults are
  // real sentences and not i18n keys.
  if (window.DigmiBrand && typeof window.DigmiBrand.applyBrandTexts === 'function') {
    const lang = window.DigmiBrand.resolveLanguage(window.location.search, navigator.language);
    window.DigmiBrand.applyBrandTexts(document, lang, window.DigmiBrand.isBox(window.location.search));
  }

  getDUID().then((duid) => {
    document.getElementById('device-duid').textContent = duid || 'Not available';
  });

  getUUID()
    .then((uuid) => {
      displayAppVersion();
      displayUUID(uuid);
      checkDevice(uuid);
      generateQRCode();
    })
    .catch((error) => {
      generateQRCode();
    });
};
