/**
 * `LIF-02` — ambient-life scheduler and pools *(coordinate mode)*
 *
 * Registered gate (feature-roadmap/README.md order 121):
 *   "Screen/distance/activity budgets; no per-agent object graphs."
 *
 * Research (`VISUAL_BIOME_BEAUTIFICATION_RESEARCH.md`):
 *   §4 item 10 — *"Birds and bees update instance matrices on the CPU"*, listed as a
 *   defect, not a design.
 *   §14 — *"Small ambient fauna visible | 30 | 60 | 100"* and *"Total added steady
 *   draw calls in ordinary view | ≤ 8"*.
 *   §6 — habitat-anchored families and *"All fauna use pooled, instanced, highly
 *   simplified motion and habitat anchors."*
 *
 * WHAT IS ASSERTED, AND WHY IT IS NOT JUST THE COUNTER
 * ---------------------------------------------------
 * A scheduler that reports "24 visible" while the frame loop still writes every
 * instance matrix would satisfy a counter-based gate and fail the real one. So this
 * scenario checks the **upload**: it reads the actual `InstancedMesh` matrices before
 * and after a frame and counts how many instances moved. That number comes from the
 * renderer's own buffers, not from the scheduler's bookkeeping, so a frame loop that
 * bypassed the budget — the pre-`LIF-02` behaviour, which walked every instance of
 * every resident tile — fails here even though the scheduler's own numbers would look
 * correct.
 *
 * The live run also proves the two budgets separately, because they are different
 * claims: the *drawn* set is capped by the profile's visible ceiling (30 at `low`), and
 * the per-frame *work* is capped by the pose budget (24). The first version of the
 * scheduler bounded only the second, which let a resident set larger than the ceiling
 * draw every agent.
 *
 * THE RUN IS FORCED TO BE NON-VACUOUS
 * ----------------------------------
 * A ceiling that is never approached proves nothing. Tiles prefetch when the player is
 * within 20% of a tile edge (`GEO_STREAMING_LIMITS.prefetchEdgeFraction`), and every
 * resident tile mounts its own ambience, so the scenario opens coordinates 8% inside a
 * tile corner: four tiles stream in, roughly four tiles' worth of agents become
 * resident, and the ceiling *has* to bite. If the resident count never exceeds the
 * ceiling the run is reported as a failure rather than as a pass.
 */
import { freshRunDirectory, openCoordinates, selectFixture } from '../harness.mjs';
import { createGeoReference, tileFractionToCoordinate } from '../../../src/geo/GeoMath.js';

const BASE_LATITUDE = 28.9845;
const BASE_LONGITUDE = 77.7064;

/**
 * A coordinate 8% inside the corner of the tile the base coordinate sits in, so the
 * player is inside the prefetch band of two axes at once and all four surrounding
 * tiles are requested. Derived from the same `GeoMath` module the runtime uses, so the
 * fixture coverage is unchanged — this is the same city block, seen from a corner.
 */
function cornerCoordinate() {
  const reference = createGeoReference(BASE_LATITUDE, BASE_LONGITUDE);
  const x = Math.floor(reference.originX), y = Math.floor(reference.originY);
  return tileFractionToCoordinate(x + 0.08, y + 0.08, reference.zoom);
}

/** Wall-clock wait: the scheduler's clock is the frame clock, so waits are real time. */
async function waitMilliseconds(page, milliseconds) {
  await page.evaluate(duration => new Promise(resolve => { setTimeout(resolve, duration); }), milliseconds);
}

async function installProbe(page) {
  await page.evaluate(() => {
    const world = globalThis.__gdoAudit.game.world;

    const ambienceMeshes = () => [...world.tiles.values()]
      .flatMap(tile => Object.values(tile.ambientMeshes ?? {}))
      .filter(mesh => mesh && mesh.count > 0);

    globalThis.__gdoAmbientProbe = {
      /** The scheduler's own diagnostics, plus what the world reports. */
      diagnostics: () => world.ambientDiagnostics,
      /** How many tiles currently carry ambience, and how many instances they hold. */
      resident: () => ({
        tiles: [...world.tiles.values()].filter(tile => tile.ambientMeshes && Object.values(tile.ambientMeshes).some(mesh => mesh?.count > 0)).length,
        instances: ambienceMeshes().reduce((sum, mesh) => sum + mesh.count, 0),
        meshes: ambienceMeshes().length,
      }),
      /**
       * How many instances the *renderer's buffers* moved between two reads, and how
       * many were collapsed (the hiding pose: zero scale). This is the independent
       * measurement — it comes from `InstancedMesh.instanceMatrix`, the same array
       * three.js uploads, so no amount of scheduler bookkeeping can satisfy it.
       */
      /**
       * How many instances the *renderer's buffers* moved across exactly one scheduler
       * pass, and how many are collapsed (the hiding pose: zero scale).
       *
       * The window is delimited by the scheduler's own pass counter rather than by wall
       * clock, because on this software renderer a frame can take hundreds of
       * milliseconds: a fixed 120 ms window was measured containing zero frames, which
       * made "nothing moved" mean nothing. Waiting for the counter to advance, then for
       * one animation frame so that pass's upload has landed, bounds what is measured to
       * a single pass plus at most one more — which is exactly what the allowance
       * (`drawn + per-frame`) covers. It is also self-certifying: the caller can see
       * `passesDelta`, so a window with no pass is never mistaken for a quiet pass.
       */
      movedInstances: async timeoutMilliseconds => {
        const meshes = ambienceMeshes();
        const identities = meshes.map(mesh => mesh.id);
        const snapshot = () => meshes.map(mesh => {
          const data = [];
          for (let index = 0; index < mesh.count; index++) {
            data.push(
              mesh.instanceMatrix.array[index * 16 + 12],
              mesh.instanceMatrix.array[index * 16 + 13],
              mesh.instanceMatrix.array[index * 16 + 14],
            );
          }
          return data;
        });
        const before = snapshot();
        const startPasses = world.ambientDiagnostics.passes;
        const deadline = performance.now() + timeoutMilliseconds;
        while (world.ambientDiagnostics.passes === startPasses && performance.now() < deadline) {
          await new Promise(resolve => requestAnimationFrame(() => resolve()));
        }
        const passesDelta = world.ambientDiagnostics.passes - startPasses;
        // One frame for the pass's own writes to land. `writeMatrices` runs immediately
        // after `update` inside the same frame, so a single frame is enough.
        await new Promise(resolve => requestAnimationFrame(() => resolve()));
        let moved = 0, collapsed = 0, instances = 0;
        meshes.forEach((mesh, meshIndex) => {
          for (let index = 0; index < mesh.count; index++) {
            const offset = index * 16;
            instances++;
            const array = mesh.instanceMatrix.array;
            if (array[offset + 0] === 0 && array[offset + 5] === 0 && array[offset + 10] === 0) { collapsed++; continue; }
            const previous = before[meshIndex];
            if (previous[index * 3] !== array[offset + 12]
              || previous[index * 3 + 1] !== array[offset + 13]
              || previous[index * 3 + 2] !== array[offset + 14]) moved++;
          }
        });
        const after = world.ambientDiagnostics;
        const alive = new Set([...world.tiles.values()].flatMap(tile => Object.values(tile.ambientMeshes ?? {})).filter(Boolean).map(mesh => mesh.id));
        return {
          moved, collapsed, instances, meshes: meshes.length,
          orphaned: identities.filter(id => !alive.has(id)).length,
          passesDelta,
          // The most recent pass's own pose count, not a difference of cumulative
          // counters: reading a delta here raced with the pass that was still running,
          // which made a correct run report "a pass with no pose updates" about once in
          // three. `lastPoseUpdates` is what that pass actually did.
          posesThisPass: after.lastPoseUpdates,
          drawnSlots: after.drawnSlots,
        };
      },
      /** Drive the activity budget the way a weather or dusk state will. */
      setActivity: (value, speciesActivity = null) => world.setAmbientActivity(value, speciesActivity),
      /** The debug overlay's ambience line, which is the review surface. */
      panelAmbienceLine: () => (document.querySelector('#geo-debug-output')?.textContent ?? '')
        .split('\n').find(line => line.startsWith('ambience ')) ?? null,
      panelVisible: () => {
        const panel = document.querySelector('#geo-debug-output');
        return Boolean(panel) && panel.hidden === false && panel.textContent.length > 0;
      },
    };
  });
}

export async function run({ page, baseUrl, log = console.log, fixtures = ['dense-urban'] }) {
  const directory = freshRunDirectory('lif02-ambient-life');
  const failures = [];
  const corner = cornerCoordinate();

  await selectFixture(page, baseUrl, { id: fixtures[0] });
  await openCoordinates(page, baseUrl, corner);
  await installProbe(page);

  // Ambience is claimed when tiles compile, which is asynchronous, so poll rather than
  // guess a frame count.
  let claimed = 0;
  for (let attempt = 0; attempt < 60 && claimed === 0; attempt++) {
    await waitMilliseconds(page, 250);
    claimed = await page.evaluate(() => globalThis.__gdoAmbientProbe.diagnostics().active);
  }
  await page.click('.geo-debug-toggle');
  await waitMilliseconds(page, 400);
  const first = await page.evaluate(() => globalThis.__gdoAmbientProbe.diagnostics());
  log(`[lif02] profile ${first.profile}, capacity ${first.capacity}, claimed ${first.active}, ceiling ${first.visibleCeiling}, per-frame ${first.perFrame}, max distance ${first.maxDistance}`);
  if (!first.active) {
    return { directory, blockers: 1, sweepFrames: 0, totalPenetrations: 0, ambientFailures: ['no ambience slot was claimed, so nothing about the scheduler is being exercised'], fixtures };
  }

  // ---- the resident set has to exceed the ceiling, or nothing is proven ---------
  // The non-vacuity precondition is that *more* agents are resident than the allowance
  // the upload check permits (`drawn + per-frame`). A frame loop that bypassed the
  // scheduler would then have to be caught, because it would move more instances than
  // the allowance — there is nowhere for it to hide. Requiring only "more than the
  // ceiling" was not enough: a run with three tiles resident moved 44 instances, which
  // slipped under a 54-instance allowance and let the defect through.
  const allowance = () => first.visibleCeiling + first.perFrame;
  let resident = await page.evaluate(() => globalThis.__gdoAmbientProbe.resident());
  let settled = 0;
  for (let attempt = 0; attempt < 80; attempt++) {
    await waitMilliseconds(page, 250);
    const next = await page.evaluate(() => globalThis.__gdoAmbientProbe.resident());
    // Stability, not just size: streaming churn makes one sample a poor basis for a
    // budget claim, so three consecutive equal readings are required.
    settled = next.instances === resident.instances && next.tiles === resident.tiles ? settled + 1 : 0;
    resident = next;
    if (settled >= 3 && resident.instances > allowance()) break;
  }
  log(`[lif02] resident: ${resident.instances} instance(s) across ${resident.meshes} mesh(es) on ${resident.tiles} tile(s), stable across ${settled + 1} reading(s); allowance ${allowance()}`);
  if (!(resident.instances > allowance())) {
    failures.push(`only ${resident.instances} agents were resident on ${resident.tiles} tile(s), which does not exceed the ${allowance()} the check allows to move, so a bypass could not be detected and the run proves nothing`);
  }

  // ---- the budgets -------------------------------------------------------------
  const budget = await page.evaluate(() => globalThis.__gdoAmbientProbe.diagnostics());
  log(`[lif02] drawn ${budget.drawnSlots} (ceiling ${budget.visibleCeiling}), poses/pass ${budget.lastPoseUpdates} (per-frame ${budget.perFrame}), evaluations/pass ${budget.evaluations}`);
  log(`[lif02] culls — distance ${budget.distanceCulls}, screen ${budget.screenCulls}, activity ${budget.activityCulls}; meshes ${budget.visibleMeshes}; rejected ${budget.rejected}`);

  // ---- the independent upload check --------------------------------------------
  // The instrument waits for a real pass, so one attempt is normally enough; the
  // retries exist for a window that closes before the renderer produces a frame at all.
  let upload = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const sample = await page.evaluate(() => globalThis.__gdoAmbientProbe.movedInstances(2000));
    log(`[lif02] sample ${attempt + 1}: ${sample.passesDelta} pass(es), ${sample.posesThisPass} pose update(s) last pass, ${sample.moved} of ${sample.instances} moved, ${sample.collapsed} collapsed`);
    if (sample.passesDelta > 0) { upload = sample; break; }
  }
  log(`[lif02] upload: ${upload.moved} instance(s) moved out of ${upload.instances} resident (${upload.collapsed} collapsed, ${upload.meshes} mesh(es))`);

  // ---- the activity budget, driven live ----------------------------------------
  await page.evaluate(() => globalThis.__gdoAmbientProbe.setActivity(0));
  await waitMilliseconds(page, 600);
  const asleepDiagnostics = await page.evaluate(() => globalThis.__gdoAmbientProbe.diagnostics());
  let asleepUpload = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const sample = await page.evaluate(() => globalThis.__gdoAmbientProbe.movedInstances(2000));
    if (sample.passesDelta > 0) { asleepUpload = sample; break; }
    asleepUpload = sample;
  }
  log(`[lif02] activity 0 → drawn ${asleepDiagnostics.drawnSlots}, activityCulls ${asleepDiagnostics.activityCulls}, collapsed ${asleepUpload.collapsed}, ${asleepUpload.moved} moved`);
  await page.evaluate(() => globalThis.__gdoAmbientProbe.setActivity(1));
  await waitMilliseconds(page, 800);
  const awake = await page.evaluate(() => globalThis.__gdoAmbientProbe.diagnostics());
  log(`[lif02] activity 1 → drawn ${awake.drawnSlots}`);

  const panelLine = await page.evaluate(() => globalThis.__gdoAmbientProbe.panelAmbienceLine());
  const panelVisible = await page.evaluate(() => globalThis.__gdoAmbientProbe.panelVisible());
  log(`[lif02] review panel: ${panelLine ?? 'no ambience line'}`);

  // ---- criteria ---------------------------------------------------------------
  // What may move in one pass: the drawn set, plus the work of one pass (the ring
  // rotates, so entrants count). Anchoring this on the *drawn* set rather than on the
  // resident count is what makes the check able to see a bypass.
  const uploadCeiling = budget.drawnSlots + budget.perFrame;
  if (!(budget.drawnSlots <= budget.visibleCeiling)) failures.push(`${budget.drawnSlots} agents drawn exceeds the ${budget.visibleCeiling} ceiling`);
  if (!(budget.lastPoseUpdates <= budget.perFrame)) failures.push(`${budget.lastPoseUpdates} pose updates in a pass exceeds the ${budget.perFrame} per-frame budget`);
  if (!(budget.evaluations <= budget.perFrame * 2)) failures.push(`a pass made ${budget.evaluations} admissibility decisions, above twice the per-frame budget`);
  if (!upload) {
    failures.push('no measurement window contained a scheduler pass, so the upload check could not be made');
    upload = { moved: -1, collapsed: 0, instances: 0, meshes: 0, passesDelta: 0, posesDelta: 0 };
  } else if (!(upload.posesThisPass > 0)) failures.push('the measured pass posed no agent at all, so the agents that should be drawn were not animated');
  // The upload is the real claim: only the drawn set may move, even though far more
  // agents are resident. One pass of slack is allowed because the ring rotates and a
  // measurement can straddle two passes.
  if (!(upload.moved <= uploadCeiling)) {
    failures.push(`${upload.moved} instances moved in one pass while only ${budget.drawnSlots} agents were scheduled to be drawn and ${upload.instances} were resident, above the ${uploadCeiling} the budgets allow`);
  }
  if (upload && !(upload.instances >= resident.instances - 1)) failures.push(`the upload measurement saw ${upload.instances} instances but ${resident.instances} were resident`);
  // Motion is a positive claim: at full activity the drawn agents must actually move,
  // so a stubborn zero here is a defect in the frame loop rather than a quiet pass.
  if (upload && upload.moved === 0) failures.push('no instance moved in a window that contained passes, so ambience is drawn but not animated');
  if (upload && upload.orphaned) failures.push(`${upload.orphaned} measured mesh(es) were replaced mid-window, so the movement count is unreliable`);
  if (!(budget.distanceCulls > 0)) failures.push('no distance cull was ever counted, so the distance budget is unproven live');
  if (!(asleepDiagnostics.drawnSlots <= 1)) failures.push(`activity 0 left ${asleepDiagnostics.drawnSlots} agents drawn, so the activity budget does not wind ambience down`);
  if (!(asleepDiagnostics.activityCulls > budget.activityCulls)) failures.push('winding activity to 0 did not produce activity culls');
  if (!asleepUpload || !(asleepUpload.collapsed >= Math.min(1, budget.drawnSlots))) failures.push(`winding activity to 0 collapsed ${asleepUpload?.collapsed ?? 'no'} instance(s), so agents left the drawn set without being hidden`);
  if (asleepUpload && !(asleepUpload.passesDelta > 0)) failures.push('the activity-0 window contained no scheduler pass');
  if (!(awake.drawnSlots > asleepDiagnostics.drawnSlots)) failures.push(`restoring activity did not bring agents back (${asleepDiagnostics.drawnSlots} → ${awake.drawnSlots})`);
  if (!panelVisible) failures.push('the review panel is not visible, so the ambience diagnostics cannot be reviewed');
  if (!panelLine) failures.push('the review panel has no `ambience` line');
  else if (!/ambience profile:low active:\d+\/64 visible:\d+ ceil:30 per-frame:24 culls d:\d+ s:\d+ a:\d+ poses:\d+/.test(panelLine)) {
    failures.push(`the ambience line does not carry the profile, budgets and culls: ${panelLine}`);
  }

  return {
    directory,
    blockers: failures.length,
    sweepFrames: 0,
    totalPenetrations: 0,
    ambientFailures: failures,
    fixtures,
    coordinate: corner,
    profile: first.profile,
    capacity: first.capacity,
    claimed: first.active,
    ceiling: first.visibleCeiling,
    perFrame: first.perFrame,
    maxDistance: first.maxDistance,
    resident,
    drawn: budget.drawnSlots,
    posesThisPass: budget.lastPoseUpdates,
    evaluationsThisPass: budget.evaluations,
    culls: { distance: budget.distanceCulls, screen: budget.screenCulls, activity: budget.activityCulls },
    rejected: budget.rejected,
    upload: { moved: upload.moved, collapsed: upload.collapsed, instances: upload.instances, meshes: upload.meshes, allowance: uploadCeiling, passesDelta: upload.passesDelta, posesThisPass: upload.posesThisPass, orphaned: upload.orphaned },
    activity: {
      off: { drawn: asleepDiagnostics.drawnSlots, activityCulls: asleepDiagnostics.activityCulls, moved: asleepUpload.moved, collapsed: asleepUpload.collapsed },
      on: { drawn: awake.drawnSlots },
    },
    panelLine,
    panelVisible,
  };
}
