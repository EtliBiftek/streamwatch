'use strict';

const PLATFORM_DOMAINS = {
  youtube: ['youtube.com', 'google.com', 'googleusercontent.com'],
  twitch: ['twitch.tv'],
  kick: ['kick.com'],
};

async function readCookies(platform) {
  const domains = PLATFORM_DOMAINS[platform];
  if (!domains) throw new Error('Desteklenmeyen platform.');

  const all = [];
  const seen = new Set();
  for (const domain of domains) {
    const cookies = await chrome.cookies.getAll({ domain });
    for (const cookie of cookies) {
      const key = [cookie.storeId, cookie.domain, cookie.path, cookie.name, JSON.stringify(cookie.partitionKey || null)].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      all.push({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        hostOnly: Boolean(cookie.hostOnly),
        path: cookie.path || '/',
        secure: Boolean(cookie.secure),
        httpOnly: Boolean(cookie.httpOnly),
        sameSite: cookie.sameSite || 'unspecified',
        session: Boolean(cookie.session),
        expirationDate: cookie.expirationDate,
        partitionKey: cookie.partitionKey || null,
      });
    }
  }
  return all;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'streamwatch-import-session') return;
  const senderUrl = sender?.tab?.url || sender?.url || '';
  if (!senderUrl.startsWith('http://127.0.0.1:')) {
    sendResponse({ ok: false, error: 'Geçersiz bağlantı kaynağı.' });
    return;
  }

  (async () => {
    try {
      const platform = String(message.platform || '').toLowerCase();
      const nonce = String(message.nonce || '');
      const port = Number(message.port || 0);
      if (!PLATFORM_DOMAINS[platform] || !nonce || port < 1 || port > 65535) {
        throw new Error('Geçersiz StreamWatch bağlantı isteği.');
      }

      const cookies = await readCookies(platform);
      const response = await fetch(`http://127.0.0.1:${port}/v1/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform, nonce, cookies }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.error) throw new Error(data.error || `StreamWatch HTTP ${response.status}`);
      sendResponse({ ok: true, imported: data.imported || 0, connected: Boolean(data.connected) });
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || 'Oturum aktarımı başarısız.' });
    }
  })();

  return true;
});
