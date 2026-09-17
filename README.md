<div align="center">
  <img src="https://via.placeholder.com/150/FF9933/FFFFFF?text=GDO" alt="The Great Desi Odyssey Logo" width="120" height="120">
  
  # THE GREAT DESI ODYSSEY 🇮🇳

  **A 3D Voxel Journey Across Indian States, Landmarks & Meme Lore.**

  [![Build Status](https://img.shields.io/badge/build-passing-brightgreen)](#)
  [![License](https://img.shields.io/badge/license-Custom-blue.svg)](#license--ip-notice)
  [![Vite](https://img.shields.io/badge/vite-%5E5.4.0-646CFF?logo=vite&logoColor=white)](#)
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

Both the curated adventure and Coordinate Explorer now start through the same procedural-engine surface and share colour management, atmospheric sky, lighting recipes, renderer ownership, and teardown. They also consume one versioned generated material allocation: seamless 64×64 packed surface noise, a guttered 24-layer semantic mask atlas, 8×8 R8 dither, a 32×8 sRGB palette LUT, and the shared 128×128 water normal. The mip-aware estimate is 175,852 bytes, below the 256 KiB low-profile ceiling. Browser generation yields in bounded startup slices after roads-first work can be queued, and the last engine reference disposes every texture. Ground, roads, facades, water, curated voxel families, and reusable roof/bark/leaf recipes share these channels; derivative and distance fades suppress subpixel detail without weather-driven shader recompilation. The required moving low-DPR shimmer capture is still pending because browser capture tooling is unavailable.

The vegetation pipeline is versioned in seven independent stages. `PlantGrammar.js` compiles normalized broadleaf, palm, shrub, herb, grass, and bamboo skeleton IR from path/channel hashes. `PlantGeometryCompiler.js` bakes shared skeleton modules into indexed exposed-face typed arrays without runtime CSG. `PlantLodCompiler.js` derives near/mid/far geometry from one skeleton under family-specific box caps, preserving its pivot, envelope, bounds, palette topology, and placement anchor. Low thresholds use each plant's own yawed projected width/height at 96/32/6 pixels, an 18% hysteresis band, stable eight-slot reevaluation staggering, and at most 4 Hz updates unless the focus cell changes; no tile-wide bounding sphere decides plant detail. `PlantRenderPools.js` uploads these tiers into global family/LOD `InstancedMesh` pools shared by all resident coordinate tiles. Each pool record retains its source owner and stable placement ID; eviction removes that owner's records and deterministically repacks sorted survivors. The two low archetype variants share each family/LOD draw through paired exposed-face vertex streams plus a custom variant selector, while custom palette and normalized age/stiffness/phase attributes avoid Three's constrained-driver `instanceColor` path. `PlantClearance.js` derives actual base, root, and crown extents from the same recipes and tests anchors against exact building rings, route reservations, terrain/water support, and mapped land kind instead of one universal halo. Crowns may overhang road verges and non-solid ground cover; near-building crowns use no more than 16 deterministic envelope samples and one custom scale/shift attribute for branch, frond, blade, leaf, and flower vertices without moving the source-owned anchor.

`PlantMorphology.js` replaces source-tile biome switches with a browser-local continuous artistic profile. Latitude and smoothly interpolated 6,400-unit absolute-coordinate anomalies establish broad fallback temperature/moisture, then deterministic terrain response, mapped land kind, signed water/wetland distance, and bounded local road/building proximity blend tropical, subtropical, arid, upland, riparian, and urban influences at each candidate. These labels guide broad silhouettes and are not scientific climate or exact-species claims. One aligned 13-byte record retains the dominant three IDs and quantized weights plus conservative nonuniform aspect/height, two-variant recipe choice, palette, age, and stiffness; density and family choice come from the same weights. Morphology composes with the exact clearance envelope before acceptance, and all coordinate sessions share one fixed versioned recipe library rather than compiling per tile or coordinate. Exactly one near/mid/far pool—or no pool beyond the cull threshold—owns each plant. LOD repacks are event-driven. `PlantWind.js` owns one versioned world-aligned 2D field with low-frequency smoothed gust/turbulence, a wrapping precision-safe clock, malformed-input fallback, and system/in-game reduced-motion state. `PlantRenderPools.js` composes height and packed bend/root roles with stable per-instance phase/stiffness in the vertex shader, reserves a bounded culling margin, and leaves plant anchors, clearances, collision/support truth, and instance matrices unchanged. Ordinary wind frames write at most one shared clock uniform, zero vegetation matrices, and zero steady-frame wind allocations; reduced motion removes gust/turbulence and retains only capped calm sway. Independent branch-group/detail wind remains deferred to `VEG-10`. Optional plant compilation/upload is scheduled only after the tile's roads/buildings/collision phase is usable. The provider-equivalence fixture mounts 1,044 plants as 11 active global pools over 36 source geometries, 208,452 static GPU-geometry bytes, and 11,190 visible plant triangles, with a four-draw delta over the replaced tile-local families.

Edge-directed prefetch still keeps no more than four chunks resident and two requests active. No map API key is required; visible attribution remains in the game view. Coordinate mode also includes a disabled-by-default **Debug**/`F3` overlay for exact proxy bounds, query masks, tile owners, support levels and slots, environment profile IDs/quantized weights, morphology/LOD/wind counters, water class/flow/byte fields, selected building/road-test/box/triangle/byte counters, worker timings, live low-profile budget status, and material dimensions/formats/bytes/checksums. Its implementation is lazy-loaded on demand, uses one capped line draw only while enabled, and can be preselected with `?debug=1`.

See [`MAP_STREAMING_RESEARCH.md`](./MAP_STREAMING_RESEARCH.md) for the evaluated sources, policy constraints, scale math, architecture, and limits. The audited missing-feature catalogue, implementation priorities, budgets, and staged roadmap are in [`PROCEDURAL_WORLD_FEATURE_RESEARCH.md`](./PROCEDURAL_WORLD_FEATURE_RESEARCH.md). The focused art-direction, procedural-variation, biome, vegetation, weather, lighting, and environment-effects plan is in [`VISUAL_BIOME_BEAUTIFICATION_RESEARCH.md`](./VISUAL_BIOME_BEAUTIFICATION_RESEARCH.md). The minimal character collision, terrain/bridge/water interaction, bounded ragdoll, engine comparison, physics budgets, and acceptance plan are in [`MINIMAL_PHYSICS_RESEARCH.md`](./MINIMAL_PHYSICS_RESEARCH.md).

The follow-up correctness plan for player/camera clipping, non-oversized role-specific proxies, transparent/depth behavior, procedural intersections, automatic surface/render/query layers, and exact tile ownership is in [`CLIPPING_AND_LAYERING_RESEARCH.md`](./CLIPPING_AND_LAYERING_RESEARCH.md). The locally generated texture catalogue, deterministic fractal vegetation compiler, smaller-box LOD/face budgets, wind grouping, and modular detail grammars for buildings, street objects, rocks, vehicles, bridges, landmarks, and props are in [`PROCEDURAL_TEXTURES_AND_SMALL_BOX_GRAMMARS_RESEARCH.md`](./PROCEDURAL_TEXTURES_AND_SMALL_BOX_GRAMMARS_RESEARCH.md).

The combined status matrix, task categories, dependency-ranked canonical build order, active work, and completion gates are maintained in the [`feature-roadmap`](./feature-roadmap/) folder. Every implementation batch must update its [`CHANGELOG.md`](./feature-roadmap/CHANGELOG.md).

---

## 🎮 Controls & UI Guide

| Action | Keybinding |
| :--- | :--- |
| **Move** | `W`, `A`, `S`, `D` or Arrow Keys |
| **Look Around** | Mouse (GTA-style pointer lock) |
| **Jump** | `Spacebar` |
| **Coordinate camera** | `V` or `C` switches FPP/TPP (FPP is default) |
| **Coordinate diagnostics** | `F3` or the **Debug** button toggles query/layer/budget overlays |
| **Interact / Board Boat** | `E` |
| **Aerial Map** | `M` (Opens a real-time tracking blueprint) |
| **Fast Travel** | `T` (Opens the directory for instant teleportation) |

*Note: Clicking anywhere on the game canvas locks your mouse. Press `ESC` to unlock. Mobile devices get a flexible left-side movement joystick plus translucent Run, Jump, and FPP/TPP controls on the right.*

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
│   ├── geo/                # Coordinate projection, MVT worker, streaming world, and controls
│   ├── reference/          # Current curated game runtime, rendering, UI, and tests
│   ├── engine/             # Shared lifecycle, generated materials, plant grammar, sky, palette, and lighting
│   ├── world/              # Legacy Classic Explorer world
│   ├── ui/                 # Legacy UI and shared docs renderer
│   └── network/            # Experimental, currently disconnected WS client
├── index.html              # Current optimized game
├── classic.html            # Preserved legacy explorer
└── package.json
```

> The files in `public/content/states/` are experimental schemas and are not yet consumed by the current runtime. See `PROJECT_AUDIT.md` for the migration plan.

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
