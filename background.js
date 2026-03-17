// background.js — Service Worker
'use strict';

const INCOMPLETE_TAB_URL =
  'https://feather.openai.com/campaigns/2072efd0-e22f-482e-bc2d-01617ce23d23' +
  '?tab=tasks&tasks-tab=incomplete&is_admin_view=false';

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'OPEN_REOPENED_TASK') {
    openReopenedTask();
  }

  if (message.type === 'REOPENED_RESULT') {
    // Save result so popup can display it even after re-opening
    chrome.storage.local.set({
      lastReopenedResult: { success: message.success, message: message.message },
    });
    // Forward to popup if it's still open
    chrome.runtime.sendMessage(message).catch(() => {});
  }
});

// ─── Main flow ────────────────────────────────────────────────────────────────

/**
 * 1. Ensures a Stagecraft tab is open on the Available Work URL.
 * 2. Waits for that tab to finish loading.
 * 3. Sends FIND_REOPENED_TASK to the content script.
 */
async function openReopenedTask() {
  const tab = await ensureAvailableWorkTab();

  // Wait for the tab to finish loading before messaging the content script.
  await waitForTabLoad(tab.id);

  // Give React/Next.js a moment to hydrate the task list
  await sleep(1500);

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'FIND_REOPENED_TASK' });
  } catch {
    // Content script may not have injected yet (e.g. on a fresh tab).
    // Store a pending flag so the content script picks it up on startup.
    await chrome.storage.local.set({ pendingFindReopened: true });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns an existing Stagecraft tab navigated to the Incomplete tab URL,
 * or opens a new one if none exists.
 */
async function ensureAvailableWorkTab() {
  const tabs = await chrome.tabs.query({ url: 'https://feather.openai.com/*' });

  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true, url: INCOMPLETE_TAB_URL });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
    return tabs[0];
  }

  return chrome.tabs.create({ url: INCOMPLETE_TAB_URL });
}

/**
 * Resolves when the given tab reaches 'complete' status.
 * Times out after 20 s to avoid hanging indefinitely.
 */
function waitForTabLoad(tabId, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab load timeout'));
    }, timeoutMs);

    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);

    // Also check immediately in case the tab is already loaded
    chrome.tabs.get(tabId, (tab) => {
      if (tab && tab.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
