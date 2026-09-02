(() => {
  if (window.__streamwatchAccountBridgeLoaded || !window.api?.accountBridge) return;
  window.__streamwatchAccountBridgeLoaded = true;

  const api = window.api;
  const platformNames = { youtube: 'YouTube', twitch: 'Twitch', kick: 'Kick' };
  const platformOrder = ['youtube', 'twitch', 'kick'];
  let lastBrowser = null;

  function statusLabel(info) {
    if (!info) return 'Bağlı değil';
    if (info.blocked) return 'Bağlantı kesildi';
    if (info.state === 'connected') return 'Bağlı';
    if (info.state === 'cookies') return 'Doğrulanamadı';
    return 'Bağlı değil';
  }

  function statusClass(info) {
    if (!info) return 'off';
    if (info.state === 'connected' && !info.blocked) return 'ok';
    if (info.state === 'cookies' && !info.blocked) return 'partial';
    return 'off';
  }

  function importMessage(state) {
    const current = state?.cookieImport;
    if (!current) return 'Henüz tarayıcı oturumu içe aktarılmadı.';
    if (current.status === 'success') {
      return `${current.profileName || current.profile || 'Profil'} • ${current.imported || 0} platform çerezi içe aktarıldı.`;
    }
    if (current.status === 'protected') {
      return 'Tarayıcı çerezleri bulundu fakat korumalı çerezler okunamadı. Platform kartlarında gerçek giriş durumu ayrı ayrı gösterilir; gerekirse StreamWatch İçinde Giriş kullan.';
    }
    if (current.status === 'unsupported') return 'Bu tarayıcı için doğrudan çerez aktarımı desteklenmiyor.';
    if (current.error) return `Oturum aktarımı başarısız: ${current.error}`;
    return 'Bu profilde kullanılabilir platform oturumu bulunamadı.';
  }

  async function refreshProfiles(force = false) {
    const browserSelect = document.getElementById('sw-browser-setting-select');
    const profileSelect = document.getElementById('sw-browser-profile-select');
    if (!browserSelect || !profileSelect) return;
    const browser = browserSelect.value;
    if (!browser || (!force && browser === lastBrowser && profileSelect.options.length)) return;
    lastBrowser = browser;

    profileSelect.disabled = true;
    profileSelect.innerHTML = '<option>Profiller aranıyor…</option>';
    try {
      const profiles = await api.accountBridge.getProfiles(browser);
      const state = await api.accountBridge.getStatus();
      profileSelect.innerHTML = '';
      if (!profiles.length) {
        profileSelect.innerHTML = '<option value="">Profil bulunamadı</option>';
        profileSelect.disabled = true;
        return;
      }
      profiles.forEach((profile) => {
        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = `${profile.name}${profile.lastUsed ? ' • son kullanılan' : ''}`;
        profileSelect.appendChild(option);
      });
      const current = state?.selectedProfile?.id || state?.selectedProfile;
      if (current && profiles.some((profile) => profile.id === current)) profileSelect.value = current;
      else profileSelect.value = profiles[0].id;
      profileSelect.disabled = false;
    } catch {
      profileSelect.innerHTML = '<option value="">Profil okunamadı</option>';
      profileSelect.disabled = true;
    }
  }

  function ensureBrowserProfileControls() {
    const section = document.getElementById('sw-browser-setting-section');
    if (!section || document.getElementById('sw-browser-profile-row')) return false;
    const row = section.querySelector('.sw-browser-setting-row');
    if (!row) return false;

    const profileRow = document.createElement('div');
    profileRow.id = 'sw-browser-profile-row';
    profileRow.className = 'sw-browser-setting-row sw-account-profile-row';
    profileRow.innerHTML = `
      <div>
        <strong>Tarayıcı profili</strong>
        <small>Default yerine gerçekten kullandığın Brave/Chrome profilini seçebilirsin.</small>
      </div>
      <select id="sw-browser-profile-select" aria-label="Tarayıcı profili seç"></select>`;
    row.insertAdjacentElement('afterend', profileRow);

    const actions = document.createElement('div');
    actions.className = 'sw-account-import-actions';
    actions.innerHTML = `
      <button type="button" id="sw-account-refresh-cookies" class="sw-account-secondary-btn">Oturumu Yenile</button>
      <span id="sw-account-import-note">Tarayıcı oturumu kontrol ediliyor…</span>`;
    profileRow.insertAdjacentElement('afterend', actions);

    const browserSelect = document.getElementById('sw-browser-setting-select');
    const profileSelect = profileRow.querySelector('#sw-browser-profile-select');
    browserSelect?.addEventListener('change', () => setTimeout(() => refreshProfiles(true), 150));
    profileSelect.addEventListener('change', async () => {
      profileSelect.disabled = true;
      try {
        await api.accountBridge.selectProfile(document.getElementById('sw-browser-setting-select')?.value, profileSelect.value);
        await refreshStatus();
      } finally {
        profileSelect.disabled = false;
      }
    });
    actions.querySelector('#sw-account-refresh-cookies').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = 'Yenileniyor…';
      try {
        await api.accountBridge.refresh();
        await refreshStatus();
      } finally {
        button.disabled = false;
        button.textContent = 'Oturumu Yenile';
      }
    });
    refreshProfiles(true);
    return true;
  }

  function ensureAccountsSection() {
    if (document.getElementById('sw-account-link-section')) return true;
    const body = document.querySelector('#settings-panel .settings-body');
    if (!body) return false;

    const section = document.createElement('div');
    section.id = 'sw-account-link-section';
    section.className = 'settings-section sw-settings-card sw-settings-wide sw-account-section';
    section.innerHTML = `
      <h3>Hesaplar</h3>
      <div class="sw-account-heading">
        <div>
          <strong>Platform hesaplarını bağla</strong>
          <small>Bağlı durumu yalnızca gerçek giriş çerezleri bulunduğunda gösterilir. Bağlantıyı Kopar StreamWatch oturumunu kalıcı olarak kaldırır.</small>
        </div>
      </div>
      <div class="sw-account-grid">
        ${platformOrder.map((platform) => `
          <article class="sw-account-card" data-platform="${platform}">
            <div class="sw-account-card-top">
              <div class="sw-account-platform">${platformNames[platform]}</div>
              <span class="sw-account-status off" data-account-status>Bağlı değil</span>
            </div>
            <div class="sw-account-cookie-count" data-cookie-count>Oturum kontrol ediliyor…</div>
            <div class="sw-account-buttons">
              <button type="button" class="sw-account-primary-btn" data-account-portal>Yerel Sitede Bağla</button>
              <button type="button" class="sw-account-secondary-btn" data-account-internal>StreamWatch'ta Giriş Yap</button>
              <button type="button" class="sw-account-secondary-btn" data-account-disconnect>Bağlantıyı Kopar</button>
            </div>
          </article>`).join('')}
      </div>
      <div class="sw-account-footnote">Bağlantıyı Kopar yalnızca StreamWatch'ın kalıcı oturumunu temizler; Chrome/Brave/Twitch/Kick/YouTube hesabından çıkış yapmaz. Tekrar bağlanmak istediğinde giriş düğmelerinden birini kullan.</div>`;

    body.appendChild(section);

    section.querySelectorAll('[data-account-portal]').forEach((button) => {
      button.addEventListener('click', async () => {
        const card = button.closest('[data-platform]');
        const platform = card?.dataset.platform;
        if (!platform) return;
        button.disabled = true;
        button.textContent = 'Yerel site açılıyor…';
        try {
          const result = await api.accountBridge.openPortal(platform);
          if (result?.error) throw new Error(result.error);
        } finally {
          setTimeout(() => {
            if (!button.isConnected) return;
            button.disabled = false;
            button.textContent = 'Yerel Sitede Bağla';
          }, 1200);
        }
      });
    });

    section.querySelectorAll('[data-account-internal]').forEach((button) => {
      button.addEventListener('click', async () => {
        const card = button.closest('[data-platform]');
        const platform = card?.dataset.platform;
        if (!platform) return;
        await api.accountBridge.allowPlatform(platform);
        await api.accountBridge.openInternal(platform);
        await refreshStatus();
      });
    });

    section.querySelectorAll('[data-account-disconnect]').forEach((button) => {
      button.addEventListener('click', async () => {
        const card = button.closest('[data-platform]');
        const platform = card?.dataset.platform;
        if (!platform) return;
        button.disabled = true;
        button.textContent = 'Koparılıyor…';
        try {
          await api.accountBridge.disconnect(platform);
          await refreshStatus();
        } finally {
          if (!button.isConnected) return;
          button.textContent = 'Bağlantıyı Kopar';
        }
      });
    });
    return true;
  }

  async function refreshStatus() {
    try {
      const current = await api.accountBridge.getStatus();
      const note = document.getElementById('sw-account-import-note');
      if (note) note.textContent = importMessage(current);
      for (const platform of platformOrder) {
        const card = document.querySelector(`#sw-account-link-section [data-platform="${platform}"]`);
        if (!card) continue;
        const info = current?.platforms?.[platform] || { state: 'none', cookieCount: 0 };
        const badge = card.querySelector('[data-account-status]');
        badge.textContent = statusLabel(info);
        badge.className = `sw-account-status ${statusClass(info)}`;
        const detail = card.querySelector('[data-cookie-count]');
        detail.textContent = info.detail || (info.cookieCount ? `${info.cookieCount} oturum çerezi mevcut` : 'Bağlı bir oturum bulunamadı.');
        const disconnect = card.querySelector('[data-account-disconnect]');
        if (disconnect) disconnect.disabled = Boolean(info.blocked);
      }
    } catch { }
  }

  function init() {
    const timer = setInterval(() => {
      const browserReady = ensureBrowserProfileControls();
      const accountsReady = ensureAccountsSection();
      if (browserReady && accountsReady) {
        clearInterval(timer);
        refreshStatus();
      }
    }, 250);
    setTimeout(() => clearInterval(timer), 20000);

    api.accountBridge.onState(() => {
      refreshStatus();
      refreshProfiles(false);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
