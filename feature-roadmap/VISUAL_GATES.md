# Visual Acceptance Gate Register

**Register version:** 1.0.0
**Established:** 2026-10-03
**Status authority:** [`README.md`](./README.md) owns feature status. This file owns the *visual* completion gates: why they exist, what exactly each one verifies, which code implements the behaviour under test, and in what order they can be closed.

---

## 1. Why visual gates exist at all

Every feature in this project is already covered by automated Node tests. Those tests prove **structural** correctness: byte-identical regeneration, exact topology, disposal, budget ceilings, deterministic remount. They run in `node --test` with no GPU and no browser.

They cannot prove **perceptual** correctness. The distinction matters because the two classes of defect fail independently:

| Class | Provable by automated test? | Example |
|---|---|---|
| Structural | Yes | A building's collision rings stay byte-identical when visual detail is enabled |
| Perceptual | **No** | A camera compresses inward over 30 frames instead of 1, so it renders through a wall for half a second |

A perceptual defect is invisible to a headless geometry assertion because nothing about the *data* is wrong. The data is correct; the *rendered result over time* is wrong. That is precisely what a visual gate tests.

The project's own definition of done ([roadmap §11](./README.md)) codifies this as item 6:

> **Visual quality:** where applicable, moving FPP/TPP captures show no unacceptable clipping, popping, shimmer, depth-order error, or repetitive failure.

### 1.1 The five defect classes these gates target

1. **Clipping / interpenetration** — the camera or player rendering inside solid geometry; the near plane cutting through a facade or through the avatar.
2. **Popping** — geometry or LOD appearing/disappearing discontinuously as the camera moves or the focus cell changes.
3. **Shimmer** — high-frequency procedural patterns aliasating at low pixel ratio into crawling noise.
4. **Depth-order error** — transparent surfaces (chiefly water) compositing in the wrong order, or darkening where two surfaces overlap and double-blend.
5. **Repetitive failure** — the same silhouette, palette, or module repeating conspicuously enough to break the illusion of a real place.

Each of these is a *temporal* property. A single still frame can hide all five. Hence the universal wording in the roadmap: **"moving"** audits. This is why every blocked gate says "moving visual validation remains".

---

## 2. Why the gates were blocked, and the 2026-10-03 breakthrough

### 2.1 The original blocker

The roadmap recorded that automated Chromium installation/capture was unavailable, so the moving visual gates could not be run. That was correct at the time and the reason was an **allowlist** in the sandbox environment:

| Endpoint | Purpose | Reachable |
|---|---|---|
| `registry.npmjs.org` | npm packages | **Yes** (HTTP 200) |
| `cdn.playwright.dev` | Playwright browser binaries | No (connection failed) |
| `storage.googleapis.com` (chrome-for-testing) | Puppeteer browser binaries | No (connection failed) |
| `tiles.openfreemap.org`, `vector.openstreetmap.org` | map vector tiles | No (connection failed) |

Both standard routes to a headless browser fetch the binary from a *CDN* at install time. Both CDNs are blocked. The npm registry is not. That asymmetry is the entire blocker.

### 2.2 The unblock

`@sparticuz/chromium` ships the Chromium binary **inside the npm tarball** rather than downloading it at install time. Installed 2026-10-03:

```text
added 18 packages in 4s
bin/chromium.br        67,016,039 bytes   (Chromium 153.0.8010.0)
bin/swiftshader.tar.br  1,637,479 bytes   (software Vulkan/GL rasterizer)
bin/al2023.tar.br       1,208,350 bytes   (bundled AL2023 shared libraries)
```

Verified working end-to-end, not merely installed:

```text
WEBGL: {
  "version":  "WebGL 2.0 (OpenGL ES 3.0 Chromium)",
  "renderer": "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)",
  "maxTex":   8192
}
PIXEL(expect ~255,128,0,255): [ 255, 128, 0, 255 ]   ← rasterization confirmed
SCREENSHOT_BYTES: 1453                                ← capture confirmed
```

Two details made it work and are easy to miss:

1. The binary needs `libnspr4`/`libnss3`, which are **not** in a bare container and cannot be `apt`-installed without root. They ship inside `al2023.tar.br`. Decompress to a directory and pass it as `LD_LIBRARY_PATH`.
2. Headless software GL requires `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`. Without the last flag Chromium 153 refuses an unsafe SwiftShader context.

### 2.3 What this actually proves, and what it does not

SwiftShader is a real, conformant software rasterizer, not a stub. Probed capabilities:

| Capability | Result | Relevance |
|---|---|---|
| WebGL 2.0 (GLSL ES 3.0) | Yes | The renderer's full path |
| `fwidth()` derivative functions | Compiles, no error | **MAT-03 depends on this exact function** |
| `WEBGL_compressed_texture_s3tc` | Available | Texture path parity |
| Real `readPixels` output | Correct RGB | Pixel assertions are trustworthy |

**Therefore closable with this tooling — correctness and appearance gates:**

- camera never renders inside a blocker; compression latency in frames
- near-plane cutting through walls, terrain, or the avatar
- water draw order and duplicate-blend darkening
- presence/absence of shimmer at low pixel ratio
- silhouette family identity, branch cracks, module facing
- popping at tile/LOD/focus transitions

**Therefore NOT closable with this tooling — performance gates:**

- "low profile must remain at 30 FPS on constrained mobile"
- GPU frame time, draw-call cost, mobile thermal behaviour

SwiftShader renders at roughly **3–10 FPS** for this game. Software rasterization is not a proxy for mobile GPU performance in either direction, and any FPS number measured under it is meaningless as a shipping claim. The performance half of `QLT-06` and the `QLT-05` ceilings still require real hardware.

**One residual caveat for shimmer specifically.** Mip selection and derivative behaviour are implementation-correct under SwiftShader, so gross shimmer from missing mips or unfiltered high-frequency patterns would show. But the software statistic does **not** respond to a positive control that strips the whole anti-alias policy (see §4 A4), so it cannot decide this gate in either direction. Treat SwiftShader output as *sufficient* for clipping, order, and popping, and as **no verdict at all** for shimmer, which needs a real-GPU capture.

---

## 3. Test method

### 3.1 Harness design

A capture run needs six things, in this order:

1. **Deterministic launch.** `vite preview` (or `dev`) on `0.0.0.0`; the page already accepts a `?quality=` override and `?debug=1`.
2. **Fixed world identity.** Pin coordinate, provider variant, world/feature version, and date seed so before/after frames are comparable. Feature versions already flow through `src/engine/FeatureVersions.js`.
3. **Scripted camera path.** Drive the camera along a reproducible path rather than relying on human input: orbit 360° at min and max TPP distance, approach each blocker family, and translate while shimmer-prone surfaces fill the frame.
4. **Frame series, not a single still.** Capture at a fixed cadence (e.g. 30 frames per scenario) so temporal defects have somewhere to appear. Encode to WebM/PNG sequence for review.
5. **Overlay capture toggles.** A "UI hidden" mode and a static HUD readout so a frame can be judged on palette and silhouette alone, per the biome research.
6. **Telemetry sidecar.** Record provider, biome, detail-family counts, worker timings, bytes, draws, triangles, frame CPU, and truncated passes alongside the imagery — the feature research requires this per capture.

### 3.2 The remaining data prerequisite

Camera-clipping gates need **mapped buildings**; water-order gates need **mapped water polygons**. Coordinate Explorer gets both from network vector tiles, which are blocked in this sandbox.

The runtime already accepts a same-origin provider URL (the provider loader allows paths beginning with `/`). So the missing piece is an **offline fixture provider**: encode `src/geo/GeoFixtures.js` fixture data into a real, spec-valid MVT `.pbf`, drop it in `public/`, and add a provider entry pointing at it. The repo already has `pbf` and `@mapbox/vector-tile` as dependencies, so the encoder is a small Node script. This is a development-only path and must not ship as a production provider.

Without it, only **curated-mode** gates and coordinate **fallback-terrain** gates are reachable. The offline fallback itself was verified working on 2026-10-03: with both providers unreachable, coordinate mode produced its seeded 33×33 terrain, displayed a specific bounded error, kept visible attribution, kept the debug overlay live, and logged zero console errors — a clean confirmation of build invariant 12.

---

## 4. Gate register

### Group A — the gates currently blocking roadmap items

#### A1. `COL-05` — Near-plane-derived TPP camera sweep *(coordinate)*

| | |
|---|---|
| **Roadmap** | Order 034, P0, **`ADDED` — closed 2026-10-04** (was `ACTIVE`), depends on `COL-03`, `COL-04` |
| **Code** | `src/geo/GeoPlayer.js` → `updateCamera()`; `cameraNearPlaneSweepRadius()`; `world.clipCamera()` |
| **Automated part** | Passing. Algorithm and response are unit-tested. |
| **Open gate** | Moving visual audit of the sweep response |

**What the code does.** Derives a sweep sphere from the near-plane half-diagonal, sweeps it from a target outside the player solid toward the desired camera position, and applies an asymmetric response:

```js
if (clip?.blocked) {
  // compress IMMEDIATELY so the previous frame's camera cannot linger behind a facade
  this.cameraResolvedDistance = Math.min(this.cameraResolvedDistance, allowedDistance);
} else {
  // recover SLOWLY to prevent doorway/corner pumping
  const recovery = 1 - Math.exp(-4 * Math.max(0, dt));
  this.cameraResolvedDistance = THREE.MathUtils.lerp(this.cameraResolvedDistance, allowedDistance, recovery);
}
```

**What is being verified (research `CLIPPING_AND_LAYERING_RESEARCH.md` §15.3):**

1. Orbit 360° around rectangular, rotated, L-shaped, concave, and thin buildings at both minimum and maximum TPP distance.
2. The camera never renders from inside a `CAMERA_BLOCKER`, and near-plane corners remain legal.
3. Emergency inward compression resolves in the **first affected rendered frame**; outward recovery is smooth and hysteretic.
4. The camera may pass above a low building **only** when the packed vertical span permits it.
5. Low bridge/ceiling and terrain cases preserve legal pitch as far as possible.
6. Foliage fade affects only eligible clutter; structural walls stay opaque.
7. Pathological close TPP self-fade prevents the avatar being sliced by the near plane.

Item 3 is the sharp one: `Math.min` compression is *instant by construction*, but whether the result actually resolves **in the first affected rendered frame** depends on update ordering relative to the render call — a temporal property no unit test observes.

**★ CLOSED 2026-10-04 — status `ADDED`.** The offline fixture provider landed (see §6.F2), so mapped buildings are orbitable with no network. `npm run visual:audit -- coordinate-matrix` swept **480 frames** across five fixtures (`dense-urban`, `concave-building`, `courtyard-hole`, `sparse-rural`, `stacked-bridge`) at both wheel-clamp extremes (min `1.2`, max `8`) with **0 penetrations**.

The test point is deliberately *not* the camera origin. The camera origin can sit legally outside a facade while the near plane clips through it — that is the exact failure this feature fixes — so the probe unprojects the **four corners of the near-plane rectangle** into world space and containment-tests each one. Crucially, the containment test is a **zero-length, zero-radius `world.sweepSphere`**, which reuses the shipped query (mask filtering, packed vertical spans, exact footprint refinement) in a direction the sweep logic never resolves, so it cannot pass by construction. `sweepPointAgainstAabb` reports `startedOverlapping` for a start-inside segment, which is what makes a degenerate sweep a valid containment test.

Research item 3 was the sharp one and is now measured, not assumed. The probe first scans yaws at maximum distance to find a genuinely obstructed pose, then jumps the camera from a clear pose straight into it — the worst case, with no gradual approach to hide latency. Compression fired on the first frame and landed exactly on the constrained distance: `8.000 → 3.108` against a target of `3.108`, `first-frame-legal=true`.

**Honest coverage limits.** Every sampled target classified as `blocky`; the fixtures use a standard block footprint, so no separate thin, long, rotated, or L-shaped *AABB* family was exercised as a distinct case. What *was* exercised is the exact-ring refinement that concave and courtyard geometry depends on: the world's own `queryDiagnostics.exactTests` counter advanced by **675** across the sweep, and `concave-building`, `courtyard-hole`, `sparse-rural`, and `stacked-bridge` each reported `1/1` tiles carrying exact footprint rings. The AABB is only a broad-phase proxy; the exact ring is what decides these cases, and it ran. Research item 6 (foliage fade eligibility) is **not** claimed — camera fade is `LAY-06`, still `DEFERRED`, so no fade behaviour exists to validate. Evidence: `tools/visual-audit/out/2026-10-04T08-19-45-341Z-col05-coordinate-matrix/`.

---

#### A2. `COL-06` — Curated camera structure obstruction *(curated)*

| | |
|---|---|
| **Roadmap** | Order 035, P0, **`ADDED` — closed 2026-10-03** (was `PARTIAL`), depends on `COL-01`, `COL-05`, `FND-08` |
| **Code** | `src/reference/ThirdPersonCamera.js` (102 lines) |
| **Automated part** | Passing. All six static structural families have tight tested compounds. |
| **Open gate** | Moving landmark/skyline/railway validation |

**Coverage:** bridges, landmarks, hoardings/signs, skyline towers, and railway masses. Same compression/recovery idiom as `COL-05`, plus a ground clamp (`position.y ≥ groundHeight + 2`). Applies the same §15.3 criteria to curated geometry.

**★ CLOSED 2026-10-03 — status `ADDED`.** Curated mode renders fully offline, so every structural family this gate covers was reachable without a fixture provider. `npm run visual:audit -- curated-camera` sampled **313 frames** across six families at minimum (10u) and maximum (65u) orbit distance plus a forced 180° yaw jump: **0 penetrations**, 0 console errors, and the yaw jump resolved with 0 penetrations across its 12 frames (the compression-latency requirement). The Gateway arch was proven a tight compound rather than an enclosing AABB: an 18-box family whose union box provably contains the opening sweep let that sweep pass while still blocking a sweep into the pier. Frames were reviewed by eye and agree. Research item §15.3-6 (foliage fade eligibility) is **not** claimed — camera fade is `LAY-06`, still `DEFERRED`, so no fade behaviour exists to validate.

---

#### A3. `LAY-03` — Opaque/transparent render policy

| | |
|---|---|
| **Roadmap** | Order 042, P0, **`ADDED` — closed 2026-10-04** (was `ACTIVE`), depends on `LAY-01`, `QLT-05` |
| **Code** | `src/geo/GeoWorld.js` (water material, `renderOrder` bands); `src/geo/GeoLayers.js` (band table) |
| **Automated part** | Passing. Bounded Three sorting and semantic bands are in place. |
| **Open gate** | Moving transparent-water validation |

**What the code does.** Water is `transparent: true, depthWrite: false`, and every world layer takes an explicit `renderOrder` from `GEO_LAYER.*.renderBand` (ground → road → land → water → building, with building detail at `building.renderBand + 1`). This implements the research's §9.4 render-pass table without relying on `renderOrder` to sort *within* a merged mesh.

**What is being verified (research §15.4):**

1. Inspect road/land/water overlap and a four-tile corner from all cardinal directions and at **low grazing angles**; no flicker.
2. Compare a sort-enabled/disabled harness: the chosen production policy yields deterministic water order.
3. Overlapping waterway/polygon features do not **darken from duplicate blending**.
4. No alpha-blended foliage family is introduced.
5. Surface offsets stay within the named contract and do not accumulate per source layer indefinitely.
6. FPP standing at a wall does not expose building interiors through the near plane.

Item 3 already has automated backing (`LAY-04` removed intersecting ribbons from the mesh while retaining query truth), so the visual gate is confirming the *residual* case rather than discovering it.

**Related research still unactioned** — §10.1: coordinate depth is near `.02` / far `210` (ratio 10,500) while fog ends at `175`. Research recommends testing near `.03–.04` and pulling far toward the fog limit. Resolving this is a natural companion to the `LAY-03` capture, since both are judged from the same grazing-angle frames. Low profile should also test **opaque** stylized water first (§10.2) — currently blocked as `ENV-03`.

**★ CLOSED 2026-10-04 — status `ADDED`.** With the fixture provider serving mapped water, all four criteria have direct evidence.

*Criterion 1 (no flicker).* Frame-to-frame diffing is worthless here — water normals animate, so frames differ by design. The defect being hunted is *ordering* instability, so the probe renders the identical scene **twice back to back inside one task**, with no clock advance and no animation step, and compares the drawing buffer via `gl.readPixels`. Identical inputs must give identical pixels. Result: **24/24 renders pixel-identical** across 4 cardinal directions × 3 grazing pitches (`.02`, `.05`, `.1`) × 2 distances. Zero differing bytes, `maxDelta = 0`.

*Criterion 2 (deterministic order).* `renderer.sortObjects` is `true` in production. The bands are `water@100` against a highest opaque band of `1`, so transparent water always blends after every opaque layer has written depth. Opaque layers legitimately share band `0` — they are depth-written, so Three's opaque pass resolves them without explicit bands, and claiming otherwise would misread the design. The sort-enabled/disabled comparison was run and both configurations were order-stable at this pose; the shipped policy is what production keeps.

*Criterion 3 (no duplicate blending).* `provider-equivalence` exists for exactly this, and both vocabularies now resolve to the same single lake: `openmaptiles` (`water` layer) and `shortbread` (`water_polygons` layer) each produced **1 mesh, 2 triangles, 4 vertices, 1 water domain, 4 classes** — identical geometry, drawn once. **Recorded limit:** the fixture set contains no *overlapping* water pair, so the residual self-overlap case is not visually exercised here; the intersecting-ribbon suppression it would test is `LAY-04`, which is separately `ADDED` with its own gate.

*Criterion 4 (no blended foliage).* Only **one** transparent material exists in the entire coordinate scene — the water `ShaderMaterial` (`transparent: true`, `depthWrite: false`, `depthTest: true`). Non-water transparent materials: **0**. There is no alpha-blended foliage family.

**Not claimed:** criteria 5 (surface-offset accumulation) and 6 (near-plane exposure of interiors at a wall) were not part of the recorded open gate and are not asserted here. The §10.1 near/far depth question was also not resolved — it needs the far-plane/fog comparison, not the grazing frames alone. Evidence: `tools/visual-audit/out/2026-10-04T08-24-29-053Z-lay03-water-order/` plus the two `…-provider-equivalence-{openmaptiles,shortbread}` runs. Reviewed by eye: `water-grazing-{north,east,south,west}.png` show clean water at a grazing angle with the offline-fixture HUD confirming the source.

---

#### A4. `MAT-03` — Mip/distance/derivative anti-alias policy

| | |
|---|---|
| **Roadmap** | Order 062, P0, `PARTIAL`, depends on `MAT-02` |
| **Code** | `src/engine/ProceduralMaterials.js`; profiles, texture filters, `gdoDetailFade` |
| **Automated part** | Passing. Mip/filter policy, derivative edges, distance fades, normal-first fade all tested. |
| **Open gate** | Moving low-pixel-ratio shimmer capture |

**What the code does.** Three profiles drive uniform-only distance behaviour:

```js
low:      { strength: .72, styleStrength: .58, fadeNear: 10, fadeFar: 54,  minimumPixels: 1.8  }
balanced: { strength: .90, styleStrength: .76, fadeNear: 18, fadeFar: 82,  minimumPixels: 1.55 }
high:     { strength: 1,   styleStrength: .92, fadeNear: 28, fadeFar: 120, minimumPixels: 1.35 }
```

Textures are filtered per role — `surfaceNoise` and `waterNormal` use `LinearMipmapLinearFilter` with mips; `styleMasks`, `dither`, and `paletteLUT` use `NearestFilter` with no mips. The shader computes a derivative footprint and fades detail when it would alias:

```glsl
float gdoFootprint = max(fwidth(gdoStyleCoord.x), fwidth(gdoStyleCoord.y)) * 16.0 * gdoMinimumPixels;
```

Because `fwidth` is core GLSL ES 3.0 and compiles under SwiftShader, this policy is **genuinely testable** in the new harness.

**What is being verified (research `PROCEDURAL_TEXTURES_…RESEARCH.md` §19.1 item 6):** at low pixel ratio, a moving camera shows no unacceptable road/grass/facade shimmer; offending micro patterns fade or mip.

**★ CAPTURE DELIVERED 2026-10-04 — the gate still does NOT pass. Status stays `PARTIAL`.**

**Anisotropic filtering is not used** (owner decision, 2026-10-04; `README.md` §9). Trilinear
selection alone is the accepted mip policy. It is not a finding and not part of this gate.

**What the capture does.** `npm run visual:audit -- shimmer-low-dpr` rotates the camera in
sub-pixel steps (`Δyaw = 0.0022`) at a grazing camera pitch (`0.01`) and reports three
frame-to-frame statistics over a centre crop: mean `|Δluma|`, the 99.9th percentile (how bad
the worst pixels get), and the hot-pixel fraction. It runs at `deviceScaleFactor 0.5`, which
lands the renderer on its **production adaptive floor of `0.6`** (`minimumPixelRatio` in
`GeoGame.js` — the lowest ratio the game will ever ship, not an artificial condition).

**Result: the metric is blind, so it decides nothing.**

| Configuration | mean `|Δluma|` | p99.9 |
|---|---|---|
| production (mip chains active) | `0.4456` | `4.1` |
| control (mip chains disabled) | `0.4459` | `4.1` |
| **positive control (all anti-alias fades stripped)** | `0.4496` | **`4.1`** |

The positive control removes `gdoDetailFade` (distance visibility pinned to 1) and
`gdoMinimumPixels` (footprint fade disabled) on all six semantic materials, plus `uNormalFade`
on the water material — the entire anti-alias policy. The p99.9 statistic does not move at all
(`1.000x`). A metric that cannot rise when the policy is removed cannot certify the policy, and
its low absolute numbers prove nothing about whether shimmer is visible.

**A withdrawn claim, recorded so it is not resurrected.** An earlier version of this section
reported production as **`0.890x`** of the mip-disabled control over water — i.e. the shipped
policy appearing *worse* than no mips — reproduced three times. That was an artifact. The water
shader offsets its normal-map lookup by `uTime`, which the render loop sets from wall-clock
milliseconds, so the production and control captures ran at **different wave phases**, and the
phase changes how much high-frequency detail faces the camera. The comparison was measuring
animation phase, not aliasing. With the phase pinned (`frozenWavePhase: 12`), the ratio is
`1.001x`. **Do not cite `0.890x`.**

**A second, larger measurement defect, also fixed.** The scenario originally returned its raw
pixel frames to Node — about 12 MB per measurement across the CDP bridge. That dominated
runtime (runs took ~16 minutes and one exceeded a 900 s protocol timeout) and produced no
verdict at all. The statistics are now computed inside the page and only the numbers cross the
bridge; a full run takes about 14 seconds.

**What must be true before this closes.** A software harness cannot settle this gate. The
register already records that SwiftShader's filtering quality differs from hardware, so the
verdict has to come from a **real-GPU capture** using the same scenario and statistics. If a
hardware run is not available, the honest alternative is an owner decision that MAT-03's shimmer
criterion is **waived** — recorded as an owner decision with the gate restated, rather than
closed on evidence that does not support it. Absent one of those, `MAT-03` stays `PARTIAL`.

**Coverage note.** This is the water/ground half. Road and facade shimmer needs mapped road and
facade detail, which the fixture provider now makes reachable, but was not part of this capture.
Evidence: `tools/visual-audit/out/2026-10-04T11-05-20-872Z-mat03-shimmer-low-dpr/`. The scenario
exits **2 (inconclusive)** rather than 0 when its metric is unvalidated, so it cannot be mistaken
for a pass.

---

#### A4b. `FND-07` — Zero-growth remount *(both runtimes)*

| | |
|---|---|
| **Roadmap** | Order 007, P0, **`ADDED` — closed 2026-10-04**, depends on `FND-02` |

**★ CLOSED 2026-10-04 — status `ADDED`.** The gate reads: *all workers, observers, textures, geometries and listeners prove zero-growth remount.* Two tiers prove it, because the five classes cannot all be reached from one place.

**Tier 1 — `npm test`, deterministic and CI-enforced.** `src/engine/ResourceLedger.test.js` drives three construct/dispose cycles per owner and asserts: exactly one worker constructed and exactly one terminated per remount; that worker's `message` and `error` subscriptions removed rather than left on the terminated instance; every armed geometry and texture firing `dispose` (ownership, not object count — `renderer.info.memory` belongs to the renderer, and a remount replaces the renderer, so counting cannot see across the boundary); pooled owners returning to empty; and net live listeners back to baseline for the player, joystick and world owners. Reverting the worker-handler removal makes the gate fail with `worker subscriptions must be removed on dispose`, so it is a gate and not a ceremony.

**Tier 2 — `npm run visual:audit -- remount-lifecycle`, exit 0.** Measures all five classes through the real landing flow, three mount → exit → mount cycles per mode. A warm-up cycle absorbs one-time page initialisation and the measured cycles must return **exactly** to that warm reference; this matters because two legitimate one-time registrations would otherwise look like growth — `react-dom` registers a delegated `selectionchange` on `document` the first time it needs that event type, and Vite injects a `<style>` into `<head>` on the first lazy CSS import.

| | coordinates | curated |
|---|---|---|
| mounted | 1 worker, 2 observers, 41 listeners | 0 workers, 1 observer, 167 listeners |
| after exit | **0 / 0 / 6** | **0 / 0 / 7** |
| geometries released | `11/11`, `11/11`, `26/26` | `83/83`, `89/89`, `75/75` |
| outstanding | 0 | 0 |
| orphaned subscriptions | **0** | retained in dev — see §6.F3 |

**What is asserted, and what deliberately is not.** Scene content is reported but not asserted: both runtimes stream, so the number of geometries in a settled mount legitimately varies (`10 → 10 → 26` in coordinates, `56 → 75 → 71` in curated), and a gate that demanded equal counts would fail for reasons that have nothing to do with lifecycle. The lifecycle property is that *nothing survives* — every armed resource released, every worker terminated, every observer disconnected, no growth in live listeners or in the mount host's DOM.

**Orphaned subscriptions are measured, not assumed.** Counting subscriptions cannot distinguish an app leak from a detached target the instrument itself is holding, so `tools/visual-audit/lifecycle.mjs` drops its own references and forces a collection over CDP. The first version of the instrument claimed those targets were "GC-reclaimable"; the measurement showed **4/4 retained** in the dev build, so the claim was withdrawn and replaced by evidence. The retention is dev-only — the production probe collects **0/4**, see §6.F3.

**Production tier.** The scenario needs the dev-only audit bridge, so it cannot run against a built bundle. `tools/visual-audit/probe-fnd07-production.mjs` drives the same real landing UI against `npm run preview` with instrumentation only: after every cycle listeners are `3` against a warm reference of `3`, the host subtree holds `38` nodes, `0` canvases remain, the document node count is flat, and **0 of 4** sampled discarded targets survive a forced collection. Evidence: `tools/visual-audit/out/2026-10-04T13-04-58-222Z-fnd07-remount-lifecycle/` and `tools/visual-audit/out/2026-10-04T13-07-34-454Z-fnd07-production-retention/`.

**Honest coverage limits.** Textures and observers cannot be reached from Node — both need a WebGL context — so they are proven in the browser tier only, and the browser tier runs under SwiftShader. The curated runtime's mounted listener count is dominated by React's own delegated set on the root container (`~142`), which is why the assertion is on growth against the warm reference rather than on an absolute number.

---

#### A4c. `COL-09` — Capped dynamic spatial hash *(the budget/query gate, not a pixel gate)*

| | |
|---|---|
| **Roadmap** | Order 038, P1, **`ADDED` — closed 2026-10-05**, depends on `COL-01`, `QLT-05` |

**★ CLOSED 2026-10-05 — status `ADDED`.** The gate reads: *64/128/256 profile caps; primitive-only dynamic proxies.* Neither half is a perceptual criterion, so both are decided by assertion plus one live run — and both halves fail differently, which is why they are proven separately.

**Caps: exact, enforced, and never evicting.** `GEO_DYNAMIC_PROXY_CAPS` is `64 / 128 / 256` for `low / balanced / high`. Each profile is filled to exactly its cap and the next insert must throw `GeoDynamicProxyCapError` naming the profile, the cap and the owner — `src/geo/GeoDynamicProxies.test.js` does this for all three tiers. The important half is what happens *after* the refusal: the population is unchanged, no existing proxy was evicted, and the query result is identical to before the attempt. Eviction was rejected as a design because dropping a solid is the one failure mode a player experiences as a physics mystery — walking through a moving vehicle. The 64 ceiling is also wired into `GDO_LOW_PROFILE_BUDGETS.dynamicProxies`, so an over-cap world is reported by the same budget evaluation every other low-profile ceiling uses.

**Primitive-only: four shapes, and everything else is named.** Circle, capsule, AABB and oriented box, each with a finite non-empty Y span; a compound is a short list of at most four of those, validated all-or-nothing. A mesh, a rendered object, a nested compound, an unknown name, a zero/negative radius, an inverted span or a non-finite centre is rejected with a message that says what arrived. A proxy spanning more than 64 cells is rejected rather than hashed unboundedly, with the message pointing at compounds as the remedy.

**Steady state.** Storage is allocated to the cap in the constructor: filling all 64 slots does not change `bytes`, and 500 queries reuse one candidate buffer. Re-bucketing happens **only** on a cell-boundary crossing, asserted as zero → one → three crossings across a slide, a long move and a return, with the query outcome following immediately and no stale candidates left in vacated cells.

**Live proof — `node tools/visual-audit/diagnose-dynamic-proxies.mjs`, exit 0 (2026-10-05).** Against `dense-urban` with mapped buildings resident:

| Check | Result |
|---|---|
| live profile / cap | `low` / `64`, equal to the budget ceiling |
| storage | `8320` bytes, preallocated to the cap |
| probe lane clear on an empty hash | sweep `false`, sphere `false` |
| same lane after placing one solid | `sweepCircle` hit at `t=0.4188` by `diagnostic-car`, `sweepSphere` hit at `t=0.4188` |
| player query | blocked at the proxy, clear 40 units away |
| 65th insert | refused, `GeoDynamicProxyCapError`, naming profile `low`, cap `64` and owner `the-65th` |
| existing proxy after the refusal | still solid (no eviction) |
| release and replace | `handle 1, slot 0` → `handle 2, slot 0` (slot reused, handle not) |
| static world across add + remove | `1 tile, 360 collider floats, 3571 bytes` before and after, `0` proxies left behind |

**The trap this gate was written around.** The first live probe reported `t=0.0000` with no dynamic owner: the sweep had started inside a mapped building, so a *static* contact at `t≈0` masked the dynamic one and the check would have passed or failed for reasons unrelated to `COL-09`. The diagnostic now requires the full probe lane to be clear on an **empty** hash first, then places the proxy and re-runs the same sweep. The evidence is the before/after pair, not the second measurement alone. Any future dynamic-contact probe needs the same discipline.

**Honest coverage limits.** The hash ships **empty** — no runtime code places a proxy yet; `DET-07` (vehicles), `PHY-01`/`PHY-02` (kinematic and dynamic response) and `LIF-02` (ambient agents) are the consumers, and they remain their own slices. Contacts are 2.5D and horizontal: an XZ primitive with a Y span gives exact horizontal sweeps, but vertical-plane contacts (landing on a moving deck, being lifted) are neither implemented nor asserted. The oriented-box sweep expands the moving radius into the half extents, which is conservative at the corners — it can stop the player marginally early and cannot let them through. No performance claim is made: the cap and the allocation contract are structural, and frame time still needs real hardware.

---

#### A4d. `FND-08` — Curated/coordinate domain interface *(both runtimes)*

| | |
|---|---|
| **Roadmap** | Order 008, P1, **`ADDED` — closed 2026-10-05** (was `PARTIAL`), depends on `FND-06`, `FND-07` |

**★ CLOSED 2026-10-05 — status `ADDED`.** The gate reads: *shared world/player/query interfaces without forcing one visual scale.* It has two halves that pull in opposite directions, and the gate is the tension between them: the **interface** must be the same for both runtimes, and the **scale** must not be. A gate written only for the first half could be satisfied by making one mode behave like the other, which is precisely the failure the second half exists to catch. Both are asserted.

**What "the interface" is.** Six members, declared in `src/engine/WorldDomain.js`: `supportAt`, `collidesCircle`, `moveCircle`, `resolveGroundStep`, `clipCamera`, `readDiagnostics`, plus a frozen `scale` descriptor whose fields have the same meaning in both modes. Arity is a floor rather than an equality — extras are allowed, and the declarations are checked with `Function.length`, which stops counting at the first default parameter, so the floor is what no domain may omit.

**Who implements it.** The coordinate runtime already had this shape: `GeoWorld` *is* its own domain, and its `name`/`scale` descriptor are now declared rather than implied. The curated runtime had no world at all — its traversal surface was spread across `BiomeManager`'s module-level 4 m terrain lattice, the bridge manager's rail boxes and deck heights, and the player's private collision box. `src/reference/CuratedDomain.js` adapts those into the same six members. Neither mode was rewritten into the other: every rule in `CuratedDomain` is the shipped rule moved behind a name, including the `.6` rail box, the centre-based world bound, the axis-separated revert and `heightAt`'s `-Infinity` on open ground.

**Both players now traverse through it.** The curated `Player` previously did its own arithmetic in `moveAxis` and `step`. It now asks the domain for horizontal motion and the step verdict, and samples ground through the shared `supportUnderFoot`, which is the same four-corner maximum it used to inline. This is what keeps the gate from being decoration: the interface has a production consumer in each runtime, not just a declaration.

**Node tier — `src/reference/WorldDomain.test.js`, 7 tests, part of `npm run check`.** A real `GeoWorld` with a compiled fixture *and* a real `BridgeManager` are driven by one identical probe, and the same `judgeWorldDomain` decides both. The tests also carry the negative controls, because a check that cannot fail proves nothing:

| Check | Result |
|---|---|
| both runtimes satisfy the six members + arity floor | pass (`supportAt/2 collidesCircle/3 moveCircle/5 resolveGroundStep/4 clipCamera/2 readDiagnostics/0`) |
| one probe, both runtimes, same semantics | pass, with the lane proven clear first and the solid proven present at its end |
| the two modes do not coincide | `advanced 5.200` vs `4.942` — a shared number would mean one lane was measured twice |
| the probe cleans up after itself | `activeCount 0` after the probe removed the solid it placed |
| scale guard | pass: footprint ratio `10.000x`, spacing ratio `33.333x`, sweep clamps disjoint |
| guard negative control | a domain adopting coordinate's clamp is **rejected** (`sweep clamps overlap`) |
| scale-drift negative control | a footprint off the 1:10 ratio is **rejected** (`must stay near the documented 10:1`) |
| contract negative control | a missing member is named; a 2-parameter `collidesCircle` is rejected |
| probe negative control | a domain that never reports a contact **fails** its own judgement |
| curated rule preservation | support matches `max(tileHeight, heightAt)` and the old four-corner maximum exactly |

**Browser tier — `npm run visual:audit -- domain-interface`, exit 0 (2026-10-05).** The same shared probe module is loaded into the page and run against the **shipped** runtimes through the real landing flow, then judged in Node by the same function the Node tier uses, so the tiers cannot drift:

| Check | Curated | Coordinates |
|---|---|---|
| interface report | complete (v1) | complete (v1) |
| scale | footprint `0.55`, spacing `4`, sweep `[0.6, 1.25]` | footprint `0.055`, spacing `0.12`, sweep `[0.03, 0.04]` |
| support | `y=3.0000`, `kind=terrain`, walkable | `y=-0.1457`, `kind=terrain`, walkable |
| lane | clear, solid at the end | clear, solid at the end |
| move | hit, contacts `1`, advanced `5.200` in 53 steps, `0.800` from the rail | hit, contacts `1`, advanced `4.942` in 50 steps, `1.058` from the proxy |
| step policy | level accepted, rise rejected as `step-up` | level accepted, rise rejected as `step-up` |
| camera | blocked `amount 0.813`, clear control unblocked | blocked `amount 0.420`, clear control unblocked |
| semantics | PASS | PASS |

Both stop distances are the sum of the mode's own numbers, which is the point: curated stops `rail half-depth .2 + footprint .55 = .75` from the rail centre, and coordinate stops `proxy radius 1 + footprint .055 = 1.055` from the proxy centre.

**Two traps this gate was written around.** First, the probe hands the move to the domain **in sub-steps and stops at the first contact**. One whole delta measured the wrong thing in curated mode: its move is a whole-delta step that reverts, so a 6-unit delta reported `advanced 0.000` — true of that call, false of the behaviour. Player-sized sub-steps make both modes show an approach and a stop, and the assertion `stepsTaken > 1` fails if anyone reintroduces a single-delta probe. Second, **lanes are found, never hard-coded.** Two attempts at choosing one by eye produced a lane already inside a building and a curated start with a bridge pier behind its clear-control segment; a probe measured from inside geometry proves nothing. Both tiers therefore search for a lane that satisfies every precondition, including the reverse camera control.

**What is deliberately not unified.** World generation and content remain separate implementations, and the gate does not ask for them to merge — the clause is "without forcing one visual scale", and the modes are different by design: curated resolves a 4 m terrain lattice at 1:1 with a camera clamp of `[.6, 1.25]`, coordinate resolves a 33×33 sample grid per tile at 1:10 with a clamp of `[.03, .04]`. `compareDomainScales` asserts the clamps stay disjoint and the footprint ratio stays near `10`, so neither a merge nor a silent 1:10 drift can pass. Also unasserted: the interface is **dev/test-visible rather than runtime-enforced in production** — the descriptor, assertion and probe are tree-shaken out of the shipped bundle, which contains the two implementations and the shared `supportUnderFoot` helper only. Frame time is not a criterion here.

#### A4e. `GME-05` — Shared interaction/action registry *(both runtimes, three surfaces)*

| | |
|---|---|
| **Roadmap** | Order 134, P1, **`ADDED` — closed 2026-10-05** (was `QUEUED`), depends on `COL-01`, `FND-08` |

**★ CLOSED 2026-10-05 — status `ADDED`.** The registered gate reads: *desktop/touch/UI expose every registered gameplay action.* Three surfaces, one registry — and the sentence is only meaningful if a surface that claims an action can actually reach it. That is what is asserted, per surface and per runtime, rather than the existence of a registry module.

**What the registry is.** `src/engine/ActionRegistry.js` declares twelve actions — `forward`, `back`, `left`, `right`, `run`, `jump`, `camera`, `map`, `debug`, `selectSlot1-3` — each with a `label`, a `kind` (`hold` active while held, `tap` fires once and ignores auto-repeat), the `codes` that reach it, the `runtimes` it exists in, the `surfaces` it is exposed on, an optional `touch` control (`button` with `text`/`grid`/`size`, or `joystick`), a `group` and, for inventory actions, a `slot`. `ActionInput` is the only object in either runtime that registers `keydown`/`keyup`/`blur`, and it owns the held set, the virtual set and the analogue stick, so a test that adds a raw code and a player that reads `active(action)` are looking at the same state.

**Why the registry had to exist.** Both live runtimes had grown their own keymaps, and one of them had no way to play on a phone at all: the curated runtime — the mode the landing page opens — shipped **zero touch controls**, so `GME-03`'s "device-gated complete touch controls" was true of the coordinate explorer only. Implementing this gate found that and fixed it, rather than documenting it: `mountTouchControls` now renders the curated inventory-mode controls from the same declarations the coordinate runtime uses.

**Node tier — `src/engine/ActionRegistry.test.js`, 14 tests, part of `npm run check`.** The registry's invariants are asserted, then the behaviour of the input object, then two checks that no runtime assertion can make:

| Check | Result |
|---|---|
| registry invariants | pass: 12 actions, every action labelled, kind valid, code-bound, runtime- and surface-known, touch control declared with `grid` and a size at or above 44px |
| no code bound twice in one runtime | pass — and this is the failure that is otherwise invisible: the losing action simply never fires |
| per-runtime surface group floors | pass: locomotion on keyboard and touch everywhere; coordinate adds view + diagnostics on keyboard and view on touch; curated adds view on touch |
| rendered markup ↔ registry equality | pass: button set and joystick zone per runtime are exactly the declared touch actions, and non-mobile markup renders hidden |
| a control can never name an action its runtime lacks | pass: `camera`/`debug` rejected by curated, `camera` absent from curated markup |
| codes resolve per runtime, not globally | pass: `KeyM`→`map` in curated and `null` in coordinates; `KeyV` and `F3` the other way round |
| `ActionInput` hold/tap behaviour | pass: hold stays active until release, `Space` fires once and auto-repeat does not re-fire, `map` is not left active |
| `ActionInput` refuses foreign or misspelled actions | pass: `camera` in curated and `jumpz` anywhere both throw `ActionRegistryError` |
| `ActionInput` discipline | pass: modified keys and text-field targets ignored; a vetoed press is counted as ignored, not as unknown, and does not become active |
| blur/dispose/snapshot | pass: blur clears keys, virtual state **and** the analogue vector while telling the owner; dispose leaves the object inert and removed every listener it registered (3 added, 3 removed) |
| **ui surface is real** | pass: `selectSlot1-3` are the only `ui` actions, each with a slot and a derived `[data-slot="N"]` selector |
| **no module outside the registry names a gameplay key** | pass: the whole `src/` tree is scanned for every registered code as a string literal |

The last one is the check that enforces the gate's own title. A second `['Digit1','Digit2','Digit3']` array in a React component or a second `F3` listener in the coordinate runtime is exactly how "one named surface" decays, and no runtime assertion can enumerate call sites that do not exist yet. Both of those duplicates were found and removed in this change: `GameUI.jsx` now forwards a click to the one selection entry point in `main.jsx`, and the coordinate runtime's debug key is dispatched by `ActionInput` to the same `toggleDebug` its button uses. The frozen `/classic.html` explorer keeps its own keymaps by the `AGENTS.md` rule that no new work goes into `src/world/`, `src/ui/` or the legacy `src/engine/` controllers; it is excluded by name and the exclusion is a written list in the test, not an accidental gap.

**Negative controls.** Because a green suite that cannot fail proves nothing, each new check was shown to fail before it was trusted: removing curated `jump`'s touch surface fails 7 tests (the group floor, the markup comparison and the input tests that depend on it); binding `F3` to both `map` and `debug` in curated throws by name (`binds F3 to both map and debug`); and re-adding a single `'KeyM'` literal to `GameUI.jsx` fails the source scan with `src/reference/GameUI.jsx names KeyM directly`.

**Browser tier — `npm run visual:audit -- action-surfaces`, exit 0 (2026-10-05).** The Node tier proves the declarations and the generated markup; only a browser can prove the *mounted* controls. The scenario drives the real landing flow into both runtimes and presses real elements with real events — pointer events on the buttons, a pointer drag on the joystick, and `KeyboardEvent`s on the page's own listeners. It does not call into the player, because calling `setVirtualInput` would test the very layer under suspicion:

| Check | Curated | Coordinates |
|---|---|---|
| touch actions declared / rendered | 7 / 7 (run, jump, map + 4 joystick) | 7 / 7 (run, jump, camera + 4 joystick) |
| buttons pressed with pointer events | `run` active while held and released to inactive; `jump`, `map` fire and leave nothing held | `run` likewise; `jump`, `camera` likewise |
| joystick drag | `z=-1.000` → `forward` active; `x=1.000` → `right` active; release returns `x=0 z=0` | identical |
| per-runtime keyboard resolution | `KeyW`→forward, `KeyM`→map, `KeyV`→none, `F3`→none, `Digit1`→selectSlot1 | `KeyW`→forward, `KeyM`→none, `KeyV`→camera, `F3`→debug, `Digit1`→none |
| ui surface | slot 0/1/2 each selected by its button **and** its key, asserted on the rendered `aria-pressed` | no inventory, nothing claimed |

**Phone-shaped viewport — the same scenario, 390x844 at DPR 2 with touch emulation.** Both runtimes must decide *for themselves* to show the controls (the check is device capability, not start state), and the targets must be usable:

| | Curated | Coordinates |
|---|---|---|
| `data-mobile` | `true` | `true` |
| buttons | run 52x52 at (242,771), jump 72x72 at (302,734), map 46x46 at (245,714) | run 52x52, jump 72x72, camera 46x46 |
| joystick | 218x633 zone, hit-tested by drag | 218x633 zone |
| desktop control | a mouse-driven browser gets `data-mobile="false"` — no joystick drawn over the page | same |

Two defects were found by this pass and fixed in the same change: the first CSS-driven sizing rendered RUN and MAP **15px** tall (the buttons were content-sized and aligned to the end of their grid cell, so the row height never reached them), and the size is now declared per button in the registry with a 44px floor asserted in Node and a `min-width/min-height` floor in the stylesheet beneath it. The gate also checks a `ui` claim the way it checks a touch claim: a registry slot no mounted `[data-slot]` carries is a failure, which is why the surface is asserted through `aria-pressed` after letting React commit its render rather than by reading the store.

**Regression evidence from the same run.** `remount-lifecycle` exit 0 — zero growth, `0` leaks, and the listener counts moved exactly as expected when ownership moved into `ActionInput` (coordinate 49 mounted, curated 189, both exiting to 7 with everything released). `domain-interface`, `curated-camera`, `coordinate-matrix` and `water-order` all exit 0 with this change in place.

**Not asserted, deliberately.** Frame time and input latency are not criteria here. The registry also does not merge the two runtimes' *actions*: coordinate mode has camera and diagnostics and curated mode has an inventory, and the gate asserts the declared per-runtime set rather than a single union — a runtime must expose everything it declares, and must not claim what it lacks.

#### A4f. `CNT-01` — Versioned state-content schema *(content files, both tiers)*

| | |
|---|---|
| **Roadmap** | Order 160, P1, **`ADDED` — closed 2026-10-05** (was `QUEUED`), depends on `FND-06`, `FND-08`, `DET-02` |

**★ CLOSED 2026-10-05 — status `ADDED`.** The registered gate reads: *current experimental JSON gains schema, validation and migration.* All three words are load-bearing, and each is asserted separately: **schema** — the format is declared, not described; **validation** — a bad file is rejected with the field named; **migration** — an old file still loads, and un-migrated content does *not*.

**Why this mattered.** The project advertises a low-code contribution path ("author a state or landmark in JSON and the runtime builds it"), and until this change that path had **no contract whatsoever**. `public/content/states/*.json` were two experimental files with no version stamp, no validation and no migration, fetched by a bare `fetch` + `res.json()` and handed straight to the geometry builder. A typo produced a silently half-built vignette; a format change would have made every existing file quietly wrong. This is the item that turns the advertised path into a real one.

**What the schema is.** `src/engine/ContentSchema.js` declares the format as a table — `STATE_CONTENT_FIELDS` carries, for every field, its name, type, whether it is required, and a description written for a contributor — and the validator **walks that table**, so the schema and the checks cannot drift apart and `describeStateContentSchema()` can print the format for a tool (`CNT-03`). Ten field types cover the whole format: `id`, `string`, `color` (six-digit hex only), `vec3`, `positiveNumber`, `integer`, `enum`, plus the three richer shapes (`buff`, `collectible[]`, `voxel[]`) that get their own checks because a scalar handler cannot express them.

**Validation keeps two kinds of finding apart.** *Errors* mean the content cannot be rendered or looked up correctly: a bad buff type, a repeated voxel coordinate, a malformed tuple, a three-digit hex colour, an undeclared field, a duplicate item id, two items at the same spawn point, a spawn outside the declared bounds, a duration or multiplier past its cap, an icon that is not a glyph, a pack over its voxel cap. Every one of them **names its field by path** (`state.collectibles[0] ("banana_chips").buff.type must be one of speed, jump, shield, stamina, focus, got "speeed"`), because a validator that says "invalid" is unusable to an author. *Warnings* are advisory and never block a build: no `bounds`, no `provenance`, a description whose stated numbers no longer match the buff (edit a duration and the pickup text lies silently), two spawns inside the 1.8-unit pickup radius, an authoring origin that is not the origin. Both shipped packs carry warnings today — that is the honest current state, and a gate that failed on them would be reporting a product decision as a defect.

**Migration is a ladder, not a flag.** `MIGRATIONS` maps each version to the next, each step pure and returning its own notes, so the next format change adds one entry instead of rewriting the upgrade path (`NET-01` reuses the shape for save files). The v0 → v1 step repairs what legacy files got wrong rather than only relabelling them: it drops coincident voxels (they z-fight and cost geometry; a same-coordinate different-colour pair is reported, first colour kept) and normalises hex case, which matters because `VoxelBuilder` caches materials by the **exact string**, so `#D4A017` and `#d4a017` would be two materials for one colour. A file stamped from the **future** is refused rather than passed through: validating it against an older schema would reject fields the author legitimately used, and accepting it would let an unknown shape reach the renderer.

**Node tier — `src/engine/ContentSchema.test.js` (13 tests) + `src/engine/StateManager.test.js` (4 tests), part of `npm run check`.** The shipped files are the real fixture: they are read from disk, not mocked, so a schema that the project's own content fails is caught immediately.

| Check | Result |
|---|---|
| both shipped packs validate | pass: `kerala` (32 voxels), `maharashtra` (34 voxels), zero errors, two warnings each |
| the schema is self-describing | pass: every field has a name, type, `required` flag and description; every key the shipped packs use is declared |
| caps derive from the shared ceiling | pass: `voxelsPerState = floor(180,000 × 0.5 / 12) = 7,500`, asserted as arithmetic, not as a literal |
| **every error class has a fixture that produces it** | pass: 29 cases, each asserting the **message** (missing/duplicate/malformed fields, bad buff type, zero multiplier, fractional duration, over-cap values, tuple arity, non-integer coordinates, short hex, coincident voxels, conflicting voxels, long icon/description, over-cap counts, same spawn point, non-object root, bad version type) |
| the valid control | pass: a minimal valid pack validates, so a validator that rejected everything would not pass the table above |
| all problems reported in one pass | pass: a pack broken four ways reports all four, and does **not** invent a rule for a negative integer duration |
| advisory warnings fire without blocking | pass: stale `+3x`/`9s` text vs a `2×`/`5000ms` buff, a 1.00-unit spawn cluster, a `(5, 5, 5)` authoring origin; agreeing text stays silent |
| declared-optional blocks | pass: `bounds` (including spawn-outside-bounds and inverted axes), `provenance` (valid review statuses, arrays, unknown keys rejected), presentation colours |
| legacy fails strict, passes migrated | pass: exactly **one** precise error for v0, and the migrated object is **deep-equal to the shipped v1 file** — the two producers of v1 content cannot drift |
| migration repairs, and says so | pass: 2 coincident voxels removed with notes, mixed hex case normalised, repaired file validates |
| migration is a no-op on current content | pass: same object reference returned, no mutation of the caller's data |
| the future is refused | pass: `schemaVersion: 2` is not migrated, and does not validate either |
| the ladder has no gaps | pass: strictly increasing from v0 to the current version |
| **the loader consumes the schema** | pass: a shipped pack loads through `StateManager.loadState` into a real `THREE.Scene` (2 vignettes = mesh + ring each), a legacy pack migrates en route, a missing pack fails as a 404 load error, and invalid content is **refused without touching the scene** (`children.length === 0`, no partial state) with both problems named |
| **negative control: the loader bypasses the schema** | all 4 loader tests fail, so the wiring is load-bearing rather than decorative |
| **negative control: the shipped pack is corrupted** | the gate fails with `buff.type must be one of …` and the unknown-field path, and `ContentSchema.test.js` fails 4 tests |

**Browser tier — `npm run visual:audit -- content-schema`, exit 0 (2026-10-05).** The Node tier validates the files *on disk*; this tier proves the files the game actually receives are the same files. It loads the landing shell (no WebGL game is started — three JSON files do not need a renderer), imports the **real** `ContentSchema.js` over the dev server, fetches both packs, and validates them in-page:

| Check | Kerala | Maharashtra |
|---|---|---|
| served | 200, `application/json` | 200, `application/json` |
| validated in-page | `stateId=kerala`, 2 collectibles, 32 voxels, schema v1 | `stateId=maharashtra`, 2 collectibles, 34 voxels, schema v1 |
| **SHA-256 of served text vs file on disk** | **identical** | **identical** |
| warnings | 2 (bounds, provenance) | 2 (bounds, provenance) |

It also exercises the two paths that only exist in the browser: a v0 pack fetched over HTTP migrates to v1 **in-page**, and a corrupted pack is rejected in-page by `StateContentError` naming `buff.type`. The negative control — changing one shipped field to a string — makes the scenario exit **1** with the field named and the hash reported as `DIFFERS`.

**The recorded gap, printed by the gate.** Nothing mounts `StateManager`: no entry point imports it, so the validator is tree-shaken and **ships zero bytes today** (verified by grepping `dist/assets/*.js` for schema-specific strings — the only match is the `contentSchema: 1` entry in the feature-version registry). That is stated in the scenario's own output and in the summary line (`runtime mount: dormant`), and it is the honest boundary of this item: `CNT-01` gives content a contract and proves it against the shipped files; `CNT-02` (recipe compiler) and `CNT-04` (packs) are what put content on a live surface. Claiming a runtime consumer that does not exist would be exactly the kind of status inflation this register exists to prevent.

---

#### A4g. `GME-04` — Throttled label line-of-sight and the richer map readout *(coordinate)*
*also closes `LAY-05`, which describes the same deliverable in another category*

| | |
|---|---|
| **Roadmap** | Order 133, P1, **`ADDED` — closed 2026-10-05** (was `PARTIAL`), depends on `TER-01`. Order 044 **`LAY-05`** (DOM label line-of-sight, deps `COL-04`/`COL-01`, both `ADDED`) is closed on the same evidence |

**★ CLOSED 2026-10-05 — status `ADDED`.** The registered gate read: *added projection/overlap; LOS and richer map remain open.* Both remaining halves are delivered and asserted. The two rows were closed by **one** implementation: `GME-04` owns the label layer's line of sight in the feature matrix, `LAY-05` names the same behaviour as a layering criterion, and the register says so rather than pretending two slices landed.

**Why this mattered.** The DOM label layer sits *outside* WebGL depth. Both research documents name the resulting defect explicitly — the layering audit table lists *"Labels | projected DOM labels, overlap suppression only | labels do not participate in WebGL depth and can show through buildings"*, the defect-class table lists *"DOM label occlusion | a place name appears through a building | sparse line-of-sight query or in-scene label | CSS z-index"* — and its Phase 2 line prescribes exactly the shape delivered here: *"throttled label LOS using `LOS_BLOCKER` masks"*. A place name readable through a building is therefore a real product defect, not a polish item.

**What ships — `src/geo/GeoLabelLos.js`.** `LabelLosScheduler` casts one small sphere per candidate label from the camera and reports whether a `LOS_BLOCKER` is in the way:

- **Budgeted, not per-frame.** The research's own ceilings are the profiles: `low` `20/s × 5`, `balanced` `40/s × 10`, `high` `80/s × 14` (tests per second × simultaneous labels). The scheduler keeps a token bucket refilled by *elapsed wall-clock time* and capped at one pass's worth, so neither a burst nor a 60-second stall can be repaid as unbounded work.
- **Verdicts are held for the update interval.** `GEO_LABEL_LOS_REFRESH_MILLISECONDS = 250` is the interval §15.6.1 names: within it the previous verdict stands, which is what makes a hidden name stay hidden while the camera moves instead of flickering per frame.
- **`LOS_BLOCKER` only.** §15.6.2 forbids consulting collectible, grass, bird or bee proxies; the mask is the hard contract and the browser tier intercepts the live call to check the *argument*, not the source.
- **`out.hit`, never truthiness.** `world.sweepSphere` returns its `out` object, which is truthy whether or not anything was hit. Reading the return value as a boolean would have hidden **every** label in the scene — the exact failure class this gate exists to catch — so the scheduler reads `out.hit` and trusts a strict boolean return only as a fallback. A dedicated test drives a world-style sweep to keep that asymmetry honest.
- **`time` distinguishes two different things.** `t = 0` means the eye is *inside* geometry: a legal query result, but not a standing position a player can occupy. The gate only accepts an interior contact (`0 < t < 1`), which is what "a name behind a building" actually means.
- **The DOM trails by one pass, by construction.** `isHidden` is read while building the label layer, before the pass that refreshes verdicts, so a verdict lands on the next refresh. The gate waits for *agreement* rather than judging the frame it teleported on, and it also requires the verdict to be **fresh** (age inside the refresh interval) — a fresh row proves the label was a candidate in the last pass, so it was on screen and not overlapped, and a hidden verdict can only be about occlusion rather than a stale verdict on a culled label.
- **Diagnostics.** Per-label rows carry the **ray**, its **blocker** and the **LOS update age** (§12.1), the counters carry **label LOS tests / hidden labels** (§12.2), `lastBlocker` reports the newest *currently blocked* row rather than only what the newest pass happened to test, and the debug panel prints `labels los:<profile> <tests>/s max:<labels> tests:<n> hidden:<n> now:<n> age:<ms>ms blocker:<name>@<tile> t=<t>`.
- **Retirement.** `retain()` drops verdicts for labels that are no longer candidates, so an element recycled by index cannot inherit another name's occlusion; `reset()` clears counters *and* verdicts, because clearing one without the other left `blockedNow` reporting a label it no longer tracked.

**The richer map readout.** The coordinate panel now prints `lat, lon · nearest <name> <distance> <compass point>`, with the bearing computed from the **coordinate pair** — the authority on orientation (`worldToCoordinate`) — rather than from world axes, so it cannot disagree with the numbers printed beside it. The compass point is one of sixteen slices and the distance is formatted as `840 m` / `1.4 km`. The label layer also marks its verdict in the DOM: an occluded label carries `data-los="blocked"` and its name in `data-label`, which is what makes the browser gate's comparison possible and a devtools reader able to see why a name vanished.

**Node tier — `src/geo/GeoLabelLos.test.js` (8 tests, part of `npm run check`, now 228 tests / 125 modules).** The scheduler is driven with a **synthetic wall** rather than a compiled fixture, because the contract is about what the layer asks and how much it asks:

| Check | Result |
|---|---|
| a label behind geometry hides, one in front stays visible | pass: one hidden of two, `blockedNow 1`, the blocker and the full ray reported, contact strictly inside the segment |
| **the query asks for `LOS_BLOCKER` only** | pass: the mask argument equals `LOS_BLOCKER` and every one of the other six roles reads `0`, so a pickup or a bird cannot blank a name |
| a verdict is held for the refresh interval | pass: no re-test 16 ms later, `skippedForRefresh 1`, re-tested at 250 ms, age readout `0 → 150 ms` |
| the ceilings are hard, under bursts and stalls | pass: a 10-pass burst inside one second stays inside 20 tests with the excess reported as skipped; a 60-second stall still tests at most one pass's worth |
| a label can clear, and a retired label cannot keep a verdict | pass: the same key returns visible after moving clear, `retain` forgets it, `reset` zeroes counters and verdicts |
| **a sweep that returns its `out` object is read correctly** | pass: an unobstructed world-style sweep hides nothing; a blocked one hides the label — the regression guard for the truthiness trap |
| malformed configuration is refused | pass: no sweep, unknown profile, zero refresh interval each throw by name; radius and interval asserted against their reasons |
| the map bearing and distance are geographically correct | pass: `0.01°` north is `1113 m`, east shrinks by `cos(lat)`, all four quadrants, diagonals, 16 reachable slice names, wrapping at 359° and −1°, `formatMetres` rounding |

**Browser tier — `npm run visual:audit -- label-los`, exit 0 (2026-10-05).** The pair is **found, never authored**: the scenario searches standing positions around each committed label with the world's own `LOS_BLOCKER` sweep, teleports to a hit, and then compares the layer's DOM verdict against an independent probe taken from the live camera.

| Check | Result |
|---|---|
| committed labels in `dense-urban` | 11 (`Fixture Nagar`, ten grid streets); labels commit per tile, so the scenario polls rather than assuming a frame count (6 frames yields zero) |
| obstructed standing positions found | 44, of which **5** have the wall strictly between eye and name — the other 39 start inside geometry and are excluded as player-unreachable |
| **occluded half** | pass: `Fixture Nagar`, live contact `t=0.375`, fresh scheduler row `blocked @134-163 ms`, `dom.hidden=true`, `data-los="blocked"` — the label is in the DOM and deliberately hidden |
| **visible half** | pass: `Grid Avenue 1` with a clear live ray, a fresh non-blocked row, and `dom.hidden=false` / no `data-los` marker |
| ray discipline (§15.6.2) | pass: 3–4 label sweeps in a 1.5 s window and **every** recorded mask equals `LOS_BLOCKER` (`16`); a foreign mask fails the run |
| budget (§13) | pass: profile `low`, `20/s × 5`, tests in the window far under the allowance |
| counters and diagnostics (§12.1/§12.2) | pass: `hidden ≥ 1`, per-label rays present, a named blocker with its rail `11728:6812`, `updateAgeMilliseconds` reported |
| review panel | pass: `labels los:low 20/s max:5 tests:8 hidden:1 now:0 age:300ms blocker:…` — read from `#geo-debug-output` after clicking the runtime's own debug toggle |
| **richer HUD, checked independently** | pass: printed `28.996130, 77.717593 · nearest Grid Avenue 1 30 m W`; the scenario recomputes `30 m` and `W` from the two coordinate pairs the runtime itself reports (a 3-unit separation is 30 m at this runtime's documented 1:10 scale) |

**Four negative controls, each measured (all exit 1).** A gate that cannot fail proves nothing, so each criterion was broken in turn and the run re-executed:

| Break | Observed failure |
|---|---|
| occlusion disabled (`const occluded = false`) | `occluded NONE — the criterion is unproven` → *no player-reachable label was hidden by a building within the update interval* |
| label ray asks for `CAMERA_BLOCKER` instead | `masks [4] vs LOS_BLOCKER 16` → *label rays used masks 4; only LOS_BLOCKER is permitted* |
| profile switched to `high` | `profile high 80/s × 14` → *the runtime profile is 80/s × 14, not the low profile's 20/s × 5* |
| overlay extras dropped | `labels los: unavailable` → *the review panel line does not carry the profile, counters and blocker* |

**Recorded gaps, stated rather than implied.** (1) The browser search runs in one fixture at one coordinate; the *rule* is fixture-independent and proved in Node against a synthetic wall, but fixture coverage is one. (2) The coordinate runtime pins the label LOS profile to `low` (a literal) rather than deriving it from the active quality profile — a deliberate first cut, so the budget is currently constant across profiles. (3) Only `LOS_BLOCKER` geometry (buildings, bridge decks) hides a name; vegetation and other proxies deliberately cannot, which is what §15.6.2 demands. (4) The nearest-place line refreshes on the once-per-second stats tick, unchanged by this work.

---

#### A4h. `LIF-02` — Budgeted ambient-life scheduler *(coordinate)*
*also closes `LIF-01`, which describes the same deliverable in another category*

| | |
|---|---|
| **Roadmap** | Order 121, P1, **`ADDED` — closed 2026-10-06** (was `QUEUED`), depends on `COL-09`, `VEG-07`, `QLT-05` (all `ADDED`). Order 120 **`LIF-01`** (existing deterministic birds and bees, deps `VEG-01`, `ADDED`) was `PARTIAL` with the open gate *"Bounded instances exist; CPU transforms remain"* and is closed on the same evidence |

**★ CLOSED 2026-10-06 — status `ADDED`.** The registered gate read: *screen/distance/activity budgets; no per-agent object graphs.* All three budgets are implemented and asserted, and the no-allocation claim is measured rather than asserted. **One implementation closed two rows**: `LIF-01` records that bounded bird/bee instances exist while the CPU transforms remain unbounded, and this slice is what bounds them, so the register records one slice rather than pretending two landed — the same pattern already used for `GME-04`/`LAY-05`.

**Why this mattered.** The frame loop walked **every ambience instance of every resident tile on every frame** — no distance test, no screen test, no budget. Both research documents name it as a defect rather than a design: the audit table's *"Birds and bees update instance matrices on the CPU"* (§4 item 10) and the ceiling table's *"Small ambient fauna visible | 30 | 60 | 100"* with *"Total added steady draw calls in ordinary view | ≤ 8"* (§14), against §6's prescription that *"All fauna use pooled, instanced, highly simplified motion and habitat anchors."*

**What ships — `src/geo/GeoAmbientLife.js`.** `GeoAmbientScheduler` is a pool, not a per-agent object graph:

- **Preallocated typed arrays.** Anchors, phase, scale, species, a stable integer, an instance index, the owner key and a pose row all live in buffers sized to the profile's capacity (`64` / `128` / `256`). Nothing is allocated per agent, and the steady cost was measured flat in agent count: **≈16 bytes per pass at 64 agents, −18 at 8** over 20,000 passes, against a per-agent control costing one object per agent per pass.
- **Two budgets, kept apart.** The *drawn set* is a fixed-size ring of `visibleCeiling` entries (`30` / `60` / `100` — the research's §14 numbers), and the per-frame *work* is a separate pose budget (`24` / `48` / `96`). This distinction is **the defect this gate found**: the first version bounded only the update rate, which let a resident set larger than the ceiling draw every agent — the updated ones moving and the rest holding a stale pose.
- **Culls counted by reason.** `distance` beyond `72 m`, `screen` below `0.6 px` (compared in squared space), and `activity` wound down by the caller, each with its own counter and a `lastRejection` naming `over-capacity`, `unknown-type` or `malformed-placement` for refused claims.
- **The activity budget is the environment hook.** `update(..., { activity, speciesActivity })` and `world.setAmbientActivity(value, speciesActivity)` scale a family deterministically — each agent's stable integer decides whether it is still awake, so there is no per-frame dice — which is what lets `ENV-04`'s weather shelter birds while bees keep working without a second animation path.
- **A culled agent is collapsed, not frozen.** Leaving the drawn set queues the slot; the world writes a zero-scale matrix, which is degenerate geometry that costs no visible pixels while keeping the batch's instance count and upload layout fixed. A bird frozen mid-air is the defect class being removed.
- **Determinism survives the pool.** The stable integer is derived from the **placement** (`|round(x*31 + z*17 + phase*1e4)|`), never from iteration order, so a tile that streams out and back reproduces the same orbits.
- **Lifecycle.** Slots are claimed at mount (`instanceIndex` is the mesh's cursor, so no lookup table exists), `mesh.count` is set to what was granted, `_evictTile` calls `releaseOwner(tile.key)`, and `dispose()` calls `reset()` — which clears the counters, the ring and the activity state together, because clearing one without the others is the same defect class already fixed in `GeoLabelLos.reset()`.

**Node tier — `src/geo/GeoAmbientLife.test.js` (10 tests, part of `npm run check`, now 238 tests / 126 modules).**

| Check | Result |
|---|---|
| profiles agree with the research ceilings | pass: each profile against `GEO_AMBIENT_RESEARCH_CEILINGS`, and the shared low budget separately required to *agree* with `30` — the first version compared the balanced profile against the low budget and threw |
| claims, releases and the capacity cap | pass: a full pool refuses by name (`over-capacity`) instead of evicting, `releaseOwner` returns exactly its own slots, a rebuilt tile reclaims the same number |
| **distance and screen budgets, from both directions** | pass: a far agent is culled as `distance` while a near one is drawn, and a small-on-screen agent is culled as `screen` at `8000 px/m` while a large one at the same scale is not — asserting only the cull would pass on a scheduler that culls everything |
| the activity budget winds down and back up | pass: activity `0` draws nothing and counts `activity` culls; restoring it returns the same agents in the same order |
| **the two budgets are both hard** | pass: `drawnSlots ≤ 30`, `lastPoseUpdates ≤ 24`, evaluations inside twice the budget, and `ring.length === visibleCeiling` structurally |
| **no per-agent object graph, and no cost that scales with agents** | pass: 8 vs 64 agents measured over 20,000 passes (`−18` and `+16` bytes/pass; the forbidden pattern would add ≈3.8 KB at 64), one reused pose object across every callback, fixed buffer identities, a free list that cannot exceed capacity |
| motion is the shipped formula | pass: bird `speed .30+step·.045`, radius `.72+.16·step`, height `2.55+.28·step`, bob `.18 @1.35 Hz`, roll `.08 @3.2`; bee `1.45+.13·step`, `.13+.045·step`, `.48+.055·step`, `.072 @4.4`-class bob and roll `.12 @8` |
| **a whole-unit rebase does not teleport agents** | pass: jump far enough to cull, return, and compare *absolute* poses — the round trip that exposed a stale origin-relative pose once putting an agent 1,414,213 units from its anchor |
| pose packaging and reset | pass: `writeMatrices` hands out one pose object, `forEachHidden` reuses it too, and `reset()` zeroes counters, ring, payload and activity together |

**Browser tier — `npm run visual:audit -- ambient-life`, exit 0 (2026-10-06).** The central check is deliberately **not** the scheduler's own bookkeeping: the scenario reads the renderer's `InstancedMesh.instanceMatrix` buffers before and after a pass and counts how many instances actually moved. A frame loop that bypassed the budget would satisfy every counter and fail here — which is exactly what the first negative control demonstrates.

| Check | Result |
|---|---|
| resident set (non-vacuity precondition) | pass: coordinates open **8% inside a tile corner**, where the prefetch band streams four tiles — **58 agents resident on 4 tiles / 8 meshes**, stable across four consecutive readings, against a 30 ceiling and an allowance of 41 |
| drawn set and per-frame work | pass: `drawn 17` of 30, `poses/pass 17` of 24, `evaluations/pass 30–33` (twice the pose budget at most) |
| **upload — the independent measurement** | pass: **`17 of 58` instances moved in one pass**, allowance `41`, `0` orphaned meshes; window delimited by the scheduler's own pass counter (a fixed 120 ms window was measured containing zero frames on this renderer) |
| distance budget | pass: distance culls counted live (`233–334` across runs) while agents in the streamed tiles stay drawn |
| screen budget | **not exercised live, and stated as such**: at the coordinate camera's `≈100 px/m` a bee is ≈27 px, so nothing is near the 0.6 px floor; the floor and its counter are proven in the Node tier, and this is a coverage limit rather than a pass |
| activity budget | pass: `setAmbientActivity(0)` → `drawn 0`, `17` instances **collapsed** to zero scale, `activityCulls` rising; restoring to `1` → `drawn 17` again |
| review surface | pass: `ambience profile:low active:58/64 visible:17 ceil:30 per-frame:24 culls d:293 s:0 a:101 poses:294 activity:1.00`, read from `#geo-debug-output` after clicking the runtime's own debug toggle |

**Five negative controls, each measured (all exit 1).**

| Break | Observed failure |
|---|---|
| the pre-`LIF-02` unbounded walk reinstalled verbatim | `58 of 58` instances moved in one pass → *above the 41 the budgets allow*, while the scheduler's own counters still read `drawn 17` |
| the activity budget ignored (`const activity = 1`) | `activity 0 → drawn 17` → *the activity budget does not wind ambience down* |
| the distance budget disabled | `no distance cull was ever counted, so the distance budget is unproven live` |
| the hide path disabled (`_hide` returns early) | `collapsing 0 instance(s)` → *agents left the drawn set without being hidden* — the stale-pose defect |
| the review-surface marker renamed (`ambient profile:`) | `no ambience line` → *the review panel has no `ambience` line* |

**A defect in the gate's own tooling, found and fixed.** The runner only turns a scenario's failure list into a non-zero exit for the field names it knows, so this scenario's **first failing run exited 0** — `blockers 2`, printed, and a zero status. `run.mjs` now carries the `ambientFailures` branch (and prints the ambience summary beside it), and the `AGENTS.md` debugging notes record the trap for the next scenario.

**Recorded gaps, stated rather than implied.** (1) The live screen budget is not reachable through the product's own camera ranges, so the 0.6 px floor is proven in Node only. (2) The browser run measures **one** fixture at one coordinate; the rule is fixture-independent, but coverage is one. (3) `GeoWorld` derives pixels-per-metre from the camera-to-focus distance, so a viewport change or a very long camera boom shifts the screen budget — it is a deliberate approximation, documented at the call site, and it never admits more than the budget allows at the focus depth. (4) Ambient fauna are **non-colliding**: this slice placed no proxy into the `COL-09` hash, which still ships empty, and an earlier roadmap paragraph predicting otherwise has been corrected rather than quietly dropped. (5) No frame-time claim: the budgets are structural, and the software renderer here runs at a few frames per second.

---

#### A4i. `ENV-02` — Time-of-day light/sky state *(coordinate, with the curated runtime beside it)*

| | |
|---|---|
| **Roadmap** | Order 111, P1, **`ADDED` — closed 2026-10-07** (was `QUEUED`), depends on `MAT-04`, `QLT-05` (both `ADDED`) |
| **Gate** | Bounded uniform updates, readable night, no per-frame allocation |
| **Scenario** | `npm run visual:audit -- time-of-day --url http://localhost:5173/` |
| **Node tier** | `src/engine/TimeOfDay.test.js` (8 tests, part of `npm run check`, now **254 tests**) |

**★ CLOSED 2026-10-07 — status `ADDED`.** Each of the gate's three clauses is a claim that can be false while a screenshot looks fine, so each is measured on its own.

**What ships — `src/engine/TimeOfDay.js`.** One solar model (`declination = 23.44·sin(2π(day−81)/365)`, hour angle from the clock minutes and the longitude) drives the phase, the palette, the light rig, the exposure and the ambient budget. **The phase is a band of solar elevation**, so a phase that contradicts the sun is not a state the system can reach; the Node gate checks every minute of a full day (1440 samples), not four. Elevation stops: `−18 night`, `−8 blue-hour`, `−1.5 sunset`, `1.5 low-sun`, `22 golden`, `42 day`, and the `day` stop reproduces the shipped shader's colours, so the default frame is the frame the project already had. The default *clock* is solar noon at the world's own longitude (06:49 UTC at 77.7°E, 84.5° elevation) rather than a fixed UTC hour, because a runtime that starts at local noon everywhere is the only default that needs no per-coordinate tuning. `sunrise` was renamed **`low-sun`**: the same low elevation happens at dawn and dusk, so a phase name that asserted a time of day would be wrong half the time it was used.

**The budget is a property of the binding, not a policy someone has to keep.** `bindTimeOfDayUniforms()` points the sky's uniforms **at the state's own `THREE.Color`/`Vector3` instances**, so applying a state is `markApplied()` and copies nothing; `update(delta, nowMs)` returns whether a write is *earned* (per-profile ceiling — low `10 Hz`, balanced `15`, high `30` — plus "on change" with an epsilon on the phase, elevation, every colour, the exposure and the star term, plus a stall coalescer). Night costs **no extra draw call and no texture**: stars are a hashed direction field and the moon a disc plus halo in the same fragment pass.

| Node check | Result |
|---|---|
| solar geography | pass: the sun is up in local day, down in local night, and the equinoctial noon elevation at the equator is 90° |
| **the phase cannot contradict the sun, at any minute** | pass: 1440 samples, every phase id consistent with its elevation band |
| **night stays readable, measured rather than asserted** | pass: `groundLuminance ≥ GDO_NIGHT_LUMINANCE_FLOOR` (0.030) across the whole cycle, with a monotonic dusk fade |
| **uniform writes are bounded, and a still clock writes nothing** | pass: per-second counts against the profile ceiling, a 60 s stall coalesced, a frozen clock at zero |
| **a steady applied frame allocates nothing at all** | pass: 2000-frame **structural identity** of the state graph (state plus 12 nested instances) and 5 × 20 000-frame windows against a **retained-state positive control** (control > 20 B/frame required, steady < control/4) |
| uniform binding is by reference | pass: the uniform's value *is* the state's instance, so applying a state cannot allocate |
| the shipped daylight look is preserved | pass: the `day` stop's colours equal the shipped shader's |
| lifecycle reset | pass: counters and state cleared together |

**Browser tier — `npm run visual:audit -- time-of-day`, exit 0 (2026-10-07).** This is the tier that found the fourth defect, and the one that makes "readable night" a *pixel* claim rather than a model claim: the scenario renders and reads the WebGL buffer, so a night that only *says* it is readable fails.

| Check | Result |
|---|---|
| bounded writes, live | pass: a frozen clock wrote **0** uniforms over 60 frames; a 600 min/s clock wrote **13** in 5.1 s inside the 10/s ceiling (per second `[2, 3, 3, 4]`); the renderer runs at ≈3 fps on SwiftShader, so the ceiling is *also* driven synthetically through the same instance at 60 fps — **30 writes over 3 s against 10/s**, exactly the ceiling |
| no per-frame allocation, live | pass: state, 6 nested objects and the uniform binding are the same instances after 100 frames |
| **readable night, from the pixels** | pass: noon luma `0.657`, visible `100%` → night luma `0.097`, visible `66.3%`, max luma `0.52`, red/blue `0.82`; night must be darker than day, keep ≥ 40% of the day's legible coverage and stay above an absolute floor |
| the light rig follows the state | pass: the scene's directional light is read back on the state's own direction, alignment `1.0000` |
| the review surface | pass: `time 18:00 UTC · phase night · sun −36.3° · light 0.30 · stars 1.00 · exposure 1.28 · writes 42 · ceil 10Hz` |
| the curated runtime | pass: reaches night (sun −44.7°, stars 1.00) and its environment map is rebuilt **0 times** during capture — once per *phase*, not per frame |
| `AGENTS.md` item 6 | pass: the night state winds the ambient budget down through `world.setAmbientActivity` (1 → 0.35) — a budget change, not a second animation path |

**Five negative controls, each measured (all exit 1).**

| Break | Observed failure |
|---|---|
| the uniform rate ceiling removed | `180 writes over 180 frames (60.0/s against 10/s)` |
| change detection removed | `a frozen clock wrote 11 uniforms over 60 frames; "on change" means zero` — and the first run of this control **passed**, because the failure was collected into an array no verdict read |
| the night loses its moon and most of its ambient term | `night keeps only 20.5% legible coverage against the day's 100.0%` — the first thresholds passed this, which is why readability is now relative |
| the uniforms bound by value instead of by reference | `uniforms bound by reference false` |
| the review-surface marker renamed (`clock …`) | `the review panel has no \`time\` line` |

**Recorded gaps, stated rather than implied.** (1) The synthetic 60 fps drive is what reaches the ceiling: the SwiftShader renderer runs at ≈3 fps, so the live loop is bounded by its frame rate first — the live half therefore proves the *frozen* half (zero writes) and the synthetic half proves the ceiling, and the gate says so in its own log rather than implying the live loop reached 10 Hz. (2) Cloud cover is a uniform but has no visual assertion; the shipped shader's banded coverage is preserved at the `day` stop, and a cloud-coverage gate belongs with `ENV-04`'s weather rather than here.

---

#### A4j. `GME-06` — Discovery journal *(coordinate, with the curated runtime beside it)*

| | |
|---|---|
| **Roadmap** | Order 135, P1, **`ADDED` — closed 2026-10-07** (was `QUEUED`), depends on `GME-04`, `GME-05`, `FND-06` (all `ADDED`) |
| **Gate** | Deterministic place IDs and bounded local state |
| **Scenario** | `npm run visual:audit -- discovery-journal --url http://localhost:5173/` |
| **Node tier** | `src/engine/DiscoveryJournal.test.js` (8 tests, part of `npm run check`, now **254 tests**) |

**★ CLOSED 2026-10-07 — status `ADDED`.** The two clauses are properties, and the two tiers are not equally strong on each — the record says which is which rather than implying both are proven everywhere.

**What ships — `src/engine/DiscoveryJournal.js`.** A place's id is a pure function of its **name, kind and a 100-unit cell**, never of insertion order, tile iteration or walk order, so the same street yields the same id in a second session, after a tile rebuild, and in a save file that `NET-01` has not written yet. Names are case- and whitespace-folded because providers disagree about both for the same street. The state is **preallocated**: fixed arrays plus `Map` indices sized to `capacity` (128), so a player who crosses the whole map holds what a player who crosses two tiles holds, and `update()` is bounded by the candidate list the runtime supplies — the labels it is already showing — rather than by the size of the world.

| Node check | Result |
|---|---|
| the id is a pure function of the place | pass: stable across calls, folded case/whitespace, kind and cell participate, survives `JSON` round trip, shape `kind:slug:hash8` |
| **a rebuilt anchor is the same place, recorded once** | pass — this is the defect the first version had: a 0.5-unit quantum changed the id under a 0.2-unit shift (rounding flips at every edge), so a rebuilt tile would have logged a second discovery |
| two sessions, either walk order, same journal | pass: identical ids, names, kinds and anchors |
| **capacity is a hard bound and the bytes never grow** | pass: 4000 discoveries into 16 slots, size `≤ capacity` after **every** offer, bytes unmoved, `discovered − evicted === size`, every candidate accounted for exactly once; with equal clocks the **same ids survive either arrival order** |
| the radius, the kinds and the clock | pass: the boundary is inclusive, per-place radius overrides the kind default, the clock is monotonic, entries carry the reading they were found at |
| a malformed place is refused without taking the journal down | pass: counted and reported, the pass continues |
| work is bounded by the candidate list | pass: 5000 candidates land inside capacity with no reallocation, and a second identical pass is **quiet** (nothing rediscovered, nothing announced) |
| lifecycle | pass: entries, counters and clock clear together, the storage does not move, and the journal still works afterwards |

**Browser tier — `npm run visual:audit -- discovery-journal`, exit 0 (2026-10-07).** The wiring claim is measured first and deliberately **not** simulated: the scenario teleports the player onto a resident label and then only watches, so a runtime that does not feed the journal cannot pass.

| Check | Result |
|---|---|
| **the runtime discovers on its own frame loop** | pass: standing on a real label (`Fixture Nagar`) produces a discovery with no probe driving it |
| **the runtime offers the places the radius reaches** | pass: standing on a shown name, the runtime reports the resident labels inside the unlock radius (`discoverablePlaces`) — the surface the journal reads, which is deliberately **not** the 14 names the HUD chose to draw |
| **determinism across sessions** | pass: the same place yields `place:fixture-nagar:50c11560` after a full reload |
| the ids held are the ids the function computes | pass: the gate imports the runtime's own module **in-page** (the dev server's module graph is by URL, so it is the same source) and recomputes every held id; a second offer of the same place adds nothing |
| bounded state over the real corpus | pass: 11 real places through the runtime's journal — bytes `6656 → 6656`, size `≤ capacity`, books balanced; a capacity-5 journal over the same 11 real places fills to exactly `5`, and two journals fed in opposite orders retain the **same ids** |
| the review surface | pass: `places 1/128 · discovered 1 · declined 0 · evicted 0 · last Fixture Nagar` |
| the curated runtime | pass: two named places (`Gateway`, `Chariot`), and walking into the Gateway records it as a landmark with a landmark id |

**Five negative controls, each measured (all exit 1).**

| Break | Observed failure |
|---|---|
| the id made a function of `Math.random()` | `the same place produced two ids across sessions` + `the journal holds ids the id function does not compute` |
| the frame loop stops feeding the journal | `the journal does not hold the place the player walked into` |
| eviction leaks its slot | `a journal of capacity 5 reached size 8` |
| displacement made unconditional again | `two journals over the same places in opposite orders retained different ids` |
| the review-surface marker renamed (`sites …`) | `the review panel has no \`places\` line` |

**A defect the regression sweep found, and what it changed.** The scenario passed on its own twice and then failed inside a full sweep: *a reloaded session did not record the same place*. The cause was not in the journal but in the wiring — the journal was fed the **labels the HUD was displaying**, and the label layer shows at most 14 names chosen by static map priority, so a place could be undiscoverable whenever fourteen higher-priority names were on screen, and *which* fourteen depended on streaming timing. The fix is the one the research actually describes (*"enter a … radius to unlock it"*): the runtime now gathers the **resident** labels inside `GEO_DISCOVERY_MAX_RADIUS` (`world.tiles` → `tile.labels`, a reused array, one distance test per resident label four times a second) and the journal applies its per-kind radius to those. Discovery is a radius test, not a HUD test. This is worth recording as the reason the sweep exists: a gate that passes twice in isolation and fails in the suite was measuring streaming timing rather than the contract. It is also why the run summary now prints the first session's id and `matched`/`NO` for the second rather than reporting success whenever the first half had succeeded.

**A control that passed, and why that is in the record.** The first control written for the order-dependence defect flipped the **id tie-break direction** and the gate still exited 0 — because the direction is not what makes the retained set canonical; the *decline* rule is. The gate's assertion was therefore already sound and the control was wrong, which is worth recording: a control that passes is evidence about the control, and the gate's own claim was re-derived from it rather than trusted.

**Recorded gaps, stated rather than implied.** (0) The controls were run against this gate's final code paths: the capacity, order-dependence and wiring controls were re-run after the resident-radius change, and the randomised-id and panel-marker controls were run against code paths that change did not touch. (1) The capacity half is only partly exercised in the browser: the fixture world exposes 11 named places, so the shipped capacity of 128 is never reached there and the capacity-5 trial over those 11 real places is what the browser proves. Filling 128 slots and the 5000-offer eviction behaviour are the Node tier's. (2) Nothing persists: `saveSchema` stays `0` because writing the journal to storage is `NET-01`, and a second storage format here would be the duplication the roadmap keeps splitting apart. (3) The journal records *places*, not visits — a street walked five times is one discovery — and the record should not be read as a visit log.

---

#### A4l. `ENV-04` — Weather state machine *(coordinate, with the curated runtime beside it)*

| | | |
|---|---|---|
| **Roadmap** | Order 113, P1, **`ADDED` — closed 2026-10-07** (was `QUEUED`), depends on `ENV-02`, `TER-07` (both `ADDED`) |
| **Gate** | Deterministic transitions, environment response, low-profile fallback |
| **Scenario** | `npm run visual:audit -- weather-state --url http://localhost:5173/` |
| **Node tier** | `src/engine/WeatherState.test.js` (11 tests, part of `npm run check`, now **273 tests**) |
| **Research** | Biome §9.2 (the eight-state table, and *"deterministic from macro climate + month + world-time window + coordinate weather seed … transition over time rather than roll independently each frame"*), §9.4 (*"never combine heavy rain, fog particles, insects, pollen, and dust simultaneously"*), §14 (*environment uniform updates: on change / ≤ 10 Hz / ≤ 15 Hz / ≤ 30 Hz*); World §4.6 (*"seeded Markov/state schedule by biome and world time; no live API dependency"*, *"shared weather uniform darkens roads/soil and increases water ripples"*, *"humidity, dust, altitude, and time control fog range/colour"*) |

**★ CLOSED 2026-10-07 — status `ADDED`.** The three clauses are independent claims, and the tier that decides each is named rather than implied: determinism is a *two-session* claim settled in the browser, the response is a *pixel and read-back* claim settled in the browser, and the fallback is a *structural* claim settled in both.

**What ships — `src/engine/WeatherState.js`.** Eight states, each a row of fifteen response fields (`cloudCover`, `cloudDarkness`, `lightScale`, `hemisphereScale`, `exposureBias`, `fogDensity`, `fogTint`, `fogWarmth`, `fogLightness`, `wetness`, `ripple`, `cloudSpeed`, `birdActivity`, `beeActivity`, `particleIntensity`). The macro climate is a band of absolute latitude and a season: `tropical` (< 12°), `monsoon` (< 22°, and < 33° in months 7–9), `semi-arid`, `temperate` (< 50°) and `cold`. Each climate is a weight vector over the eight states in which **zero is a prohibition** — the Node gate sweeps a year of windows of every climate and requires the states produced to be exactly the states weighted, so no weight is decorative and no prohibition is merely unlikely. Transitions are an 8 × 8 Markov table scored by `markov[from][to] × climate[to]` and row-normalised at pick time, so a storm decays rain-ward, dust arrives from haze, and snow persists. The seed is the coordinate: FNV-1a over `provider|lat|lon` at three decimal places, then a `Math.imul` hash per (day, window, step).

**The schedule is random-accessible, and that is the determinism argument.** A day is anchored once and walked at most fifteen Markov steps, so `weatherStateIndexAt(seed, climate, 900)` answers directly; the gate checks that against a walk, and replaces `Math.random` with a thrower for the duration, because reproducibility is the property that cannot be verified by reading the source. The browser tier proves the property that matters in the product: it **re-navigates** to the same coordinate and requires the same seed, the same climate, the same state and the same fifteen response fields, then compares the runtime's own schedule window by window against the module's sampler.

**Transitions happen over time.** The state at a window is discrete; the response cross-fades linearly across the first `GDO_WEATHER_TRANSITION_MINUTES = 18` of each `GDO_WEATHER_WINDOW_MINUTES = 90` window, and the state names where it is *going* once the fade is more than half done. Continuity is therefore a bound stated in the clock — the browser tier samples a whole day in five-minute steps and fails a field that moves further than a cross-fade step allows (measured worst `0.2500` on `fogTint` against a `0.4167` bound, with 10 state changes in the day) — and it is proven *across the day boundary* specifically, because that is where a per-day schedule is most likely to cut: the last window of a day fades into the next day's anchor, and 23:55 → 00:00 moves no field at all (`0.0000`).

**The response is absolute, and `clear` is the identity.** Applying a state writes composed values rather than deltas (`lightIntensity × lightScale`, `fogColor × tint`, `clamp(exposure + bias, .2, 3)`), so the two integrations can run in either order and a repeated apply cannot compound. `clear` is every scale at 1 and every additive term at 0, and the gate requires it to be the pre-weather frame **bit for bit**: the dome carries the hour's own cloud cover, the water is unwet, the fog range is the runtime's shipped `78 / 175`, the fog colour is the hour's colour to `0.0e+0`, and the sun is the hour's own intensity. Node asserts the composition's `===` equality across a whole day; the browser re-measures it from the live scene.

| Node check | Result |
|---|---|
| random access equals the walk; `Math.random` cannot be consulted | pass: window 900 answered directly equals the walk, and a throwing `Math.random` changes nothing |
| the schedule is a function of seed, climate **and** day | pass: 32-window sequences differ for a neighbouring seed, a different climate and the next day |
| the climate's prohibitions hold over a year | pass: every state a climate produces is weighted, and every state it weights is produced; snow is unreachable in the semi-arid band at any window of any year |
| transitions are continuous, midnight included | pass: the worst five-minute field move is inside a fade step, and the day boundary moves nothing (`0.0000`) |
| `clear` is the identity | pass: `composedGroundLuminance(state, clear) === state.groundLuminance` across 1440 minutes |
| night stays readable under every state | pass: a year × clock × state sweep keeps `0.5466` of the unweathered luminance against a declared `0.52`; a starved state **fails** the floor, so the bound has teeth |
| the low profile can express every state without particles | pass: all 28 pairs differ on the uniform response alone |
| the apply path writes uniforms, lights and materials only | pass: no scene object, no draw call, and the composed values are absolute |
| bounded writes | pass: a frozen clock writes 0 over 60 frames, a jump costs one write, a 30-second moving clock stays inside the ceiling |
| bad inputs | pass: profiles, climates, seeds, clocks, days, coordinates, windows and uniform handles are refused by name |

**Browser tier — `npm run visual:audit -- weather-state`, exit 0 (2026-10-07).** This is the tier that found the three defects in the feature, and the one that makes "environment response" a claim about the *renderer* rather than about the model.

| Check | Result |
|---|---|
| the seeded schedule across sessions | pass: seed **3117801742** equals the module's own hash of the coordinate, climate `semi-arid` is what the latitude and the season imply, and a second session at clock 613 gives `clear` at window 2758 with identical response fields |
| the runtime follows the module | pass: all 16 windows of the runtime's schedule agree with the module's sampler, window index included; a day of the schedule reads `clear mist mist clear clear overcast overcast clear clear clear clear haze haze clear clear clear …` |
| continuity and the day boundary | pass: worst `0.2500` on `fogTint` in five minutes against a `0.4167` bound, 10 changes a day; 23:55 `clear` → 00:00 next day `clear`, worst field move `0.0000` |
| bounded writes, live | pass: a frozen clock wrote **0** weather and **0** time-of-day uniforms over 60 frames; a synthetic 60 fps drive (one world minute per frame, 720 frames = twelve world hours) spent **33** writes, busiest second **4** against the 10 Hz ceiling, 120 coalesced, 27 window transitions; a 400 → 1000 minute jump cost **1** write and the next update was refused |
| the eight states, at one clock | pass: every state driven through the runtime and read back from the dome, the water, the fog, the sun, the exposure and the pixels — `clear` 0.38/0.00, water 0·0, fog 78·175, sun 3.20, exposure 1.05, luma 0.493; `haze` 0.43/0.08, 59·126, 3.04, luma 0.488; `overcast` 0.73/0.42, 72·159, 2.30, 0.458; `rain` 0.88/0.62, 0.80·0.85, 61·132, 1.92, 0.429; `storm` 1.00/0.82, 1.00·1.00, 54·115, 1.66, 1.11, 0.403; `dust` 0.63/0.30, 52·110, 1.98, 1.03, 0.428; `snow` 0.93/0.34, 57·121, 2.24, 1.15, 0.480; `mist` 0.53/0.20, 42·83, 2.24, 1.09, 0.453 |
| every state is visible on the low profile | pass: **28** pairs compared on the uniform response (cover, darkness, ripple, wetness, fog near, fog far, sun, exposure) with every pair distinct, and `clear` identical to the hour |
| a storm cannot brighten a night | pass: the hour's fog `0.220/0.420/0.520` times a warm tint stays below it in every channel — worst excess `−0.1214` against the hour × 1.13 |
| cloud drift is a motion budget | pass: over 20 frames of a *moving* clock a storm advances `uSkyTime` by `0.00910`–`0.00991` and `clear` by `0.00017`–`0.00037` across the recorded runs; on a frozen clock both are `0` (the absolute value moves a little with the wall clock, which is stated rather than smoothed over) |
| the habitat response rides the ambient budget | pass: at an unchanged phase budget of **1**, clear draws **7** agents and a storm **2**, with the shares moving from bird `1.00`/bee `1.00` to `0.10`/`0.05` |
| the fallback is uniform-only | pass: the low profile declares **0** particle families and cap **0**, and the scene's child count is **6** for all eight states — no state adds an object |
| the review surface | pass: `weather Storm | monsoon | window 2756 | blend 1.00 rain→storm | next storm | cloud 0.62/0.82 | wet 1.00 ripple 1.00 | fog 0.55 | life 0.10/0.05 | writes 47 · ceil 10Hz · particles 0` (the write counter is live, so this value is run-to-run; the scenario matches the line by regex rather than by value) |
| the curated runtime | pass: the same machine and the same vocabulary — a storm drives its water normal scale `0.550 → 0.880`, roughness `0.420 → 0.360`, fog `88/185 → 61/122` sun `3.20 → 1.66` and frame luma `0.648 → 0.548` (a thousandth or two of run-to-run jitter, because the frame carries moving ambient life), while `clear` leaves each at its base |

**Negative controls (10, all exit 1, each restored and `diff`-verified).**

| Break | Observed failure |
|---|---|
| the coordinate seed becomes random | `the runtime's weather seed … is not the module's hash of the coordinate` and `a second session produced a different seed at the same coordinate` |
| change detection removed | `a frozen clock wrote 22 weather uniforms over 60 frames; "on change" means zero` and `the sky drift uniform moved 0.00283 on a frozen clock` |
| cloud darkness never written | `a storm's cloud darkness is only 0.00` and `a storm sky (luma 0.450) is not darker than clear (0.424)` |
| `clear` given a cloud cover of its own | `clear is not the identity: cloud cover 0.6799999999999999 is not the hour's own 0.38` |
| the species shares ignored | `a storm drew 7 agents against clear's 7, so the weather does not reach the ambience` |
| the low profile given particle families | `state clear ran 2 particle families against a low profile that allows none` |
| the water's weather uniform never written | `a storm's water response is 0.00/0.00, which is not a storm` |
| the fog tint made absolute | `the storm fog is not a tint of the hour's fog colour (worst channel exceeds it by 0.1034)` |
| the season ignored in the climate *(Node)* | `not ok 3 — cities in the climate are the ones that climate may have: Meerut in September is the monsoon` |
| the cross-fade's endpoints interpolated *(Node)* | `not ok 2 — beeActivity must settle on the target state` |

**Three defects in the feature, and one in the gate itself.**

1. **The schedule's clock wrapped into a single day.** The first version resolved the window from `minutes` in `[0, 1440)`, so day *n*+1's morning was day *n*'s morning and midnight was a snap from one chain to another with no cross-fade — a per-boundary roll of the exact kind §9.2 forbids. Found by the continuity sweep (the wrap reported a `0.4500` move in five minutes on `fogWarmth`). Fixed by giving the schedule an unwrapped clock and an explicit day, taken in both runtimes from `TimeOfDay.dayOfYear`, so midnight is a window boundary like any other.
2. **Absolute weather colours brightened the night.** The first fog and cloud response wrote absolute values; at night a dust tint would have been *lighter* than the sky it obscured. Fixed to multiplicative tints and a shader-relative cloud tone, and the rule became a clause of the gate rather than a comment.
3. **The curated runtime's water never reacted.** `applyWeatherToWater`'s `MeshStandardMaterial` fallback read `userData.geoWaterRoughnessBase`, which nothing ever set — so one of the two runtimes silently took no surface response. Found by the curated half of the matrix (`0.420 → 0.420`); it now captures the material's own roughness on the first apply.
4. **A probe set the weather's clock behind the frame loop's back.** `GeoGame`'s loop re-reads the time-of-day clock every frame and pushes it into the weather, so a probe that only called `weather.setClock()` was overwritten before the next paint: three states measured as whatever the clock happened to be showing, which read exactly like "haze, overcast and dust have the same response". The scenario drives `setClockMinutes()` instead, which is also the honest statement of "the weather rides the clock the player's hour comes from".

**Recorded gaps, stated rather than implied.** (1) **No particles.** The research's §9.4 budgets (80 / 180 / 350) are kept beside the profiles and the low profile runs zero families; camera-local precipitation, dust strips and their screen/overdraw accounting belong to `ENV-05`, and this slice proves only that the states do not *need* them. (2) **No lightning, no wet-material darkening of roads or soil beyond the shared water uniform, and no frogs**: §9.2's Storm row wants intermittent flash and Rain wants roof-drip hints; both are effects work rather than state work. (3) **The rain/storm pair is the closest pair on the uniform response** (0.250 apart in the unit measure) — legible, but a reviewer who wants them further apart should change the state table, not the response code. (4) **No reduced-motion path yet.** The cloud drift this slice introduced moves only when the clock moves, and the shipped configuration pins the clock; suppressing it by preference is `GME-10`'s clause (*"prefers-reduced-motion … suppresses gust detail, particles, lightning flashes, and rapid cloud motion"*), which is now dependency-complete. (5) **The curated fixture's default sky is `overcast`** at its own clock, because 20.5°N in the monsoon band is that weather — recorded as a deliberate visual consequence of the season rule rather than as a regression. (6) **No frame-time claim**: the budgets are structural and the software renderer here runs at a few frames per second.

---

#### A4m. `NET-01` — Versioned local save *(both runtimes, across reloads)*

| | | |
|---|---|---|
| **Roadmap** | Order 170, P2, **`ADDED` — closed 2026-10-07** (was `QUEUED`), depends on `FND-06`, `GME-06`, `CNT-01` (all `ADDED`) |
| **Gate** | *Migration-safe settings/discovery/progress* |
| **Scenario** | `npm run visual:audit -- local-save --url http://localhost:5173/` — exit 0, 0 blockers, 2026-10-07 (two consecutive runs) |
| **Node tier** | `src/engine/SaveState.test.js` (13 tests, part of `npm run test`, now **286 tests**) |
| **Research** | World §4.7 (*"Local persistence \| IndexedDB record keyed by world-version + coordinate tile + discovery ID \| **Revisits retain progress** \| Low \| P1"*), §7 (the `≤ 8` persistent audio-layer cap the settings table is read against) |

**★ CLOSED 2026-10-07 — status `ADDED`.** The gate is four words, and each is a separate claim with a surface that can be wrong on its own: a **setting** that is written by one surface and not the other (or written and not read back as behaviour), a **discovery** that the runtime records but never persists, a **progress** record that respawns what it restored, and a **migration** path that reads a legacy file without upgrading it or trusts a file it cannot read. All four are measured on the document **in `localStorage`**, not on the live model, because the live model holds the change for up to a second before the write lands — and a reload is the only thing the gate actually cares about.

**What ships — `src/engine/SaveState.js`.** One key (`gdo:save`), one envelope (`schemaVersion`, `worldVersion`, `writtenAt`, `settings`, `discovery`, `progress`), one declared settings table (a fallback per field), one byte ceiling (64 KiB) and three count ceilings (`128` discoveries, `64` states, `64` collected per state — the last read from `STATE_CONTENT_LIMITS.collectiblesPerState`, so the document and the journal cannot disagree about what "full" means).

- **The declared table is the schema.** `SAVE_SETTING_FIELDS` is walked by both the validator and the ladder, so an undeclared key is a *problem* in a v1 document and a **drop with a note** in a legacy one, and a missing or wrong-typed key fails validation rather than silently taking a default. That is what makes the settings section migration-safe by construction rather than by a second list of checks.
- **Problems and warnings are different things**, as `CNT-01` established for content: a document written by **another generator build** loads with a warning (the build digest differs by construction), while a document from a **newer schema**, or one whose discovery ids do not match their own anchors, does not load at all.
- **The ladder is a ladder.** `SAVE_MIGRATIONS[0]` upgrades a pre-schema file: it reads `options`/`discovered` under their older names, re-derives every place id from its own name, kind and anchor (an id is a function of the place, so a stale id is *repair*, not invention), coerces `0`/`1`/`"0"`/`"1"` against the declared types, drops undeclared settings by name, dedupes collected ids and drops ids that cannot be instance ids — and every repair is reported as a note, which is what the gate reads.
- **Nothing unreadable is ever destroyed.** A refused document leaves the primary key exactly as it was found, copies the bytes to `gdo:save:unreadable`, and the runtime mounts with an empty document and a `lastProblem`. The writer refuses exactly what the reader refuses, and a refused write stays `dirty` so the next tick retries instead of dropping the change.
- **Writes are changes, not frames.** `tick()` writes only when the document changed *and* the interval elapsed (1 s); an over-ceiling document is trimmed **oldest-first** (discoveries first, then the oldest collectible of the heaviest state) with a note per drop, because refusing to save is worse than saving less.
- **The identity constraint that shaped both modules.** A stored `discoveredAt` is an *order* from another session's clock, not a time: every page load restarts the clock the journal reads. `restoreDiscovery` therefore rebases the whole section into the live clock's frame, ascending in the saved order and inside a millisecond above the reading the journal is on — and `DiscoveryJournal.restore()` no longer moves the journal's own clock. Without that, a restored reading from an earlier session (say `3254`) would look like a **backwards clock** to the next frame (`update()` refuses one by design), and the journal would throw on its first label refresh after a reload.

**Runtime wiring, both modes.** Coordinate: the store is created and read *before* the world is built, the journal is restored before the first frame, `tick()` runs in the frame loop, a changed journal is re-captured on the same 250 ms refresh that discovers it, `showDebug` is written by the one `toggleDebug` the button and `F3` both call, `progress.lastMode`/`lastCoordinate` are written once per mount, and disposal flushes. Curated: the same store, `items.restore(collectedInstances(progress))` removes exactly the instances a previous session took and adds their points back, a pickup rewrites `progress.states`, the mute button writes `soundEnabled`, and the audio preference is applied before anything plays. Landing: `lastSession()` reads the document directly and writes `Resume: last session at <lat>, <lon> (<mode>).` into `.odyssey-start-note` before any 3D loads — the no-3D proof that the document reached the shell.

**The audit surface the gate reads.** `__gdoAudit.game` gained `saveStore`, `save`, `saveDiagnostics`, `saveReport`, `saveRestore`, `saveNow()` and `clearSave()` in both runtimes, and the review panel's last line is `save v1 · <storage> · places N/128 · items M · writes W · B B`.

**Recorded run (2026-10-07, `local-save`, exit 0, 0 blockers).**

| Clause | Result |
|---|---|
| **settings** | `showDebug` written by the button (`false → true`) and by `F3` (`true → false → true`, registry `fired 0 → 1`), the file's stored setting moved in both directions, and the next session opened the panel **from the document** (`document says true · panel is true`) |
| **discovery** | `Fixture Nagar` found by the runtime's own loop, `713 B` written, reload `loaded true (v1 → v1) · restored 1 · journal 1 with 0 new find(s)`, the same id (`place:fixture-nagar:50c11560`) |
| **progress** | `vada-pav:0` (+10) collected and saved as `{"maharashtra":{"collected":["vada-pav:0"],"score":10}}`; reload `items restored 1 (missing []) · collected 1 + 10 point(s) · the instance is in the layout false · sound false` — the pickup is progress, not a respawn |
| **migration** | v0 → v1 `loaded true · migrated true`, journal `2` with the stale id re-derived (`water:nangal-sagar:deadbeef → water:nangal-sagar:8c220b28`), `soundEnabled 0 → false`, `showDebug 1 → true`, `nonsenseSetting` dropped, the duplicate collectible deduped (`8 notes`), storage **now v1**, and the next session `migrated false` |
| **refusal** | a `schemaVersion: 2` document and a truncated one both leave the runtime mounted, the journal empty, the settings at the declared fallbacks, and the bytes under `gdo:save:unreadable`; whatever the primary key holds afterwards validates |
| **boundedness** | `0` writes over `60` idle frames (`60` skip(s)), `10/10` ticks inside the interval coalesced, a change past it writes once (`3` total), the live frame loop `0` writes on `45` clean frames, and a 128-place document (`23 525 B`) trimmed oldest-first to `7 802 B` under a reduced ceiling keeping readings `88–127` with `88` drop notes |
| **the writer is the module** | `the stored document is the live document's own bytes: true` — the runtime's live document, re-encoded in-page through the module the runtime loaded, equals the bytes in storage |
| **one journal** | the curated runtime restored the coordinate runtime's place (`restored 1`), because there is one player and one journal |

**Negative controls — seven, each exit 1, each restored byte-identically afterwards.** (1) The review toggle stops writing → *"clicking the review panel did not move the stored setting to true"* (+ the F3 clause). (2) The frame loop never captures the journal into the document → *"the coordinate runtime never wrote a save"*. (3) `ItemManager.restore` returns without removing anything → *"the curated reload restored 0 collectible(s) against 1 in the document"*. (4) The ladder keeps a stored id instead of re-deriving it → *"the migrated journal holds 0 of the 2 entries the document carried"* (9 failures: a stale id is refused by the restore path, exactly as designed). (5) The ladder stops coercing `0`/`1` → *"the v0 sound setting of 0 was not repaired to false"* and the same for `showDebug`. (6) A future document is merged into this build's shape instead of refused → *"the refusal did not name the version"*. (7) The store ignores the write interval → *"a change inside the interval was written immediately (1 write(s))"*.

**One control passed, and the record keeps it.** Removing the ladder's `dirty = true` after a migration does **not** fail the gate: the runtime's own mount update marks the document dirty anyway, so the upgraded file is written back by the next tick. The flag is therefore belt-and-braces for a consumer that reads without writing; the *product* property the gate asserts (a v0 file becomes a v1 file) holds through the runtime either way. The control was rewritten to break the *repair* instead (control 4 above), which is the part that is only the ladder's.

**Recorded gaps, stated rather than implied.** (1) **The adapter is `localStorage`, not IndexedDB.** §4.7 names IndexedDB; the shipped adapter is a synchronous three-method store (`getItem`/`setItem`/`removeItem`) because both consumers need the settings applied *during* mount and the landing's resume runs before the first frame — an async adapter behind the same interface is the open step, not a defect in the gate. The size ceilings are the reason the synchronous path is safe (a document is bounded at 64 KiB). (2) **The `worldVersion` is a warning, not a gate clause.** A document from another generator build loads and says so; remapping a *stale world* (the same coordinate with different content) is not attempted, and no feature depends on it yet. (3) **The save does not carry the clock or the weather.** `ENV-04`'s schedule is random-accessible precisely so that a reload lands on the same weather without storing it; the same is true of `TimeOfDay`. (4) **Nothing resumes the *player's position*** — only `lastMode` and `lastCoordinate`, which is what the landing shell needs to re-enter the world. (5) **Appendices that could share this envelope** (`CNT-02`'s compiled recipes, `GME-08`'s objectives) are not in it; the section set is closed and validated, so adding one is a schema change with a ladder step. (6) **The id vocabulary split is deliberate and load-bearing**: content packs use underscores (`vada_pav`), runtime instance ids use hyphens (`vada-pav:0`), and `SAVE_INSTANCE_ID_PATTERN` accepts the hyphen on purpose — the save stores the runtime's own ids and the progress key is the item's `biome`, which both vocabularies agree on. Unifying the two is `CNT-02`/`CNT-04`'s problem, not the save's.

---

#### A4k. `DET-09` — Landmark grammar and openings *(curated runtime)*

| | |
|---|---|
| **Roadmap** | Order 098, P2, **`ADDED` — closed 2026-10-07** (was `QUEUED`), depends on `DET-02`, `DET-04`, `QLT-05` (all `ADDED`) |
| **Gate** | *Repeated modules batched; arches never use one enclosing AABB* |
| **Research** | Textures §17.2 (*visual boxes that create colliders automatically: 0*), §19.5 item 8 (one collider per wheel, spokes visual-only) and Clipping §15.8 item 34 (declarative modules with repeat kinds, and this gate's wording) |
| **Scenario** | `npm run visual:audit -- landmark-openings` — curated runtime, exit 0 (2026-10-07) |
| **Node tier** | `src/geo/GeoLandmarkGrammar.test.js` (8 tests) against `src/geo/GeoLandmarks.legacy.js` |

**★ CLOSED 2026-10-07 — status `ADDED`.** Both clauses in the gate's wording are claims that can be false while a screenshot still looks right, so both are measured rather than described, and the tier that measures them is the *running* runtime rather than a re-implementation of it.

**Why this mattered.** The Gateway and the Chariot were the only two structures whose **collision was written twice**: `gateway()`/`chariot()` stamped boxes into the chunk's `VoxelBatch`, and `createLandmarkCameraBlockers()` listed the same compound by hand as 34 `Box3`s. Nothing tied the two together, so tightening a pier or moving a voussoir could leave the camera clipping a wall that no longer existed — and the reverse: the gate's own wording exists because the cheapest way to stop a camera clipping a landmark is one big box, which is also the way to make the arch unwalkable. The research's answer (§15.8 item 34) is a grammar: declare modules with repeat kinds, derive collision from the drawing, and *forbid* a box from entering a declared opening.

**What ships — `src/geo/GeoLandmarkGrammar.js` (the compiler) and `src/geo/GeoLandmarks.js` (the two shipped landmarks).**

- **Modules, not loops.** A landmark is masses, repeats and accents. The repeat kinds are `grid`, `walk`, `arc`, `ring`, `stack` and `line`, and a `grid` may nest (`each`), which is what makes *four wheels of sixteen rim stones* one declaration: `grid{xOffsets, zOffsets} × each{arc count: 16}`. The compiler expands one outer **site** at a time and admits the whole site against the box budget or none of it, so a landmark can never be half-admitted.
- **Budgets, not hopes.** `GEO_LANDMARK_BOX_BUDGETS` is `low 120 / balanced 220 / high 400`; overflow drops by role — accents first, then surface, never silhouette — and every dropped box is counted (`budgetSkips`) rather than silently omitted. Both shipped landmarks fit the *low* budget with room (50 and 108 against 120) and drop nothing, which is what lets the coordinate profile and the curated runtime share one geometry.
- **Openings as profiles.** A void is a bottom, a depth and a **stack of bands** (`top`, `halfWidth`), because a real arch steps inward as it climbs: the Gateway's passage is 4.5 m half-width to 13.35, then 3.6, 2.95 and 2.3. `boxIntrudesIntoVoid` tests the box's y-range **band by band**, which is what lets the lintel sit legally above the head while a box sharing a band's height must keep clear of that band's width. The tolerance (`GEO_LANDMARK_VOID_TOLERANCE = 1e-4`) is applied horizontally **and vertically**, because the voussoirs are *defined* by the band edges — a stone whose lower face *is* a boundary overlaps it by 1e-15 in binary floating point, and an exact comparison silently dropped two stones of the shipped arch when the profile was first entered.
- **Collision derived from drawing, role by role.** A structural module yields one proxy per outer repeat site; the proxy may be declared larger than the drawing (the wheel's collision is the ring's circumscribed square, not the stone that happened to be drawn first); anything that is not structural contributes **no** collider at all — and an *accent* that declares collision is rejected at definition time rather than quietly ignored, so §17.2's *"visual boxes that create colliders automatically: 0"* is a rule the compiler enforces instead of a property someone has to check.
- **One material family, one draw.** `landmarkBatches` groups by the material key `VoxelBatch` itself instances by, and `stampLandmark` writes through any `box(x,y,z,sx,sy,sz,color,rotation,metalness)` sink, so the grammar never imports a renderer. The six roof tiers that used to be two interleaved loops are now one loop with a `colorCycle`, which keeps them one family *and* keeps six distinct proxy ids — the first port attempt ran them as two single-colour modules sharing one id template and produced duplicate `chariot:roof:0..2` ids.

**Browser tier — `npm run visual:audit -- landmark-openings`, exit 0 (2026-10-07).** The scenario recompiles both landmarks **inside the page** from the modules the runtime loaded (the dev server's module graph is keyed by URL, so this is the same source, the technique `GME-06`'s gate uses) and matches them against the live `game.scene` instance by instance:

- **Batched.** All **50** Gateway boxes and all **108** Chariot boxes are each found as instances of **1** `InstancedMesh` — the chunk's own mesh, which is the point: a landmark is not an extra draw, it is more instances of a draw the chunk was already making. Translation, scale *and* the per-instance colour must match (the palette is read as raw triples and converted with the renderer's own colour class, because `THREE.Color` has stored *linear* values since r152 and a hex comparison would compare two encodings).
- **Open.** The runtime's own `bridges.clipCamera` — the same call `Gameplay.test.js` makes — is **open** along the centre line through the arch at the live sweep radius (0.933) and **blocked** into the pier; the union of the same 18 blockers *would* cross that segment (`unionWouldBlock` true), which is what makes the tight compound a result rather than a coincidence; and the gate's clause is also stated as a property of the live list — **no single blocker contains the opening's whole free volume**.
- **The collider contains the drawing.** The wheel rim's reach is measured from the *drawn instances* as the radial support of the rotated stones (3.7 m), and the live blocker must contain it. This is the check that caught the port's own error: the first declaration was 7.3 m from the tangential half-width, 5 cm short of the 45° corners.
- **Ids are preserved because gates address them.** 34 landmark blockers (18 + 16), all ids distinct, `gateway:pier:-1` and `gateway:tower:-11:-4` among them — the port had to reproduce `pier:{side}` / `tower:{x}:{z}` (not `piers:`/`towers:`) and the chariot's historical `{ndz}` numbering, where the id indexes the descriptor offset (±5) rather than the drawn one (±6.5 / ±3.5, with two different multipliers).
- **Two controls run in the same process.** Pushing the pre-`DET-09` union box back into the live blocker list must close the arch (it does), and removing the Gateway's blockers must open the pier (so the pier result is caused by a pier, not by a runtime that blocks everything). The blocker list is verified back at 34 afterwards.

**Negative controls (6, all reproduced).** Node: the Gateway declaring no opening → 3 failures (the arch clause, the enclosing-mass refusal, the profile validation); the wheel collider back to 7.3 → `the wheel collider (3.65 m) must contain the drawn rim (3.700 m)`; the free width no longer ending at the arch head → the arch clause fails. Browser: `stampLandmark` emitting nothing → 6 failures (*only 0 of the Gateway's 50 boxes are in the scene*); `landmarkCameraBlockers` returning one enclosing AABB per landmark → the blocks-verdict and containment failures, with exactly the defect the gate forbids (*a single live blocker (`gateway:enclosing-aabb`) contains the whole opening*); every box given its own material family → *the Gateway's boxes are spread over 3 instanced draws · the Chariot's 108 boxes reach the renderer as 16 draws*. Each control's source was restored and `diff`-verified clean.

**A runner defect this gate's own controls found, again.** The first `landmark-openings` control run printed `[audit] FAIL` and **exited 0**: the new failure field was branched on and printed, but the branch omitted `process.exitCode = 1`. It is the same class of defect `QLT-06` recorded for `ambient-life` — a failure list the runner knows about but does not convert into a status — and it was found the same way, by running a control and checking the exit status rather than the log.

**Regression evidence.** `npm test` 262/262 (254 before this change; the 8 new tests are this gate's Node tier). `npm run visual:audit -- curated-camera` re-ran exit 0 with **0 penetrations** across all twelve sweeps, the arch still open / pier still blocked / union still crossing, and the `gateway-pier-compressed` review frame unchanged — the port had to be neutral for the gate that addresses these landmarks by id, and it is.

**Recorded gaps, stated rather than implied.** (0) The geometry-parity claim is **exact for boxes** — position, size, rotation and colour — and deliberately **not** exact for colliders: the wheel proxy went 7.0 → 7.4 because the shipped slab cut the drawn rim, so a consumer that depended on the old size would see a wider collider. No consumer does (the ids are what `curated-camera` addresses), but the difference is a deliberate change rather than parity, and it is recorded as one. (1) The Chariot declares **no** void, so the arch clause is exercised on one landmark only; the second landmark's contribution to this gate is the batching and collider-containment halves. (2) The `high` profile's 400-box budget is asserted in Node but **not** exercised in the browser, where both landmarks fit the low budget without dropping anything.

---

#### A5. `QLT-06` — TPP/FPP visual audit capture matrix *(the umbrella)*

| | |
|---|---|
| **Roadmap** | Order 015, P1, `DEFERRED`, depends on `COL-05`, `TER-04`, `MAT-03` |
| **Gate** | Moving screenshots/video at urban, rural, coast, wetland, mountain, and arid locations |

This is the general-purpose matrix the individual gates feed into. It remains gated behind `TER-04` (optional public elevation enrichment, itself `DEFERRED` on `MAP-09`), so it cannot fully close even with working capture — mountain/DEM scenarios need an elevation provider.

**Scenario lists defined by research:**

*`PROCEDURAL_WORLD_FEATURE_RESEARCH.md` §8 (8 scenarios):* dense North Indian city; sparse Indo-Gangetic settlement; western hot-arid settlement; tropical/coastal; wetland or river crossing; mountain with optional DEM; night/rain state; mobile portrait and landscape.
Per capture record: provider, biome, detail-family counts, worker timings, bytes, draws, triangles, frame CPU, errors, truncated passes.

*`VISUAL_BIOME_BEAUTIFICATION_RESEARCH.md` §15 (10 scenarios):* Meerut / Indo-Gangetic urban-agricultural mosaic; Rajasthan hot-arid town; tropical wet coast; mapped river/wetland; dense urban centre; forested mountain with optional DEM; high/cold environment; dawn/noon/sunset/night; clear/haze/rain/dust/snow where eligible; mobile portrait and landscape with reduced-motion comparison.
Use fixed coordinate, provider fixture, world version, date seed, camera pose, and weather override for before/after comparisons.

Note the overlap: six scenarios are common to both matrices. A single harness satisfying the union covers both.

---

### Group B — visual criteria attached to features already marked `ADDED`

These are the **systemic gap**. The features below passed their automated gates and were moved to `ADDED`, but their own research specs list visual acceptance criteria that have never been run. They are not tracked as blocking items in the roadmap matrix because the roadmap tracks each feature's stated *gate*, and for these features the stated gate was structural.

| Source | Criterion | Affected feature | Status |
|---|---|---|---|
| Textures §19.2 #4 | ≥3 large-plant silhouettes across a suitable 30 m walk, biome-appropriate family selection | `VEG-08` | Never run |
| Textures §19.2 #5 | Near/mid/far silhouettes retain family identity (umbrella, palm, conifer, bamboo) | `VEG-05` | Never run |
| Textures §19.2 #7 | Connected branches show no obvious cracks | `VEG-04` | Never run |
| Textures §19.2 #8 | Branch/crown self-intersections within declared overlap roles | `VEG-04` | Never run |
| Textures §19.3 #4 | Crop/grass rows align coherently; riparian plants correlate with water | `VEG-07/08` | Never run |
| Textures §19.4 #3 | One plant moves coherently; adjacent plants do not share an obvious identical phase | `VEG-09` | **Moot** — wind rejected as a default path 2026-10-03 |
| Textures §19.4 #4 | Wind does not open branch joints or move collision proxies | `VEG-09` | **Moot** — same |
| Textures §19.4 #5 | Reduced-motion retains a calm, readable world | `VEG-09` | **Moot** — default path has no wind to calm |
| Textures §19.5 #4 | Facade details fit wall slots, face outward, preserve entrances | `DET-04` | Never run |
| Textures §19.6 | Full performance + visual audit across 6 locations, 7 metrics per profile | all | Never run |
| Clipping §15.5 #1–3 | Roof details inside concave polygons/outside holes; facade modules attached and outward | `DET-04` | Never run |
| Clipping §15.6 #1–2 | Label behind a building hides within the LOS interval; LOS ignores grass/bird/bee proxies | `LAY-05`/`GME-04` | **Run 2026-10-05, pass** — see §4 A4g: an occluded pair found at `t=0.375` is hidden with `data-los="blocked"` while a clear name stays visible, and every label ray asks for `LOS_BLOCKER` alone |

The `VEG-09` wind items are now **moot**: on 2026-10-03 the owner rejected whole-plant wind as a default path because its per-vertex cost is not worth the effect. The default compiles no wind ALU at all, so there is no wind behaviour to review. The remaining Group B items are all *static* properties — silhouette family identity, branch cracks, clearance conformance, facade facing — and every one of them is observable in the offline fallback world, so none of them is blocked by anything except the work of running and reading the captures.

The good news: every one of these is offline-testable in the curated or fallback world except the riparian/facade ones, which need mapped data.

---

### Group C — visual gates on not-yet-implemented features

These will need a moving audit when built. Listed so the harness is designed to serve them rather than being rebuilt each time.

| ID | Feature | Visual gate |
|---|---|---|
| ~~`LAY-05`~~ | ~~DOM label line-of-sight~~ | **Delivered 2026-10-05** in the `GME-04` slice (§4 A4g) — struck from this list because it is no longer a not-yet-implemented feature |
| `LAY-06` | Camera-fade eligibility/dither | Opaque/alpha-tested screen-door fade; no broad blended foliage |
| `VEG-10` | Branch-group/detail wind | Up to 4 coherent phase groups; reduced-motion gate |
| `DET-06` | Rocks/geology grammar | Major-mass proxies only; small chips visual-only |
| `DET-07` | Vehicle grammar | Wheels/mirrors/lights must not expand body collision |
| `DET-08` | Bridge grammar and compounds | Traversable deck/rails/openings agree with visuals |
| ~~`DET-09`~~ | ~~Landmark grammar and openings~~ | **Delivered 2026-10-07** in its own slice (§4 A4k) — struck from this list on 2026-10-07, when the `DET-09` pass arrived at this table and found its own row still describing the gate as unbuilt |
| `DET-10` | Prop/food grammar and triggers | Interaction range separate from solid proxy |
| ~~`ENV-02`~~ | ~~Time-of-day light/sky state~~ | **Delivered 2026-10-07** in its own slice (§4 A4i) — struck from this list on 2026-10-07, when the run that closed it noticed the row was still describing an unimplemented feature |
| `ENV-03` | Water visual classes | Opaque/one-family low path and bounded blended higher path |
| ~~`ENV-04`~~ | ~~Weather state machine~~ | **Delivered 2026-10-07** in its own slice (§4 A4l) — struck from this list on 2026-10-07. Its three clauses are measured in two tiers: a second session at the same coordinate reproduces the seed, the climate and the whole schedule, midnight is continuous to `0.0000`, a frozen clock writes nothing while a synthetic 60 fps drive advances twelve world hours (720 world minutes) in 33 writes, all eight states were driven through the live runtime and read back from the dome, the water, the fog, the sun, the exposure and the pixels, and the low profile proves the response is uniform-only with zero particle families |
| `ENV-05` | Bounded weather/shore effects | Alpha-test/dither, strict screen/overdraw counts |
| `ENV-06` | Procedural ambient audio zones | Distance/activity caps (audible, not visual) |
| ~~`GME-04`~~ | ~~Place labels and coordinate HUD~~ | **Delivered 2026-10-05** in its own slice (§4 A4g) — struck from this list on 2026-10-06, when the `LIF-02` pass noticed the row was still describing a closed feature |
| `PHY-03` | Pose-fall knockdown | Visual/state-machine baseline before rigid bodies |

`ENV-02` through `ENV-05` are the largest coherent block and the biggest visible-quality gap in the project. **`ENV-02` and `ENV-04` are delivered (2026-10-07)** — the sun and the weather now share one clock, one state vocabulary and one budget; `ENV-03`, `ENV-05` and `ENV-06` are `QUEUED` and not started, and `ENV-05` still waits on `ENV-03` and `MAT-03`. The biome research's acceptance goal — *"a screenshot with UI hidden can distinguish at least six tested environmental combinations by palette and silhouette, not labels alone"* — is the target for that block.

---

## 5. Closing sequence

Dependency-correct order, split by whether a data prerequisite exists.

### Phase 1 — no data prerequisite (possible now)

0. ~~**`COL-09`** — capped dynamic spatial hash.~~ **CLOSED 2026-10-05** (see §4 A4c). Not a pixel gate: the caps, the primitive restriction, the reinsert discipline and the merged query contract are asserted, and one live run proves the wiring and that a placed solid changes a sweep that was first shown to be clear. Its five dependents (`DET-07`, `PHY-01`, `PHY-02`, `LIF-02`, `NET-02`) are now dependency-complete. The hash ships empty; none of them has placed a proxy yet.
0k. ~~**`NET-01`** — versioned local save, the entry point of the gameplay-state chain.~~ **CLOSED 2026-10-07** (see §4 A4m). Not a pixel gate, and the four words of its gate are four separate surfaces: **settings** (the review panel and the mute button each write their setting, the file's stored value moves in both directions, and the *next* session behaves it — the panel opens on mount, the audio graph is muted at mount), **discovery** (a place the runtime found by itself survives a reload with the same id, and the runtime's own module re-encodes the live document to exactly the bytes in storage), **progress** (a collected instance comes back as an id in the document and is **removed from the live layout** rather than respawned, with its points), and **migration-safe** (a v0 file is repaired — stale id re-derived, `0`/`1` settings coerced, duplicate collectible deduped — **and written back as v1**, while a file from a future schema or an unparseable one is refused with the runtime still mounting and the player's bytes copied aside). Boundedness is the counter-clause and is measured twice: 60 idle frames at 60 fps write nothing, and a change inside the write interval is coalesced (10 of 10) rather than written. Seven negative controls each exit 1, and **one control passed**: removing the ladder's `dirty = true` does not fail the gate, because the runtime's own mount update writes the upgraded file back anyway — recorded because it corrected the gate's own explanation of *why* a v0 file becomes a v1 file. Closing it made **`NET-02`** (multiplayer protocol decision) dependency-complete; `NET-03` still waits on `NET-02` and `MAP-07`.

0j. ~~**`ENV-04`** — weather state machine, the item `ENV-02` was closed to unblock.~~ **CLOSED 2026-10-07** (see §4 A4l). Three clauses, two tiers, and the one that decided each is named: determinism is a **two-session** claim (the run re-navigates and requires the same seed, climate, state and every response field, then compares the runtime's schedule against the module's own sampler), the response is a **read-back and pixel** claim (all eight states driven through the live runtime, read from the dome, the water, the fog, the sun, the exposure and the frame, with `clear` identical to the hour), and the fallback is **structural** (zero particle families, all 28 pairs distinct on the uniform response, no state adding a scene object). The gate found three defects in the feature — a schedule clock that wrapped into a single day, so midnight snapped instead of fading; absolute fog and cloud colours, which would have made a dusty night brighter than the sky it obscured; and a curated water fallback that read a baseline nothing ever captured, so one runtime took no surface response — and one in itself, a probe that set the weather's clock behind the frame loop's back and so measured three states as whatever the clock was showing. Ten negative controls each exit 1. Closing it made **`ENV-06`** and **`GME-10`** dependency-complete; **`ENV-05`** still waits on `ENV-03` and `MAT-03`.

0i. ~~**`DET-09`** — landmark grammar and openings, the entry point of the content chain.~~ **CLOSED 2026-10-07** (see §4 A4k). The smallest closure of the sequence — one direct dependent — and the one that opens a chain rather than a queue. Its gate is the only one so far whose two clauses are both about what the *renderer and the collider* were handed rather than about a displayed value, so both tiers measure the artifact: the compiled landmark is matched instance for instance against the live scene, and the runtime's own `clipCamera` is asked, not re-implemented. It found two real errors in the port itself (an opening whose free width did not end at the arch head; a wheel collider inherited from the tangential half-width that still cut the drawn rim) and one in the audit runner (`landmarkFailures` printed without setting `process.exitCode`, the same class `QLT-06` recorded for `ambient-life`). Closing it made **`CNT-02`** dependency-complete, so the content chain (`CNT-02` → `CNT-03` → `CNT-04`) now has its entry point.
0h. ~~**`GME-06`** — discovery journal, the largest remaining lever when it closed (5 in its closure, 2 direct).~~ **CLOSED 2026-10-07** (see §4 A4j). Not a pixel gate: determinism is measured across a reload and against the id function re-imported in-page, and boundedness is measured as bytes that do not move while the accounting identity holds. Five negative controls each exit 1, and the one control that *passed* is in the record because it corrected the gate's own explanation of why the property holds. The browser tier proves the determinism half end-to-end and the capacity half only as far as the fixture's 11 named places allow. Closing it made `NET-01` dependency-complete, which is the entry point of the gameplay-state chain (`NET-01` → `NET-02` → `NET-03` → `NET-04`).
0g. ~~**`ENV-02`** — time-of-day light/sky state, the item `LIF-02` was built to feed.~~ **CLOSED 2026-10-07** (see §4 A4i). Three clauses, three measurements: a frozen clock writes nothing while a moving one stays inside the profile ceiling (driven synthetically at 60 fps because the SwiftShader renderer runs at ≈3 fps), night readability is read from the **rendered pixels** rather than from the model, and the state object graph and uniform bindings are the same instances across frames. Four defects came out of the tiers themselves — a shared scratch return, an allocating closure in the per-frame sampler, a `setClock()` that did not re-sample, and a review-panel throw on a diagnostics field that did not exist — which is the case for gates being executed rather than written. Five negative controls each exit 1, and two of them forced real changes to the gate's thresholds. Closing it made `ENV-04` dependency-complete.
0f. ~~**`LIF-02`** — ambient-life scheduler and pools, which also closes **`LIF-01`**.~~ **CLOSED 2026-10-06** (see §4 A4h). Not a pixel gate, and deliberately not a counters gate either: the run reads the **renderer's own instance buffers** and counts how many instances actually moved in one pass, so the pre-`LIF-02` frame loop — reinstalled verbatim as the first negative control — fails at 58 moved against an allowance of 41. The gate found a real defect in the implementation it was written for: the first version bounded the per-frame *update rate* but not the number of agents *drawn*, so a resident set larger than the ceiling still drew every agent. Five negative controls (legacy walk, activity ignored, distance budget disabled, hide path disabled, panel marker renamed) each exit 1. Closing it made `LIF-03` dependency-complete; the `COL-09` hash still ships empty because ambient fauna do not collide.
0e. ~~**`GME-04`** — place labels and coordinate HUD, which also satisfies **`LAY-05`**.~~ **CLOSED 2026-10-05** (see §4 A4g). A real pixel-adjacent gate this time: the run *finds* a standing position with a wall strictly between the eye and a name, and then requires the layer to hide that label (`dom.hidden` plus `data-los="blocked"`) within the 250 ms update interval while a clear-ray name stays visible. Ray discipline is checked by intercepting the live call — every label sweep must ask for `LOS_BLOCKER` and nothing else — and the research's own budget (`20/s × 5` at the low profile) is measured over a wall-clock window. Four negative controls (occlusion disabled, wrong mask, wrong profile, panel line removed) each exit 1. Closing it made `GME-06`, `GME-07` and `MAT-06` dependency-complete, so the largest remaining lever is now `GME-06` (5 in its closure, 2 direct), with `LIF-02` (4, 4) and `ENV-02` (4, 1) immediately behind it.
0d. ~~**`CNT-01`** — versioned state-content schema.~~ **CLOSED 2026-10-05** (see §4 A4f). Not a pixel gate: the format is declared as a field table the validator walks, every error class is proven by a fixture that must produce it, legacy v0 migrates to a file deep-equal to the shipped v1 pack, and the browser tier proves the bytes served over HTTP are byte-identical (SHA-256) to the bytes validated on disk. Both shipped packs validate in both tiers. Recorded gap: no entry point mounts `StateManager`, so the validator ships zero bytes today — putting these packs on a live surface is `CNT-02`/`CNT-04`.
0c. ~~**`GME-05`** — shared interaction/action registry.~~ **CLOSED 2026-10-05** (see §4 A4e). Not a pixel gate: the registry's invariants, the input object's behaviour and the generated markup are asserted in Node, one source scan proves no module outside the registry names a gameplay key, and the browser tier drives both shipped runtimes' mounted controls with real pointer and key events on desktop **and** on a 390x844 touch viewport. Implementing it closed two real defects: the curated runtime had no touch controls at all, and touch buttons first rendered 15px tall on a phone. Its three waiting-only-on-it dependents (`DET-10`, `PHY-01`, `PHY-03`) are now dependency-complete.
0a. ~~**`FND-08`** — curated/coordinate domain interface.~~ **CLOSED 2026-10-05** (see §4 A4d). Not a pixel gate: the interface is asserted on both real runtimes in Node, and one shared probe drives both shipped runtimes in the browser tier. Its two direct dependents (`GME-05`, `CNT-01`) are now dependency-complete, and `GME-05` becomes the largest remaining lever at 14 items in its closure.
0b. ~~**`FND-07`** — zero-growth remount across all five resource classes.~~ **CLOSED 2026-10-04** (see §4 A4b). Dependency-complete and the largest transitive lever in the matrix: 20 open items depended on it. Its two fixes (named worker handlers removed before `terminate()`; landing input delegated from the persistent host) removed the only real disposal defects the measurement found. The one residual — dev-only React root retention — is registered as §6.F3 with the production measurement that bounds it.

1. ~~**`COL-06`** — curated camera obstruction.~~ **CLOSED 2026-10-03** (see §4 A2).
2. **`MAT-03`** (partial) — ~~ground/terrain shimmer capture~~ **capture delivered 2026-10-04, and it is inconclusive**: the metric cannot detect aliasing even with the entire anti-alias policy stripped, so it certifies nothing (see §4 A4). Remaining work is a real-GPU capture, or an owner decision to waive the shimmer criterion for trilinear-only selection.
3. **`VEG-05`/`VEG-04`/`VEG-07`/`VEG-08` static criteria** (Group B) — silhouette family identity, branch cracks, overlap roles, clearance conformance. Vegetation renders in the fallback world, so these are observable offline.
4. ~~`VEG-09` wind appearance~~ — moot; wind is rejected as a default path.

### Phase 2 — ~~requires the offline fixture provider~~ **provider delivered 2026-10-04** (see §6.F2)

5. ~~Build the fixture provider.~~ **DONE** — `src/geo/GeoFixtureTileEncoder.js` + `tools/fixture-provider/`, dev-only, verified absent from `dist/`.
6. ~~**`COL-05`** — orbit mapped buildings at min/max TPP distance.~~ **CLOSED 2026-10-04** (see §4 A1).
7. ~~**`LAY-03`** — four-tile corners, grazing angles, duplicate-blend check.~~ **CLOSED 2026-10-04** (see §4 A3). §10.1 near/far was **not** resolved — it needs the far-plane/fog comparison, not these frames.
8. **`MAT-03`** (completion) — road and facade shimmer with mapped detail present, on hardware, using the §4 A4 statistics.
9. **`DET-04`** facade-facing criteria (Group B) — now reachable; not yet run.

### Phase 3 — requires `TER-04`

10. **`QLT-06`** — full matrix including mountain and DEM scenarios.

### Phase 4 — unblocked by the above

11. **`MAT-05`** — ordered behind `MAT-03`.
12. **`DET-08`** — next dependency-complete object build; its gate ("traversable deck/rails/openings agree with visuals") needs the harness.

### Explicitly out of scope for this tooling

- Any FPS/frame-time claim on mobile or constrained hardware. SwiftShader runs at 3–10 FPS and is not a performance proxy.
- `MAT-03`'s shimmer sign-off itself: **no software metric here can decide shimmer at all**, so the verdict needs a real-GPU capture.
- **`F1`** (the `gdoPlantClearance` attribute-budget defect) is real and reproducible, but is a vegetation-slice change, not a visual gate.

---

## 6. Defect register

Defects found while working these gates. They are recorded here rather than in a gate's own section because they are not gate criteria — but each one is real, reproduced, and has a named owner route.

### F1. `gdoPlantClearance` exceeds the vertex attribute budget *(pre-existing, unfixed)*

**Symptom.** Coordinate mode logs, once per program:

```
THREE.WebGLProgram: Shader Error 0 - VALIDATE_STATUS false
Material Type: MeshStandardMaterial
Program Info Log: Too many attributes (gdoPlantClearance)
```

**Cause.** The plant pool geometry occupies **exactly 16** vertex attribute slots, which is the WebGL floor guarantee — matching the code's own documented intent ("Eight paired static streams + four instance-matrix columns + four custom instance streams exactly meet the WebGL minimum", `GDO_PLANT_VERTEX_ATTRIBUTE_LOCATIONS = 16`). Measured directly from the live pool geometry: 8 per-vertex streams (`position`, `normal`, `gdoPlantMeta0`, `gdoPlantLod0`, `gdoPlantPosition1`, `gdoPlantNormal1`, `gdoPlantMeta1`, `gdoPlantLod1`) + `instanceMatrix` (4 columns) + 4 instanced streams (`gdoPlantPalette`, `gdoPlantTraits`, `gdoPlantVariant`, `gdoPlantClearance`) = 16 against `MAX_VERTEX_ATTRIBS = 16`. SwiftShader's linker rejects a program sitting exactly on that boundary, naming the last attribute. The accounting is internally consistent; the design is simply wedged against the limit, so it is fragile on any driver that reserves a slot.

**Not caused by recent work.** Reproduced identically with the whole wind change stashed — see the verification below.

**Impact.** The plant `MeshStandardMaterial` never links in the affected profiles, so pooled plants do not render there. `COL-05` and `LAY-03` are unaffected (plants are neither camera blockers nor water), and the audit harness classifies this as a tracked-known defect rather than a gate failure — see `KNOWN_CONSOLE_DEFECTS` in `tools/visual-audit/harness.mjs`, which still prints it and writes it into every `report.json` rather than dropping it.

**Fix direction.** Reclaim one slot, e.g. pack the paired scalar LOD weights (`gdoPlantLod0`/`gdoPlantLod1`, each `itemSize 1`) into a single `vec2`, or drop them from the instanced geometry. Either touches the vegetation slice and needs its own feature-slice change with roadmap and changelog updates, so it is recorded rather than silently patched here.

**Reproduce the accounting** (`npm run dev` must be running):

```bash
node tools/visual-audit/diagnose-plant-attributes.mjs
# MAX_VERTEX_ATTRIBS = 16
# plant-pool:broadleaf:far ... total slots: 8 + 4 + 4 (instanceMatrix) = 16
```

It prints the per-vertex and instanced streams per pool plus the context limit, so a fix can be
verified as "comfortably under the limit" rather than "still exactly on it". A fix should leave
headroom, not merely move the number.

**Verify it is pre-existing:**

```bash
git stash push src/engine/PlantRenderPools.js src/engine/PlantRenderPools.test.js src/geo/Geo.test.js
npm run visual:audit -- water-order            # same "Too many attributes" error
git stash pop
```

### F2. The offline fixture provider *(the unblock, delivered 2026-10-04)*

This is no longer a blocker; it is recorded here because three gates referenced it by name.

`src/geo/GeoFixtureTileEncoder.js` encodes any `GEO_FIXTURE_MATRIX` entry into a spec-valid MVT protobuf. Because `GEO_FIXTURE_EXTENT = 4096` is identical to MVT's standard extent, encode→decode is geometrically exact, and the test suite asserts it: decoded fixture tiles drive `buildRoadGeometry`, `buildContextData`, and `buildBuildingGeometry` to output **byte-identical** to compiling the fixture directly, for all 7 entries and 8 id+variant cases.

`tools/fixture-provider/vite-plugin.mjs` serves that encoding at a same-origin URL and injects a provider entry into the `/map-providers.json` *response* — never onto disk. It declares `apply: 'serve'`, so it cannot participate in `vite build`. Verified: `dist/` contains **0** `.pbf` files, **0** references to `gdo-offline-fixture` or `fixture-tiles`, and `dist/map-providers.json` lists only the two real remote providers. `public/map-providers.json` on disk never lists the fixture, asserted by a regression test.

Canonical `.pbf` artefacts are also written to `public/fixture-tiles/` by `npm run fixture:tiles` for external inspection, and a test fails if they ever drift from a fresh encode. `public/` is copied verbatim by `vite build`, so `pruneFixtureTiles()` removes them from `dist/` explicitly.

---

### F3. Dev build retains discarded React root containers *(dev-only, measured, unfixed)*

**Symptom.** In the dev build, every curated mount creates a React root on a fresh overlay `<div>`; after `ui.unmount()` the div is detached but still reachable, carrying roughly **142** delegated subscriptions. `remount-lifecycle` counted `142 / 284 / 426` orphaned subscriptions after three mounts, and of the sampled discarded targets **4 of 4** survived a forced collection over CDP.

**Why it is not a product defect.** The production probe drives the same UI against the built bundle and collects **0 of 4** sampled targets, with live listeners flat at `3` and the document node count unchanged after every cycle. So the retention belongs to the development runtime (`react-dom`'s development build and the React Refresh runtime), and nothing ships to players. It is recorded rather than fixed because a fix is a design change, not a cleanup: it would mean holding one React root per page and re-rendering into it across remounts, changing the curated mount contract. That change should not ride along with the gate that discovered it — it needs its own slice and its own remount verification.

**Consequence and scope.** A long dev session that enters and leaves the curated world many times grows the dev heap by one container per mount. Player-facing cost: none measured. Gate impact: none — `remount-lifecycle` reports the retention as attributed framework behaviour instead of failing on it, and fails only on the app-owned classes.

**How it was found, and the near miss.** The instrument originally described orphaned targets as GC-reclaimable without checking. Forcing a collection is what turned an assumption into a finding: had the classification been trusted, a real dev-side retention pattern would have been documented as "collectable" — and had it been asserted as a failure, a dev-only framework behaviour would have blocked a gate the shipped product satisfies.

---

## 7. Evidence log

| Date | Check | Result |
|---|---|---|
| 2026-10-07 | `ENV-04` regression | `npm test` 273/273 (262 before, +11); the full 15-scenario sweep — **14 exit 0 with no `[audit] FAIL` line**, and `shimmer-low-dpr` exit 2, which is `MAT-03`'s recorded inconclusive rather than a regression. The environment neighbours re-ran clean beside it: `time-of-day` 52 s, `ambient-life` 11 s, `landmark-openings` 39 s, `discovery-journal` 45 s, `coordinate-camera` 145 s, `coordinate-matrix` 288 s |
| 2026-10-07 | `ENV-04` Node gate | `WeatherState.test.js` 11 tests pass (273 total, +11): random access equals the walk at window 900 with `Math.random` replaced by a thrower, a 32-window sequence is a function of the seed, the climate **and** the day, midnight is continuous to `0.0000` and the last window fades into the next day's anchor, every climate's zero weights are prohibitions honoured over a year of windows, `composedGroundLuminance(state, clear) === state.groundLuminance` across 1440 minutes, a year × clock × state sweep keeps `0.5466` of the unweathered luminance against a declared `0.52` (and a starved state fails the floor), all 28 low-profile pairs differ on the uniform response, the apply path writes uniforms/lights/materials and no scene object, a frozen clock writes 0 while a jump costs 1, and bad inputs are refused by name |
| 2026-10-07 | `ENV-04` browser gate | `weather-state` exit 0 with `blockers 0`, in both runtimes: seed **3117801742** equal to the module's hash of the coordinate, a second session reproducing seed, climate, state (`clear`, window 2758) and all 16 schedule windows, worst five-minute move `0.2500` on `fogTint` against a `0.4167` bound with 10 changes a day and `0.0000` across midnight, a frozen clock writing 0 over 60 frames while a synthetic 60 fps drive spends 33 writes over 720 frames (busiest second 4 against 10 Hz, 120 coalesced, 27 transitions, a jump costing exactly 1), the eight-state matrix read back live (`storm` 1.00/0.82 cover·darkness, water 1.00·1.00, fog 54·115, sun 1.66, exposure 1.11, luma 0.403 against `clear` 0.38/0.00, 0·0, 78·175, 3.20, 1.05, 0.493), all 28 pairs distinct, `clear` bit-identical to the hour (`0.0e+0`), the storm fog a tint (worst excess `−0.1214`), drift `+0.00991` over 20 moving frames and 0 frozen, the habitat response 7 → 2 agents at an unchanged budget of 1, 6 scene children throughout, the panel line `weather Clear | semi-arid | window 2756 | … | particles 0`, and the curated runtime driven to the same states (water normal 0.550 → 0.880, roughness 0.420 → 0.360, fog 88/185 → 61/122, sun 3.20 → 1.66, luma 0.648 → 0.548) |
| 2026-10-07 | `ENV-04` negative controls (10) | Random coordinate seed → *the runtime's weather seed … is not the module's hash* + *a second session produced a different seed*; change detection removed → *a frozen clock wrote 22 weather uniforms over 60 frames*; cloud darkness never written → *a storm's cloud darkness is only 0.00*; `clear` given a cover → *clear is not the identity: cloud cover 0.6799999999999999 is not the hour's own 0.38*; species shares ignored → *a storm drew 7 agents against clear's 7*; low profile given particles → *ran 2 particle families against a low profile that allows none*; water uniform never written → *a storm's water response is 0.00/0.00*; absolute fog tint → *the storm fog is not a tint of the hour's fog colour*. Node: the season ignored in the climate → `not ok 3`; the cross-fade's endpoints interpolated → `not ok 2 — beeActivity must settle on the target state`. Each restored and `diff`-verified |
| 2026-10-07 | `ENV-04` defects found by its own gate | Three in the feature (a schedule clock that wrapped into a single day, so midnight snapped with no cross-fade — a per-boundary roll §9.2 forbids; absolute fog/cloud colours that would have brightened a night; a curated water fallback reading a roughness baseline nothing ever set) and one in the probe (the weather clock set behind the frame loop's back, so three states measured as whatever the clock showed) |
| 2026-10-07 | `DET-09` Node gate | `GeoLandmarkGrammar.test.js` 8 tests pass: the port is geometry-neutral against a table captured by executing the pre-port loops (50 + 108 boxes, rotations and colours included), repeated modules carry the geometry (6 declarations → 20 sites, 96.1% and 98.1% repeated) and one material family is one instanced draw, the arches use no enclosing AABB (no proxy contains the opening, the passage is clear at 5.5 m and 10 m, the pier line and the arch head are not), an enclosing mass is refused and counted, accents never produce colliders, voids are banded profiles with a tolerance in both axes, budgets drop accents first and never silhouette, and the compiler is deterministic |
| 2026-10-07 | `DET-09` browser gate | `landmark-openings` exit 0 with `blockers 0`: 50/50 Gateway and 108/108 Chariot boxes matched as instances of **1** draw each from an in-page recompile, 34 landmark blockers (18 gateway + 16 chariot) with distinct ids matching the definitions, the runtime's `clipCamera` open through the arch (radius 0.933) and blocked into the pier while the union crosses the segment, no single blocker enclosing the opening, and the wheel collider 7.4 m against a drawn reach of 3.7 m; two in-run controls (union box closes the arch, pier opens without its blockers) behave |
| 2026-10-07 | `DET-09` negative controls (6) | Node: no declared opening → 3 failures; wheel collider back to 7.3 → *must contain the drawn rim (3.700 m)*; free width not ending at the head → arch clause fails. Browser: stamping disabled → 6 failures; one enclosing AABB per landmark → *a single live blocker contains the whole opening*; one family per box → *spread over 3* and *16 draws*. Each restored and `diff`-verified |
| 2026-10-07 | `DET-09` runner defect found by those controls | The first browser control printed `[audit] FAIL` and **exited 0** — the new failure branch omitted `process.exitCode = 1`. Same class as the `QLT-06` finding for `ambient-life`, found the same way (run a control, check the status, not the log) |
| 2026-10-07 | `DET-09` regression | `npm test` 262/262 (254 before, +8); `curated-camera` exit 0 with 0 penetrations across all twelve sweeps, arch open / pier blocked / union crossing unchanged, `gateway-pier-compressed` frame unchanged |
| 2026-10-06 | `LIF-02`/`LIF-01` Node gate | `GeoAmbientLife.test.js` 10 tests pass: profile ceilings agree with the research table, claim/release/cap with named rejections, distance and screen culls asserted from both directions, the activity budget winding a family down and back, both budgets hard, the no-scaling allocation property (8 vs 64 agents over 20,000 passes), the shipped motion formulas, the rebase round trip, and pose reuse/reset. Suite total `238 pass / 0 fail`, 126 modules |
| 2026-10-06 | `LIF-02` browser gate | `ambient-life` exit 0 with `blockers 0` (three consecutive identical runs): 58 agents resident on 4 tiles against a 30 ceiling, `drawn 17`, `poses/pass 17`, **`17 of 58` instances moved in one pass** (allowance 41, 0 orphaned), distance culls counted, `activity 0 → drawn 0` with 17 collapsed and restored to 17, panel `ambience profile:low active:58/64 visible:17 ceil:30 per-frame:24 culls d:293 s:0 a:101 poses:294 activity:1.00` |
| 2026-10-06 | `LIF-02` negative controls (5) | Pre-`LIF-02` unbounded walk → exit 1 (*58 of 58 moved, above the 41 allowed*); activity ignored → exit 1 (*activity 0 → drawn 17*); distance budget disabled → exit 1 (*no distance cull was ever counted*); hide path disabled → exit 1 (*collapsing 0 instance(s)*); panel marker renamed → exit 1 (*no `ambience` line*). Each restored and `diff`-verified clean before the commit |
| 2026-10-06 | Audit-runner defect found by those controls | The scenario's first failing run **exited 0**: `run.mjs` only converts failure lists it knows into a non-zero status. Added the `ambientFailures` branch and recorded the trap in `AGENTS.md` |
| 2026-10-06 | `LIF-02` regression sweep | `remount-lifecycle` (eviction/dispose changed), `label-los`, `content-schema`, `action-surfaces`, `domain-interface`, `water-order`, `curated-camera`, `coordinate-camera` and `coordinate-matrix` all exit 0 with the scheduler live |
| 2026-10-05 | `GME-04`/`LAY-05` Node gate | `GeoLabelLos.test.js` 8 tests pass: occlusion hides and a clear ray does not, `LOS_BLOCKER`-only masks, verdicts held for 250 ms, the 20/s and 5-label ceilings under a burst and a 60-second stall, clear/retire/reset behaviour, the world-style return-value contract, config rejection, and the bearing/distance geography. Suite total `228 pass / 0 fail`, 125 modules |
| 2026-10-05 | `GME-04`/`LAY-05` browser gate | `label-los` exit 0 with `blockers 0`: 11 committed labels, 44 obstructed standing positions (5 with the wall between), `Fixture Nagar` hidden at contact `t=0.375` with a fresh row (`blocked @134–163 ms`) and `data-los="blocked"`, `Grid Avenue 1` visible with a clear ray, 3–4 label sweeps with masks `[16]` only, panel `labels los:low 20/s max:5 …`, HUD `nearest Grid Avenue 1 30 m W` matching an independent recompute from the runtime's own coordinates |
| 2026-10-05 | `GME-04` negative controls (4) | Occlusion disabled → exit 1 (*no player-reachable label was hidden*); mask changed to `CAMERA_BLOCKER` → exit 1 (*label rays used masks 4*); profile `high` → exit 1 (*80/s × 14, not 20/s × 5*); overlay extras dropped → exit 1 (*panel line does not carry the profile, counters and blocker*). Each restored and re-verified clean before the commit |
| 2026-10-05 | `GME-04` regression sweep | `label-los`, `content-schema`, `action-surfaces`, `domain-interface`, `remount-lifecycle`, `curated-camera`, `coordinate-matrix` and `water-order` all exit 0 with the label layer live |
| 2026-10-05 | `FND-08` Node gate | `WorldDomain.test.js` 7 tests pass: both real runtimes satisfy the six members, one probe reaches the same semantics on each, the scale guard holds at a `10.000x` footprint ratio, and five negative controls fail as required. Suite total `189 pass / 0 fail` |
| 2026-10-05 | `FND-08` interface gate (dev, both runtimes) | `domain-interface` exit 0: curated `moveCircle` hit with `advanced 5.200` in 53 steps and `0.800` left to the rail, coordinates hit with `4.942` in 50 steps and `1.058` left to the proxy; both cameras blocked forward and clear on the control; interface reports complete for both |
| 2026-10-05 | `FND-08` scale guard | footprint ratio `10.000x` (documented 1:10), spacing ratio `33.333x`, sweep clamps `[.03,.04]` and `[.6,1.25]` disjoint. Both guard negative controls rejected |
| 2026-10-05 | `FND-08` traced transition regression | A buried or teleported body was lifted to the surface instead of falling, because a support-to-support step policy cannot see the body's own height. Caught by the curated gameplay test, fixed with the shipped `.6` proximity guard. `Gameplay.test.js` 8/8 |
| 2026-10-05 | `COL-05` re-run with the domain in place | `coordinate-matrix` exit 0: 480 frames across 5 fixtures, 0 penetrations, 688 exact-ring tests, 5 tracked-known `F1` console errors |
| 2026-10-05 | `COL-06` re-run with the curated player on the domain | `curated-camera` exit 0: 323 frames, 0 penetrations, Gateway arch compound preserved |
| 2026-10-05 | `LAY-03` / `FND-07` re-run | `water-order` exit 0 (24/24 stable); `remount-lifecycle` exit 0 with `zero growth: YES (0 leak(s))` |
| 2026-10-03 | `@sparticuz/chromium` install from npm only | 18 packages, 4s, 70 MB unpacked binary included |
| 2026-10-03 | `chromium --version` with bundled AL2023 libs | `Chromium 153.0.8010.0` |
| 2026-10-03 | WebGL 2.0 context under SwiftShader | Yes, ANGLE/Vulkan 1.3 SwiftShader, maxTex 8192 |
| 2026-10-03 | `readPixels` correctness | `[255,128,0,255]` for a 1.0/0.5/0.0 clear |
| 2026-10-03 | `fwidth` fragment shader compiles | Yes, no info log |
| 2026-10-03 | Full-page screenshot | Yes, PNG bytes returned |
| 2026-10-03 | Curated game boots and renders | 1 canvas 768×432, 39 calls, 22k tris, 36 chunks, **0 console errors** |
| 2026-10-03 | Curated auto-quality selection | Correctly selected **"Low power"** profile |
| 2026-10-03 | Coordinate mode with both providers unreachable | Bounded deterministic fallback: seeded terrain, specific error, attribution retained, debug overlay live, **0 console errors** |
| 2026-10-03 | Coordinate telemetry under fallback | 10 FPS, 0.2 ms CPU, 117 ms worst, 2 calls, 2k tris, 2 geo |
| 2026-10-03 | `COL-06` committed harness run | 590 blockers, 313 swept frames, **0 penetrations**, arch compound preserved, 0 console errors, `archPreserved: true` |
| 2026-10-03 | `COL-06` compression latency | Forced 180° yaw jump: 12 sampled frames, **0 penetrations** |
| 2026-10-03 | Gateway compound proof | 18-box gateway family; union box blocks the opening sweep, real compounds let it through while blocking the pier sweep |
| 2026-10-03 | Wind default path | No define set, no clock uniform bound or written, `windDisplacementMargin: 0`, `configureWind()` returns `false` |
| 2026-10-03 | Audit bridge containment | `grep -rl __gdoAudit dist/` returns nothing — tree-shaken from production |
| 2026-10-05 | `COL-09` profile caps | Filled each of `low`/`balanced`/`high` to exactly `64`/`128`/`256`; the next insert throws naming profile, cap and owner, with the population and the query result unchanged |
| 2026-10-05 | `COL-09` primitive-only rejection | Mesh, rendered object, nested compound, unknown name, zero/negative radius, inverted span, non-finite centre and an over-64-cell proxy each rejected by name |
| 2026-10-05 | `COL-09` steady state | `bytes` unchanged after filling all 64 slots; one candidate allocation across 500 queries; reinserts `0 → 1 → 3` across a slide, a long move and a return |
| 2026-10-05 | `COL-09` live diagnostic | `dense-urban` exit 0: lane clear on an empty hash, then `sweepCircle`/`sweepSphere` hit at `t=0.4188` by `diagnostic-car`; cap refusal at 64 without eviction; slot reuse with a fresh handle; static world byte-identical across add/remove |
| 2026-10-05 | `COL-09` regression | `coordinate-matrix` exit 0 (73 blockers, 0 penetrations) and `water-order` exit 0 (24/24 stable) with the merged dynamic query path live; `remount-lifecycle` exit 0 (zero growth) after `GeoWorld` gained a new owned resource |
| 2026-10-04 | `FND-07` worker disposal | Named handlers removed before `terminate()`; reverting the removal fails the gate with `worker subscriptions must be removed on dispose` |
| 2026-10-04 | `FND-07` landing input delegation | Registered once on the persistent host; curated start, coordinate submit, sample button (`28.9845/77.7064` + focus) and invalid-input rejection all re-verified |
| 2026-10-04 | `FND-07` remount gate (dev) | `remount-lifecycle` exit 0: coordinates `1w/2o/41l → 0w/0o/6l` (0 orphans); curated `0w/1o/167l → 0w/0o/7l`; `11/11`, `11/11`, `26/26` and `83/83`, `89/89`, `75/75` released, 0 outstanding |
| 2026-10-04 | `FND-07` remount gate (prod) | `probe-fnd07-production.mjs` exit 0: listeners `3` per cycle vs warm `3`, host `38` nodes, 0 canvases left, **0/4** discarded targets retained after forced GC |
| 2026-10-04 | `FND-07` Node gate | `ResourceLedger.test.js` 3 tests pass across 3 remounts; suite total `158 pass / 0 fail` |
| 2026-10-04 | MVT encoder round trip | 7 fixtures / 8 cases decode, and drive the production builders to byte-identical output |  
| 2026-10-04 | Offline fixture provider, dev | `GET /fixture-tiles/{z}/{x}/{y}.pbf` → 200, `application/x-protobuf`, correct fixture header; Coordinate Explorer renders **90 buildings, 204 details, 10 roads** from it with no network |
| 2026-10-04 | Fixture provider containment | `dist/`: 0 `.pbf` files, 0 fixture references; `dist/map-providers.json` lists only `openfreemap`, `openstreetmap` |
| 2026-10-04 | `COL-05` closure run | `coordinate-matrix`: 73 blockers, **480 swept frames**, **0 penetrations**, 675 exact-ring tests, 5 fixtures, 0 gate-relevant console errors |
| 2026-10-04 | `COL-05` compression latency | Forced clear→obstructed yaw jump at max distance: `8.000 → 3.108` (target `3.108`), `compressed=true`, `first-frame-legal=true` |
| 2026-10-04 | `LAY-03` order stability | **24/24** identical-input renders pixel-identical across 4 cardinals × 3 grazing pitches × 2 distances, `maxDelta = 0` |
| 2026-10-04 | `LAY-03` band ordering | `water@100` vs highest opaque band `1`; water blends after all opaque geometry |
| 2026-10-04 | `LAY-03` duplicate blending | `provider-equivalence`: `water` and `water_polygons` both resolve to 1 mesh / 2 triangles / 1 domain / 4 classes — identical, drawn once |
| 2026-10-04 | `LAY-03` blended foliage | 1 transparent material in scene (water only); non-water transparent materials: **0** |
| 2026-10-04 | `MAT-03` shimmer capture | Delivered at the production pixel-ratio floor `0.6`. **Gate not passed — the metric is blind**: production `0.4456` vs mips-disabled `0.4459` vs all-fades-stripped `0.4496`, with p99.9 pinned at `4.1` in every configuration (`1.000x` sensitivity). Scenario exits 2 (inconclusive) |
| 2026-10-04 | `MAT-03` withdrawn claim | The earlier `0.890×` figure was an artifact of an unpinned water-animation phase; with the phase pinned the ratio is `1.001×`. Do not cite `0.890×` |
| 2026-10-04 | Mip/texture policy | Trilinear mip selection is the accepted policy; anisotropic filtering is not used (owner decision, `README.md` §9) |

Committed harness output lands under `tools/visual-audit/out/` (git-ignored). The earlier scratch screenshots from the tooling-verification run were not committed.

**Reproduce `COL-06`:**

```bash
npm run dev                                    # terminal 1
npm run visual:audit -- curated-camera         # terminal 2
```

Then read `tools/visual-audit/out/<timestamp>-col06-curated-camera/report.json` and inspect the four PNG frames.

**Reproduce the 2026-10-04 coordinate gates** (all offline — the fixture provider needs no network):

```bash
npm run dev                                              # terminal 1
npm run visual:audit -- coordinate-matrix                 # COL-05 shape-family matrix
npm run visual:audit -- water-order                       # LAY-03 on mapped-coast
npm run visual:audit -- water-order --fixture provider-equivalence --variant shortbread
npm run visual:audit -- shimmer-low-dpr --fixture mapped-coast   # MAT-03 capture
```

---

## 8. Maintenance

- When a gate in this register closes, update the matrix status in [`README.md`](./README.md) and add a dated entry to [`CHANGELOG.md`](./CHANGELOG.md) in the same change — per the changelog rules, a visual gate closes only when the prescribed capture has actually been reviewed, not when the harness merely runs.
- Record rejected captures (scenario, quality profile, frame range, reason) so a flaky or inconclusive run is not mistaken for a pass.
- If a real browser/GPU is later available in CI, the harness should stay and simply gain a second, hardware backend; do not replace the software path, which is the only one that runs without a CDN.
