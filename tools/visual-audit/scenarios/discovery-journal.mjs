/**
 * `GME-06` — discovery journal *(coordinate, with the curated runtime beside it)*
 *
 * Registered gate (feature-roadmap/README.md order 135):
 *   "Deterministic place IDs and bounded local state"
 *
 * Research (`PROCEDURAL_WORLD_FEATURE_RESEARCH.md` §4.7):
 *   *"Enter a POI/site/water/place radius to unlock its map-derived name and type"*, and
 *   batch A item 6: *"Add a discovery journal and one reachable local walking route."*
 *
 * WHAT THE TWO CLAUSES MEAN IN A BROWSER, AND WHAT IS MEASURED FOR EACH
 * --------------------------------------------------------------------
 * 1. **Deterministic place IDs.** "Deterministic" is a claim about two different sessions
 *    agreeing, so it is measured across a reload: the scenario walks into a real map place,
 *    records the id the *runtime* gave it, reloads the runtime, walks into the same place
 *    again and requires the same id. A second, independent check ties that id to the pure
 *    function: the gate imports the runtime's own module *inside the page* (the dev server's
 *    module graph is by URL, so this is the same module the runtime loaded) and recomputes
 *    the id for every place in the corpus, requiring it to equal the id the journal holds.
 *    A third requires the same place offered twice to be one discovery, not two.
 * 2. **Bounded local state.** Two halves. The runtime's own journal is fed the *real* label
 *    corpus gathered from the world's resident tiles across several coordinate origins, and
 *    its byte count must not move while its size stays under its capacity and the
 *    accounting identity `discovered - evicted === size` holds after every offer. Then,
 *    because a fixture corpus is smaller than the shipped capacity of 128, the capacity
 *    bound itself is measured on a small-capacity journal *of the same class in the same
 *    page* over the same real corpus: it must fill to exactly its capacity and stop, and
 *    two journals fed the same places in opposite orders must retain the same ids — the
 *    property that makes a save file (`NET-01`) stable.
 *
 * The wiring claim — that the runtime's own frame loop feeds the journal, rather than the
 * gate feeding it — is measured first and is deliberately *not* simulated: the scenario
 * teleports the player onto a resident label and waits for the journal to grow by itself.
 */
import { freshRunDirectory, openCoordinates, openCurated, selectFixture, waitFrames } from '../harness.mjs';

/**
 * The runtime's journal, the module behind it, and the real places the world is holding.
 * Read-only: everything here reports, nothing here drives the frame loop.
 */
const JOURNAL_PROBE = `() => {
  const game = globalThis.__gdoAudit.game;
  return {
    count: game.discoveries?.size ?? null,
    report: game.discoveries ?? null,
    places: (game.visiblePlaces ?? []).map(place => ({ name: place.name, kind: place.kind, x: place.x, z: place.z })),
    rows: game.discoveryJournal ? game.discoveryJournal.list() : [],
  };
}`;

/** Every label the resident tiles hold — the real corpus, not the 14 the layer shows. */
const DISCOVERABLE_PROBE = `() => {
  const game = globalThis.__gdoAudit.game;
  return (game.discoverablePlaces ?? game.visiblePlaces ?? []).map(place => ({ name: place.name, kind: place.kind, x: place.x, z: place.z }));
}`;

const TILE_CORPUS_PROBE = `() => {
  const game = globalThis.__gdoAudit.game;
  const world = game.world ?? game.domain;
  const rows = [];
  const seen = new Set();
  for (const tile of world.tiles?.values?.() ?? []) {
    for (const label of tile.labels ?? []) {
      if (!label?.name || !Number.isFinite(label.x) || !Number.isFinite(label.z)) continue;
      const key = label.name.toLocaleLowerCase() + '|' + label.kind;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ name: label.name, kind: label.kind, x: label.x, z: label.z });
    }
  }
  return { rows, tiles: world.tiles?.size ?? 0 };
}`;

const COORDINATE_ORIGINS = [
  { latitude: 28.9845, longitude: 77.7064 },
  { latitude: 27.5803, longitude: 77.7004 },
  { latitude: 27.1767, longitude: 78.0081 },
  { latitude: 26.9124, longitude: 75.7873 },
];

/**
 * Wait for the world to stream in a named place.
 *
 * A coordinate session mounts before its tiles arrive, so `visiblePlaces` is empty for the
 * first seconds; a gate that reads it immediately measures the network, not the journal.
 */
const waitForPlaces = async (page, timeout = 90_000) => {
  try {
    await page.waitForFunction(() => (globalThis.__gdoAudit.game.visiblePlaces ?? []).length > 0, { timeout });
    return true;
  } catch {
    return false;
  }
};

const waitForJournal = async (page, minimum, timeout = 30_000) => {
  try {
    await page.waitForFunction(
      count => (globalThis.__gdoAudit.game.discoveries?.size ?? 0) >= count,
      { timeout },
      minimum,
    );
    return true;
  } catch {
    return false;
  }
};

export async function run({ page, baseUrl, log = console.log, fixtures = ['dense-urban'] }) {
  const directory = freshRunDirectory('gme06-discovery-journal');
  const failures = [];

  // --------------------------------------------------- wiring: the runtime feeds the journal
  await selectFixture(page, baseUrl, { id: fixtures[0] });
  await openCoordinates(page, baseUrl, COORDINATE_ORIGINS[0]);
  await page.click('.geo-debug-toggle');
  await waitFrames(page, 8);
  const streamed = await waitForPlaces(page);

  // The player is put exactly on a resident label's anchor; from then on the gate only
  // watches. If the runtime never feeds the journal, nothing below can pass.
  const target = await page.evaluate(() => {
    const game = globalThis.__gdoAudit.game;
    const place = (game.visiblePlaces ?? [])[0] ?? null;
    if (!place) return null;
    game.player.position.x = place.x;
    game.player.position.z = place.z;
    return { name: place.name, kind: place.kind, x: place.x, z: place.z };
  });
  if (!streamed) failures.push('the fixture streamed no named place within 90s, so nothing below could be measured');
  if (!target) {
    failures.push('the coordinate runtime shows no named place at all, so no discovery can happen');
    return finish({ failures, directory, fixtures, log });
  }
  log(`[gme06] standing on a real place: ${target.name} (${target.kind}) at ${target.x.toFixed(1)}, ${target.z.toFixed(1)}`);
  const discovered = await waitForJournal(page, 1);
  const after = await page.evaluate(`(${JOURNAL_PROBE})()`);
  log(`[gme06] the frame loop discovered ${after.count} place(s) by itself: ${(after.rows ?? []).map(row => row.name).join(', ')}`);
  if (!discovered || !after.count) {
    failures.push('walking onto a resident named place recorded nothing, so the runtime does not feed the journal');
  }
  const recorded = after.rows.find(row => row.name === target.name) ?? null;
  if (!recorded) failures.push(`the journal does not hold the place the player walked into (${target.name})`);
  else if (!/^[a-z-]+:[a-z0-9-]+:[0-9a-f]{8}$/.test(recorded.id)) {
    failures.push(`the place id is not the documented shape: ${recorded.id}`);
  }

  // ---------------------------------------------------- the panel carries the journal state
  // The overlay repaints on its own throttle and is handed the journal's report once per
  // frame *before* the label pass runs, so the panel trails a discovery. Wait for it to
  // catch up rather than for a fixed number of frames: a panel that never catches up is a
  // finding, and a fixed wait would report it as a flake.
  const readLine = () => page.evaluate(() => (document.querySelector('#geo-debug-output')?.textContent ?? '')
    .split('\n').find(line => line.startsWith('places ')) ?? null);
  let panelLine = await readLine();
  const panelDeadline = Date.now() + 20_000;
  while (panelLine && /^places 0\//.test(panelLine) && Date.now() < panelDeadline) {
    await waitFrames(page, 2);
    panelLine = await readLine();
  }
  log(`[gme06] review panel: ${panelLine ?? 'no discovery line'}`);
  if (!panelLine) failures.push('the review panel has no `places` line');
  else if (!/^places (\d+)\/(\d+) · discovered \d+ · declined \d+ · evicted \d+( · last .+)?$/.test(panelLine)) {
    failures.push(`the discovery line does not carry the size, the capacity and the counters: ${panelLine}`);
  } else {
    const shown = Number(panelLine.match(/^places (\d+)\//)[1]);
    if (shown !== after.count) failures.push(`the panel shows ${shown} places while the journal holds ${after.count}`);
  }
  if (!(after.report.capacity === 128)) failures.push(`the shipped journal capacity is ${after.report.capacity}, not the documented 128`);
  if (!(after.report.bytes > 0 && after.report.size <= after.report.capacity)) failures.push('the journal reports an impossible size against its capacity');

  // ---------------------------------------------------- determinism across two sessions
  const firstSession = recorded ? { ...recorded } : null;
  let secondSession = null;
  await openCoordinates(page, baseUrl, COORDINATE_ORIGINS[0]);
  await page.click('.geo-debug-toggle');
  await waitFrames(page, 8);
  await waitForPlaces(page);
  // Find the place again through the *world*, not through the HUD: the label layer shows at
  // most 14 names by static priority, and which fourteen is not what determinism is about.
  const secondRun = await page.evaluate(place => {
    const game = globalThis.__gdoAudit.game;
    const world = game.world ?? game.domain;
    let found = (game.visiblePlaces ?? []).find(candidate => candidate.name === place.name) ?? null;
    if (!found) {
      for (const tile of world.tiles?.values?.() ?? []) {
        const match = (tile.labels ?? []).find(label => label.name === place.name);
        if (match) { found = match; break; }
      }
    }
    if (!found) return { found: null };
    game.player.position.x = found.x;
    game.player.position.z = found.z;
    return { found: { name: found.name, kind: found.kind, x: found.x, z: found.z } };
  }, target);
  if (!secondRun.found) {
    failures.push(`the same coordinate no longer offers ${target.name}, so determinism cannot be checked`);
  } else {
    let grown = await waitForJournal(page, 1, 15_000);
    for (let attempt = 0; !grown && attempt < 3; attempt++) {
      const again = await page.evaluate(place => {
        const game = globalThis.__gdoAudit.game;
        const world = game.world ?? game.domain;
        let found = (game.discoverablePlaces ?? []).find(candidate => candidate.name === place.name) ?? null;
        if (!found) {
          for (const tile of world.tiles?.values?.() ?? []) {
            const match = (tile.labels ?? []).find(label => label.name === place.name);
            if (match) { found = match; break; }
          }
        }
        if (!found) return null;
        game.player.position.x = found.x;
        game.player.position.z = found.z;
        return { x: found.x, z: found.z };
      }, target);
      if (!again) break;
      grown = await waitForJournal(page, 1, 10_000);
    }
    const session = await page.evaluate(`(${JOURNAL_PROBE})()`);
    const same = session.rows.find(row => row.name === target.name) ?? null;
    secondSession = same ? { ...same } : null;
    log(`[gme06] second session: ${same ? `${same.id}` : 'the place was not re-recorded'} after ${grown ? 'a discovery' : 'no discovery'}`);
    if (!same) failures.push('a reloaded session did not record the same place, so the journal is not a function of the place');
    else if (firstSession && same.id !== firstSession.id) {
      failures.push(`the same place produced two ids across sessions: ${firstSession.id} then ${same.id}`);
    }
  }

  // -------------------- the ids the runtime holds are the ids the pure function computes
  // The gate imports the runtime's own module inside the page: the dev server's module graph
  // is keyed by URL, so this is the same source the runtime loaded, and the id it computes
  // for a place is the id a second session would compute.
  const functionCheck = await page.evaluate(async () => {
    const module = await import('/src/engine/DiscoveryJournal.js');
    const game = globalThis.__gdoAudit.game;
    const rows = game.discoveryJournal.list();
    const mismatches = [];
    for (const row of rows) {
      const expected = module.discoveryPlaceId(row.name, row.kind, row.x, row.z);
      if (expected !== row.id) mismatches.push({ name: row.name, held: row.id, computed: expected });
      // The same place, offered twice, is one place: the runtime's journal already answers
      // this, so asking it again must be a no-op and must not add an entry.
      const before = game.discoveryJournal.size;
      game.discoveryJournal.consider({ name: row.name, kind: row.kind, x: row.x, z: row.z });
      if (game.discoveryJournal.size !== before) mismatches.push({ name: row.name, why: 'a second offer added an entry' });
    }
    return { rows: rows.length, mismatches, stability: module.discoveryPlaceId(rows[0]?.name ?? 'x', 'place', 1, 2) === module.discoveryPlaceId(rows[0]?.name ?? 'x', 'place', 1, 2) };
  });
  log(`[gme06] ids recomputed in-page for ${functionCheck.rows} held place(s): ${functionCheck.mismatches.length} mismatch(es)`);
  if (!functionCheck.stability) failures.push('the id function is not even stable within one page');
  if (functionCheck.mismatches.length) {
    failures.push(`the journal holds ids the id function does not compute: ${JSON.stringify(functionCheck.mismatches.slice(0, 3))}`);
  }

  // ------------------------------------------- bounded state over the real label corpus
  const corpus = new Map();
  for (const origin of COORDINATE_ORIGINS) {
    await openCoordinates(page, baseUrl, origin);
    await waitFrames(page, 6);
    await waitForPlaces(page);
    const gathered = await page.evaluate(`(${TILE_CORPUS_PROBE})()`);
    for (const row of gathered.rows) corpus.set(`${row.name.toLocaleLowerCase()}|${row.kind}`, row);
    log(`[gme06] ${origin.latitude},${origin.longitude}: ${gathered.rows.length} resident label(s) over ${gathered.tiles} tile(s); corpus ${corpus.size}`);
  }
  const residentSample = await page.evaluate(`(() => {
    const game = globalThis.__gdoAudit.game;
    const place = (game.visiblePlaces ?? [])[0];
    if (place) { game.player.position.x = place.x; game.player.position.z = place.z; }
    return (game.discoverablePlaces ?? []).map(entry => ({ name: entry.name, kind: entry.kind, x: entry.x, z: entry.z }));
  })()`);
  log(`[gme06] standing on a shown name, the runtime offers ${residentSample.length} discoverable place(s) from the resident tiles`);
  if (!residentSample.length) failures.push('the runtime offers no discoverable place at the final coordinate, so the radius path is not exercised');
  const places = [...corpus.values()];
  const bounded = await page.evaluate(async input => {
    const module = await import('/src/engine/DiscoveryJournal.js');
    const game = globalThis.__gdoAudit.game;
    const samples = [];
    // The runtime's own journal is already running on its own clock, so the sweep continues
    // from it: the clock is monotonic by contract, and a sweep that started over at zero
    // would be refused — which is how the first version of this gate found the contract.
    let clock = game.discoveryJournal.diagnostics().clock;
    // The runtime's own journal, fed the real corpus in a shuffled order. Real play would
    // take a long walk to collect these; the per-offer arithmetic is the same either way.
    const shuffled = input.slice();
    for (let index = shuffled.length - 1; index > 0; index--) {
      const swap = (index * 7919) % (index + 1);
      [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
    }
    for (const place of shuffled) {
      clock += 1000;
      game.discoveryJournal.update({ x: place.x, z: place.z }, [place], { now: clock });
      samples.push({ size: game.discoveryJournal.size, bytes: game.discoveryJournal.diagnostics().bytes });
    }
    const journey = game.discoveryJournal.diagnostics();
    // The capacity bound itself, on the same class in the same page, over the same real
    // places: a fixture corpus is smaller than the shipped 128, so the bound is measured at
    // a capacity the corpus can actually exceed.
    const capacity = Math.max(1, Math.min(8, Math.floor(input.length / 2)));
    const small = new module.DiscoveryJournal({ capacity });
    const reverse = new module.DiscoveryJournal({ capacity });
    const bytesAtConstruction = small.diagnostics().bytes;
    let peak = 0;
    for (const place of input) {
      small.update({ x: place.x, z: place.z }, [place], { now: 5 });
      peak = Math.max(peak, small.size);
    }
    for (const place of [...input].reverse()) {
      reverse.update({ x: place.x, z: place.z }, [place], { now: 5 });
    }
    const beforeRepeat = small.diagnostics().discoveries;
    for (const place of input) small.update({ x: place.x, z: place.z }, [place], { now: 5 });
    return {
      offered: shuffled.length,
      sizes: samples.map(sample => sample.size),
      bytes: samples.map(sample => sample.bytes),
      journey,
      capacity,
      peak,
      small: small.diagnostics(),
      reverse: reverse.diagnostics(),
      smallBytes: small.diagnostics().bytes,
      bytesAtConstruction,
      repeatAdded: small.diagnostics().discoveries - beforeRepeat,
      smallIds: small.list().map(row => row.id).sort(),
      reverseIds: reverse.list().map(row => row.id).sort(),
      ids: input.map(place => module.discoveryPlaceId(place.name, place.kind, place.x, place.z)),
    };
  }, places);

  log(`[gme06] corpus of ${bounded.offered} real place(s) through the runtime journal: size ${bounded.journey.size}/${bounded.journey.capacity}, bytes ${bounded.bytes[0]} → ${bounded.bytes[bounded.bytes.length - 1]}, id(s) ${new Set(bounded.ids).size}`);
  log(`[gme06] capacity ${bounded.capacity} journal: peak size ${bounded.peak}, ${bounded.small.discoveries} discovery(ies), ${bounded.small.evicted} evicted, ${bounded.small.declined} declined, bytes ${bounded.bytesAtConstruction} → ${bounded.smallBytes}`);
  if (!(bounded.offered >= 8)) failures.push(`the real corpus is only ${bounded.offered} place(s), which cannot demonstrate a bound`);
  if (new Set(bounded.ids).size !== bounded.ids.length) {
    failures.push('two distinct resident places share an id, so the id is not a function of the place');
  }
  // The runtime's journal, over the whole corpus: the byte count is a function of the
  // capacity, never of the journey.
  if (bounded.bytes.some(bytes => bytes !== bounded.bytes[0])) {
    failures.push(`the journal's storage moved while it was filled: ${JSON.stringify([...new Set(bounded.bytes)])}`);
  }
  if (!(bounded.journey.size <= bounded.journey.capacity)) failures.push('the runtime journal exceeded its capacity');
  if (bounded.journey.discoveries - bounded.journey.evicted !== bounded.journey.size) {
    failures.push(`the runtime journal's books do not balance: ${bounded.journey.discoveries} - ${bounded.journey.evicted} !== ${bounded.journey.size}`);
  }
  if (!(bounded.peak <= bounded.capacity)) failures.push(`a journal of capacity ${bounded.capacity} reached size ${bounded.peak}`);
  if (!(bounded.small.size === bounded.capacity)) failures.push(`a journey longer than the capacity left ${bounded.small.size} of ${bounded.capacity} places`);
  if (bounded.smallBytes !== bounded.bytesAtConstruction) failures.push('the small journal reallocated rather than reusing its slots');
  if (bounded.small.discoveries - bounded.small.evicted !== bounded.small.size) failures.push('the small journal\'s books do not balance');
  if (bounded.small.declined + bounded.small.rediscovered + bounded.small.rejected + bounded.small.discoveries !== bounded.small.considered) {
    failures.push('the small journal did not account for every candidate exactly once');
  }
  if (bounded.repeatAdded !== 0) failures.push(`re-offering the same places discovered ${bounded.repeatAdded} more, so a place is not stable`);
  if (bounded.smallIds.join('|') !== bounded.reverseIds.join('|')) {
    failures.push('two journals over the same places in opposite orders retained different ids, so the journal is order-dependent');
  }

  // ------------------------------------------------------------- the curated runtime
  await openCurated(page, baseUrl);
  await waitFrames(page, 6);
  await waitForPlaces(page, 20_000);
  const curatedPlaces = await page.evaluate(() => (globalThis.__gdoAudit.game.visiblePlaces ?? []).map(place => ({ ...place })));
  void curatedPlaces.length;
  const walked = await page.evaluate(() => {
    const game = globalThis.__gdoAudit.game;
    const place = (game.visiblePlaces ?? [])[0] ?? null;
    if (!place) return null;
    game.player.position.x = place.x;
    game.player.position.z = place.z;
    return { name: place.name, kind: place.kind };
  });
  const curatedGrew = walked ? await waitForJournal(page, 1) : false;
  const curated = await page.evaluate(`(${JOURNAL_PROBE})()`);
  log(`[gme06] curated world: ${curatedPlaces.length} named place(s) (${curatedPlaces.map(place => place.name).join(', ')}), walked into ${walked?.name ?? 'nothing'}, journal holds ${curated.count}`);
  if (!curatedPlaces.length) failures.push('the curated runtime names no places, so its journal can never record one');
  if (!walked || !curatedGrew || !curated.count) {
    failures.push('the curated runtime did not record a landmark the player walked into');
  } else if (!curated.rows.some(row => row.name === walked.name && row.kind === 'landmark')) {
    failures.push(`the curated journal does not hold ${walked.name} as a landmark: ${JSON.stringify(curated.rows)}`);
  }
  if (curated.count && !curated.rows.every(row => /^landmark:[a-z0-9-]+:[0-9a-f]{8}$/.test(row.id))) {
    failures.push(`the curated ids are not landmark ids: ${JSON.stringify(curated.rows.map(row => row.id))}`);
  }

  // The runtime is still running after everything above: the journal is fed on the label
  // refresh, so its update counter must still move on its own.
  const stillFeeding = await page.evaluate(async () => {
    const game = globalThis.__gdoAudit.game;
    const before = game.discoveries.updates;
    for (let frame = 0; frame < 40; frame++) await new Promise(resolve => requestAnimationFrame(resolve));
    return { before, after: game.discoveries.updates };
  });
  log(`[gme06] the curated frame loop kept feeding the journal after capture: updates ${stillFeeding.before} → ${stillFeeding.after}`);
  if (!(stillFeeding.after > stillFeeding.before)) failures.push('the frame loop stopped feeding the journal, so the journal is a one-off read');

  return finish({ failures, directory, fixtures, log, summary: { target, firstSession, secondSession, panelLine, functionCheck, bounded, curated, residentPlaces: residentSample.length } });
}

function finish({ failures, directory, fixtures, log, summary = null }) {
  log(`[gme06] ${failures.length ? 'FAIL' : 'PASS'}: ${failures.length} failure(s)`);
  for (const failure of failures) log(`  ${failure}`);
  return {
    directory,
    blockers: failures.length,
    sweepFrames: 0,
    totalPenetrations: 0,
    discoveryFailures: failures,
    fixtures,
    summary,
  };
}
