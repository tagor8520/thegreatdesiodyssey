/**
 * `NET-01` — versioned local save *(one document, both runtimes)*
 *
 * Registered gate (feature-roadmap/README.md order 170):
 *   "Migration-safe settings/discovery/progress"
 *
 * Research (`PROCEDURAL_WORLD_FEATURE_RESEARCH.md` §4.7):
 *   *"Local persistence | IndexedDB record keyed by world-version + coordinate tile +
 *   discovery ID | Revisits retain progress | Low | P1"*.
 *
 * WHAT EACH WORD OF THE GATE MEANS HERE, AND WHAT IS MEASURED FOR IT
 * ------------------------------------------------------------------
 * 1. **settings.** Two declared settings, both two-way in the product and both asserted
 *    through the surface that changes them: the coordinate runtime's review panel
 *    (`showDebug`, toggled by the button *and* by `F3` — the same handler) and the curated
 *    runtime's mute button (`soundEnabled`). Each is toggled, the document is waited for, the
 *    page is *reloaded*, and the restored runtime must behave the setting — the panel open on
 *    mount, the audio graph muted before anything is played.
 * 2. **discovery.** The runtime is driven onto a real resident place so its journal grows by
 *    itself; the section is then read **out of `localStorage`**, and the reloaded runtime must
 *    hold the same ids *before* anything walks anywhere. The gate also re-encodes the runtime's
 *    own live document **in the page** through the module the runtime loaded and requires the
 *    bytes to equal what storage holds — so the file and the live model cannot drift.
 * 3. **progress.** The curated runtime is driven onto a collectible, which is then restored:
 *    the instance must be *gone from the live layout* (not respawned) while its points and its
 *    count are back, in a reloaded session with the same seed. What the document stores is the
 *    id, which is the reason the layout is seeded; a restored *and* still-placed instance would
 *    be a second copy of one pickup.
 * 4. **migration-safe.** A **v0 document** (the pre-schema shape, written into storage by this
 *    gate) must be migrated by the runtime: the journal holds the migrated entries, the stale id
 *    has been re-derived, the `0`/`1` settings have been repaired — and storage must now hold a
 *    **v1** document, because a ladder that never writes back is dead code. A **future** document
 *    and a **corrupt** one must be refused: the runtime still mounts, nothing of the text is
 *    adopted, and the player's bytes survive under the backup key for a support path. The
 *    counter-clause is boundedness: driven synthetically at 60 fps the store writes on change and
 *    not per frame, a still live runtime writes nothing, and a document that would exceed the
 *    byte ceiling is trimmed oldest-first rather than refused.
 *
 * The one-journal decision is asserted rather than implied: the curated runtime restores the
 * coordinate runtime's places and vice versa, because there is one player and one journal.
 */
import { freshRunDirectory, openCoordinates, openCurated, selectFixture, waitFrames } from '../harness.mjs';

const KEY = 'gdo:save';
const BACKUP_KEY = 'gdo:save:unreadable';
const COORDINATE = { latitude: 28.9845, longitude: 77.7064 };

/** The runtime's save surface, its storage, and the landing shell's resume line. */
const READ_PROBE = `() => {
  const game = globalThis.__gdoAudit?.game;
  if (!game) return { mounted: false };
  return {
    mounted: true,
    mode: globalThis.__gdoAudit.mode,
    diagnostics: game.saveDiagnostics ?? null,
    report: game.saveReport ?? null,
    restore: game.saveRestore ?? null,
    save: game.save ? JSON.parse(JSON.stringify(game.save)) : null,
    journal: game.discoveries ?? null,
    journalIds: (game.discoveryJournal?.list?.() ?? []).map(entry => entry.id),
    items: game.items ? {
      collected: game.items.collected,
      score: game.items.score,
      remaining: game.items.items.size,
      collectedIds: [...game.items.collectedIds],
      layoutIds: [...game.items.items.keys()],
    } : null,
    soundEnabled: game.store?.getSnapshot?.().soundEnabled ?? null,
    debugEnabled: game.debugOverlay?.enabled ?? null,
    stored: localStorage.getItem('${KEY}'),
    backup: localStorage.getItem('${BACKUP_KEY}'),
  };
}`;

/**
 * The module the runtime loaded, imported by URL inside the same page. `byteIdentical` is only
 * meaningful while the runtime is quiet, so the caller re-reads until it is.
 */
const MODULE_PROBE = `async () => {
  const module = await import('/src/engine/SaveState.js');
  const game = globalThis.__gdoAudit.game;
  const stored = localStorage.getItem('${KEY}');
  const decoded = module.decodeSave(stored);
  return {
    byteIdentical: decoded.save && !game.saveStore.dirty ? module.encodeSave(game.save) === stored : null,
    dirty: game.saveStore.dirty,
    storedProblems: decoded.problems,
    storedWarnings: decoded.warnings,
    storedVersion: decoded.save?.schemaVersion ?? null,
    runtimeVersion: game.save?.schemaVersion ?? null,
    limits: module.GDO_SAVE_LIMITS,
    settings: Object.keys(module.SAVE_SETTING_FIELDS),
    migrationSteps: module.SAVE_MIGRATION_STEPS,
  };
}`;

/** A v0 document: the pre-schema shape, carrying every repair this ladder makes. */
const LEGACY_DOCUMENT = {
  options: { soundEnabled: 0, showDebug: 1, nonsenseSetting: 'carried from an older build' },
  discovered: [
    { name: 'Sardar Patel Marg', kind: 'street', x: 120.5, z: -40.25, at: 10 },
    { name: 'Nangal Sagar', kind: 'water', x: -300.125, z: 88, id: 'water:nangal-sagar:deadbeef', at: 20 },
  ],
  progress: { states: { maharashtra: { collected: ['vada-pav:0', 'vada-pav:0', 'not-an-id'], score: 25 } } },
};

/**
 * Wait until the change has reached **storage**: the document in `localStorage` satisfies
 * `expression` (which sees `save`, the stored document) and the runtime's store is quiet.
 *
 * Waiting on the stored bytes rather than on the live model is deliberate: the document is
 * written at most once a second, so a live model that already holds the change says nothing
 * about whether the change survives a reload — which is the whole gate.
 *
 * The predicate is a real function: a *string* passed to `page.waitForFunction` is evaluated as
 * an expression, so a string-bodied arrow function is returned as a (truthy) function object and
 * the wait resolves immediately. That mistake made every clause below read a document one write
 * behind; the storage-level wording is what makes this class of error impossible here.
 */
async function waitForStored(page, expression, timeout = 30_000) {
  try {
    await page.waitForFunction((body) => {
      const store = globalThis.__gdoAudit.game?.saveStore;
      if (!store || store.dirty || store.counters.writes === 0) return false;
      let stored = null;
      try { stored = JSON.parse(localStorage.getItem('gdo:save')); } catch { stored = null; }
      if (!stored) return false;
      // eslint-disable-next-line no-new-func
      return Boolean(new Function('save', `return (${body});`)(stored));
    }, { timeout }, expression);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait until the coordinate runtime is accepting input.
 *
 * `GeoPlayer.enabled` is set when the first chunk is resident, and its `ActionInput` vetoes
 * every key until then (`shouldIgnore: () => !this.enabled`) — so a key pressed before readiness
 * is *ignored by design*, which is a different thing from a broken binding.
 */
async function waitForReady(page, timeout = 60_000) {
  try {
    await page.waitForFunction(() => globalThis.__gdoAudit.game?.player?.enabled === true, { timeout });
    return true;
  } catch {
    return false;
  }
}

/** Read the module facts, re-running while the runtime is mid-write. */
async function readModule(page, attempts = 5) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    last = await page.evaluate(`(${MODULE_PROBE})()`);
    if (last.byteIdentical !== null) return last;
    await page.waitForFunction(() => !globalThis.__gdoAudit.game.saveStore.dirty, { timeout: 30_000 }).catch(() => {});
  }
  return last;
}

export async function run({ page, baseUrl, log = console.log, fixtures = ['dense-urban'] }) {
  const directory = freshRunDirectory('net01-local-save');
  const failures = [];
  const fail = message => failures.push(message);
  const summary = {};

  // ------------------------------------------------- 1. write a session (coordinate runtime)
  await selectFixture(page, baseUrl, { id: fixtures[0] });
  // The gate starts from nothing, so the previous session's document is cleared from the
  // landing shell (a document exists there — `about:blank` denies storage access).
  await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 90_000 });
  await page.evaluate(() => { localStorage.clear(); });
  await openCoordinates(page, baseUrl, COORDINATE);
  await page.waitForFunction(() => (globalThis.__gdoAudit.game.visiblePlaces ?? []).length > 0, { timeout: 90_000 });
  const walked = await page.evaluate(() => {
    const game = globalThis.__gdoAudit.game;
    const place = (game.visiblePlaces ?? [])[0] ?? null;
    if (place) { game.player.position.x = place.x; game.player.position.z = place.z; }
    return place ? { name: place.name, kind: place.kind } : null;
  });
  if (!walked) {
    fail('the coordinate runtime shows no named place, so no discovery could be saved');
    return finish({ failures, directory, fixtures, log, summary });
  }
  const discovered = await page.waitForFunction(() => (globalThis.__gdoAudit.game.discoveries?.size ?? 0) >= 1, { timeout: 30_000 })
    .then(() => true, () => false);
  if (!discovered) fail('walking onto a resident place recorded nothing, so there is no discovery to save');
  const wrote = await waitForStored(page, 'save.discovery.entries.length >= 1');
  const first = await page.evaluate(`(${READ_PROBE})()`);
  const firstStored = await page.evaluate(async () => {
    const module = await import('/src/engine/SaveState.js');
    const decoded = module.decodeSave(localStorage.getItem('gdo:save'));
    return { entries: decoded.save?.discovery?.entries?.length ?? null, problems: decoded.problems };
  });
  log(`[net01] coordinate session: ${walked.name} (${walked.kind}) · ${first.diagnostics?.writes} write(s) · ${first.stored?.length ?? 0} bytes · journal ${first.journal?.size} place(s) · live document ${first.save?.discovery?.entries?.length} place(s) · storage ${firstStored.entries} place(s) · storage ${first.diagnostics?.storage}`);
  if (!wrote) fail('the coordinate runtime never wrote a save, so nothing below could be measured');
  if (!first.stored) fail('localStorage holds no save after a session with a discovery in it');
  if (!first.diagnostics?.available) fail('the runtime reports storage as unavailable in a browser that has it');
  if (!(first.journal?.size >= 1)) fail(`the journal holds ${first.journal?.size} place(s) after walking onto one`);
  if (firstStored.entries !== first.journal?.size) {
    fail(`the journal holds ${first.journal?.size} place(s) but the stored document holds ${firstStored.entries}`);
  }
  if (firstStored.problems.length) fail(`the stored document does not validate: ${firstStored.problems.join('; ')}`);

  const module1 = await readModule(page);
  if (module1.storedProblems.length) fail(`the document the runtime wrote does not validate: ${module1.storedProblems.join('; ')}`);
  if (module1.storedVersion !== 1) fail(`the runtime wrote schema version ${module1.storedVersion} rather than 1`);
  if (module1.runtimeVersion !== 1) fail(`the live document is at schema version ${module1.runtimeVersion}`);
  if (module1.byteIdentical === false) {
    fail("the bytes in storage are not the bytes the runtime's own module encodes for its live document");
  }
  if (!module1.settings.includes('soundEnabled') || !module1.settings.includes('showDebug')) {
    fail(`the declared settings table is ${JSON.stringify(module1.settings)}`);
  }
  if (!module1.migrationSteps.some(step => step.from === 0 && step.to === 1)) {
    fail(`the ladder does not carry a 0 → 1 step: ${JSON.stringify(module1.migrationSteps)}`);
  }
  log(`[net01] the stored document is the live document's own bytes: ${module1.byteIdentical} · v${module1.storedVersion} · worldVersion pinned · ${module1.storedWarnings.length} warning(s) · ladder ${JSON.stringify(module1.migrationSteps.map(step => `${step.from}→${step.to}`))}`);
  summary.wrote = { bytes: Number(first.stored.length), writes: first.diagnostics.writes, discoveries: first.journal.size };
  const firstIds = first.journalIds;

  // ------------------------------------------------------- 2. the reload restores the journal
  await openCoordinates(page, baseUrl, COORDINATE);
  await waitFrames(page, 6);
  const restored = await page.evaluate(`(${READ_PROBE})()`);
  log(`[net01] reload at the same coordinate: loaded ${restored.report?.loaded} (v${restored.report?.from} → v${restored.report?.to}) · restored ${restored.restore?.restored} · journal ${restored.journal?.size} with ${restored.journal?.discoveries} new find(s) · ${restored.diagnostics?.bytes} bytes`);
  if (!restored.report?.loaded) fail('the second session did not load the document the first one wrote');
  if (restored.report?.migrated) fail('a v1 document was migrated again');
  if (restored.restore?.restored !== firstIds.length) {
    fail(`the reload restored ${restored.restore?.restored} of ${firstIds.length} journalled place(s)`);
  }
  if (restored.journal?.restored !== firstIds.length) {
    fail(`the journal reports ${restored.journal?.restored} restored entries against ${firstIds.length} in the document`);
  }
  if (JSON.stringify(restored.journalIds.slice(0, firstIds.length)) !== JSON.stringify(firstIds)) {
    fail(`the restored ids are not the ids that were saved:\n  saved ${JSON.stringify(firstIds)}\n  read  ${JSON.stringify(restored.journalIds)}`);
  }
  if (!(restored.diagnostics?.discoveries >= firstIds.length)) {
    fail(`the restored runtime's own document holds ${restored.diagnostics?.discoveries} discoveries`);
  }
  summary.reloaded = { restored: restored.restore?.restored, ids: restored.journalIds, rediscovered: restored.journal?.rediscovered };

  // ------------------------------------------------------------------ 3. a setting, two-way
  // Three things have to hold for `showDebug`, checked in the order the player meets them: the
  // surface must *write* the setting, a reload must *open* the panel from it, and the keyboard
  // must be the same switch as the button. The state is read from the runtime before driving it,
  // so the clause does not depend on which value the save happened to carry.
  const ready = await waitForReady(page);
  if (!ready) fail('the coordinate runtime never finished streaming its first chunk, so its input surface is vetoed and the keyboard route below cannot be exercised');
  const panelBefore = await page.evaluate(`(${READ_PROBE})()`);
  const saved = !panelBefore.debugEnabled;
  await page.click('.geo-debug-toggle');
  const clickWritten = await waitForStored(page, `save.settings.showDebug === ${saved}`);
  // The overlay module is imported on demand, so "closed" is `enabled !== true` rather than a
  // specific null: a panel that has not finished loading is not an open panel.
  await page.waitForFunction((target) => (globalThis.__gdoAudit.game.debugOverlay?.enabled ?? false) === target, { timeout: 20_000 }, saved).catch(() => {});
  const afterClick = await page.evaluate(`(${READ_PROBE})()`);
  log(`[net01] the button wrote the setting: the panel ${panelBefore.debugEnabled} → ${afterClick.debugEnabled}, the document ${panelBefore.save?.settings?.showDebug} → ${afterClick.save?.settings?.showDebug} (written ${clickWritten})`);
  if (!clickWritten) fail(`clicking the review panel did not move the stored setting to ${saved}`);
  if (afterClick.debugEnabled !== saved || afterClick.save?.settings?.showDebug !== saved) {
    fail(`the button moved the panel and the document differently (${afterClick.debugEnabled} against ${afterClick.save?.settings?.showDebug})`);
  }

  // A saved setting is not a second switch: the next session must open the panel from the
  // document, without anyone touching it.
  await openCoordinates(page, baseUrl, COORDINATE);
  const mountReady = await waitForReady(page);
  if (!mountReady) fail('the second coordinate session never became ready');
  await page.waitForFunction((target) => (globalThis.__gdoAudit.game.debugOverlay?.enabled ?? false) === target, { timeout: 30_000 }, saved).catch(() => {});
  const mounted = await page.evaluate(`(${READ_PROBE})()`);
  log(`[net01] the reloaded session: the document says ${mounted.save?.settings?.showDebug} and the panel is ${mounted.debugEnabled}`);
  if (mounted.save?.settings?.showDebug !== saved) {
    fail(`the reloaded session read showDebug ${mounted.save?.settings?.showDebug} against ${saved} in storage`);
  }
  if (mounted.debugEnabled !== saved) {
    fail(`a saved showDebug of ${saved} left the review panel ${mounted.debugEnabled} on mount`);
  }

  // The keyboard route is the registry's: `F3` resolves to the `debug` action, which calls the
  // same `toggleDebug` the button calls. The press is asserted against the registry's own
  // counters as well as the panel and the document, so a vetoed press is visible rather than
  // silent, and both directions are driven.
  const keyBefore = await page.evaluate(() => {
    const input = globalThis.__gdoAudit.game.player?.input;
    return {
      enabled: globalThis.__gdoAudit.game.debugOverlay?.enabled ?? null,
      fired: input?.diagnostics?.actionsFired ?? null, keydowns: input?.diagnostics?.keydowns ?? null, ignored: input?.diagnostics?.ignored ?? null,
    };
  });
  await page.keyboard.press('F3');
  const keyTarget = !keyBefore.enabled;
  const keyMoved = await page.waitForFunction((target) => globalThis.__gdoAudit.game.debugOverlay?.enabled === target, { timeout: 20_000 }, keyTarget)
    .then(() => true, () => false);
  const keyWritten = await waitForStored(page, `save.settings.showDebug === ${keyTarget}`);
  const keyAfter = await page.evaluate(() => {
    const game = globalThis.__gdoAudit.game;
    const input = game.player?.input;
    return {
      enabled: game.debugOverlay?.enabled ?? null, document: game.save.settings.showDebug,
      fired: input?.diagnostics?.actionsFired ?? null, keydowns: input?.diagnostics?.keydowns ?? null, ignored: input?.diagnostics?.ignored ?? null,
    };
  });
  log(`[net01] F3: the panel ${keyBefore.enabled} → ${keyAfter.enabled}, the document ${keyAfter.document} (wanted ${keyTarget}, written ${keyWritten}) · the registry fired ${keyBefore.fired} → ${keyAfter.fired} action(s) over ${keyBefore.keydowns} → ${keyAfter.keydowns} keydown(s), ${keyAfter.ignored} ignored`);
  if (!keyMoved) fail(`pressing F3 did not move the review panel from ${keyBefore.enabled}`);
  if (!keyWritten || keyAfter.document !== keyTarget) fail(`pressing F3 did not move the stored setting to ${keyTarget}`);
  if (!(keyAfter.fired > keyBefore.fired)) fail("the F3 press never reached the runtime's action registry");
  await page.keyboard.press('F3');
  const keyBack = await page.waitForFunction((target) => globalThis.__gdoAudit.game.debugOverlay?.enabled === target, { timeout: 20_000 }, keyBefore.enabled)
    .then(() => true, () => false);
  const keyBackWritten = await waitForStored(page, `save.settings.showDebug === ${keyBefore.enabled}`);
  log(`[net01] F3 again: the panel is ${keyBack ? `back to ${keyBefore.enabled}` : 'NOT back'}, the document ${keyBackWritten ? `back to ${keyBefore.enabled}` : 'NOT back'}`);
  if (!keyBack || !keyBackWritten) fail(`pressing F3 again did not restore the panel and the setting to ${keyBefore.enabled}`);

  // The review surface carries the document, so the panel and the gate cannot drift apart. The
  // overlay renders every line once with no extras when it is switched on (that snapshot says
  // `save unavailable` for every section), and a hidden panel keeps its last text, so the line
  // is only read while the panel is on show and is required to agree, field for field, with the
  // runtime's own document at the instant it is read.
  if (!(await page.evaluate(() => globalThis.__gdoAudit.game.debugOverlay?.enabled === true))) {
    await page.click('.geo-debug-toggle');
    await waitForStored(page, 'save.settings.showDebug === true');
  }
  const panelLine = await page.evaluate(async () => {
    const deadline = performance.now() + 20_000;
    let last = null, matched = null;
    while (performance.now() < deadline) {
      if (globalThis.__gdoAudit.game.debugOverlay?.enabled !== true) return { line: null, agrees: false, live: null, off: true };
      last = (document.querySelector('#geo-debug-output')?.textContent ?? '').split('\n').find(row => row.startsWith('save ')) ?? null;
      const parsed = /^save v(\d+) · (\S+) · places (\d+)\/(\d+) · items (\d+) · writes (\d+) · (\d+) B$/.exec(last ?? '');
      if (!parsed) { await new Promise(resolve => requestAnimationFrame(resolve)); continue; }
      const live = globalThis.__gdoAudit.game.saveDiagnostics;
      const agrees = Number(parsed[1]) === live.version && parsed[2] === live.storage
        && Number(parsed[3]) === live.discoveries && Number(parsed[4]) === live.capacity
        && Number(parsed[5]) === live.collected && Number(parsed[6]) === live.writes && Number(parsed[7]) === live.bytes;
      if (agrees) return { line: last, agrees: true, live, off: false };
      matched = { line: last, agrees: false, live, off: false };
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    return matched ?? { line: null, agrees: false, live: globalThis.__gdoAudit.game.saveDiagnostics, off: false };
  });
  log(`[net01] review panel: "${panelLine.line ?? 'no save line'}" · agrees field for field with the model ${panelLine.agrees} (writes ${panelLine.live?.writes}, ${panelLine.live?.bytes} B, ${panelLine.live?.discoveries} place(s)${panelLine.off ? ', panel hidden' : ''})`);
  if (!panelLine.line || !panelLine.line.startsWith('save v')) fail(`the review panel has no live \`save\` line: ${JSON.stringify(panelLine.line)}`);
  else if (!panelLine.agrees) {
    fail(`the save line does not agree with the runtime's own document: "${panelLine.line}" against ${JSON.stringify({ version: panelLine.live?.version, storage: panelLine.live?.storage, discoveries: panelLine.live?.discoveries, capacity: panelLine.live?.capacity, collected: panelLine.live?.collected, writes: panelLine.live?.writes, bytes: panelLine.live?.bytes })}`);
  }
  summary.panelLine = panelLine.line;

  // --------------------------------------------------------- 4. progress in the curated world
  await openCurated(page, baseUrl);
  await waitFrames(page, 6);
  const curatedStart = await page.evaluate(`(${READ_PROBE})()`);
  const collected = await page.evaluate(async () => {
    const game = globalThis.__gdoAudit.game;
    const deadline = performance.now() + 20_000;
    while (performance.now() < deadline) {
      const item = game.items.items.values().next().value;
      if (item) {
        const position = item.mesh.position;
        game.player.position.set(position.x, position.y, position.z);
        return { id: item.id, points: item.definition.points };
      }
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    return null;
  });
  if (!collected) fail('the curated runtime has no collectible to pick up');
  const pickedUp = collected
    ? await page.waitForFunction(() => (globalThis.__gdoAudit.game.items?.collected ?? 0) >= 1, { timeout: 30_000 }).then(() => true, () => false)
    : false;
  if (!pickedUp) fail('standing on a collectible did not collect it, so there is no progress to save');
  const progressWritten = await waitForStored(page, 'Object.keys(save.progress.states).length > 0');
  const curatedSaved = await page.evaluate(`(${READ_PROBE})()`);
  const section = curatedSaved.save?.progress?.states ?? {};
  const savedIds = Object.values(section).flatMap(record => record.collected ?? []);
  log(`[net01] curated session: picked ${collected?.id} (+${collected?.points}) · saved ${JSON.stringify(section)} · ${curatedSaved.diagnostics?.writes} write(s) · the coordinate places are still in the document: ${curatedSaved.save?.discovery?.entries?.length}`);
  if (!progressWritten) fail('a pickup never reached the save');
  if (!collected || !savedIds.includes(collected.id)) {
    fail(`the collected instance ${collected?.id} is not in the saved progress ${JSON.stringify(savedIds)}`);
  }
  if (curatedSaved.diagnostics?.modes !== 'curated') fail(`the document says the last mode was ${curatedSaved.diagnostics?.modes}`);
  if (!(curatedSaved.save?.progress?.lastCoordinate?.latitude === 28.985)) {
    fail(`the curated session dropped the last coordinate: ${JSON.stringify(curatedSaved.save?.progress?.lastCoordinate)}`);
  }
  // One journal, one player: the curated runtime restores the coordinate runtime's places.
  if (!((curatedSaved.restore?.restored ?? 0) >= firstIds.length)) {
    fail(`the curated runtime restored ${curatedSaved.restore?.restored} of the ${firstIds.length} places the other runtime saved`);
  }

  // The mute button is the second declared setting, and the curated runtime writes it.
  await page.click('button[aria-label="Mute sound"]');
  const muteWritten = await waitForStored(page, 'save.settings.soundEnabled === false');
  if (!muteWritten) fail('muting the curated runtime did not reach the save');

  // ------------------------------------------------------------------- 5. the curated reload
  await openCurated(page, baseUrl);
  await waitFrames(page, 6);
  const curatedReload = await page.evaluate(`(${READ_PROBE})()`);
  log(`[net01] curated reload: items restored ${curatedReload.restore?.items?.restored} (missing ${JSON.stringify(curatedReload.restore?.items?.missing)}) · collected ${curatedReload.items?.collected} + ${curatedReload.items?.score} point(s) · the instance is in the layout ${curatedReload.items?.layoutIds?.includes(collected?.id)} · sound ${curatedReload.soundEnabled} · journal ${curatedReload.journal?.size}`);
  if (!curatedReload.report?.loaded) fail('the curated reload did not load the document');
  if (curatedReload.restore?.items?.restored !== 1) {
    fail(`the curated reload restored ${curatedReload.restore?.items?.restored} collectible(s) against 1 in the document`);
  }
  if ((curatedReload.restore?.items?.missing ?? []).length) {
    fail(`the curated reload could not find ${JSON.stringify(curatedReload.restore?.items?.missing)}`);
  }
  if (curatedReload.items?.layoutIds?.includes(collected?.id)) {
    fail(`the restored instance ${collected?.id} is still in the live layout, so a second copy of one pickup exists`);
  }
  if (!curatedReload.items?.collectedIds?.includes(collected?.id)) {
    fail(`the restored session does not count ${collected?.id} as collected`);
  }
  if (curatedReload.items?.collected !== 1) fail(`the restored session reports ${curatedReload.items?.collected} collected`);
  if (!(curatedReload.items?.score >= (collected?.points ?? 0))) {
    fail(`the restored score is ${curatedReload.items?.score} against ${collected?.points} saved`);
  }
  if (curatedReload.save?.settings?.soundEnabled !== false) fail('the muted setting did not survive the reload');
  if (curatedReload.soundEnabled !== false) fail('the restored runtime did not apply the muted setting to its own audio surface');
  summary.curated = {
    instance: collected?.id, points: collected?.points, section,
    restored: curatedReload.restore?.items?.restored, layout: curatedReload.items?.layoutIds ?? [],
  };

  // ----------------------------------------------------------- 6. the landing shell resumes
  await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 90_000 });
  const landing = await page.evaluate(() => ({
    latitude: document.querySelector('.odyssey-coordinate-form')?.elements?.latitude?.value ?? null,
    longitude: document.querySelector('.odyssey-coordinate-form')?.elements?.longitude?.value ?? null,
    note: document.querySelector('.odyssey-start-note')?.textContent ?? null,
  }));
  log(`[net01] landing resume: ${landing.latitude}, ${landing.longitude} · "${landing.note}"`);
  if (!landing.note || !/^Resume: last session at -?\d+(\.\d+)?, -?\d+(\.\d+)? \((curated|coordinate)\)\.$/.test(landing.note)) {
    fail(`the landing shell did not report the saved session: ${JSON.stringify(landing.note)}`);
  }
  if (landing.latitude === null || Number.isNaN(Number(landing.latitude))) {
    fail('the landing shell did not prefill the coordinate form from the save');
  }
  if (Number(landing.latitude) !== 28.985) fail(`the landing shell prefilled ${landing.latitude}, not the saved coordinate`);
  summary.landing = landing;

  // ------------------------------------------------------------- 7. bounded: change not frame
  await openCoordinates(page, baseUrl, COORDINATE);
  // The live frame loop, sampled per frame. The clause is not "the counter is frozen" — a place
  // can legitimately be discovered during the window — it is "a write happens on a *change* and
  // never on a frame": every frame the store was clean must have contributed a skip and no write.
  const live = await page.evaluate(async () => {
    const store = globalThis.__gdoAudit.game.saveStore;
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const sample = () => ({
      dirty: store.dirty, writes: store.counters.writes, skips: store.counters.unchangedSkips,
      coalesced: store.counters.coalesced, entries: store.save.discovery.entries.length,
    });
    const deadline = performance.now() + 20_000;
    while (performance.now() < deadline && store.dirty) await frame();
    const rows = [sample()];
    for (let index = 0; index < 45; index++) { await frame(); rows.push(sample()); }
    return { rows, intervalMs: store.intervalMs };
  });
  const liveWindows = live.rows.length - 1;
  let cleanWrites = 0, cleanSkips = 0, cleanFrames = 0, dirtyFrames = 0;
  for (let index = 1; index < live.rows.length; index++) {
    const previous = live.rows[index - 1], row = live.rows[index];
    if (previous.dirty) dirtyFrames++;
    else {
      cleanFrames++;
      if (row.writes > previous.writes) cleanWrites++;
      if (row.skips > previous.skips) cleanSkips++;
    }
  }
  const liveWrites = live.rows[live.rows.length - 1].writes - live.rows[0].writes;
  const liveEntries = live.rows[live.rows.length - 1].entries - live.rows[0].entries;
  log(`[net01] live frame loop over ${liveWindows} frames: ${cleanFrames} clean / ${dirtyFrames} dirty · ${cleanWrites} write(s) on a clean frame, ${cleanSkips} skip(s) on one · writes ${live.rows[0].writes} → ${live.rows[live.rows.length - 1].writes}, places +${liveEntries} (interval ${live.intervalMs}ms)`);
  if (cleanWrites !== 0) fail(`${cleanWrites} write(s) happened on a frame the store had nothing to write`);
  if (cleanSkips * 3 < cleanFrames) {
    fail(`only ${cleanSkips} of ${cleanFrames} clean frames reached the store's skip path, so the frame loop is not driving the store`);
  }
  if (liveWrites > 1 + liveEntries) fail(`${liveWrites} write(s) against ${liveEntries} new place(s) over ${liveWindows} frames, so writes are not tracking changes`);
  summary.live = { windows: liveWindows, cleanFrames, dirtyFrames, cleanWrites, cleanSkips, writes: liveWrites, entries: liveEntries, intervalMs: live.intervalMs };

  const budget = await page.evaluate(async () => {
    const module = await import('/src/engine/SaveState.js');
    const storage = module.createMemoryStorage();
    let now = 100_000;
    const store = new module.SaveStore({ storage, clock: () => now, intervalMs: 1000 });
    store.read();
    const frame = () => { now += 16.667; store.tick(); };
    // A first change is written on the next tick, which gives the interval a floor to measure from.
    store.update(save => { save.settings.showDebug = true; });
    frame();
    const firstChange = { writes: store.counters.writes, coalesced: store.counters.coalesced };
    // 60 frames with nothing changing: the store must not write at all.
    const idleStart = { writes: store.counters.writes, skips: store.counters.unchangedSkips };
    for (let i = 0; i < 60; i++) frame();
    const idle = { writes: store.counters.writes - idleStart.writes, skips: store.counters.unchangedSkips - idleStart.skips };
    // The idle run has long outlived the interval, so one more change is written on its next
    // tick — that is the write the coalescing below is measured from.
    store.update(save => { save.progress.lastMode = 'coordinate'; });
    frame();
    const floor = { writes: store.counters.writes, coalesced: store.counters.coalesced };
    // A change *inside* the interval waits: ten frames of coalescing, not one write.
    store.update(save => { save.progress.lastMode = 'curated'; });
    for (let i = 0; i < 10; i++) frame();
    const inside = { writes: store.counters.writes, coalesced: store.counters.coalesced, dirty: store.dirty };
    now += 2_000;
    store.tick();
    const after = { writes: store.counters.writes, dirty: store.dirty, bytes: store.bytes };
    return { firstChange, idle, floor, inside, after, intervalMs: store.intervalMs, limit: module.GDO_SAVE_LIMITS.bytes };
  });
  log(`[net01] write budget: one change ${budget.firstChange.writes} write(s) · ${budget.idle.writes} write(s) over 60 idle frames (${budget.idle.skips} skip(s)) · after the idle run ${budget.floor.writes} write(s) · a change inside the ${budget.intervalMs}ms interval coalesced ${budget.inside.coalesced - budget.floor.coalesced} time(s) and added ${budget.inside.writes - budget.floor.writes} write(s) · past the interval ${budget.after.writes} write(s) in total, dirty ${budget.after.dirty}`);
  if (budget.firstChange.writes !== 1) fail(`one change produced ${budget.firstChange.writes} write(s)`);
  if (budget.idle.writes !== 0) fail(`a still store wrote ${budget.idle.writes} time(s) over 60 idle frames`);
  if (budget.idle.skips < 55) fail(`only ${budget.idle.skips} of 60 idle frames reached the store's skip path`);
  if (budget.floor.writes !== 2) fail(`a change after the idle run produced ${budget.floor.writes} write(s) in total`);
  if (budget.inside.writes !== budget.floor.writes) {
    fail(`a change inside the interval was written immediately (${budget.inside.writes - budget.floor.writes} write(s))`);
  }
  if (!(budget.inside.coalesced - budget.floor.coalesced >= 8)) {
    fail(`only ${budget.inside.coalesced - budget.floor.coalesced} of 10 ticks inside the interval were coalesced`);
  }
  if (!budget.inside.dirty) fail('a change inside the interval was marked clean without being written');
  if (budget.after.writes !== budget.floor.writes + 1) {
    fail(`a change past the interval produced ${budget.after.writes - budget.floor.writes} write(s)`);
  }
  if (budget.after.dirty) fail('the store is still dirty after writing past the interval');
  summary.budget = budget;

  // A document that would exceed the byte ceiling is trimmed oldest-first rather than refused.
  const ceiling = await page.evaluate(async () => {
    const module = await import('/src/engine/SaveState.js');
    const journal = await import('/src/engine/DiscoveryJournal.js');
    const saving = module.createEmptySave({ writtenAt: 1 });
    for (let index = 0; index < module.GDO_SAVE_LIMITS.discoveries; index++) {
      const name = `Place number ${index} with a deliberately long map name`;
      const x = index * 137, z = index * 91;
      saving.discovery.entries.push({
        id: journal.discoveryPlaceId(name, 'place', x, z),
        name, kind: 'place', x, z, radius: 32, discoveredAt: index,
      });
    }
    const full = module.saveByteLength(module.encodeSave(saving));
    const limits = { ...module.GDO_SAVE_LIMITS, bytes: Math.floor(full / 3) };
    const storage = module.createMemoryStorage();
    const store = new module.SaveStore({ storage, clock: () => 0, intervalMs: 0, limits });
    store.update(document => { document.discovery.entries = saving.discovery.entries; });
    const written = store.write({ now: 1 });
    const stored = JSON.parse(storage.getItem('gdo:save'));
    return {
      ceiling: limits.bytes, declared: module.GDO_SAVE_LIMITS.bytes, full, trimmed: store.diagnostics().bytes,
      written, notes: store.diagnostics().migrations.filter(note => /byte ceiling/.test(note)),
      kept: stored.discovery.entries.length, newest: stored.discovery.entries[stored.discovery.entries.length - 1]?.discoveredAt,
      oldest: stored.discovery.entries[0]?.discoveredAt, problems: module.validateSave(stored).problems,
    };
  });
  log(`[net01] byte ceiling: a full ${ceiling.kept >= 0 ? 'document' : ''} is ${ceiling.full} bytes against the declared ${ceiling.declared} · under a ${ceiling.ceiling} ceiling it was written ${ceiling.written} keeping ${ceiling.kept} entries (readings ${ceiling.oldest}–${ceiling.newest}) in ${ceiling.trimmed} bytes with ${ceiling.notes.length} drop note(s)`);
  if (ceiling.full >= ceiling.declared) fail(`a full document of ${ceiling.full} bytes exceeds its own declared ceiling of ${ceiling.declared}`);
  if (!ceiling.written) fail('a document over a (reduced) byte ceiling was refused rather than trimmed');
  if (!ceiling.notes.length) fail('an over-ceiling document was written without a single drop note');
  if (ceiling.newest !== 127) fail(`trimming dropped the newest discovery (newest kept reading ${ceiling.newest})`);
  if (!(ceiling.kept >= 1)) fail('trimming kept no entries at all');
  if (ceiling.problems.length) fail(`the trimmed document does not validate: ${ceiling.problems.join('; ')}`);
  summary.ceiling = ceiling;

  // ------------------------------------------------------------- 8. the ladder, in the runtime
  await page.evaluate(document => {
    localStorage.clear();
    localStorage.setItem('gdo:save', JSON.stringify(document));
  }, LEGACY_DOCUMENT);
  await openCoordinates(page, baseUrl, COORDINATE);
  const migratedWrote = await waitForStored(page, 'save.schemaVersion === 1 && save.discovery.entries.length >= 2');
  const migrated = await page.evaluate(`(${READ_PROBE})()`);
  const migratedModule = await readModule(page);
  const notes = migrated.report?.notes ?? [];
  log(`[net01] v0 document: loaded ${migrated.report?.loaded} migrated ${migrated.report?.migrated} from v${migrated.report?.from} to v${migrated.report?.to} · journal ${migrated.journal?.size} (${JSON.stringify(migrated.journalIds)}) · settings ${JSON.stringify(migrated.save?.settings)} · storage now v${migratedModule.storedVersion} · ${notes.length} note(s)`);
  for (const note of notes) log(`  note: ${note}`);
  if (!migrated.report?.loaded) fail('the runtime refused a v0 document it should have migrated');
  if (migrated.report?.from !== 0 || migrated.report?.to !== 1) fail(`the migration reported v${migrated.report?.from} → v${migrated.report?.to}`);
  if (!migratedWrote || migratedModule.storedVersion !== 1) fail('the migrated document was not written back, so the ladder is dead code in the product');
  const migratedIds = migrated.journalIds;
  if (migratedIds.includes('water:nangal-sagar:deadbeef') || !migratedIds.some(id => id.startsWith('water:nangal-sagar:'))) {
    fail(`the migrated journal ids are ${JSON.stringify(migratedIds)}, which is not the stale id repaired`);
  }
  if (!(migrated.journal?.size >= 2)) fail(`the migrated journal holds ${migrated.journal?.size} of the 2 entries the document carried`);
  if (!((migrated.restore?.restored ?? 0) >= 2)) fail(`the runtime restored ${migrated.restore?.restored} of the migrated entries`);
  if (migrated.save?.settings?.soundEnabled !== false) {
    fail(`the v0 sound setting of 0 was not repaired to false (it reads ${JSON.stringify(migrated.save?.settings?.soundEnabled)})`);
  }
  if (migrated.save?.settings?.showDebug !== true) {
    fail(`the v0 showDebug setting of 1 was not repaired to true (it reads ${JSON.stringify(migrated.save?.settings?.showDebug)})`);
  }
  if (migrated.save?.progress?.states?.maharashtra?.collected?.length !== 1) {
    fail(`the migrated progress holds ${JSON.stringify(migrated.save?.progress?.states?.maharashtra?.collected)}, which is not the deduped list`);
  }
  if (!notes.some(note => /re-derived as/.test(note))) fail('the migration did not report that it re-derived the stale id');
  if (!notes.some(note => /was listed twice/.test(note))) fail('the migration did not report the deduped collectible');
  if (!notes.some(note => /is not declared by this build/.test(note))) fail('the migration kept a setting this build does not declare');
  summary.migration = { from: migrated.report?.from, to: migrated.report?.to, ids: migratedIds, settings: migrated.save?.settings, notes };

  // A second reload is not a migration: the ladder ran once and the file is v1.
  await openCoordinates(page, baseUrl, COORDINATE);
  await waitFrames(page, 6);
  const afterMigration = await page.evaluate(`(${READ_PROBE})()`);
  log(`[net01] the upgraded document on its next session: loaded ${afterMigration.report?.loaded} · migrated ${afterMigration.report?.migrated} · journal ${afterMigration.journal?.size}`);
  if (afterMigration.report?.migrated) fail('the ladder ran twice on the same document');
  if (!afterMigration.report?.loaded) fail('the upgraded document did not load on the next session');

  // A document this build cannot read is refused, and its bytes are kept for support.
  const future = JSON.stringify({ schemaVersion: 2, settings: { soundEnabled: true } });
  await page.evaluate(({ key, text }) => { localStorage.clear(); localStorage.setItem(key, text); }, { key: KEY, text: future });
  await openCoordinates(page, baseUrl, COORDINATE);
  await waitFrames(page, 20);
  const refused = await page.evaluate(`(${READ_PROBE})()`);
  const refusedKept = refused.stored === future;
  log(`[net01] a document from the future: mounted ${refused.mounted} · problems ${JSON.stringify(refused.report?.problems ?? [])} · journal ${refused.journal?.size} · settings ${JSON.stringify(refused.save?.settings)} · the primary key still holds it: ${refusedKept} · the backup holds it: ${refused.backup === future}`);
  if (!refused.mounted) fail('the runtime failed to mount on a document from the future');
  if (refused.report?.loaded) fail('a document from a newer schema was accepted');
  if (!(refused.report?.problems ?? []).some(problem => /newer save schema/.test(problem))) {
    fail(`the refusal did not name the version: ${JSON.stringify(refused.report?.problems ?? [])}`);
  }
  if ((refused.journal?.size ?? 0) !== 0) fail(`the runtime carries ${refused.journal?.size} entries from a document it refused`);
  if ((refused.restore?.restored ?? 0) !== 0) fail('the runtime restored entries from a document it refused');
  if (Object.keys(refused.save?.progress?.states ?? {}).length !== 0) fail('the runtime adopted progress from a document it refused');
  if (refused.save?.settings?.showDebug !== false) fail('the runtime adopted settings from a document it refused');
  if (refused.backup !== future) fail('the unreadable document was not copied aside for support');
  if (refused.diagnostics?.lastProblem === null) fail('the runtime reported no problem for an unreadable document');
  if (!refusedKept) {
    const replacement = await page.evaluate(`(${MODULE_PROBE})()`);
    log(`[net01] note: the primary key was replaced by the runtime's own document (v${replacement.storedVersion}, ${replacement.storedProblems.length} problem(s)); the refused bytes are under the backup key`);
    if (replacement.storedProblems.length) fail(`the runtime replaced an unreadable document with one that does not validate: ${replacement.storedProblems.join('; ')}`);
  }
  summary.refused = { problems: refused.report?.problems, kept: refusedKept, backup: refused.backup === future, journal: refused.journal?.size };

  // ...and so is text that does not parse at all.
  const corrupt = '{"schemaVersion":1,';
  await page.evaluate(({ key, text }) => { localStorage.clear(); localStorage.setItem(key, text); }, { key: KEY, text: corrupt });
  await openCoordinates(page, baseUrl, COORDINATE);
  await waitFrames(page, 12);
  const broken = await page.evaluate(`(${READ_PROBE})()`);
  log(`[net01] corrupt text: mounted ${broken.mounted} · loaded ${broken.report?.loaded} · problems ${JSON.stringify(broken.report?.problems ?? [])} · the backup holds it: ${broken.backup === corrupt} · journal ${broken.journal?.size}`);
  if (!broken.mounted) fail('the runtime failed to mount on corrupt text');
  if (broken.report?.loaded) fail('corrupt text was accepted as a save');
  if (!(broken.report?.problems ?? []).some(problem => /not valid JSON/.test(problem))) {
    fail(`the corrupt-text refusal did not say why: ${JSON.stringify(broken.report?.problems ?? [])}`);
  }
  if (broken.backup !== corrupt) fail('corrupt text was read and then discarded without a copy');
  if ((broken.journal?.size ?? 0) !== 0) fail('the runtime carries entries from corrupt text');
  summary.corrupt = { problems: broken.report?.problems, backup: broken.backup === corrupt };

  return finish({ failures, directory, fixtures, log, summary });
}

function finish({ failures, directory, fixtures, log, summary = null }) {
  log(`[net01] ${failures.length ? 'FAIL' : 'PASS'}: ${failures.length} failure(s)`);
  for (const failure of failures) log(`  ${failure}`);
  return {
    directory,
    blockers: failures.length,
    sweepFrames: 0,
    totalPenetrations: 0,
    saveFailures: failures,
    fixtures,
    summary,
  };
}
