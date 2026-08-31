(() => {
  if (window.__streamwatchLayoutV2Loaded || !window.api) return;
  window.__streamwatchLayoutV2Loaded = true;

  const api = window.api;
  const platformNames = { youtube: 'YouTube', twitch: 'Twitch', kick: 'Kick' };
  let renderPatched = false;

  const escapeText = (value) => String(value ?? '');

  function livePlatform(channel) {
    return ['youtube', 'twitch', 'kick'].find((key) => channel?.isLive?.[key] && channel[key]) || null;
  }

  function livePlatforms(channel) {
    return ['youtube', 'twitch', 'kick'].filter((key) => channel?.isLive?.[key] && channel[key]);
  }

  function groupName(channel) {
    if (channel?.favorite) return '★ Favoriler';
    return String(channel?.group || '').trim() || 'Diğer';
  }

  function groupSort(a, b) {
    if (a === '★ Favoriler') return -1;
    if (b === '★ Favoriler') return 1;
    if (a === 'Diğer') return 1;
    if (b === 'Diğer') return -1;
    return a.localeCompare(b, 'tr');
  }

  function ensureAvatar(item, channel) {
    const avatar = item.querySelector('.channel-avatar');
    if (!avatar) return;
    const initial = escapeText(channel.name).charAt(0).toUpperCase() || '?';
    const wantedUrl = channel.avatarUrl || '';
    const image = avatar.querySelector('img.avatar-img');
    const initialNode = avatar.querySelector('.avatar-initial');

    if (wantedUrl) {
      if (!image) {
        const img = document.createElement('img');
        img.className = 'avatar-img';
        img.alt = escapeText(channel.name);
        img.addEventListener('error', () => {
          img.style.display = 'none';
          const fallback = avatar.querySelector('.avatar-initial');
          if (fallback) fallback.style.display = 'flex';
        });
        avatar.prepend(img);
      }
      const currentImage = avatar.querySelector('img.avatar-img');
      if (currentImage.getAttribute('src') !== wantedUrl) currentImage.src = wantedUrl;
      let fallback = avatar.querySelector('.avatar-initial');
      if (!fallback) {
        fallback = document.createElement('span');
        fallback.className = 'avatar-initial';
        avatar.appendChild(fallback);
      }
      fallback.textContent = initial;
      fallback.style.display = 'none';
    } else {
      image?.remove();
      let fallback = initialNode;
      if (!fallback) {
        fallback = document.createElement('span');
        fallback.className = 'avatar-initial';
        avatar.appendChild(fallback);
      }
      fallback.textContent = initial;
      fallback.style.display = 'flex';
    }
  }

  function ensureChannelItem(channel, existing) {
    const item = existing || document.createElement('div');
    item.className = 'channel-item';
    item.dataset.id = channel.id;

    if (!item.querySelector('.channel-avatar')) {
      item.innerHTML = `
        <div class="channel-avatar"><span class="avatar-initial"></span></div>
        <div class="channel-info">
          <div class="channel-name"></div>
          <div class="channel-status"></div>
          <div class="sw-layout-game"></div>
        </div>`;
    }

    const active = typeof activeChannelId !== 'undefined' && channel.id === activeChannelId;
    item.classList.toggle('active', active);
    ensureAvatar(item, channel);

    const avatar = item.querySelector('.channel-avatar');
    const isLive = livePlatforms(channel).length > 0;
    let badge = avatar.querySelector('.live-badge');
    if (isLive && !badge) {
      badge = document.createElement('div');
      badge.className = 'live-badge';
      avatar.appendChild(badge);
    } else if (!isLive) {
      badge?.remove();
    }

    const name = item.querySelector('.channel-name');
    if (name && name.textContent !== channel.name) name.textContent = channel.name;

    const platforms = livePlatforms(channel);
    const status = item.querySelector('.channel-status');
    const statusText = platforms.length ? `● ${platforms.map((key) => platformNames[key]).join(', ')}` : 'Çevrimdışı';
    if (status) {
      if (status.textContent !== statusText) status.textContent = statusText;
      status.classList.toggle('live', platforms.length > 0);
    }

    let game = item.querySelector('.sw-layout-game');
    if (!game) {
      game = document.createElement('div');
      game.className = 'sw-layout-game';
      item.querySelector('.channel-info')?.appendChild(game);
    }
    const platform = livePlatform(channel);
    const gameText = platform ? String(channel.streamMeta?.[platform]?.game || '').trim() : '';
    game.textContent = gameText;
    game.classList.toggle('hidden', !gameText);
    game.title = gameText;

    if (!item.dataset.swLayoutClickBound) {
      item.dataset.swLayoutClickBound = '1';
      item.addEventListener('click', (event) => {
        const id = item.dataset.id;
        if (typeof handleChannelClick === 'function') handleChannelClick(event, id);
      });
    }
    return item;
  }

  function stableRenderChannelList() {
    const list = document.getElementById('channel-list');
    if (!list || typeof channels === 'undefined') return;
    const data = Array.isArray(channels) ? channels : [];

    if (!data.length) {
      if (!list.querySelector('.no-channels-msg')) list.innerHTML = '<div class="no-channels-msg">Henüz kanal eklenmedi</div>';
      return;
    }
    list.querySelector('.no-channels-msg')?.remove();

    const existingItems = new Map([...list.querySelectorAll('.channel-item[data-id]')].map((node) => [node.dataset.id, node]));
    const existingGroups = new Map([...list.querySelectorAll(':scope > .swx-channel-group[data-layout-group]')].map((node) => [node.dataset.layoutGroup, node]));
    const grouped = new Map();

    for (const channel of data) {
      const key = groupName(channel);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(channel);
    }

    const orderedGroups = [...grouped.keys()].sort(groupSort);
    const seenIds = new Set();
    const seenGroups = new Set();

    for (const key of orderedGroups) {
      let section = existingGroups.get(key);
      if (!section) {
        section = document.createElement('div');
        section.className = 'swx-channel-group';
        section.dataset.layoutGroup = key;
        const title = document.createElement('div');
        title.className = 'swx-group-title';
        section.appendChild(title);
      }
      section.dataset.layoutGroup = key;
      const title = section.querySelector(':scope > .swx-group-title');
      if (title && title.textContent !== key) title.textContent = key;

      for (const channel of grouped.get(key)) {
        const item = ensureChannelItem(channel, existingItems.get(channel.id));
        seenIds.add(channel.id);
        section.appendChild(item);
      }
      list.appendChild(section);
      seenGroups.add(key);
    }

    for (const [id, node] of existingItems) {
      if (!seenIds.has(id)) node.remove();
    }
    for (const [key, node] of existingGroups) {
      if (!seenGroups.has(key)) node.remove();
    }

    document.querySelectorAll('#channel-list .sw-live-title').forEach((node) => node.remove());
  }

  function patchRenderer() {
    if (renderPatched) return true;
    try {
      if (typeof renderChannelList !== 'function') return false;
      renderChannelList = stableRenderChannelList;
      renderPatched = true;
      stableRenderChannelList();
      return true;
    } catch (error) {
      console.warn('[LayoutV2] Sidebar renderer patch failed:', error.message);
      return false;
    }
  }

  function pinPreviewShell() {
    const shell = document.getElementById('swx-hover-preview-shell');
    const sidebar = document.getElementById('sidebar');
    if (!shell || !sidebar) return;
    const x = Math.round(sidebar.getBoundingClientRect().right + 12);
    shell.style.setProperty('left', `${x}px`, 'important');
  }

  async function installBrowserSetting() {
    if (document.getElementById('sw-browser-setting-section')) return true;
    const body = document.querySelector('#settings-panel .settings-body');
    if (!body) return false;

    const browsers = await api.getAvailableBrowsers();
    const current = await api.getStore('selectedBrowser');
    const section = document.createElement('div');
    section.id = 'sw-browser-setting-section';
    section.className = 'settings-section sw-settings-card';
    section.innerHTML = `
      <h3>Tarayıcı</h3>
      <div class="sw-browser-setting-row">
        <div>
          <strong>Oturum tarayıcısı</strong>
          <small>Çerez ve oturum bilgileri bu tarayıcıdan alınır.</small>
        </div>
        <select id="sw-browser-setting-select" aria-label="Tarayıcı seç">
          ${browsers.map((browser) => `<option value="${browser.key}">${browser.name}</option>`).join('')}
        </select>
      </div>
      <div id="sw-browser-setting-note" class="sw-browser-setting-note">Değişiklik yeni yayınlarda kullanılır; oturum aktarımının tamamen yenilenmesi için uygulamayı yeniden başlat.</div>`;

    const sections = [...body.querySelectorAll(':scope > .settings-section')];
    const appearance = sections.find((node) => node.querySelector('h3')?.textContent?.trim() === 'Görünüm');
    if (appearance?.nextSibling) body.insertBefore(section, appearance.nextSibling);
    else body.prepend(section);

    const select = section.querySelector('#sw-browser-setting-select');
    if (!browsers.length) {
      select.innerHTML = '<option>Desteklenen tarayıcı bulunamadı</option>';
      select.disabled = true;
    } else {
      select.value = browsers.some((browser) => browser.key === current) ? current : browsers[0].key;
      select.addEventListener('change', async () => {
        select.disabled = true;
        const note = section.querySelector('#sw-browser-setting-note');
        try {
          await api.selectBrowser(select.value);
          if (note) note.textContent = `${select.options[select.selectedIndex].text} seçildi. Oturum aktarımını tamamen yenilemek için uygulamayı yeniden başlat.`;
        } finally {
          select.disabled = false;
        }
      });
    }
    return true;
  }

  function organizeSettings() {
    const panel = document.getElementById('settings-panel');
    const body = panel?.querySelector('.settings-body');
    if (!panel || !body) return;
    panel.classList.add('sw-settings-v2');
    body.querySelectorAll(':scope > .settings-section').forEach((section) => {
      section.classList.add('sw-settings-card');
      const title = section.querySelector(':scope > h3')?.textContent?.trim() || '';
      section.classList.toggle('sw-settings-wide', title === 'Kanal Yönetimi' || title === 'StreamWatch+');
    });
  }

  function cleanLiveTitles() {
    document.querySelectorAll('#channel-list .sw-live-title').forEach((node) => node.remove());
  }

  function init() {
    const patchTimer = setInterval(() => {
      if (patchRenderer()) clearInterval(patchTimer);
    }, 100);
    setTimeout(() => clearInterval(patchTimer), 10000);

    const settingsTimer = setInterval(async () => {
      await installBrowserSetting();
      organizeSettings();
      if (document.getElementById('sw-browser-setting-section')) clearInterval(settingsTimer);
    }, 250);
    setTimeout(() => clearInterval(settingsTimer), 15000);

    const observer = new MutationObserver(() => {
      cleanLiveTitles();
      pinPreviewShell();
      organizeSettings();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    window.addEventListener('resize', pinPreviewShell);
    cleanLiveTitles();
    organizeSettings();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
