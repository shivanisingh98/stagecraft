// popup.js
'use strict';

const statusDot   = document.getElementById('statusDot');
const statusLabel = document.getElementById('statusLabel');
const statusSub   = document.getElementById('statusSub');
const tipBanner   = document.getElementById('tipBanner');
const btnGo       = document.getElementById('btnGo');
const result      = document.getElementById('result');
const resultIcon  = document.getElementById('resultIcon');
const resultText  = document.getElementById('resultText');
const flash       = document.getElementById('flash');

// Show tip if Stagecraft is not already open
chrome.tabs.query({ url: 'https://feather.openai.com/*' }, (tabs) => {
  tipBanner.style.display = tabs.length === 0 ? 'block' : 'none';
});

// Show last result from storage
chrome.storage.local.get(['lastClaimResult'], ({ lastClaimResult: r }) => {
  if (!r) return;
  showResult(r.success, r.message);
});

// Listen for results while popup is open
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'TASK_CLAIM_RESULT') {
    setStatus(msg.success ? 'active' : 'inactive', msg.success ? 'Done' : 'Failed', msg.message);
    showResult(msg.success, msg.message);
    btnGo.disabled = false;
    btnGo.textContent = 'Claim Available Task';
  }
});

btnGo.addEventListener('click', () => {
  btnGo.disabled = true;
  btnGo.textContent = 'Working…';
  setStatus('active pulse', 'Searching…', 'Looking for an available task to claim');
  result.style.display = 'none';
  flash.style.display  = 'none';

  chrome.runtime.sendMessage({ type: 'CLAIM_AVAILABLE_TASK' });
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
