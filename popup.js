// popup.js
'use strict';

const statusDot  = document.getElementById('statusDot');
const statusLabel = document.getElementById('statusLabel');
const statusSub  = document.getElementById('statusSub');
const tipBanner  = document.getElementById('tipBanner');
const btnGo      = document.getElementById('btnGo');
const result     = document.getElementById('result');
const resultIcon = document.getElementById('resultIcon');
const resultText = document.getElementById('resultText');
const flash      = document.getElementById('flash');

// Show the tip if Stagecraft is not already open
chrome.tabs.query({ url: 'https://feather.openai.com/*' }, (tabs) => {
  tipBanner.style.display = tabs.length === 0 ? 'block' : 'none';
});

// Show last result from storage (if any)
chrome.storage.local.get(['lastReopenedResult'], ({ lastReopenedResult: r }) => {
  if (!r) return;
  showResult(r.success, r.message);
});

// Listen for result messages from background while the popup is open
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'REOPENED_RESULT') {
    setStatus(msg.success ? 'active' : 'inactive', msg.success ? 'Done' : 'Failed', msg.message);
    showResult(msg.success, msg.message);
    btnGo.disabled = false;
    btnGo.textContent = 'Open Reopened Task';
  }
});

btnGo.addEventListener('click', () => {
  btnGo.disabled = true;
  btnGo.textContent = 'Working…';
  setStatus('active pulse', 'Searching…', 'Looking for a Reopened task');
  result.style.display = 'none';
  flash.style.display  = 'none';

  chrome.runtime.sendMessage({ type: 'OPEN_REOPENED_TASK' });
});

function setStatus(dotClass, label, sub) {
  statusDot.className = `dot ${dotClass}`;
  statusLabel.textContent = label;
  statusSub.textContent = sub;
}

function showResult(success, message) {
  result.style.display = 'flex';
  result.className = `claim-result ${success ? 'ok' : 'fail'}`;
  resultIcon.textContent = success ? '✓' : '⚠';
  resultText.textContent = message;
}
