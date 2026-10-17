# Visual, Biome, and Environment Beautification Research

**Research date:** 2026-09-16
**Target:** an original Minecraft/Roblox-inspired coordinate world that is beautiful, geographically grounded, deterministic, browser-local, and usable on low-end mobile hardware.
**Implementation checkpoint:** 2026-09-17 — `VEG-08` implements the continuous artistic vegetation-profile, dominant-three transfer, correlated morphology, mapped hydrology/land/human modifiers, fixed recipe cache, and automated seam/budget gates described here. `VEG-09` adds bounded whole-plant GPU wind, stable phase/stiffness response, reduced-motion fallback, and zero-matrix/uniform/allocation gates. `TER-08` now supplies compact provider-neutral stream/canal/river/lake/ocean classes plus truthful mapped waterway and bounded associated polygon flow; lakes/oceans stay still. `DET-04` adds one bounded focus-tile batch of selected road-facing facade and exact-slot roof relief while leaving ordinary facade detail analytical. Branch-detail wind, `ENV-03` visual water classes/waves/foam, weather, broader environment uniforms/object families, and moving browser visual audits remain pending.

## Programmatic verification policy (supersedes browser capture)

**Status:** browser capture tooling is retired as a project dependency. Automated Chromium installation, screenshots, and video are deleted from the acceptance gates, and no checkpoint below may remain `PARTIAL`/`DEFERRED` because of them; the historical notes that say "capture unavailable" are kept as dated history.

The evidence a moving capture used to provide is produced deterministically instead:

- `src/engine/MovementAudit.js` — fixed-step scripted paths over the real runtime with verdicts for determinism, clipping (camera clearance against real blockers), render-band ordering, LOD/resident churn, subpixel/mip/fade, and per-step stability. Failure reports name the verdict, path, and sample index.
- `src/engine/DebugHooks.js` — `window.__gdo` exposes `probe()`, `ledger()`, `step(dt, steps)`, `log.text()`, and `audits.run('movement')`, with a bounded `[gdo:*]` log ring a test can read back.
- `src/engine/LifecycleContract.js` — one owner-scoped ledger proves zero-growth remount and names any leaked worker, listener, geometry, material, mesh, node, timer, or handle.

A moving claim is accepted when those reports pass on the real runtime and the numbers are recorded in the roadmap changelog. Human viewing remains useful, but it is not a gate.

## 1. Recommendation in one sentence

Do not beautify the world by scattering unrelated objects everywhere. Build a **continuous environmental profile** that coordinates palette, silhouettes, plant communities, materials, light, water, atmosphere, weather, and ambient motion at three spatial scales.

```text
real map facts + optional public climate/elevation context
                      ↓
continuous climate and biome influences
                      ↓
land-cover / water / urban local modifiers
                      ↓
coherent palette + shape + material + placement grammar
                      ↓
time, weather, wind, wetness, particles, and ambient life
```

The current world is already dense. Its next visual leap should come from **cohesion, depth, recognizable silhouettes, and correlated variation**, not simply a higher instance count.

## 2. Visual audit of the current implementation

### Strengths worth preserving

- A consistent warm, blocky visual language shared by curated and coordinate modes.
- ACES filmic tone mapping, sRGB output, a hemisphere fill, and a warm directional sun.
- A procedural gradient sky with sun glow and block-cloud cells.
- Rough, mostly matte materials that fit voxel and low-poly forms.
- Road hierarchy, curb bands, markings, crosswalk hints, and aggregate variation.
- Mapped land/water surfaces and facade-shaded mapped building masses.
- Dense herbs and grass with larger trees, palms, shrubs, flowers, rocks, lamps, benches, cars, birds, and bees.
- Deterministic multi-octave vegetation patches and exact obstacle filtering.
- Instancing and merged geometry instead of one draw call per object.
- Strong low-resource discipline: no default shadows, SSAO, PMREM, texture downloads, or post-processing.

### Specific limitations visible in the code

1. **The original biome state was a tile label, not a continuous field.** `VEG-08` removes `chooseBiome()` from plant decisions and point-samples a continuous profile; a dominant blended tile summary remains only for UI/global ground targeting, whose colour now approaches changes at 10 Hz. Fully position-sampled global environment uniforms remain future work.
2. **Most mapped land colours are globally fixed.** A forest polygon still uses the same authored vertex base colour in a wet tropical place, a Himalayan valley, and a northern temperate location.
3. **The original path used one geometry per detail family.** Coordinate plants now select between two globally cached low archetypes and apply correlated nonuniform morphology, palette, and age traits. Broader hero silhouette catalogues remain gated by the existing draw/source limits.
4. **Plant families still share one material efficiently.** `VEG-08` supplies per-instance palette and stiffness, and `VEG-09` now consumes stiffness/phase plus packed bend/root metadata for whole-plant GPU wind. Season tint, wetness, branch-detail wind, and broader environment material response remain pending.
5. **The facade grid is globally procedural.** It adds detail cheaply, but does not understand each building's wall length, floor count, road-facing side, entrance, building type, or local architectural grammar.
6. **Surfaces do not feel grounded.** Shadows are off and there is no substitute contact darkening under buildings, trees, cars, benches, or the avatar.
7. **Sky, sun, fog, and clouds are static.** They cannot communicate biome, humidity, time, season, dust, rain, or altitude.
8. **Water has one colour family and undirected ripples.** It lacks banks, shallow/deep colour, river flow, shore foam, reflection tint, wetland detail, and weather response.
9. **Roads are unlit `MeshBasicMaterial`.** This keeps markings readable, but roads do not respond to day/night, rain, wetness, dust, or nearby environment palette.
10. **Ambient plant motion is absent.** Birds and bees update instance matrices on the CPU; vegetation remains static even when the sky implies wind.
11. **Detail has weak hierarchy.** Dense cover fills space, but landmark areas, vistas, clear paths, ecological clusters, and calm negative-space pockets are not composed differently.
12. **There is no quality-scaled effects layer.** Rain, snow, dust, pollen, leaves, fireflies, lightning, heat shimmer, emissive night detail, and seasonal overlays are missing.

## 3. Research conclusions

### 3.1 Beauty comes from relationships

The most convincing procedural environments correlate their decisions:

- water → moist soil → reeds → insects → birds → mist;
- canopy → shade → sparse grass → mushrooms/leaf litter;
- dry climate → dusty palette → thorn silhouette → heat haze → low cloud cover;
- rain → dark ground → stronger ripples → dripping roofs → muted distant fog;
- road class → curb/sidewalk → lamp/sign family → traffic density;
- mapped POI → landmark silhouette → accent colour → denser authored detail pocket.

Independent random rolls produce variety but not believability. Each visual property should read from shared environmental fields.

### 3.2 Use three scales of variation

| Scale | Typical extent | Controls | Example |
|---|---:|---|---|
| Macro | 2–100+ km | climate family, dominant hues, cloudiness, seasonality, species pool | humid subtropical plain vs hot desert |
| Meso | 20–500 m | groves, fields, wet pockets, settlement character, colour districts, vistas | orchard block beside a village |
| Micro | 0.2–10 m | instance height, crown asymmetry, flower colour, rock rotation, wear | three visibly different trees in one grove |

The current generator has good meso-scale vegetation noise and micro-scale transforms, but needs a better macro climate foundation and more meaningful micro morphology.

### 3.3 Use layered influences, not one giant biome enum

A single enum such as `tropical` cannot describe a tropical city park beside a mangrove channel during a dry morning. Compose the environment from independent axes:

```text
macro climate      tropical seasonal, subtropical, hot arid, temperate…
terrain modifier   lowland, plateau, foothill, mountain, alpine…
hydrology          dry, riparian, wetland, coast, delta…
map land cover     forest, cropland, orchard, scrub, park, built-up…
human intensity    wild, rural, village, suburban, urban, industrial…
season/time        month, phenology, solar phase…
weather state      clear, haze, cloud, rain, storm, dust, snow…
```

This cross-product creates thousands of coherent combinations without authoring thousands of monolithic biome definitions.

### 3.4 Preserve a style bible

Stylized rendering still needs constraints. The GDC material research reviewed for this pass emphasizes deliberate colour choice and documented material rules even when physically based shading is used. A small visual contract will prevent procedural variation from turning into visual noise.

Recommended contract:

- Chunky geometric silhouettes; no imported photoreal assets.
- Matte materials dominate; metal/glass are rare accents.
- A controlled environment palette with primary, support, neutral, and accent slots.
- Dark roads and trunks anchor the image; sky and open ground remain lighter.
- Important landmarks receive the highest saturation and silhouette contrast.
- Texture frequency decreases with distance.
- No feature may create a draw call per instance.
- Motion has a shared wind rhythm; everything does not oscillate independently.
- Atmospheric depth replaces long-distance micro-detail.
- Generated detail clusters around ecological and mapped reasons, while traversable corridors remain clear.

## 4. Proposed continuous environment model

### 4.1 Environment sample

Every world point should be able to obtain a compact sample:

```js
{
  temperature: 0.0,      // cold → hot
  moisture: 0.0,         // dry → saturated
  seasonality: 0.0,      // stable → strong seasonal swing
  elevation: 0.0,        // normalized local/absolute context
  ruggedness: 0.0,
  coast: 0.0,
  riparian: 0.0,
  canopy: 0.0,
  fertility: 0.0,
  human: 0.0,
  urban: 0.0,
  pollutionDust: 0.0,
  biomeWeights: [/* top 3 IDs and weights */],
  landKind: 'cropland',
  seasonPhase: 0.0,
  weatherState: 'haze'
}
```

Only the dominant three biome influences need to be transferred to rendering. Most generation decisions can derive in the worker from quantized byte fields.

### 4.2 Baseline with no extra request

The required fallback can be generated from data already available:

- Latitude supplies a broad solar/temperature baseline.
- Stable low-frequency coordinate noise supplies a small climate anomaly, not a new false geography.
- Mapped water count and point-to-water distance influence moisture.
- Mapped forest, wetland, sand, farmland, park, and built-up classes strongly override local surface use.
- Building/road density estimates human intensity.
- Optional DEM modifies temperature and ruggedness if available.
- The selected world date controls a deterministic seasonal phase.

This is not a scientific climate model and must be described as an art-direction fallback. It is still better than abrupt source-tile biome selection because it is continuous and map-constrained.

### 4.3 Optional geographic enrichment

| Dataset | What it adds | Fit | Decision |
|---|---|---|---|
| RESOLVE Ecoregions 2017 | 846 ecoregions grouped into 14 terrestrial biomes | Global, CC BY 4.0, vector/WMS | Strong candidate for a project-built, aggressively simplified low-zoom biome lookup |
| ESA WorldCover 2021 v200 | 10 m tree, shrub, grass, cropland, built-up, sparse, snow/ice, water, wetland, mangrove, moss/lichen classes | Global, free with attribution, COG + public WMTS; reported 76.7% overall accuracy | Optional sparse-map enrichment; do not request for every tile until endpoint/CORS/cache budgets are audited |
| NASA POWER climatology | Monthly temperature, precipitation, humidity, wind, solar values for a coordinate | No-key public API, JSON/CSV; 429 responses possible | Optional one request per starting climate cell, cached; never block world loading |
| Terrarium DEM | Elevation and slope | Strong visual value; public/best effort | Optional and separately attributable, as already researched |
| WorldClim | Fine global climate surfaces | Good scientifically | Do not use by default: official terms restrict commercial use/redistribution without permission |
| Published Köppen–Geiger rasters | Direct climate class | Useful | Audit each release's licence and redistribution terms before bundling; “freely downloadable” is not enough |

A recommended eventual production asset is a very small versioned lookup created from RESOLVE's 14 biome classes, simplified and tiled by the project. It should select a **macro species/palette pool only**. Mapped local land cover must still determine what is actually on the ground.

### 4.4 Blending and continuity

- Evaluate macro climate at a grid much larger than an MVT tile and interpolate.
- Select the three nearest profile prototypes in climate space.
- Blend colour, fog, density, and effect probabilities continuously.
- Choose discrete geometry recipes with stochastic weights from that blend.
- Use world coordinates for all fields so source-tile edges share samples.
- Let map polygons apply smooth local modifiers near boundaries where feasible.
- Transition global sky/fog/light uniforms over 1–3 seconds when the focus environment changes; never snap shared materials at a source-tile boundary.

## 5. Biome and modifier art direction

### 5.1 Macro climate profiles

These profiles are artistic families, not claims about exact real vegetation species.

| Profile | Ground/value | Dominant silhouettes | Colour accents | Typical atmosphere |
|---|---|---|---|---|
| Tropical wet | deep warm green, dark soil | layered broadleaf canopy, palms, lianas, ferns | saturated flowers, turquoise water | humid blue-green haze, tall clouds, frequent rain |
| Tropical seasonal | olive/ochre grass and red-brown soil | open broadleaf, umbrella crowns, bamboo pockets | dry gold + fresh green | bright sun, seasonal dust or monsoon rain |
| Humid subtropical | medium green/alluvial earth | rounded broadleaf, orchard trees, tall crops | mustard, marigold, painted urban accents | warm haze, monsoon clouds, fireflies |
| Semi-arid thorn | pale olive, stone, dusty clay | thorn trees, scrub clumps, succulents | faded yellow/red | dry haze, gusts, sparse clouds |
| Hot desert | sand/terracotta with dark rock | sparse shrubs, cactus-like forms, dune grass | rare bright blooms | strong horizon haze, heat shimmer, dust |
| Warm temperate | balanced green/brown | mixed broadleaf, meadow, hedges | seasonal flowers | softer sun, layered clouds, rain |
| Cool temperate | cool green/grey earth | dense broadleaf/conifer mixture | moss, berries, leaf colour | mist, lower cloud base, drizzle |
| Boreal | blue-green, dark peat | narrow conifers, birch-like trunks | lichen, pale grass | cool fog, low sun, snow |
| Polar/tundra | stone, moss, snow | ground-hugging shrubs, no tall canopy | small flowers/lichen | long shadows, blowing snow, clear cold air |

### 5.2 Terrain and hydrology modifiers

| Modifier | Surface changes | Element changes | Effects |
|---|---|---|---|
| Riparian | dark moist band, eroded bank | reeds, overhanging trees, insects, birds | mist pockets, stronger water sound |
| Wetland | mud/water mosaic | sedges, reeds, lotus/lily families, frogs/fireflies | low fog, reflective patches |
| Mangrove/delta | saturated mud, shallow channels | root-like trunks, dense shrubs | insects, birds, humid haze |
| Coast/beach | dry-to-wet sand bands, shells/pebbles | dune grass, palms where climate permits | foam line, salt haze, stronger wind |
| Floodplain | fertile alluvium | crops, tall grass, scattered trees | morning mist, seasonal water |
| Rocky plateau | exposed stone plates | low scrub, boulder groups | dust gusts, wide visibility |
| Mountain | rock/soil bands by slope | altitude-dependent tree forms | cloud wisps, cool fog, waterfalls |
| Alpine | scree, short turf, snow pockets | ground plants, no broad canopy | fast clouds, snow grains |

### 5.3 Human-use modifiers

| Modifier | Composition rule |
|---|---|
| Cropland | aligned field rows, 2–4 crop stages, irrigation edge, occasional scarecrow/hay/water pump |
| Orchard | regular but jittered tree rows; low grass and fallen fruit/flowers |
| Village | irregular shade trees, courtyards, walls, utility poles, painted doors, roof tanks |
| Residential | road-facing entrances, balconies/awnings, mixed wall colours, street trees, parked two-wheel/vehicle forms |
| Urban core | stronger facade rhythm, signs, wires, lamps, traffic props, fewer but deliberate plants |
| Industrial | cooler/desaturated base, broad roofs, tanks/vents, gravel, fencing, sparse hardy vegetation |
| Park/garden | paths remain clear; designed clusters, benches, flower bands, specimen tree focal points |
| Sacred/civic site | recognizable silhouette, cleaner visual radius, one controlled accent palette, approach axis |

### 5.4 India-focused combinations

The global layered model naturally supports distinct Indian looks without hard-coding a country theme:

- Indo-Gangetic plain = humid-subtropical macro + floodplain + cropland/village + warm haze.
- Thar/Rajasthan = hot-desert macro + rocky/sandy modifier + village/fort colour accents + dust.
- Central dry forest = tropical-seasonal macro + semi-arid transition + mapped forest/scrub.
- Western Ghats = tropical-wet macro + mountain + dense mapped forest + mist/rain.
- Himalayan foothills = humid-subtropical/cool-temperate blend + mountain + riparian valleys.
- High Himalaya = cool-temperate/boreal/alpine gradient + rugged DEM + snow/wind.
- Sundarbans/delta = tropical-wet + mangrove/delta + tidal-looking channels + birds/insects.
- Kerala/coastal west = tropical-wet + coast + palms/wetlands + heavy monsoon state.
- Deccan plateau = tropical-seasonal/semi-arid blend + rocky plateau + dry crops and thorn scrub.

## 6. Element library to research and build

The goal is a compact **procedural kit**, not hundreds of imported models.

### 6.1 Ground and terrain elements

- Soil families: alluvial, red/lateritic, dark cotton-like soil, pale dust, peat/mud, sand, gravel, scree.
- Ground motifs: cracked dry cells, damp mottling, tiny stones, leaf litter, petals, needles, crop stubble, moss patches.
- Slope motifs after DEM: exposed cliff face, strata bands, talus fans, terraces, retaining walls.
- Surface borders: grass-to-road verge, curb dirt, building plinth stain, field bund, shore wet band.
- Procedural paths through parks/fields, constrained by mapped roads and clear traversal.
- Puddles in concave/flat areas represented by sparse opaque/dithered or tightly bounded transparent quads.

**Cheap technique:** continue world-space procedural material detail, but expose environmental uniforms for soil tint, patch scale, wetness, snow/sand overlay, and growth amount. Use generated 32–128 px noise/data textures only where they outperform shader hash and keep them shared globally.

### 6.2 Tree morphology families

1. Rounded broadleaf with 2–5 crown masses.
2. Spreading banyan-like/fig-like canopy with optional roots.
3. Tall sal/teak-like upright broadleaf.
4. Umbrella/acacia-like dry canopy.
5. Coconut/date/fan palm variants.
6. Bamboo clump made from several narrow stems.
7. Conical conifer with 3–6 tier profiles.
8. Narrow high-altitude conifer.
9. Mangrove/rooted wetland form.
10. Orchard form with compact regular crown.
11. Thorn tree with sparse branch boxes.
12. Dead snag/stump as a low-frequency ecological detail.

Each family needs only 2–4 compiled shared geometries. Further variation comes from non-uniform scale, crown aspect, trunk lean, missing crown pieces, palette index, age, and wind stiffness.

### 6.3 Understory and small plants

- Ferns, broad-leaf ground plants, reeds/sedges, bamboo shoots.
- Lotus/lily pads and emergent flowers constrained to water.
- Dry scrub, thorn bush, succulent/cactus-like forms.
- Meadow wildflowers in 4–6 palette slots.
- Mushrooms and leaf litter under sufficient canopy/moisture.
- Crops: rice/paddy-like tufts, wheat/millet-like stalks, sugarcane-like stems, mustard-like flowers, orchard understory.
- Climbers/vines only on selected building walls, fences, and tropical trunks.
- Fallen leaves/petals as flat opaque geometry rather than many transparent particles.

### 6.4 Rocks and geology

- Rounded boulder, angular split rock, stacked strata, flat plate, pebble patch, river stone.
- Colour from soil/geology palette with sun-facing top lightening.
- Cluster rule: one hero rock plus 2–5 smaller satellites, rather than uniform independent rocks.
- Align strata to slope/terrain field and river stones to water tangents.

### 6.5 Water-edge elements

- Wet/dry bank strips.
- Reeds, mud, pebbles, roots, driftwood, shells, foam segments.
- Pier/ghat/steps where mapped POI/site context supports them.
- Lily/lotus groups only in still freshwater; never in ocean or fast river classes.
- Small fish-shadow or ripple rings as bounded instanced geometry.

### 6.6 Urban beauty elements

- Sidewalk slabs, gutters, drains, bollards, bins, hydrant/utility boxes.
- Utility poles with wire **suggestions** limited to short spans and high profiles.
- Street vendors/kiosks/tea-stall silhouettes near suitable POIs, not arbitrary factual claims.
- Walls/fences/gates around mapped sites.
- Painted doors, awnings, balconies, jali-like screens, roof shade frames, solar panels, tanks.
- Building base stains, rooftop parapet variation, facade trim bands, corner accents.
- Bus shelters, station signs, park gates, playground equipment, sports markings.
- Small flags/bunting only for suitable site/event recipes; avoid religious/political inference from weak data.

### 6.7 Ambient life silhouettes

- Butterflies near flowers, dragonflies near wetland, fireflies in humid dusk.
- Water birds near broad water, small birds by trees/buildings, pigeons in dense urban areas.
- Cattle/goats/chickens only in pasture/farm/village activity zones.
- Dogs in settlement zones with very small caps.
- Fish schools inside water polygons.
- All fauna use pooled, instanced, highly simplified motion and habitat anchors.

## 7. Variation grammar

### 7.1 Correlated random channels

Do not derive every property from the same hash value. Allocate stable channels:

```text
feature identity
  ├─ silhouette channel
  ├─ age/size channel
  ├─ palette channel
  ├─ asymmetry channel
  ├─ material/wear channel
  ├─ seasonal channel
  └─ animation phase/stiffness channel
```

Changing the palette algorithm must not alter position or collision. Every channel remains namespaced by procedural-world version and pass ID.

### 7.2 Variation without draw-call explosion

Recommended techniques in order:

1. **Transforms:** non-uniform scale, lean, yaw, crown/trunk proportion encoded in matrices.
2. **Custom instanced attributes:** compact normalized bytes for palette index, wind phase, stiffness, age, and variant selector.
3. **Compiled geometry variants:** 2–4 silhouettes per family; instances are sorted into these few shared geometries.
4. **BatchedMesh investigation:** Three.js `BatchedMesh` is designed for many different geometries sharing a material and can reduce draws when different silhouettes are needed.
5. **Shader omission:** hide optional crown/branch modules using a variant attribute where the geometry remains cheap.
6. **Distance recipes:** near variant has branch/crown modules; far variant keeps one trunk and one crown silhouette.

`InstancedMesh.instanceColor` previously rendered black under the constrained SwiftShader audit, so do not depend on it. A custom `InstancedBufferAttribute` may avoid that path, but must first pass the same constrained-browser fixture. Keep a deterministic geometry/palette-bucket fallback.

### 7.3 Palette variation rules

- Store authored palette slots in sRGB-friendly forms, convert once to linear values before putting colours into buffer attributes.
- Vary lightness more than hue within one material family.
- Share shadow and highlight bias across a biome so objects belong to the same light world.
- Use one rare saturated accent per visual pocket.
- Wetness lowers diffuse value and slightly raises controlled specular response; it does not simply turn everything black.
- Distant colours approach the environment fog/horizon colour.
- Night does not equal a blue multiplier over everything: lower sky/sun contribution, preserve warm emissive accents, and maintain navigation contrast.

Three.js's colour-management documentation is important here: material/light/shader working colours and vertex colours operate in Linear-sRGB, while display output is sRGB. The existing comment about linear buffer colours should become an enforceable palette utility with tests.

## 8. Lighting and depth improvements

### 8.1 Highest-value low-cost changes

| Technique | Visual gain | Runtime cost | Recommendation |
|---|---|---:|---|
| Environment-driven sun/hemi/fog colours | Cohesion and time/biome mood | tiny uniform updates | P0 |
| Hemisphere-normal wrap tint | Softer readable foliage/building shade | few shader ops | P0 |
| Per-vertex/build-rule self-occlusion | Facade corners, roofs, tree crowns read better | worker generation + vertex byte | P0 |
| Instanced contact ellipses | Grounds trees, cars, benches, fauna | 1 opaque/dithered draw per tile/profile | P0 prototype |
| Height/distance atmospheric tint | Depth without post-processing | few shader ops | P0 |
| One tight local shadow map | Strong dynamic depth | extra scene render | Balanced/high only, P2 |
| SSAO/post-processing | Broad contact depth | full-screen bandwidth and extra pass | Not default; likely omit |
| Screen-space outlines | Graphic style | extra pass/edge artifacts | Do not prioritize |

The low profile should fake grounding instead of enabling full shadow maps. Possible methods:

- Darken building wall bottoms and inward corners in generated vertex data.
- Add one instanced flattened dark polygon/ellipse beneath selected props.
- Encode crown-interior darkness and lighter top planes directly in geometry colours.
- Use terrain proximity fields to subtly darken ground near large mapped buildings, if it can be generated without expensive pairwise tests.

The INSIDE rendering research is relevant not because this game should copy its look, but because it demonstrates that carefully separated diffuse/specular/bounce contributions and analytic primitive occlusion can provide high fidelity without relying only on conventional expensive effects.

### 8.2 Toon/PBR balance

Keep `MeshStandardMaterial` for broad light response, but stylize it:

- quantize only a small part of diffuse response, avoiding harsh two-band shadows;
- add a warm sunlit bias and cool sky-facing bias;
- keep roughness high and metals rare;
- use a subtle wrap term for plant leaves and small voxel forms;
- use rim/horizon lighting only for hero landmarks or weather silhouettes;
- avoid a global black outline that would clutter dense cities and grass.

A full `MeshToonMaterial` conversion is not automatically better. Test a three- or four-step generated gradient map on plants and hero props while keeping terrain/buildings softly lit.

## 9. Sky, time, weather, and environment effects

### 9.1 Dynamic sky model

Turn the current fixed sky shader into a shared uniform-driven model:

```text
sun direction and elevation
horizon / zenith / ground-bounce colours
humidity and aerosol/dust
cloud coverage, height, speed, darkness
star visibility and moon phase/direction
weather flash and exposure compensation
```

A full multi-sample physical atmosphere is not appropriate for low-end default. The GPU Gems atmospheric-scattering research confirms why outdoor scattering matters, but the project can preserve its fast dome and approximate the visible cues with gradients, sun disc/glow, horizon haze, and carefully tuned phase colours.

Suggested phases:

- pre-dawn cool horizon;
- warm low sun;
- neutral high daylight;
- golden late afternoon;
- saturated sunset horizon;
- blue-hour gradient;
- night with stars/moon and warm settlements.

### 9.2 Weather state machine

Weather is deterministic from macro climate + month + world-time window + coordinate weather seed. It should transition over time rather than roll independently each frame.

| State | Sky/light | Surface response | Particles/motion | Habitat response |
|---|---|---|---|---|
| Clear | high contrast, low cloud | dry | mild wind | normal birds/bees |
| Haze | bright horizon, reduced distance | dusty/desaturated distance | occasional dust motes | fewer high birds |
| Overcast | soft low-contrast light | neutral | stronger cloud motion | calmer insects |
| Rain | dark cloud base, cool light | wet roads/soil, stronger water ripples | camera-local rain, roof drip hints | birds sheltered, frogs/insects possible |
| Storm | dark sky, intermittent flash | wet | stronger gusts, sparse lightning | suppress ordinary flyers |
| Dust | warm low visibility | dust overlay | low opaque/dithered gust strips | suppress insects |
| Snow | cool low sun/overcast | snow overlay on upward faces | sparse camera-local flakes | reduced small life |
| Mist | low contrast near water/valley | damp | no dense full-screen particles | water/wetland emphasis |

### 9.3 Wind

GPU Gems vegetation research supports a suitable low-resource design:

- one global 2D wind vector and strength;
- low-frequency gust plus higher-frequency turbulence;
- displacement grows with normalized vertex height;
- per-instance phase and stiffness avoid synchronized motion;
- trunk/main bend and leaf/detail bend can have separate simulation LODs;
- distant vegetation keeps only slow main bend;
- nearby grass and leaves get a small detail wave;
- no per-plant CPU transform update.

Use smooth triangle waves where they are cheaper and visually adequate. Keep amplitudes low to preserve voxel shape.

### 9.4 Particles and overdraw

Transparent effects are primarily a fill-rate/overdraw problem on mobile. Therefore:

- keep effects camera-local, not tile-wide;
- use one pooled draw per effect family;
- depth-test particles and stop them behind opaque surfaces;
- kill particles extremely near the camera;
- prefer narrow streaks/compact shapes to screen-sized translucent cards;
- reduce count and screen coverage before reducing simulation accuracy;
- use opaque/dithered geometry for leaves, dust strips, and distant rain where acceptable;
- never combine heavy rain, fog particles, insects, pollen, and dust simultaneously;
- disable collision and individual lights;
- scale by measured fill rate and dynamic resolution.

### 9.5 Effect catalogue

| Effect | Trigger | Cheap representation | Priority |
|---|---|---|---|
| Wind waves | all vegetated profiles | vertex deformation | P0 |
| Morning/evening ground haze | humid/dry climate + low sun | fog colour/range | P0 |
| Heat shimmer | hot dry midday | tiny horizon/road UV distortion, high profile only | P2 |
| Rain | wet weather | camera-local line mesh/points | P1 |
| Surface wetness | rain history | global material uniform | P1 |
| Dust gusts | arid/semi-arid wind | sparse moving opaque/dithered strips | P1 |
| Fireflies | humid vegetation at dusk/night | existing ambient instance approach, strict cap | P1 |
| Pollen/seed fluff | flowering season + light wind | very low count near vegetation | P2 |
| Falling leaves | temperate seasonal wind | opaque instanced leaf shapes | P2 |
| Snow | cold climate/weather | camera-local points + upward-face tint | P1 after elevation/climate |
| Lightning | storm | sky/light flash + one distant branch silhouette rarely | P2 |
| Water mist | waterfall/rapid | small localized points | P2 after DEM |
| Chimney/cooking smoke | mapped/rule-supported activity | short-lived compact billboard/voxel puffs | P2 |
| Star field | clear night | one static point draw | P1 |
| Moon | night | sky shader disc | P1 |

## 10. Water beautification

### P0/P1 techniques

1. Generate a bank/wet-edge ribbon from water boundaries.
2. Transfer waterway tangents or a compact flow direction attribute.
3. Use two wave scales: broad flow and fine wind ripples.
4. Blend shallow bank colour into deeper centre colour.
5. Tint reflection/Fresnel toward the actual horizon/sky uniform.
6. Increase ripple amplitude and darken water during rain.
7. Place reeds, rocks, lilies, roots, or foam according to water class and environment—not all together.
8. Add one sparse ripple-ring family around rain/fish/insects.
9. Keep transparency tightly bounded; broad water polygons remain one draw.

### Class-specific appearance

| Water class | Appearance |
|---|---|
| Ocean/coast | larger slow directional bands, salt haze, shore foam, deep blue/green by climate |
| River | tangent-aligned flow, bank vegetation, occasional debris/ripple |
| Canal | straighter controlled flow, built edges where urban |
| Pond/lake | low ripple, stronger sky reflection, lilies/reeds where suitable |
| Wetland | shallow mixed tint, many emergent plants, mud patches |
| Intermittent stream | dry bed/patchy water based on deterministic season state |

### Implemented semantic checkpoint (`TER-08`)

The existing `TER-07` bounded hydrology domain is now version 2. It preserves provider-neutral unknown/stream/canal/river/lake/ocean class codes per polygon and per waterway segment, quantizes normalized mapped geometry-order tangents, and assigns polygon flow only when explicit input or a touched matching flowing waterway makes that direction truthful. Lake, ocean, unmatched, degenerate, and malformed inputs remain zero-flow; no elevation-derived downstream direction is fabricated. Class survives adjacent shore/bank queries and suppressed line-ribbon overlap, while typed storage, association tests, transfer ownership, and diagnostics remain capped.

This completes the semantic prerequisite only. `ENV-03` still owns the material/shader use of these fields: class palettes, tangent-aligned waves, foam, depth tint, weather response, and moving browser visual acceptance are not implemented here. Wetland remains an ecological-domain kind rather than a fabricated open-water flow class, and intermittent/seasonal state remains future work.

## 11. Procedural composition rather than uniform filling

“Never leave large empty spaces” should not mean “give every square metre the same detail density.” A beautiful world needs visual rhythm.

### Detail-pocket generator

For each tile, create a few stable visual pockets from mapped anchors:

- landmark pocket around an important POI;
- street-life pocket near an intersection/transit/commercial cluster;
- ecological pocket near water/forest/wetland;
- rural pocket around a field edge/orchard;
- vista pocket where a road/path approaches water, mountain, or landmark.

A pocket owns:

- one dominant silhouette;
- one support cluster;
- one colour accent;
- one motion/effect accent;
- a clear approach or view cone;
- strict object and triangle budget.

This creates memorable scenes while ground-cover fields continue to prevent barren space.

### Negative-space rule

Keep these intentionally calm:

- roads and required shoulders;
- building entrances;
- route/navigation corridors;
- landmark view cones;
- water surface centre;
- small foreground breathing zones near the camera/spawn.

Calm areas still receive shader texture, short ground cover, shadows, and atmosphere; they are not visually empty.

## 12. Priority matrix

Scoring: visual impact and feasibility from 1–5; cost risk from 1 (low) to 5 (high).

| Feature | Impact | Feasibility | Cost risk | Priority |
|---|---:|---:|---:|---|
| Continuous environment profile and blended palette | 5 | 5 | 2 | P0 |
| Environment uniforms across terrain/land/building/road/water/decor | 5 | 4 | 2 | P0 |
| 2–4 silhouette variants for major tree/plant/rock families | 5 | 4 | 2 | P0 |
| GPU wind for grass, plants, and crowns | 5 | 4 | 2 | P0 |
| Cheap contact anchoring/AO substitute | 5 | 4 | 2 | P0 |
| Shore/bank ribbons and riparian placement | 5 | 4 | 2 | P0 |
| Dynamic sky phases and geographic sun | 5 | 4 | 2 | P0 |
| Correlated ecological placement rules | 5 | 5 | 2 | P0 |
| Agricultural rows and field-edge props | 4 | 5 | 1 | P0 |
| Building entrances/roof/facade grammar | 5 | 3 | 3 | P0/P1 |
| Weather state and fog/cloud response | 5 | 4 | 2 | P1 |
| Wetness and rain ripples | 4 | 4 | 2 | P1 |
| Rain/dust/snow particle families | 4 | 3 | 3 | P1 |
| RESOLVE macro-biome lookup | 4 | 3 | 2 | P1 |
| Optional NASA climatology cache | 3 | 3 | 2 | P2 |
| Optional ESA WorldCover sparse fallback | 4 | 2 | 4 | P2 |
| Full DEM terrain | 5 | 2 | 4 | P1 in world roadmap |
| Small fauna habitat families | 4 | 3 | 2 | P1 |
| Local 512 px dynamic shadows | 4 | 2 | 4 | P2/profile-only |
| SSAO/post-processing stack | 3 | 2 | 5 | Not default |
| Volumetric clouds/fog | 4 | 1 | 5 | Reject for low-resource target |

## 13. Recommended first beautification batch

### Phase 1 — visual foundation

1. Replace the single biome object with a versioned `EnvironmentProfile` containing climate weights, palette slots, density multipliers, wind, fog, water, sky, and species weights.
2. Make environment fields world-coordinate based and continuous across tile edges.
3. Add a single palette conversion utility so worker-authored vertex colours are explicitly converted to Linear-sRGB.
4. Feed shared environment uniforms into terrain, land, roads, buildings, water, sky, and decoration materials.
5. Smooth global sky/fog/light transitions when moving between environments.

### Phase 2 — shape and grounding

1. Compile several silhouettes for broadleaf trees, dry trees, palms, conifers, shrubs, rocks, herbs, grasses, and crops.
2. Add namespaced variation channels and compact custom attributes or deterministic palette buckets.
3. Add crown-interior/trunk-base colour shading and a prototype instanced contact-shadow family.
4. Add worker-generated facade attributes/sections so architecture varies per mapped building rather than global world grid only.
5. Add visual-pocket anchors around mapped water, POIs, intersections, parks, and farmland.

### Phase 3 — living environment

1. Add shared GPU wind with per-family stiffness.
2. Add shore bands, flow tangents, riparian plant rules, and class-specific water colour.
3. Add a geographic sun/world clock and sky phases.
4. Add deterministic clear/haze/overcast/rain/dust state transitions.
5. Add one pooled camera-local precipitation/dust system with hard mobile caps.

### Why this order

- It fixes source-tile palette snapping before adding more content.
- Every later element reads the same environment model.
- Shape variation and contact grounding improve every screenshot in daylight.
- Wind, water, and weather then animate an already coherent scene.
- Optional public datasets can enrich the same contract later without replacing the generator.

## 14. Proposed low-resource budgets

Additional budgets beyond the current renderer:

| Resource | Low | Balanced | High/desktop |
|---|---:|---:|---:|
| Geometry variants per major instance family | 2 | 3 | 4 |
| Total added steady draw calls in ordinary view | ≤ 8 | ≤ 14 | ≤ 22 |
| Contact-shadow instances visible | 250 | 500 | 900 |
| Transparent weather particles visible | 80 | 180 | 350 |
| Small ambient fauna visible | 30 | 60 | 100 |
| Environment uniform updates | on change / ≤ 10 Hz | ≤ 15 Hz | ≤ 30 Hz |
| Wind animation | vertex shader | vertex shader | vertex shader + detail bend |
| Shadow maps | off | optional 512² tight local | optional 1024² tight local |
| Post-processing | none | none by default | opt-in only after profiling |
| Additional generated textures | ≤ 256 KB shared | ≤ 512 KB | ≤ 2 MB |
| Added ordinary-view triangles | ≤ 35k | ≤ 70k | ≤ 130k |

Particles should also have a **screen-coverage** budget, because 80 huge transparent cards can cost more than hundreds of tiny opaque meshes. Record estimated particle pixels/overdraw in the audit report; the `__gdo` probe exposes the same counters without browser tooling.

## 15. Acceptance criteria

### 15.1 Implemented `VEG-08` checkpoint

The first continuous-profile consumer is now coordinate vegetation:

- `PlantMorphology` uses latitude plus smoothly interpolated 6,400-unit absolute-coordinate anomalies as its no-request macro fallback. Deterministic terrain response, `TER-07` water distance/wetland role, mapped land kind, and bounded local road/building proximity modify six normalized tropical, subtropical, arid, upland, riparian, and urban influences at each candidate.
- The result is explicitly artistic. `latitude-map-water-terrain-v1` metadata prevents the baseline from being presented as scientific climatology or exact species inference; optional public climate/land-cover enrichment in Section 4.3 remains future work.
- Family, density, two-variant archetype choice, nonuniform crown/height/asymmetry, palette, age, and stiffness are correlated through the shared profile. Bamboo joins broadleaf, palm, shrub, herb, and grass as a geographically reachable cached family. Urban/arid evidence suppresses density, while exact mapped routes, buildings, unsupported water, slope, and land-kind rules remain authoritative.
- Each aligned decoration transfers 13 bytes: conservative quantized X/Y/Z morphology, variant/palette/age/stiffness, and the dominant three influence IDs and weights summing to 255. Geometry remains one fixed versioned global cache with two low variants per family; there are no per-instance geometries, per-tile libraries, extra environment requests, dense environment rasters, or per-frame CPU plant updates.
- Morphology is evaluated before `VEG-07` acceptance using the widest horizontal envelope, then composed with branch-only crown adaptation without moving the source anchor. Focus-ground profile changes are approached at a bounded 10 Hz rather than assigned abruptly.
- Automated tests prove exact shared-position seams, interpolation around source-tile edges, determinism, six influence responses, dominant-three quantization, malformed-input rejection, provider equivalence, fixed cross-coordinate recipe sharing, nonuniform render records, eviction/remount reproduction, and existing memory/draw/triangle caps.

`npm run check` passes 118 tests and builds 109 modules. The current provider-equivalence structure uses 1,044 plant records, 11 active pools, 36 source geometries, 208,452 static GPU-geometry bytes, 11,190 visible triangles, and a four-draw replacement delta. The walking matrix below now runs as the scripted movement audit over the real runtime; constrained-mobile frame-time acceptance remains a hardware measurement and is not implied by this checkpoint.

### 15.2 Implemented whole-plant GPU wind checkpoint (`VEG-09`)

- `PlantWindState` owns one versioned normalized world-space direction plus bounded strength/gustiness. One precision-safe wrapping clock uniform drives smoothed triangle waves at low whole-plant, gust-envelope, and turbulence frequencies; gusts are derived in the shader rather than uploaded or simulated per plant.
- `PlantRenderPools` resolves that direction through each model/instance transform, then composes object height, normalized packed bend, fixed root role, stable per-instance phase, and morphology stiffness. Every vertex in one plant shares the same temporal/spatial wave, while only response magnitude changes, preserving coherent box silhouettes and leaving independent branch-group/detail phase to deferred `VEG-10`.
- The `.055` low amplitude is bounded by a `.06` object-space culling reserve. Placement anchors, `VEG-07` clearances, source ownership, support/collision domains, and all instance matrices remain static. Paired variants, one active LOD, resident pooling, remount, renderer-context restoration, and disposal retain their existing contracts.
- System preference and the public world/pool setting activate reduced motion: turbulence/gust becomes zero and residual slow sway is capped at `.10` strength. Invalid direction/strength/gust/time input falls back or holds safely and increments diagnostics.
- Low-profile gates allow one shared clock-uniform write per rendered wind frame, zero wind-driven CPU vegetation matrix updates, and zero steady-frame wind allocation. The debug/budget surfaces expose these values plus wind namespace, effective field, reduced-motion state, displacement cap, malformed inputs, and lifecycle counters.

`npm run check` passes 125 tests and builds 110 modules. Wind adds no geometry bytes, triangles, draw calls, instance records, or map/network payload, so the provider-equivalence structural totals above remain unchanged. This checkpoint proves deterministic shader/state/lifecycle/resource contracts; moving FPP/TPP behaviour is now audited programmatically by the movement audit, while constrained-mobile frame time remains a hardware measurement.

### Coherence

- The debug probe's palette/silhouette record distinguishes at least six tested environmental combinations by measured colour and silhouette state, not by labels alone.
- The same environment visibly coordinates ground, foliage, water, sky, fog, buildings, and effects.
- No abrupt global palette or fog jump occurs at an MVT boundary.
- A wetland cannot spawn desert-only details; still water and ocean do not share every water-edge prop.

### Variation

- In a 30 m game-space walk through vegetation, at least three large-plant silhouettes and multiple scale/asymmetry variants are visible where the environment supports them.
- Repeated buildings do not all share identical roof/parapet/colour/entrance treatment.
- Variation remains deterministic after tile eviction and reload.
- Variation channels are independent: palette-rule changes do not move collision or placements.

### Composition and traversal

- Ground cover remains dense, but roadways, entrances, route corridors, and spawn remain clear.
- Each suitable source tile creates at least one recognizable mapped/ecological visual pocket without inventing a factual landmark.
- The player can identify mapped water, major roads, fields/parks, and building masses from silhouette/value hierarchy.

### Effects

- Vegetation wind uses no per-instance CPU matrix updates.
- Weather transitions are deterministic and do not flicker or reset at tile boundaries.
- Rain/dust/snow effects stay camera-local and respect the active quality cap.
- Night preserves path/road/player readability.
- `prefers-reduced-motion` or an in-game reduced-motion option suppresses gust detail, particles, lightning flashes, and rapid cloud motion.

### Performance

- Low profile stays within the existing 30 FPS target on constrained software rendering and low-end mobile audits.
- Ordinary street view remains under the agreed draw/triangle/memory ceilings.
- No visual family creates one mesh, material, listener, timer, or audio node per instance.
- Shader programs are warmed or feature-stable; weather changes update uniforms instead of recompiling materials.
- Every geometry, texture, buffer, shader material, timer, and effect pool disposes on Exit.

### Programmatic movement-audit matrix

The retired capture matrix is replaced by the scripted movement audit
(`src/engine/MovementAudit.js`) run through `runMovementAudit({ step, probe })`
against each environment. Every row below is a fixed-step script plus recorded
numbers, not a screenshot:

1. Meerut / Indo-Gangetic urban-agricultural mosaic (canonical `dense-urban` fixture);
2. Rajasthan hot arid town (arid morphology profile);
3. tropical wet coast (`mapped-coast` fixture);
4. mapped river/wetland (`mapped-coast` hydrology domain);
5. dense urban centre (canonical `dense-urban` building-detail batch);
6. forested mountain with the deterministic fallback terrain grid;
7. high/cold environment (macro-field blend at the canonical seed);
8. dawn, noon, sunset, and night once `ENV-02` lands, through the same audit with a time-of-day override;
9. clear, haze, rain, dust, and snow once `ENV-04` lands, through the same audit with a weather override;
10. mobile portrait/landscape shape plus reduced motion, driven by the `GeoPlayer` profile and the audit's reduced-motion flag.

Each run records, per fixed coordinate/provider fixture/world version/camera pose:
the movement fingerprint, camera clearance against real blockers, live render
bands and transparency flags, per-family LOD churn, subpixel/microfade values per
semantic surface, per-step travel, and resident-set churn — so two runs at the
same inputs are directly comparable in numbers rather than in pixels.

## 16. Research sources

### Biomes and geographic context

- [AutoBiomes: procedural generation of multi-biome landscapes](https://cgvr.cs.uni-bremen.de/papers/cgi20/AutoBiomes.pdf) — pipeline climate model, DEM integration, biome classification, transitions, and rule-driven asset distributions.
- [Ecologically Sound Procedural Generation of Natural Environments](https://doi.org/10.1155/2017/7057141) — landscape maps, patchiness/coverage, Poisson/Wang placement, web visualization, and ecological validation.
- [Procedural Urban Forestry](https://arxiv.org/abs/2008.05567) — zone-aware urban planting strategies, boundary/cluster/equidistant patterns, and obstacle-aware Poisson spacing.
- [RESOLVE Terrestrial Ecoregions 2017 metadata](https://africa-knowledge-platform.ec.europa.eu/dataset/terrestrial-ecoregions) — 846 global ecoregions, CC BY 4.0.
- [ESA WorldCover 2021 v200 metadata and WMTS](https://data.apps.fao.org/catalog/iso/8cf69f76-1be0-4339-a0b0-18a93c7f4760) — 10 m, 11 classes, COG/WMTS, attribution, and validation limits.
- [NASA POWER API overview](https://power.larc.nasa.gov/docs/services/api/) and [Climatology API](https://power.larc.nasa.gov/docs/services/api/temporal/climatology/) — point climatology formats, request limits, and possible HTTP 429 responses.
- [WorldClim official licence](https://worldclim.org/about.html) — reason it should not be a default unrestricted production source.

### Rendering, variation, and effects

- [Three.js colour management](https://threejs.org/manual/en/color-management.html) — Linear-sRGB working values and sRGB output handling.
- [Three.js InstancedMesh](https://threejs.org/docs/#api/en/objects/InstancedMesh) and [BatchedMesh](https://threejs.org/docs/#api/en/objects/BatchedMesh) — repeated-instance and varied-geometry draw reduction.
- [Three.js optimizing lots of objects](https://threejs.org/manual/en/optimize-lots-of-objects.html) — merged geometry and scene-performance rationale.
- [GPU-Generated Procedural Wind Animations for Trees](https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-6-gpu-generated-procedural-wind-animations-trees) — GPU instancing, stochastic wind fields, and simulation LOD.
- [Vegetation Procedural Animation and Shading in Crysis](https://developer.nvidia.com/gpugems/gpugems3/part-iii-rendering/chapter-16-vegetation-procedural-animation-and-shading-crysis) — main/detail bending, phase and stiffness attributes, smoothed triangle waves, and precomputed occlusion.
- [Accurate Atmospheric Scattering, GPU Gems 2](https://developer.nvidia.com/gpugems/gpugems2/part-ii-shading-lighting-and-shadows/chapter-16-accurate-atmospheric-scattering) — visible outdoor scattering principles and cost trade-offs.
- [Low Complexity, High Fidelity: INSIDE Rendering](https://gdcvault.com/play/1023783/Low-Complexity-High-Fidelity-INSIDE) — analytic occlusion, separated light contributions, water, atmosphere, and dithering.
- [Physically-Based Materials in a Stylized Open World](https://gdcvault.com/play/1024690/-Agents-of-Mayhem-Physically) — colour/material documentation and balancing PBR with illustrative style.
- [Snap VFX Graph optimization](https://developers.snap.com/lens-studio/features/graphics/particles/vfx-editor/vfx-graph-optimization) — particle count, screen overdraw, texture sizing, and mobile effect budgeting.

## 17. Final direction

The visual target should be a **living geographic diorama**:

- Minecraft contributes staged, seeded, field-driven world generation.
- Roblox contributes readable modular silhouettes and approachable colour.
- Mapped geography contributes recognizable real coordinate structure.
- The project's own identity comes from warm South Asian-inspired visual grammar, dense ecological relationships, voxel-scale architecture, and low-resource atmospheric motion.

The first implementation should therefore establish the continuous environment/palette contract, procedural silhouette variants, cheap grounding, wind, and shore ecology before attempting expensive shadows, post-processing, volumetric clouds, or even more raw object density.
