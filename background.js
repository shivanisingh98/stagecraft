// background.js — Service Worker
// Manages known task state, sends desktop notifications, handles alarms.

const PLATFORM_URL =
  'https://feather.openai.com/campaigns/2072efd0-e22f-482e-bc2d-01617ce23d23' +
  '?tab=tasks&tasks-tab=unclaimed&is_admin_view=false';

// ─── Lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    enabled: true,
    knownTaskIds: [],
    taskCount: 0,
    lastCheckTime: null,
  });

  // Wake up every minute to ping any open Stagecraft tabs
  chrome.alarms.create('periodicScan', { periodInMinutes: 1 });
});

// Re-register alarm when service worker restarts (MV3 requirement)
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'periodicScan') triggerScanOnOpenTabs();
});

async function triggerScanOnOpenTabs() {
  const tabs = await chrome.tabs.query({ url: 'https://feather.openai.com/*' });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: 'SCAN_NOW' }).catch(() => {
      // Tab may not have content script ready yet — ignore
    });
  }
}

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'TASK_LIST':
      handleTaskList(message.tasks).catch(console.error);
      break;

    case 'GET_STATUS':
      chrome.storage.local.get(
        ['enabled', 'taskCount', 'lastCheckTime'],
        (data) => sendResponse(data)
      );
      return true; // keep channel open for async sendResponse

    case 'TOGGLE_ENABLED':
      chrome.storage.local.set({ enabled: message.enabled });
      break;
  }
});

// ─── Core logic ───────────────────────────────────────────────────────────────

async function handleTaskList(tasks) {
  if (!tasks || tasks.length === 0) return; // ignore empty/loading states

  const { enabled, knownTaskIds = [] } = await chrome.storage.local.get([
    'enabled',
    'knownTaskIds',
  ]);

  const currentIds = tasks.map((t) => t.id);
  const knownSet = new Set(knownTaskIds);

  const newTasks = tasks.filter((t) => !knownSet.has(t.id));

  // Always update stored state & timestamp
  await chrome.storage.local.set({
    knownTaskIds: currentIds,
    taskCount: tasks.length,
    lastCheckTime: Date.now(),
  });

  // First-run: store baseline silently
  if (knownTaskIds.length === 0) return;

  if (newTasks.length > 0 && enabled) {
    sendTaskNotification(newTasks, tasks.length);
  }
}

function sendTaskNotification(newTasks, total) {
  const count = newTasks.length;
  const taskWord = count === 1 ? 'task' : 'tasks';
  const firstTitle = newTasks[0].title ? `"${newTasks[0].title}"` : '';
  const body =
    count === 1
      ? `New task available: ${firstTitle || 'Claim it before someone else does!'}`
      : `${count} new unclaimed ${taskWord} just appeared. ${total} total available.`;

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

// ─── Notification click → focus / open tab ────────────────────────────────────

chrome.notifications.onClicked.addListener((notificationId) => {
  chrome.notifications.clear(notificationId);
  focusOrOpenStagecraft();
});

chrome.notifications.onButtonClicked.addListener((notificationId) => {
  chrome.notifications.clear(notificationId);
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
