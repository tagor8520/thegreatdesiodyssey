# Visual audit harness

Deterministic **moving-capture** tooling for the visual acceptance gates described in
[`feature-roadmap/VISUAL_GATES.md`](../../feature-roadmap/VISUAL_GATES.md).

It is deliberately isolated from the game's dependency tree: its two dependencies live in
this folder's own `package.json`, so `npm install` at the repository root never downloads a
browser and `npm run check` is unaffected.

## Why `@sparticuz/chromium`

Playwright and Puppeteer download their browser binary from a CDN at install time
(`cdn.playwright.dev`, `storage.googleapis.com`). In restricted build environments those
hosts are unreachable while `registry.npmjs.org` is reachable, which is what historically
blocked every moving visual gate.

`@sparticuz/chromium` ships the binary **inside the npm tarball** (`bin/chromium.br`, ~67 MB),
so it installs from the registry alone. Two details are handled in `harness.mjs`:

1. The binary links `libnspr4`/`libnss3`, which bare containers lack and cannot `apt`-install
   without root. They ship in `bin/al2023.tar.br`; the harness decompresses them into
   `.cache/libs` and sets `LD_LIBRARY_PATH`.
2. Headless software GL needs `--use-gl=angle --use-angle=swiftshader
   --enable-unsafe-swiftshader`. Chromium 153 refuses an unsafe SwiftShader context without
   the last flag.

## Usage

```bash
npm run dev                 # terminal 1: the game must be running
npm run visual:audit -- --list
npm run visual:audit -- curated-camera          # COL-06, curated world
npm run visual:audit -- coordinate-matrix       # COL-05 shape-family orbit matrix
npm run visual:audit -- water-order             # LAY-03 transparent water
npm run visual:audit -- shimmer-low-dpr         # MAT-03 low-pixel-ratio shimmer
npm run visual:audit -- remount-lifecycle       # FND-07 zero-growth remount
npm run visual:audit -- domain-interface        # FND-08 curated + coordinate domain interface
npm run visual:audit -- action-surfaces         # GME-05 every action on every surface it claims, both runtimes
```

Options: `--url <base>` (default `http://localhost:5173/`), `--width`, `--height`,
`--fixture <id>`, `--variant <name>`.

Coordinate scenarios need the **offline fixture provider**, which is part of the dev server
(`tools/fixture-provider/vite-plugin.mjs`) and needs no network. `--fixture` switches which
canonical `GeoFixtures` entry is served; the switch happens server-side, so no dev-server
restart is needed between fixtures. Defaults: `dense-urban` for the camera scenarios,
`mapped-coast` for `water-order`.

Two standalone diagnostics live beside the scenarios. They are not in `SCENARIOS` because they
assert rather than capture — they print a live report and set a non-zero exit code.

`tools/visual-audit/diagnose-plant-attributes.mjs` prints the live vertex-attribute accounting for
the plant pools and the context limit, reproducing defect `F1` (`VISUAL_GATES.md` §6.F1).

`tools/visual-audit/diagnose-dynamic-proxies.mjs` proves `COL-09`'s contract is wired into the
running product, against `dense-urban` with mapped buildings resident. It reports the live profile
and cap, checks the cap agrees with the low-profile budget ceiling, refuses the 65th insert without
evicting anything, shows storage-slot reuse with a fresh handle, and — the part worth copying into
any future dynamic-contact probe — **first proves its probe lane is clear on an empty hash**, then
places a solid and re-runs the identical sweep, so the before/after pair is the evidence rather
than a single measurement that static geometry could have decided.

### `domain-interface` — FND-08

Runs the shared domain probe against **both** shipped runtimes in one session: it opens the curated
runtime, probes it, then switches to Coordinate Explorer on the offline fixture and probes that.
The probe itself is `src/engine/WorldDomainProbe.js`, the same module `src/reference/WorldDomain.test.js`
imports, so the Node tier and this one cannot drift — and the verdict is reached in Node by the same
`judgeWorldDomain` and `compareDomainScales` the Node tier calls, so both tiers fail with the same
sentences. Only the probe executes in the page; it is loaded over the dev server with a dynamic
`import()`, which is why this scenario needs `npm run dev` rather than a production preview.

It is not a pixel gate. What it establishes is that the two modes answer the same five questions
through the same six-member interface with their own scales intact, and that a placed solid changes
the outcome of a move that was first shown to be clear. The summary carries `domainFailures`, and
`run.mjs` exits 1 if it is non-empty.

### `action-surfaces` — GME-05

Opens **both** shipped runtimes through the real landing flow and presses what a player presses: the
mounted touch controls with real `PointerEvent`s, the joystick with a pointer drag, and the page's own
`KeyboardEvent` listeners for the keys. It never calls into the player — calling `setVirtualInput`
would test the very layer under suspicion — and it judges in Node (`judgePresses`) against the same
registry declarations the page rendered from.

It asserts three surfaces in one pass: **touch** (every declared control exists, hold controls stay
active while held and release, tap controls fire and leave nothing held, the joystick drag moves the
player's own analogue vector and zeroes it on release), **desktop** (each key resolves per runtime,
and the two runtimes' bindings are disjoint: `KeyM` is map mode in curated and nothing in coordinates,
`KeyV`/`F3` the other way round) and **ui** (every inventory slot reached by both its button and its
key, asserted on the rendered `aria-pressed` after letting React commit). It then repeats the whole
touch measurement at **390x844 with touch emulation**, where each runtime must decide for itself to
show the controls, and fails any target below the 44px floor or drawn off-screen. A mouse-driven
browser must end up with `data-mobile="false"`. This is not a pixel gate; the summary carries
`actionFailures` and `run.mjs` exits 1 if it is non-empty.

### `remount-lifecycle` — FND-07

The only scenario that measures *lifecycle* instead of pixels. It mounts and exits three times in
each runtime and asserts that workers, observers, listeners, geometries and textures return to
baseline. `tools/visual-audit/lifecycle.mjs` holds the instrument (imported by the scenario, never
by the game) and `run.mjs` exits **1** when a class grows.

Three things about it are deliberate and easy to break:

- **A warm-up cycle absorbs one-time initialisation**, because `react-dom` registers a delegated
  `selectionchange` on `document` the first time it needs that event type and Vite injects a
  `<style>` into `<head>` on the first lazy CSS import. Measured cycles are compared to the warm
  reference, not to a fresh page load.
- **A subscription is *live* only if its target is reachable** — `window`, `document`, an
  `isConnected` node, an unterminated worker, an open socket. Detached ones are reported as
  orphaned and are not counted as growth, because counting them cannot tell an app leak from the
  instrument's own reference. The collectability step drops those references, forces a collection
  over CDP and reports what the page still holds.
- **Geometry counts are never asserted, only releases.** Both runtimes stream, so a settled mount
  owns a different amount each time; the property that matters is that everything armed was
  disposed.

`tools/visual-audit/probe-fnd07-production.mjs` is the production counterpart, because this
scenario needs the dev-only audit bridge and therefore cannot run against a built bundle:

```bash
npm run build && npm run preview -- --host 0.0.0.0 --port 4173   # terminal 1
node tools/visual-audit/probe-fnd07-production.mjs               # terminal 2
```

It drives the same real landing UI with instrumentation only, and exits non-zero if a measured
cycle fails to return to the warm reference or if a discarded target survives a forced collection.
It exists to bound `VISUAL_GATES.md` §6.F3: the dev build retains discarded React root containers,
the shipped build collects all of them.

Output goes to `out/<timestamp>-<scenario>/`: a `report.json` plus PNG frames for review.
Exit code is non-zero if the camera ever rendered from inside a blocker, if a **gate-relevant**
console error was logged, or if a scenario asserts a failure.

### Tracked-known console errors

Some console errors are known, tracked, and provably unrelated to the gate under test.
These live in `KNOWN_CONSOLE_DEFECTS` (`harness.mjs`), each naming the defect and where it is
recorded. They are **still printed and still written into `report.json`** under
`knownConsoleDefects`; they simply do not set the exit code, because failing every coordinate
audit for an unrelated vegetation-slice defect would train readers to ignore the signal.

Never add an entry to silence a failure. Add one only after reproducing the defect with your
change reverted and recording it in `VISUAL_GATES.md` §6.

## What the harness may and may not decide

SwiftShader is a **conformant software rasterizer**, so this harness can settle *correctness
and appearance* gates:

- camera never renders inside a blocker; compression latency in frames
- near-plane cutting through walls, terrain, or the avatar
- water draw order and duplicate-blend darkening
- presence/absence of gross shimmer at low pixel ratio
- silhouette family identity, branch cracks, module facing
- popping at tile/LOD/focus transitions

It **cannot** settle *performance* gates. It renders this game at single-digit FPS, which is
not a proxy for a mobile GPU in either direction. Never record an FPS, frame-time, draw-cost,
or thermal result from this harness as a shipping claim — those still require real hardware.

Shimmer is the hard case, and the honest answer is that **this harness cannot decide it**.
`shimmer-low-dpr` measures frame-to-frame luma change at the production pixel-ratio floor, and
its statistic stays at p99.9 = `4.1` whether the anti-alias policy is active, mip-disabled, or
**entirely stripped** — a positive control that removes `gdoDetailFade`, `gdoMinimumPixels`, and
`uNormalFade` across all six semantic materials moves nothing. A metric that cannot fail cannot
pass either, so the scenario reports `metricValidated: false` and exits **2 (inconclusive)**.
`MAT-03`'s shimmer sign-off therefore needs a real-GPU capture, using the same scenario.

Two traps to avoid when writing this kind of measurement:

- **Pin the animation clock.** The water shader offsets its normal-map lookup by `uTime` from
  wall-clock milliseconds, so an A/B taken at different moments samples different wave phases.
  That produced a reproducible but completely wrong `0.890x` result before the phase was pinned.
- **Compute statistics in the page.** Returning raw frames to Node costs ~12 MB per measurement
  and turned this scenario from 14 seconds into 16 minutes with no verdict.

## How scenarios drive the game

Scenarios do not synthesise input events. A development-only bridge in `src/landing.js`
exposes the mounted runtime on `globalThis.__gdoAudit` when `import.meta.env.DEV` is true, and
Vite tree-shakes that branch out of production builds, so no audit handle ships to players.
Scenarios then pin the player, aim the orbit camera, and sample geometry on **every rendered
frame**. Two techniques are worth reusing:

- **Assert on the sharper object, not the convenient one.** `COL-05` tests the four
  **near-plane corners**, not the camera origin, because the origin can sit legally outside a
  facade while the near plane clips through it. Containment is a zero-length, zero-radius
  `world.sweepSphere` — the shipped query, used in a direction the sweep logic never resolves,
  so it cannot pass by construction.
- **Render twice in one task to isolate ordering.** Frame-to-frame diffing cannot separate
  flicker from animation. `LAY-03` renders the identical scene twice back to back with no clock
  advance and compares `gl.readPixels` output; identical inputs must give identical pixels.

Metrics that need a control should always carry one. `shimmer-low-dpr` does not report absolute
temporal variance (water normals animate, so it is meaningless); it reports variance **relative
to a mip-disabled control** at identical camera micro-motion.

Keep new scenarios consistent with that: assert against the same objects the renderer uses,
sample every frame rather than a single still, and write a JSON report beside the frames.

## Maintenance

- `.cache/` and `out/` are generated and git-ignored.
- The first run installs dependencies and extracts libraries, which takes a few seconds.
- Chromium is pinned in `package.json`. If a future release renames the bundled library
  archive, `ensureLibraries` is the single place to update.
