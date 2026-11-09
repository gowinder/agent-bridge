// Headless Firefox check of p0/noise-interop/index.html (real browser wasm + WS).
// Usage: node verify-firefox.mjs <baseUrl> <pskHex>   (requires playwright + firefox build)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let firefox;
try { ({ firefox } = require('playwright')); }
catch { ({ firefox } = createRequire(process.env.PW + '/package.json')('playwright')); }

const base = process.argv[2] ?? 'http://127.0.0.1:8792';
const psk = process.argv[3];
const browser = await firefox.launch({ headless: true });
const page = await browser.newPage();
const consoleMsgs = [];
page.on('console', m => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => consoleMsgs.push('[pageerror] ' + e.message));
const ua = await page.evaluate(() => navigator.userAgent);
const resp = await page.goto(`${base}/?psk=${psk}`, { waitUntil: 'load' });
console.log('HTTP', resp.status(), 'UA', ua);
await page.waitForFunction(() => window.__p0 && window.__p0.done === true, null, { timeout: 90000 });
const p0 = await page.evaluate(() => window.__p0);
console.log(await page.locator('#out').innerText());
console.log('\nRESULT', JSON.stringify({ ua, total: p0.steps.length, failures: p0.failures, fatal: p0.fatal, done: p0.done }, null, 1));
await page.screenshot({ path: process.env.TMPDIR + '/firefox-p0.png', fullPage: true });
if (consoleMsgs.length) console.log('\nconsole:', consoleMsgs.slice(0, 20).join('\n'));
await browser.close();
process.exitCode = p0.failures.length ? 1 : 0;
