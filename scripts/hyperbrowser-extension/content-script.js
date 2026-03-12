// Inject the geolocation blocker into the page's main world
// so it can override the page's navigator.geolocation API.
const script = document.createElement('script');
script.src = chrome.runtime.getURL('block-geolocation.js');
script.onload = () => script.remove();
(document.head || document.documentElement).appendChild(script);

// Force Bing search result links to open in the same tab
if (location.hostname.includes('bing.com')) {
  function removeTargetBlank() {
    document.querySelectorAll('a[target="_blank"]').forEach(a => {
      a.removeAttribute('target');
    });
  }
  removeTargetBlank();
  new MutationObserver(removeTargetBlank).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['target'],
  });

  // Also intercept click events to prevent any JS-based new tab opens
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[target="_blank"]');
    if (link) {
      e.preventDefault();
      e.stopPropagation();
      window.location.href = link.href;
    }
  }, true);

  // Override window.open only on Bing search result pages
  if (location.pathname === '/search') {
    const openBlocker = document.createElement('script');
    openBlocker.textContent = `
      (function() {
        window.open = function(url) {
          if (url) { window.location.href = url; }
          return window;
        };
      })();
    `;
    (document.head || document.documentElement).appendChild(openBlocker);
    openBlocker.remove();
  }
}
