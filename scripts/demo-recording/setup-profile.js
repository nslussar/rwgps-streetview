// One-time setup: launch Chromium with the unpacked extension loaded, wait for
// the user to pin it to the toolbar, then close. The persistent profile dir
// keeps the pin permanent so subsequent demo.js runs reuse it.

const { chromium } = require('playwright');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '../..');
const PROFILE_DIR = path.resolve(__dirname, '.chrome-profile');

(async () => {
  console.log('Launching Chromium with extension loaded...');
  console.log(`  Extension dir: ${REPO_ROOT}`);
  console.log(`  Profile dir:   ${PROFILE_DIR}`);
  console.log('');
  console.log('To complete setup:');
  console.log('  1. Click the puzzle-piece icon in the toolbar.');
  console.log('  2. Click the pin next to "Street View Preview for RideWithGPS".');
  console.log('  3. Close this browser window.');
  console.log('');

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: null,
    args: [
      `--disable-extensions-except=${REPO_ROOT}`,
      `--load-extension=${REPO_ROOT}`,
      '--window-size=1200,800',
    ],
  });

  await new Promise(resolve => ctx.on('close', resolve));
  console.log('Setup complete. Profile saved.');
})().catch(e => { console.error(e); process.exit(1); });
