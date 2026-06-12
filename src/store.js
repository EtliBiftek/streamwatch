const Store = require('electron-store');

const store = new Store({
  defaults: {
    selectedBrowser: null,
    theme: 'dark',
    autoLaunch: false,
    startMinimized: false,
    channels: [],
    sidebarExpanded: true,
  },
});

module.exports = store;
