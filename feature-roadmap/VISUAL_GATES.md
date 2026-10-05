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

**Node tier — `src/engine/ContentSchema.test.js` (13 tests) + `src/engine/StateManager.test.js` (4 tests), part of `npm run check` (220 tests total).** The shipped files are the real fixture: they are read from disk, not mocked, so a schema that the project's own content fails is caught immediately.

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
| Clipping §15.6 #1–2 | Label behind a building hides within the LOS interval; LOS ignores grass/bird/bee proxies | `LAY-05`/`GME-04` | Blocked, `LAY-05` still `QUEUED` |

The `VEG-09` wind items are now **moot**: on 2026-10-03 the owner rejected whole-plant wind as a default path because its per-vertex cost is not worth the effect. The default compiles no wind ALU at all, so there is no wind behaviour to review. The remaining Group B items are all *static* properties — silhouette family identity, branch cracks, clearance conformance, facade facing — and every one of them is observable in the offline fallback world, so none of them is blocked by anything except the work of running and reading the captures.

The good news: every one of these is offline-testable in the curated or fallback world except the riparian/facade ones, which need mapped data.

---

### Group C — visual gates on not-yet-implemented features

These will need a moving audit when built. Listed so the harness is designed to serve them rather than being rebuilt each time.

| ID | Feature | Visual gate |
|---|---|---|
| `LAY-05` | DOM label line-of-sight | Sparse capped LOS hides labels behind blockers |
| `LAY-06` | Camera-fade eligibility/dither | Opaque/alpha-tested screen-door fade; no broad blended foliage |
| `VEG-10` | Branch-group/detail wind | Up to 4 coherent phase groups; reduced-motion gate |
| `DET-06` | Rocks/geology grammar | Major-mass proxies only; small chips visual-only |
| `DET-07` | Vehicle grammar | Wheels/mirrors/lights must not expand body collision |
| `DET-08` | Bridge grammar and compounds | Traversable deck/rails/openings agree with visuals |
| `DET-09` | Landmark grammar and openings | Repeated modules batched; arches never one enclosing AABB |
| `DET-10` | Prop/food grammar and triggers | Interaction range separate from solid proxy |
| `ENV-02` | Time-of-day light/sky state | Bounded uniform updates, readable night, no per-frame allocation |
| `ENV-03` | Water visual classes | Opaque/one-family low path and bounded blended higher path |
| `ENV-04` | Weather state machine | Deterministic transitions, low-profile fallback |
| `ENV-05` | Bounded weather/shore effects | Alpha-test/dither, strict screen/overdraw counts |
| `ENV-06` | Procedural ambient audio zones | Distance/activity caps (audible, not visual) |
| `GME-04` | Place labels and coordinate HUD | Projection/overlap; richer map |
| `PHY-03` | Pose-fall knockdown | Visual/state-machine baseline before rigid bodies |

`ENV-02` through `ENV-05` are the largest coherent block and the biggest visible-quality gap in the project. All are `QUEUED`; none are started. The biome research's acceptance goal — *"a screenshot with UI hidden can distinguish at least six tested environmental combinations by palette and silhouette, not labels alone"* — is the target for that block.

---

## 5. Closing sequence

Dependency-correct order, split by whether a data prerequisite exists.

### Phase 1 — no data prerequisite (possible now)

0. ~~**`COL-09`** — capped dynamic spatial hash.~~ **CLOSED 2026-10-05** (see §4 A4c). Not a pixel gate: the caps, the primitive restriction, the reinsert discipline and the merged query contract are asserted, and one live run proves the wiring and that a placed solid changes a sweep that was first shown to be clear. Its five dependents (`DET-07`, `PHY-01`, `PHY-02`, `LIF-02`, `NET-02`) are now dependency-complete. The hash ships empty; none of them has placed a proxy yet.
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
