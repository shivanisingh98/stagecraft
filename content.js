// content.js — "Open first Reopened task" extension
'use strict';

const TARGET_URL =
  'https://feather.openai.com/campaigns/2072efd0-e22f-482e-bc2d-01617ce23d23' +
  '?tab=tasks&tasks-tab=incomplete&is_admin_view=false';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'FIND_REOPENED_TASK') {
    findAndOpenReopenedTask();
  }
});

// ─── Startup: pick up the pending flag when the content script loads fresh ────

(async function checkPendingOnStartup() {
  const { pendingFindReopened } = await new Promise((res) =>
    chrome.storage.local.get('pendingFindReopened', res)
  );
  if (!pendingFindReopened) return;
  await chrome.storage.local.set({ pendingFindReopened: false });
  await sleep(2000); // let the page finish rendering
  findAndOpenReopenedTask();
})();

// ─── Core ─────────────────────────────────────────────────────────────────────

async function findAndOpenReopenedTask() {
  // If we're not on the target tab, navigate there and let the
  // pendingFindReopened flag trigger the search on arrival.
  if (!location.href.includes('feather.openai.com')) return;
  if (!location.href.includes('tasks-tab=')) {
    await chrome.storage.local.set({ pendingFindReopened: true });
    window.location.href = TARGET_URL;
    return;
  }

  let link;
  try {
    link = await waitForElement(findReopenedTaskLink, 12_000);
  } catch {
    reportResult(false, 'No Reopened task found — check the Incomplete tab has tasks with a Reopened label');
    return;
  }

  link.scrollIntoViewIfNeeded?.() ?? link.scrollIntoView?.({ block: 'center' });
  await sleep(300);
  link.click();
  reportResult(true, `Opened: "${link.textContent.trim().substring(0, 60)}"`);
}

// ─── Finder ───────────────────────────────────────────────────────────────────

/**
 * Finds the first visible task link whose row contains "Reopened".
 *
 * Strategy:
 *  1. Walk every element in the page looking for one that contains the text
 *     "reopened" (case-insensitive) but is not itself a huge container.
 *  2. From that element, climb up to the nearest row/card and then find
 *     the first <a> link inside that row — that is the task title link.
 *  3. Fallback: return the "reopened" element itself if it's clickable.
 */
function findReopenedTaskLink() {
  // Find all leaf-ish visible elements containing "reopened"
  const all = Array.from(document.querySelectorAll('*'));

  for (const el of all) {
    // Skip hidden elements and large containers (html, body, main, etc.)
    if (!el.offsetParent) continue;
    if (el.children.length > 10) continue;

    const text = el.textContent.trim().toLowerCase();
    if (!text.includes('reopened')) continue;
    if (text.length > 200) continue; // skip large blocks

    // Found a small element with "reopened" text.
    // Walk up to find the row/card that contains this badge.
    const row = el.closest(
      'tr, [role="row"], li, [class*="task"], [class*="row"], [class*="card"], [class*="item"]'
    ) || el.parentElement?.parentElement;

    if (!row) continue;

    // Prefer a green-coloured <a> link (task title) inside the row
    const links = Array.from(row.querySelectorAll('a')).filter((a) => a.offsetParent && a.textContent.trim());
    if (links.length > 0) {
      // Prefer green links
      const green = links.find((a) => {
        const c = window.getComputedStyle(a).color;
        const m = c.match(/\d+/g);
        if (!m) return false;
        const [r, g, b] = m.map(Number);
        return g > r + 20 && g > b + 20 && g > 80;
      });
      return green || links[0];
    }

    // If no <a> in the row, return the row itself or the clickable el
    if (el.tagName === 'A' || el.getAttribute('role') === 'button') return el;
    const rowLink = row.querySelector('[role="button"], button, a');
    if (rowLink) return rowLink;
  }

  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
