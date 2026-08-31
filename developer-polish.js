'use strict';

const { app, BrowserWindow } = require('electron');

const developerCss = `
  #btn-welcome-credits {
    justify-content: center;
    min-height: 126px;
  }
  #btn-welcome-credits .card-icon { margin-bottom: 10px; }
  #btn-welcome-credits .card-title { margin-bottom: 0; }

  #credits-overlay.sw-dev-polished .info-panel {
    width: min(500px, calc(100vw - 48px));
  }
  #credits-overlay.sw-dev-polished .credits-body {
    padding: 26px 28px 28px;
  }
  #credits-overlay.sw-dev-polished .creator-badge {
    margin: 0;
    padding: 22px 18px 20px;
    border: 1px solid var(--border-color);
    border-radius: 14px;
    background: var(--bg-card);
  }
  #credits-overlay.sw-dev-polished .creator-avatar {
    width: 82px;
    height: 82px;
    margin-bottom: 13px;
    animation: none !important;
    box-shadow: 0 8px 24px rgba(0,0,0,.22);
  }
  #credits-overlay.sw-dev-polished .creator-badge h3 {
    margin: 0 0 5px;
    font-size: 19px;
    letter-spacing: -.01em;
  }
  #credits-overlay.sw-dev-polished .creator-badge .role-desc {
    margin: 0;
    color: var(--text-secondary);
    font-size: 11px;
    font-weight: 500;
  }
  #credits-overlay.sw-dev-polished .credits-details {
    margin-top: 12px;
  }
  #credits-overlay.sw-dev-polished .developer-links {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    margin-top: 0;
  }
  #credits-overlay.sw-dev-polished .dev-link-card {
    justify-content: center;
    min-width: 0;
    height: 42px;
    padding: 0 12px;
    gap: 8px;
    border-radius: 10px;
    background: transparent;
  }
  #credits-overlay.sw-dev-polished .dev-link-card:hover {
    transform: none;
    box-shadow: none;
    background: var(--bg-card-hover);
  }
  #credits-overlay.sw-dev-polished .dev-link-card span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (max-width: 560px) {
    #credits-overlay.sw-dev-polished .developer-links {
      grid-template-columns: 1fr;
    }
    #credits-overlay.sw-dev-polished .dev-link-card {
      justify-content: flex-start;
    }
  }
`;

const developerRenderer = `(() => {
  if (window.__streamwatchDeveloperPolished) return;
  window.__streamwatchDeveloperPolished = true;

  const apply = () => {
    const welcomeCard = document.getElementById('btn-welcome-credits');
    welcomeCard?.querySelector('.card-desc')?.remove();

    const overlay = document.getElementById('credits-overlay');
    if (!overlay) return;
    overlay.classList.add('sw-dev-polished');
    overlay.querySelector('.credit-item-desc')?.remove();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply, { once: true });
  } else {
    apply();
  }
})();`;

function mainWindow() {
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && !/PiP/i.test(win.getTitle())) || null;
}

function inject(win) {
  if (!win || win.isDestroyed()) return;
  win.webContents.insertCSS(developerCss).catch(() => {});
  win.webContents.executeJavaScript(developerRenderer).catch((error) => {
    console.error('[DeveloperPolish] Renderer injection failed:', error.message);
  });
}

app.whenReady().then(() => {
  const attach = () => {
    const win = mainWindow();
    if (!win) return setTimeout(attach, 250);
    setTimeout(() => inject(win), 900);
    win.webContents.on('did-finish-load', () => setTimeout(() => inject(win), 900));
  };
  setTimeout(attach, 500);
});
