'use strict';

const { WebContentsView } = require('electron');
const Store = require('electron-store');

const store = new Store();
const previousSetBounds = WebContentsView?.prototype?.setBounds;

if (previousSetBounds && !WebContentsView.prototype.__streamwatchPreviewPositionV2) {
  WebContentsView.prototype.setBounds = function streamwatchPreviewPositionV2(bounds) {
    let next = bounds;
    try {
      if (Number(bounds?.width) === 320 && Number(bounds?.height) === 180) {
        const sidebarWidth = store.get('sidebarExpanded', true) ? 280 : 64;
        next = { ...bounds, x: sidebarWidth + 12 };
      }
    } catch { }
    return previousSetBounds.call(this, next);
  };
  WebContentsView.prototype.__streamwatchPreviewPositionV2 = true;
}
