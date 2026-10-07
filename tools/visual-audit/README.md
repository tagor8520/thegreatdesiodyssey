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
npm run visual:audit -- content-schema          # CNT-01 the served state packs validate in-page, byte-identical to disk
npm run visual:audit -- label-los               # GME-04/LAY-05 a name behind a wall hides; a clear name stays visible
npm run visual:audit -- landmark-openings       # DET-09 the two landmarks batched, the arch open and the pier blocked
npm run visual:audit -- weather-state           # ENV-04 the seeded weather schedule, its response on the live scene, both runtimes
npm run visual:audit -- local-save              # NET-01 the versioned save survives a reload in both runtimes
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

### `content-schema` — CNT-01

The only scenario that needs no fixture and no mounted game: it loads the landing shell, imports the
real `src/engine/ContentSchema.js` over the dev server, fetches `public/content/states/*.json`, and
validates them **in the page**. The Node tier validates the files on disk; this tier proves the files
the game actually receives are the same files, by comparing the SHA-256 of the served text against the
file on disk — a dev-server plugin, a transform or a stale `public/` copy would show up as a mismatch
rather than passing silently. It also runs the legacy v0 → v1 migration and a rejection case in the
browser, so a Node-only API that slipped into the schema module fails here rather than in a
contributor's browser.

The summary carries `contentFailures` and `run.mjs` exits 1 if it is non-empty. It also prints the
recorded gap: nothing mounts `StateManager` yet, so there is no live surface to drive and the
validator ships zero bytes — that is `CNT-02`/`CNT-04`'s work, and stating it here is what keeps the
gate from implying coverage that does not exist.

### `label-los` — `GME-04` / `LAY-05`

A real line-of-sight gate, and the only scenario whose subject is *found* rather than authored. Labels are DOM elements drawn over the canvas, so without an explicit test a place name is readable through the building in front of it. The scenario installs a page-side probe, intercepts `world.sweepSphere` to record the **masks the label layer actually asks for**, then searches standing positions around each committed label with the world's own `LOS_BLOCKER` sweep, teleports to a hit, and compares the layer's DOM verdict (`element.hidden` plus `data-los="blocked"`) against an independent probe taken from the live camera.

Three details make the comparison falsifiable rather than decorative:

- **Only interior contacts count.** A contact at `t = 0` means the sampled eye is *inside* geometry — a legal query result, but not a standing position a player can occupy. The scenario reports both counts and requires the wall to be strictly between (`0 < t < 1`); in `dense-urban` it finds 44 obstructed samples of which 5 qualify.
- **A verdict is only trusted while it is fresh.** The DOM trails the scheduler by one label pass (`isHidden` is read before the pass that refreshes it) and a stale verdict on a culled label would look identical to an occluded one. A fresh per-label row (age under the 250 ms refresh interval) proves the label was a candidate in the last pass — on screen and not overlapped — so a hidden verdict can only be about occlusion.
- **Every criterion is a hard failure.** The summary carries `labelFailures` and `run.mjs` exits 1 if it is non-empty: no interior contact, no clear-ray visible label, a label ray that used any mask other than `LOS_BLOCKER`, no rays at all in the window, a profile other than `low` `20/s × 5`, an over-budget test count, a missing per-label ray/blocker/age, an invisible or malformed review panel line, or a coordinate readout whose printed distance and compass point disagree with the ones recomputed from the runtime's own coordinates.

Four negative controls were run and each exits 1: occlusion disabled (*no player-reachable label was hidden*), the ray changed to `CAMERA_BLOCKER` (*label rays used masks 4*), the profile switched to `high` (*80/s × 14, not 20/s × 5*), and the overlay extras dropped (*panel line does not carry the profile, counters and blocker*).

### `ambient-life` — `LIF-02` / `LIF-01`

The one scenario that judges a budget **against the renderer's own buffers instead of the subsystem's counters**. The registered gate is *screen/distance/activity budgets; no per-agent object graphs*, and the defect it guards is not subtle: the frame loop used to walk every ambience instance of every resident tile on every frame. A scheduler that reports a perfect `24` while the frame loop keeps walking is exactly the state a counters-based gate would call a pass, so the scenario reads `InstancedMesh.instanceMatrix` before and after a pass and counts how many instances **actually moved**.

Four details make it falsifiable rather than decorative:

- **The window is delimited by the scheduler's pass counter, not by wall clock.** On this software renderer a frame can take a quarter of a second; a fixed 120 ms window was repeatedly measured containing zero frames, where "nothing moved" means nothing at all. The instrument waits for `diagnostics.passes` to advance, then one animation frame for the pass's upload to land, and returns `passesDelta` so a caller can see the window was real. It also reports `orphaned` meshes, so a tile that streamed in or out mid-window cannot be mistaken for a still scene.
- **The run is forced to be non-vacuous.** Coordinates open 8% inside a tile corner — inside the prefetch band of both axes — so four tiles stream in and the resident set (**58 agents** in the runs recorded here) exceeds both the 30 ceiling *and* the allowance the check permits to move. That last part matters: an earlier version only required "more than the ceiling" and a three-tile run moved 44 instances under a 54-instance allowance, letting the exact bypass it exists to catch slip through. The scenario now fails outright if the resident set cannot exceed the allowance.
- **Two budgets are asserted, not one.** The drawn set is capped by `visibleCeiling` (30 low) and the per-frame work by `perFrame` (24). The first implementation honoured only the second — it bounded the update rate while still drawing every resident agent — which is why the criteria are separate and why `drawnSlots` and `lastPoseUpdates` are reported apart.
- **Every criterion is a hard failure.** The summary carries `ambientFailures` and `run.mjs` exits 1 if it is non-empty: more agents drawn than the ceiling, more poses than the per-frame budget, more admissibility decisions than twice that budget, more instances moved in a pass than `drawn + per-frame`, a pass that posed nothing, no distance cull ever counted, a resident set that never exceeded the allowance, activity `0` that left agents drawn or failed to collapse them, activity restored without bringing them back, or a missing/malformed `ambience` line on the review panel. Note that a **new** scenario's failure field must be added to `run.mjs`'s verdict branches: this one's first failing run printed `blockers 2` and still exited 0, because the runner only converts field names it recognises into a non-zero status.

Five negative controls were run and each exits 1: the pre-`LIF-02` unbounded walk reinstalled verbatim (**58 of 58** instances moved, above the 41 allowed, while the counters still read `drawn 17`), the activity budget ignored (`activity 0 → drawn 17`), the distance budget disabled (*no distance cull was ever counted*), the hide path disabled (*collapsing 0 instance(s)* — the stale-pose defect), and the review-surface marker renamed (*no `ambience` line*).

Recorded coverage limit: the **screen** budget cannot be exercised live through the product's own camera ranges — at the coordinate camera's ≈100 px/m even a bee spans ≈27 px against a 0.6 px floor — so the floor and its counter are proven in the Node tier (`src/geo/GeoAmbientLife.test.js`), and the browser run exercises distance and activity only.

### `time-of-day` — `ENV-02`

The scenario that turns "readable night" and "bounded uniform updates" into measurements instead of adjectives. Three details matter:

- **The frame is drawn and read in the same task.** The default framebuffer's contents are undefined once the task yields, so reading pixels from the animation loop's last frame returns black — the first run of this scenario reported `mean luma 0.000` for a daylight frame that was plainly rendering. The probe calls the runtime's own `render()` immediately before `gl.readPixels`, which also means the measurement is *about the state that was just applied*.
- **Readability is relative to the day frame, not an absolute floor.** The first thresholds (`visibleFraction > 0.05`, `maxLuma > 0.15`) passed a night that had lost its moon and most of its ambient term — the third negative control demonstrated exactly that — so the gate now requires the night to keep **≥ 40% of the day's legible coverage** and its own luma floor (0.05). A night that is merely dark fails, and so does a night that is not dark at all.
- **The ceiling is driven synthetically, and the log says so.** On SwiftShader the renderer runs at ≈3 fps, so the live loop *cannot* reach a 10 Hz ceiling — the frame rate bounds it first. The live half therefore proves the frozen half (a frozen clock writes **zero** uniforms over 60 frames), and a 60 fps drive through the same instance proves the ceiling (30 writes over 3 s against 10/s). The scenario prints the observed frame rate next to the numbers so a reader can see which half did which.

`timeOfDayFailures` is a hard assertion in `run.mjs`. Five negative controls each exit 1: the rate ceiling removed, change detection removed, the night stripped of its moon and ambient term, the uniforms bound by value, and the review-surface marker renamed. The second of those **passed on its first run** — the failure was collected into an array no verdict read — which is why the frozen-clock check is part of the verdict list rather than a diagnostic.

### `discovery-journal` — `GME-06`

The scenario that proves a runtime *feeds* its journal rather than being fed by the probe. It teleports the player onto a real resident label and then only watches, so a runtime that never calls `update()` cannot pass.

- **Determinism is measured across a reload**, not within one page: the id the runtime gives a place in session one must be the id session two gives the same place. That is the only way to tell a function of the place from a function of the session.
- **The ids are checked against the function itself.** The scenario imports `/src/engine/DiscoveryJournal.js` *inside the page* — the dev server's module graph is keyed by URL, so this is the module the runtime loaded — and recomputes the id of every place the journal holds.
- **The corpus is the world's own labels**, read from every resident tile rather than from the 14 the label layer displays, so the bound is measured over real map data. It is also small, and the scenario says so: the fixture world exposes 11 named places, so the shipped capacity of 128 is never reached in a browser and the capacity-5 trial over those same 11 real places is what fills to capacity and proves the retained set is the same in either walk order.

`discoveryFailures` is a hard assertion in `run.mjs`. Five negative controls each exit 1: a randomised id, the frame loop no longer feeding the journal, eviction leaking its slot, displacement made unconditional, and the review-surface marker renamed. A sixth control — flipping the id tie-break direction — **passed**, and the record keeps that because it corrected the gate's own explanation of which rule makes the retained set canonical.

### `landmark-openings` — `DET-09`

The scenario for the gate *"repeated modules batched; arches never use one enclosing AABB"*. Both clauses are about what the **renderer and the collider were handed**, not about a displayed value, so both are measured against the live artifacts.

- **Batched** is measured against the live scene, not the source. The scenario recompiles both landmarks *inside the page* from the modules the runtime loaded (the dev server's module graph is keyed by URL — the technique `discovery-journal` uses) and then requires every compiled box to be found as an instance of **one** `InstancedMesh`: 50 Gateway boxes and 108 Chariot boxes, each in a single draw, with translation, scale **and** per-instance colour checked. The palette is read as raw triples and compared through the renderer's own colour class, because `THREE.Color` has stored *linear* values since r152 and a hex-string comparison would compare two encodings. The chunk's own boxes live in the same mesh, which is the claim: a landmark is more instances of a draw the chunk was already making, not an extra draw.
- **The arch** is asked of the runtime rather than re-implemented: `bridges.clipCamera` — the call `Gameplay.test.js` makes — must be open along the centre line through the Gateway arch at the live sweep radius and blocked into the pier, while the union of the same 18 blockers must cross that segment (`unionWouldBlock`). The clause is additionally stated as a property of the live blocker list: **no single blocker may contain the opening's whole free volume**. Ids are checked because other gates address them (`gateway:pier:-1`, `gateway:tower:-11:-4`) and because they must be unique.
- **The collider contains the drawing**: the wheel rim's reach is measured from the *drawn* instances as the radial support of the rotated stones (3.7 m — the 45° stones put a corner 0.7 m out from radius 3.0), and the live collider must contain it. That check caught the port's own 7.3 m declaration, which was 5 cm short.
- **Two controls run in the same process**, so the two assertions above are falsifiable in the run that reports them: the pre-`DET-09` union box is pushed back into the live blocker list and must close the arch (it does), and the Gateway's blockers are removed and the pier must open (so the pier result is caused by a pier). The blocker list is verified back at 34 afterwards.

`landmarkFailures` is a hard assertion in `run.mjs`. Six negative controls each exit 1 — three in the Node tier (no declared opening → 3 failures; the wheel collider back to 7.3; the free width not ending at the arch head) and three in the browser (stamping disabled → *only 0 of the Gateway's 50 boxes are in the scene*; one enclosing AABB per landmark → *a single live blocker contains the whole opening*; one material family per box → *the Chariot's 108 boxes reach the renderer as 16 draws*). The first of those browser controls found a runner defect: the run printed `[audit] FAIL` and exited 0 because the new failure branch omitted `process.exitCode = 1` — the same class `QLT-06` recorded for `ambient-life`. the wheel collider back to 7.3; the free width not ending at the arch head) and three in the browser (stamping disabled → *only 0 of the Gateway's 50 boxes are in the scene*; one enclosing AABB per landmark → *a single live blocker contains the whole opening*; one material family per box → *the Chariot's 108 boxes reach the renderer as 16 draws*). The first of those browser controls found a runner defect: the run printed `[audit] FAIL` and exited 0 because the new failure branch omitted `process.exitCode = 1` — the same class `QLT-06` recorded for `ambient-life`.

### `local-save` — `NET-01`

The gate is *"migration-safe settings/discovery/progress"*, and the scenario is the only one that **reads its subject out
of `localStorage` rather than off the live model**. That distinction is the gate: the store is change-tracked and
interval-coalesced, so the live document holds a change for up to a second before the bytes land, and a reload is the
only thing the feature is actually about.

- **Every clause is read from storage.** `waitForStored(page, expression)` polls until the *stored* document satisfies the
  expression with the store quiet, and the same helper drives the two settings (`save.settings.showDebug`,
  `save.settings.soundEnabled`), the journal section, the curated progress section and the migrated file. A live model
  that has the change but has not written it does not pass — which is exactly the state a naive gate would report as green.
- **The writer is the module the runtime loaded.** The scenario imports `/src/engine/SaveState.js` in-page and requires
  `encodeSave(game.save)` to equal the bytes in storage, so the file cannot drift from the model. It also prints the
  ladder's steps and the declared settings table from that same module rather than from the test file.
- **The panel line must agree field for field.** The review panel's `save v1 · local · places N/128 · items M · writes W ·
  B B` line is parsed and compared with `saveDiagnostics()` at the instant it is read, so the panel cannot show a stale or
  invented document. The overlay renders every line once with no extras when it is switched on (which says
  `save unavailable`), and a hidden panel keeps its last text — the scenario polls only while the panel is on show.
- **The setting clauses are order-independent.** The runtime's own state is read first (`debugOverlay.enabled`), and the
  button is required to move the panel *and* the document to the opposite value; then a **new session** must open the
  panel from the saved value; then `F3` must move both, in both directions, with the registry's `actionsFired` counter as
  the evidence that the press actually reached the runtime (a press vetoed by `GeoPlayer.enabled` is silent otherwise —
  the scenario waits for readiness rather than assuming it).
- **The refusal clauses come last, because they poison storage.** A future and a corrupt document are each planted, the
  run asserts the runtime still mounts, holds nothing from them, and leaves the bytes under `gdo:save:unreadable`; the
  scenario notes whether the primary key was replaced by the runtime's own document and requires that replacement to validate.

`saveFailures` is a hard assertion in `run.mjs`. Seven negative controls each exit 1, each restored byte-identically:
the review toggle stops writing; the frame loop never captures the journal; `ItemManager.restore` removes nothing; the
ladder keeps a stale id; the ladder stops coercing `0`/`1`; a future document is merged instead of refused; the store
ignores the write interval. **A control that passed is in the record too**: removing the ladder's `dirty = true` after a
migration does not fail the gate, because both runtimes write the document on mount anyway and the upgraded file lands on
the next tick. The control was rewritten to break the *repair* instead, which is the part that is only the ladder's.

### `weather-state` — `ENV-04`

The gate is *"deterministic transitions, environment response, low-profile fallback"*, and the
three clauses are not equally strong in one tier, so the scenario says which tier decides which.
It drives **both** runtimes in one session, the way `domain-interface` does.

**Determinism is a two-session claim, so the scenario re-navigates.** It opens the coordinate
fixture, reads the seed and the climate the runtime chose, re-runs the module's own hash and
climate rule in the page and requires them to agree, then *loads the page again* at the same
coordinate and requires the same seed, the same state and the same fifteen response fields at
the same clock. It then compares the runtime's schedule against `sampleWeatherAt` window by
window (the runtime takes a time of day inside a day, the module an unwrapped clock, so the
comparison places the sample in the day the runtime is in), sweeps a whole day in five-minute
steps to bound continuity by the cross-fade, and probes **midnight** separately — the last
window of a day must fade into the next day's anchor, which is where a per-day schedule is most
likely to cut. The budget is measured twice: 60 frames of a frozen clock must write **nothing**,
and a synthetic 60 fps drive with the clock advancing a world minute per frame must stay inside
the profile ceiling while still changing state and coalescing writes, with a 400 → 1000 minute
jump costing exactly one write.

**The response matrix drives the live runtime to all eight states.** The day the seed produces
is a day, not a menu, so the probe *searches seeds through the runtime's own model* to find a
window whose state is the one it wants, then applies it through `setClockMinutes` — the clock
the frame loop actually reads — and measures what the renderer holds: the dome's cloud uniforms,
the water's weather uniform, the fog range and colour, the sun's intensity, the exposure and the
rendered pixels. Each state is compared against `clear` **at the same clock and the same sun**,
so the hour cannot explain a difference, and every state's eight-value response vector must be
distinct from every other's, which is the claim that the states are visible at all. `clear` is
additionally required to be the arithmetic **identity**: the hour's own cloud cover, unwet water,
the shipped fog range, the hour's fog colour to `0.0e+0` and the hour's own sun intensity. Two
clauses are deliberately one-directional: a storm must be darker than clear, and its fog must
stay a **tint** of the hour's colour (below the hour × 1.13), so no weather can brighten a night.

**The fallback is structural.** The low profile declares zero particle families, so the response
must be uniform-only: the scenario requires the profile to say so, requires all 28 pairs to
differ on the uniform response alone, and requires the scene's child count to be identical
across every state — a state that added an object or a draw would fail. The habitat response is
measured where it happens rather than inferred: three scheduler passes are waited for at each
budget and the drawn agent count is compared, while `world.ambientActivity` must be **1** at both
ends so the difference can only come from the weather's species shares.

Both negative controls and in-run controls live in the register (`feature-roadmap/VISUAL_GATES.md`
§4 A4l); the scenario's own probe bugs are recorded there too, because two of them made a *pass*
look like a failure and one made three states look identical when they were not.

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
