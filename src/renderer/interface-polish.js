(() => {
  if (window.__streamwatchInterfacePolishLoaded) return;
  window.__streamwatchInterfacePolishLoaded = true;

  const TOOLBAR_OVERFLOW_SELECTOR = '#titlebar-controls > .sw-feature-btn:not(#sw-btn-update)';
  const SETTINGS_ORDER = new Map([
    ['Görünüm', 10],
    ['Başlangıç', 20],
    ['Tarayıcı', 30],
    ['Hesaplar', 40],
    ['StreamWatch+', 50],
    ['Kanal Yönetimi', 90],
    ['Hakkında', 100],
  ]);

  let titlebarQueued = false;
  let settingsQueued = false;
  let settingsScrollBound = false;
  let lastSettingsSignature = '';

  function slugify(value) {
    return String(value || 'ayar')
      .toLocaleLowerCase('tr-TR')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/ı/g, 'i')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'ayar';
  }

  function makeOverflow() {
    const controls = document.getElementById('titlebar-controls');
    const settings = document.getElementById('btn-settings-titlebar');
    if (!controls || !settings || settings.parentElement !== controls) return null;

    let wrap = document.getElementById('sw-titlebar-overflow-wrap');
    if (wrap) return wrap;

    wrap = document.createElement('div');
    wrap.id = 'sw-titlebar-overflow-wrap';
    wrap.className = 'sw-titlebar-overflow-wrap';
    wrap.innerHTML = `
      <button id="sw-titlebar-more" class="titlebar-btn sw-titlebar-more" type="button" title="Daha fazla araç" aria-label="Daha fazla araç" aria-haspopup="menu" aria-expanded="false">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.6"></circle><circle cx="12" cy="12" r="1.6"></circle><circle cx="19" cy="12" r="1.6"></circle>
        </svg>
      </button>
      <div id="sw-titlebar-more-menu" class="sw-titlebar-more-menu hidden" role="menu" aria-label="StreamWatch araçları"></div>`;
    controls.insertBefore(wrap, settings);

    const button = wrap.querySelector('#sw-titlebar-more');
    const menu = wrap.querySelector('#sw-titlebar-more-menu');
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const open = menu.classList.toggle('hidden') === false;
      button.setAttribute('aria-expanded', String(open));
    });
    menu.addEventListener('click', (event) => {
      if (!event.target.closest('button')) return;
      menu.classList.add('hidden');
      button.setAttribute('aria-expanded', 'false');
    });

    return wrap;
  }

  function updateOverflowVisibility(wrap) {
    if (!wrap) return;
    const menu = wrap.querySelector('#sw-titlebar-more-menu');
    const button = wrap.querySelector('#sw-titlebar-more');
    if (!menu || !button) return;
    const visibleItems = [...menu.querySelectorAll('button')].filter((item) => !item.classList.contains('hidden'));
    wrap.classList.toggle('hidden', visibleItems.length === 0);
    if (!visibleItems.length) {
      menu.classList.add('hidden');
      button.setAttribute('aria-expanded', 'false');
    }
  }

  function organizeTitlebar() {
    const controls = document.getElementById('titlebar-controls');
    if (!controls) return;
    controls.classList.add('sw-titlebar-polished');

    const wrap = makeOverflow();
    const menu = wrap?.querySelector('#sw-titlebar-more-menu');
    if (!wrap || !menu) return;

    const featureButtons = [...document.querySelectorAll(TOOLBAR_OVERFLOW_SELECTOR)];
    for (const button of featureButtons) {
      if (button.closest('#sw-titlebar-more-menu')) continue;
      button.dataset.swToolbarLabel = button.title || button.getAttribute('aria-label') || 'Araç';
      button.setAttribute('role', 'menuitem');
      menu.appendChild(button);
    }

    const settings = document.getElementById('btn-settings-titlebar');
    settings?.classList.add('sw-titlebar-settings');
    document.getElementById('btn-minimize')?.classList.add('sw-window-control');
    document.getElementById('btn-maximize')?.classList.add('sw-window-control');
    document.getElementById('btn-close')?.classList.add('sw-window-control');
    updateOverflowVisibility(wrap);
  }

  function sectionTitle(section) {
    return section.querySelector(':scope > h3')?.textContent?.trim() || 'Ayarlar';
  }

  function ensureSettingsNav(body) {
    let nav = body.querySelector(':scope > #sw-settings-nav');
    if (nav) return nav;
    nav = document.createElement('nav');
    nav.id = 'sw-settings-nav';
    nav.className = 'sw-settings-nav';
    nav.setAttribute('aria-label', 'Ayar kategorileri');
    body.prepend(nav);
    return nav;
  }

  function ensureSettingsHeader(panel) {
    const header = panel.querySelector('.settings-header');
    if (!header || header.querySelector('.sw-settings-heading-copy')) return;
    const heading = header.querySelector('h2');
    if (!heading) return;
    const wrap = document.createElement('div');
    wrap.className = 'sw-settings-heading-copy';
    heading.replaceWith(wrap);
    wrap.appendChild(heading);
    const subtitle = document.createElement('span');
    subtitle.textContent = 'Uygulama, oynatıcı, hesaplar ve bildirimler';
    wrap.appendChild(subtitle);
  }

  function rebuildSettingsNav(body, nav, sections) {
    const previousActive = nav.querySelector('.active')?.dataset.target || null;
    nav.replaceChildren();

    for (const section of sections) {
      const title = sectionTitle(section);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sw-settings-nav-item';
      button.dataset.target = section.id;
      button.textContent = title;
      button.addEventListener('click', () => {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        nav.querySelectorAll('.sw-settings-nav-item').forEach((item) => item.classList.toggle('active', item === button));
      });
      nav.appendChild(button);
    }

    const active = previousActive
      ? nav.querySelector(`[data-target="${CSS.escape(previousActive)}"]`)
      : nav.querySelector('.sw-settings-nav-item');
    active?.classList.add('active');
  }

  function updateActiveSettingsNav(body, nav, sections) {
    if (!sections.length) return;
    const bodyTop = body.getBoundingClientRect().top;
    let current = sections[0];
    let best = Infinity;
    for (const section of sections) {
      const distance = Math.abs(section.getBoundingClientRect().top - bodyTop - 14);
      if (distance < best) {
        best = distance;
        current = section;
      }
    }
    nav.querySelectorAll('.sw-settings-nav-item').forEach((item) => {
      item.classList.toggle('active', item.dataset.target === current.id);
    });
  }

  function organizeSettings() {
    const panel = document.getElementById('settings-panel');
    const body = panel?.querySelector('.settings-body');
    if (!panel || !body) return;

    panel.classList.add('sw-settings-v3');
    ensureSettingsHeader(panel);
    const nav = ensureSettingsNav(body);
    const sections = [...body.querySelectorAll(':scope > .settings-section')];

    sections.sort((a, b) => {
      const aTitle = sectionTitle(a);
      const bTitle = sectionTitle(b);
      const aRank = SETTINGS_ORDER.get(aTitle) ?? 70;
      const bRank = SETTINGS_ORDER.get(bTitle) ?? 70;
      return aRank - bRank;
    });

    sections.forEach((section, index) => {
      section.classList.add('sw-settings-card-v3');
      if (!section.id) section.id = `sw-settings-${slugify(sectionTitle(section))}-${index}`;
    });

    const currentOrder = [...body.querySelectorAll(':scope > .settings-section')];
    const needsReorder = currentOrder.length !== sections.length || currentOrder.some((section, index) => section !== sections[index]);
    if (needsReorder) sections.forEach((section) => body.appendChild(section));

    const signature = sections.map((section) => `${section.id}:${sectionTitle(section)}`).join('|');
    if (signature !== lastSettingsSignature) {
      lastSettingsSignature = signature;
      rebuildSettingsNav(body, nav, sections);
    }
    if (!settingsScrollBound) {
      settingsScrollBound = true;
      body.addEventListener('scroll', () => updateActiveSettingsNav(body, nav, [...body.querySelectorAll(':scope > .settings-section')]), { passive: true });
    }
  }

  function queueTitlebar() {
    if (titlebarQueued) return;
    titlebarQueued = true;
    requestAnimationFrame(() => {
      titlebarQueued = false;
      organizeTitlebar();
    });
  }

  function queueSettings() {
    if (settingsQueued) return;
    settingsQueued = true;
    requestAnimationFrame(() => {
      settingsQueued = false;
      organizeSettings();
    });
  }

  function closeOverflowOnOutside(event) {
    const wrap = document.getElementById('sw-titlebar-overflow-wrap');
    const menu = document.getElementById('sw-titlebar-more-menu');
    const button = document.getElementById('sw-titlebar-more');
    if (!wrap || !menu || wrap.contains(event.target)) return;
    menu.classList.add('hidden');
    button?.setAttribute('aria-expanded', 'false');
  }

  function init() {
    setTimeout(() => {
      organizeTitlebar();
      organizeSettings();
    }, 1200);

    const observer = new MutationObserver((records) => {
      let titlebarChanged = false;
      let settingsChanged = false;
      for (const record of records) {
        const target = record.target;
        if (target?.id === 'titlebar-controls' || target?.closest?.('#titlebar-controls')) titlebarChanged = true;
        if (target?.classList?.contains('settings-body') || target?.closest?.('#settings-panel .settings-body')) settingsChanged = true;
      }
      if (titlebarChanged) queueTitlebar();
      if (settingsChanged) queueSettings();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    document.addEventListener('click', closeOverflowOnOutside, true);
    window.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const menu = document.getElementById('sw-titlebar-more-menu');
      const button = document.getElementById('sw-titlebar-more');
      if (!menu || menu.classList.contains('hidden')) return;
      menu.classList.add('hidden');
      button?.setAttribute('aria-expanded', 'false');
      button?.focus();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();