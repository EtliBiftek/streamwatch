(() => {
  if (window.__streamwatchAccountBridgeLoaded || !window.api?.accountBridge) return;
  window.__streamwatchAccountBridgeLoaded = true;

  const api = window.api;
  const platformNames = { youtube: 'YouTube', twitch: 'Twitch', kick: 'Kick' };
  const platformOrder = ['youtube', 'twitch', 'kick'];
  let lastBrowser = null;

  function statusLabel(info) {
    if (!info) return 'Bağlı değil';
    if (info.state === 'connected') return 'Bağlı';
    if (info.state === 'cookies') return 'Oturum verisi bulundu';
    return 'Bağlı değil';
  }

  function statusClass(info) {
    if (!info) return 'off';
    if (info.state === 'connected') return 'ok';
    if (info.state === 'cookies') return 'partial';
    return 'off';
  }

  function importMessage(state) {
    const current = state?.cookieImport;
    if (!current) return 'Henüz tarayıcı oturumu içe aktarılmadı.';
    if (current.status === 'success') {
      return `${current.profileName || current.profile || 'Profil'} • ${current.imported || 0} oturum çerezi içe aktarıldı.`;
    }
    if (current.status === 'protected') {
      return 'Tarayıcı çerezleri bulundu ancak bazıları tarayıcı koruması nedeniyle okunamadı. Aşağıdaki StreamWatch girişi kullanılabilir.';
    }
    if (current.status === 'unsupported') return 'Bu tarayıcı için doğrudan çerez aktarımı desteklenmiyor.';
    if (current.error) return `Oturum aktarımı başarısız: ${current.error}`;
    return 'Bu profilde kullanılabilir oturum bulunamadı.';
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
      const current = state?.selectedProfile?.id;
      if (current && profiles.some((profile) => profile.id === current)) profileSelect.value = current;
      else profileSelect.value = profiles[0].id;
      profileSelect.disabled = false;
    } catch (error) {
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
          <small>Harici tarayıcıda giriş yapıp oturumu otomatik içe aktarabilir veya StreamWatch'ın kendi oturumunda bir kez giriş yapabilirsin.</small>
        </div>
      </div>
      <div class="sw-account-grid">
        ${platformOrder.map((platform) => `
          <article class="sw-account-card" data-platform="${platform}">
            <div class="sw-account-card-top">
              <div class="sw-account-platform">${platformNames[platform]}</div>
              <span class="sw-account-status off" data-account-status>Bağlı değil</span>
            </div>
            <div class="sw-account-cookie-count" data-cookie-count>Oturum verisi yok</div>
            <div class="sw-account-buttons">
              <button type="button" class="sw-account-primary-btn" data-account-external>Tarayıcıda Bağla</button>
              <button type="button" class="sw-account-secondary-btn" data-account-internal>StreamWatch'ta Giriş Yap</button>
            </div>
          </article>`).join('')}
      </div>
      <div class="sw-account-footnote">Harici bağlantı seçtiğin tarayıcı ve profili açar. Giriş yaptıktan sonra StreamWatch oturumu kısa aralıklarla otomatik yeniler.</div>`;

    body.appendChild(section);

    section.querySelectorAll('[data-account-external]').forEach((button) => {
      button.addEventListener('click', async () => {
        const card = button.closest('[data-platform]');
        const platform = card?.dataset.platform;
        if (!platform) return;
        button.disabled = true;
        button.textContent = 'Tarayıcı açılıyor…';
        try {
          const result = await api.accountBridge.openExternal(platform);
          if (result?.error) throw new Error(result.error);
          button.textContent = 'Girişi Tamamla';
          setTimeout(() => { if (button.isConnected) { button.disabled = false; button.textContent = 'Tarayıcıda Bağla'; } }, 5000);
        } catch (error) {
          button.disabled = false;
          button.textContent = 'Tarayıcıda Bağla';
        }
      });
    });

    section.querySelectorAll('[data-account-internal]').forEach((button) => {
      button.addEventListener('click', async () => {
        const card = button.closest('[data-platform]');
        const platform = card?.dataset.platform;
        if (!platform) return;
        await api.accountBridge.openInternal(platform);
      });
    });
    return true;
  }

  async function refreshStatus(state) {
    try {
      const current = state || await api.accountBridge.getStatus();
      const note = document.getElementById('sw-account-import-note');
      if (note) note.textContent = importMessage(current);
      for (const platform of platformOrder) {
        const card = document.querySelector(`#sw-account-link-section [data-platform="${platform}"]`);
        if (!card) continue;
        const info = current?.platforms?.[platform] || { state: 'none', cookieCount: 0 };
        const badge = card.querySelector('[data-account-status]');
        badge.textContent = statusLabel(info);
        badge.className = `sw-account-status ${statusClass(info)}`;
        const count = card.querySelector('[data-cookie-count]');
        count.textContent = info.cookieCount ? `${info.cookieCount} oturum çerezi mevcut` : 'Oturum verisi yok';
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

    api.accountBridge.onState((state) => {
      refreshStatus(state);
      refreshProfiles(false);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
