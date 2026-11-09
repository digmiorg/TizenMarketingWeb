(function () {
  try { localStorage.clear(); } catch (e) {}
  window.__t = {
    paired: true, verify: 0, devices: 0, fail: false,
    liveIntervals: 0, maxLive: 0, ticks: 0,
    // What the unpaired answer carries as `reason`. null leaves the key out
    // entirely, which is the pre-#1649 payload - the QR code must still come
    // up for it. Set it to 'unknown' or 'switched-off' to drive the two
    // faces of the activation view.
    reason: null
  };
  // Short durations so a full playlist loop (which is what calls
  // checkDeviceDataChanges) completes inside a test run.
  window.__t.media = [
    { fullsize_url: 'img/a.png', thumbnail_url: 'img/a.png', video: false,
      duration: 700, campaign_name: 'Testkampanj', media_name: 'Bild 1' },
    { fullsize_url: 'img/b.png', thumbnail_url: 'img/b.png', video: false,
      duration: 700, campaign_name: 'Testkampanj', media_name: 'Bild 2' }
  ];

  // Track live interval handles so an orphaned rotation chain is visible.
  var realSet = window.setInterval, realClear = window.clearInterval;
  var live = {};
  window.setInterval = function (fn, ms) {
    var id = realSet(function () { window.__t.ticks++; fn.apply(null, arguments); }, ms);
    live[id] = true;
    window.__t.liveIntervals = Object.keys(live).length;
    if (window.__t.liveIntervals > window.__t.maxLive) {
      window.__t.maxLive = window.__t.liveIntervals;
    }
    return id;
  };
  window.clearInterval = function (id) {
    if (live[id]) { delete live[id]; }
    window.__t.liveIntervals = Object.keys(live).length;
    return realClear(id);
  };

  window.tizen = {
    systeminfo: {
      getCapability: function () { return 'TEST-UUID-0001'; },
      getCapabilities: function () { return { duid: 'TEST-DUID' }; },
      getPropertyValue: function (k, cb) { setTimeout(function () { cb({ model: 'QB43C' }); }, 0); }
    }
  };
  var realFetch = window.fetch;
  window.fetch = function (url) {
    var u = String(url);
    if (u.indexOf('/api/verify-device/') !== -1) {
      window.__t.verify++;
      if (window.__t.fail) {
        return Promise.resolve(new Response(JSON.stringify({ message: 'Too Many Attempts.' }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }));
      }
      var body;
      if (window.__t.paired) {
        body = { device_exists: true, message: 'Device registered' };
      } else {
        body = { device_exists: false, message: 'Device not registered' };
        if (window.__t.reason !== null) {
          body.reason = window.__t.reason;
        }
      }
      return Promise.resolve(new Response(JSON.stringify(body),
        { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    if (u.indexOf('/api/v1/devices/') !== -1) {
      window.__t.devices++;
      return Promise.resolve(new Response(JSON.stringify(
        { location: 'Testsalongen', campaign_media: window.__t.media }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return realFetch.apply(window, arguments);
  };
})();
