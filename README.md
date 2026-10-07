<div align="center">
  <img src="https://via.placeholder.com/150/FF9933/FFFFFF?text=GDO" alt="The Great Desi Odyssey Logo" width="120" height="120">
  
  # THE GREAT DESI ODYSSEY 🇮🇳

  **A 3D Voxel Journey Across Indian States, Landmarks & Meme Lore.**

  [![Build Status](https://img.shields.io/badge/build-passing-brightgreen)](#)
  [![License](https://img.shields.io/badge/license-Custom-blue.svg)](#license--ip-notice)
  [![Vite](https://img.shields.io/badge/vite-%5E6.0.0-646CFF?logo=vite&logoColor=white)](#)
  [![Three.js](https://img.shields.io/badge/three.js-r170-black?logo=three.js&logoColor=white)](#)
  [![Discord](https://img.shields.io/discord/1234567890?color=5865F2&label=Discord&logo=discord&logoColor=white)](https://discord.gg/wCgUdZppd)
  <a href="https://buymeacoffee.com/aayushraj1q" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 28px !important;width: 100px !important;" ></a>
  [**▶ Play the Live Demo**](https://desiodyssey.pixellon.in)  |  [**💬 Join our Discord Community**](https://discord.gg/wCgUdZppd)
</div>

---

## 📖 Game Vision

Our grand vision is to build an immersive, living virtual universe celebrating India’s multi-layered cultural tapestry, regional diversity, and iconic internet meme culture.

**[Read the full Game Vision (The Virtual Universe of Bharat) here.](./VISION.md)**

---

## 🗺️ Current Map & Biomes

Our Z-axis aligned map currently features three fully realized regions:

### 🚂 Maharashtra (The Starting Hub)
* **Platform 1 — Mumbai Central**: The spawn area featuring a continuous railway track, bustling chai stalls, and a moving local train.
* **Marine Drive**: The iconic Queen's Necklace promenade bordering the Arabian Sea.
* **Gateway of India & Taj Mahal Palace**: The grand colonial-era archway and the legendary luxury hotel.

### 🛕 Karnataka (The Cultural Bridge)
* **Hampi Stone Chariot**: An intricately detailed voxel recreation of the UNESCO World Heritage monument.
* **Mysore Palace Gates**: The grand cream-and-gold entryways to the royal city.
* **Bengaluru Tech Towers**: Modern glass facades surrounded by blooming pink Tabebuia trees.

### 🌴 Kerala (God's Own Country)
* **Fort Kochi Coast**: Featuring the famous Chinese fishing nets overlooking the water.
* **Alappuzha Backwaters**: Board a traditional boat and sail across interactive water bodies.
* **Munnar Tea Hills**: Rolling, procedurally-damped hills that challenge your climbing physics.

### 🌍 Coordinate Explorer

Choose **Enter coordinates** on the landing screen to build a lightweight local world from OpenStreetMap-derived vector data. The browser fetches one zoom-14 chunk and generates it in phases: navigable roads first; mapped water, land cover, biome colours, deterministic trees/palms/shrubs/flowers/herbs/tall grass/rocks/street furniture/parked voxel cars, animated birds and bees, and map-derived names second; accurate horizontal building footprints with reproducible stylized heights last. Sparse map tiles use Minecraft-inspired seeded octave fields plus a jittered lattice to grow contiguous, obstacle-aware plant patches instead of leaving empty generic ground. A coordinate-seeded 33×33 height grid gives each resident chunk seam-free local relief without another API; roads, mapped land, buildings, details, labels, player grounding, and camera clearance share its exact height/normal query. Mapped polygon water, waterways, shorelines, banks, and wetlands compile into a bounded transferable signed-distance/support domain. Its v2 schema classifies provider aliases as unknown, stream, canal, river, lake, or ocean; stores normalized mapped waterway tangents and bounded associated polygon flow; keeps lakes/oceans still; and preserves the nearest class across shore/bank queries. Intersecting waterway ribbons are omitted from polygon-water meshes to avoid duplicate transparent self-overdraw while retaining class, flow, and support truth. Roads include high-contrast batched curbs, lane marks and crosswalks; provider bridge, tunnel, `brunnel`, and numeric levels resolve to separated physical grades, while bounded same-grade patches close joins and crossings. Buildings retain one-draw analytical framed windows, colour variation, and parapets as their ordinary path. A footprint-hashed maximum-eight subset in the current source tile receives one extra visual-only batch of road-facing entrance/canopy/cornice/balcony/utility modules and exact-slot roof stair/solar/vent modules; missing roads or slots skip the affected detail without fabrication. The versioned object recipe keeps oriented silhouette, surface, accent, collision, interaction, and camera roles independent. Building collision uses the true mapped polygon after a cheap spatial/AABB broad phase, so rotated, triangular, and L-shaped footprints no longer create oversized invisible walls. Horizontal scale remains approximately 1:10.

Map-derived names are projected as DOM labels over the canvas, which means they do not take part in WebGL depth: each label is therefore tested against the world's `LOS_BLOCKER` geometry so a place name is never readable through the building in front of it (`GME-04`, which also closes `LAY-05`). The test is throttled rather than per-frame — one small sphere per candidate, held for a 250 ms update interval and capped at the research's 20 tests/second and 5 simultaneous labels on the low profile — and it asks for blockers only, so a pickup, a bird or a blade of grass between the eye and a name cannot blank it. The coordinate readout prints the nearest named place with its bearing and distance, computed from the coordinates themselves rather than from world axes. The gate (`npm run visual:audit -- label-los`) finds an occluded pair in the live scene and requires the layer to hide that label while a clear-ray name stays visible.


Ambient life — the birds circling over the blocks and the bees working the verges — now runs on a **budget rather than on a walk** (`LIF-02`, which also closes `LIF-01`). `src/geo/GeoAmbientLife.js` keeps agents in preallocated typed arrays with no per-agent objects and enforces the two budgets the research states separately: a **drawn set** capped by the profile's visible ceiling (30 / 60 / 100 at low / balanced / high) and a separate **per-frame work** budget (24 / 48 / 96 poses), plus a 72 m distance limit, a 0.6 px screen floor and an activity multiplier that lets weather or time of day wind a family down without a second animation path. An agent that leaves the drawn set is collapsed rather than frozen mid-air, and a tile that streams out returns its slots. The gate refuses to take the scheduler's word for it: it reads the renderer's own instance buffers and counts how many instances actually moved in a pass — in the recorded run, **17 of 58 residents** moved while the rest held still, where the previous frame loop moved all of them. `npm run visual:audit -- ambient-life`.

Both runtimes now read the same clock (`ENV-02`): `src/engine/TimeOfDay.js` derives the sun's elevation from the coordinate, the date and the clock, picks the palette from **elevation stops** rather than from an hour, and drives the sky dome, the light rig, the fog, the exposure and the ambient budget from one preallocated state — so "bounded uniform updates" is a property of the binding (the sky uniforms point *at* the state's own colours) rather than a budget someone has to police. Night is dark **and** legible: stars are a hashed direction field and the moon a disc in the same fragment pass, so it costs no extra draw call and no texture, and the ambient budget winds down with the light (birds roost at night rather than disappearing). `npm run visual:audit -- time-of-day`.

Exploration now has a memory (`GME-06`): `src/engine/DiscoveryJournal.js` records the named places a player walks into, identifying each by a **deterministic id** built from its name, kind and a coarse cell rather than from a session — so the same street has the same id after a reload, after a tile is rebuilt, and in the save file `NET-01` will write. Its state is bounded by capacity alone: preallocated slots, deterministic eviction, and a place the full journal cannot hold is *declined* rather than announced, so a HUD cannot be spammed by the labels it is already showing. `npm run visual:audit -- discovery-journal`.

The advertised contribution path — author a state in JSON, validate it, ship it — now has a contract even though it has no live mount yet: `src/engine/ContentSchema.js` declares the format as a table of fields the validator walks, keeps errors (a bad buff type, a repeated voxel coordinate, an undeclared field, a spawn outside declared bounds) apart from advisory warnings (no provenance, stale numbers in a pickup description), migrates legacy files through a version ladder that repairs coincident voxels and hex-case drift and refuses files from the future, and derives its authoring caps from the shared low-profile budget so content cannot claim a second allowance on top of the world's. Both shipped packs validate in both tiers. Not yet mounted: see the note below the engine lanes.

Both the curated adventure and Coordinate Explorer now start through the same procedural-engine surface and share colour management, atmospheric sky, lighting recipes, renderer ownership, and teardown. They also share one gameplay action registry (`GME-05`, `src/engine/ActionRegistry.js`): twelve actions are declared once with their codes, runtimes, surfaces and touch controls, both players resolve input through one `ActionInput` and handle actions **by name**, and the touch layer plus the curated inventory are generated from the same declarations. A key bound twice in one runtime throws by name, a declared touch control that is not rendered fails the gate, a source scan fails the build if any module outside the registry names a registered key, and touch targets carry a 44px floor. They also share one named query and traversal interface (`FND-08`, `src/engine/WorldDomain.js`): ground support, overlap, displacement, step verdict, camera clipping and diagnostics are six members that both runtimes implement — `GeoWorld` for coordinate, `CuratedDomain` for curated — and both players traverse through, so a shared consumer can address either mode. The two modes keep their own scales on purpose (coordinate resolves a 33×33 grid per tile at approximately 1:10 with a near-plane camera clamp of `[.03, .04]`; curated resolves a 4-metre terrain lattice at 1:1 with a clamp of `[.6, 1.25]`), and a build-time guard fails if those clamps start overlapping or the footprint ratio drifts off 10. They also consume one versioned generated material allocation: seamless 64×64 packed surface noise, a guttered 24-layer semantic mask atlas, 8×8 R8 dither, a 32×8 sRGB palette LUT, and the shared 128×128 water normal. The mip-aware estimate is 175,852 bytes, below the 256 KiB low-profile ceiling. Browser generation yields in bounded startup slices after roads-first work can be queued, and the last engine reference disposes every texture. Ground, roads, facades, water, curated voxel families, and reusable roof/bark/leaf recipes share these channels; derivative and distance fades suppress subpixel detail without weather-driven shader recompilation. The moving low-DPR shimmer capture is `MAT-03`'s remaining `PARTIAL`: browser capture tooling arrived on 2026-10-03 and the capture now runs in about fourteen seconds, but its frame-to-frame statistic does not move even when the entire anti-alias policy is stripped, so it certifies nothing either way. That gate needs a real-GPU capture or an owner decision to waive the criterion for trilinear-only selection; anisotropic filtering is deliberately not used.

The vegetation pipeline is versioned in seven independent stages. `PlantGrammar.js` compiles normalized broadleaf, palm, shrub, herb, grass, and bamboo skeleton IR from path/channel hashes. `PlantGeometryCompiler.js` bakes shared skeleton modules into indexed exposed-face typed arrays without runtime CSG. `PlantLodCompiler.js` derives near/mid/far geometry from one skeleton under family-specific box caps, preserving its pivot, envelope, bounds, palette topology, and placement anchor. Low thresholds use each plant's own yawed projected width/height at 96/32/6 pixels, an 18% hysteresis band, stable eight-slot reevaluation staggering, and at most 4 Hz updates unless the focus cell changes; no tile-wide bounding sphere decides plant detail. `PlantRenderPools.js` uploads these tiers into global family/LOD `InstancedMesh` pools shared by all resident coordinate tiles. Each pool record retains its source owner and stable placement ID; eviction removes that owner's records and deterministically repacks sorted survivors. The two low archetype variants share each family/LOD draw through paired exposed-face vertex streams plus a custom variant selector, while custom palette and normalized age/stiffness/phase attributes avoid Three's constrained-driver `instanceColor` path. `PlantClearance.js` derives actual base, root, and crown extents from the same recipes and tests anchors against exact building rings, route reservations, terrain/water support, and mapped land kind instead of one universal halo. Crowns may overhang road verges and non-solid ground cover; near-building crowns use no more than 16 deterministic envelope samples and one custom scale/shift attribute for branch, frond, blade, leaf, and flower vertices without moving the source-owned anchor.

`PlantMorphology.js` replaces source-tile biome switches with a browser-local continuous artistic profile. Latitude and smoothly interpolated 6,400-unit absolute-coordinate anomalies establish broad fallback temperature/moisture, then deterministic terrain response, mapped land kind, signed water/wetland distance, and bounded local road/building proximity blend tropical, subtropical, arid, upland, riparian, and urban influences at each candidate. These labels guide broad silhouettes and are not scientific climate or exact-species claims. One aligned 13-byte record retains the dominant three IDs and quantized weights plus conservative nonuniform aspect/height, two-variant recipe choice, palette, age, and stiffness; density and family choice come from the same weights. Morphology composes with the exact clearance envelope before acceptance, and all coordinate sessions share one fixed versioned recipe library rather than compiling per tile or coordinate. Exactly one near/mid/far pool—or no pool beyond the cull threshold—owns each plant. LOD repacks are event-driven. `PlantWind.js` owns one versioned world-aligned 2D field with low-frequency smoothed gust/turbulence, a wrapping precision-safe clock, malformed-input fallback, and system/in-game reduced-motion state. **Whole-plant wind is not enabled by default** (owner decision, 2026-10-03): the per-vertex cost was judged not worth the effect, so `VEG-09`/`VEG-10` are `REJECTED` as default paths. `PlantRenderPools.js` therefore compiles no wind ALU at all behind `#ifdef GDO_PLANT_WIND`, writes no clock uniform, and withholds no culling margin from geometry bounds. Opting in with `wind: true` restores the full field — height and packed bend/root roles with stable per-instance phase/stiffness in the vertex shader, at most one shared clock uniform per frame, zero vegetation matrices, and zero steady-frame wind allocations — and never touches plant anchors, clearances, collision/support truth, or instance matrices. The code and its lifecycle tests are retained so the decision is reversible by one flag. Optional plant compilation/upload is scheduled only after the tile's roads/buildings/collision phase is usable. The provider-equivalence fixture mounts 1,044 plants as 11 active global pools over 36 source geometries, 208,452 static GPU-geometry bytes, and 11,190 visible plant triangles, with a four-draw delta over the replaced tile-local families. *Fixture totals quoted in this document are point-in-time measurements: the automated gates assert named budget ceilings rather than these literals, so a figure can drift while `npm run check` still passes. See [`feature-roadmap/README.md`](./feature-roadmap/README.md#reproducing-this-snapshot).*

Edge-directed prefetch still keeps no more than four chunks resident and two requests active. No map API key is required; visible attribution remains in the game view. Coordinate mode also includes a disabled-by-default **Debug**/`F3` overlay for exact proxy bounds, query masks, tile owners, support levels and slots, environment profile IDs/quantized weights, morphology/LOD/wind counters, water class/flow/byte fields, selected building/road-test/box/triangle/byte counters, worker timings, live low-profile budget status, and material dimensions/formats/bytes/checksums. Its implementation is lazy-loaded on demand, uses one capped line draw only while enabled, and can be preselected with `?debug=1`.

See [`MAP_STREAMING_RESEARCH.md`](./MAP_STREAMING_RESEARCH.md) for the evaluated sources, policy constraints, scale math, architecture, and limits. The audited missing-feature catalogue, implementation priorities, budgets, and staged roadmap are in [`PROCEDURAL_WORLD_FEATURE_RESEARCH.md`](./PROCEDURAL_WORLD_FEATURE_RESEARCH.md). The focused art-direction, procedural-variation, biome, vegetation, weather, lighting, and environment-effects plan is in [`VISUAL_BIOME_BEAUTIFICATION_RESEARCH.md`](./VISUAL_BIOME_BEAUTIFICATION_RESEARCH.md). The minimal character collision, terrain/bridge/water interaction, bounded ragdoll, engine comparison, physics budgets, and acceptance plan are in [`MINIMAL_PHYSICS_RESEARCH.md`](./MINIMAL_PHYSICS_RESEARCH.md).

The follow-up correctness plan for player/camera clipping, non-oversized role-specific proxies, transparent/depth behavior, procedural intersections, automatic surface/render/query layers, and exact tile ownership is in [`CLIPPING_AND_LAYERING_RESEARCH.md`](./CLIPPING_AND_LAYERING_RESEARCH.md). The locally generated texture catalogue, deterministic fractal vegetation compiler, smaller-box LOD/face budgets, wind grouping, and modular detail grammars for buildings, street objects, rocks, vehicles, bridges, landmarks, and props are in [`PROCEDURAL_TEXTURES_AND_SMALL_BOX_GRAMMARS_RESEARCH.md`](./PROCEDURAL_TEXTURES_AND_SMALL_BOX_GRAMMARS_RESEARCH.md).

The combined status matrix, task categories, dependency-ranked canonical build order, active work, and completion gates are maintained in the [`feature-roadmap`](./feature-roadmap/) folder. Every implementation batch must update its [`CHANGELOG.md`](./feature-roadmap/CHANGELOG.md).

---

## 🎮 Controls & UI Guide

| Action | Keybinding | Available in |
| :--- | :--- | :--- |
| **Move** | `W`, `A`, `S`, `D` or Arrow Keys | All modes |
| **Look Around** | Mouse (GTA-style pointer lock) | All modes |
| **Jump** | `Spacebar` | All modes |
| **Run** | `Shift` | All modes |
| **Aerial Map** | `M` or the on-screen **Map** button | Curated and Classic; on-screen button in Curated only |
| **Coordinate camera** | `V` or `C` switches FPP/TPP (FPP is default) | Coordinate Explorer only |
| **Coordinate diagnostics** | `F3` or the **Debug** button toggles query/layer/budget overlays | Coordinate Explorer only |
| **Select food slot** | `1`, `2`, `3` or the inventory buttons | Curated only |
| **Interact / Board Boat** | `E` | Classic Explorer (`/classic.html`) only |
| **Fast Travel** | `T` | Classic Explorer (`/classic.html`) only |

`E`, `T`, and the Classic travel/map modals belong to the preserved legacy explorer at `/classic.html`; they are not wired into the current curated or coordinate runtimes. Coordinate mode has no `M` overview key.

*Note: Clicking anywhere on the game canvas locks your mouse. Press `ESC` to unlock. On touch devices **both** live runtimes now render a flexible left-side movement joystick plus translucent buttons on the right — Run/Jump/Map in the curated adventure, Run/Jump/TPP in the Coordinate Explorer — with a 44px minimum touch target. Every action above is declared once in `src/engine/ActionRegistry.js` and reached from the keyboard, the touch layer and the in-game UI through the same name (`GME-05`); the frozen `/classic.html` explorer keeps its own keymap by design. A desktop browser is never given the touch controls.*

---

## 🛠️ Technical Architecture (How to Build)

### Tech Stack
- **Engine**: [Three.js](https://threejs.org/) (`three`) behind one shared procedural runtime for renderer setup, atmospheric style, lighting, water primitives, deterministic chunk generation, and instanced/merged voxel batches.
- **Build Tool**: [Vite](https://vitejs.dev/) for HMR, code splitting, and optimized bundling.
- **Architecture**: JavaScript ES modules. Simulation/rendering stay framework-independent; React is used only for the in-game UI overlay.
- **Assets**: Gameplay models do not use `.gltf` or `.obj` files. They are generated from procedural geometry and voxel recipes.
- **Procedural materials**: `src/engine/ProceduralMaterials.js` owns deterministic texture bytes/checksums, filters/colour spaces, semantic recipes, uniform-only detail profiles, shared reference counting, and disposal. No texture is allocated per map tile.
- **Vegetation compilation/rendering**: `src/engine/PlantGrammar.js` owns versioned keyed-random skeleton IR, recipes, termination budgets, placement references, and skeleton caching. `src/engine/PlantGeometryCompiler.js` owns oriented-box transforms, exposed-face reduction, packed upload attributes, and geometry fingerprints. `src/engine/PlantLodCompiler.js` owns deterministic family-aware near/mid/far reduction, projected individual-bound measurement, hysteretic/staggered selection, stable source fingerprints, cache/entry caps, diagnostics, and reference-counted lifecycle. `src/engine/PlantRenderPools.js` owns paired-variant `BufferGeometry` upload, global family/LOD instance membership, custom palette/trait/clearance attributes, exact owner release, deterministic repack, renderer-context restoration, and GPU disposal. `src/engine/PlantWind.js` owns the bounded shared wind field, precision-safe clock, reduced-motion fallback, CPU acceptance mirror, uniform budgets, and lifecycle diagnostics; the pool shader applies its whole-plant deformation without matrix animation. `src/geo/PlantClearance.js` owns actual role extents, exact map/domain acceptance, bounded crown adaptation, and diagnostics; `src/geo/PlantMorphology.js` owns the continuous artistic environment sampler, dominant-three quantization, family/density/trait correlation, and conservative compact transfer; `src/geo/GeoWaterDomains.js` owns the compact shoreline/bank/wetland distance/support field, provider-neutral water classes, quantized polygon flow, per-segment mapped tangents, overlap suppression, transfer ownership, and 512 KiB low-profile byte cap. `src/geo/GeoBuildingGrammar.js` owns stable selected-building priority, the bounded ground-road facade index, road-facing edge resolution, exact-slot roof modules, oriented role-labelled recipes, and the one focus-tile visual-detail batch caps.
- **Low-end support**: The landing page lazy-loads WebGL. Automatic low/balanced profiles control resolution, effects, shadows, streaming distance, and decoration density. Use `?quality=low`, `?quality=balanced`, or `?quality=high` to force a profile.
- **Quality fixtures**: Network-free dense, sparse, concave, courtyard-hole, stacked-grade, coast, OpenMapTiles, and Shortbread fixtures compile through the production worker builders. `npm run check` verifies byte-stable regeneration/remount, disposal, exact topology, and declared memory/draw/triangle/query/worker ceilings.

### Directory Structure
```text
desi-odyssey/
├── public/content/         # Static imagery and experimental state data
├── src/
│   ├── landing.js          # Lightweight shell; lazy-loads the selected 3D runtime
│   ├── geo/                # Coordinate Explorer: projection, MVT worker, streaming world, controls
│   ├── reference/          # Curated game runtime, rendering, UI, and tests
│   ├── engine/             # Mixed directory — see the breakdown below before editing
│   ├── world/              # Legacy Classic Explorer world (classic.html only)
│   ├── ui/                 # Legacy UI and shared docs renderer
│   └── network/            # Experimental, currently disconnected WS client
├── index.html              # Current optimized game (curated + Coordinate Explorer)
├── classic.html            # Preserved legacy explorer
└── package.json
```

`src/engine/` is not uniformly "shared" or "legacy". Check which lane a module belongs to before changing it:

| Lane | Modules | Consumers |
| :--- | :--- | :--- |
| **Shared by current runtimes** | `ProceduralEngine`, `ProceduralMaterials`, `FeatureVersions`, `PerformanceBudget`, `WorldDomain`, `ActionRegistry`, `TouchControls`, `PlantGrammar`, `PlantGeometryCompiler`, `PlantLodCompiler`, `PlantRenderPools`, `PlantWind` | `/` curated and/or Coordinate Explorer. `WorldDomain` is `FND-08`'s query interface: both runtimes implement it (`GeoWorld` and `CuratedDomain`) and both players traverse through it. `ActionRegistry` is `GME-05`'s single gameplay keymap and action declaration for both runtimes, and `TouchControls` renders both runtimes' on-screen controls from it |
| **Tests and audits only** | `FlatDomain`, `WorldDomainProbe`, `ResourceLedger` | `*.test.js` and `tools/visual-audit`. None is reachable from an entry point, so none ships |
| **Legacy engine** | `CollectibleManager`, `Input`, `PlayerController`, `TerrainPhysics` | `/classic.html` only |
| **Currently unreferenced** | `LerpPlayerController`, `Renderer`, `StateManager` | No entry point mounts them. `StateManager` is the loader for `public/content/states/*.json` and now enforces the `CNT-01` content schema (migrate, validate, reject by name), but nothing imports it, so the validator is tree-shaken and ships **zero bytes** today. `ContentSchema` reaches the tree only through that dormant loader |
| **Tests and audits only** | `FlatDomain`, `WorldDomainProbe`, `ResourceLedger` | `*.test.js` and `tools/visual-audit`. None is reachable from an entry point, so none ships |

`src/world/`, `src/ui/`, the legacy `src/engine/` modules, and `src/network/` are reachable only from `/classic.html`. New gameplay work belongs in `src/geo/` (coordinate) or `src/reference/` (curated), not in those folders.

> The files in `public/content/states/` are versioned state packs (`schemaVersion: 1`) and each one validates against `src/engine/ContentSchema.js`, in Node and again over the dev server in the browser tier — including a SHA-256 check that the bytes served are the bytes validated. They are still **not mounted by either live runtime**: the `StateManager` that loads them enforces the schema but is imported by no entry point, so the content pipeline's remaining work is `CNT-02` (recipe compiler), `CNT-03` (authoring/preview tool) and `CNT-04` (packs) in the [feature roadmap](./feature-roadmap/README.md) — see also `VISUAL_GATES.md` §4 A4f for the recorded gap and `PROJECT_AUDIT.md` for the original migration plan.

### Local Development Setup
1. **Clone the repository**:
   ```bash
   git clone https://github.com/your-org/thegreatdesiodyssey.git
   cd desi-odyssey
   ```
2. **Install dependencies**:
   ```bash
   npm install
   ```
3. **Start the development server**:
   ```bash
   npm run dev
   ```
4. Open your browser to `http://localhost:5173`.

### Deployment
This project is a static site and can be deployed easily to Vercel, Netlify, or GitHub Pages.
```bash
npm run build
```
Upload the resulting `dist/` folder to your hosting provider.

---

## 🚀 Roadmap & Future Expansion

*   **New States**: Punjab (Golden Temple), Delhi (India Gate), West Bengal (Howrah Bridge), and Tamil Nadu (Meenakshi Temple).
*   **Multiplayer**: WebSockets integration to see other players' avatars exploring the map.
*   **Audio**: Chiptune-style regional background music and 8-bit sound effects (e.g., train horns, item pickup chimes).
*   **Meme Unlocks**: Collect rare items to unlock avatar skins (e.g., "Bhupendra Jogi" shades or a "Gamcha" cape).

---

## 💬 Community

We’d love to have you in our community! Come hang out, share your voxel creations, report bugs, or just share your favorite desi memes with us.

[**Join our Discord Server**](https://discord.gg/wCgUdZppd) 🚀

---

## ⚖️ License & IP Notice

**Copyright © 2026 pixellon.in. All Rights Reserved.**

While the source code for *The Great Desi Odyssey* is made publicly available to encourage open-source community contributions, learning, and collaboration, **all commercial rights, intellectual property, branding, trademarks, and game assets belong strictly to pixellon.in**. 

You may fork this repository for personal, non-commercial use or to submit pull requests back to the main project. However, you may not monetize, re-distribute, or re-publish this game or its underlying engine as your own product without explicit written permission from the IP holders.
