// background.js — Service Worker
'use strict';

const TARGET_URL =
  'https://feather.openai.com/campaigns/2072efd0-e22f-482e-bc2d-01617ce23d23' +
  '?tab=tasks&tasks-tab=incomplete&is_admin_view=false';

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'OPEN_REOPENED_TASK') {
    openReopenedTask().catch(console.error);
  }

  if (message.type === 'REOPENED_RESULT') {
    chrome.storage.local.set({
      lastReopenedResult: { success: message.success, message: message.message },
    });
    chrome.runtime.sendMessage(message).catch(() => {});
  }
});

// ─── Main flow ────────────────────────────────────────────────────────────────

async function openReopenedTask() {
  const tabId = await navigateToTarget();

  // Wait for the NEW page (our target URL) to finish loading.
  // We pass the expected URL substring so we don't accidentally resolve
  // on the old page's 'complete' event before the navigation starts.
  await waitForTabComplete(tabId, 'tasks-tab=incomplete');

  // Extra delay for React/Next.js to hydrate the task list
  await sleep(2000);

  // Send the message; retry once if the content script isn't ready yet
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'FIND_REOPENED_TASK' });
      return; // success
    } catch {
      // Content script not ready yet — wait and retry
      await sleep(1000);
    }
  }

  // Last resort: store a pending flag the content script will read on startup
  await chrome.storage.local.set({ pendingFindReopened: true });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Opens or navigates to the target URL.
 * Returns the tab ID of the tab being used.
 */
async function navigateToTarget() {
  const tabs = await chrome.tabs.query({ url: 'https://feather.openai.com/*' });

  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true, url: TARGET_URL });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
    return tabs[0].id;
  }

  const newTab = await chrome.tabs.create({ url: TARGET_URL });
  return newTab.id;
}

/**
 * Waits until the tab's URL contains `urlSubstring` AND status is 'complete'.
 * This prevents resolving on the old page's status before navigation starts.
 */
function waitForTabComplete(tabId, urlSubstring, timeoutMs = 25_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(); // resolve anyway so we still try to message the content script
    }, timeoutMs);

    function listener(id, info, tab) {
      if (id !== tabId) return;
      if (info.status === 'complete' && tab.url && tab.url.includes(urlSubstring)) {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
