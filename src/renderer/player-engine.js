(() => {
  if (window.__streamwatchPlayerEngineLoaded || !window.api) return;
  window.__streamwatchPlayerEngineLoaded = true;

  const api = window.api;
  const ENGINE_LABELS = {
    embedded: 'Dahili Player',
    mpv: 'MPV + Streamlink',
    vlc: 'VLC + Streamlink',
  };

  let previewTimer = null;
  let previewItem = null;

  const esc = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

  async function installPlayerEngineSetting() {
    if (document.getElementById('swx-player-engine-setting')) return true;
    const settingsBody = document.querySelector('#settings-panel .settings-body');
    if (!settingsBody) return false;

    const section = document.getElementById('sw-feature-settings');
    if (!section) return false;

    const row = document.createElement('div');
    row.id = 'swx-player-engine-setting';
    row.className = 'sw-setting-row swx-player-engine-setting';
    row.innerHTML = `
      <div class="swx-player-engine-copy">
        <strong>Player Engine</strong>
        <small>Dahili player veya Streamlink üzerinden MPV/VLC kullan.</small>
      </div>
      <div class="swx-player-engine-controls">
        <select id="swx-player-engine-select" class="swx-player-engine-select" aria-label="Player engine">
          <option value="embedded">Dahili Player</option>
          <option value="mpv">MPV + Streamlink</option>
          <option value="vlc">VLC + Streamlink</option>
        </select>
        <small class="swx-player-engine-note">Harici seçenekler için Streamlink ve siçilen player kurulu olmalı.</small>
      </div>`;

    const lightweight = document.getElementById('swx-lightweight-setting');
    if (lightweight?.parentElement === section) section.insertBefore(row, lightweight);
    else section.appendChild(row);

    const select = row.querySelector('#swx-player-engine-select');
    const current = await api.getStore('playerEngine') || 'embedded';
    select.value = ENGINE_LABELS[current] ? current : 'embedded';
    updateEngineNotice(select.value);

    select.addEventListener('change', async () => {
      const value = ENGINE_LABELS[select.value] ? select.value : 'embedded';
      await api.setStore('playerEngine', value);
      if (value !== 'embedded') {
        await api.closeEmbeddedBrowser();
        api.hideBrowser();
      } else {
        api.showBrowser();
      }
      updateEngineNotice(value);
    });
    return true;
  }

  function ensureEngineNotice() {
    const welcome = document.getElementById('welcome-screen');
    if (!welcome) return null;
    let notice = document.getElementById('swx-player-engine-notice');
    if (notice) return notice;
    notice = document.createElement('div');
    notice.id = 'swx-player-engine-notice';
    notice.className = 'swx-player-engine-notice hidden';
    welcome.appendChild(notice);
    return notice;
  }

  function updateEngineNotice(engine) {
    const notice = ensureEngineNotice();
    if (!notice) return;
    if (engine === 'embedded') {
      notice.classList.add('hidden');
      return;
    }
    notice.innerHTML = `<span class="swx-engine-dot"></span><div><strong>${esc(ENGINE_LABELS[engine])}</strong><small>Yayınlar ayrı player penceresinde açılır.</small></div>`;
    notice.classList.remove('hidden');
  }

  async function keepWelcomeVisibleForExternalPlayer() {
    const welcome = document.getElementById('welcome-screen');
    if (!welcome) return;
    const engine = await api.getStore('playerEngine') || 'embedded';
    updateEngineNotice(engine);
    if (engine === 'embedded') return;
    if (welcome.classList.contains('hidden')) {
      welcome.classList.remove('hidden');
      api.hideBrowser();
    }
  }

  function removePreviewShell() {
    clearTimeout(previewTimer);
    previewTimer = null;
    previewItem = null;
    document.getElementById('swx-hover-preview-shell')?.remove();
  }

  async function showPreviewShell(item) {
    if (!item?.isConnected || document.body.classList.contains('sw-lightweight')) return;
    const channelId = item.dataset.id;
    if (!channelId) return;
    const channels = await api.getChannels() || [];
    const channel = channels.find((entry) => entry.id === channelId);
    if (!channel) return;

    const platform = ['youtube', 'twitch', 'kick'].find((key) => channel.isLive?.[key] && channel[key])
      || ['youtube', 'twitch', 'kick'].find((key) => channel[key]);
    if (!platform) return;

    removePreviewShell();
    previewItem = item;

    const width = 376;
    const videoHeight = 212;
  const headerHeight = 40;
    const totalHeight = videoHeight + headerHeight;
    const rect = item.getBoundingClientRect();
    const x = Math.min(Math.max(8, rect.right + 8), Math.max(8, window.innerWidth - width - 8));
    const y = Math.min(Math.max(42, rect.top), Math.max(42, window.innerHeight - totalHeight - 8));
    const isLive = Boolean(channel.isLive?.[platform]);
    const platformName = platform === 'youtube' ? 'YouTube' : platform === 'twitch' ? 'Twitch' : 'Kick';

    const shell = document.createElement('div');
    shell.id = 'swx-hover-preview-shell';
    shell.className = 'swx-hover-preview-shell';
    shell.style.left = `${x}px`;
    shell.style.top = `${y}px`;
    shell.style.width = `${width}px`;
    shell.style.height = `${totalHeight}px`;
    shell.innerHTML = `
      <div class="swx-hover-preview-head">
        <span class="swx-hover-preview-avatar">${channel.avatarUrl ? `<img src="${esc(channel.avatarUrl)}" alt="">` : esc(channel.name?.charAt(0)?.toUpperCase() || '?')}</span>
        <div class="swx-hover-preview-copy">
          <strong>${esc(channel.name || 'Yayın'i}</strong>
          <small>${esc(platformName)}</small>
        </div>
        <span class="swx-hover-preview-live ${isLive ? '' : 'offline'}">${isLive ? 'CANLI' : 'ÖNİZLEME'}</span>
      </div>
      <div class="swx-hover-preview-video"><span>Yayın hazırlanıyor…</span></div>`;
    document.body.appendChild(shell);
  }

  function installPreviewShellHooks() {
    document.addEventListener('mouseover', (event) => {
      const item = event.target.closest?.('.channel-item');
      if (!item || item.contains(event.relatedTarget)) return;
      clearTimeout(previewTimer);
      previewItem = item;
      previewTimer = setTimeout(() => {
        if (previewItem === item) showPreviewShell(item);
      }, 610);
    }, true);

    document.addEventListener('mouseout', (event) => {
      const item = event.target.closest?.('.channel-item');
      if (!item || item.contains(event.relatedTarget)) return;
      if (previewItem === item) removePreviewShell();
    }, true);

    document.addEventListener('contextmenu', removePreviewShell, true);
    window.addEventListener('blur', removePreviewShell);
  }

  function watchWelcomeState() {
    const welcome = document.getElementById('welcome-screen');
    if (!welcome) return;
    const observer = new MutationObserver(() => {
      if (welcome.classList.contains('hidden')) {
        setTimeout(keepWelcomeVisibleForExternalPlayer, 80);
      }
    });
    observer.observe(welcome, { attributes: true, attributeFilter: ['class'] });
  }

  async function init() {
    installPreviewShellHooks();
    watchWelcomeState();
    updateEngineNotice(await api.getStore('playerEngine') || 'embedded');

    const timer = setInterval(async () => {
      if (await installPlayerEngineSetting()) interval();
    }, 250);
    setTimeout(() => clearInterval(timer), 10000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
