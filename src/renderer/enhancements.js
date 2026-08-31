(() => {
  if (window.__streamwatchEnhancementsLoaded || !window.api?.enhancements) return;
  window.__streamwatchEnhancementsLoaded = true;

  const api = window.api;
  const fx = window.api.features;
  const ex = window.api.enhancements;
  let tournamentState = { active: false, count: 0, entries: [] };
  let previewTimer = null;
  let currentPreviewId = null;
  let groupRefreshQueued = false;

  const icons = {
    star: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 2.5 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5-4.7-4.6 6.5-.9z"/></svg>',
    trophy: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 21h8M12 17v4M7 4h10v4a5 5 0 0 1-10 0z"/><path d="M7 6H4v2a4 4 0 0 0 4 4M17 6h3v2a4 4 0 0 1-4 4"/></svg>',
    mixer: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/></svg>',
    log: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16v16H4z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
  };

  const esc = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

  const platformLabel = (platform) => ({ youtube: 'YouTube', twitch: 'Twitch', kick: 'Kick' }[platform] || platform || 'Yayın');

  function titleButton(id, title, html, className = '') {
    const button = document.createElement('button');
    button.id = id;
    button.className = `titlebar-btn sw-feature-btn ${className}`.trim();
    button.title = title;
    button.innerHTML = html;
    return button;
  }

  function installTitlebar() {
    const controls = document.getElementById('titlebar-controls');
    const anchor = document.getElementById('btn-settings-titlebar');
    if (!controls || document.getElementById('swx-btn-collections')) return;

    const collections = titleButton('swx-btn-collections', 'Favoriler, gruplar ve notlar', icons.star);
    const tournament = titleButton('swx-btn-tournament', 'Turnuva modu', icons.trophy);
    const mixer = titleButton('swx-btn-mixer', 'Ses mikseri', icons.mixer, 'hidden');
    const log = titleButton('swx-btn-broadcast-log', 'Yayın kayıt defteri', icons.log);

    for (const button of [collections, tournament, mixer, log]) controls.insertBefore(button, anchor || controls.firstChild);
    collections.addEventListener('click', () => openChannelManager());
    tournament.addEventListener('click', () => openTournamentDialog());
    mixer.addEventListener('click', openMixer);
    log.addEventListener('click', openBroadcastLog);
  }

  function createOverlay(id, title, body, footer = '') {
    closeOverlay();
    api.hideBrowser();
    fx.hideMultiView();
    ex.hideTournament();
    const overlay = document.createElement('div');
    overlay.id = id;
    overlay.className = 'sw-feature-overlay swx-overlay';
    overlay.innerHTML = `
      <div class="sw-feature-panel swx-panel">
        <div class="sw-feature-header">
          <h2>${esc(title)}</h2>
          <button class="sw-icon-button" data-swx-close>×</button>
        </div>
        <div class="sw-feature-body">${body}</div>
        ${footer ? `<div class="sw-feature-footer">${footer}</div>` : ''}
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('[data-swx-close]').addEventListener('click', closeOverlay);
    overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) closeOverlay(); });
    return overlay;
  }

  function closeOverlay() {
    document.querySelectorAll('.swx-overlay').forEach((node) => node.remove());
    api.showBrowser();
    fx.showMultiView();
    ex.showTournament();
  }

  async function openChannelManager(selectedId = null) {
    const channels = await api.getChannels() || [];
    if (!channels.length) {
      createOverlay('swx-channels', 'Kanallar', '<div class="sw-empty">Henüz kanal eklenmedi.</div>');
      return;
    }

    const selected = channels.find((channel) => channel.id === selectedId) || channels[0];
    const list = channels.map((channel) => `
      <button class="swx-channel-pick ${channel.id === selected.id ? 'active' : ''}" data-channel-id="${esc(channel.id)}">
        <span class="swx-mini-avatar">${channel.avatarUrl ? `<img src="${esc(channel.avatarUrl)}">` : esc(channel.name.charAt(0).toUpperCase())}</span>
        <span>${channel.favorite ? '★ ' : ''}${esc(channel.name)}</span>
      </button>`).join('');

    const overlay = createOverlay('swx-channels', 'Favoriler, Gruplar ve Notlar', `
      <div class="swx-manager-grid">
        <div class="swx-channel-list">${list}</div>
        <div class="swx-channel-editor">
          <div class="swx-editor-head">
            <div>
              <strong id="swx-editor-name">${esc(selected.name)}</strong>
              <small>Kanal tercihleri</small>
            </div>
            <label class="swx-favorite-toggle"><input id="swx-favorite" type="checkbox" ${selected.favorite ? 'checked' : ''}> ★ Favori</label>
          </div>
          <label class="swx-field">Grup<input id="swx-group" type="text" maxlength="40" value="${esc(selected.group || '')}" placeholder="Örn. CS2, Turnuvalar"></label>
          <label class="swx-field">Streamer notu<textarea id="swx-note" maxlength="1000" placeholder="Bu yayıncı hakkında kişisel not...">${esc(selected.note || '')}</textarea></label>
          <button class="sw-btn sw-btn-primary" id="swx-save-channel">Kaydet</button>
        </div>
      </div>`);

    let current = selected;
    const fillEditor = (channel) => {
      current = channel;
      overlay.querySelector('#swx-editor-name').textContent = channel.name;
      overlay.querySelector('#swx-favorite').checked = Boolean(channel.favorite);
      overlay.querySelector('#swx-group').value = channel.group || '';
      overlay.querySelector('#swx-note').value = channel.note || '';
      overlay.querySelectorAll('.swx-channel-pick').forEach((button) => button.classList.toggle('active', button.dataset.channelId === channel.id));
    };

    overlay.querySelectorAll('.swx-channel-pick').forEach((button) => {
      button.addEventListener('click', () => {
        const channel = channels.find((item) => item.id === button.dataset.channelId);
        if (channel) fillEditor(channel);
      });
    });

    overlay.querySelector('#swx-save-channel').addEventListener('click', async () => {
      const updated = {
        ...current,
        favorite: overlay.querySelector('#swx-favorite').checked,
        group: overlay.querySelector('#swx-group').value.trim(),
        note: overlay.querySelector('#swx-note').value.trim(),
      };
      await api.updateChannel(updated);
      const index = channels.findIndex((channel) => channel.id === updated.id);
      if (index >= 0) channels[index] = updated;
      await refreshSidebarGroups(true);
      closeOverlay();
    });
  }

  async function refreshSidebarGroups(force = false) {
    const list = document.getElementById('channel-list');
    if (!list) return;
    if (!force && list.querySelector('.swx-channel-group')) return;
    const items = [...list.querySelectorAll('.channel-item')];
    if (!items.length) return;
    const channels = await api.getChannels() || [];
    const byId = new Map(channels.map((channel) => [channel.id, channel]));
    const groups = new Map();

    for (const item of items) {
      const channel = byId.get(item.dataset.id);
      if (!channel) continue;
      const key = channel.favorite ? '★ Favoriler' : (String(channel.group || '').trim() || 'Diğer');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
      const name = item.querySelector('.channel-name');
      if (name && channel.favorite && !name.querySelector('.swx-fav-mark')) name.insertAdjacentHTML('afterbegin', '<span class="swx-fav-mark">★</span>');
      if (channel.note) item.title = channel.note;
      attachPreview(item, channel);
      if (!item.dataset.swxContextBound) {
        item.dataset.swxContextBound = '1';
        item.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          clearPreview();
          openChannelManager(channel.id);
        });
      }
    }

    const order = [...groups.keys()].sort((a, b) => {
      if (a === '★ Favoriler') return -1;
      if (b === '★ Favoriler') return 1;
      if (a === 'Diğer') return 1;
      if (b === 'Diğer') return -1;
      return a.localeCompare(b, 'tr');
    });
    const fragment = document.createDocumentFragment();
    for (const key of order) {
      const section = document.createElement('div');
      section.className = 'swx-channel-group';
      section.innerHTML = `<div class="swx-group-title">${esc(key)}</div>`;
      groups.get(key).forEach((item) => section.appendChild(item));
      fragment.appendChild(section);
    }
    list.replaceChildren(fragment);
  }

  function scheduleGroupRefresh() {
    if (groupRefreshQueued) return;
    groupRefreshQueued = true;
    setTimeout(() => {
      groupRefreshQueued = false;
      refreshSidebarGroups();
    }, 50);
  }

  function attachPreview(item, channel) {
    if (item.dataset.swxPreviewBound) return;
    item.dataset.swxPreviewBound = '1';
    item.addEventListener('mouseenter', () => {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(async () => {
        if (document.body.classList.contains('sw-lightweight')) return;
        const fresh = (await api.getChannels() || []).find((entry) => entry.id === channel.id) || channel;
        const platform = ['youtube', 'twitch', 'kick'].find((key) => fresh.isLive?.[key] && fresh[key])
          || ['youtube', 'twitch', 'kick'].find((key) => fresh[key]);
        if (!platform) return;
        const rect = item.getBoundingClientRect();
        currentPreviewId = channel.id;
        await ex.openPreview({
          url: fresh[platform],
          channelId: fresh.id,
          channelName: fresh.name,
          platform,
          avatarUrl: fresh.avatarUrl || null,
        }, { x: rect.right + 8, y: rect.top });
      }, 650);
    });
    item.addEventListener('mouseleave', clearPreview);
  }

  function clearPreview() {
    clearTimeout(previewTimer);
    previewTimer = null;
    if (currentPreviewId) ex.closePreview();
    currentPreviewId = null;
  }

  async function streamChoices() {
    const channels = await api.getChannels() || [];
    const choices = [];
    for (const channel of channels) {
      for (const platform of ['youtube', 'twitch', 'kick']) {
        if (!channel[platform]) continue;
        choices.push({
          channelName: channel.name,
          channelId: channel.id,
          platform,
          url: channel[platform],
          avatarUrl: channel.avatarUrl || null,
          live: Boolean(channel.isLive?.[platform]),
        });
      }
    }
    choices.sort((a, b) => Number(b.live) - Number(a.live) || a.channelName.localeCompare(b.channelName, 'tr'));
    return choices;
  }

  async function openTournamentDialog() {
    if (tournamentState.active) {
      const overlay = createOverlay('swx-tournament-stop', 'Turnuva Modu', '<p class="sw-muted">Turnuva modu şu anda açık.</p>', '<button class="sw-btn sw-btn-danger" id="swx-stop-tournament">Turnuva Modunu Kapat</button>');
      overlay.querySelector('#swx-stop-tournament').addEventListener('click', async () => {
        await ex.closeTournament();
        closeOverlay();
      });
      return;
    }

    const choices = await streamChoices();
    const html = choices.length ? choices.map((item, index) => `
      <label class="sw-stream-choice">
        <input type="checkbox" data-swx-tournament-index="${index}">
        <span class="sw-stream-choice-main"><strong>${item.live ? '● ' : ''}${esc(item.channelName)}</strong><small>${esc(platformLabel(item.platform).toUpperCase())}</small></span>
      </label>`).join('') : '<div class="sw-empty">Önce kanal eklemelisiniz.</div>';
    const overlay = createOverlay('swx-tournament', 'Turnuva Modu', `<p class="sw-muted">2–6 yayını aynı anda izleyin. 5–6 yayında 3×2 düzen kullanılır. Sesleri mikserden ayrı ayrı kontrol edebilirsiniz.</p><div class="sw-stream-choice-list">${html}</div>`, '<button class="sw-btn sw-btn-primary" id="swx-start-tournament">Turnuva Modunu Aç</button>');
    const checks = [...overlay.querySelectorAll('[data-swx-tournament-index]')];
    checks.forEach((check) => check.addEventListener('change', () => {
      if (checks.filter((item) => item.checked).length > 6) check.checked = false;
    }));
    overlay.querySelector('#swx-start-tournament').addEventListener('click', async () => {
      const selected = checks.filter((item) => item.checked).map((item) => choices[Number(item.dataset.swxTournamentIndex)]);
      if (selected.length < 2) return alert('Turnuva modu için en az 2 yayın seçin.');
      clearPreview();
      await fx.closeMultiView();
      await api.closeEmbeddedBrowser();
      closeOverlay();
      const result = await ex.openTournament(selected);
      if (result?.error) alert(result.error);
      else applyTournamentState(result);
    });
  }

  async function currentMixerEntries() {
    if (tournamentState.active) return tournamentState.entries || [];
    const media = await fx.getCurrentMedia();
    if (media?.mode === 'multi') return media.entries || [];
    if (media?.mode === 'single' && media.entry) return [media.entry];
    return [];
  }

  async function openMixer() {
    const entries = await currentMixerEntries();
    if (!entries.length) return alert('Ses mikseri için açık bir yayın bulunamadı.');
    const volumes = await ex.getVolumes(entries.map((entry) => entry.url));
    const rows = entries.map((entry, index) => {
      const volume = Number(volumes?.[entry.url] ?? (index === 0 ? 100 : 0));
      return `<div class="swx-mixer-row" data-url="${esc(entry.url)}">
        <div><strong>${esc(entry.channelName || `Yayın ${index + 1}`)}</strong><small>${esc(platformLabel(entry.platform))}</small></div>
        <input type="range" min="0" max="100" step="1" value="${volume}">
        <span>${volume}%</span>
      </div>`;
    }).join('');
    const overlay = createOverlay('swx-mixer', 'Ses Mikseri', `<div class="swx-mixer-list">${rows}</div>`);
    overlay.querySelectorAll('.swx-mixer-row').forEach((row) => {
      const slider = row.querySelector('input');
      const label = row.querySelector('span');
      slider.addEventListener('input', () => {
        label.textContent = `${slider.value}%`;
        ex.setVolume(row.dataset.url, Number(slider.value));
      });
    });
  }

  async function openBroadcastLog() {
    const log = await api.getStore('broadcastLog') || [];
    const rows = log.length ? log.slice(0, 100).map((item) => `
      <div class="swx-log-row">
        <span class="swx-log-dot ${item.type === 'start' ? 'start' : 'end'}"></span>
        <div><strong>${esc(item.channelName)}</strong><small>${esc(platformLabel(item.platform))} • ${new Date(item.at).toLocaleString('tr-TR')}</small></div>
        <span>${item.type === 'start' ? 'Yayın başladı' : 'Yayın bitti'}</span>
      </div>`).join('') : '<div class="sw-empty">Henüz yayın başlangıç/bitiş kaydı yok.</div>';
    createOverlay('swx-log', 'Yayın Kayıt Defteri', `<p class="sw-muted">Takip edilen kanalların algılanan canlı yayın başlangıç ve bitişleri burada tutulur.</p><div class="swx-log-list">${rows}</div>`);
  }

  async function installSettings() {
    const settings = document.querySelector('#settings-panel .settings-body');
    if (!settings) return;
    document.querySelector('.sw-discord-id-row')?.remove();
    const discordStatus = document.getElementById('sw-discord-status-text');
    if (discordStatus?.parentElement && !document.getElementById('swx-discord-fixed')) {
      const fixed = document.createElement('small');
      fixed.id = 'swx-discord-fixed';
      fixed.textContent = 'StreamWatch Discord profili otomatik kullanılır.';
      discordStatus.parentElement.appendChild(fixed);
    }
    if (document.getElementById('swx-lightweight-setting')) return;
    const target = document.getElementById('sw-feature-settings') || settings.lastElementChild;
    if (!target) return;
    const row = document.createElement('div');
    row.id = 'swx-lightweight-setting';
    row.className = 'sw-setting-row';
    row.innerHTML = `<div><strong>Lightweight Mode</strong><small>Arayüz efektlerini ve yayın önizlemelerini kapatarak kaynak kullanımını azaltır.</small></div><label class="sw-switch"><input id="swx-lightweight" type="checkbox"><span></span></label>`;
    target.appendChild(row);
    const input = row.querySelector('input');
    input.checked = Boolean(await api.getStore('lightweightMode'));
    applyLightweight(input.checked);
    input.addEventListener('change', async () => {
      await api.setStore('lightweightMode', input.checked);
      applyLightweight(input.checked);
      if (input.checked) clearPreview();
    });
  }

  function applyLightweight(enabled) {
    document.body.classList.toggle('sw-lightweight', Boolean(enabled));
  }

  async function openUpdateDialog() {
    const state = await fx.getUpdateState();
    if (!state?.available) return;
    const release = await ex.getReleaseNotes();
    const notes = release?.notes || 'Bu sürüm için değişiklik notu bulunamadı.';
    const overlay = createOverlay('swx-update', `StreamWatch ${esc(state.version || release?.version || '')}`, `
      <div class="swx-update-card">
        <strong>Yeni sürüm hazır</strong>
        <p>Kurulum yalnızca aşağıdaki butona bastığınızda indirilir ve başlatılır.</p>
        <div class="swx-changelog">${esc(notes).replaceAll('\n', '<br>')}</div>
      </div>`, `<button class="sw-btn" id="swx-open-release">Release Sayfası</button><button class="sw-btn sw-btn-primary" id="swx-install-update">İndir ve Kur</button>`);
    overlay.querySelector('#swx-open-release').addEventListener('click', () => {
      const url = release?.url || state.releaseUrl;
      if (url) api.openExternal(url);
    });
    overlay.querySelector('#swx-install-update').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = 'İndiriliyor…';
      const result = await fx.installUpdate();
      if (result?.error) {
        alert(`Güncelleme başarısız: ${result.error}`);
        button.disabled = false;
        button.textContent = 'İndir ve Kur';
      }
    });
  }

  function applyTournamentState(next) {
    tournamentState = next || { active: false, count: 0, entries: [] };
    document.getElementById('swx-btn-tournament')?.classList.toggle('active', Boolean(tournamentState.active));
    refreshMixerVisibility();
  }

  async function refreshMixerVisibility() {
    const button = document.getElementById('swx-btn-mixer');
    if (!button) return;
    if (tournamentState.active) return button.classList.remove('hidden');
    const media = await fx.getCurrentMedia();
    button.classList.toggle('hidden', !(media?.mode === 'multi' && (media.entries?.length || 0) > 1));
  }

  function installGlobalHooks() {
    document.addEventListener('click', (event) => {
      if (event.target.closest('#sw-btn-update')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        openUpdateDialog();
      }
    }, true);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && document.querySelector('.swx-overlay')) closeOverlay();
    });

    const channelList = document.getElementById('channel-list');
    if (channelList) {
      new MutationObserver(scheduleGroupRefresh).observe(channelList, { childList: true });
      scheduleGroupRefresh();
    }

    document.getElementById('btn-home')?.addEventListener('click', () => {
      clearPreview();
      if (tournamentState.active) ex.closeTournament();
    }, true);

    api.onChannelsUpdated?.(() => {
      setTimeout(() => refreshSidebarGroups(true), 70);
    });
    fx.onMultiViewState?.(() => setTimeout(refreshMixerVisibility, 50));
    ex.onTournamentState(applyTournamentState);
  }

  async function init() {
    document.body.classList.add('swx-enabled');
    installTitlebar();
    installGlobalHooks();
    applyTournamentState(await ex.getTournamentState());
    applyLightweight(Boolean(await api.getStore('lightweightMode')));
    const settingsTimer = setInterval(() => {
      installSettings();
      if (document.getElementById('swx-lightweight-setting')) clearInterval(settingsTimer);
    }, 250);
    setTimeout(() => clearInterval(settingsTimer), 10000);
    setTimeout(() => refreshSidebarGroups(true), 500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
