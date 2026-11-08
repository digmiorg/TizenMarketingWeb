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
        clearInterval(window.rotationInterval);
        window.currentMediaIndex =
          (window.currentMediaIndex - 1 + window.mediaLength) % window.mediaLength;
        window.displayMedia(window.currentMediaIndex);
      }
      e.preventDefault();
      break;
    case window.tvKey.RIGHT:
      if (window.currentMediaIndex !== undefined && window.displayMedia) {
        clearInterval(window.rotationInterval);
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
 * Reads the panel's Tizen device id, preferring the `tizenid` capability and
 * falling back to the legacy `getCapabilities().duid`.
 *
 * Never rejects: a panel that answers neither way yields the literal string
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
 * Re-renders only when the encoded URL actually changed, guarded by
 * `lastGeneratedUrl`: the caller polls, and rebuilding the canvas on every
 * poll made the code visibly flash.
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
 * @returns {Promise<string>} The model name; rejects if the Tizen API throws.
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
 * Fetches this screen's planned content, displaying the cached payload first
 * so a slow network does not leave the panel blank, then caching and
 * displaying the fresh one.
 *
 * The return value distinguishes three outcomes the caller has to tell apart:
 * the fresh payload, the cached payload when the request failed but something
 * is still playable, and `null` when it failed with nothing cached. `null`
 * specifically does NOT mean "nothing is planned" - an empty
 * `campaign_media` array does.
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
      window.rotationInterval = null;

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
              // Load cached data
              const cachedData = MediaStorage.load(uuid);

              // If data differs from cache or no cache exists, update the data
              if (!cachedData || JSON.stringify(cachedData) !== JSON.stringify(currentData)) {
                // Update the data object with new media content
                data.campaign_media = currentData.campaign_media;

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
                  mediaPlayer.innerHTML = '';
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

      // Set up rotation interval
      function startRotationTimer() {
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
                // Only update if we're still on the same media item
                if (data.campaign_media[window.currentMediaIndex] === currentMedia) {
                  clearInterval(window.rotationInterval);
                  const videoDuration = videoElement.duration * 1000;

                  // Set new interval with correct duration
                  window.rotationInterval = setInterval(() => {
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
                            window.displayMedia(window.currentMediaIndex);
                            clearInterval(window.rotationInterval);
                            startRotationTimer();
                          }
                        })
                        .catch(error => {
                          // Continue with normal rotation despite error
                          window.displayMedia(window.currentMediaIndex);
                          clearInterval(window.rotationInterval);
                          startRotationTimer();
                        });
                    } else {
                      // Normal rotation for non-last items
                      window.displayMedia(window.currentMediaIndex);
                      clearInterval(window.rotationInterval);
                      startRotationTimer();
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
                  window.displayMedia(window.currentMediaIndex);
                  clearInterval(window.rotationInterval);
                  startRotationTimer();
                }
              })
              .catch(error => {
                // Continue with normal rotation despite error
                window.displayMedia(window.currentMediaIndex);
                clearInterval(window.rotationInterval);
                startRotationTimer();
              });
          } else {
            // Normal rotation for non-last items
            window.displayMedia(window.currentMediaIndex);
            clearInterval(window.rotationInterval);
            startRotationTimer();
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
  // Was `MAX_ATTEMPTS = 300` with an uncapped `attempt * 1000` backoff: the
  // interval grew without bound and the client stopped asking entirely after
  // ~12.5 h. A screen that had been parked on the QR page could not notice its
  // own registration, so re-pairing from the portal changed nothing until
  // someone power-cycled the TV (Hair & Co, 2026-09-04). Poll forever, capped.
  const MAX_DELAY_MS = 30000;
  const countdownElement = document.getElementById('check-countdown');

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
      const data = await response.json();

      // A poll that came back and said "not paired" makes anything already on
      // the status line untrue: a `Kontrollen misslyckades` from the catch
      // below (the control just succeeded), a `Kunde inte hämta innehåll`
      // from fetchDeviceMedia, or an `Ansluten till …` from a pairing since
      // removed in the portal. Without this, one blip before pairing leaves a
      // false error standing over the QR screen for as long as the panel is
      // on, because nothing else writes that line in this state.
      //
      // It has to run BEFORE the `data.message` write below, not after the
      // branch: showStatus() writes `#checkdevice-response` as well as the
      // status line, so clearing afterwards blanked the `( 👎 ) …` diagnostic
      // that the INFO panel exists to show. Measured - the field came back
      // empty. The paired branch writes its own status later and is untouched.
      if (!data.device_exists) {
        showStatus('');
      }

      if (data.message) {
        document.getElementById('checkdevice-response').textContent =
          (data.device_exists ? '( 👍 ) ' : '( 👎 ) ') + data.message;
      }
      if (data.device_exists) {
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
            // Vestigial: `checkInterval` is declared and never assigned -
            // the backoff is a setTimeout chain, not an interval. Left in
            // place rather than removed in this commit, which is about the
            // pairing screen; clearInterval(undefined) is a no-op. The
            // `return` is what actually stops the polling.
            clearInterval(checkInterval);

            return;
          }

          // Paired, but nothing planned yet. Keep asking: the media poll is set
          // up inside displayMediaContent(), which only runs when there is
          // media, so a screen that paired into an empty playlist had nothing
          // watching for content to appear. That is the state Hair & Co's TV
          // sat in.
          showStatus('Ansluten till ' + (media.location || 'DIGMI') +
            ' — inget innehåll är planerat för den här skärmen än.');
        }
      }
    } catch (error) {
      // This catch used to be empty, which is why a week of this outage left
      // no trace on the screen at all. Say what went wrong.
      showStatus('Kontrollen misslyckades: ' + (error && error.message ? error.message : error));
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
