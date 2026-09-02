'use strict';

(() => {
  const url = new URL(location.href);
  if (url.pathname !== '/streamwatch-session-bridge') return;

  const platform = url.searchParams.get('platform');
  const nonce = url.searchParams.get('nonce');
  const port = Number(url.port || 0);
  if (!platform || !nonce || !port) return;

  chrome.runtime.sendMessage({
    type: 'streamwatch-import-session',
    platform,
    nonce,
    port,
  }).then((result) => {
    window.postMessage({
      source: 'streamwatch-browser-bridge',
      type: 'result',
      result,
    }, location.origin);
  }).catch((error) => {
    window.postMessage({
      source: 'streamwatch-browser-bridge',
      type: 'result',
      result: { ok: false, error: error?.message || 'Eklenti yanıt vermedi.' },
    }, location.origin);
  });
})();
