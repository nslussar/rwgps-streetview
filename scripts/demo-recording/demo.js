// Launch harness for manually recording the Web Store demo video. Opens
// Chromium with the unpacked extension loaded, clears extension storage so
// the popup re-enters firstrun state, seeds a few demo-friendly storage
// values, navigates to the route, and waits on a keypress so you can record
// the screen at your leisure with QuickTime (Cmd+Shift+5 → Record Selection).
//
// Prereqs:
//   1. `npm install` and `npx playwright install chromium` in this directory
//   2. `npm run setup` once to pin the extension to the toolbar

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '../..');
const PROFILE_DIR = path.resolve(__dirname, '.chrome-profile');
const ROUTE_URL = 'https://ridewithgps.com/routes/52960875';

async function main() {
  if (!fs.existsSync(PROFILE_DIR)) {
    console.error(`Profile dir missing: ${PROFILE_DIR}`);
    console.error('Run `npm run setup` first to create it and pin the extension.');
    process.exit(1);
  }

  // Suppress the "Restore pages? Chromium didn't shut down correctly" bubble
  // that appears when a prior run was force-quit.
  cleanProfileExitState();

  // Maximize the window so a full-screen QuickTime recording (with the dock
  // auto-hidden) captures everything cleanly. viewport:null lets the page
  // size itself to whatever the maximized window provides, instead of being
  // pinned to a fixed CSS-pixel viewport. Native retina is honored without
  // forcing a device-scale-factor.
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: null,
    args: [
      `--disable-extensions-except=${REPO_ROOT}`,
      `--load-extension=${REPO_ROOT}`,
      '--start-maximized',
    ],
  });

  try {
    console.log('Clearing extension storage so the popup opens in firstrun state...');
    await clearExtensionStorage(ctx);

    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(ROUTE_URL, { waitUntil: 'networkidle' });

    console.log('');
    console.log('Browser launched, route loaded. Start your screen recording');
    console.log('and run through the demo manually. Press any key here when');
    console.log('done to close the browser (or hit Ctrl-C to abort).');
    await waitForKeypress('Press any key here to finish...');
  } finally {
    await ctx.close().catch(() => {});
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Pauses until the user presses any key on the controlling terminal. Uses raw
// mode so a single keystroke triggers without requiring Enter. Ctrl-C still
// works (re-thrown as SIGINT).
function waitForKeypress(message) {
  return new Promise((resolve, reject) => {
    process.stdout.write(message + ' ');
    if (!process.stdin.isTTY) {
      console.log('(non-TTY stdin — skipping wait)');
      return resolve();
    }
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', (buf) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (buf[0] === 0x03) return reject(new Error('Aborted by user'));
      resolve();
    });
  });
}

// Mark the prior session as a clean exit so Chrome doesn't show the
// "Restore pages? Chromium didn't shut down correctly" bubble next launch.
function cleanProfileExitState() {
  const prefsPath = path.join(PROFILE_DIR, 'Default', 'Preferences');
  if (!fs.existsSync(prefsPath)) return;
  try {
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
    if (!prefs.profile) prefs.profile = {};
    prefs.profile.exit_type = 'Normal';
    prefs.profile.exited_cleanly = true;
    fs.writeFileSync(prefsPath, JSON.stringify(prefs));
  } catch (e) {
    console.warn('  could not clean profile exit state:', e.message);
  }
}

async function clearExtensionStorage(ctx) {
  let sw = ctx.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'));
  if (!sw) {
    sw = await Promise.race([
      ctx.waitForEvent('serviceworker', { timeout: 10000 }),
      sleep(10000).then(() => null),
    ]);
  }
  if (!sw) {
    console.warn('  extension service worker did not appear within 10s; storage NOT cleared');
    return;
  }
  console.log(`  extension ID: ${new URL(sw.url()).host}`);
  await sw.evaluate(async () => {
    await chrome.storage.sync.clear();
    await chrome.storage.local.clear();
    if (chrome.storage.session) await chrome.storage.session.clear();
    // Demo seeds:
    //  - dwellMs:50 — drop the settle delay so the Street View image
    //    refetches quickly during the recorded sweep (default 200ms is too
    //    slow; 0 is too aggressive now that we pause between hops anyway).
    //  - apiUsage — fake the persistent monthly counter to a realistic
    //    mid-month figure so the popup shows a populated usage meter
    //    instead of starting at 0. Month is set to "now" so the SW's
    //    rollover logic doesn't reset it.
    await chrome.storage.sync.set({ dwellMs: 50 });
    var d = new Date();
    var m = d.getMonth() + 1;
    var monthKey = d.getFullYear() + '-' + (m < 10 ? '0' + m : '' + m);
    await chrome.storage.local.set({
      apiUsage: {
        month: monthKey,
        streetviewNetwork: 3632,
        streetviewCached: 0,
        geocode: 0,
      },
    });
  });
  console.log('  storage cleared; demo seeds (dwellMs=50, apiUsage=3632) written');
}

main().catch(e => { console.error(e); process.exit(1); });
