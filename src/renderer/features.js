(() => {
  if (window.__streamwatchFeaturesLoaded || !window.api?.features) return;
  window.__streamwatchFeaturesLoaded = true;

  const features = window.api.features;
  const state = {
    multi: { active: false, count: 0, audioIndex: 0 },
    pip: { active: false },
    update: { available: false },
  };

  const icons = {
    grid: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
    pip: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><rect x="12" y="11" width="8" height="6" rx="1"/></svg>',
    history: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>',
    volume: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>',
  };

  const escapeHtml = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

  const formatDuration = (seconds) => {
    const total = Math.max(0, Math.round(Number(seconds || 0)));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (hours > 0) return `${hours} sa ${minutes} dk`;
    if (minutes > 0) return `${minutes} dk`;
    return `${total} sn`;
  };

  function makeTitleButton(id, title, html, className = '') {
    const button = document.createElement('button');
    button.id = id;
    button.className = `titlebar-btn sw-feature-btn ${className}`.trim();
    button.title = title;
    button.innerHTML = html;
    return button;
  }

  function installTitlebar() {
    const controls = document.getElementById('titlebar-controls');
    const settingsButton = document.getElementById('btn-settings-titlebar');
    if (!controls || document.getElementById('sw-btn-multiview')) return;

    const multiButton = makeTitleButton('sw-btn-multiview', 'Multi-View', icons.grid);
    const audioButton = makeTitleButton('sw-btn-multiview-audio', 'Multi-View sesini değiştir', icons.volume, 'hidden');
    const pipButton = makeTitleButton('sw-btn-pip', 'PiP / Mini Player', icons.pip);
    const historyButton = makeTitleButton('sw-btn-history', 'İzleme geçmişi ve istatistik', icons.history);
    const updateButton = makeTitleButton('sw-btn-update', 'Güncelle', '<span>Güncelle</span>', 'sw-update-button hidden');

    const anchor = settingsButton || controls.firstChild;
    controls.insertBefore(multiButton, anchor);
    controls.insertBefore(audioButton, anchor);
    controls.insertBefore(pipButton, anchor);
    controls.insertBefore(historyButton, anchor);
    controls.insertBefore(updateButton, anchor);

    multiButton.addEventListener('click', openMultiViewDialog);
    audioButton.addEventListener('click', async () => applyMultiState(await features.cycleMultiViewAudio()));
    pipButton.addEventListener('click', togglePip);
    historyButton.addEventListener('click', openHistoryDialog);
    updateButton.addEventListener('click', installUpdate);
  }

  function createOverlay(id, title, bodyHtml, footerHtml = '') {
    closeFeatureOverlay();
    window.api.hideBrowser();
    features.hideMultiView();

    const overlay = document.createElement('div');
    overlay.id = id;
    overlay.className = 'sw-feature-overlay';
    overlay.innerHTML = `
      <div class="sw-feature-panel">
        <div class="sw-feature-header">
          <div><h2>${escapeHtml(title)}</h2></div>
          <button class="sw-icon-button" data-sw-close title="Kapat">×</button>
        </div>
        <div class="sw-feature-body">${bodyHtml}</div>
        ${footerHtml ? `<div class="sw-feature-footer">${footerHtml}</div>` : ''}
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('[data-sw-close]').addEventListener('click', closeFeatureOverlay);
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) closeFeatureOverlay();
    });
    return overlay;
  }

  function closeFeatureOverlay() {
    document.querySelectorAll('.sw-feature-overlay').forEach((element) => element.remove());
    window.api.showBrowser();
    features.showMultiView();
  }

  async function openMultiViewDialog() {
    const channels = await window.api.getChannels() || [];
    const choices = [];
    for (const channel of channels) {
      for (const platform of ['youtube', 'twitch', 'kick']) {
        if (!channel[platform]) continue;
        choices.push({ channelName: channel.name, channelId: channel.id, platform, url: channel[platform] });
      }
    }

    const listHtml = choices.length
      ? choices.map((item, index) => `
          <label class="sw-stream-choice">
            <input type="checkbox" data-sw-stream-index="${index}">
            <span class="sw-stream-choice-main">
              <strong>${escapeHtml(item.channelName)}</strong>
              <small>${escapeHtml(item.platform.toUpperCase())}</small>
            </span>
          </label>
        `).join('')
      : '<div class="sw-empty">Multi-View için önce kanal eklemelisiniz.</div>';

    const closeMulti = state.multi.active
      ? '<button class="sw-btn sw-btn-danger" id="sw-close-multiview">Multi-View’i Kapat</button>'
      : '';

    const overlay = createOverlay(
      'sw-multiview-overlay',
      'Multi-View',
      `<p class="sw-muted">Aynı anda en fazla 4 yayın seçebilirsiniz. Ses varsayılan olarak ilk yayında açık olur.</p><div class="sw-stream-choice-list">${listHtml}</div>`,
      `${closeMulti}<button class="sw-btn sw-btn-primary" id="sw-start-multiview" ${choices.length ? '' : 'disabled'}>Seçilenleri Aç</button>`
    );

    const checkboxes = [...overlay.querySelectorAll('[data-sw-stream-index]')];
    checkboxes.forEach((checkbox) => checkbox.addEventListener('change', () => {
      const selected = checkboxes.filter((item) => item.checked);
      if (selected.length > 4) {
        checkbox.checked = false;
        alert('Multi-View en fazla 4 yayın destekliyor.');
      }
    }));

    overlay.querySelector('#sw-close-multiview')?.addEventListener('click', async () => {
      await features.closeMultiView();
      closeFeatureOverlay();
    });

    overlay.querySelector('#sw-start-multiview')?.addEventListener('click', async () => {
      const selected = checkboxes
        .filter((item) => item.checked)
        .map((item) => choices[Number(item.dataset.swStreamIndex)]);
      if (!selected.length) return alert('En az bir yayın seçin.');
      await window.api.closeEmbeddedBrowser();
      closeFeatureOverlay();
      const result = await features.openMultiView(selected);
      if (result?.error) alert(result.error);
      else applyMultiState(result);
    });
  }

  async function togglePip() {
    if (state.pip.active) {
      await features.closePip();
      applyPipState({ active: false });
      return;
    }
    const result = await features.openPip();
    if (result?.error) alert(result.error);
    else applyPipState({ active: true });
  }

  async function openHistoryDialog() {
    const stats = await features.getWatchStats();
    const top = stats.topChannels?.length
      ? stats.topChannels.map((item, index) => `<div class="sw-top-row"><span>${index + 1}. ${escapeHtml(item.name)}</span><strong>${formatDuration(item.durationSec)}</strong></div>`).join('')
      : '<div class="sw-empty">Henüz yeterli izleme verisi yok.</div>';
    const recent = stats.recent?.length
      ? stats.recent.slice(0, 20).map((item) => `
          <div class="sw-history-row">
            <div><strong>${escapeHtml(item.channelName)}</strong><small>${escapeHtml(String(item.platform || '').toUpperCase())} • ${new Date(item.startedAt).toLocaleString('tr-TR')}</small></div>
            <span>${formatDuration(item.durationSec)}</span>
          </div>
        `).join('')
      : '<div class="sw-empty">İzleme geçmişi henüz boş.</div>';

    createOverlay('sw-history-overlay', 'İzleme Geçmişi ve İstatistik', `
      <div class="sw-stat-grid">
        <div class="sw-stat-card"><span>Bugün</span><strong>${formatDuration(stats.todaySec)}</strong></div>
        <div class="sw-stat-card"><span>Son 7 gün</span><strong>${formatDuration(stats.weekSec)}</strong></div>
        <div class="sw-stat-card"><span>Toplam</span><strong>${formatDuration(stats.totalSec)}</strong></div>
        <div class="sw-stat-card"><span>Oturum</span><strong>${stats.sessions || 0}</strong></div>
      </div>
      <h3 class="sw-subtitle">En çok izlenenler</h3>
      <div class="sw-top-list">${top}</div>
      <h3 class="sw-subtitle">Son izlemeler</h3>
      <div class="sw-history-list">${recent}</div>
    `);
  }

  function installFeatureSettings() {
    const body = document.querySelector('#settings-panel .settings-body');
    if (!body || document.getElementById('sw-feature-settings')) return;

    const section = document.createElement('div');
    section.id = 'sw-feature-settings';
    section.className = 'settings-section sw-settings-section';
    section.innerHTML = `
      <h3>StreamWatch+</h3>
      <div class="sw-setting-row">
        <div><strong>Akıllı yayın bildirimleri</strong><small>Tekrarlanan bildirimleri engeller ve sessiz saatlere uyar.</small></div>
        <label class="sw-switch"><input id="sw-smart-notifications" type="checkbox"><span></span></label>
      </div>
      <div class="sw-setting-row sw-quiet-row">
        <div><strong>Sessiz saatler</strong><small>Bu aralıkta bildirimler sessiz gösterilir.</small></div>
        <div class="sw-inline-controls">
          <label class="sw-switch"><input id="sw-quiet-enabled" type="checkbox"><span></span></label>
          <input id="sw-quiet-start" class="sw-time-input" type="time"><span>–</span><input id="sw-quiet-end" class="sw-time-input" type="time">
        </div>
      </div>
      <div class="sw-setting-row sw-discord-row">
        <div><strong>Discord Rich Presence</strong><small id="sw-discord-status-text">Kapalı</small></div>
        <label class="sw-switch"><input id="sw-discord-enabled" type="checkbox"><span></span></label>
      </div>
      <div class="sw-discord-id-row">
        <label for="sw-discord-client-id">Discord Application ID</label>
        <input id="sw-discord-client-id" type="text" inputmode="numeric" placeholder="Discord Developer Portal uygulama ID'si">
      </div>
    `;
    body.appendChild(section);

    Promise.all([
      features.getSetting('smartNotificationsEnabled'),
      features.getSetting('quietHoursEnabled'),
      features.getSetting('quietHoursStart'),
      features.getSetting('quietHoursEnd'),
      features.getSetting('discordEnabled'),
      features.getSetting('discordClientId'),
      features.getDiscordStatus(),
    ]).then(([smart, quiet, start, end, discordEnabled, clientId, discordStatus]) => {
      section.querySelector('#sw-smart-notifications').checked = smart !== false;
      section.querySelector('#sw-quiet-enabled').checked = Boolean(quiet);
      section.querySelector('#sw-quiet-start').value = start || '00:00';
      section.querySelector('#sw-quiet-end').value = end || '08:00';
      section.querySelector('#sw-discord-enabled').checked = Boolean(discordEnabled);
      section.querySelector('#sw-discord-client-id').value = clientId || '';
      applyDiscordStatus(discordStatus);
    });

    section.querySelector('#sw-smart-notifications').addEventListener('change', (event) => features.setSetting('smartNotificationsEnabled', event.target.checked));
    section.querySelector('#sw-quiet-enabled').addEventListener('change', (event) => features.setSetting('quietHoursEnabled', event.target.checked));
    section.querySelector('#sw-quiet-start').addEventListener('change', (event) => features.setSetting('quietHoursStart', event.target.value || '00:00'));
    section.querySelector('#sw-quiet-end').addEventListener('change', (event) => features.setSetting('quietHoursEnd', event.target.value || '08:00'));
    section.querySelector('#sw-discord-enabled').addEventListener('change', (event) => features.setSetting('discordEnabled', event.target.checked));
    section.querySelector('#sw-discord-client-id').addEventListener('change', (event) => features.setSetting('discordClientId', event.target.value.trim()));
  }

  function applyMultiState(next) {
    if (!next) return;
    Object.assign(state.multi, next);
    document.getElementById('sw-btn-multiview')?.classList.toggle('active', Boolean(state.multi.active));
    const audioButton = document.getElementById('sw-btn-multiview-audio');
    if (audioButton) {
      audioButton.classList.toggle('hidden', !state.multi.active || state.multi.count < 2);
      audioButton.title = state.multi.active ? `Aktif ses: ${Number(state.multi.audioIndex || 0) + 1}. yayın` : 'Multi-View sesini değiştir';
    }
  }

  function applyPipState(next) {
    if (!next) return;
    Object.assign(state.pip, next);
    document.getElementById('sw-btn-pip')?.classList.toggle('active', Boolean(state.pip.active));
  }

  function applyDiscordStatus(status) {
    const text = document.getElementById('sw-discord-status-text');
    if (!text || !status) return;
    if (!status.enabled) text.textContent = 'Kapalı';
    else if (!status.configured) text.textContent = 'Application ID gerekli';
    else if (status.connected) text.textContent = 'Discord’a bağlı';
    else text.textContent = 'Discord bekleniyor';
  }

  function applyUpdateState(next) {
    if (!next) return;
    state.update = next;
    const button = document.getElementById('sw-btn-update');
    if (!button) return;
    button.classList.toggle('hidden', !next.available);
    if (next.downloading) {
      button.disabled = true;
      button.querySelector('span').textContent = 'İndiriliyor…';
    } else {
      button.disabled = false;
      button.querySelector('span').textContent = next.version ? `Güncelle ${next.version}` : 'Güncelle';
    }
  }

  async function installUpdate() {
    const button = document.getElementById('sw-btn-update');
    if (button) button.disabled = true;
    const result = await features.installUpdate();
    if (result?.error) {
      alert(`Güncelleme başarısız: ${result.error}`);
      if (button) button.disabled = false;
    }
  }

  function watchNativeOverlays() {
    const settings = document.getElementById('settings-overlay');
    if (!settings) return;
    const observer = new MutationObserver(() => {
      const visible = !settings.classList.contains('hidden');
      if (visible) features.hideMultiView();
      else if (!document.querySelector('.sw-feature-overlay')) features.showMultiView();
    });
    observer.observe(settings, { attributes: true, attributeFilter: ['class'] });
  }

  function installInteractionHooks() {
    document.getElementById('channel-list')?.addEventListener('click', () => {
      if (state.multi.active) features.closeMultiView();
    }, true);
    document.getElementById('btn-home')?.addEventListener('click', () => {
      if (state.multi.active) features.closeMultiView();
    }, true);
    document.getElementById('btn-reload-stream')?.addEventListener('click', () => {
      if (state.multi.active) features.reloadMultiView();
    }, true);
    document.getElementById('btn-toggle-sidebar')?.addEventListener('click', () => {
      if (state.multi.active) setTimeout(() => features.resizeMultiView(), 180);
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && document.querySelector('.sw-feature-overlay')) closeFeatureOverlay();
    });
  }

  async function init() {
    installTitlebar();
    installFeatureSettings();
    installInteractionHooks();
    watchNativeOverlays();
    applyMultiState(await features.getMultiViewState());
    applyPipState(await features.getPipState());
    applyDiscordStatus(await features.getDiscordStatus());
    applyUpdateState(await features.getUpdateState());
    features.onMultiViewState(applyMultiState);
    features.onPipState(applyPipState);
    features.onDiscordStatus(applyDiscordStatus);
    features.onUpdateState(applyUpdateState);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
