const appVersion = '1.0.10';
const baseUrl = 'https://portal.digmi.eu';
// Shared tablet bearer. /api/v1/devices needs it (401 without); verify-device
// does not, so it is no longer sent there. It lives in one place now because
// rotating it means rebuilding this widget in lockstep with the other clients
// that carry the same token.
const apiAuthorization = 'Bearer DzQ7bhe9mt32FrGQXdhH5JrKesmrVcf40QwXiR2z8nvMaCePKskZP76ZqHEKoRNFtWpYCYR7VYeJgyTh';
let lastGeneratedUrl = null; // Store the last generated URL outside the function to track changes.
let checkInterval;

new QRCode(document.getElementById('qrcode'), {
  text: baseUrl,
  width: 360,
  height: 360,
  colorDark: '#000000',
  colorLight: '#ffffff',
  correctLevel: QRCode.CorrectLevel.H,
});

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
      deviceInfoElement = document.querySelector('.device-info'); // Select the device-info element
      if (deviceInfoElement) {
        // Toggle the element's display property
        deviceInfoElement.style.display =
          deviceInfoElement.style.display === 'none' || !deviceInfoElement.style.display
            ? 'block'
            : 'none';
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
    case window.tvKey.INFO:
      deviceInfoElement = document.querySelector('.device-info'); // Select the device-info element
      if (deviceInfoElement) {
        // Toggle the element's display property
        deviceInfoElement.style.display =
          deviceInfoElement.style.display === 'none' || !deviceInfoElement.style.display
            ? 'block'
            : 'none';
      }
      e.preventDefault();
      break;
  }
});

function generateUUID() {
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
  );
}

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
      width: 360,
      height: 360,
      colorDark: '#000000',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.H,
    });
    lastGeneratedUrl = qrUrl; // Update the last generated URL
  }
}

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
    document.getElementById('checkdevice-response').textContent = `Error: ${error.message}`;

    // If we have cached data, keep using it during error
    if (cachedData) {
      return cachedData;
    }

    // Retry after 5 seconds
    setTimeout(() => fetchDeviceMedia(uuid), 5000);
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

/** Everything that makes up the pre-pairing screen, hidden as one unit. */
function hideRegistrationScreen() {
  ['logo', 'image-banner', 'qrcode', 'qr-text', 'background-image'].forEach((id) => {
    const element = document.getElementById(id);
    if (element) {
      element.style.display = 'none';
    }
  });
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
    statusLine.style.display = text ? 'block' : 'none';
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

                // Immediately display the first item of the new content
                window.displayMedia(0);

                // Restart the rotation timer with the new content
                clearInterval(window.rotationInterval);
                startRotationTimer();

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

      if (data.message) {
        document.getElementById('checkdevice-response').textContent =
          (data.device_exists ? '( 👍 ) ' : '( 👎 ) ') + data.message;
      }
      if (data.device_exists) {
        clearInterval(checkInterval);

        // Start fetching and displaying media
        const media = await fetchDeviceMedia(uuid);

        // Hide the whole registration screen, not just the QR square. Only the
        // QR itself used to go, so a device that was registered but had no
        // slides yet kept showing "Scan the QR-code to connect this TV" and
        // read to the salon as still broken (Hair & Co, 2026-09-04).
        hideRegistrationScreen();

        // Show campaign container
        const campaignContainer = document.getElementById('campaign-container');
        campaignContainer.style.display = 'block';

        if (!media || !media.campaign_media || media.campaign_media.length === 0) {
          showStatus('Connected to ' + (media && media.location ? media.location : 'DIGMI') +
            ' — no content planned for this screen yet.');
        }

        return;
      }
    } catch (error) {
      // This catch used to be empty, which is why a week of this outage left
      // no trace on the screen at all. Say what went wrong.
      showStatus('Check failed: ' + (error && error.message ? error.message : error));
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

function displayUUID(uuid) {
  document.getElementById('device-uuid').textContent = uuid;
}

function displayAppVersion() {
  const appVersionElement = document.getElementById('app-version-text');
  if (appVersionElement) {
    appVersionElement.textContent = `${appVersion}`;
  }
}
window.onload = function () {
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

// The device panel (uuid, model, last API response) is hidden by default and
// had no way of being opened on a TV, so nobody on site could read the device
// id off the screen — the QR code was the only route to it. INFO or the red
// button toggles it.
document.addEventListener('keydown', function (event) {
  const keys = window.tvKey || {};
  if (event.keyCode !== keys.INFO && event.keyCode !== keys.RED) {
    return;
  }

  const panel = document.querySelector('.device-info');
  if (panel) {
    panel.classList.toggle('visible');
    updateStageGeometry();
  }
});

try {
  if (window.tizen && tizen.tvinputdevice) {
    tizen.tvinputdevice.registerKey('Info');
    tizen.tvinputdevice.registerKey('ColorF0Red');
  }
} catch (error) {
  // Best effort: without the registration the panel just stays unreachable,
  // which is the behaviour we had before anyway.
}
