# Procedural Coordinate World — Missing Feature Research and Roadmap

**Research date:** 2026-09-15
**Scope:** browser-local, deterministic coordinate generation; approximately 1:10 horizontal scale; free/public map sources; low-end mobile first.
**Implementation checkpoint:** 2026-09-17 — `TER-07`/`TER-08` provide the bounded transferable shoreline/bank/wetland/support, provider-neutral water-class, and mapped flow-direction semantic foundation described here. `DET-04` now provides the bounded selected-building roof/facade grammar with geometry-derived road-facing entrances and exact roof support. `ENV-03` water appearance/effects, broader place/object families, intermittent seasonal state, and moving browser validation remain pending.

## 1. Executive conclusion

The coordinate world now has a strong rendering and streaming foundation: mapped roads, water, land cover, names, geographically accurate building footprints, exact footprint collision, biome palettes, dense seeded plants, low-poly birds and bees, FPP/TPP, mobile controls, diagnostics, and bounded neighboring-tile prefetch.

Its largest remaining weakness is no longer raw object count. It is **semantic depth**. A road is visually readable but does not yet form a traffic network; a POI can become a label but not a recognizable place; water has geometry but little shoreline or flow behavior; the sky has atmosphere but no time or weather; and exploration has no generated discoveries or goals.

The recommended direction is a Minecraft-like staged feature pipeline constrained by map truth:

```text
map truth and optional elevation
  → roads and traversability
  → terrain/water surfaces
  → mapped structures and sites
  → biome feature passes
  → ambient systems and agents
  → discoveries, interactions, and quests
```

Minecraft's useful lesson is not to copy its blocks or code. It is to separate terrain, biome, and feature passes; seed every pass; preserve continuity across chunk edges; and stop expensive chunks at a safe intermediate stage when they are far from the player. For this project, mapped geography remains authoritative while procedural systems fill missing visual and gameplay detail.

## 2. Current baseline

### Implemented now

- Web Mercator coordinate projection and approximately 1:10 horizontal scale.
- Zoom-14 OpenMapTiles and Shortbread provider adapters with retries and attribution.
- Worker phases in the required order: roads, context, buildings.
- Mapped road ribbons, curbs, center marks, crosswalks, and block-scale surface variation.
- Mapped land and water polygons/lines.
- Geographic building footprints, approximate heights, facade rhythm, windows, parapets, and tanks.
- Spatial broad-phase plus exact mapped-polygon building collision, including courtyard holes.
- Map-derived place, street, water, and POI names with screen-space decluttering.
- Coordinate-derived biome palettes and sparse-tile fallback styling.
- Seeded trees, palms, shrubs, flowers, rocks, herbs, tall grass, benches, lights, and parked cars.
- Bounded animated bird and bee instance groups.
- First-person default, switchable third-person, camera clipping, desktop input, and full mobile controls.
- Maximum four resident source tiles and two active requests.
- Browser-local generation, transferable buffers, shared materials, instancing, and explicit disposal.
- Runtime diagnostics for requests, bytes, worker time, FPS, CPU, stalls, draws, triangles, geometry, and feature counts.

### Missing or shallow

- Terrain elevation, slopes, cliffs, valleys, and terrain-aware physics.
- Shorelines, banks, flow direction, waterfalls, wetness, and water interactions.
- Mapped bridge, dam, pier, ferry, aerialway, airport, address, boundary, and transit semantics.
- Recognizable POI/landmark archetypes.
- Sidewalk networks, entrances, gates, walls, fences, playgrounds, and site-specific furnishing.
- Building shape grammar beyond the current facade shader and roof props.
- Moving road traffic, trains, ferries, pedestrians, and local NPC activity.
- Day/night, geographic solar position, stars, moon, seasons, weather, wind, and streetlight switching.
- Procedural ambient audio and spatial feedback.
- Discoveries, interactions, collectibles, generated routes, local challenges, or quests in coordinate mode.
- Persistent world/seed versioning and cached exploration state.
- Distance-based detail levels within a resident map tile.

## 3. What the existing map tiles can support but the game does not use yet

Provider implementations vary, so every capability needs a schema adapter and a graceful fallback.

| Source capability | OpenMapTiles | Shortbread 1.1 | Current use | Missing opportunity |
|---|---|---|---|---|
| Roads and paths | `transportation` | `streets` | Geometry, class, some bridge state | Surface-aware materials, lanes, access, graph routing, traffic |
| Dedicated bridges | mostly `brunnel` attributes | `bridges` | Partial elevation flag only | Decks, railings, supports, bridge collision and underpasses |
| Water areas/lines | `water`, `waterway` | `water_polygons`, `water_lines`, `ocean` | Flat animated surfaces | Banks, reeds, flow, depth tint, intermittent state, fish |
| Dams and piers | provider-dependent | dedicated dam/pier layers | Unused | Dams, ghats, jetties, breakwaters, fishing spots |
| Buildings | `building` | `buildings` | Footprints, stable height approximation, selected road-facing facade/exact-slot roof grammar | Source colour/min-height, parts, mapped entrances/addresses, broader regional recipes |
| Addresses | `housenumber` | `addresses` | Unused | Door plates, street identity, navigation targets |
| Land/site areas | `landcover`, `landuse`, `park` | `land`, `sites` | Surface colour and broad vegetation | Schools, hospitals, campuses, parking, playgrounds, farm rows |
| POIs | `poi` | `pois` | Mostly names | Voxel archetypes, discoveries, activity zones, quests |
| Public transport | POIs/transportation | `public_transport`, ferries | Unused | Stops, platforms, moving buses/trains/ferries |
| Airports | `aeroway`, `aerodrome_label` | streets/sites/POIs vary | Unused | Runways, taxiways, beacons, airport signage |
| Aerialways | transportation varies | `aerialways` | Unused | Gondolas/cable cars in mountain areas |
| Peaks | `mountain_peak` | POI/place coverage varies | Unused | Summit markers, lookout challenges, elevation labels |
| Boundaries | `boundary` | `boundaries` | Unused | Region transitions and discovery notices, not physical walls |
| Multilingual names | language fields vary | `name_xx` fields | English/general fallback only | Hindi/local-script display preferences |

Shortbread deliberately stays lean and does not expose the full OpenStreetMap tag universe. Therefore, this project should not make a required gameplay mechanic depend on a rarely populated property.

**Implemented building checkpoint (`DET-04`):** both provider building layers now share a version-2, geometry-hashed grammar. Ordinary structures retain cheap analytical facade detail. A stable maximum-eight focus-tile subset uses a capped ground-road index to choose its nearest outward wall and can add entrance/canopy/cornice/balcony/utility relief; absent mapped roads remain absent rather than receiving a fake orientation. Stair, solar, and vent roof modules consume only remaining exact concave/hole-safe slots. All boxes merge into one visual-only batch, preserve mapped collision bytes, transfer and dispose with the source tile, and stay under explicit scan/box/triangle/byte/draw limits. Mapped entrances, addresses, building parts, and claimed real-world architectural identity remain future provider/content work.

## 4. Feature catalogue

Priority definitions:

- **P0:** high player impact, low/moderate risk; appropriate for the next implementation batch.
- **P1:** high value but needs a new shared subsystem or more data validation.
- **P2:** useful expansion after P0/P1 foundations.
- **P3:** experimental, expensive, or in tension with geographic fidelity.

Cost estimates refer to the low-power profile after batching and distance culling.

### 4.1 Terrain and geology

| Feature | Generation/data approach | Value | Cost | Priority |
|---|---|---|---|---|
| Real local relief | Optional no-auth Terrarium DEM tile; subtract local datum, downsample to a 33×33 or 49×49 mesh | Removes flat-world appearance; location identity | Medium network/geometry | P1 |
| Terrain draping | Sample one shared height field for ground, roads, water banks, props, buildings, player, and camera | Keeps visual and physical surfaces aligned | Medium complexity | P1 |
| Playable slope policy | Clamp/smooth only under roads and large building footprints; retain surrounding relief | Avoids impassable roads and floating structures | Low runtime | P1 |
| Terraced voxel slopes | Quantize non-road terrain height into broad steps with vertical cliff walls | Strong Minecraft-inspired silhouette | Medium geometry | P2 |
| Cliff/outcrop features | Derive from DEM slope plus ridge noise; batch rock strata | Makes mountains and quarries legible | Low/medium | P2 |
| Soil/geology micro-biomes | Coordinate climate + land class choose clay, alluvium, sand, dark soil, scree, mud | More regional ground identity | Very low shader cost | P0 |
| Peaks and lookouts | Use `mountain_peak` or high local DEM maxima | Navigation landmarks and challenges | Low | P1 |
| Caves/mines | Seeded underground graph, only where geology/quarry/peak context supports it | Exploration depth | High; weak map truth | P3 |

**DEM candidate:** AWS Open Data Terrain Tiles are globally tiled, publicly accessible without an AWS account, and offer a browser-decodable Terrarium form through the documented dataset. They have no application SLA, so relief must remain an optional provider with a flat/stylized fallback. A production implementation must preserve terrain attribution and avoid bulk download behavior.

### 4.2 Water and coasts

| Feature | Generation/data approach | Value | Cost | Priority |
|---|---|---|---|---|
| Shore/bank bands | Offset mapped polygon/line edges; classify beach, mud, rock, or grass from biome/land | Gives water a readable edge | Low, batched | P0 |
| Riparian ecology | Distance-to-water field places reeds, lotus, mangrove-like roots, insects, and birds | Strong ecosystem coherence | Low | P0 |
| Directional flow | Orient ripple shader and floating debris along water-line tangents | Rivers read differently from ponds | Very low | P0 |
| Water depth tint | Distance from polygon edge or compact signed-distance approximation | Better shape and depth perception | Shader-only | P1 |
| Intermittent water | Respect intermittent attributes; dry bed in dry season/seeded weather state | More truthful regional behavior | Low | P2 |
| Dams, piers, ghats | Dedicated Shortbread layers or POI/site rules; modular voxel grammar | Place-specific structures | Low/medium | P1 |
| Waterfalls | Waterway crossing a strong DEM drop; minimum-length and slope checks | Memorable landmark | Medium; needs DEM | P2 |
| Fish and water insects | Small instanced schools/particles constrained to water polygons | Living water | Low | P2 |
| Swimming/wading/boat interaction | Depth zones and simple state machine | New gameplay | Medium/high | P2 |
| Rain puddles | Weather mask on flat non-water ground and roads; shader reflection only on higher profiles | Weather responsiveness | Low/medium | P2 |

**Implemented semantic checkpoint (`TER-08`):** the compact hydrology domain now classifies mapped water as unknown, stream, canal, river, lake, or ocean and preserves normalized provider geometry-order tangents on waterway segments. Bounded touched same-class association can transfer stream/canal/river direction to polygon flow; lake, ocean, unmatched, degenerate, and malformed records remain still rather than receiving fabricated downstream direction. The field keeps overlap-suppressed line truth and shoreline class, has explicit association/storage caps, adds no request or runtime simulation, and transfers/releases with its source tile. Class-specific appearance, directional ripple shading, debris, foam, depth tint, and seasonal intermittent water remain later visual/ecological work.

### 4.3 Ecology and vegetation

| Feature | Generation/data approach | Value | Cost | Priority |
|---|---|---|---|---|
| Regional species sets | Latitude, longitude, biome, moisture, and land kind select several tree/plant recipes | Stops every green biome sharing one silhouette | Low | P0 |
| Canopy/understory relationship | Trees reserve canopy cells; shade-tolerant herbs/mushrooms fill beneath; grass prefers openings | More believable ecology | Worker-only | P0 |
| Variable-density blue-noise placement | Deterministic Poisson/blue-noise candidates for large plants; current lattice remains for ground cover | Avoids tree clumps and giant gaps | Low/medium worker cost | P1 |
| Ecotone blending | Blend neighboring biome palettes/species weights instead of hard tile transitions | Seamless travel | Low | P1 |
| Agricultural patterns | Farmland/orchard/vineyard polygons create aligned crop rows, irrigation, hay, scarecrows | Strong rural identity | Low, instanced | P0 |
| Wetland features | Reed beds, lily/lotus clusters, mud patches, frogs/fireflies | Makes wetlands distinct | Low | P0 |
| Dry-biome features | Cacti/succulents, thorn scrub, dry grass, dune shrubs, dust particles | Better arid variety | Low | P0 |
| Dead wood and leaf litter | Canopy-aware logs, stumps, mushrooms, fallen leaves | Fills forests without more trees | Low | P2 |
| Seasonal state | Pure function of coordinate, world date, altitude, and species; colour/flower/leaf weights | Revisitable variation | Low | P2 |
| Wind response | Shared wind uniform bends grass/leaf vertices; no per-instance CPU updates | Makes vegetation feel alive | Low shader cost | P1 |
| Wildlife habitat rules | Birds near canopy/water, bees near flowers, cattle near pasture, fish in water | Replaces arbitrary fauna scatter | Low worker cost | P0 |
| Small terrestrial fauna | Butterflies, dragonflies, dogs, cattle, goats, chickens; strict biome/site caps | Regional life and scale cues | Low/medium | P1 |
| Growth/harvest | Deterministic growth stages plus local interaction state | Gameplay loop | Medium/stateful | P2 |

L-systems can generate diverse trees and plants, but generating unique high-poly geometry per instance would conflict with mobile constraints. The useful adaptation is to compile a small seed-derived library of voxel branch recipes per biome, then instance those shared variants.

### 4.4 Roads, transport, and urban fabric

| Feature | Generation/data approach | Value | Cost | Priority |
|---|---|---|---|---|
| Sidewalk graph | Offset eligible mapped streets, clip/merge at intersections, omit rural/path classes | Fixes empty city edges and supports pedestrians | Medium worker geometry | P0 |
| Surface-aware roads | Use available surface/class properties for asphalt, concrete, dirt, gravel, paving | Geographic and biome variety | Very low | P0 |
| Intersection classification | Build endpoint graph; detect T, X, roundabout, dead-end, and bridge nodes | Foundation for markings, lights, and traffic | Medium worker | P0 |
| Traffic signs/signals | Rules from road class, graph shape, access, and crossings | Makes roads functional | Low, instanced | P1 |
| Moving local traffic | Recycle a small pool of voxel vehicles along nearby graph edges; deterministic routes | Living city without global simulation | Medium CPU | P1 |
| Pedestrians | Sidewalk graph agents with crossing nodes and activity-zone destinations | Human scale and activity | Medium CPU | P1 |
| Trains/trams | Rail polylines become routes; recycle one or two consists near player | Strong visual landmark | Low/medium | P1 |
| Ferries/boats | Ferry/water paths plus water polygon checks | Coastal/riverside identity | Low | P2 |
| Transit stops | Public-transport POIs become shelters, signs, route discoveries | Useful mapped detail | Low | P0 |
| Parking areas | Site polygons create marked bays, sparse parked vehicles, trees, lights | Fills currently empty paved sites | Low | P0 |
| Roadworks | Construction landuse or stable low-frequency event seed | Temporal variety | Low | P2 |
| Street clutter | Bins, bollards, hydrants, utility boxes, kiosks, tea stalls; class/POI-driven | Roblox-like readable street life | Low, instanced | P0 |

Traffic should not be a full city simulation. Only the nearest graph neighborhood should own live agents. Vehicles leaving the active radius are recycled onto another valid edge; far traffic is represented by occasional shader/light hints or not rendered.

### 4.5 Buildings and mapped places

| Feature | Generation/data approach | Value | Cost | Priority |
|---|---|---|---|---|
| Footprint-aware mass grammar | Split mapped mass into base, repeating floors, roof, and optional setback while preserving footprint | Greater building variety | Worker geometry | P0 |
| Facade grammar | Deterministic bay width, floor height, frame, balcony, shade, and colour rules | Less repetitive cities | Mostly shader/merged geometry | P0 |
| Entrances and awnings | Place on longest road-facing wall; reject corners; POI type selects canopy/sign | Makes buildings understandable | Low | P0 |
| Roof families | Flat/parapet, shed, gable suggestion, terrace shade, tanks, solar panels | Better skyline | Low/medium | P0 |
| Source building colour/min-height | Respect available OpenMapTiles fields before fallback palette | Better map fidelity | Very low | P0 |
| Address plates | Use address/housenumber layers at close range only | Local identity/navigation | Low, distance-limited | P1 |
| POI voxel archetypes | Temple/mosque/church, school, hospital, shop, fuel, station, tower, monument, park gate | Converts names into recognizable places | Medium content rules | P0 |
| Site semantics | School yards, hospital entrances, campuses, sports fields, playgrounds, prisons, parking | Uses large polygons meaningfully | Medium | P0 |
| Walls, fences, gates | Polygon-edge ribbons with entrance gaps; site/landuse-specific recipes | Defines space and collision | Medium | P1 |
| Balconies and shopfronts | Merged facade details, disabled at distance | India-specific urban character | Medium | P1 |
| Solar panels/water tanks | Climate/building-size weights; current tank system expanded | Rooftop richness | Low | P0 |
| Interiors | Only a tiny authored procedural room set entered through a portal/instance | Deep interaction | High | P3 |

A compact CGA/shape-grammar subset is a good fit: split a footprint-derived mass into facade components, repeat bays/floors, and select rules from a coordinate seed. It should emit into the existing one-draw building buffer instead of creating one object per window or balcony.

Wave Function Collapse is useful only in bounded, strongly constrained areas such as a shop interior, courtyard paving pattern, market-stall arrangement, or temple compound. Running unconstrained 3D WFC across every source tile would be too costly and could contradict mapped geography.

### 4.6 Atmosphere, time, and sound

| Feature | Generation/data approach | Value | Cost | Priority |
|---|---|---|---|---|
| Geographic sun/day cycle | Client-side solar approximation using latitude, longitude, and a controllable world clock | Every coordinate gets appropriate light direction/day length | Very low | P0 |
| Night lighting | Lamp/window emissive state derived from world clock; one shared material family | Makes existing streets/buildings useful at night | Low | P0 |
| Stars and moon | Procedural sky points/disc; low profile uses a static seeded set | Night identity | Low | P1 |
| Climate weather state | Seeded Markov/state schedule by biome and world time; no live API dependency | Reproducible rain, haze, dust, cloud changes | Low | P0 |
| Clouds | Existing block clouds gain coverage, wind, height, and weather colour | Visible weather without ray marching | Low | P0 |
| Rain/snow/dust | Camera-centered instanced/point particle field, one draw each, strict profile caps | Strong atmosphere | Low/medium fill rate | P1 |
| Wet/dry materials | Shared weather uniform darkens roads/soil and increases water ripples | Cohesion | Shader-only | P1 |
| Fog/haze variation | Humidity, dust, altitude, and time control fog range/colour | Regional mood and depth | Very low | P0 |
| Procedural ambience | Web Audio filtered noise for wind/rain/water/city bed | No audio downloads | Low | P0 |
| Spatial one-shots | Small oscillator/noise recipes for bees, birds, traffic, steps, water | Interaction feedback | Low with node pool | P1 |
| Surface footsteps | Road/soil/grass/water material selects a synthesized footstep envelope | Makes materials meaningful | Low | P0 |

Live weather would be location-authentic but not reproducible and adds another external dependency. The default should be deterministic climate weather. A future opt-in “live conditions” layer can override visuals without changing world geometry or gameplay.

### 4.7 Exploration and gameplay

| Feature | Generation/data approach | Value | Cost | Priority |
|---|---|---|---|---|
| Discovery journal | Enter a POI/site/water/place radius to unlock its map-derived name and type | Immediate purpose for exploration | Very low | P0 |
| Coordinate seed card | Show provider, biome, discoveries, generated world version, and shareable coordinate | Reproducibility/social sharing | Very low | P0 |
| Procedural walking route | Build a short reachable route across named roads/POIs using local road graph | Guides players through generated content | Low/medium | P0 |
| Photo challenges | Deterministically choose a landmark + viewpoint direction/time condition | Uses visuals without combat systems | Low | P1 |
| Regional collectibles | Spawn outside roads/buildings/water; type weights from biome/POI/landuse | Connects coordinate and curated loops | Low | P1 |
| Contextual micro-quests | Templates such as visit, photograph, follow river, reach bridge, collect, return | Purposeful but controllable generation | Low | P1 |
| NPC requests | Activity-zone NPC chooses a quest valid for nearby generated affordances | More narrative context | Medium | P2 |
| Environmental interactions | Sit on bench, read sign, ring bell, board ferry, switch lamp, inspect plant | World responsiveness | Low per action | P1 |
| Local route/minimap | Simplified nearby graph, labels, player heading, loaded-tile state | Navigation | Low | P0 |
| Accessibility navigation | High-contrast route ribbon, reduced motion, volume controls, touch sensitivity | Broader usability | Low | P0 |
| Local persistence | IndexedDB record keyed by world-version + coordinate tile + discovery ID | Revisits retain progress | Low | P1 |
| Daily deterministic challenge | Date + coordinate seed selects a route/goal; can be reproduced for that date | Repeat engagement | Low | P2 |

Generated quests should be grounded in actual affordances. For example, a “cross two bridges” quest must be emitted only after a local graph proves two reachable mapped/procedural bridges exist. Template generation is safer than unconstrained text generation, runs locally, is easy to test, and avoids fabricated place claims.

## 5. Recommended feature architecture

### 5.1 Pass registry

Replace a growing chain of special cases with a small data-driven pass registry:

```js
{
  id: 'riparian-ecology-v1',
  phase: 'decoration',
  dependsOn: ['water-distance-field', 'map-obstacles', 'biome'],
  schemas: ['openmaptiles', 'shortbread'],
  budget: { candidates: 600, instances: 140, milliseconds: 5 },
  generate(context, output) { /* deterministic typed-data output */ }
}
```

Each pass must declare:

- stable ID and version;
- inputs and dependencies;
- provider/schema support;
- candidate, output, byte, and time budgets;
- deterministic seed namespace;
- low/balanced/high profile density;
- collision/exclusion requirements;
- transfer/disposal ownership;
- tests and diagnostics label.

### 5.2 Staged generation graph

```text
FETCH
  MVT ──────────────┐
  optional DEM ─────┤
                    ▼
ROAD PASS (first visible map feature)
  road geometry + route graph + crossing/intersection metadata
                    ▼
SURFACE PASS
  terrain height field + land + water + shore + slope fields
                    ▼
STRUCTURE PASS
  buildings + exact collision + sites + bridges/piers/POI structures
                    ▼
ECOLOGY PASS
  canopy + understory + agriculture + riparian + ambient spawn anchors
                    ▼
AMBIENT PASS
  bounded nearby traffic/pedestrians/fauna + sound emitters + weather
                    ▼
GAMEPLAY PASS
  discoveries + reachable route + quest candidates + save IDs
```

Roads still become visible before buildings. An optional DEM can fetch in parallel; if unavailable by the road deadline, the tile mounts a flat provisional surface and upgrades without blocking navigation.

### 5.3 Seed contract

Use namespaces rather than sharing one random stream:

```text
seed = hash(
  proceduralWorldVersion,
  sourceZoom,
  sourceTileX,
  sourceTileY,
  stableFeatureIdOrGeometryHash,
  passId,
  localCellOrCandidateId
)
```

This prevents adding one flower rule from moving every tree, vehicle, and discovery. Feature order alone is not a sufficiently stable identity because provider updates can insert or reorder features.

### 5.4 Map truth hierarchy

1. Mapped geometry and explicit properties win.
2. Optional terrain elevation modifies Y, never X/Z footprints.
3. Procedural completion may add detail where source coverage is absent.
4. Synthetic content must not imply a real-world fact in labels or descriptions.
5. Gameplay props are visibly stylized and deterministic.
6. Provider failure degrades to the current procedural fallback, not a broken loading screen.

## 6. Recommended implementation sequence

### Batch A — recognizable places, estimated highest value

1. Add a provider-neutral feature adapter for POIs, sites, bridges, piers/dams, public transport, addresses, aeroways, and peaks.
2. Generate 10–12 low-poly POI archetypes and site furnishing recipes.
3. Add sidewalk/road-edge generation and intersection metadata.
4. Add a compact building mass/facade/roof grammar with road-facing entrances. **Implemented for bounded selected buildings by `DET-04`; mapped entrance/address enrichment remains.**
5. Add mapped surface-aware roads and multilingual label preference.
6. Add a discovery journal and one reachable local walking route.

**Why first:** this uses data already present in the downloaded MVT, adds no new network request, and makes coordinates feel materially different.

### Batch B — living atmosphere

1. Geographic world clock and sun direction.
2. Automatic lamps, emissive windows, stars, and moon.
3. Reproducible climate weather, cloud coverage, fog, and wind uniforms.
4. Procedural Web Audio ambience and surface footsteps.
5. Habitat rules for existing birds/bees plus butterflies, water fauna, and pasture animals.

**Why second:** high experiential impact with few draw calls and no provider dependency.

### Batch C — terrain and water relief

1. Optional AWS Terrarium provider configuration and attribution.
2. Worker/offscreen decoding and downsampled local height field.
3. Shared terrain-height query used by rendering, roads, props, collision, camera, and player.
4. Road/building flattening masks and tile-edge seam tests.
5. Shore bands, river direction, depth tint, and DEM-triggered waterfalls.

**Why third:** this removes the largest remaining visual limitation but touches nearly every spatial subsystem.

### Batch D — bounded agents and activity

1. Build route graph from the existing road pass.
2. Add pooled nearby vehicle agents and deterministic spawn/recycle points.
3. Add sidewalks/crossings as a pedestrian graph.
4. Add transit, rail, ferry, and activity-zone agents when mapped.
5. Reduce/suspend simulation by distance and visibility.

### Batch E — deeper procedural gameplay

1. Persist discovery IDs and world version in IndexedDB.
2. Add photo challenges, environmental interactions, and regional collectibles.
3. Generate only quests whose prerequisites are proven reachable.
4. Share coordinate + procedural world version + optional date seed.

## 7. Low-resource budgets

Recommended one-resident-tile **low profile** ceilings after the next feature batches:

| Budget | Target |
|---|---:|
| MVT requests | 1 per source tile |
| Optional DEM requests | 0 by default; maximum 1 per terrain tile when enabled |
| Active network requests | 2 total |
| Resident source tiles | 4 |
| Visible draw calls at ordinary street view | ≤ 35 |
| Draw calls at four-tile corner | ≤ 80 after frustum/distance culling |
| Visible triangles at ordinary street view | ≤ 180k |
| Dynamic vehicle agents | 12 low / 24 balanced |
| Dynamic pedestrians | 16 low / 32 balanced |
| Ambient fauna transform updates | ≤ 120 instances across resident tiles |
| Weather particle draws | ≤ 1 per active precipitation family |
| Procedural audio graph | ≤ 8 persistent layers, pooled one-shots |
| Main-thread generation | none beyond bounded GPU mounting |
| Worker context target | < 150 ms typical; split/yield when above budget |
| Single main-thread mount task | < 8 ms hard ceiling, approximately 2 ms target |
| Resident estimated GPU allocation | < 128 MB low profile |

Detail density should drop by distance, not disappear globally. Near the player, herbs, signs, doors, and animals remain visible; far parts of the same tile retain terrain, roads, buildings, canopy silhouettes, and important labels.

## 8. Validation requirements for every new feature

### Determinism

- Same coordinate, world version, provider payload, and date seed produces identical typed-data fingerprints.
- Adding a new pass does not move outputs from unrelated seed namespaces.
- Neighboring tiles agree at borders.
- Eviction and regeneration reproduce transforms and IDs.

### Geographic safety

- No props inside mapped roads, water, or occupied building rings unless that prop explicitly belongs there.
- Courtyards and footprint holes remain usable.
- Roads, sidewalks, water, terrain, props, collision, player, and camera sample the same height field.
- Synthetic names or historical claims are never presented as map facts.

### Traversal

- Spawn position is reachable.
- Generated routes pass collision checks.
- Bridges, sidewalks, entrances, crossings, and terrain tile seams are walkable in both directions.
- Vehicle/pedestrian agents cannot permanently block the player.

### Rendering and lifecycle

- No extra draw per object.
- Distant detail is culled or reduced.
- All materials, geometries, audio nodes, workers, timers, and listeners dispose on Exit.
- Context loss can rebuild procedural resources.
- Mobile controls remain complete and readable under rain/night modes.

### Visual audit matrix

At minimum, capture moving TPP at:

1. dense North Indian city;
2. sparse Indo-Gangetic settlement;
3. western hot-arid settlement;
4. tropical/coastal location;
5. wetland or river crossing;
6. mountain location with optional DEM;
7. night/rain state;
8. mobile portrait and landscape.

Each capture should record provider, biome, detail-family counts, worker timings, bytes, draws, triangles, frame CPU, errors, and truncated passes.

## 9. Approaches not recommended as defaults

- **Public Overpass per moving player:** unsuitable request/reliability budget for ordinary streaming.
- **Unbounded 3D WFC:** too expensive and likely to violate mapped geometry; reserve it for tiny constrained areas.
- **Full building interiors everywhere:** disproportionate geometry, collision, and content cost.
- **One object/material/audio node per prop or creature:** destroys the current low-resource advantage.
- **Real-time weather as authoritative world state:** non-reproducible and dependent on another service.
- **Physics simulation for every vehicle, leaf, or animal:** use routes, shader motion, instancing, and bounded state machines.
- **Procedurally inventing real place names or descriptions:** risks misinformation; synthetic gameplay text must be clearly identified.
- **Changing mapped X/Z geometry to make terrain easier:** footprints and roads remain map truth; only vertical adaptation is allowed.
- **Making every researched feature mandatory:** provider coverage and device budgets vary; passes must be optional and degradable.

## 10. Sources

### Map and terrain capabilities

- [Shortbread Vector Tile Schema 1.1](https://shortbread-tiles.org/schema/1.1/)
- [OpenMapTiles schema](https://openmaptiles.org/docs/schema/)
- [OpenMapTiles layer configuration example](https://github.com/systemed/tilemaker/blob/master/resources/config-openmaptiles.json)
- [AWS Open Data: Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
- [Re:Earth open terrain service and formats](https://terrain.reearth.land/)

### Procedural generation

- [Minecraft World Generation Overview — Microsoft Learn](https://learn.microsoft.com/en-us/minecraft/creator/documents/world-generation?view=minecraft-bedrock-stable)
- [Minecraft feature types — Microsoft Learn](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/featuresreference/examples/featuresintroduction?view=minecraft-bedrock-stable)
- [Minecraft Wiki: world generation](https://minecraft.wiki/w/World_generation)
- [Red Blob Games: maps from noise functions](https://www.redblobgames.com/maps/terrain-from-noise/)
- [Wave Function Collapse reference implementation](https://github.com/mxgmn/WaveFunctionCollapse)
- [Procedural Modeling of Buildings / CGA shape grammar](https://dl.acm.org/doi/10.1145/1179352.1141931)
- [Procedural Generation and Rendering of Forests](https://arxiv.org/pdf/2208.01471)

### Browser rendering, sound, and gameplay

- [Three.js InstancedMesh documentation](https://threejs.org/docs/#api/en/objects/InstancedMesh)
- [MDN Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)
- [Deriving quests from open-world mechanics](https://www.researchgate.net/publication/319364603_Deriving_quests_from_open_world_mechanics)

## Bottom line

The next major gain will not come from adding another random prop type in isolation. It will come from **relationships**:

- mapped POI → recognizable structure → local activity → discovery;
- road graph → sidewalk/intersection → traffic/pedestrians → route challenge;
- water geometry → shoreline/slope → riparian ecology → sound/interaction;
- coordinate/clock → sun/weather → material response → fauna behavior;
- building footprint → shape grammar → entrance/address → meaningful destination.

That layered approach can make every coordinate feel dense, specific, alive, and playable while keeping generation local, reproducible, and bounded.
