// Block geolocation requests by overriding the Geolocation API.
// This runs as a page-level script (injected via content script) so it
// intercepts calls from the page's own JS context.

(function () {
  const error = new GeolocationPositionError
    ? undefined
    : undefined;

  function makeError() {
    // PERMISSION_DENIED = 1
    return {
      code: 1,
      message: 'User denied Geolocation',
      PERMISSION_DENIED: 1,
      POSITION_UNAVAILABLE: 2,
      TIMEOUT: 3,
    };
  }

  navigator.geolocation.getCurrentPosition = function (_success, error) {
    if (typeof error === 'function') {
      error(makeError());
    }
  };

  navigator.geolocation.watchPosition = function (_success, error) {
    if (typeof error === 'function') {
      error(makeError());
    }
    return 0;
  };

  // Also override the permissions API to report geolocation as denied
  const originalQuery = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = function (descriptor) {
    if (descriptor && descriptor.name === 'geolocation') {
      return Promise.resolve({ state: 'denied', onchange: null });
    }
    return originalQuery(descriptor);
  };
})();
