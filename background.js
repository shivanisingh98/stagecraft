// background.js — Service Worker
'use strict';

const AVAILABLE_WORK_URL =
  'https://feather.openai.com/campaigns/2072efd0-e22f-482e-bc2d-01617ce23d23' +
  '?tab=tasks&tasks-tab=unclaimed&is_admin_view=false';

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'CLAIM_AVAILABLE_TASK') {
    claimAvailableTask().catch(console.error);
  }

  if (message.type === 'TASK_CLAIM_RESULT') {
    chrome.storage.local.set({ lastClaimResult: { success: message.success, message: message.message } });
    chrome.runtime.sendMessage(message).catch(() => {});
  }
});

// ─── Main flow ────────────────────────────────────────────────────────────────

async function claimAvailableTask() {
  const tabId = await navigateToAvailableWork();

  // Wait for the Available Work tab's URL to finish loading (not the old page)
  await waitForTabComplete(tabId, 'tasks-tab=unclaimed');

  // Give React/Next.js time to render the task list
  await sleep(2000);

  // Tell the content script to find and click the first available task
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'FIND_AND_CLAIM_TASK' });
      return;
    } catch {
      await sleep(1000);
    }
  }

  // Fallback: set pending flag for the content script to pick up on startup
  await chrome.storage.local.set({ pendingClaimTask: true });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function navigateToAvailableWork() {
  const tabs = await chrome.tabs.query({ url: 'https://feather.openai.com/*' });

  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true, url: AVAILABLE_WORK_URL });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
    return tabs[0].id;
  }

  const newTab = await chrome.tabs.create({ url: AVAILABLE_WORK_URL });
  return newTab.id;
}

/**
 * Waits until the tab URL contains `urlSubstring` AND status is 'complete'.
 * Resolves on timeout anyway so the caller can still try messaging.
 */
function waitForTabComplete(tabId, urlSubstring, timeoutMs = 25_000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
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
