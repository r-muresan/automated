import { NextRequest, NextResponse } from 'next/server';

/**
 * Serves a minimal screencast viewer that connects to a local Chrome
 * instance via CDP WebSocket. Shows only the page content (no DevTools UI).
 *
 * Query params:
 *   ws - WebSocket URL for the CDP connection (e.g. localhost:PORT/devtools/page/PAGE_ID)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const ws = searchParams.get('ws') || '';
  const secure = searchParams.get('secure') === '1';
  const watchOnly = searchParams.get('watchOnly') === '1';

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Browser Screencast</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #fff; }
  #screencast {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
    cursor: default;
  }
  #overlay {
    position: absolute;
    top: 0; left: 0;
    width: 100%; height: 100%;
    cursor: default;
  }
</style>
</head>
<body>
<img id="screencast" alt="">
<div id="overlay"></div>
<script>
(function() {
  const wsUrl = ${JSON.stringify(secure)} ? 'wss://' + ${JSON.stringify(ws)} : 'ws://' + ${JSON.stringify(ws)};
  const watchOnly = ${JSON.stringify(watchOnly)};
  const img = document.getElementById('screencast');
  const overlay = document.getElementById('overlay');
  let socket = null;
  let msgId = 1;
  let screencastWidth = 0;
  let screencastHeight = 0;
  let sessionId = null;
  let lastFrameTime = 0;
  let heartbeatTimer = null;
  let lastFrameNotifyTime = 0;

  var SCREENCAST_OPTS = {
    format: 'jpeg',
    quality: 80,
    maxWidth: 1920,
    maxHeight: 1080,
    everyNthFrame: 1,
  };

  function startScreencast() {
    send('Page.startScreencast', SCREENCAST_OPTS);
    lastFrameTime = Date.now();
  }

  // Re-request screencast if no frames arrive for 3 seconds.
  // Chrome throttles/stops screencast for background pages, so
  // when a tab becomes visible again we need to re-start it.
  function startHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(function() {
      if (Date.now() - lastFrameTime > 3000 && socket && socket.readyState === WebSocket.OPEN) {
        console.log('[Screencast] No frames for 3s, re-requesting screencast');
        startScreencast();
      }
    }, 2000);
  }

  // Extract pageId from the WebSocket URL (last segment of path)
  var pageId = ${JSON.stringify(ws)}.split('/').pop() || '';

  // Listen for "activate" message from parent when this tab becomes
  // visible.  In headless Chrome, Page.bringToFront forces a
  // compositor update so the screencast produces a fresh frame.
  window.addEventListener('message', function(e) {
    if (e.data === 'screencast:activate') {
      console.log('[Screencast] Activated by parent, bringing page to front');
      send('Page.bringToFront');
      startScreencast();
    }
  });

  // Event tracking script – only captures click and keydown (scroll is
  // never used in interaction recording so we skip it to avoid overhead).
  // Uses textContent instead of innerText to avoid triggering layout reflow.
  var EVENT_TRACKING_SCRIPT = '(' + (function() {
    if (window.__bbEventListenerInjected) return;
    window.__bbEventListenerInjected = true;

    function reportEvent(data) {
      if (typeof window.__cdpEvent === 'function') {
        try { window.__cdpEvent(JSON.stringify(data)); } catch(e) {}
      }
    }

    function getElementSelector(el) {
      if (!el) return '';
      if (el.id) return '#' + el.id;
      var path = [];
      while (el && el.nodeType === 1) {
        var s = el.nodeName.toLowerCase();
        if (el.className && typeof el.className === 'string') {
          s += '.' + el.className.trim().split(/\s+/).join('.');
        }
        path.unshift(s);
        el = el.parentNode;
        if (path.length > 3) break;
      }
      return path.join(' > ');
    }

    function getElementInfo(el) {
      if (!el) return null;
      var text = (el.textContent || '').substring(0, 200);
      return {
        tagName: el.tagName || 'unknown',
        id: el.id || '',
        className: el.className || '',
        selector: getElementSelector(el),
        text: text,
        value: el.value || '',
        href: el.href || '',
        type: el.type || '',
        name: el.name || ''
      };
    }

    document.addEventListener('click', function(e) {
      reportEvent({
        type: 'click',
        x: e.clientX,
        y: e.clientY,
        target: getElementInfo(e.target),
        timestamp: Date.now()
      });
    }, true);

    document.addEventListener('keydown', function(e) {
      reportEvent({
        type: 'keydown',
        key: e.key,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
        target: getElementInfo(e.target),
        timestamp: Date.now()
      });
    }, true);
  }).toString() + ')()';

  function connect() {
    socket = new WebSocket(wsUrl);

    socket.onopen = function() {
      console.log('[Screencast] Connected to CDP');
      // Enable required domains
      send('Page.enable');
      send('DOM.enable');
      send('Runtime.enable');
      send('Input.setIgnoreInputEvents', { ignore: false });
      // Set up __cdpEvent binding so the page's init script can report
      // click/keydown/scroll events back through this CDP session.
      // This is critical for local browser because the frontend's separate
      // CDP connection may get disconnected when multiple clients connect
      // to the same /devtools/page/ endpoint.
      send('Runtime.addBinding', { name: '__cdpEvent' });
      // Inject event tracking script for current page and future navigations.
      // This ensures event listeners exist even if Playwright's addInitScript
      // didn't run on this tab (e.g. tabs created via CDP Target.createTarget).
      send('Page.addScriptToEvaluateOnNewDocument', { source: EVENT_TRACKING_SCRIPT });
      send('Runtime.evaluate', { expression: EVENT_TRACKING_SCRIPT });
      // Start screencast with good quality
      startScreencast();
      // In watch-only mode, skip the heartbeat so background tabs don't
      // re-request screencast and cause the parent to flip between tabs.
      if (!watchOnly) startHeartbeat();
    };

    socket.onmessage = function(event) {
      try {
        var msg = JSON.parse(event.data);

        if (msg.method === 'Page.screencastFrame') {
          var params = msg.params;
          sessionId = params.sessionId;
          lastFrameTime = Date.now();
          screencastWidth = params.metadata.deviceWidth;
          screencastHeight = params.metadata.deviceHeight;
          img.src = 'data:image/jpeg;base64,' + params.data;
          // Acknowledge the frame
          send('Page.screencastFrameAck', { sessionId: params.sessionId });
          // Notify parent that this page is receiving frames (throttled to ~1/s)
          var now = Date.now();
          if (now - lastFrameNotifyTime > 1000) {
            lastFrameNotifyTime = now;
            window.parent.postMessage({
              type: 'screencast:frame-received',
              pageId: pageId,
            }, '*');
          }
        }

        // Forward interaction events (click, keydown) to parent frame.
        // Scroll events are intentionally skipped – they are never used in
        // interaction recording and would cause unnecessary React re-renders.
        if (msg.method === 'Runtime.bindingCalled' && msg.params && msg.params.name === '__cdpEvent') {
          try {
            var eventData = JSON.parse(msg.params.payload);
            if (eventData.type === 'click' || eventData.type === 'keydown') {
              window.parent.postMessage({
                type: 'screencast:cdp-event',
                pageId: pageId,
                data: eventData,
              }, '*');
            }
          } catch(e) {}
        }

        // Forward frame navigation events so the parent can update the URL bar
        if (msg.method === 'Page.frameNavigated') {
          var frame = msg.params && msg.params.frame;
          if (frame && !frame.parentId) {
            window.parent.postMessage({
              type: 'screencast:frame-navigated',
              pageId: pageId,
              frame: { url: frame.url, id: frame.id, name: frame.name },
            }, '*');
          }
        }

        // Forward page load events so the parent can query title/favicon
        if (msg.method === 'Page.loadEventFired' || msg.method === 'Page.domContentEventFired') {
          window.parent.postMessage({
            type: 'screencast:page-loaded',
            pageId: pageId,
            event: msg.method,
          }, '*');
        }
      } catch(e) {
        // ignore
      }
    };

    socket.onclose = function() {
      console.log('[Screencast] WebSocket closed, reconnecting in 2s...');
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      setTimeout(connect, 2000);
    };

    socket.onerror = function(err) {
      console.error('[Screencast] WebSocket error:', err);
    };
  }

  function send(method, params) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ id: msgId++, method: method, params: params || {} }));
    }
  }

  // Convert page coordinates to CDP coordinates
  function toDeviceCoords(clientX, clientY) {
    var rect = img.getBoundingClientRect();
    // img uses object-fit: contain, so we need to calculate the actual rendered area
    var imgAspect = screencastWidth / screencastHeight;
    var boxAspect = rect.width / rect.height;
    var renderW, renderH, offsetX, offsetY;

    if (imgAspect > boxAspect) {
      // Image wider than box - letterboxed top/bottom
      renderW = rect.width;
      renderH = rect.width / imgAspect;
      offsetX = 0;
      offsetY = (rect.height - renderH) / 2;
    } else {
      // Image taller than box - pillarboxed left/right
      renderH = rect.height;
      renderW = rect.height * imgAspect;
      offsetX = (rect.width - renderW) / 2;
      offsetY = 0;
    }

    var x = (clientX - rect.left - offsetX) / renderW * screencastWidth;
    var y = (clientY - rect.top - offsetY) / renderH * screencastHeight;

    return { x: Math.round(x), y: Math.round(y) };
  }

  function getModifiers(e) {
    var m = 0;
    if (e.altKey) m |= 1;
    if (e.ctrlKey) m |= 2;
    if (e.metaKey) m |= 4;
    if (e.shiftKey) m |= 8;
    return m;
  }

  function getButtonFlag(button) {
    if (button === 0) return 1;  // left
    if (button === 1) return 4;  // middle
    if (button === 2) return 2;  // right
    return 0;
  }

  // Mouse events
  overlay.addEventListener('mousedown', function(e) {
    e.preventDefault();
    if (!screencastWidth) return;
    var coords = toDeviceCoords(e.clientX, e.clientY);
    send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: coords.x,
      y: coords.y,
      button: e.button === 0 ? 'left' : e.button === 1 ? 'middle' : 'right',
      buttons: getButtonFlag(e.button),
      clickCount: 1,
      modifiers: getModifiers(e),
    });
  });

  overlay.addEventListener('mouseup', function(e) {
    e.preventDefault();
    if (!screencastWidth) return;
    var coords = toDeviceCoords(e.clientX, e.clientY);
    send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: coords.x,
      y: coords.y,
      button: e.button === 0 ? 'left' : e.button === 1 ? 'middle' : 'right',
      buttons: 0,
      clickCount: 1,
      modifiers: getModifiers(e),
    });
  });

  overlay.addEventListener('mousemove', function(e) {
    if (!screencastWidth) return;
    var coords = toDeviceCoords(e.clientX, e.clientY);
    send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: coords.x,
      y: coords.y,
      modifiers: getModifiers(e),
    });
  });

  overlay.addEventListener('wheel', function(e) {
    e.preventDefault();
    if (!screencastWidth) return;
    var coords = toDeviceCoords(e.clientX, e.clientY);
    send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: coords.x,
      y: coords.y,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      modifiers: getModifiers(e),
    });
  }, { passive: false });

  // Keyboard events
  overlay.setAttribute('tabindex', '0');
  overlay.focus();

  // Modifier-only keys are skipped – their state is conveyed via the
  // "modifiers" bitmask on every other event.
  var MODIFIER_KEYS = { Shift: 1, Control: 1, Alt: 1, Meta: 1 };

  // Map special keys to the text they insert.
  var SPECIAL_KEY_TEXT = { Enter: '\\r', Tab: '\\t' };

  overlay.addEventListener('keydown', function(e) {
    e.preventDefault();
    if (MODIFIER_KEYS[e.key]) return;

    var text = e.key.length === 1 ? e.key : (SPECIAL_KEY_TEXT[e.key] || '');
    var mods = getModifiers(e);

    // Use "keyDown" with text for keys that produce text input – this
    // tells Chrome the keystroke is consumed as text and suppresses
    // internal shortcut handling (e.g. Space → scroll, Enter → chrome://help).
    // Use "rawKeyDown" only for non-text keys (arrows, F-keys, Escape, etc.).
    send('Input.dispatchKeyEvent', {
      type: text ? 'keyDown' : 'rawKeyDown',
      key: e.key,
      code: e.code,
      windowsVirtualKeyCode: e.keyCode,
      nativeVirtualKeyCode: e.keyCode,
      modifiers: mods,
      text: text,
      unmodifiedText: text,
    });
  });

  overlay.addEventListener('keyup', function(e) {
    e.preventDefault();
    if (MODIFIER_KEYS[e.key]) return;
    send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: e.key,
      code: e.code,
      windowsVirtualKeyCode: e.keyCode,
      nativeVirtualKeyCode: e.keyCode,
      modifiers: getModifiers(e),
    });
  });

  // Keep overlay focused for keyboard events
  overlay.addEventListener('click', function() {
    overlay.focus();
  });

  // Context menu prevention
  overlay.addEventListener('contextmenu', function(e) {
    e.preventDefault();
  });

  connect();
})();
</script>
</body>
</html>`;

  const headers = new Headers();
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');

  return new NextResponse(html, { headers });
}
