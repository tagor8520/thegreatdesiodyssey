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

`npm run check` is the gate for structural correctness. It must pass before you claim any non-visual work is complete. Current baseline: **220 tests, 124 Vite modules** (re-measured 2026-10-05, `CNT-01`).

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
- **Touch controls are generated, not hand-written.** `mountTouchControls({ runtime, container, input })` renders both live runtimes' on-screen controls from the registry, and device capability (`shouldUseTouchControls`) is a separate question from whether the game has started — keep `setMobile(touchDevice)` so a desktop browser never shows a joystick. Placement lives in `touch.grid`, never in per-action CSS. The frozen `/classic.html` explorer is the one place with its own keymaps, and no new work goes there.

---

## 10. What to work on next

Canonical order lives in `feature-roadmap/README.md` §12, and the leverage ranking there is **recomputed from the dependency graph after every closure** — do not carry a stale list forward. As of 2026-10-05, with `FND-07`, `COL-09`, `FND-08` and `GME-05` closed, the largest remaining lever is **`CNT-01`** (content/scenario authoring, 7 items in its closure, 3 direct), then **`GME-04`** (place labels and coordinate HUD — *not* the action registry, which is now closed — 7, 2), `LIF-02` (4, 4) and `ENV-02` (4, 1).

1. **`MAT-03`** — the shimmer capture runs (~14 s) but is **inconclusive**: p99.9 stays at `4.1` whether the anti-alias policy is active, mip-disabled, or entirely stripped, so the metric cannot certify the policy. Anisotropic filtering is settled (`REJECTED`, `feature-roadmap/README.md` §9) and is not the answer. Either capture on real hardware with the same statistics, or record an owner decision waiving the shimmer criterion for trilinear-only selection. Details in `VISUAL_GATES.md` §4 A4.
2. **`F1`** — the `gdoPlantClearance` attribute budget (`VISUAL_GATES.md` §6.F1). Pre-existing, reproducible, unfixed: the plant pool sits exactly on the 16-attribute WebGL floor and SwiftShader rejects it. Reclaim one slot (e.g. pack the paired LOD scalars into a `vec2`).
3. **Group B static appearance criteria** — silhouette family identity, branch cracks, overlap roles, clearance conformance. Re-scope away from wind, which is `REJECTED`.
4. **`DET-04` facade criteria** and `MAT-03`'s road/facade half — both now reachable through the fixture provider, neither run yet.
5. **`DET-08`** — next dependency-complete object build; write its visual gate alongside the code.

Do not start the `ENV-02` → `ENV-05` atmosphere block, `CNT-*` content pipeline, or `NET-*` multiplayer work without the owner's direction; they are the largest remaining gaps but heavily product-dependent.
