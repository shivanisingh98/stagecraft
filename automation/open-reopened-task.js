'use strict';

/**
 * open-reopened-task.js
 *
 * Playwright script that:
 *  1. Opens Stagecraft (feather.openai.com) in a visible browser window
 *  2. Navigates to the Available Work tab of the campaign
 *  3. Finds the first task row/link that has a "Reopened" badge/label
 *  4. Clicks it to open the task
 *  5. Leaves the browser open so you can see / interact with the task
 *
 * Usage:
 *   cd automation
 *   npm install
 *   node open-reopened-task.js
 *
 * Authentication:
 *   The script reuses your existing Chrome profile so you stay logged in.
 *   Set CHROME_PROFILE_PATH to your actual Chrome user data dir, e.g.:
 *     Linux   : ~/.config/google-chrome
 *     macOS   : ~/Library/Application Support/Google/Chrome
 *     Windows : %LOCALAPPDATA%\Google\Chrome\User Data
 *
 *   Or leave CHROME_PROFILE_PATH empty to use a fresh (logged-out) browser.
 */

const { chromium } = require('playwright');
const path = require('path');
const os = require('os');

// ─── Config ───────────────────────────────────────────────────────────────────

const AVAILABLE_WORK_URL =
  'https://feather.openai.com/campaigns/2072efd0-e22f-482e-bc2d-01617ce23d23' +
  '?tab=tasks&tasks-tab=unclaimed&is_admin_view=false';

// Path to an existing Chrome profile to reuse your login session.
// Override with the CHROME_PROFILE_PATH environment variable.
const DEFAULT_PROFILE_PATHS = {
  linux:  path.join(os.homedir(), '.config', 'google-chrome'),
  darwin: path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome'),
  win32:  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data'),
};

const CHROME_PROFILE_PATH =
  process.env.CHROME_PROFILE_PATH ||
  DEFAULT_PROFILE_PATHS[process.platform] ||
  '';

// Maximum time (ms) to wait for the task list to appear after navigation
const PAGE_LOAD_TIMEOUT  = 20_000;
// Maximum time (ms) to wait for a "Reopened" task to be visible
const TASK_WAIT_TIMEOUT  = 15_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns true if an element's visible text contains "reopened" (case-insensitive). */
function hasReopenedText(el) {
  return el.innerText.toLowerCase().includes('reopened');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log('Launching browser…');

  let browser;
  let context;

  if (CHROME_PROFILE_PATH) {
    console.log(`Using Chrome profile: ${CHROME_PROFILE_PATH}`);
    // launchPersistentContext reuses the real Chrome profile (stays logged in)
    context = await chromium.launchPersistentContext(CHROME_PROFILE_PATH, {
      headless: false,
      channel: 'chrome',          // use the installed Google Chrome binary
      args: ['--start-maximized'],
      ignoreDefaultArgs: ['--enable-automation'],
    });
  } else {
    console.log('No Chrome profile found – using a fresh browser (you may need to log in).');
    browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
    context = await browser.newContext();
  }

  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

  // ── Step 1: Navigate to the Available Work tab ──────────────────────────────
  console.log('Navigating to Available Work tab…');
  await page.goto(AVAILABLE_WORK_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT });

  // Wait for the page to settle (React/Next.js hydration)
  await page.waitForLoadState('networkidle', { timeout: PAGE_LOAD_TIMEOUT }).catch(() => {
    console.log('(networkidle timeout – continuing anyway)');
  });

  // ── Step 2: Confirm the Available Work tab is active ───────────────────────
  // The URL already targets tasks-tab=unclaimed so no extra click needed, but
  // if the page redirects to a different tab we click the right one.
  const onAvailableWork = page.url().includes('tasks-tab=unclaimed');
  if (!onAvailableWork) {
    console.log('Not on Available Work tab – looking for the tab button…');
    const tabBtn = await page.locator(
      'button:has-text("Available"), [role="tab"]:has-text("Available"), a:has-text("Available Work")'
    ).first();
    if (await tabBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await tabBtn.click();
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    } else {
      console.warn('Could not find "Available Work" tab button – proceeding anyway.');
    }
  }

  console.log('On Available Work tab ✓');

  // ── Step 3: Find the first "Reopened" task ─────────────────────────────────
  console.log('Looking for the first "Reopened" task…');

  // Strategy A: a visible element whose text contains "reopened" AND looks like
  //             a task link (green anchor) or a row
  let reopenedTask = null;

  try {
    // Wait up to TASK_WAIT_TIMEOUT for at least one Reopened item to appear.
    // We check several selector patterns because the exact markup varies.
    reopenedTask = await page.waitForSelector(
      [
        // A link (green task title text) inside a row that contains "Reopened"
        'tr:has-text("Reopened") a',
        '[role="row"]:has-text("Reopened") a',
        // A badge/chip element itself labelled "Reopened"
        '[class*="badge" i]:has-text("Reopened")',
        '[class*="chip" i]:has-text("Reopened")',
        '[class*="status" i]:has-text("Reopened")',
        '[class*="tag" i]:has-text("Reopened")',
        // Fallback: any <a> link inside a container that has "Reopened" text
        'li:has-text("Reopened") a',
        '[class*="task" i]:has-text("Reopened") a',
      ].join(', '),
      { timeout: TASK_WAIT_TIMEOUT }
    );
  } catch {
    console.warn('Specific selectors didn\'t find a Reopened task. Falling back to JS scan…');
  }

  // Strategy B: JavaScript scan for green links whose nearest ancestor row
  //             contains "reopened"
  if (!reopenedTask) {
    reopenedTask = await page.evaluateHandle(() => {
      const links = Array.from(document.querySelectorAll('a'));
      return links.find((a) => {
        if (!a.offsetParent) return false; // not visible
        const row = a.closest('tr, [role="row"], li, [class*="task" i], [class*="row" i]');
        if (!row) return false;
        return row.innerText.toLowerCase().includes('reopened');
      }) || null;
    });

    // evaluateHandle returns a JSHandle; check if it's a real element
    const el = reopenedTask.asElement();
    if (!el) {
      console.error('No Reopened task found in the Available Work tab. Exiting.');
      if (!CHROME_PROFILE_PATH) await browser.close();
      process.exit(1);
    }
    reopenedTask = el;
  }

  console.log('Found a Reopened task ✓');

  // ── Step 4: Click the task to open it ─────────────────────────────────────
  await reopenedTask.scrollIntoViewIfNeeded();
  await reopenedTask.click();
  console.log('Task opened ✓  — browser left open for you to review.');

  // Keep the browser open indefinitely (Ctrl-C to exit)
  await new Promise(() => {});
})();
