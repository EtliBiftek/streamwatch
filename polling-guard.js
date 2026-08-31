'use strict';

const { app } = require('electron');

let intercepted = false;
const startedAt = Date.now();

function fakeTimer() {
  return {
    __streamwatchSuppressed: true,
    ref() { return this; },
    unref() { return this; },
    hasRef() { return false; },
  };
}

function arm() {
  if (intercepted) return;
  const current = global.setInterval;
  if (current?.__streamwatchLegacyGuard) return;

  function guardedSetInterval(callback, delay, ...args) {
    if (!intercepted && Number(delay) === 60000) {
      intercepted = true;
      console.log('[PollingGuard] Legacy 60 second stream polling suppressed.');
      if (global.setInterval === guardedSetInterval) global.setInterval = current;
      return fakeTimer();
    }
    return current(callback, delay, ...args);
  }

  guardedSetInterval.__streamwatchLegacyGuard = true;
  global.setInterval = guardedSetInterval;
}

arm();

app.whenReady().then(() => {
  const keepArmed = () => {
    if (intercepted) return;
    arm();
    if (Date.now() - startedAt < 45000) setTimeout(keepArmed, 200);
  };
  keepArmed();
});
