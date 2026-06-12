// ===== State =====
let channels = [];
let currentTheme = 'dark';
let sidebarExpanded = true;
let activeChannelId = null;
let editingChannelId = null;
let platformPopupChannelId = null;

// ===== Browser Icons (inline SVG) =====
const browserIcons = {
  chrome: `<svg viewBox="0 0 48 48" width="48" height="48"><circle cx="24" cy="24" r="22" fill="#fff"/><path d="M24 8a16 16 0 0 1 13.86 8H24v0a8 8 0 0 0-6.93 4L12.14 11.5A16 16 0 0 1 24 8z" fill="#EA4335"/><path d="M37.86 16A16 16 0 0 1 28.93 38l-4.93-8.5A8 8 0 0 0 32 24h5.86z" fill="#FBBC05"/><path d="M28.93 38A16 16 0 0 1 8.14 16l4.93 8.5A8 8 0 0 0 24 32l4.93 6z" fill="#34A853"/><circle cx="24" cy="24" r="8" fill="#4285F4"/><circle cx="24" cy="24" r="5" fill="#fff"/></svg>`,
  edge: `<svg viewBox="0 0 48 48" width="48" height="48"><defs><linearGradient id="eg1" x1="0" y1="0" x2="48" y2="48"><stop offset="0%" stop-color="#0078D4"/><stop offset="100%" stop-color="#00BCF2"/></linearGradient></defs><circle cx="24" cy="24" r="22" fill="url(#eg1)"/><path d="M14 30c0-8 6-14 14-14 4 0 7 1.5 9 4-3-3-7-4-11-4-7 0-12 5-12 12 0 4 2 7 5 9-4-2-5-4-5-7z" fill="rgba(255,255,255,0.9)"/><path d="M24 16c6 0 10 4 10 10s-4 10-10 10c-3 0-6-1-8-4 2 2 5 3 8 3 5 0 9-4 9-9s-4-9-9-9c-2 0-3 .5-4 1 1-1 3-2 4-2z" fill="rgba(255,255,255,0.7)"/></svg>`,
  brave: `<svg viewBox="0 0 48 48" width="48" height="48"><defs><linearGradient id="bg1" x1="0" y1="0" x2="0" y2="48"><stop offset="0%" stop-color="#FF5500"/><stop offset="100%" stop-color="#FF2000"/></linearGradient></defs><rect width="48" height="48" rx="10" fill="url(#bg1)"/><path d="M24 8l8 6-2 4 4 2-2 6 2 4-4 4-6 4-6-4-4-4 2-4-2-6 4-2-2-4z" fill="#fff" opacity="0.9"/></svg>`,
  opera: `<svg viewBox="0 0 48 48" width="48" height="48"><defs><linearGradient id="og1" x1="0" y1="0" x2="48" y2="48"><stop offset="0%" stop-color="#FF1B2D"/><stop offset="100%" stop-color="#A70014"/></linearGradient></defs><circle cx="24" cy="24" r="22" fill="url(#og1)"/><ellipse cx="24" cy="24" rx="8" ry="14" fill="none" stroke="#fff" stroke-width="3"/></svg>`,
  firefox: `<svg viewBox="0 0 48 48" width="48" height="48"><defs><linearGradient id="fg1" x1="0" y1="0" x2="48" y2="48"><stop offset="0%" stop-color="#FF9640"/><stop offset="50%" stop-color="#FF5A00"/><stop offset="100%" stop-color="#E31587"/></linearGradient></defs><circle cx="24" cy="24" r="22" fill="url(#fg1)"/><circle cx="24" cy="24" r="12" fill="none" stroke="#fff" stroke-width="2.5" opacity="0.9"/><circle cx="20" cy="16" r="3" fill="#fff" opacity="0.8"/></svg>`
};

// ===== Init =====
document.addEventListener('DOMContentLoaded', async () => {
  currentTheme = await window.api.getStore('theme') || 'dark';
  applyTheme(currentTheme);
  sidebarExpanded = await window.api.getStore('sidebarExpanded');
  if (sidebarExpanded === null || sidebarExpanded === undefined) sidebarExpanded = true;

  // Sidebar CSS sınıfını store değerine göre hemen uygula
  const sidebar = document.getElementById('sidebar');
  if (sidebar) {
    sidebar.classList.toggle('expanded', sidebarExpanded);
    sidebar.classList.toggle('collapsed', !sidebarExpanded);
  }

  // BrowserManager'ı da başlangıçta sidebar durumu ile senkronize et
  await window.api.updateBrowserBounds(sidebarExpanded);

  const selectedBrowser = await window.api.getStore('selectedBrowser');
  if (!selectedBrowser) {
    showScreen('onboarding');
    loadBrowserOptions();
  } else {
    showScreen('main-app');
    await loadChannels();
    await checkCookieStatus();
  }

  setupEventListeners();
  setupIpcListeners();

  // Initial stream check
  setTimeout(() => checkStreams(), 3000);
});

// ===== Screen Management =====
function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  document.getElementById(screenId)?.classList.remove('hidden');
}

// ===== Theme =====
function applyTheme(theme) {
  document.body.setAttribute('data-theme', theme);
  currentTheme = theme;
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });
}

// ===== Browser Selection =====
async function loadBrowserOptions() {
  const grid = document.getElementById('browser-grid');
  const browsers = await window.api.getAvailableBrowsers();

  if (browsers.length === 0) {
    grid.innerHTML = '<p style="color:var(--text-muted)">Desteklenen tarayıcı bulunamadı.</p>';
    return;
  }

  grid.innerHTML = browsers.map(b => `
    <div class="browser-card" data-browser="${b.key}">
      ${browserIcons[b.key] || ''}
      <span>${b.name}</span>
    </div>
  `).join('');

  grid.querySelectorAll('.browser-card').forEach(card => {
    card.addEventListener('click', async () => {
      const key = card.dataset.browser;
      await window.api.selectBrowser(key);
      showScreen('main-app');
      await loadChannels();
      await checkCookieStatus();
    });
  });
}

async function checkCookieStatus() {
  const selectedBrowser = await window.api.getStore('selectedBrowser');
  if (!selectedBrowser) return;

  const cookieStatus = await window.api.getCookieStatus();
  const warningEl = document.getElementById('welcome-cookie-warning');
  if (!warningEl) return;

  console.log('[App] Cookie status is:', cookieStatus);

  if (cookieStatus === 'locked' || cookieStatus === 'error' || cookieStatus === 'empty') {
    const browserNames = { chrome: 'Chrome', edge: 'Edge', brave: 'Brave', opera: 'Opera' };
    const name = browserNames[selectedBrowser] || 'tarayıcınızı';
    
    const span = warningEl.querySelector('span');
    if (span) {
      span.textContent = `Hesap oturumlarının (çerezler) aktarılması için lütfen ${name} tarayıcınızı tamamen kapatıp uygulamayı yeniden başlatın.`;
    }
    warningEl.classList.remove('hidden');
  } else {
    warningEl.classList.add('hidden');
  }
}

// ===== Channel Management =====
async function loadChannels() {
  channels = await window.api.getChannels() || [];
  renderChannelList();
  renderSettingsChannelList();
}

function renderChannelList() {
  const list = document.getElementById('channel-list');
  if (channels.length === 0) {
    list.innerHTML = '<div class="no-channels-msg">Henüz kanal eklenmedi</div>';
    return;
  }

  list.innerHTML = channels.map(ch => {
    const isLive = ch.isLive && (ch.isLive.youtube || ch.isLive.twitch || ch.isLive.kick);
    const livePlatforms = [];
    if (ch.isLive?.youtube) livePlatforms.push('YouTube');
    if (ch.isLive?.twitch) livePlatforms.push('Twitch');
    if (ch.isLive?.kick) livePlatforms.push('Kick');
    const initial = ch.name.charAt(0).toUpperCase();
    const isActive = ch.id === activeChannelId;

    return `
      <div class="channel-item ${isActive ? 'active' : ''}" data-id="${ch.id}">
        <div class="channel-avatar">
          ${ch.avatarUrl ? `<img src="${ch.avatarUrl}" alt="${escapeHtml(ch.name)}" class="avatar-img" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" /><span class="avatar-initial" style="display:none;">${initial}</span>` : initial}
          ${isLive ? '<div class="live-badge"></div>' : ''}
        </div>
        <div class="channel-info">
          <div class="channel-name">${escapeHtml(ch.name)}</div>
          <div class="channel-status ${isLive ? 'live' : ''}">
            ${isLive ? '● ' + livePlatforms.join(', ') : 'Çevrimdışı'}
          </div>
        </div>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.channel-item').forEach(item => {
    item.addEventListener('click', (e) => handleChannelClick(e, item.dataset.id));
  });
}

function handleChannelClick(e, channelId) {
  const channel = channels.find(c => c.id === channelId);
  if (!channel) return;

  // Count available platforms
  const platforms = [];
  if (channel.youtube) platforms.push('youtube');
  if (channel.twitch) platforms.push('twitch');
  if (channel.kick) platforms.push('kick');

  if (platforms.length === 1) {
    openStream(channel, platforms[0]);
  } else if (platforms.length > 1) {
    showPlatformPopup(e, channel);
  }
}

function showPlatformPopup(e, channel) {
  const popup = document.getElementById('platform-popup');
  platformPopupChannelId = channel.id;

  // Tarayıcıyı gizle (popup'ın native görünüm altında kalmaması için)
  window.api.hideBrowser();

  popup.querySelectorAll('.platform-option').forEach(opt => {
    const platform = opt.dataset.platform;
    const hasLink = !!channel[platform];
    opt.classList.toggle('disabled', !hasLink);
    opt.onclick = hasLink ? () => {
      openStream(channel, platform);
      popup.classList.add('hidden');
      window.api.showBrowser();
    } : null;
  });

  // Position popup near click
  const rect = e.currentTarget.getBoundingClientRect();
  popup.style.top = rect.top + 'px';
  popup.style.left = (rect.right + 8) + 'px';
  popup.classList.remove('hidden');

  // Close on outside click
  setTimeout(() => {
    const closeHandler = (ev) => {
      if (!popup.contains(ev.target)) {
        popup.classList.add('hidden');
        window.api.showBrowser();
        document.removeEventListener('click', closeHandler);
      }
    };
    document.addEventListener('click', closeHandler);
  }, 50);
}

async function openStream(channel, platform) {
  activeChannelId = channel.id;
  renderChannelList();

  const url = channel[platform];
  if (!url) return;

  document.getElementById('welcome-screen').classList.add('hidden');

  // Sidebar durumunu stream açmadan önce güncelle
  await window.api.updateBrowserBounds(sidebarExpanded);

  const result = await window.api.openStream(url);
  if (result.error) {
    console.error('Stream open error:', result.error);
    document.getElementById('welcome-screen').classList.remove('hidden');
  }
}

// ===== Settings Channel List =====
function renderSettingsChannelList() {
  const list = document.getElementById('settings-channel-list');
  if (channels.length === 0) {
    list.innerHTML = '<div class="no-channels-msg">Henüz kanal eklenmedi</div>';
    return;
  }

  list.innerHTML = channels.map(ch => {
    const notificationsEnabled = ch.notificationsEnabled !== false;
    const bellIcon = notificationsEnabled 
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>`
      : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13.73 21a2 2 0 0 1-3.46 0"></path><path d="M18.63 13A17.89 17.89 0 0 1 18 8"></path><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"></path><path d="M18 8a6 6 0 0 0-9.33-5"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
    const bellTitle = notificationsEnabled ? 'Bildirimleri Kapat' : 'Bildirimleri Aç';
    const activeClass = notificationsEnabled ? 'active' : '';

    return `
      <div class="settings-channel-item" data-id="${ch.id}">
        <div class="channel-avatar">
          ${ch.avatarUrl ? `<img src="${ch.avatarUrl}" alt="${escapeHtml(ch.name)}" class="avatar-img" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" /><span class="avatar-initial" style="display:none;">${ch.name.charAt(0).toUpperCase()}</span>` : ch.name.charAt(0).toUpperCase()}
        </div>
        <span class="channel-name">${escapeHtml(ch.name)}</span>
        <button class="btn-icon notification-toggle ${activeClass}" title="${bellTitle}" data-action="toggle-notifications" data-id="${ch.id}">
          ${bellIcon}
        </button>
        <button class="btn-icon edit" title="Düzenle" data-action="edit" data-id="${ch.id}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="btn-icon delete" title="Sil" data-action="delete" data-id="${ch.id}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    `;
  }).join('');

  list.querySelectorAll('[data-action="toggle-notifications"]').forEach(btn => {
    btn.addEventListener('click', () => toggleNotifications(btn.dataset.id));
  });
  list.querySelectorAll('[data-action="edit"]').forEach(btn => {
    btn.addEventListener('click', () => openEditModal(btn.dataset.id));
  });
  list.querySelectorAll('[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', () => deleteChannel(btn.dataset.id));
  });
}

async function toggleNotifications(channelId) {
  const channel = channels.find(c => c.id === channelId);
  if (!channel) return;

  const notificationsEnabled = channel.notificationsEnabled === false;
  await window.api.updateChannel({ id: channelId, notificationsEnabled });
  await loadChannels();
}

// ===== Modal =====
function openAddModal() {
  editingChannelId = null;
  document.getElementById('modal-title').textContent = 'Kanal Ekle';
  document.getElementById('input-channel-name').value = '';
  document.getElementById('input-youtube').value = '';
  document.getElementById('input-twitch').value = '';
  document.getElementById('input-kick').value = '';
  document.getElementById('modal-error').classList.add('hidden');
  document.getElementById('channel-modal-overlay').classList.remove('hidden');
  window.api.hideBrowser(); // Tarayıcıyı gizle — modal üstte görünsün
}

function openEditModal(channelId) {
  const channel = channels.find(c => c.id === channelId);
  if (!channel) return;

  editingChannelId = channelId;
  document.getElementById('modal-title').textContent = 'Kanalı Düzenle';
  document.getElementById('input-channel-name').value = channel.name;
  document.getElementById('input-youtube').value = channel.youtube || '';
  document.getElementById('input-twitch').value = channel.twitch || '';
  document.getElementById('input-kick').value = channel.kick || '';
  document.getElementById('modal-error').classList.add('hidden');
  document.getElementById('channel-modal-overlay').classList.remove('hidden');
  window.api.hideBrowser(); // Tarayıcıyı gizle — modal üstte görünsün
}

async function saveChannel() {
  const name = document.getElementById('input-channel-name').value.trim();
  const youtube = document.getElementById('input-youtube').value.trim();
  const twitch = document.getElementById('input-twitch').value.trim();
  const kick = document.getElementById('input-kick').value.trim();
  const errorEl = document.getElementById('modal-error');

  if (!name) {
    errorEl.textContent = 'Kanal adı zorunludur.';
    errorEl.classList.remove('hidden');
    return;
  }
  if (!youtube && !twitch && !kick) {
    errorEl.textContent = 'En az bir platform linki girilmelidir.';
    errorEl.classList.remove('hidden');
    return;
  }

  const channelData = { name, youtube: youtube || null, twitch: twitch || null, kick: kick || null };

  if (editingChannelId) {
    channelData.id = editingChannelId;
    await window.api.updateChannel(channelData);
  } else {
    await window.api.addChannel(channelData);
  }

  document.getElementById('channel-modal-overlay').classList.add('hidden');
  window.api.showBrowser(); // Modal kapandı — tarayıcıyı geri göster
  await loadChannels();
}

async function deleteChannel(channelId) {
  await window.api.deleteChannel(channelId);
  if (activeChannelId === channelId) {
    activeChannelId = null;
    await window.api.closeEmbeddedBrowser();
    document.getElementById('welcome-screen').classList.remove('hidden');
  }
  await loadChannels();
}

// ===== Stream Checking =====
async function checkStreams() {
  try {
    const updated = await window.api.checkStreams();
    if (updated) {
      channels = updated;
      renderChannelList();
      renderSettingsChannelList();
    }
  } catch (e) {
    console.error('Check streams error:', e);
  }
}

// ===== Event Listeners =====
function setupEventListeners() {
  // Window controls
  document.getElementById('btn-minimize').addEventListener('click', () => window.api.minimize());
  document.getElementById('btn-reload-stream').addEventListener('click', () => window.api.reloadStream());
  document.getElementById('btn-maximize').addEventListener('click', () => window.api.maximize());
  document.getElementById('btn-close').addEventListener('click', () => window.api.close());

  // Home button navigation
  document.getElementById('btn-home').addEventListener('click', async () => {
    await window.api.closeEmbeddedBrowser();
    activeChannelId = null;
    renderChannelList();
    document.getElementById('welcome-screen').classList.remove('hidden');
  });

  // Sidebar toggle
  document.getElementById('btn-toggle-sidebar').addEventListener('click', toggleSidebar);

  // Add channel
  document.getElementById('btn-add-channel').addEventListener('click', openAddModal);

  // Modal
  const closeModal = () => {
    document.getElementById('channel-modal-overlay').classList.add('hidden');
    window.api.showBrowser(); // Tarayıcıyı geri göster
  };
  document.getElementById('btn-close-modal').addEventListener('click', closeModal);
  document.getElementById('btn-modal-cancel').addEventListener('click', closeModal);
  document.getElementById('btn-modal-save').addEventListener('click', saveChannel);

  // Settings
  document.getElementById('btn-settings-titlebar').addEventListener('click', openSettings);
  document.getElementById('btn-close-settings').addEventListener('click', () => {
    document.getElementById('settings-overlay').classList.add('hidden');
    window.api.showBrowser(); // Tarayıcıyı geri göster
  });

  // Welcome screen action cards
  document.getElementById('btn-welcome-settings').addEventListener('click', openSettings);

  document.getElementById('btn-welcome-howto').addEventListener('click', () => {
    document.getElementById('howto-overlay').classList.remove('hidden');
    window.api.hideBrowser();
  });

  document.getElementById('btn-welcome-license').addEventListener('click', () => {
    document.getElementById('license-overlay').classList.remove('hidden');
    window.api.hideBrowser();
  });

  document.getElementById('btn-welcome-credits').addEventListener('click', () => {
    document.getElementById('credits-overlay').classList.remove('hidden');
    window.api.hideBrowser();
  });

  // Info overlays close events
  const closeHowto = () => {
    document.getElementById('howto-overlay').classList.add('hidden');
    window.api.showBrowser();
  };
  document.getElementById('btn-close-howto').addEventListener('click', closeHowto);
  document.getElementById('howto-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeHowto();
  });

  const closeLicense = () => {
    document.getElementById('license-overlay').classList.add('hidden');
    window.api.showBrowser();
  };
  document.getElementById('btn-close-license').addEventListener('click', closeLicense);
  document.getElementById('license-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeLicense();
  });

  const closeCredits = () => {
    document.getElementById('credits-overlay').classList.add('hidden');
    window.api.showBrowser();
  };
  document.getElementById('btn-close-credits').addEventListener('click', closeCredits);
  document.getElementById('credits-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeCredits();
  });

  // Theme toggle
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const theme = btn.dataset.theme;
      await window.api.setTheme(theme);
      applyTheme(theme);
    });
  });

  // Auto-launch
  document.getElementById('toggle-autolaunch').addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    await window.api.setAutoLaunch(enabled);
    document.getElementById('minimized-start-row').classList.toggle('hidden', !enabled);
  });

  document.getElementById('toggle-start-minimized').addEventListener('change', async (e) => {
    await window.api.setStartMinimized(e.target.checked);
  });

  // Close overlays on backdrop click
  document.getElementById('settings-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      e.currentTarget.classList.add('hidden');
      window.api.showBrowser();
    }
  });
  document.getElementById('channel-modal-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      e.currentTarget.classList.add('hidden');
      window.api.showBrowser();
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.getElementById('settings-overlay').classList.add('hidden');
      document.getElementById('channel-modal-overlay').classList.add('hidden');
      document.getElementById('platform-popup').classList.add('hidden');
      document.getElementById('howto-overlay').classList.add('hidden');
      document.getElementById('license-overlay').classList.add('hidden');
      document.getElementById('credits-overlay').classList.add('hidden');
      window.api.showBrowser(); // Escape ile modal kapanınca tarayıcıyı geri göster
    }
  });

  // Handle external link clicks
  document.addEventListener('click', (e) => {
    const link = e.target.closest('.external-link');
    if (link) {
      e.preventDefault();
      const url = link.dataset.url || link.href;
      if (url && url !== '#') {
        window.api.openExternal(url);
      }
    }
  });
}

async function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  sidebarExpanded = !sidebarExpanded;
  sidebar.classList.toggle('expanded', sidebarExpanded);
  sidebar.classList.toggle('collapsed', !sidebarExpanded);
  await window.api.updateBrowserBounds(sidebarExpanded);
}

async function openSettings() {
  const autoLaunch = await window.api.getStore('autoLaunch');
  const startMinimized = await window.api.getStore('startMinimized');

  document.getElementById('toggle-autolaunch').checked = !!autoLaunch;
  document.getElementById('toggle-start-minimized').checked = !!startMinimized;
  document.getElementById('minimized-start-row').classList.toggle('hidden', !autoLaunch);

  applyTheme(currentTheme);
  renderSettingsChannelList();
  document.getElementById('settings-overlay').classList.remove('hidden');
  window.api.hideBrowser(); // Ayarlar açıkken tarayıcıyı gizle
}

// ===== IPC Listeners =====
function setupIpcListeners() {
  window.api.onWindowMaximized((isMax) => {
    // maximize buton ikonu güncellenebilir
  });

  // Fullscreen değişimi: titlebar/sidebar gizleme/gösterme
  window.api.onFullscreenChanged((isFullscreen) => {
    document.body.classList.toggle('app-fullscreen', isFullscreen);
  });

  window.api.onChannelsUpdated((updatedChannels) => {
    channels = updatedChannels;
    renderChannelList();
    renderSettingsChannelList();
  });

  window.api.onOpenStreamFromNotification((data) => {
    const channel = channels.find(c => c.id === data.channelId);
    if (channel) {
      openStream(channel, data.platform);
    }
  });
}

// ===== Utilities =====
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
