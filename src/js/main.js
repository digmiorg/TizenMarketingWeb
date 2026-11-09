const appVersion = '1.0.11';
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
    window.location.reload();
  }, 1500);
}

document.addEventListener('keydown', function (e) {
  let deviceInfoElement;

  switch (e.keyCode) {
    case window.tvKey.ENTER:
    case window.tvKey.INFO:
      deviceInfoElement = document.querySelector('.device-info');
      if (deviceInfoElement) {
        // One mechanism, the `.visible` class. This assigned `style.display`
        // inline in two separate copies, which silently beats any stylesheet
        // rule and made the panel's state depend on which key opened it.
        deviceInfoElement.classList.toggle('visible');
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
    case window.tvKey.EXIT:
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
  TTL: 10000, // 1 hours

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
function showRegistrationScreen() {
  const screen = document.getElementById('content-reg');
  if (screen) {
    screen.style.display = '';
  }

  const campaignContainer = document.getElementById('campaign-container');
  if (campaignContainer) {
    campaignContainer.style.display = 'none';
  }

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

      // Make displayMedia available globally
      window.displayMedia = function(index) {
        window.currentMediaIndex = index;
        const mediaItem = data.campaign_media[index];

        // Clear previous content
        mediaPlayer.innerHTML = '';

        // Create background image
        const backgroundImg = document.createElement('img');
        backgroundImg.className = 'background';
        backgroundImg.src = mediaItem.video ?
          (mediaItem.thumbnail_url || mediaItem.thumbnail) :
          (mediaItem.fullsize_url || mediaItem.fullsize);
        mediaPlayer.appendChild(backgroundImg);

        // Create main media element
        const mediaElement = document.createElement(mediaItem.video ? 'video' : 'img');
        mediaElement.className = mediaItem.video ? 'video fade-in' : 'main-media fade-in';
        mediaElement.src = mediaItem.fullsize_url || mediaItem.fullsize;

        if (mediaItem.video) {
          mediaElement.autoplay = true;
          mediaElement.loop = true;
          mediaElement.muted = true;
          mediaElement.playsInline = true;
        }

        mediaPlayer.appendChild(mediaElement);

        // Update info display if campaign name exists
        if (mediaItem.campaign_name || mediaItem.campaignName) {
          const mediaPlayingInfoElement = document.getElementById('media-playing-info');
          mediaPlayingInfoElement.textContent = `${mediaItem.campaign_name || mediaItem.campaignName} (${index + 1}/${data.campaign_media.length}) - ${mediaItem.media_name || mediaItem.name}`;
        }
      };

      // Initial display
      window.displayMedia(0);
      updateStageGeometry();

      // Function to check for device data changes and handle accordingly
      function checkDeviceDataChanges() {
        return getUUID().then(uuid => {
          const url = `${baseUrl}/api/v1/devices/${uuid}`;
          const options = {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              Authorization: apiAuthorization,
            },
          };

          return fetch(url, options)
            .then(response => {
              if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
              }
              return response.json();
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

              // Load cached data
              const cachedData = MediaStorage.load(uuid);

              // If data differs from cache or no cache exists, update the data
              if (!cachedData || JSON.stringify(cachedData) !== JSON.stringify(currentData)) {
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
      const continueRotation = () => {
        if (!isCurrentGeneration()) {
          return;
        }

        window.displayMedia(window.currentMediaIndex);

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
        let duration = currentMedia.duration || 10000;

        // For videos, get the actual duration from the video element
        if (currentMedia.video) {
          const videoElement = document.querySelector('.media-player video');

          if (videoElement) {
            // Check if duration is already available
            if (videoElement.duration && videoElement.duration > 0) {
              duration = videoElement.duration * 1000; // Convert to milliseconds
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
                  const videoDuration = videoElement.duration * 1000;

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
        showRegistrationScreen();
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
        document.getElementById('checkdevice-response').textContent =
          (data.device_exists ? '( 👍 ) ' : '( 👎 ) ') + data.message;
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
