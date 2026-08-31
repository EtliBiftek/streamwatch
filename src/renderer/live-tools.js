(() => {
  if (window.__streamwatchLiveToolsLoaded || !window.api?.liveTools) return;
  window.__streamwatchLiveToolsLoaded = true;

  const api = window.api;
  const fx = api.features;
  const live = api.liveTools;
  let chatActive = false;

  const esc = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

  function titleButton() {
    if (document.getElementById('sw-live-chat-btn')) return;
    const controls = document.getElementById('titlebar-controls');
    const settings = document.getElementById('btn-settings-titlebar');
    if (!controls) return;

    const button = document.createElement('button');
    button.id = 'sw-live-chat-btn';
    button.className = 'titlebar-btn sw-live-chat-btn';
    button.title = 'Sohbeti Aç';
    button.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/><path d="M8 9h8M8 13h5"/></svg>';
    controls.insertBefore(button, settings || controls.firstChild);
    button.addEventListener('click', async () => {
      if (chatActive) {
        await live.closeChat();
        return;
      }
      const media = await fx.getCurrentMedia();
      const entry = media?.mode === 'single' ? media.entry : media?.entries?.[0];
      if (!entry?.url) {
        alert('Sohbet için önce bir yayın açmalısınız.');
        return;
      }
      const result = await live.openChat(entry);
      if (result?.error) alert(result.error);
    });
  }

  function applyChatState(state) {
    chatActive = Boolean(state?.active);
    const button = document.getElementById('sw-live-chat-btn');
    if (!button) return;
    button.classList.toggle('active', chatActive);
    button.title = chatActive ? 'Sohbeti Kapat' : 'Sohbeti Aç';
  }

  function statusBadge(label, item) {
    const ok = Boolean(item?.installed);
    return `<span class="sw-player-status-badge ${ok ? 'ok' : 'missing'}" title="${esc(item?.path || 'Bulunamadı')}"><span></span>${esc(label)} ${ok ? '✓' : '✕'}</span>`;
  }

  async function refreshPlayerStatus() {
    const status = await api.playerEngineStatus();
    const target = document.getElementById('sw-player-status-list');
    if (!target) return;
    target.innerHTML = [
      statusBadge('Streamlink', status?.streamlink),
      statusBadge('MPV', status?.mpv),
      statusBadge('VLC', status?.vlc),
    ].join('');
  }

  async function bindAdvancedFields(root) {
    const defaults = {
      streamlinkQuality: 'best',
      streamlinkTransport: 'default',
      streamlinkLowLatency: false,
      streamlinkHlsLiveEdge: 3,
      streamlinkSegmentThreads: 1,
      streamlinkRetryOpen: 3,
      streamlinkRetryStreams: 2,
      streamlinkRetryMax: 5,
      streamlinkPlayerArgs: '',
    };

    for (const [key, fallback] of Object.entries(defaults)) {
      const element = root.querySelector(`[data-store-key="${key}"]`);
      if (!element) continue;
      const stored = await api.getStore(key);
      const value = stored === undefined || stored === null ? fallback : stored;
      if (element.type === 'checkbox') element.checked = Boolean(value);
      else element.value = String(value);
      element.addEventListener('change', () => {
        const next = element.type === 'checkbox'
          ? element.checked
          : element.type === 'number'
            ? Number(element.value)
            : element.value;
        api.setStore(key, next);
      });
    }
  }

  async function installSettings() {
    if (document.getElementById('sw-live-tools-settings')) return true;
    const body = document.querySelector('#settings-panel .settings-body');
    if (!body) return false;
    const section = document.getElementById('sw-feature-settings') || body.lastElementChild;
    if (!section) return false;

    const wrapper = document.createElement('div');
    wrapper.id = 'sw-live-tools-settings';
    wrapper.className = 'sw-live-tools-settings';
    wrapper.innerHTML = `
      <div class="sw-setting-row sw-player-status-row">
        <div>
          <strong>Player Durumu</strong>
          <small>Streamlink, MPV ve VLC kurulumlarını kontrol eder.</small>
        </div>
        <div class="sw-player-status-side">
          <div id="sw-player-status-list" class="sw-player-status-list"></div>
          <button id="sw-player-status-refresh" class="sw-mini-button">Yenile</button>
        </div>
      </div>
      <details class="sw-streamlink-advanced">
        <summary>
          <div><strong>Streamlink Gelişmiş Ayarları</strong><small>Kalite, düşük gecikme, transport, retry ve player argümanları.</small></div>
          <span>›</span>
        </summary>
        <div class="sw-streamlink-grid">
          <label>Kalite
            <select data-store-key="streamlinkQuality">
              <option value="best">Best</option>
              <option value="1080p60">1080p60</option>
              <option value="720p60">720p60</option>
              <option value="720p">720p</option>
              <option value="480p">480p</option>
              <option value="audio_only">Audio only</option>
            </select>
          </label>
          <label>Transport
            <select data-store-key="streamlinkTransport">
              <option value="default">Varsayılan</option>
              <option value="http">HTTP</option>
              <option value="fifo">FIFO</option>
            </select>
          </label>
          <label>HLS Live Edge<input type="number" min="1" max="10" data-store-key="streamlinkHlsLiveEdge"></label>
          <label>Segment Thread<input type="number" min="1" max="10" data-store-key="streamlinkSegmentThreads"></label>
          <label>Retry Open<input type="number" min="1" max="20" data-store-key="streamlinkRetryOpen"></label>
          <label>Retry Streams<input type="number" min="0" max="60" data-store-key="streamlinkRetryStreams"></label>
          <label>Retry Max<input type="number" min="0" max="50" data-store-key="streamlinkRetryMax"></label>
          <label class="sw-switch-line">Düşük Gecikme
            <input type="checkbox" data-store-key="streamlinkLowLatency">
          </label>
          <label class="sw-player-args-field">Player Argümanları
            <input type="text" maxlength="500" placeholder="Örn. --cache=no" data-store-key="streamlinkPlayerArgs">
          </label>
        </div>
      </details>`;
    section.appendChild(wrapper);
    wrapper.querySelector('#sw-player-status-refresh').addEventListener('click', refreshPlayerStatus);
    await bindAdvancedFields(wrapper);
    await refreshPlayerStatus();
    return true;
  }

  function decorateChannels(channels) {
    const byId = new Map((channels || []).map((channel) => [channel.id, channel]));
    document.querySelectorAll('.channel-item[data-id]').forEach((item) => {
      const channel = byId.get(item.dataset.id);
      if (!channel) return;
      const info = item.querySelector('.channel-info');
      if (!info) return;
      let details = info.querySelector('.sw-live-details');
      const platform = ['youtube', 'twitch', 'kick'].find((key) => channel.isLive?.[key] && channel[key]);
      const meta = platform ? channel.streamMeta?.[platform] : null;
      if (!platform || (!meta?.title && !meta?.game)) {
        details?.remove();
        return;
      }
      if (!details) {
        details = document.createElement('div');
        details.className = 'sw-live-details';
        info.appendChild(details);
      }
      details.replaceChildren();
      if (meta.game) {
        const game = document.createElement('span');
        game.className = 'sw-live-game';
        game.textContent = meta.game;
        details.appendChild(game);
      }
      if (meta.title) {
        const title = document.createElement('span');
        title.className = 'sw-live-title';
        title.textContent = meta.title;
        title.title = meta.title;
        details.appendChild(title);
      }
    });
  }

  function showFallbackToast(data) {
    document.getElementById('sw-player-fallback-toast')?.remove();
    const toast = document.createElement('div');
    toast.id = 'sw-player-fallback-toast';
    toast.className = 'sw-player-fallback-toast';
    const from = String(data?.from || '').toUpperCase();
    const to = data?.to === 'embedded' ? 'Dahili Player' : String(data?.to || '').toUpperCase();
    toast.innerHTML = `<strong>Player otomatik değiştirildi</strong><span>${esc(from)} → ${esc(to)} · ${esc(data?.reason || '')}</span>`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
  }

  async function init() {
    titleButton();
    live.onChatState(applyChatState);
    applyChatState(await live.getChatState());
    api.onPlayerEngineFallback(showFallbackToast);
    api.onChannelsUpdated((channels) => setTimeout(() => decorateChannels(channels), 30));
    decorateChannels(await api.getChannels());

    const timer = setInterval(async () => {
      titleButton();
      if (await installSettings()) clearInterval(timer);
    }, 250);
    setTimeout(() => clearInterval(timer), 12000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
