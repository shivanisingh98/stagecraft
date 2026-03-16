// content.js — Isolated-world content script.
// 1. Injects inject.js into the page's main world to intercept API calls.
// 2. Falls back to DOM scanning with MutationObserver + periodic polling.
// 3. Forwards normalised task lists to background.js for diff & notification.

'use strict';

// ─── Inject the page-world interceptor ───────────────────────────────────────

(function injectPageScript() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject.js');
  (document.head || document.documentElement).appendChild(script);
  script.addEventListener('load', () => script.remove());
})();

// ─── State ────────────────────────────────────────────────────────────────────

let lastSentFingerprint = null; // prevent sending duplicate lists

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isOnUnclaimedTab() {
  const { href } = window.location;
  return (
    href.includes('feather.openai.com') &&
    href.includes('tasks-tab=unclaimed')
  );
}

function sendTasks(tasks) {
  if (!tasks || tasks.length === 0) return;
  const fingerprint = JSON.stringify(tasks.map((t) => t.id).sort());
  if (fingerprint === lastSentFingerprint) return; // no change
  lastSentFingerprint = fingerprint;
  chrome.runtime.sendMessage({ type: 'TASK_LIST', tasks });
}

// ─── API interception path ────────────────────────────────────────────────────

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.type !== 'STAGECRAFT_API_DATA') return;
  if (!isOnUnclaimedTab()) return;

  const tasks = extractTasksFromApiPayload(event.data.data);
  if (tasks) sendTasks(tasks);
});

function extractTasksFromApiPayload(data) {
  if (!data) return null;

  // Walk common API response shapes
  const candidates = [
    data,
    data.data,
    data.tasks,
    data.items,
    data.results,
    data.data?.tasks,
    data.data?.items,
    data.data?.results,
  ];

  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0 && isTaskLike(c[0])) {
      return c.map(normaliseTask);
    }
  }
  return null;
}

function isTaskLike(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return !!(obj.id || obj.task_id || obj.taskId || obj._id || obj.uuid);
}

function normaliseTask(raw) {
  return {
    id: String(
      raw.id ?? raw.task_id ?? raw.taskId ?? raw._id ?? raw.uuid ?? Math.random()
    ),
    title:
      raw.title ??
      raw.name ??
      raw.task_name ??
      raw.description ??
      raw.label ??
      'Untitled Task',
  };
}

// ─── DOM scan fallback ────────────────────────────────────────────────────────
// Used when the API shape doesn't match expectations, or on manual trigger.

const TASK_SELECTORS = [
  '[data-task-id]',
  '[data-testid*="task"]',
  '[data-cy*="task"]',
  '[class*="TaskCard"]',
  '[class*="task-card"]',
  '[class*="task-item"]',
  '[class*="TaskRow"]',
  'article',
];

function scanDOM() {
  if (!isOnUnclaimedTab()) return;

  let elements = [];
  for (const sel of TASK_SELECTORS) {
    try {
      const found = document.querySelectorAll(sel);
      if (found.length > 0) {
        elements = Array.from(found);
        break;
      }
    } catch (_) {}
  }

  // Generic fallback: meaningful list items
  if (elements.length === 0) {
    elements = Array.from(
      document.querySelectorAll(
        '[role="list"] [role="listitem"], ul > li, ol > li'
      )
    ).filter((el) => el.textContent.trim().length > 30);
  }

  if (elements.length === 0) return;

  const tasks = elements.map((el) => {
    const id =
      el.getAttribute('data-task-id') ||
      el.getAttribute('data-id') ||
      el.getAttribute('id') ||
      `dom:${el.textContent.trim().substring(0, 60).replace(/\s+/g, '_')}`;

    const titleEl = el.querySelector(
      'h1,h2,h3,h4,h5,h6,[class*="title"],[class*="Title"],[class*="name"],[class*="Name"]'
    );
    const title = (titleEl?.textContent ?? el.textContent).trim().substring(0, 80);
    return { id, title };
  });

  sendTasks(tasks);
}

// ─── MutationObserver — react to DOM changes ─────────────────────────────────

let scanTimer = null;
function scheduleScan() {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scanDOM, 600);
}

const observer = new MutationObserver(scheduleScan);
observer.observe(document.documentElement, { childList: true, subtree: true });

// ─── SPA URL-change watcher ───────────────────────────────────────────────────

let lastHref = location.href;
setInterval(() => {
  if (location.href !== lastHref) {
    lastHref = location.href;
    lastSentFingerprint = null; // reset so we re-send baseline on next scan
    if (isOnUnclaimedTab()) setTimeout(scanDOM, 1200);
  }
}, 500);

// ─── Periodic DOM scan (safety net) ─────────────────────────────────────────

setInterval(() => {
  if (isOnUnclaimedTab()) scanDOM();
}, 30_000); // every 30 s

// ─── Messages from background (alarm-triggered scan) ─────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'SCAN_NOW') scanDOM();
});

// ─── Initial scan on load ─────────────────────────────────────────────────────

if (isOnUnclaimedTab()) {
  // Give the React app time to render before first scan
  setTimeout(scanDOM, 1500);
}
