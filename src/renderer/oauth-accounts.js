(() => {
  if (window.__streamwatchOAuthAccountsLoaded || !window.api?.oauthAccounts) return;
  window.__streamwatchOAuthAccountsLoaded = true;

  const api = window.api.oauthAccounts;
  const platforms = {
    youtube: { name: 'YouTube', short: 'YT' },
    twitch: { name: 'Twitch', short: 'TW' },
    kick: { name: 'Kick', short: 'K' },
  };
  let lastStatus = null;
  let hubOpening = false;

  function removeLegacyAccountUi() {
    document.getElementById('sw-account-link-section')?.remove();
    document.getElementById('sw-browser-profile-row')?.remove();
    document.querySelector('.sw-account-import-actions')?.remove();
    document.getElementById('welcome-cookie-warning')?.classList.add('hidden');
    document.getElementById('sw-oauth-config')?.remove();
    document.getElementById('sw-oauth-config-toggle')?.remove();
  }

  function esc(value) {
    return String(value || '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  }

  function setMessage(text, type = '') {
    const el = document.getElementById('sw-oauth-message');
    if (!el) return;
    el.textContent = text;
    el.className = `sw-oauth-message ${type}`;
  }

  function avatarHtml(platform, info) {
    const url = info?.profile?.avatarUrl;
    if (url && /^https?:\/\//i.test(url)) {
      return `<img class="sw-oauth-avatar" src="${esc(url)}" alt="${platforms[platform].name}">`;
    }
    return `<div class="sw-oauth-avatar sw-oauth-avatar-fallback">${platforms[platform].short}</div>`;
  }

  function accountLabel(info) {
    if (info?.connected) return info.profile?.displayName || info.profile?.username || 'Bağlı hesap';
    if (info?.busy) return 'İzin bekleniyor…';
    return 'Bağlı değil';
  }

  function renderCards() {
    if (!lastStatus) return;
    for (const platform of Object.keys(platforms)) {
      const info = lastStatus.accounts?.[platform] || {};
      const row = document.querySelector(`[data-oauth-platform="${platform}"]`);
      if (!row) continue;

      row.querySelector('[data-oauth-avatar-wrap]').innerHTML = avatarHtml(platform, info);
      row.querySelector('[data-oauth-user]').textContent = accountLabel(info);

      const badge = row.querySelector('[data-oauth-status]');
      badge.textContent = info.connected ? 'Bağlı' : info.busy ? 'Bekleniyor' : 'Bağlı değil';
      badge.className = `sw-oauth-status ${info.connected ? 'ok' : info.busy ? 'pending' : ''}`;

      const disconnect = row.querySelector('[data-oauth-disconnect]');
      disconnect.hidden = !info.connected;
      disconnect.disabled = Boolean(info.busy);
    }
  }

  async function refreshStatus(validate = false) {
    try {
      lastStatus = validate ? await api.validate() : await api.getStatus();
      renderCards();
    } catch (error) {
      setMessage(error?.message || 'Hesap durumu alınamadı.', 'bad');
    }
  }

  async function openHub(button) {
    if (hubOpening) return;
    hubOpening = true;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = 'Açılıyor…';
    try {
      const result = await api.openHub();
      if (result?.error) throw new Error(result.error);
      setMessage('StreamWatch Connect tarayıcıda açıldı. Platformu seçip resmî izin ekranında onay ver.', 'good');
    } catch (error) {
      setMessage(error?.message || 'Bağlantı merkezi açılamadı.', 'bad');
    } finally {
      hubOpening = false;
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = original;
      }
    }
  }

  async function disconnect(platform, button) {
    button.disabled = true;
    const original = button.textContent;
    button.textContent = 'Koparılıyor…';
    try {
      lastStatus = await api.disconnect(platform);
      renderCards();
      setMessage(`${platforms[platform].name} bağlantısı kaldırıldı.`, 'good');
    } catch (error) {
      setMessage(error?.message || `${platforms[platform].name} bağlantısı kaldırılamadı.`, 'bad');
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = original;
      }
    }
  }

  function createSection() {
    removeLegacyAccountUi();
    if (document.getElementById('sw-oauth-section')) return true;
    const body = document.querySelector('#settings-panel .settings-body');
    if (!body) return false;

    const section = document.createElement('section');
    section.id = 'sw-oauth-section';
    section.className = 'settings-section sw-oauth-section';
    section.innerHTML = `
      <div class="sw-oauth-shell">
        <div class="sw-oauth-heading">
          <div class="sw-oauth-copy">
            <h3>Hesaplar</h3>
            <p>YouTube, Twitch ve Kick hesaplarını StreamWatch Connect üzerinden resmî OAuth ile bağla. Şifre, token veya geliştirici anahtarı girmen gerekmez.</p>
          </div>
          <div class="sw-oauth-heading-actions">
            <button type="button" class="sw-oauth-btn primary" id="sw-oauth-open-connect-hub">Hesapları Bağla</button>
            <button type="button" class="sw-oauth-btn" id="sw-oauth-refresh">Durumu Yenile</button>
          </div>
        </div>

        <div class="sw-oauth-list">
          ${Object.keys(platforms).map((platform) => `
            <div class="sw-oauth-row" data-oauth-platform="${platform}">
              <div data-oauth-avatar-wrap>${avatarHtml(platform, null)}</div>
              <div class="sw-oauth-account-meta">
                <div class="sw-oauth-platform">${platforms[platform].name}</div>
                <div class="sw-oauth-user" data-oauth-user>Kontrol ediliyor…</div>
              </div>
              <span class="sw-oauth-status" data-oauth-status>Bağlı değil</span>
              <button type="button" class="sw-oauth-btn danger sw-oauth-disconnect" data-oauth-disconnect="${platform}" hidden>Bağlantıyı Kopar</button>
            </div>`).join('')}
        </div>

        <div class="sw-oauth-footer">
          <div id="sw-oauth-message" class="sw-oauth-message">Tarayıcı eklentisi kullanılmaz; çerez veya parola okunmaz.</div>
          <div class="sw-oauth-security-dot"><span></span>Resmî OAuth</div>
        </div>
      </div>`;

    body.prepend(section);

    section.querySelector('#sw-oauth-open-connect-hub').addEventListener('click', (event) => openHub(event.currentTarget));
    section.querySelector('#sw-oauth-refresh').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const original = button.textContent;
      button.disabled = true;
      button.textContent = 'Kontrol ediliyor…';
      try {
        await refreshStatus(true);
        setMessage('Bağlı hesaplar doğrulandı.', 'good');
      } finally {
        button.disabled = false;
        button.textContent = original;
      }
    });
    section.querySelectorAll('[data-oauth-disconnect]').forEach((button) => {
      button.addEventListener('click', () => disconnect(button.dataset.oauthDisconnect, button));
    });

    refreshStatus(false);
    return true;
  }

  function init() {
    removeLegacyAccountUi();
    const timer = setInterval(() => {
      removeLegacyAccountUi();
      if (createSection()) clearInterval(timer);
    }, 200);
    setTimeout(() => clearInterval(timer), 20000);

    api.onState(async () => {
      await refreshStatus(false);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();