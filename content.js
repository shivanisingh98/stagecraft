// content.js — Stagecraft Task Claimer
'use strict';

const AVAILABLE_WORK_URL =
  'https://feather.openai.com/campaigns/2072efd0-e22f-482e-bc2d-01617ce23d23' +
  '?tab=tasks&tasks-tab=unclaimed&is_admin_view=false';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'FIND_AND_CLAIM_TASK') {
    findAndClaimTask();
  }
});

// ─── Startup: handle pending flags when content script loads on a new page ───

(async function onStartup() {
  const data = await storageGet(['pendingClaimTask', 'pendingClickClaim']);

  if (data.pendingClickClaim) {
    // We just navigated to a task detail page — find and click Claim
    await storageSet({ pendingClickClaim: false });
    await sleep(2000); // wait for top bar to render
    await clickClaimButton();
    return;
  }

  if (data.pendingClaimTask) {
    // We just navigated to Available Work — find and click first task
    await storageSet({ pendingClaimTask: false });
    await sleep(2000);
    await findAndClaimTask();
  }
})();

// ─── Core ─────────────────────────────────────────────────────────────────────

async function findAndClaimTask() {
  // If not on feather, bail
  if (!location.href.includes('feather.openai.com')) return;

  // If not on the task list at all, navigate there
  if (!location.href.includes('tasks-tab=')) {
    await storageSet({ pendingClaimTask: true });
    window.location.href = AVAILABLE_WORK_URL;
    return;
  }

  // If on the wrong tasks tab, navigate to Available Work
  if (!location.href.includes('tasks-tab=unclaimed')) {
    await storageSet({ pendingClaimTask: true });
    window.location.href = AVAILABLE_WORK_URL;
    return;
  }

  // ── Check for empty state ─────────────────────────────────────────────────
  if (isEmptyState()) {
    reportResult(false, 'No tasks available to claim right now');
    return;
  }

  // ── Wait for task rows to appear ──────────────────────────────────────────
  let taskLink;
  try {
    taskLink = await waitForElement(findFirstTaskLink, 12_000);
  } catch {
    // Check empty state one more time after waiting
    if (isEmptyState()) {
      reportResult(false, 'No tasks available to claim right now');
    } else {
      reportResult(false, 'Could not find any task links in Available Work tab');
    }
    return;
  }

  // ── Click the task — the page will navigate to the task detail ────────────
  // Set a flag so the new page's content script knows to click Claim
  await storageSet({ pendingClickClaim: true });

  taskLink.scrollIntoViewIfNeeded?.() ?? taskLink.scrollIntoView?.({ block: 'center' });
  await sleep(200);
  taskLink.click();
  // From here the page navigates; onStartup() on the new page handles Claim
}

async function clickClaimButton() {
  let claimBtn;
  try {
    claimBtn = await waitForElement(findClaimButton, 10_000);
  } catch {
    reportResult(false, 'Task opened but could not find the Claim button');
    return;
  }

  claimBtn.scrollIntoViewIfNeeded?.() ?? claimBtn.scrollIntoView?.({ block: 'center' });
  await sleep(200);
  claimBtn.click();
  reportResult(true, 'Task claimed successfully');
}

// ─── Finders ──────────────────────────────────────────────────────────────────

/**
 * Returns true if the page is showing the "no tasks" empty state.
 */
function isEmptyState() {
  const body = document.body?.innerText?.toLowerCase() || '';
  return body.includes('no tasks that match') || body.includes('no tasks available');
}

/**
 * Find the first clickable task link in the Available Work list.
 * Prefers green-coloured <a> elements inside a table row / list item.
 */
function findFirstTaskLink() {
  // Look for <a> links inside table rows or list items
  const rows = document.querySelectorAll('tr, [role="row"], li, [class*="task-row" i], [class*="taskRow" i]');

  for (const row of rows) {
    // Skip header rows
    if (row.querySelector('th')) continue;
    if (row.tagName === 'TH') continue;

    const links = Array.from(row.querySelectorAll('a')).filter(
      (a) => a.offsetParent && a.textContent.trim().length > 0
    );
    if (links.length === 0) continue;

    // Prefer green links (task title)
    const green = links.find((a) => {
      const c = window.getComputedStyle(a).color;
      const m = c.match(/\d+/g);
      if (!m || m.length < 3) return false;
      const [r, g, b] = m.map(Number);
      return g > r + 20 && g > b + 20 && g > 80;
    });

    return green || links[0];
  }

  // Fallback: any visible <a> in the main content area
  const allLinks = Array.from(document.querySelectorAll('main a, [role="main"] a, #root a')).filter(
    (a) => a.offsetParent && a.textContent.trim().length > 4
  );
  return allLinks[0] || null;
}

/**
 * Find the Claim button in the task detail top bar.
 * Looks for a button/link whose visible text is "Claim" or "Claim task".
 */
function findClaimButton() {
  // Direct text match first
  const allButtons = Array.from(document.querySelectorAll('button, a[role="button"], [role="button"]'));

  const exact = allButtons.find((el) => {
    if (!el.offsetParent) return false;
    const text = el.textContent.trim().toLowerCase();
    return text === 'claim' || text === 'claim task';
  });
  if (exact) return exact;

  // Partial match fallback
  const partial = allButtons.find((el) => {
    if (!el.offsetParent) return false;
    return el.textContent.trim().toLowerCase().includes('claim');
  });
  return partial || null;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function waitForElement(finder, timeoutMs) {
  return new Promise((resolve, reject) => {
    const found = finder();
    if (found) { resolve(found); return; }

    const observer = new MutationObserver(() => {
      const el = finder();
      if (el) { observer.disconnect(); clearTimeout(timer); resolve(el); }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error('Timeout'));
    }, timeoutMs);
  });
}

function reportResult(success, message) {
  console.debug(`[Stagecraft] ${success ? '✓' : '✗'} ${message}`);
  chrome.runtime.sendMessage({ type: 'TASK_CLAIM_RESULT', success, message });
}

function storageGet(keys) {
  return new Promise((res) => chrome.storage.local.get(keys, res));
}

function storageSet(obj) {
  return new Promise((res) => chrome.storage.local.set(obj, res));
}
