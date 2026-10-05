/**
 * `GME-04` — label line-of-sight and the richer map readout *(coordinate mode)*
 *
 * Registered gate (feature-roadmap/README.md order 133):
 *   "A place name behind a building hides within the LOS update interval; a name in
 *    front stays visible; label LOS asks only for LOS blockers; the coordinate
 *    readout names the nearest place; the review panel reports the label LOS profile."
 *
 * Research criteria (`CLIPPING_AND_LAYERING_RESEARCH.md`):
 *   §15.6.1 — a label behind a building is hidden within the update interval, and a
 *             label in front remains visible.
 *   §15.6.2 — label LOS does not consult collectible, grass, bird or bee proxies.
 *   §13     — label LOS is budgeted at 20 tests/second and 5 simultaneous labels at
 *             the low profile; the budget is a ceiling, not a target.
 *   §12.1   — diagnostics expose the label ray, its blocker and the LOS update age.
 *   §12.2   — counters for label LOS tests and hidden labels.
 *
 * WHY THE PAIR IS *FOUND* RATHER THAN AUTHORED
 * -------------------------------------------
 * An occluded label cannot be authored the way a camera sweep can be: whether a name
 * is behind a building depends on the fixture geometry, the player position, the
 * third-person camera offset, and which labels survive the frustum and overlap gates.
 * So this scenario *searches* the live scene — candidate standing positions around
 * each projected label, tested with the world's own `LOS_BLOCKER` sweep — then
 * teleports to a hit and asserts the layer's DOM verdict against that independent
 * probe. Nothing in the search reads the scheduler; the scheduler is only ever
 * compared against the probe, which is what makes the comparison falsifiable.
 *
 * A verdict is only accepted when the scheduler's per-label row is **fresh** (its age
 * is inside the refresh interval). That is the anti-vacuity clause: a fresh row means
 * the label was a candidate in the last pass, so it was on screen and not overlapped,
 * and a hidden verdict can therefore only be about occlusion — not about the label
 * having been culled earlier while a stale verdict lingered.
 *
 * The search is bounded and reports its coverage: if no occluded pair exists in the
 * fixture, the run exits 1 as *uncovered* rather than passing vacuously.
 */
import { freshRunDirectory, openCoordinates, selectFixture } from '../harness.mjs';

/** Reported per-label verdicts are only trusted inside this window (the layer's 250 ms). */
const FRESH_MILLISECONDS = 250;
/** How long to wait, in wall-clock milliseconds, for a verdict to be re-tested. */
const VERDICT_TIMEOUT_MILLISECONDS = 3000;

/**
 * Page-side helpers. Installed once per navigation; everything they need is read
 * from `__gdoAudit.game` at call time, because page callbacks cannot close over
 * module scope.
 */
async function installProbe(page) {
  await page.evaluate(() => {
    const game = globalThis.__gdoAudit.game;
    const world = game.world;
    const LOS = game.queryMasks.LOS_BLOCKER;
    const PROBE_RADIUS = game.labelScheduler.radius;

    /**
     * Wrap the world's obstruction sweep so the *masks the label layer actually
     * asks for* are recorded at runtime. §15.6.2 is a claim about the arguments of
     * this call, so intercepting the call is the only way to check it honestly.
     */
    const calls = [];
    const original = world.sweepSphere.bind(world);
    world.sweepSphere = (x, y, z, dx, dy, dz, radius, out, mask) => {
      const isLabelRay = radius === PROBE_RADIUS;
      const record = isLabelRay ? { mask } : null;
      if (record) calls.push(record);
      const result = original(x, y, z, dx, dy, dz, radius, out, mask);
      if (record) record.blocked = out.hit === true;
      return result;
    };

    const newScratch = () => ({
      hit: false, time: 1, normalX: 0, normalY: 0, normalZ: 0,
      tileKey: null, polygonIndex: -1, dynamicHandle: 0, dynamicOwner: null,
    });

    globalThis.__gdoLabelProbe = {
      probeRadius: PROBE_RADIUS,
      losMask: LOS,
      /** Every sweep the label layer made, with its mask and outcome. */
      losCalls: () => calls.map(record => ({ mask: record.mask, blocked: record.blocked })),
      clearCalls: () => { calls.length = 0; },
      /** The offset the layer adds per kind, so the probe aims at the same point. */
      labelOffset(kind) {
        return kind === 'place' ? 1.25 : kind === 'poi' ? .72 : kind === 'water' ? .28 : .42;
      },
      /** Candidate anchors: committed labels with their world positions. */
      anchors: () => world.visibleLabels.map(label => ({
        name: label.name, kind: label.kind,
        x: label.x, y: label.y ?? 0, z: label.z,
      })),
      /** The DOM label layer, as a player sees it. */
      domLabels: () => [...document.querySelectorAll('.geo-map-label')].map(element => ({
        name: element.dataset.label ?? '',
        kind: element.dataset.kind ?? '',
        hidden: element.hidden,
        los: element.dataset.los ?? null,
        opacity: element.style.opacity || null,
      })).filter(label => label.name),
      /** Scheduler diagnostics, including the per-label rows. */
      diagnostics: () => game.labelDiagnostics,
      /** The coordinate panel text, which carries the richer readout. */
      coordinateText: () => document.querySelector('.geo-coordinates')?.textContent ?? '',
      /**
       * The independent verdict: is the straight line from the camera to this label
       * anchor obstructed by a `LOS_BLOCKER`? Uses the world's own sweep, at the
       * layer's probe radius, with a private scratch object.
       */
      obstructed(anchor) {
        const camera = game.player.camera;
        const out = newScratch();
        const dx = anchor.x - camera.position.x;
        const dy = anchor.y - camera.position.y;
        const dz = anchor.z - camera.position.z;
        world.sweepSphere(camera.position.x, camera.position.y, camera.position.z, dx, dy, dz, PROBE_RADIUS, out, LOS);
        return { blocked: out.hit === true, tileKey: out.tileKey, owner: out.dynamicOwner, time: out.time };
      },
      /**
       * Pure-math search for standing positions whose camera would have an
       * obstructed (`blocked: true`) or a clear (`blocked: false`) ray to a label
       * that is inside the distance window and roughly in front of the player.
       *
       * The third-person camera trails the player by `player.distance` along the
       * facing direction, so the eye is approximated at the standing point with the
       * *current* camera height. That approximation is why the caller must re-verify
       * with real frames: only verified hits count as evidence.
       */
      search(wantBlocked) {
        const out = newScratch();
        const camera = game.player.camera;
        const eyeY = camera.position.y;
        const hits = [];
        // Rings and step count are inlined: a page callback cannot see module scope.
        // Near rings only — a label must stay inside the layer's 72 m distance
        // window, and a building has to fit between the eye and the name.
        const radii = [3, 5, 8, 12];
        const steps = 16;
        for (const anchor of this.anchors()) {
          const targetY = anchor.y + this.labelOffset(anchor.kind);
          for (const radius of radii) {
            for (let step = 0; step < steps; step++) {
              const angle = step * Math.PI * 2 / steps;
              const x = anchor.x + Math.cos(angle) * radius;
              const z = anchor.z + Math.sin(angle) * radius;
              const toX = anchor.x - x, toZ = anchor.z - z;
              const yaw = Math.atan2(-toX, -toZ);            // face the label
              const forwardX = -Math.sin(yaw), forwardZ = -Math.cos(yaw);
              const facing = (forwardX * toX + forwardZ * toZ) / (Math.hypot(toX, toZ) || 1);
              if (facing < .45) continue;                     // outside the frustum's reach
              out.hit = false; out.time = 1; out.tileKey = null; out.dynamicHandle = 0;
              world.sweepSphere(x, eyeY, z, toX, targetY - eyeY, toZ, PROBE_RADIUS, out, LOS);
              if ((out.hit === true) !== wantBlocked) continue;
              hits.push({
                name: anchor.name, kind: anchor.kind, standX: x, standZ: z, distance: radius, yaw,
                sketchBlocker: out.hit === true ? out.tileKey : null,
                // Where along the ray the contact happens. `t = 0` means the eye is
                // *inside* geometry — geometrically blocked, but not a state a player
                // can stand in. An interior contact (0 < t < 1) is the real thing:
                // a wall between the eye and the name.
                time: out.time,
                interior: out.hit === true && out.time > .05 && out.time < .95,
              });
            }
          }
        }
        // Interior contacts first, then nearest: an eye-inside-geometry sample is a
        // legitimate query result but not a player-reachable standing position, so it
        // must never be the evidence for "a name behind a building is hidden".
        hits.sort((a, b) => (Number(b.interior) - Number(a.interior)) || (a.distance - b.distance));
        return hits;
      },
      /** Teleport and let the camera settle: the layer's clock is wall-clock. */
      stand(x, z, yaw) {
        game.player.position.x = x;
        game.player.position.z = z;
        game.player.yaw = yaw;
        // Minimum third-person distance keeps the eye closest to the standing point,
        // which is where the search's approximation was taken.
        game.player.distance = 1.2;
      },
      /** Which labels are currently candidates, with fresh verdicts. */
      freshRows: milliseconds => game.labelDiagnostics.labels
        .filter(row => row.ageMilliseconds <= milliseconds)
        .map(row => ({ key: row.key, blocked: row.blocked, blocker: row.blocker, age: row.ageMilliseconds })),
      /** The debug overlay's own panel, which is the review surface. */
      // The review surface is `#geo-debug-output` (`.geo-debug-output`); there is no
      // `.geo-debug-panel` in the markup, and reading the wrong selector silently
      // reported "no label LOS line" for a panel that was rendering correctly.
      panelText: () => document.querySelector('.geo-debug-output')?.textContent ?? '',
      /** Whether the review panel is visible, not merely present in the DOM. */
      panelVisible: () => {
        const panel = document.querySelector('.geo-debug-output');
        return Boolean(panel) && panel.hidden === false && panel.textContent.length > 0;
      },
      /**
       * The geographic ends of the HUD's own claim: where the player is and where the
       * place it names is. The scenario recomputes the bearing from these two
       * coordinate pairs instead of trusting the printed text.
       */
      hudEnds: () => {
        const player = game.player.position;
        const nearest = game.labelDiagnostics.nearest;
        if (!nearest) return null;
        return {
          from: world.coordinateAt(player.x, player.z),
          to: world.coordinateAt(nearest.x, nearest.z),
          worldDistance: Math.hypot(nearest.x - player.x, nearest.z - player.z),
          name: nearest.name, kind: nearest.kind,
        };
      },
    };
  });
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** Scenario-local bearing, so the HUD is checked against something other than itself. */
function oracleBearing(from, to) {
  const radians = degrees => degrees * Math.PI / 180;
  const fromLat = radians(from.latitude), toLat = radians(to.latitude);
  const deltaLon = radians(to.longitude - from.longitude);
  const y = Math.sin(deltaLon) * Math.cos(toLat);
  const x = Math.cos(fromLat) * Math.sin(toLat) - Math.sin(fromLat) * Math.cos(toLat) * Math.cos(deltaLon);
  const degrees = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  const meanLatitude = radians((from.latitude + to.latitude) / 2);
  const metres = Math.hypot(
    (to.longitude - from.longitude) * Math.cos(meanLatitude) * 111_320,
    (to.latitude - from.latitude) * 111_320,
  );
  return { point: COMPASS[Math.round(degrees / 22.5) % 16], metres, degrees };
}

/** Parse `lat, lon · nearest NAME <distance> <point>` and check it against the oracle. */
function checkReadout(text, ends) {
  const match = /^(-?\d+\.\d{6}), (-?\d+\.\d{6}) · (nearest|water) (.+?) (\d+(?:\.\d+)?) (m|km) ([NSEW]{1,3})$/.exec(text.trim());
  if (!match) return { ok: false, reason: `the readout does not have the documented shape: ${JSON.stringify(text)}` };
  if (!ends) return { ok: false, reason: 'the runtime names no nearest place, so the readout cannot be about one' };
  const printedDistance = Number(match[5]) * (match[6] === 'km' ? 1000 : 1);
  const oracle = oracleBearing(ends.from, ends.to);
  const distanceError = Math.abs(printedDistance - oracle.metres) / Math.max(1, oracle.metres);
  const pointMatches = match[7] === oracle.point;
  return {
    ok: distanceError <= .2 && pointMatches,
    printedDistance, oracleDistance: Math.round(oracle.metres), oraclePoint: oracle.point,
    printedPoint: match[7], distanceError, name: match[4], kind: match[3],
    reason: distanceError > .2 ? `printed ${printedDistance} m vs ${Math.round(oracle.metres)} m from the coordinates`
      : !pointMatches ? `printed ${match[7]} vs ${oracle.point} from the coordinates` : null,
  };
}

/** Wait in wall-clock time: the scheduler's refresh interval is wall-clock based. */
async function waitMilliseconds(page, milliseconds) {
  await page.evaluate(duration => new Promise(resolve => { setTimeout(resolve, duration); }), milliseconds);
}

export async function run({ page, baseUrl, log = console.log, fixtures = ['dense-urban'] }) {
  const directory = freshRunDirectory('gme04-label-los');
  const results = [];

  await selectFixture(page, baseUrl, { id: fixtures[0] });
  await openCoordinates(page, baseUrl, { latitude: 28.9845, longitude: 77.7064 });
  await installProbe(page);
  // Labels are committed per tile, so the first frames carry none: poll instead of
  // guessing a frame count. (Measured: 6 frames yields zero labels, ~30 yields 11.)
  let committed = 0;
  for (let attempt = 0; attempt < 40 && committed === 0; attempt++) {
    await waitMilliseconds(page, 250);
    committed = await page.evaluate(() => globalThis.__gdoLabelProbe.anchors().length);
  }
  // The review panel carries the §12.1/§12.2 label diagnostics, so it has to be on.
  await page.click('.geo-debug-toggle');
  await waitMilliseconds(page, 400);

  const setup = await page.evaluate(() => ({
    probeRadius: globalThis.__gdoLabelProbe.probeRadius,
    losMask: globalThis.__gdoLabelProbe.losMask,
    anchors: globalThis.__gdoLabelProbe.anchors(),
  }));
  log(`[gme04] probe radius ${setup.probeRadius}, LOS mask ${setup.losMask}, ${setup.anchors.length} committed labels: ${setup.anchors.map(anchor => anchor.name).join(', ')}`);
  if (!setup.anchors.length) {
    return { directory, ok: false, reason: 'the fixture commits no labels at all — nothing to test', results };
  }
  if (!Number.isInteger(setup.losMask) || setup.losMask <= 0) {
    return { directory, ok: false, reason: `the runtime exposed no LOS_BLOCKER bit (${setup.losMask})`, results };
  }

  // ---- §15.6.1 occluded half: find a pair, verify it, then read the DOM ---------
  // `search(true)` — omit the polarity and every hit is silently rejected, which is
  // exactly the kind of vacuous pass this gate must not produce.
  const hits = await page.evaluate(() => globalThis.__gdoLabelProbe.search(true));
  // Only *interior* contacts count as evidence: `t = 0` means the sampled eye was
  // inside geometry, which is a legal query result but not a standing position a
  // player can occupy, and a gate that accepted it would pass on a state that cannot
  // happen in play.
  const interiorHits = hits.filter(hit => hit.interior);
  log(`[gme04] search found ${hits.length} obstructed standing positions across ${new Set(hits.map(hit => hit.name)).size} labels (${interiorHits.length} with the wall strictly between eye and name, ${hits.length - interiorHits.length} with the eye inside geometry)`);
  if (!interiorHits.length) {
    return {
      directory, blockers: 1, sweepFrames: 0, totalPenetrations: 0,
      labelFailures: ['every obstructed sample starts inside geometry — no player-reachable "behind a building" state exists in this fixture, so §15.6.1 is uncovered rather than satisfied'],
      fixtures, results, committedLabels: setup.anchors.map(anchor => anchor.name),
    };
  }

  const firstByLabel = new Map();
  for (const hit of interiorHits) if (!firstByLabel.has(hit.name)) firstByLabel.set(hit.name, hit);
  const candidates = [...firstByLabel.values()];

  let occluded = null;
  for (const candidate of candidates.slice(0, 8)) {
    await page.evaluate(item => globalThis.__gdoLabelProbe.stand(item.standX, item.standZ, item.yaw), candidate);
    // The DOM verdict trails the scheduler by one label pass (`isHidden` is read
    // before the pass that refreshes it), so the loop waits for *agreement*:
    // a fresh blocked row, a hidden element, and the label marked `data-los`.
    const deadline = Date.now() + VERDICT_TIMEOUT_MILLISECONDS;
    let observation = null;
    while (Date.now() < deadline) {
      await waitMilliseconds(page, 120);
      observation = await page.evaluate(({ name, freshMilliseconds }) => {
        const anchor = globalThis.__gdoLabelProbe.anchors().find(item => item.name === name);
        if (!anchor) return { offScreen: true };
        const point = { x: anchor.x, y: anchor.y + globalThis.__gdoLabelProbe.labelOffset(anchor.kind), z: anchor.z };
        const obstructed = globalThis.__gdoLabelProbe.obstructed(point);
        const row = globalThis.__gdoLabelProbe.freshRows(freshMilliseconds).find(item => item.key === name) ?? null;
        const dom = globalThis.__gdoLabelProbe.domLabels().find(item => item.name === name) ?? null;
        return { obstructed, row, dom };
      }, { name: candidate.name, freshMilliseconds: FRESH_MILLISECONDS });
      const agreed = observation?.obstructed?.blocked === true && observation.obstructed.time > .05 &&
        observation.row?.blocked === true && observation.dom?.hidden === true && observation.dom.los === 'blocked';
      if (agreed) break;
    }
    const verdict = observation?.row ?? null;
    const dom = observation?.dom ?? null;
    log(`[gme04] ${candidate.name}: contact t=${observation?.obstructed?.time?.toFixed?.(3) ?? 'n/a'} live-blocked=${observation?.obstructed?.blocked} fresh-row=${verdict ? `${verdict.blocked}@${Math.round(verdict.age)}ms` : 'none'} dom.hidden=${dom?.hidden ?? 'absent'} dom.los=${dom?.los ?? 'none'}`);
    results.push({
      name: candidate.name, stage: 'occluded',
      liveBlocked: observation?.obstructed?.blocked ?? null,
      contactTime: observation?.obstructed?.time ?? null,
      row: verdict, domHidden: dom?.hidden ?? null, domLos: dom?.los ?? null,
      blocker: observation?.obstructed?.tileKey ?? null,
    });
    // Acceptance: a wall strictly between the live camera and the anchor, the layer
    // hid the label, and the DOM says why it hid it.
    if (observation?.obstructed?.blocked && observation.obstructed.time > .05 &&
        verdict?.blocked === true && dom?.hidden === true && dom.los === 'blocked') {
      occluded = { name: candidate.name, ...observation };
      break;
    }
  }

  // ---- §12.1: the diagnostics row must carry ray, blocker and age --------------
  const diagnostics = await page.evaluate(() => globalThis.__gdoLabelProbe.diagnostics());
  const rowWithRay = (diagnostics.labels ?? []).find(row => row.ray?.from && row.ray?.to);
  const blockerRow = (diagnostics.labels ?? []).find(row => row.blocked);
  log(`[gme04] diagnostics: tests=${diagnostics.tests} hidden=${diagnostics.hidden} blockedNow=${diagnostics.blockedNow} age=${Math.round(diagnostics.updateAgeMilliseconds)}ms profile=${diagnostics.profile}`);
  log(`[gme04] last blocker: ${diagnostics.lastBlocker ? `${diagnostics.lastBlocker.key}@${diagnostics.lastBlocker.blocker} t=${diagnostics.lastBlocker.time?.toFixed?.(3)}` : 'none'}`);

  // ---- §15.6.1 visible half: a clear ray must leave the label visible ----------
  // The visible half of §15.6.1: find a standing position with a *clear* ray to a
  // label, then require that the layer shows it — with a fresh, non-blocked verdict,
  // so the name is on screen because the ray is clear and not because it was never
  // tested.
  const clearHits = await page.evaluate(() => globalThis.__gdoLabelProbe.search(false));
  log(`[gme04] searches: ${hits.length} obstructed, ${clearHits.length} clear standing positions`);
  const firstClearByLabel = new Map();
  for (const hit of clearHits) if (!firstClearByLabel.has(hit.name)) firstClearByLabel.set(hit.name, hit);

  let visible = null;
  for (const candidate of [...firstClearByLabel.values()].slice(0, 6)) {
    await page.evaluate(item => globalThis.__gdoLabelProbe.stand(item.standX, item.standZ, item.yaw), candidate);
    const deadline = Date.now() + VERDICT_TIMEOUT_MILLISECONDS;
    let observation = null;
    while (Date.now() < deadline) {
      await waitMilliseconds(page, 120);
      observation = await page.evaluate(({ name, freshMilliseconds }) => {
        const anchor = globalThis.__gdoLabelProbe.anchors().find(item => item.name === name);
        if (!anchor) return null;
        const point = { x: anchor.x, y: anchor.y + globalThis.__gdoLabelProbe.labelOffset(anchor.kind), z: anchor.z };
        return {
          obstructed: globalThis.__gdoLabelProbe.obstructed(point),
          row: globalThis.__gdoLabelProbe.freshRows(freshMilliseconds).find(item => item.key === name) ?? null,
          dom: globalThis.__gdoLabelProbe.domLabels().find(item => item.name === name) ?? null,
        };
      }, { name: candidate.name, freshMilliseconds: FRESH_MILLISECONDS });
      if (observation?.row && observation.row.blocked === false) break;
    }
    log(`[gme04] clear: ${candidate.name}: live-ray blocked=${observation?.obstructed?.blocked} fresh-row=${observation?.row ? observation.row.blocked : 'none'} dom.hidden=${observation?.dom?.hidden ?? 'absent'} dom.los=${observation?.dom?.los ?? 'none'}`);
    if (observation?.obstructed?.blocked === false && observation.row?.blocked === false &&
        observation.dom && observation.dom.hidden === false && observation.dom.los === null) {
      visible = { name: candidate.name, ...observation };
      break;
    }
  }
  log(`[gme04] visible-half: ${visible ? `${visible.name} (clear ray, fresh row, visible)` : 'none found'}`);

  // ---- §15.6.2 + §13 + §12.2: the masks and budget observed at runtime --------
  // The failure list is assembled from *observed* values only: every criterion below
  // is a comparison against a measurement, so a scenario that could not measure it
  // fails instead of passing by default.
  const failures = [];
  if (occluded === null) failures.push('no player-reachable label was hidden by a building within the update interval (see the per-candidate attempts above)');
  if (visible === null) failures.push('no label with a clear line of sight stayed visible, so the "in front" half of §15.6.1 is unproven');
  await page.evaluate(() => globalThis.__gdoLabelProbe.clearCalls());
  await waitMilliseconds(page, 1500);
  const runtime = await page.evaluate(() => ({
    calls: globalThis.__gdoLabelProbe.losCalls(),
    diagnostics: globalThis.__gdoLabelProbe.diagnostics(),
    coordinateText: globalThis.__gdoLabelProbe.coordinateText(),
    panelText: globalThis.__gdoLabelProbe.panelText(),
    panelVisible: globalThis.__gdoLabelProbe.panelVisible(),
    hudEnds: globalThis.__gdoLabelProbe.hudEnds(),
  }));
  const masks = [...new Set(runtime.calls.map(call => call.mask))];
  const overBudget = runtime.diagnostics.tests - (diagnostics.tests ?? 0);
  log(`[gme04] observed ${runtime.calls.length} label sweeps in 1500 ms (${overBudget} tests), masks: ${masks.join(', ')} (LOS_BLOCKER=${setup.losMask})`);
  log(`[gme04] coordinate readout: ${runtime.coordinateText}`);
  log(`[gme04] review panel visible: ${runtime.panelVisible}`);
  const panelLine = runtime.panelText.split('\n').find(line => line.startsWith('labels los')) ?? null;
  const hudCheck = checkReadout(runtime.coordinateText, runtime.hudEnds);
  log(`[gme04] HUD check: ${hudCheck.ok ? `printed ${hudCheck.name} ${hudCheck.printedDistance} m ${hudCheck.printedPoint}, oracle ${hudCheck.oracleDistance} m ${hudCheck.oraclePoint}` : hudCheck.reason}`);
  log(`[gme04] review panel: ${panelLine ?? 'no label LOS line'}`);
  log(`[gme04] nearest place: ${JSON.stringify(runtime.diagnostics.nearest)}`);

  // §15.6.2 — every sweep the label layer made must have asked for LOS_BLOCKER and
  // nothing else. A single foreign bit would let a pickup or a bird blank a name.
  if (!runtime.calls.length) failures.push('the label layer cast no rays at all in a 1.5 s window, so occlusion is not being tested');
  if (masks.some(mask => mask !== setup.losMask)) {
    failures.push(`label rays used masks ${masks.map(mask => mask === setup.losMask ? 'LOS_BLOCKER' : mask).join(', ')}; only LOS_BLOCKER is permitted`);
  }
  if (runtime.calls.some(call => call.blocked === null || call.blocked === undefined)) {
    failures.push('a label sweep did not report an outcome, so its verdict cannot be trusted');
  }
  // §13 — the per-second ceiling, measured over the window. One pass of slack is
  // allowed because the token bucket is capped per pass rather than per window.
  const budget = diagnostics.testsPerSecond ?? 0;
  const allowed = Math.ceil(1500 / 1000 * budget) + (diagnostics.simultaneousLabels ?? 0);
  if (overBudget > allowed) failures.push(`${overBudget} label LOS tests in 1500 ms exceeds the ${budget}/s budget (allowance ${allowed})`);
  if (diagnostics.testsPerSecond !== 20 || diagnostics.simultaneousLabels !== 5) {
    failures.push(`the runtime profile is ${diagnostics.testsPerSecond}/s × ${diagnostics.simultaneousLabels}, not the low profile's 20/s × 5`);
  }
  // §12.2 — the counters exist and have counted something.
  if (!(runtime.diagnostics.hidden >= 1)) failures.push(`the hidden-label counter reports ${runtime.diagnostics.hidden}, but this run hid at least one label`);
  // §12.1 — ray, blocker and age, per label and in the newest-blocker summary.
  if (!rowWithRay) failures.push('no per-label diagnostic row carries a ray');
  if (!blockerRow) failures.push('no per-label diagnostic row names a blocker');
  if (!diagnostics.lastBlocker) failures.push('the diagnostics report no last blocker while the run hid a label');
  if (!(diagnostics.updateAgeMilliseconds >= 0)) failures.push('the diagnostics report no LOS update age');
  // §12.4 / review surface — the panel must render the label line, not merely exist.
  if (!runtime.panelVisible) failures.push('the debug review panel is not visible, so the label diagnostics cannot be reviewed');
  if (!panelLine) failures.push('the review panel has no `labels los:` line');
  else if (!/los:low 20\/s max:5 tests:\d+ hidden:\d+ now:\d+ age:\d+ms blocker:/.test(panelLine)) {
    failures.push(`the review panel line does not carry the profile, counters and blocker: ${panelLine}`);
  }
  // The richer map readout: shape, and the bearing/distance recomputed from the
  // coordinates the runtime itself reports.
  if (!hudCheck.ok) failures.push(`the coordinate readout failed its check: ${hudCheck.reason}`);
  if (!runtime.diagnostics.nearest) failures.push('the runtime names no nearest place, so the readout carries only the player position');

  return {
    directory,
    // The convention the other scenarios and `run.mjs` share: `blockers` is the
    // failure count, so a run that did not meet its criteria cannot exit 0.
    blockers: failures.length,
    sweepFrames: 0,
    totalPenetrations: 0,
    labelFailures: failures,
    fixtures,
    probeRadius: setup.probeRadius,
    losMask: setup.losMask,
    committedLabels: setup.anchors.map(anchor => anchor.name),
    searchHits: hits.length,
    interiorHits: interiorHits.length,
    occluded: occluded && {
      name: occluded.name,
      liveBlocker: occluded.obstructed.tileKey,
      liveOwner: occluded.obstructed.owner,
      rayTime: occluded.obstructed.time,
      row: occluded.row,
      domHidden: occluded.dom.hidden,
      domLos: occluded.dom.los,
    },
    visible: visible && { name: visible.name, row: visible.row, los: visible.dom.los, hidden: visible.dom.hidden },
    clearHits: clearHits.length,
    diagnostics: {
      tests: diagnostics.tests, hidden: diagnostics.hidden, blockedNow: diagnostics.blockedNow,
      profile: diagnostics.profile,
      testsPerSecond: diagnostics.testsPerSecond, simultaneousLabels: diagnostics.simultaneousLabels,
      updateAgeMilliseconds: diagnostics.updateAgeMilliseconds,
      lastBlocker: diagnostics.lastBlocker, tracked: diagnostics.tracked,
      hasRayRow: Boolean(rowWithRay), hasBlockerRow: Boolean(blockerRow),
    },
    runtime: {
      masks, sweeps: runtime.calls.length, testsInWindow: overBudget,
      testsPerSecondBudget: diagnostics.testsPerSecond ?? null,
      simultaneousLabels: diagnostics.simultaneousLabels ?? null,
      tests: runtime.diagnostics.tests, hidden: runtime.diagnostics.hidden,
      coordinateText: runtime.coordinateText,
      nearest: runtime.diagnostics.nearest,
      panelLine,
      panelVisible: runtime.panelVisible,
      hudEnds: runtime.hudEnds,
      hudCheck,
    },
    results,
  };
}
