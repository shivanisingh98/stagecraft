// content.js — content script for "Open first Reopened task" extension
'use strict';

const INCOMPLETE_TAB_URL =
  'https://feather.openai.com/campaigns/2072efd0-e22f-482e-bc2d-01617ce23d23' +
  '?tab=tasks&tasks-tab=incomplete&is_admin_view=false';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isOnIncompleteTab() {
  return location.href.includes('tasks-tab=incomplete');
}

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'FIND_REOPENED_TASK') {
    findAndOpenReopenedTask();
  }
});

// ─── Startup: handle the pending flag set by background when the tab was
//     not yet ready to receive a message ─────────────────────────────────────

(async function checkPendingOnStartup() {
  if (!isOnIncompleteTab()) return;
  const { pendingFindReopened } = await new Promise((res) =>
    chrome.storage.local.get('pendingFindReopened', res)
  );
  if (!pendingFindReopened) return;
  await chrome.storage.local.set({ pendingFindReopened: false });
  // Give the page a moment to finish rendering
  await sleep(1500);
  findAndOpenReopenedTask();
})();

// ─── Core: find the first Reopened task and click it ─────────────────────────

async function findAndOpenReopenedTask() {
  if (!isOnIncompleteTab()) {
    window.location.href = INCOMPLETE_TAB_URL;
    return;
  }

  let link = null;

  try {
    // Wait up to 10 s for a Reopened task to appear in the DOM
    link = await waitForElement(findReopenedTaskLink, 10_000);
  } catch {
    reportResult(false, 'No Reopened task found in Available Work tab');
    return;
  }

  link.scrollIntoViewIfNeeded?.() || link.scrollIntoView?.({ block: 'center' });
  await sleep(300);
  link.click();
  reportResult(true, `Opened: "${link.textContent.trim().substring(0, 60)}"`);
}

// ─── Selector: finds the first visible task link that contains "reopened" ─────

function findReopenedTaskLink() {
  // Walk every visible <a> whose nearest task-row ancestor contains "reopened"
  const links = Array.from(document.querySelectorAll('a'));

  for (const a of links) {
    if (!a.offsetParent) continue;          // not visible
    if (!a.textContent.trim()) continue;

    // Check the link text itself
    if (a.textContent.toLowerCase().includes('reopened')) return a;

    // Check the containing row / list item for a "reopened" badge
    const row = a.closest(
      'tr, [role="row"], li, [class*="task" i], [class*="row" i], [class*="item" i]'
    );
    if (row && row.textContent.toLowerCase().includes('reopened')) return a;
  }

  // Fallback: any element with "reopened" text that is itself clickable
  const clickable = Array.from(
    document.querySelectorAll('[role="button"], button, [tabindex]')
  ).find(
    (el) => el.offsetParent && el.textContent.toLowerCase().includes('reopened')
  );

  return clickable || null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Polls finder() via MutationObserver until it returns a non-null element
 * or the timeout fires.
 */
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
  chrome.runtime.sendMessage({ type: 'REOPENED_RESULT', success, message });
}
