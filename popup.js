// popup.js
'use strict';

const PLATFORM_URL =
  'https://feather.openai.com/campaigns/2072efd0-e22f-482e-bc2d-01617ce23d23' +
  '?tab=tasks&tasks-tab=unclaimed&is_admin_view=false';

// ─── Element refs ─────────────────────────────────────────────────────────────
const statusDot      = document.getElementById('statusDot');
const statusLabel    = document.getElementById('statusLabel');
const statusSub      = document.getElementById('statusSub');
const taskCountEl    = document.getElementById('taskCount');
const lastCheckEl    = document.getElementById('lastCheck');
const enableToggle   = document.getElementById('enableToggle');
const autoClaimToggle = document.getElementById('autoClaimToggle');
const claimBadge     = document.getElementById('claimBadge');
const claimResult    = document.getElementById('claimResult');
const claimResultIcon = document.getElementById('claimResultIcon');
const claimResultText = document.getElementById('claimResultText');
const tipBanner      = document.getElementById('tipBanner');
const btnOpen        = document.getElementById('btnOpen');
const btnScan        = document.getElementById('btnScan');
const flash          = document.getElementById('flash');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function relativeTime(ts) {
  if (!ts) return 'Never';
  const diff = Date.now() - ts;
  if (diff < 5_000)     return 'Just now';
  if (diff < 60_000)    return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

let flashTimer;
function showFlash(msg, type = 'ok') {
  flash.textContent = msg;
  flash.className = type === 'warn' ? 'flash warn' : 'flash';
  flash.style.display = 'block';
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flash.style.display = 'none'; }, 3000);
}

// ─── UI refresh ───────────────────────────────────────────────────────────────

async function refreshUI() {
  const data = await new Promise((res) =>
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, res)
  );
  if (!data) return;

  const { enabled, autoClaim, taskCount, lastCheckTime, lastClaimResult: lcr } = data;

  // Monitoring toggle
  enableToggle.checked = enabled !== false;

  if (enabled !== false) {
    statusDot.className = 'dot active pulse';
    statusLabel.textContent = autoClaim ? 'Auto-claim active' : 'Monitoring active';
    statusSub.textContent = autoClaim
      ? 'Will claim the top task automatically'
      : 'Watching for unclaimed tasks';
  } else {
    statusDot.className = 'dot inactive';
    statusLabel.textContent = 'Monitoring paused';
    statusSub.textContent = 'Enable to receive notifications';
  }

  // Auto-claim toggle
  autoClaimToggle.checked = autoClaim !== false;
  claimBadge.textContent = autoClaim !== false ? 'ON' : 'OFF';
  claimBadge.className = `toggle-badge ${autoClaim !== false ? 'on' : 'off'}`;

  // Stats
  taskCountEl.textContent = taskCount != null ? taskCount : '—';
  lastCheckEl.textContent = relativeTime(lastCheckTime);

  // Last claim result
  if (lcr) {
    claimResult.style.display = 'flex';
    if (lcr.success) {
      claimResult.className = 'claim-result ok';
      claimResultIcon.textContent = '✓';
      claimResultText.textContent = lcr.taskTitle
        ? `Claimed: "${lcr.taskTitle.substring(0, 40)}"`
        : 'Last task claimed successfully';
    } else {
      claimResult.className = 'claim-result fail';
      claimResultIcon.textContent = '⚠';
      claimResultText.textContent = `Claim failed: ${lcr.reason || 'unknown error'}`;
    }
  }
}

// Tip: show if no Stagecraft tab is open
chrome.tabs.query({ url: 'https://feather.openai.com/*' }, (tabs) => {
  tipBanner.style.display = tabs.length === 0 ? 'block' : 'none';
});

// ─── Event handlers ───────────────────────────────────────────────────────────

enableToggle.addEventListener('change', () => {
  chrome.runtime.sendMessage({ type: 'TOGGLE_ENABLED', enabled: enableToggle.checked });
  refreshUI();
});

autoClaimToggle.addEventListener('change', () => {
  chrome.runtime.sendMessage({ type: 'TOGGLE_AUTO_CLAIM', autoClaim: autoClaimToggle.checked });
  refreshUI();
});

btnOpen.addEventListener('click', () => {
  chrome.tabs.query({ url: 'https://feather.openai.com/*' }, (tabs) => {
    if (tabs.length > 0) {
      chrome.tabs.update(tabs[0].id, { active: true, url: PLATFORM_URL });
      chrome.windows.update(tabs[0].windowId, { focused: true });
    } else {
      chrome.tabs.create({ url: PLATFORM_URL });
    }
  });
  window.close();
});

btnScan.addEventListener('click', async () => {
  btnScan.disabled = true;
  btnScan.textContent = 'Scanning…';

  const tabs = await new Promise((res) =>
    chrome.tabs.query({ url: 'https://feather.openai.com/*' }, res)
  );

  if (tabs.length > 0) {
    chrome.tabs.sendMessage(tabs[0].id, { type: 'SCAN_NOW' }).catch(() => {});
    showFlash('Scan triggered!');
  } else {
    showFlash('Open Stagecraft first', 'warn');
  }

  setTimeout(() => {
    btnScan.disabled = false;
    btnScan.textContent = 'Scan Now';
    refreshUI();
  }, 2000);
});

// ─── Init ─────────────────────────────────────────────────────────────────────

refreshUI();
setInterval(refreshUI, 5000);
