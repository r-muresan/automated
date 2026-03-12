// Redirect new tabs to DuckDuckGo.
// chrome_url_overrides only fires for chrome://newtab, not for tabs created
// via CDP Target.createTarget (which open at about:blank). This service worker
// catches both cases.

chrome.tabs.onCreated.addListener((tab) => {
  // New tabs start as about:blank or chrome://newtab — redirect them.
  // Skip tabs that already have a real URL (e.g. created with a target URL).
  const url = tab.pendingUrl || tab.url || '';
  if (!url || url === 'about:blank' || url === 'chrome://newtab/' || url === 'chrome://newtab') {
    chrome.tabs.update(tab.id, { url: 'https://duckduckgo.com' });
  }
});
