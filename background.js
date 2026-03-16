// background.js — Service Worker
// Manages known task state, triggers auto-claim, sends desktop notifications.

const PLATFORM_URL =
  'https://feather.openai.com/campaigns/2072efd0-e22f-482e-bc2d-01617ce23d23' +
  '?tab=tasks&tasks-tab=unclaimed&is_admin_view=false';

// ─── Lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    enabled: true,
    autoClaim: true,
    knownTaskIds: [],
    taskCount: 0,
    lastCheckTime: null,
    lastClaimResult: null,
  });
  chrome.alarms.create('periodicScan', { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'periodicScan') triggerScanOnOpenTabs();
});

async function triggerScanOnOpenTabs() {
  const tabs = await chrome.tabs.query({ url: 'https://feather.openai.com/*' });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: 'SCAN_NOW' }).catch(() => {});
  }
}

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'TASK_LIST':
      handleTaskList(message.tasks, sender.tab).catch(console.error);
      break;

    case 'CLAIM_RESULT':
      handleClaimResult(message);
      break;

    case 'GET_STATUS':
      chrome.storage.local.get(
        ['enabled', 'autoClaim', 'taskCount', 'lastCheckTime', 'lastClaimResult'],
        (data) => sendResponse(data)
      );
      return true;

    case 'TOGGLE_ENABLED':
      chrome.storage.local.set({ enabled: message.enabled });
      break;

    case 'TOGGLE_AUTO_CLAIM':
      chrome.storage.local.set({ autoClaim: message.autoClaim });
      break;

    case 'SCAN_HEARTBEAT':
      chrome.storage.local.set({
        lastCheckTime: Date.now(),
        ...(message.taskCount != null && { taskCount: message.taskCount }),
      });
      break;
  }
});

// ─── Core task-list handler ───────────────────────────────────────────────────

async function handleTaskList(tasks, senderTab) {
  if (!tasks || tasks.length === 0) return;

  const { enabled, autoClaim, knownTaskIds = [] } = await chrome.storage.local.get([
    'enabled', 'autoClaim', 'knownTaskIds',
  ]);

  const currentIds = tasks.map((t) => t.id);
  const knownSet = new Set(knownTaskIds);
  const newTasks = tasks.filter((t) => !knownSet.has(t.id));

  // Update stored baseline & timestamp
  await chrome.storage.local.set({
    knownTaskIds: currentIds,
    taskCount: tasks.length,
    lastCheckTime: Date.now(),
  });

  // First run — just record the baseline, no action
  if (knownTaskIds.length === 0) return;
  if (newTasks.length === 0) return;
  if (!enabled) return;

  if (autoClaim) {
    // ── AUTO-CLAIM MODE ──────────────────────────────────────────────────────
    // Ensure the Stagecraft tab is open and focused, then tell the content
    // script to claim the top task.
    const tab = await ensureStagecraftTab(senderTab);
    if (tab) {
      // Give the page a moment to settle after any focus/navigation
      setTimeout(() => {
        chrome.tabs.sendMessage(tab.id, { type: 'CLAIM_TOP_TASK' }).catch(() => {
          // Content script may not be ready; send a notification fallback
          sendNewTaskNotification(newTasks, tasks.length);
        });
      }, 1000);
    }
  } else {
    // ── NOTIFY-ONLY MODE ─────────────────────────────────────────────────────
    sendNewTaskNotification(newTasks, tasks.length);
  }
}

// ─── Claim result ─────────────────────────────────────────────────────────────

function handleClaimResult(result) {
  chrome.storage.local.set({ lastClaimResult: { ...result, time: Date.now() } });

  if (result.success) {
    chrome.notifications.create(`claim-ok-${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'Task Claimed Successfully!',
      message: result.taskTitle
        ? `"${result.taskTitle}" has been claimed.`
        : 'A task has been claimed on your behalf.',
      priority: 2,
    });
  } else {
    // Auto-claim failed — fall back to a regular notification so the user
    // can manually claim the task.
    chrome.notifications.create(`claim-fail-${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'New Task Available — Manual Claim Needed',
      message: `Auto-claim failed (${result.reason}). Click to open the task.`,
      buttons: [{ title: 'View Unclaimed Tasks' }],
      priority: 2,
      requireInteraction: true,
    });
  }
}

// ─── Notifications ────────────────────────────────────────────────────────────

function sendNewTaskNotification(newTasks, total) {
  const count = newTasks.length;
  const body =
    count === 1
      ? `New task: "${newTasks[0].title || 'Untitled'}". Click to claim it now.`
      : `${count} new unclaimed tasks appeared. ${total} total available.`;

  chrome.notifications.create(`task-alert-${Date.now()}`, {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: `New Task${count > 1 ? 's' : ''} Available on Stagecraft`,
    message: body,
    buttons: [{ title: 'View Unclaimed Tasks' }],
    priority: 2,
    requireInteraction: true,
  });
}

// ─── Tab management ───────────────────────────────────────────────────────────

/**
 * Returns the Stagecraft tab to use for auto-claiming.
 * Prefers the tab that sent the message; falls back to any open Stagecraft tab;
 * opens a new one if none exists.
 */
async function ensureStagecraftTab(senderTab) {
  if (senderTab && senderTab.url?.includes('feather.openai.com')) {
    return senderTab;
  }

  const tabs = await chrome.tabs.query({ url: 'https://feather.openai.com/*' });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
    return tabs[0];
  }

  // Open a new tab — content script will load and background will retry
  // via the next task-list message.
  const newTab = await chrome.tabs.create({ url: PLATFORM_URL });
  return newTab;
}

// ─── Notification clicks → focus / open tab ───────────────────────────────────

chrome.notifications.onClicked.addListener((id) => {
  chrome.notifications.clear(id);
  focusOrOpenStagecraft();
});

chrome.notifications.onButtonClicked.addListener((id) => {
  chrome.notifications.clear(id);
  focusOrOpenStagecraft();
});

function focusOrOpenStagecraft() {
  chrome.tabs.query({ url: 'https://feather.openai.com/*' }, (tabs) => {
    if (tabs.length > 0) {
      chrome.tabs.update(tabs[0].id, { active: true, url: PLATFORM_URL });
      chrome.windows.update(tabs[0].windowId, { focused: true });
    } else {
      chrome.tabs.create({ url: PLATFORM_URL });
    }
  });
}
