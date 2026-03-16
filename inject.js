// inject.js — Runs in the PAGE's main world (same JS context as the app).
// Intercepts fetch & XHR so we can see the raw API responses for tasks
// before the React app renders them, enabling real-time detection.
// Communicates back to content.js via window.postMessage.

(function () {
  'use strict';

  const MSG_TYPE = 'STAGECRAFT_API_DATA';

  function looksLikeTaskEndpoint(url) {
    if (!url) return false;
    const lower = url.toLowerCase();
    return (
      lower.includes('/task') ||
      lower.includes('/campaign') ||
      lower.includes('unclaimed') ||
      lower.includes('/work')
    );
  }

  function broadcast(url, data) {
    window.postMessage({ type: MSG_TYPE, url, data }, '*');
  }

  // ── Intercept fetch ────────────────────────────────────────────────────────
  const _fetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const response = await _fetch(input, init);
    try {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof Request
          ? input.url
          : '';
      if (looksLikeTaskEndpoint(url)) {
        response
          .clone()
          .json()
          .then((data) => broadcast(url, data))
          .catch(() => {});
      }
    } catch (_) {}
    return response;
  };

  // ── Intercept XMLHttpRequest ───────────────────────────────────────────────
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__stagecraftUrl = url;
    return _open.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      try {
        if (looksLikeTaskEndpoint(this.__stagecraftUrl)) {
          const data = JSON.parse(this.responseText);
          broadcast(this.__stagecraftUrl, data);
        }
      } catch (_) {}
    });
    return _send.apply(this, args);
  };

  console.debug('[Stagecraft Notifier] API interceptor active.');
})();
