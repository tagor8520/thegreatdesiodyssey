# Working in this repository — agent operating manual

**Audience:** automated agents and new contributors doing implementation work here.
**Last verified:** 2026-10-03.
**Companion docs:** [`README.md`](./README.md) (product + architecture), [`feature-roadmap/README.md`](./feature-roadmap/README.md) (status authority), [`feature-roadmap/VISUAL_GATES.md`](./feature-roadmap/VISUAL_GATES.md) (visual acceptance gates), [`feature-roadmap/CHANGELOG.md`](./feature-roadmap/CHANGELOG.md) (dated change log).

Read this before changing anything. It records environment facts and process rules that are easy to rediscover the hard way.

---

## 1. The one rule that governs everything

**This project's documentation is unusually strict, and it is the product of that strictness.** A feature is not done because code exists. It is done when its named gate passes, and the gate is almost never "it builds". Every change must update the roadmap matrix *and* the changelog in the same commit. See §7.

If you are about to write "implemented" or move a status to `ADDED`, stop and identify the exact gate from the matrix. If you cannot run that gate, the status does not change — leave it `PARTIAL` with the open gate recorded, and say so plainly.

---

## 2. Environment constraints (verified, not assumed)

This repository has been worked in a sandbox where the network is **allowlisted to the npm registry only**. Knowing precisely what works prevents wasted effort.

| Endpoint | Purpose | Reachable |
|---|---|---|
| `registry.npmjs.org` | npm packages | **yes** |
| `cdn.playwright.dev` | Playwright browser binaries | no |
| `storage.googleapis.com` (chrome-for-testing) | Puppeteer browser binaries | no |
| `tiles.openfreemap.org` | map vector tiles (provider 1) | no |
| `vector.openstreetmap.org` | map vector tiles (provider 2) | no |
| `apt` repositories | system packages | no (and no root) |

### 2.1 A browser DOES work — use `npm run visual:audit`

Because npm is reachable, `@sparticuz/chromium` installs: it ships the Chromium binary **inside the npm tarball** rather than fetching it from a CDN. This is the supported path for any visual verification. See [`tools/visual-audit/README.md`](./tools/visual-audit/README.md).

Do **not** conclude that visual work is impossible. That mistake was made once and cost four gates months. Do not install Playwright or Puppeteer expecting their binaries to download — they will not.

### 2.2 Remote map tiles do not work — but the offline fixture provider does

Live tile endpoints are unreachable from this environment. That is **no longer a blocker**: the **offline fixture provider** (§6.2) serves a real MVT protobuf from the dev server at a same-origin URL, so Coordinate Explorer renders mapped buildings, roads, and water with no network at all. Verified rendering **90 buildings / 204 details / 10 roads** from the `dense-urban` fixture.

Do not describe mapped-geometry visual work as impossible. Coordinate mode also still degrades cleanly without any provider: seeded 33×33 fallback terrain, a specific user-facing error, visible attribution, live debug overlay, zero console errors.

### 2.3 `/tmp` and background processes do not survive between work sessions

Files written outside the repository root are **not persisted**, and a dev server started in one session is gone in the next. `node_modules` at the repository root is also not persisted in some environments. Consequences:

- The audit harness stores everything under `tools/visual-audit/` (inside the repo) precisely for this reason. Do not move its cache to `/tmp`.
- Re-run `npm install` if `npm run dev` reports `vite: not found`.
- Restart the dev server before any audit run.

---

## 3. Repository layout and where code belongs

Canonical runtimes are **`src/geo/`** (Coordinate Explorer) and **`src/reference/`** (curated adventure). `src/engine/` is a *mixed* directory — some of it is shared by the current runtimes, some is legacy-only, some is unreferenced. Check before editing; see the lane table in `README.md`.

**Put new work in `src/geo/` or `src/reference/`.** Do not add features to `src/world/`, `src/ui/`, or the legacy `src/engine/` modules — they are reachable only from `/classic.html`, the frozen explorer.

Unreferenced modules worth knowing: `src/engine/StateManager.js` (it now reads `public/content/states/*.json` **through the `CNT-01` content schema**, but no entry point mounts it, so those packs still do not reach a player), `src/engine/Renderer.js`, `src/engine/LerpPlayerController.js`, `src/main.js` (it is not the entry point — `index.html` loads `src/landing.js`, which imports `src/reference/main.jsx` and `src/geo/GeoGame.js` on demand). The advertised low-code JSON content path now has a **contract** (`CNT-01`: schema, validation, migration — both shipped packs validate in Node and in the browser) but no **live surface**: `CNT-02` (recipe compiler) and `CNT-04` (packs) are what mount content, and `CNT-03` is the authoring/preview tool.

**Content is authored against a versioned schema, not a shape you infer from the files.** `src/engine/ContentSchema.js` is the authority: add a field by declaring it in `STATE_CONTENT_FIELDS` (the validator walks the table, so an undeclared key is an error), keep errors separate from advisory warnings, and add a migration step rather than editing the current one. `validateStateContent` in strict mode refuses un-migrated legacy content on purpose — that is what keeps migration load-bearing. Authoring caps derive from `GDO_LOW_PROFILE_BUDGETS` rather than being invented per feature. Every content change must keep both `src/engine/ContentSchema.test.js` and `src/engine/StateManager.test.js` green, and `npm run visual:audit -- content-schema` proves the served bytes are the validated bytes.

**Tooling lives under `tools/`.** `tools/visual-audit/` is the browser gate harness (`harness.mjs`, `run.mjs`, `lifecycle.mjs`, `scenarios/`, `out/`); `tools/fixture-provider/` is the dev-only offline tile provider and its artefact builder. Both are development infrastructure — neither is imported by a Vite entry point, and the build contains no trace of them.

**Test-only code is named as test-only.** `src/engine/FlatDomain.js` (a forty-line domain double) and `src/engine/WorldDomainProbe.js` (lane search plus probe orchestration) are imported by `*.test.js` and by `tools/visual-audit` only. The probe module exists so the Node tier and the browser tier run the *same* probe rather than two similar ones; it is reachable from the page over the dev server, which is why it lives under `src/` instead of `tools/`. Neither is in the production bundle — check with `grep -rl FlatDomain dist/` after a build if you touch their imports.

**Test support is a real file, not a hidden fixture.** `src/geo/GeoTestSupport.js` holds the one implementation of the fixture-mount sequence (`applyCompilation`) so lifecycle and byte-equivalence proofs drive a world identically; `src/engine/ResourceLedger.js` is the FND-07 lifecycle instrument. Both are imported only by `*.test.js`, so Vite does not bundle them — verify with `grep -rl ResourceLedger dist/` after any test restructure. Likewise `tools/visual-audit/lifecycle.mjs` is instrument code for the browser tier and is never imported by the game.

**One query interface, two scales (`FND-08`).** Traversal and query code in *both* runtimes goes through the six-member domain interface in `src/engine/WorldDomain.js` — `supportAt`, `collidesCircle`, `moveCircle`, `resolveGroundStep`, `clipCamera`, `readDiagnostics`, plus a frozen `scale` descriptor. `GeoWorld` is the coordinate implementation and `src/reference/CuratedDomain.js` is the curated one. Two rules follow. First, **do not add a fifth question ad hoc** — if a runtime needs something the interface does not answer, add it as a seventh member with a defined shape and a probe assertion, because the point of the interface is that a shared consumer can address either mode. Second, **do not unify the scales**: curated resolves 4 m terrain at 1:1 with a camera clamp of `[.6, 1.25]`, coordinate resolves a 33×33 grid per tile at 1:10 with a clamp of `[.03, .04]`, and `compareDomainScales` fails the build if the clamps start overlapping or the footprint ratio drifts off `10`. `moveCircle` means "advance and resolve contacts", not "slide": curated reverts the step and returns a zero projected remainder, coordinate slides and returns a projected one. Both are correct for their mode.

**Traversal must be driven by the body's own state, not only by the ground.** The curated step policy compares two supports, so a position discontinuity — a respawn, a debug teleport, a scenario pin — reads as a legal step unless the body checks that it was standing on the support it came from (`CURATED_SUPPORT_PROXIMITY` in `src/reference/Player.js`). Removing that guard silently disables the `y < -5` world escape and is caught by the "river fall respawns" gameplay test.

**Static vs dynamic collision is a hard split (`COL-09`).** Tile footprints live in the per-tile 4-unit grid (`buildCollisionGrid`); anything that *moves* belongs in `src/geo/GeoDynamicProxies.js`, a capped hash with the same cell size. Do not add a moving solid to the tile grid, and do not add a static building to the dynamic hash. The dynamic hash admits four primitives only (circle, capsule, AABB, oriented box) plus compounds of at most four; it rejects rather than evicts at the profile cap (64/128/256), because an evicted solid lets the player walk through a vehicle. Proxies are **2.5D**: horizontal sweeps are exact, vertical-plane contacts are not implemented. The hash ships **empty** — placing traffic is `DET-07`'s job, and kinematic/dynamic response is `PHY-01`/`PHY-02`.

---

## 4. Commands

```bash
npm install            # required after a fresh session
npm run dev            # dev server on 0.0.0.0:5173
npm test               # 189 node tests, no browser needed
npm run check          # npm test && npm run build  (the canonical gate)
npm run fixture:tiles  # regenerate public/fixture-tiles/*.pbf from the encoder

npm run visual:audit -- --list                     # needs `npm run dev` running
npm run visual:audit -- curated-camera             # COL-06, curated world
npm run visual:audit -- coordinate-matrix          # COL-05 shape-family orbit matrix
npm run visual:audit -- water-order                # LAY-03 transparent water
npm run visual:audit -- shimmer-low-dpr            # MAT-03 low-pixel-ratio shimmer
npm run visual:audit -- remount-lifecycle          # FND-07 zero-growth remount
npm run visual:audit -- domain-interface           # FND-08 curated/coordinate interface (both modes)
npm run visual:audit -- water-order --fixture provider-equivalence --variant shortbread

node tools/visual-audit/diagnose-dynamic-proxies.mjs   # COL-09 live caps/queries
node tools/visual-audit/diagnose-plant-attributes.mjs  # F1 attribute budget
```

`npm run check` is the gate for structural correctness. It must pass before you claim any non-visual work is complete. Current baseline: **238 tests, 126 Vite modules** (re-measured 2026-10-06, `LIF-02`).

The two `diagnose-*.mjs` scripts are asserted diagnostics rather than capture scenarios: they drive the running game, print a live report, and exit non-zero on failure. Use them to prove that a contract the Node tests decide is genuinely wired to the shipped runtime.

Audit scenarios accept `--fixture <id>` and `--variant <name>`; the fixture is switched server-side at runtime (`POST /__fixture-tiles/select`), so you do not need to restart the dev server between fixtures.

There is **no** lint, typecheck, or CI job in this repository. If the roadmap or changelog claims a "canonical roadmap parser" or a "Markdown-link audit", that claim is stale — those tools were never committed. Verify roadmap counts by hand; the commands are in `feature-roadmap/README.md` §6 "Reproducing this snapshot".

---

## 5. Determining the wind decision (do not re-litigate casually)

On **2026-10-03** the project owner decided whole-plant wind was **not worth its per-vertex cost** and should not run by default. `VEG-09` and `VEG-10` are therefore marked **REJECTED** as default architecture.

What this means in code:

- `PlantRenderPools` / `createPlantPoolMaterial` take an opt-in `wind: true`. The default compiles **no wind ALU at all** — the vertex shader wraps the whole field in `#ifdef GDO_PLANT_WIND` and only sets the define when wind is requested, so the driver's preprocessor removes every wind instruction. This is stronger than setting an amplitude to zero.
- With wind off, geometry bounds withhold **no** culling margin (`windDisplacementMargin: 0`), no clock uniform is written, and `configureWind()` returns `false` rather than half-applying a disabled field.
- `PlantWind.js`, the `PlantMorphology` stiffness traits, and all tests remain, so re-enabling is a one-flag change if the decision is ever revisited.

If you believe wind should return, treat it as a product decision requiring the owner, not a technical cleanup.

---

## 6. Implementing a feature: the expected shape

Every slice in this project follows the same pattern. Deviating produces rework.

1. **Find or add the matrix entry** in `feature-roadmap/README.md` with an ID, priority, dependencies, and an explicit completion gate. New ideas need an ID before implementation.
2. **Check dependencies are `ADDED`.** Building on a `PARTIAL` or `QUEUED` dependency is how half-systems accumulate.
3. **Respect the build invariants** (roadmap §4). The ones most often violated: roads before buildings; mapped horizontal footprints and half-open tile ownership stay exact; visual boxes/foliage/particles never become solid hitboxes; low-end budgets are shared ceilings, not per-feature allowances; every deterministic output is owned by a versioned namespace in `src/engine/FeatureVersions.js`.
4. **Reject the documented anti-patterns** (roadmap §9): per-box `Mesh`/material/collider, runtime CSG, arbitrary building AABBs as collision, dense transparent foliage, `renderOrder` with `sortObjects = false`.
5. **Write tests in the existing style.** Node's built-in runner, deterministic assertions, lifecycle and budget coverage, malformed-input fallback. Budget ceilings go through `src/engine/PerformanceBudget.js` (`GDO_LOW_PROFILE_BUDGETS`, `assertLowProfileBudget`) so breaches fail descriptively.
6. **Run `npm run check`.**
7. **If the feature has visual criteria, run the audit.** Look at the frames. Do not mark the gate passed because the harness ran — someone must actually read the output.
8. **Update the matrix status, this file if process changed, `VISUAL_GATES.md` if a gate closed, and the changelog — in the same change.**
9. **Commit. Record breaking seed/schema/save changes with old and new versions.**

### 6.1 Budget discipline

Figures quoted in prose across the docs (e.g. the 1,044-plant / 208,452-byte provider-equivalence mount) are **point-in-time measurements**. The automated gates assert *ceilings*, so a fixture total can drift while `npm run check` still passes. Re-derive before citing; see `VISUAL_GATES.md`.

### 6.2 The offline fixture provider — **DONE 2026-10-04, use it, don't rebuild it**

This was the highest-leverage missing piece and it now exists. Three parts:

| Piece | File | Role |
|---|---|---|
| Encoder | `src/geo/GeoFixtureTileEncoder.js` | `encodeFixtureVectorTile(id, variant)` → spec-valid MVT bytes for any `GEO_FIXTURE_MATRIX` entry |
| Provider | `tools/fixture-provider/vite-plugin.mjs` | Dev-only same-origin provider; injects a fixture entry into the `/map-providers.json` **response** |
| Artefacts | `public/fixture-tiles/**/*.pbf` | Canonical bytes for external inspection; regenerate with `npm run fixture:tiles` |

`GEO_FIXTURE_EXTENT` is `4096`, identical to MVT's standard extent, so encode→decode is geometrically exact. The suite asserts decoded tiles drive `buildRoadGeometry`, `buildContextData`, and `buildBuildingGeometry` to **byte-identical** output versus compiling the fixture directly.

**Never let it reach production.** The plugin declares `apply: 'serve'`, so it cannot run during `vite build`; `pruneFixtureTiles()` strips the `.pbf` artefacts from `dist/`; `public/map-providers.json` on disk never lists the fixture and a test enforces that. If you touch this area, re-verify: `dist/` must contain **0** `.pbf` files and **0** references to `gdo-offline-fixture`.

---

## 7. Documentation rules (non-negotiable)

- `feature-roadmap/README.md` is the status authority. `CHANGELOG.md` records history. `README.md` describes the product as it actually is.
- Newest changelog entries go **first**. Never rewrite an old entry to imply unfinished work was complete. If a later entry supersedes an earlier claim, say so in the later entry and leave the earlier one intact with a pointer.
- Use real statuses: `ADDED`, `PARTIAL`, `ACTIVE`, `QUEUED`, `DEFERRED`, `REJECTED`. If work is blocked, `PARTIAL` plus the concrete open gate — never `ADDED`.
- **Do not let the docs drift from behaviour.** This repository has had to run two accuracy audits already. Concrete past defects worth not repeating:
  - a controls table listing keybindings that only existed in the legacy explorer;
  - a directory map describing `src/engine/` as uniformly shared when it is mixed;
  - a claimed "roadmap parser" that did not exist;
  - a WIP limit stated as "one `ACTIVE` P0" while two were active.
- Prefer verified facts over plausible ones. Run the command; read the file; check the import graph. If you cannot verify a number, do not restate it.

---

## 8. Visual acceptance gates

Full register: [`feature-roadmap/VISUAL_GATES.md`](./feature-roadmap/VISUAL_GATES.md). Summary of what matters operationally:

**Why they exist.** Automated tests prove *structural* correctness (byte-identical regeneration, exact topology, disposal, budgets). They cannot prove *perceptual* correctness. A camera that compresses over 30 frames instead of 1 has perfectly correct data and still renders through a wall for half a second. Perceptual defects are temporal, so gates require **moving** captures.

**What the harness can decide.** Clipping, depth order, popping, gross shimmer, silhouette identity — SwiftShader is a conformant rasterizer.

**What it cannot.** Anything about performance. It renders this game at single-digit FPS. **Never record an FPS, frame-time, or thermal number from it as a shipping claim.** Mobile/GPU performance still needs real hardware.

**And it cannot decide `MAT-03`'s shimmer criterion at all.** The frame-to-frame statistic does not move even when the entire anti-alias policy is stripped, so it can neither confirm nor refute the policy. The scenario reports `metricValidated: false` and exits **2 (inconclusive)**. Read that as "no verdict", never as a pass. Before adding a new perceptual metric, build a **positive control** that removes the mechanism and confirm the metric rises; without one, a low number means nothing.

**Discipline.** Sample **every frame**, assert against the same objects the renderer uses, and write a JSON report beside the PNGs. A single still frame cannot reveal any of the five defect classes. Rejected or inconclusive captures must be recorded as such so they are not mistaken for passes.

**Collision gates are asserted, not eyeballed (`COL-09`, `COL-01`).** The dynamic hash's contract is decided in `npm test`; the live script only proves the wiring. One trap is worth remembering because it cost a run: a dynamic-contact probe must first show that its lane is **clear on an empty hash**, then place the solid and re-run the same sweep. A static contact at `t≈0` (the probe started inside a mapped building) otherwise decides the outcome, and the result proves nothing about the dynamic path.

**A shared-interface gate needs both a conformance half and an anti-merge half (`FND-08`).** "Both modes use the same interface" is satisfiable by making one mode behave like the other, so the gate asserts the two modes *differ* where the design says they must (disjoint camera clamps, a footprint ratio pinned near `10`) as well as that they agree on semantics. Two traps come with it. **A probe must measure the behaviour, not the call:** curated's move reverts a whole delta, so handing it one large displacement reports that it advanced nothing; the probe sub-steps like a player and asserts it did. **A lane must be found, not chosen:** a probe that starts inside geometry measures that geometry. Both tiers search for a lane clear of solids *with an unblocked reverse camera control*, and the probe's own judgement fails if the lane was not proven clear first.

**Lifecycle is a gate class of its own (`FND-07`).** "Prove zero-growth remount" means *repeat* mount → exit → mount, never one clean teardown, and it means all five classes — workers, observers, textures, geometries, listeners. Two tiers implement it: `ResourceLedger.test.js` in `npm test` (workers, listeners, geometry/texture release, pools) and `npm run visual:audit -- remount-lifecycle` (all five, both runtimes, plus a production probe). Three traps are baked into that harness and will bite anyone extending it: a **warm-up cycle** is required because one-time page initialisation (React's delegated `selectionchange`, Vite's injected `<style>`) would otherwise read as growth; subscriptions are counted only on **reachable** targets, because counting detached ones cannot distinguish a leak from the instrument's own reference — that is what the forced-collection step proves; and geometry **counts are never asserted**, only releases, because streaming legitimately changes how much a settled mount owns. Dev-only retention is registered as `VISUAL_GATES.md` §6.F3 — do not "fix" it casually.

**DOM labels do not participate in WebGL depth (`GME-04`/`LAY-05`).** Any label the map generates is a DOM element drawn over the canvas, so without an explicit test a place name is readable *through* a building. Every label ray goes through `LabelLosScheduler` (`src/geo/GeoLabelLos.js`), which is budgeted (the research's `20/40/80` tests per second and `5/10/14` simultaneous labels), holds a verdict for the 250 ms update interval instead of re-testing per frame, and asks for `LOS_BLOCKER` **and nothing else** — a pickup, a bird or a bee must never be able to blank a name. Two traps are worth carrying forward: `world.sweepSphere` **returns its `out` object**, so a truthiness test on the return value marks every label as hidden (read `out.hit`, or a strict boolean); and a contact at `t = 0` means the eye is *inside* geometry, which is a legal query result but not a position a player can occupy — only `0 < t < 1` proves a wall between the eye and the name. The browser gate finds its occluded pair instead of authoring it, and only trusts a verdict while its per-label diagnostic row is fresh.

**Known gap.** Several features carry `ADDED` status on structural gates while their own research specs list visual criteria never observed — most notably the `VEG-03` → `VEG-09` stack. These are catalogued under `VISUAL_GATES.md` §4 Group B. Close them before treating those stacks as finished.

**Tracked-known console errors.** `tools/visual-audit/harness.mjs` holds `KNOWN_CONSOLE_DEFECTS`, an explicit allowlist of errors that are known, tracked, and provably unrelated to the gate under test. Each entry names the defect and where it is recorded. Filtered errors are **still printed and still written into `report.json`** — never add an entry to silence a failure, and only gate-relevant errors set the exit code. The current single entry is `F1` (the `gdoPlantClearance` attribute budget, `VISUAL_GATES.md` §6.F1).

---

## 9. Debugging notes that save time

- **Coordinate stats readout** (`F3` or `?debug=1`) exposes query masks, tile owners, support levels, LOD/wind counters, budget status, and worker timings. Use it before guessing.
- **Pin any animation clock before comparing configurations.** The water shader offsets its normal-map lookup by `uTime`, which the render loop sets from wall-clock milliseconds. Two captures taken at different wall-clock moments sample different wave phases, and the phase changes how much high-frequency detail faces the camera — so an A/B between configurations measures animation phase unless the clock is pinned. This produced a plausible, reproducible, and completely wrong result once (`0.890x`, withdrawn; the corrected figure is `1.001x`). See `frozenWavePhase` in `shimmer-low-dpr.mjs`.
- **Compute image statistics inside the page, never ship pixels to Node.** Returning frames over the CDP bridge costs ~12 MB per measurement, which turned a 14-second scenario into a 16-minute one that timed out with no verdict. Only numbers should cross the bridge.
- **Validate a perceptual metric with a positive control before trusting it.** Remove the mechanism under test and confirm the metric rises. If it does not, the metric cannot fail, so it cannot pass either.
- **`Function.length` counts only up to the first default parameter.** An arity assertion written against a signature with defaults (`clipCamera(target, desired, radius = .03, out = {})`) measures 2, not 4. Write the floor for what must not be omitted, not for what the signature spells out; a check that rejects both real implementations is a broken check, not a strict one.
- **A position discontinuity is not a step.** Any rule of the form "may the body move from support A to support B" needs the body's own height as context, or a respawn/debug teleport under the terrain is read as a legal step and lifted to the surface. See `CURATED_SUPPORT_PROXIMITY`.
- **Teleporting the player bypasses collision.** When scripting captures, validate that the *orbit target* is outside every blocker before measuring penetrations, or you will measure your own harness bug. The audit harness does this via `chooseStand` / `standCheck`.
- **Camera sweep radii differ by design between modes.** Coordinate uses FOV 68 / near `.02` → radius ≈ `.03–.04`, matching the research. Curated uses FOV 42 / near `1` → radius ≈ `.93`, so curated compresses much more often at long orbit distances. This is a near-plane consequence, **not** a defect; don't "fix" it without a product reason.
- **`cameraBlockers` carry `{ id, role: 'camera-blocker' }` in `userData`.** `BridgeManager` was missing this until 2026-10-03; keep the convention when adding structure.
- **A development-only audit bridge** exposes the mounted runtime at `globalThis.__gdoAudit` when `import.meta.env.DEV` is true. It is tree-shaken from production builds (verify with `grep -rl __gdoAudit dist/`, which should return nothing).
- **`src/engine/ActionRegistry.js` is the only gameplay keymap.** Add an action by declaring it there — name, `kind` (`hold`/`tap`), `codes`, `runtimes`, `surfaces`, touch control (with `grid` and a `size` at or above 44px), `group` and, for inventory, `slot` — then handle it by name in the owner's `onAction`. Do **not** write a `keydown` listener that compares `event.code` to a key, and do not add a second copy of a key binding in a React component or a scene module: `src/engine/ActionRegistry.test.js` scans `src/` and fails the build when any module outside the registry names a registered code. `ActionInput` owns the listeners, the held set and the analogue stick for both players; let a runtime *handle actions*, not keys.
- **A new audit scenario must be wired into the runner's verdict, or it cannot fail.** `run.mjs` turns a scenario's failures into a non-zero exit only for the field names it knows (`summary.labelFailures`, `actionFailures`, `contentFailures`, `ambientFailures`, …), so a scenario that returns `blockers: 2` and a fresh field name will print the numbers and **exit 0**. The `ambient-life` gate did exactly that on its first failing run. Before calling any scenario load-bearing, break one criterion and confirm the run exits 1.
- **On this software renderer, delimit a measurement by the runtime's own counters, not by wall clock.** A frame here can take a quarter of a second, so a fixed 120 ms window was repeatedly measured containing **zero frames** — and "nothing moved" then looks like evidence while meaning nothing. The ambient instrument waits for the scheduler's pass counter to advance and then for one animation frame, and returns `passesDelta` so a caller can see that the window was real. Same family of mistake as the pinned wave clock: an unpinned window silently measures nothing.
- **Make a gate's non-vacuity an asserted precondition.** `ambient-life` fails unless the resident agent count **exceeds the allowance the check permits to move**, because a run with fewer agents than that could not detect the defect it exists to detect. The first version only required "more than the ceiling" and a three-tile run moved 44 instances under a 54-instance allowance, letting the exact bypass through.
- **Check the claim against the renderer's buffers, not the subsystem's counters.** A scheduler reporting a perfect `24` while the frame loop walked every instance is the failure mode; reading `InstancedMesh.instanceMatrix` before and after a pass, and counting moved instances, is what makes the gate about pixels-to-be rather than about bookkeeping.
- **When a budget has two parts, assert two parts.** `LIF-02` states a *visible* ceiling and a *per-frame work* budget; the first implementation honoured only the second and drew every agent. If a research table lists two numbers, a single test that passes is not evidence that both hold.
- **`page.evaluate` does not await promises nested inside a returned object.** An object literal containing `probe.something()` serialises that field as `{}`; the outer promise is awaited, the inner one is not. It cost a silent `undefined` in a gate's output — call the probe separately, or `await` the inner value in the page before returning.
- **Touch controls are generated, not hand-written.** `mountTouchControls({ runtime, container, input })` renders both live runtimes' on-screen controls from the registry, and device capability (`shouldUseTouchControls`) is a separate question from whether the game has started — keep `setMobile(touchDevice)` so a desktop browser never shows a joystick. Placement lives in `touch.grid`, never in per-action CSS. The frozen `/classic.html` explorer is the one place with its own keymaps, and no new work goes there.

---

## 10. What to work on next

Canonical order lives in `feature-roadmap/README.md` §12, and the leverage ranking there is **recomputed from the dependency graph after every closure** — do not carry a stale list forward. As of 2026-10-07, with `FND-07`, `COL-09`, `FND-08`, `GME-05`, `CNT-01`, `GME-04` (+ `LAY-05`), `LIF-02` (+ `LIF-01`), `ENV-02` and `GME-06` closed, the dependency-complete set is led by **`MAT-03`**, **`ENV-04`**, **`MAP-09`**, **`NET-01`** and **`DET-09`** (3 each). `MAT-03` stays `PARTIAL` on SwiftShader. **`ENV-04`** continues the environment chain that `ENV-02` unblocked, **`NET-01`** is the entry point of the gameplay-state chain `GME-06` just unblocked (`NET-01` → `NET-02` → `NET-03` → `NET-04`), and **`DET-09`** is still the entry point to the content chain `CNT-02` → `CNT-03` → `CNT-04`. `LIF-03` (GPU bird/insect motion) became dependency-complete with `LIF-02` but is a leaf — nothing depends on it — so it buys ambience quality rather than reachability. The `COL-09` hash still ships **empty**: `LIF-02` did **not** place a proxy into it (ambient fauna do not collide), so `DET-07`, `PHY-01` and `PHY-02` remain its consumers — an earlier note here predicted otherwise. **`GME-04` is place labels and coordinate HUD — *not* the action registry, which is `GME-05` and is closed.**

1. **`MAT-03`** — the shimmer capture runs (~14 s) but is **inconclusive**: p99.9 stays at `4.1` whether the anti-alias policy is active, mip-disabled, or entirely stripped, so the metric cannot certify the policy. Anisotropic filtering is settled (`REJECTED`, `feature-roadmap/README.md` §9) and is not the answer. Either capture on real hardware with the same statistics, or record an owner decision waiving the shimmer criterion for trilinear-only selection. Details in `VISUAL_GATES.md` §4 A4.
2. **`F1`** — the `gdoPlantClearance` attribute budget (`VISUAL_GATES.md` §6.F1). Pre-existing, reproducible, unfixed: the plant pool sits exactly on the 16-attribute WebGL floor and SwiftShader rejects it. Reclaim one slot (e.g. pack the paired LOD scalars into a `vec2`).
3. **Group B static appearance criteria** — silhouette family identity, branch cracks, overlap roles, clearance conformance. Re-scope away from wind, which is `REJECTED`.
4. **`DET-04` facade criteria** and `MAT-03`'s road/facade half — both now reachable through the fixture provider, neither run yet.
5. **`DET-08`** — next dependency-complete object build; write its visual gate alongside the code. `DET-09` (landmark grammar and openings) is the pattern to copy: declare the modules, compile them, and have the gate recompile the declaration **inside the running page** and match it against the live scene and the live collider, so the gate cannot drift from what ships.
6. **`ENV-02`** — closed 2026-10-07. The rule it established is the one to keep: the ambient scheduler's `world.setAmbientActivity(activity, speciesActivity)` is how an environment state winds a family down (**no second animation path**), and `GEO_AMBIENT_ACTIVITY_BY_PHASE` in `GeoGame.js` is the only place that policy lives. `ENV-04` (weather state machine) is the next item that consumes the same hook, and it is dependency-complete.
7. **`GME-06`** — closed 2026-10-07. Two rules to keep: a place id is a function of the **place** (name, kind, coarse cell) and never of a session, so anything that persists or shares a discovery must persist the id rather than re-derive it from a name; and the journal is **bounded by capacity alone** — a new field added to an entry must be preallocated, or the "bounded local state" half of its gate stops being true. Writing the journal to storage is `NET-01`.
8. **`DET-09`** — closed 2026-10-07. Three rules to keep. Collision is **derived from the drawing**, never listed a second time: a structural module yields its proxy, an accent yields none, and an accent that declares collision is rejected at definition time. Openings are declared as **profiles** (a stack of bands), and the free width is 0 *both* below the passage and **above the arch head** — a band is a slice of the opening, not a width that continues upward, which is what keeps a lintel legal and an arch head impassable. And a collider that is meant to "contain what is drawn" must be measured against the rotated geometry: the wheel's sixteen rim stones sit at radius 3.0 and are rotated to face the hub, so the 45° stones reach a corner 3.7 m out, and half of whichever side happens to be longest is not the reach. The content chain (`CNT-02` → `CNT-03` → `CNT-04`) now has its entry point.

Do not start the `ENV-02` → `ENV-05` atmosphere block beyond the item above, the `CNT-*` content pipeline, or the `NET-*` multiplayer work without the owner's direction; they are the largest remaining gaps but heavily product-dependent.
