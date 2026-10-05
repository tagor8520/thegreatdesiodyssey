/**
 * `CNT-01` content-schema gate — the *served* bytes *(no runtime mount required)*
 *
 * The Node tier validates `public/content/states/*.json` as they sit on disk. This
 * tier closes the other half of that claim: the same packs, fetched over the dev
 * server that the game actually uses, and validated **in the page** by the real
 * `ContentSchema.js` module.
 *
 * Three things this can fail that the Node tier cannot:
 *
 * - **The served bytes are not the validated bytes.** A dev-server plugin, a
 *   transform or a stale `public/` copy would all produce a file that passes on
 *   disk and differs over HTTP. The hashes are compared rather than assumed.
 * - **The module does not run in a browser.** The schema is imported over the dev
 *   server (`import('/src/engine/ContentSchema.js')`), so a Node-only API that
 *   slipped into a future edit fails here rather than in a contributor's browser.
 * - **A pack is missing or unreachable over HTTP.** The content path is only real
 *   if `/content/states/<id>.json` resolves to a valid pack.
 *
 * There is deliberately no runtime-mount half: nothing in the shipped game mounts
 * `StateManager` yet, so there is no live surface to drive. Recording that gap is
 * this scenario's job too — the returned summary carries it.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { freshRunDirectory } from '../harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SHIPPED = ['kerala', 'maharashtra'];

/**
 * In the page: import the real schema module, fetch each pack, validate it, and
 * report what the module saw.
 *
 * The hash of the served text is returned so Node can compare it with the file on
 * disk — the point is not that the browser can hash, but that the bytes the gate
 * validated and the bytes the game receives are the same bytes.
 */
const VALIDATE_IN_PAGE = async (names) => {
  const schema = await import('/src/engine/ContentSchema.js');
  const results = [];
  for (const name of names) {
    const url = `/content/states/${name}.json`;
    const response = await fetch(url);
    const text = await response.text();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const entry = { name, url, status: response.status, contentType: response.headers.get('content-type'), hash };
    try {
      const parsed = schema.parseStateContent(text, { sourceName: `${name}.json` });
      results.push({
        ...entry,
        ok: true,
        schemaVersion: parsed.report.schemaVersion,
        namespace: parsed.report.namespace,
        stateId: parsed.content.stateId,
        collectibles: parsed.content.collectibles.length,
        voxels: parsed.report.voxels,
        warnings: parsed.report.warnings,
        migratedFrom: parsed.report.migratedFrom,
      });
    } catch (error) {
      results.push({ ...entry, ok: false, error: error.message, problems: error.problems ?? [] });
    }
  }
  // The legacy path, exercised in the browser rather than only in Node: a v0 file
  // fetched over HTTP must migrate to v1 in-page.
  const legacyText = (await (await fetch('/content/states/kerala.json')).text()).replace(/^\{\n  "schemaVersion": 1,\n/, '{\n');
  let legacy = null;
  try {
    const migrated = schema.parseStateContent(legacyText, { sourceName: 'kerala.json' });
    legacy = {
      ok: true,
      migratedFrom: migrated.report.migratedFrom,
      schemaVersion: migrated.report.schemaVersion,
      stateId: migrated.content.stateId,
    };
  } catch (error) { legacy = { ok: false, error: error.message }; }
  // A rejected pack must produce named problems, not a bare failure.
  const broken = JSON.parse(legacyText);
  broken.collectibles[0].buff.type = 'speeed';
  let rejected = null;
  try {
    schema.parseStateContent(JSON.stringify(broken), { sourceName: 'kerala.json' });
    rejected = { ok: false, note: 'invalid content was accepted' };
  } catch (error) {
    rejected = { ok: true, name: error.name, problems: error.problems };
  }
  return { results, legacy, rejected, schemaVersion: schema.STATE_CONTENT_SCHEMA_VERSION, namespace: schema.describeStateContentSchema().namespace };
};

/** SHA-256 of the file on disk, so "served == validated" is a comparison, not a hope. */
function diskHash(name) {
  return createHash('sha256').update(readFileSync(join(ROOT, 'public', 'content', 'states', `${name}.json`))).digest('hex');
}

export async function run({ page, baseUrl, log = console.log }) {
  const directory = freshRunDirectory('cnt01-content-schema');
  const failures = [];

  // No runtime mount is needed, so the landing shell is enough — and starting a
  // WebGL game to validate three JSON files would be a slower, flakier way to ask
  // the same question.
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const probe = await page.evaluate(VALIDATE_IN_PAGE, SHIPPED);

  log(`\n[cnt01] content schema v${probe.schemaVersion} (${probe.namespace}) over ${baseUrl}`);
  for (const result of probe.results) {
    if (!result.ok) {
      failures.push(`${result.name}: served pack is invalid — ${result.error}`);
      log(`  ${result.name.padEnd(12)} FAILED: ${result.error}`);
      continue;
    }
    const served = result.hash;
    const disk = diskHash(result.name);
    const identical = served === disk;
    log(`  ${result.name.padEnd(12)} ok · stateId=${result.stateId} · ${result.collectibles} collectible(s) · ${result.voxels} voxel(s) · schema v${result.schemaVersion}${result.migratedFrom === null ? '' : ` (migrated from v${result.migratedFrom})`}`);
    log(`    ${result.contentType} · ${result.hash.slice(0, 16)}… served, ${disk.slice(0, 16)}… on disk ${identical ? '(identical)' : '(DIFFERENT)'}`);
    for (const warning of result.warnings) log(`    warning: ${warning}`);
    if (result.status !== 200) failures.push(`${result.name}: served with status ${result.status}`);
    if (!identical) failures.push(`${result.name}: the bytes served over HTTP differ from the validated file on disk`);
    if (result.schemaVersion !== probe.schemaVersion) failures.push(`${result.name}: served pack reports schema v${result.schemaVersion}, module implements v${probe.schemaVersion}`);
    if (result.stateId !== result.name) failures.push(`${result.name}: served pack declares stateId ${JSON.stringify(result.stateId)}`);
  }

  log(`\n[cnt01] legacy path in-page`);
  log(`  v0 pack migrated: ${probe.legacy.ok ? `v${probe.legacy.migratedFrom} → v${probe.legacy.schemaVersion} (${probe.legacy.stateId})` : `FAILED — ${probe.legacy.error}`}`);
  if (!probe.legacy.ok) failures.push(`legacy migration in the browser failed: ${probe.legacy.error}`);
  log(`  invalid pack rejected: ${probe.rejected.ok ? `${probe.rejected.name} naming ${probe.rejected.problems.length} problem(s)` : `NOT rejected — ${probe.rejected.note}`}`);
  log(`    ${(probe.rejected.problems ?? []).join('\n    ')}`);
  if (!probe.rejected.ok) failures.push('invalid content was accepted in the browser');
  if (probe.rejected.ok && !probe.rejected.problems.some(problem => /buff\.type/.test(problem))) {
    failures.push('the browser rejection did not name the offending field');
  }

  // The honest gap. Stated in the output and carried in the report so a later
  // agent reads it here rather than inferring coverage that does not exist.
  const mounted = await page.evaluate(() => Boolean(globalThis.__gdoAudit?.game));
  log(`\n[cnt01] runtime mount: ${mounted ? 'a game handle is present' : 'no runtime mounts state content yet — the loader is dormant, so there is no live surface to drive (CNT-02/CNT-04)'}`);

  log(`\n[cnt01] ${failures.length ? `FAIL (${failures.length}): ${failures[0]}` : `PASS: ${SHIPPED.length} shipped pack(s) validate in the browser, byte-identical to the files the Node tier validated.`}`);

  return {
    directory,
    blockers: failures.length,
    sweepFrames: 0,
    totalPenetrations: 0,
    contentFailures: failures,
    schemaVersion: probe.schemaVersion,
    namespace: probe.namespace,
    packs: probe.results.map(result => ({
      name: result.name, ok: result.ok, status: result.status, stateId: result.stateId ?? null,
      collectibles: result.collectibles ?? null, voxels: result.voxels ?? null,
      warnings: result.warnings ?? [], hashMatch: result.ok ? result.hash === diskHash(result.name) : null,
    })),
    legacy: probe.legacy,
    rejected: probe.rejected,
    runtimeMounted: mounted,
  };
}
