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

  function removeLegacyAccountUi() {
    document.getElementById('sw-account-link-section')?.remove();
    document.getElementById('sw-browser-profile-row')?.remove();
    document.querySelector('.sw-account-import-actions')?.remove();
    document.getElementById('welcome-cookie-warning')?.classList.add('hidden');
  }

  function esc(value) {
    return String(value || '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  }

  function accountText(info) {
    if (info?.connected && info.profile) return info.profile.displayName || info.profile.username || 'Bağlı hesap';
    if (!info?.configured) return 'OAuth uygulama bilgisi gerekli';
    return 'Henüz bağlanmadı';
  }

  function detailText(platform, info) {
    if (info?.connected) {
      if (info.lastValidatedAt) return `Gerçek OAuth oturumu • son kontrol ${new Date(info.lastValidatedAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}`;
      return 'Gerçek OAuth oturumu bağlı.';
    }
    if (!info?.configured) {
      if (platform === 'youtube') return 'Google Cloud Desktop OAuth Client ID gir.';
      if (platform === 'twitch') return 'Twitch Developer Client ID gir.';
      return 'Kick Developer Client ID + Client Secret gir.';
    }
    if (platform === 'twitch') return 'Bağla dediğinde Twitch izin sayfası normal tarayıcıda açılır.';
    return 'Bağla dediğinde platform izin sayfası normal tarayıcıda açılır.';
  }

  function statusBadge(info) {
    if (info?.connected) return ['Bağlı', 'ok'];
    if (!info?.configured) return ['Kurulum gerekli', 'setup'];
    return ['Bağlı değil', ''];
  }

  function avatarHtml(platform, info) {
    const url = info?.profile?.avatarUrl;
    if (url && /^https?:\/\//i.test(url)) return `<img class="sw-oauth-avatar" src="${esc(url)}" alt="${platforms[platform].name}">`;
    return `<div class="sw-oauth-avatar sw-oauth-avatar-fallback">${platforms[platform].short}</div>`;
  }

  function renderCards() {
    if (!lastStatus) return;
    for (const platform of Object.keys(platforms)) {
      const info = lastStatus.accounts?.[platform] || {};
      const card = document.querySelector(`[data-oauth-platform="${platform}"]`);
      if (!card) continue;
      const badge = card.querySelector('[data-oauth-status]');
      const [label, cls] = statusBadge(info);
      badge.textContent = label;
      badge.className = `sw-oauth-status ${cls}`;
      card.querySelector('[data-oauth-avatar-wrap]').innerHTML = avatarHtml(platform, info);
      card.querySelector('[data-oauth-user]').textContent = accountText(info);
      card.querySelector('[data-oauth-detail]').textContent = detailText(platform, info);
      const connect = card.querySelector('[data-oauth-connect]');
      const disconnect = card.querySelector('[data-oauth-disconnect]');
      connect.disabled = !info.configured || Boolean(info.busy);
      connect.style.display = info.connected ? 'none' : '';
      disconnect.style.display = info.connected ? '' : 'none';
    }
  }

  function fillConfig(config) {
    const section = document.getElementById('sw-oauth-section');
    if (!section) return;
    section.querySelector('#sw-oauth-youtube-id').value = config?.youtubeClientId || '';
    section.querySelector('#sw-oauth-twitch-id').value = config?.twitchClientId || '';
    section.querySelector('#sw-oauth-kick-id').value = config?.kickClientId || '';
    section.querySelector('#sw-oauth-youtube-secret').placeholder = config?.youtubeHasSecret ? 'Kayıtlı — değiştirmek için yeni değer gir' : 'İsteğe bağlı';
    section.querySelector('#sw-oauth-kick-secret').placeholder = config?.kickHasSecret ? 'Kayıtlı — değiştirmek için yeni değer gir' : 'Zorunlu';
    section.querySelector('[data-kick-redirect]').textContent = config?.kickRedirectUri || 'http://localhost:37651/oauth/kick/callback';
  }

  function setMessage(text, type = '') {
    const el = document.getElementById('sw-oauth-message');
    if (!el) return;
    el.textContent = text;
    el.className = `sw-oauth-message ${type}`;
  }

  async function refreshStatus(validate = false) {
    try {
      lastStatus = validate ? await api.validate() : await api.getStatus();
      renderCards();
      if (lastStatus?.config) fillConfig(lastStatus.config);
    } catch (error) {
      setMessage(error?.message || 'OAuth durumu alınamadı.', 'bad');
    }
  }

  async function saveConfig() {
    const section = document.getElementById('sw-oauth-section');
    const button = section?.querySelector('#sw-oauth-save-config');
    if (!section || !button) return;
    button.disabled = true;
    button.textContent = 'Kaydediliyor…';
    try {
      const config = await api.saveConfig({
        youtubeClientId: section.querySelector('#sw-oauth-youtube-id').value,
        youtubeClientSecret: section.querySelector('#sw-oauth-youtube-secret').value,
        twitchClientId: section.querySelector('#sw-oauth-twitch-id').value,
        kickClientId: section.querySelector('#sw-oauth-kick-id').value,
        kickClientSecret: section.querySelector('#sw-oauth-kick-secret').value,
      });
      fillConfig(config);
      section.querySelector('#sw-oauth-youtube-secret').value = '';
      section.querySelector('#sw-oauth-kick-secret').value = '';
      setMessage('OAuth uygulama bilgileri güvenli depolamaya kaydedildi.', 'good');
      await refreshStatus(false);
    } catch (error) {
      setMessage(error?.message || 'OAuth bilgileri kaydedilemedi.', 'bad');
    } finally {
      button.disabled = false;
      button.textContent = 'Kaydet';
    }
  }

  async function connect(platform, button) {
    button.disabled = true;
    const original = button.textContent;
    button.textContent = 'Tarayıcıdan izin bekleniyor…';
    setMessage(`${platforms[platform].name} izin akışı başlatılıyor…`);
    try {
      lastStatus = await api.connect(platform);
      renderCards();
      setMessage(`${platforms[platform].name} hesabı başarıyla StreamWatch'a bağlandı.`, 'good');
    } catch (error) {
      setMessage(error?.message || `${platforms[platform].name} bağlantısı başarısız.`, 'bad');
    } finally {
      button.disabled = false;
      button.textContent = original;
      await refreshStatus(false);
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
      button.disabled = false;
      button.textContent = original;
    }
  }

  function createSection() {
    removeLegacyAccountUi();
    if (document.getElementById('sw-oauth-section')) return true;
    const body = document.querySelector('#settings-panel .settings-body');
    if (!body) return false;

    const section = document.createElement('div');
    section.id = 'sw-oauth-section';
    section.className = 'settings-section sw-settings-card sw-settings-wide sw-oauth-section';
    section.innerHTML = `
      <h3>Hesaplar</h3>
      <div class="sw-oauth-heading">
        <div>
          <strong>Resmî OAuth ile bağlan</strong>
          <small>Çerez okunmaz ve tarayıcı eklentisi kullanılmaz. Bağla dediğinde normal tarayıcındaki açık hesap üzerinden platformun kendi izin ekranı açılır.</small>
        </div>
        <div class="sw-oauth-heading-actions">
          <button type="button" class="sw-oauth-btn" id="sw-oauth-refresh">Durumu Yenile</button>
          <button type="button" class="sw-oauth-btn" id="sw-oauth-config-toggle">OAuth Ayarları</button>
        </div>
      </div>
      <div class="sw-oauth-grid">
        ${Object.keys(platforms).map((platform) => `
          <article class="sw-oauth-card" data-oauth-platform="${platform}">
            <div class="sw-oauth-card-top">
              <div data-oauth-avatar-wrap>${avatarHtml(platform, null)}</div>
              <div class="sw-oauth-account-meta">
                <div class="sw-oauth-platform">${platforms[platform].name}</div>
                <div class="sw-oauth-user" data-oauth-user>Kontrol ediliyor…</div>
              </div>
              <span class="sw-oauth-status" data-oauth-status>Bağlı değil</span>
            </div>
            <div class="sw-oauth-card-detail" data-oauth-detail>OAuth durumu kontrol ediliyor…</div>
            <div class="sw-oauth-card-actions">
              <button type="button" class="sw-oauth-btn primary" data-oauth-connect="${platform}">Hesabı Bağla</button>
              <button type="button" class="sw-oauth-btn danger" data-oauth-disconnect="${platform}" style="display:none">Bağlantıyı Kopar</button>
            </div>
          </article>`).join('')}
      </div>
      <div class="sw-oauth-config hidden" id="sw-oauth-config">
        <div class="sw-oauth-config-intro">Bunlar platformların sana verdiği OAuth uygulama kimlikleridir. YouTube için Google Cloud'da <strong>Desktop app</strong>, Twitch için Developer Console'da uygulama, Kick için Developer ayarlarında uygulama oluştur. Twitch'te Client Secret kullanmıyoruz.</div>
        <div class="sw-oauth-config-grid">
          <div class="sw-oauth-field wide"><label>YouTube / Google Client ID</label><input id="sw-oauth-youtube-id" autocomplete="off" placeholder="...apps.googleusercontent.com"><div class="sw-oauth-help">Google OAuth client türü: Desktop app. StreamWatch localhost callback + PKCE kullanır.</div></div>
          <div class="sw-oauth-field"><label>YouTube Client Secret (isteğe bağlı)</label><input id="sw-oauth-youtube-secret" type="password" autocomplete="new-password"></div>
          <div class="sw-oauth-field"><label>Twitch Client ID</label><input id="sw-oauth-twitch-id" autocomplete="off"><div class="sw-oauth-help">Public Device Code Flow; secret gerekmez.</div></div>
          <div class="sw-oauth-field"><label>Kick Client ID</label><input id="sw-oauth-kick-id" autocomplete="off"></div>
          <div class="sw-oauth-field"><label>Kick Client Secret</label><input id="sw-oauth-kick-secret" type="password" autocomplete="new-password"></div>
          <div class="sw-oauth-field wide"><label>Kick Redirect URL</label><div class="sw-oauth-help"><code data-kick-redirect>http://localhost:37651/oauth/kick/callback</code> — Kick Developer uygulamasında Redirect URL olarak birebir bunu ekle.</div></div>
        </div>
        <div class="sw-oauth-config-actions"><button type="button" class="sw-oauth-btn primary" id="sw-oauth-save-config">Kaydet</button><div id="sw-oauth-message" class="sw-oauth-message">Hazır.</div></div>
        <div class="sw-oauth-security">Access/refresh tokenlar ve secret değerleri Electron safeStorage ile işletim sistemi şifrelemesi altında tutulur. Arayüz kaydedilmiş secret değerlerini geri göstermez.</div>
      </div>`;

    body.appendChild(section);

    section.querySelector('#sw-oauth-config-toggle').addEventListener('click', () => {
      section.querySelector('#sw-oauth-config').classList.toggle('hidden');
    });
    section.querySelector('#sw-oauth-refresh').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = 'Kontrol ediliyor…';
      try {
        await refreshStatus(true);
        setMessage('Hesap tokenları platformlardan doğrulandı.', 'good');
      } finally {
        button.disabled = false;
        button.textContent = 'Durumu Yenile';
      }
    });
    section.querySelector('#sw-oauth-save-config').addEventListener('click', saveConfig);
    section.querySelectorAll('[data-oauth-connect]').forEach((button) => {
      button.addEventListener('click', () => connect(button.dataset.oauthConnect, button));
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
    }, 250);
    setTimeout(() => clearInterval(timer), 20000);

    api.onState(async (event) => {
      if (event?.type === 'device-code' && event.platform === 'twitch') {
        const code = event.userCode ? ` Kod: ${event.userCode}` : '';
        setMessage(`Twitch izin sayfası tarayıcıda açıldı.${code}`, '');
      }
      await refreshStatus(false);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
