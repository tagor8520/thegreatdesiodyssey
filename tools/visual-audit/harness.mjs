/**
 * Chromium acquisition and launch for the visual audit harness.
 *
 * WHY THIS EXISTS INSTEAD OF PLAYWRIGHT/PUPPETEER DEFAULTS
 * --------------------------------------------------------
 * Playwright and Puppeteer both download their browser binary from a CDN at
 * install time (`cdn.playwright.dev`, `storage.googleapis.com`). In restricted
 * build environments those hosts are unreachable while `registry.npmjs.org` is
 * reachable. `@sparticuz/chromium` instead ships the binary *inside the npm
 * tarball* (`bin/chromium.br`, ~67 MB), so it installs from the registry alone.
 *
 * TWO NON-OBVIOUS REQUIREMENTS, both handled here:
 *  1. The binary links against `libnspr4`/`libnss3`, which a bare container does
 *     not have and cannot `apt`-install without root. They ship in
 *     `bin/al2023.tar.br`; we decompress it to `.cache/libs` and expose it via
 *     `LD_LIBRARY_PATH`.
 *  2. Headless software GL needs `--use-gl=angle --use-angle=swiftshader
 *     --enable-unsafe-swiftshader`. Without the last flag, Chromium 153 refuses
 *     to create an unsafe SwiftShader context.
 *
 * MEASUREMENT CAVEAT: SwiftShader is a conformant software rasterizer, so this
 * harness can decide correctness and appearance (clipping, depth order, popping,
 * shimmer, silhouette identity). It is NOT a performance proxy — it renders this
 * game at single-digit FPS. Never record an FPS or frame-time number from it as
 * a shipping claim; those gates still require real hardware.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const toolRoot = here;
export const cacheDir = path.join(here, '.cache');
// The archive stores its payload under a top-level `lib/` directory.
export const libDir = path.join(cacheDir, 'al2023', 'lib');
export const outRoot = path.join(here, 'out');

const CHROMIUM_PACKAGE = '@sparticuz/chromium';

function ensureDependencies() {
  if (fs.existsSync(path.join(here, 'node_modules', 'puppeteer-core')) &&
      fs.existsSync(path.join(here, 'node_modules', '@sparticuz', 'chromium'))) return;
  console.error('[harness] installing isolated audit dependencies (first run only)...');
  execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: here, stdio: 'inherit' });
}

/** Decompress the bundled AL2023 shared libraries the binary links against. */
function ensureLibraries(chromiumBinDir) {
  const marker = path.join(libDir, 'libnspr4.so');
  if (fs.existsSync(marker)) return libDir;
  const archive = path.join(chromiumBinDir, 'al2023.tar.br');
  if (!fs.existsSync(archive)) throw new Error(`Bundled AL2023 library archive missing: ${archive}`);
  fs.rmSync(path.join(cacheDir, 'al2023'), { recursive: true, force: true });
  fs.mkdirSync(path.join(cacheDir, 'al2023'), { recursive: true });
  const tarPath = path.join(cacheDir, 'al2023.tar');
  fs.writeFileSync(tarPath, zlib.brotliDecompressSync(fs.readFileSync(archive)));
  // Archive layout is `lib/<name>.so`; keep it so LD_LIBRARY_PATH can point at `lib/`.
  execFileSync('tar', ['-xf', tarPath, '-C', path.join(cacheDir, 'al2023')], { stdio: 'inherit' });
  fs.rmSync(tarPath, { force: true });
  if (!fs.existsSync(marker)) throw new Error(`Failed to extract libnspr4.so into ${libDir}`);
  return libDir;
}

/**
 * Resolve the Chromium executable path and the environment it needs.
 * Cached after the first call because extraction costs a few seconds.
 */
let prepared = null;
export async function prepareChromium() {
  if (prepared) return prepared;
  ensureDependencies();
  const chromium = (await import(CHROMIUM_PACKAGE)).default;
  const executablePath = await chromium.executablePath();
  const binDir = path.join(here, 'node_modules', '@sparticuz', 'chromium', 'bin');
  const libs = ensureLibraries(binDir);
  prepared = {
    executablePath,
    env: { ...process.env, LD_LIBRARY_PATH: [libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') },
  };
  return prepared;
}

export const LAUNCH_ARGS = Object.freeze([
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--hide-scrollbars',
  '--mute-audio',
]);

export async function launch({ width = 1280, height = 720, deviceScaleFactor = 1 } = {}) {
  const { executablePath, env } = await prepareChromium();
  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: [...LAUNCH_ARGS, `--window-size=${width},${height}`],
    env,
    // Scenarios that read pixels do long synchronous runs inside one
    // `page.evaluate`, and SwiftShader can be slow when a capture deliberately
    // removes the anti-alias policy. The default 180s protocol timeout aborts
    // those runs mid-capture.
    protocolTimeout: 900_000,
  });
  const page = await browser.newPage();
  // `deviceScaleFactor` below 1 is the low-pixel-ratio condition MAT-03's
  // shimmer gate names: fewer device pixels than CSS pixels, so high-frequency
  // surface detail is undersampled and aliasing becomes visible.
  await page.setViewport({ width, height, deviceScaleFactor });
  const logs = [];
  page.on('console', message => {
    if (message.type() === 'error') logs.push({ level: 'error', text: message.text().slice(0, 400) });
  });
  page.on('pageerror', error => logs.push({ level: 'pageerror', text: String(error).slice(0, 400) }));
  return { browser, page, logs };
}

/** Resolve after the browser has painted `count` frames. */
export async function waitFrames(page, count = 1) {
  await page.evaluate(async frames => {
    for (let index = 0; index < frames; index++) {
      await new Promise(resolve => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

/** Wait until the dev-only audit bridge exists, i.e. a runtime is mounted. */
export async function waitForAuditBridge(page, timeout = 60_000) {
  await page.waitForFunction('globalThis.__gdoAudit && globalThis.__gdoAudit.game', { timeout });
}

/** Load the landing shell and mount the curated adventure. */
export async function openCurated(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 90_000 });
  await page.waitForSelector('.odyssey-start', { timeout: 30_000 });
  await page.click('.odyssey-start');
  await waitForAuditBridge(page);
  // The curated world streams in chunks; give the first pass time to settle.
  await waitFrames(page, 6);
}

/**
 * Console errors that are known, tracked, and provably NOT related to the gate
 * under test. Every entry names the defect and where it is recorded, and every
 * filtered error is still printed and written into `report.json` — nothing is
 * dropped silently.
 *
 * `gdoPlantClearance` — the plant pool geometry occupies exactly the 16 vertex
 * attribute slots the WebGL minimum guarantees (8 per-vertex streams + 4
 * `instanceMatrix` columns + 4 custom instanced streams). SwiftShader's linker
 * rejects a program that sits exactly on that boundary. Pre-existing, unrelated
 * to the fixture provider or to camera/water/materials policy under test:
 * `git stash` of the wind change reproduces it identically. See
 * feature-roadmap/VISUAL_GATES.md §F1.
 */
export const KNOWN_CONSOLE_DEFECTS = Object.freeze([
  {
    id: 'F1-plant-attribute-budget',
    pattern: /Too many attributes \(gdoPlantClearance\)|Shader Error 0 - VALIDATE_STATUS false/,
    recordedIn: 'feature-roadmap/VISUAL_GATES.md §6.F1',
  },
]);

/** Split captured console errors into gate-relevant and tracked-known. */
export function classifyConsoleErrors(logs) {
  const relevant = [];
  const known = [];
  for (const entry of logs) {
    const match = KNOWN_CONSOLE_DEFECTS.find(defect => defect.pattern.test(entry.text));
    if (match) known.push({ ...entry, defectId: match.id, recordedIn: match.recordedIn });
    else relevant.push(entry);
  }
  return { relevant, known };
}

/**
 * Select which canonical fixture the dev provider serves. Must be called before
 * navigating, because the provider list is fetched once per page load.
 * Uses Node's own fetch, since the page has no origin before navigation.
 */
export async function selectFixture(_page, origin, { id, variant = 'openmaptiles' }) {
  // Callers pass the base URL, which carries a trailing slash; the middleware
  // matches on an exact pathname, so a doubled slash would 404.
  const base = String(origin).replace(/\/+$/, '');
  const response = await fetch(`${base}/__fixture-tiles/select`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, variant }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Failed to select fixture ${id}/${variant}: ${JSON.stringify(body)}`);
  return body;
}

/**
 * Load the landing shell and mount Coordinate Explorer at a coordinate.
 * Assumes a fixture has already been selected and the dev provider injected.
 */
export async function openCoordinates(page, baseUrl, { latitude = 28.9845, longitude = 77.7064 } = {}) {
  await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 90_000 });
  await page.waitForSelector('.odyssey-coordinate-form', { timeout: 30_000 });
  await page.evaluate(({ latitude: lat, longitude: lon }) => {
    const form = document.querySelector('.odyssey-coordinate-form');
    form.elements.latitude.value = String(lat);
    form.elements.longitude.value = String(lon);
  }, { latitude, longitude });
  await page.click('.odyssey-coordinate-start');
  await waitForAuditBridge(page);
  await waitFrames(page, 6);
}

/** Read the coordinate stats line the runtime already renders. */
export async function readCoordinateStats(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('.geo-panel');
    const text = panel?.innerText ?? '';
    const number = label => {
      const match = text.match(new RegExp(`(\\d+)\\s+${label}`));
      return match ? Number(match[1]) : null;
    };
    return {
      text,
      roads: number('roads'),
      buildings: number('buildings'),
      details: number('details'),
      names: number('names'),
      chunks: number('chunk'),
      provider: /Offline fixture/i.test(text) ? 'offline-fixture' : null,
    };
  });
}


export function freshRunDirectory(label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = path.join(outRoot, `${stamp}-${label}`);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

export async function capture(page, directory, name) {
  const file = path.join(directory, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}
