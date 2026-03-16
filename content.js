// content.js — Isolated-world content script.
// 1. Injects inject.js into the page's main world to intercept API calls.
// 2. Falls back to DOM scanning with MutationObserver + periodic polling.
// 3. Forwards normalised task lists to background.js for diff & notification.
// 4. Handles AUTO-CLAIM: opens first unclaimed task and clicks the Claim button.

'use strict';

const PLATFORM_URL =
  'https://feather.openai.com/campaigns/2072efd0-e22f-482e-bc2d-01617ce23d23' +
  '?tab=tasks&tasks-tab=unclaimed&is_admin_view=false';

// ─── Inject the page-world fetch interceptor ─────────────────────────────────

(function injectPageScript() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject.js');
  (document.head || document.documentElement).appendChild(script);
  script.addEventListener('load', () => script.remove());
})();

// ─── State ────────────────────────────────────────────────────────────────────

let lastSentFingerprint = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isOnUnclaimedTab() {
  return (
    location.href.includes('feather.openai.com') &&
    location.href.includes('tasks-tab=unclaimed')
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sendTasks(tasks) {
  if (!tasks || tasks.length === 0) return;
  const fingerprint = JSON.stringify(tasks.map((t) => t.id).sort());
  if (fingerprint === lastSentFingerprint) return;
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
  const candidates = [
    data, data.data, data.tasks, data.items, data.results,
    data.data?.tasks, data.data?.items, data.data?.results,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0 && isTaskLike(c[0])) {
      return c.map(normaliseTask);
    }
  }
  return null;
}

function isTaskLike(obj) {
  return !!(obj && typeof obj === 'object' &&
    (obj.id || obj.task_id || obj.taskId || obj._id || obj.uuid));
}

function normaliseTask(raw) {
  return {
    id: String(raw.id ?? raw.task_id ?? raw.taskId ?? raw._id ?? raw.uuid ?? Math.random()),
    title: raw.title ?? raw.name ?? raw.task_name ?? raw.description ?? raw.label ?? 'Untitled Task',
  };
}

// ─── DOM scan fallback ────────────────────────────────────────────────────────

const TASK_SELECTORS = [
  '[data-task-id]', '[data-testid*="task"]', '[data-cy*="task"]',
  '[class*="TaskCard"]', '[class*="task-card"]', '[class*="task-item"]',
  '[class*="TaskRow"]', 'article',
];

function scanDOM() {
  if (!isOnUnclaimedTab()) return;

  let elements = [];
  for (const sel of TASK_SELECTORS) {
    try {
      const found = document.querySelectorAll(sel);
      if (found.length > 0) { elements = Array.from(found); break; }
    } catch (_) {}
  }

  if (elements.length === 0) {
    elements = Array.from(
      document.querySelectorAll('[role="list"] [role="listitem"], ul > li, ol > li')
    ).filter((el) => el.textContent.trim().length > 30);
  }

  if (elements.length === 0) return;

  const tasks = elements.map((el) => {
    const id =
      el.getAttribute('data-task-id') || el.getAttribute('data-id') ||
      el.getAttribute('id') ||
      `dom:${el.textContent.trim().substring(0, 60).replace(/\s+/g, '_')}`;
    const titleEl = el.querySelector(
      'h1,h2,h3,h4,h5,h6,[class*="title"],[class*="Title"],[class*="name"],[class*="Name"]'
    );
    const title = (titleEl?.textContent ?? el.textContent).trim().substring(0, 80);
    return { id, title };
  });

  // Always tell background a scan happened so lastCheckTime stays current,
  // even when the task list hasn't changed.
  chrome.runtime.sendMessage({ type: 'SCAN_HEARTBEAT', taskCount: tasks.length });

  sendTasks(tasks);
}

// ─── AUTO-CLAIM ───────────────────────────────────────────────────────────────

/**
 * Main entry point called by background when new tasks are detected
 * and autoClaim is enabled.
 */
async function claimTopTask() {
  // If not on the unclaimed tab, navigate there first then bail —
  // the content script will re-run after navigation and background will
  // retry via the CLAIM_TOP_TASK message.
  if (!isOnUnclaimedTab()) {
    window.location.href = PLATFORM_URL;
    return { success: false, reason: 'Navigating to unclaimed tasks page' };
  }

  // Small wait to ensure the task list has rendered
  await sleep(800);

  // ── Step 1: find & click the top task card ─────────────────────────────────
  const taskCard = findFirstTaskCard();
  if (!taskCard) {
    return { success: false, reason: 'No task cards found in the list' };
  }

  const taskTitle = extractCardTitle(taskCard);
  taskCard.click();

  // ── Step 2: wait for the Claim button to appear in the top bar ────────────
  let claimBtn;
  try {
    claimBtn = await waitForElement(findClaimButton, 12000);
  } catch {
    return { success: false, reason: 'Claim button did not appear after opening task' };
  }

  // Brief pause so the page is stable before clicking
  await sleep(300);

  claimBtn.click();

  return { success: true, taskTitle };
}

/**
 * Finds the first task link on the Available Work / unclaimed tab.
 * The platform renders tasks as green-coloured anchor links, so we
 * prioritise those before falling back to generic card selectors.
 */
function findFirstTaskCard() {
  // ── Strategy 1: green-coloured <a> links (the task title links) ────────────
  const greenLinks = Array.from(document.querySelectorAll('a'))
    .filter((a) => {
      if (!a.offsetParent) return false;           // must be visible
      if (!a.textContent.trim()) return false;
      const color = window.getComputedStyle(a).color;
      const m = color.match(/\d+/g);
      if (!m) return false;
      const [r, g, b] = m.map(Number);
      // Green-dominant text colour
      return g > r + 20 && g > b + 20 && g > 80;
    });
  if (greenLinks.length > 0) return greenLinks[0];

  // ── Strategy 2: data-attribute and class-based selectors ──────────────────
  const selectors = [
    '[data-task-id]',
    '[data-testid*="task-row"]', '[data-testid*="task-item"]', '[data-testid*="task-card"]',
    '[class*="TaskRow"]', '[class*="task-row"]',
    '[class*="TaskCard"]', '[class*="task-card"]',
    '[role="row"]:not([aria-label*="header"])',
    'tbody tr',
    '[role="list"] [role="listitem"]',
    'ul > li',
  ];

  for (const sel of selectors) {
    try {
      const els = Array.from(document.querySelectorAll(sel))
        .filter((el) => el.textContent.trim().length > 10);
      if (els.length > 0) return els[0];
    } catch (_) {}
  }
  return null;
}

function extractCardTitle(el) {
  const titleEl = el.querySelector(
    'h1,h2,h3,h4,h5,h6,[class*="title"],[class*="Title"],[class*="name"],[class*="Name"]'
  );
  return (titleEl?.textContent ?? el.textContent).trim().substring(0, 80);
}

/**
 * Finds the Claim button in the top bar after a task is opened.
 *
 * Strategy order:
 *  1. Any visible button/link whose text contains "claim" (case-insensitive)
 *  2. Any visible button/link whose class or aria-label contains "claim"
 *  3. Green-coloured button anywhere in the top 250px of the viewport
 *  4. Green-coloured button anywhere on the page (widest fallback)
 */
function findClaimButton() {
  const allBtns = Array.from(
    document.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]')
  ).filter((el) => !el.disabled && el.offsetParent !== null);

  // Strategy 1: text contains "claim"
  const byText = allBtns.find((btn) =>
    btn.textContent.trim().toLowerCase().includes('claim')
  );
  if (byText) { console.debug('[Stagecraft Notifier] Claim btn via text:', byText); return byText; }

  // Strategy 2: class or aria-label contains "claim"
  const byAttr = allBtns.find((btn) => {
    const cls   = (btn.className || '').toLowerCase();
    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
    const href  = (btn.getAttribute('href') || '').toLowerCase();
    return cls.includes('claim') || label.includes('claim') || href.includes('claim');
  });
  if (byAttr) { console.debug('[Stagecraft Notifier] Claim btn via attr:', byAttr); return byAttr; }

  // Helper: is this element green?
  function isGreen(el) {
    const style = window.getComputedStyle(el);
    for (const prop of ['backgroundColor', 'background', 'color', 'borderColor']) {
      const val = style[prop];
      const m = val && val.match(/\d+/g);
      if (!m) continue;
      const [r, g, b] = m.map(Number);
      if (g > r + 20 && g > b + 20 && g > 80) return true;
    }
    return false;
  }

  // Strategy 3: green button in the top bar (top 250px)
  const topGreen = allBtns.filter((btn) => {
    const rect = btn.getBoundingClientRect();
    return rect.top < 250 && rect.width > 30 && isGreen(btn);
  });
  if (topGreen.length > 0) { console.debug('[Stagecraft Notifier] Claim btn via top-green:', topGreen[0]); return topGreen[0]; }

  // Strategy 4: any green button on the page
  const anyGreen = allBtns.find((btn) => btn.getBoundingClientRect().width > 30 && isGreen(btn));
  if (anyGreen) { console.debug('[Stagecraft Notifier] Claim btn via any-green:', anyGreen); return anyGreen; }

  // Log all visible buttons to help diagnose when nothing matches
  console.debug('[Stagecraft Notifier] No claim button found. Visible buttons:',
    allBtns.map((b) => ({ text: b.textContent.trim().substring(0, 40), cls: b.className }))
  );
  return null;
}

/**
 * Polls `finder()` using MutationObserver + timeout.
 * Resolves with the element or rejects on timeout.
 */
function waitForElement(finder, timeoutMs) {
  return new Promise((resolve, reject) => {
    // Check immediately
    const immediate = finder();
    if (immediate) { resolve(immediate); return; }

    const observer = new MutationObserver(() => {
      const el = finder();
      if (el) { observer.disconnect(); clearTimeout(timer); resolve(el); }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error('Timeout waiting for element'));
    }, timeoutMs);
  });
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
    lastSentFingerprint = null;
    if (isOnUnclaimedTab()) setTimeout(scanDOM, 1200);
  }
}, 500);

// ─── Periodic DOM scan (safety net every 30 s) ───────────────────────────────

setInterval(() => { if (isOnUnclaimedTab()) scanDOM(); }, 30_000);

// ─── Messages from background ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'SCAN_NOW') {
    scanDOM();
  } else if (msg.type === 'CLAIM_TOP_TASK') {
    claimTopTask()
      .then((result) => {
        chrome.runtime.sendMessage({ type: 'CLAIM_RESULT', ...result });
        sendResponse(result);
      })
      .catch((err) => {
        const result = { success: false, reason: err.message };
        chrome.runtime.sendMessage({ type: 'CLAIM_RESULT', ...result });
        sendResponse(result);
      });
    return true; // keep channel open for async sendResponse
  }
});

// ─── Initial scan ─────────────────────────────────────────────────────────────

if (isOnUnclaimedTab()) setTimeout(scanDOM, 1500);
