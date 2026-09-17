# Lightweight Procedural Textures, Fractal Vegetation, and Small-Box Detail Research

**Research date:** 2026-09-16
**Implementation checkpoint:** 2026-09-17 — the shared material foundation, `LAY-04`/`TER-07` hydrology prerequisite, `TER-08` provider-neutral water classes/mapped flow inputs, `VEG-03` through `VEG-09` vegetation stack, and `DET-01` through `DET-04` object-role/support/building grammar are implemented. `DET-04` keeps analytical ordinary facades and adds one bounded visual-only focus-tile batch for selected road-facing facade and exact-slot roof modules. `ENV-03` water materials/motion, later branch-detail wind, broader object families, and browser visual gates remain governed by this design.
**Target:** deterministic local-browser generation, a Minecraft/Roblox-inspired voxel language, approximately 1:10 mapped horizontal scale, and low-end/mobile operation.

## 1. Recommendation in one sentence

Use **shader math for broad variation, one tiny shared mask library for repeated microstructure, and deterministic grammar compilers that turn a bounded hierarchy of small boxes into a few reusable near/mid/far meshes**—never a material, draw call, scene node, or collider per box.

```text
environment + map facts + stable seed
                  ↓
        recipe / skeleton / slots
                  ↓
┌───────────────────────────────────────────────────────────┐
│ macro silhouette │ meso box modules │ micro shader detail │
└───────────────────────────────────────────────────────────┘
                  ↓
 exposed-face compiled geometry + instance attributes + LODs
                  ↓
       tile-owned placements in bounded shared batches
```

Small boxes should change the silhouette and add readable accents. They should not be used to model pores, every leaf, every blade at all distances, or invisible interior faces.

## 2. Existing foundation and audit

### 2.1 What is already strong

- Terrain, roads, and facades already use world/local-space shader hashes instead of downloaded images.
- `createWaterNormalTexture()` creates a deterministic 128×128 RGBA `DataTexture` locally and repeats it.
- Non-plant coordinate decorations remain compiled box-family instances; plants now upload compiled exposed-face LOD tiers into global owner-aware resident family/LOD pools rather than multiplying those draws per tile.
- Curated `VoxelBatch` uses one shared cube geometry and custom palette attributes, producing one instanced draw per material family instead of one draw per box.
- Coordinate placement uses deterministic hashes, octave vegetation fields, mapped land kinds, roads, exact building rings, water, and hard population caps.
- Roads are streamed before buildings, and the tile worker already performs browser-local generation off the main thread.
- `VISUAL_BIOME_BEAUTIFICATION_RESEARCH.md` already defines continuous environmental influences, morphology families, wind, composition, and global added-resource ceilings.

### 2.2 Where naive “more small boxes” would fail

Each complete `BoxGeometry` has 12 triangles. `mergeGeometries()` reduces scene objects/draw calls but does **not** remove hidden faces where boxes touch or overlap.

Current coordinate archetypes contain approximately:

| Type | Family | Complete boxes | Triangles per instance |
|---:|---|---:|---:|
| 0 | broadleaf tree | 3 | 36 |
| 1 | palm | 6 | 72 |
| 2 | shrub | 2 | 24 |
| 3 | lamp | 3 | 36 |
| 4 | rock | 3 | 36 |
| 5 | flower | 4 | 48 |
| 6 | bench | 4 | 48 |
| 7 | parked car | 7 | 84 |
| 8 | herb patch | 12 | 144 |
| 9 | tall grass | 6 | 72 |
| 10 | birds | 12 | 144 |
| 11 | bees | 15 | 180 |

`MAX_GROUND_COVER` permits 1,100 placements per tile and up to four source tiles can be resident. A non-arid weighted ground-cover mix is already roughly 110 triangles per placement before frustum/instance effects—about 121k ground-cover triangles for one full tile in the worst density case. Adding more boxes to every herb could therefore regress performance even though draw calls stay unchanged.

Other audit findings:

- One fixed silhouette currently represents each coordinate family; only scale and yaw vary materially.
- Curated tree forms are similarly compact: a common tree is two boxes, while a palm is segmented but still one deterministic shape per call.
- Small connected boxes retain internal end caps and overlapping side fragments.
- Coordinate instancing is tile-local, so up to 12 decoration draws can multiply across four resident tiles.
- Ground cover has no geometric distance LOD; once a tile mesh is visible, all instances use the same family geometry.
- Tiny high-frequency geometry is likely to shimmer because coordinate mode disables antialiasing and runs at adaptive pixel ratio `.5–.85`.
- Building windows, frames, floor trim, aggregate, and terrain motifs already prove that shader detail can replace large amounts of geometry.
- The current roof tank uses an AABB-center anchor; richer detail needs actual support-domain slots, as defined in `CLIPPING_AND_LAYERING_RESEARCH.md`.

The target is therefore **better allocation**, not simply a larger count.

## 3. Three-scale detail grammar

Define one real/style unit `U` in each mode:

- coordinate mode: `U = mapMetresToWorld(1 m) = 0.1` game units;
- curated mode: adapt `U` through the shared world-scale profile rather than copying coordinate constants.

| Scale | Approximate mapped size | Representation | LOD behavior |
|---|---:|---|---|
| Macro silhouette | `≥ 0.8U` | boxes/footprint mesh; trunk, crown, roofline, vehicle body | retained through far LOD |
| Meso surface relief | `0.2U–0.8U` | selective small boxes; branch, awning, ledge, rock shard | near/mid only |
| Micro accent | `< 0.2U` | shader mask, vertex color, tiny texture, rare near-only hero box | removed first |

Screen size is the final authority. For viewport height `H`, object size `s`, camera distance `d`, and vertical FOV `f`:

```text
projectedPixels ≈ H · s / (2 · d · tan(f / 2))
```

If a detail’s narrow dimension projects below roughly 1.5–2 pixels on the low profile, replace it with parent color/mask or omit it. More subpixel boxes add vertex work and shimmer, not visible detail.

## 4. Procedural material architecture

### 4.1 Four sources of appearance

Use them in this priority order:

1. **Vertex/instance palette** — base family, face tint, biome/season variation.
2. **Analytical shader pattern** — grids, stripes, hashes, slope/height bands, low-frequency patches.
3. **Shared generated mask texture** — filtered noise/cellular masks where texture sampling is cheaper and more stable than repeated shader noise.
4. **Geometry relief** — only when it changes silhouette, cast/readable shading, or interaction.

No downloaded texture is required for the baseline.

### 4.2 Proposed shared texture set

The low profile can support the complete material library with about 150 KB of uncompressed GPU data including mips and the existing water normal.

| Resource | Format/size | Channels | Filtering/wrap | Approx. GPU bytes |
|---|---|---|---|---:|
| `surfaceNoise` | 64×64 RGBA8 `DataTexture` | R macro value noise; G fine aggregate; B cellular edge/distance; A directional wear/dirt | Linear mag, linear mip min, repeat | ~22 KB with mips |
| `styleMasks` | 16×16×24 RGBA8 `DataArrayTexture` | up to four scalar masks per layer: brick, paver, bark, leaf, jali, roof, fabric, etc. | Nearest mag, nearest-mipmap min, per-layer repeat | ~33 KB with mips |
| `dither` | 8×8 R8 | Bayer/blue-ish ordered threshold | Nearest, no mip, repeat | 64 B base data |
| `paletteLUT` | 32×8 RGBA8 | environment/material palette slots | Nearest, clamp | 1 KB |
| `waterNormal` | existing 128×128 RGBA8 | tangent normal XYZ + A | Linear/trilinear mip, repeat | ~87 KB with mips |
| **Total** |  |  |  | **~143 KB** |

A 16×16×24 array is only a recommendation after a WebGL/driver compatibility test. Three r170 exposes `DataArrayTexture`. If the target path rejects it, use a 128×128 atlas with extruded gutters and manual per-tile mips; never accept cross-tile mip bleeding.

All resources are generated once from versioned fixed seeds, shared across both modes, and disposed with the shared procedural engine. Do not regenerate them per tile.

### 4.3 Color-space contract

- scalar masks, normal data, dither, IDs, and packed roughness use `NoColorSpace`;
- any stored base-color data uses `SRGBColorSpace`;
- palette values passed as material/vertex colors follow the engine’s Linear-sRGB working-space contract;
- never linearly filter integer IDs or palette indices;
- normal channels are renormalized after sampling/blending.

### 4.4 Shader cost tiers

| Tier | Low | Balanced | High/desktop |
|---|---|---|---|
| analytical hash/noise | ≤ 1–2 hash evaluations/fragment | ≤ 2 hashes or one mask + hash | ≤ 3 samples/hashes |
| octaved fBm | pre-baked into shared mask | max 2 analytical octaves on selected materials | max 3–4, distance gated |
| texture samples/material | 0–2 ordinary | 1–3 | 2–5 selected |
| normal detail | water only by default | water + selected rock/road | selected surfaces |
| triplanar | reject as default | hard top/side projection where needed | selected hero rock/terrain only |

Full procedural noise saves texture memory but costs arithmetic and interpolation. GPU Gems explicitly notes that texture-free noise is more computationally expensive. On the low profile, generate smooth multi-octave masks once on the CPU/worker and sample them rather than running long fBm loops across every terrain pixel.

### 4.5 Distance behavior

- macro palette variation remains to fog distance;
- filtered broad masks remain at distance through mipmaps;
- 16×16 style masks fade to base color before their texels become subpixel;
- normal strength falls to zero earlier than albedo variation;
- high-frequency hashes must be derivative-filtered (`fwidth`/smooth thresholds) or disabled with distance;
- no material recompiles when quality/weather changes; uniforms select bounded branches.

## 5. Practical procedural texture catalogue

### 5.1 Ground, terrain, and geology

| Texture/pattern | Local recipe | Resolution/channels | Filter/repeat | Target | Cost and quality behavior |
|---|---|---|---|---|---|
| alluvial soil mottling | 2-scale value noise + palette mix | `surfaceNoise.RG` | linear mip; 3–8 m repeats | plains/farms | 1 sample; macro channel remains far, fine fades mid |
| red/lateritic soil | broad noise + sparse dark grains | R+G | linear mip; non-integer dual repeats | Deccan/wet tropical soil | 1–2 samples balanced; low uses one |
| cracked dry earth | thresholded cellular boundary | B + analytical threshold | linear mip; 1–2 m | arid ground | near/mid only; no geometry per crack |
| grass block mottling | quantized smooth noise + blade crosses | R + analytical grid | linear mask; world-space repeat | grass/parks | current shader is a good baseline; derivative-filter the blade motif |
| leaf litter | sparse hash clusters, palette flecks | style mask RGBA layer | nearest mip; 0.5–1 m | under canopy | near only; no transparent leaves |
| mud/wet patch | low noise threshold controls rough/dark tint | R | linear mip; 2–6 m | wetland/banks | color/roughness only; no blended puddle by default |
| sand grain/ripple | fine grain G + warped sine bands | G + analytical sine | linear mip; directional repeat | beach/desert | ripple disabled far; align to coast/wind field |
| gravel/pebbles | multi-threshold aggregate | G or style layer | nearest/linear mip | shoulders/industrial | near; selected larger pebbles may become 2–4 box cluster |
| rock speckle | sparse cell centers | G/B | linear mip | boulders/cliffs | one sample; color-only low |
| geological strata | quantized height + warped coordinate | analytical + R | no dedicated image | cliffs/rocks | very cheap; broad bands survive far |
| snow/frost cover | slope/up mask + height/noise | analytical + R | linear | high altitude/season | no texture allocation; profile gated |
| farmland rows | direction-aligned stripes + jitter | analytical hash | derivative filtered | mapped cropland | orientation from polygon/road context; reduce frequency far |
| paddy/wet-field grid | row/bund pattern + dark wet mask | style layer + R | nearest mip | suitable cropland | no soft transparent water on low |

### 5.2 Roads and paving

| Texture/pattern | Local recipe | Resolution/channels | Filter/repeat | Target | Cost and quality behavior |
|---|---|---|---|---|---|
| asphalt aggregate | fine quantized noise | `surfaceNoise.G` | linear mip; 0.25–0.6 m | paved roads | replaces repeated fragment hash if profiled cheaper |
| dust edge | road-edge distance × broad noise | R + geometry distance attr | linear | shoulders | one sample; no extra mesh |
| worn lane marking | along-line coordinate × sparse mask | style layer | nearest mip | markings | near/mid; markings remain geometric silhouette bands |
| paving slab | antialiased rectangular grid | analytical | `fwidth`, no texture | sidewalks/plazas | cheap; surface only |
| brick/herringbone paver | 16×16 scalar mask | style layer | nearest mip | plaza/footway | near only; one palette-tinted sample |
| road crack | sparse cellular ridge | B | linear mip | selected urban roads | very low strength; near only |
| tyre/dirt track | two broad directional bands + noise | analytical + R | linear | tracks/unpaved roads | derived from road tangent |
| curb grime | height/edge gradient × R | no new texture | linear | curbs | surface tint; does not add curb collision |

### 5.3 Buildings, roofs, and materials

| Texture/pattern | Local recipe | Resolution/channels | Filter/repeat | Target | Cost and quality behavior |
|---|---|---|---|---|---|
| plaster/limewash | low noise + vertical dirt gradient | R/A | linear mip | facades | 1 sample; windows remain analytical |
| concrete pores | fine sparse aggregate | G | linear mip | concrete/bridges | near/mid only |
| brick bond | offset rows in 16×16 mask | style layer | nearest mip | selected facades | do not use on every building; palette tint |
| stone block | irregular cellular blocks | style layer or B | nearest/linear mip | landmarks/walls | medium frequency; optional box corner stones only on hero objects |
| facade windows | existing cell grid + stable occupancy | analytical hash | derivative-filtered | mapped buildings | zero texture; add building-specific scale/road-facing logic later |
| jali/perforated screen | binary geometric mask | style layer A | nearest/alpha test | selected facade accent | one bounded plane/box, not blended transparency |
| painted wear/chips | sparse threshold mask | G/A | nearest/linear | doors/walls | near only; color blend, no relief |
| wood grain | warped directional sine | analytical + R | derivative-filtered | doors/boats/benches | 1 sample/hash; object-local coordinates |
| corrugated metal | directional bands | analytical sine | derivative-filtered | roofs/sheds | normal/color perturbation; no tiny corrugation boxes |
| rust/oxidation | cellular spots + downward streak | B/A | linear mip | metal props/roofs | selected accents only |
| roof tiles | offset row mask | style layer | nearest mip | sloped/selected roofs | near/mid; far is one roof color |
| roof dust/wetness | broad noise + slope | R | linear | all roofs as environment permits | one sample shared |
| glass variation | cell hash, Fresnel-like color | analytical | no texture | windows | keep opaque stylized glass on low |
| fabric/check/awning | stripes/check mask | style layer | nearest mip | awnings/vendors | near; one box/plane carries many stripes |
| sign backing | palette + border/glyph mask | generated bounded atlas only if required | nearest | POI/street signs | map names remain DOM unless an LRU in-scene sign system is justified |

### 5.4 Vegetation and organic detail

| Texture/pattern | Local recipe | Resolution/channels | Filter/repeat | Target | Cost and quality behavior |
|---|---|---|---|---|---|
| bark ridges | vertical ridged noise/stripes | style layer + R | nearest/linear mip | trunks/branches | near/mid; far uses face shading only |
| bark patches | broad value threshold | R | linear mip | trunks | one sample shared with other surfaces |
| canopy dapple | quantized cell noise | style layer or G | nearest mip | crown cluster boxes | color-only; opaque geometry |
| leaf-cluster breakup | per-face/vertex palette variation | no texture required | n/a | crown silhouettes | preferred low path |
| palm frond bands | directional center/edge mask | style layer | nearest mip | frond boxes | near; silhouette comes from boxes |
| bamboo nodes | analytical height bands | analytical | derivative-filtered | culms | do not add a ring box at every far node |
| flower center/petal | palette blocks/mask | style layer | nearest | flowers | geometry gives coarse petals; mask gives micro color |
| grass blade gradient | base-to-tip palette | vertex color/height | no texture | grass boxes | free once compiled |
| moss/lichen | low cellular patches | B/R | linear mip | rocks/trunks | environment-gated, near/mid |
| fruit/seed spots | stable sparse hash | G | nearest/threshold | orchard/crowns | color spots or a few near boxes, never every fruit |

### 5.5 Water and effects

| Texture/pattern | Local recipe | Resolution/channels | Filter/repeat | Target | Cost and quality behavior |
|---|---|---|---|---|---|
| water normal | existing two-frequency periodic waves | 128² RGB | trilinear mip/repeat | curated water; candidate shared water | already implemented; strength fades with distance/quality |
| flow direction | world-space sine warped by tangent | analytical | no texture | rivers/canals | tangent field required; one/two waves |
| shore foam/wet band | bank distance × noise threshold | R/G | linear | water edge | alpha-test/dither or opaque tint, not broad blending |
| ripple rings | analytic radial band in bounded instance | shader | n/a | insects/fish/rain | strict count/screen budget |
| ordered fade | 8×8 threshold | dither R | nearest/repeat | camera fade/LOD transition | one shared tiny texture; depth-writing discard |
| rain/snow sprite mask | 8–16 px binary shape | style layer | nearest/alpha test | weather | count and overdraw capped; low may omit |

## 6. Texture generation recipes

### 6.1 Deterministic periodic noise

For every generated pixel/layer:

- use an integer-coordinate PRNG/hash seeded by `materialLibraryVersion` and layer ID;
- wrap lattice coordinates by texture period before hashing;
- use the same wrapped domain for every octave;
- build mip levels from each tile/layer independently;
- record a checksum in diagnostics/tests.

Do not use `Math.random()` or device-dependent canvas filtering for canonical masks.

### 6.2 Filtered macro/micro combination

Break repetition with two incommensurate world-space scales, but reuse one sample where possible:

```text
macro = sample(surfaceNoise, worldXZ / 8.0).r
micro = sample(surfaceNoise, worldXZ / 0.45 + fixedOffset).g
color *= mix(0.88, 1.10, macro) * mix(0.95, 1.04, micro)
```

Low profile can use only macro at distance and one packed sample near. Avoid eight-octave fBm, texture bombing, and three-axis sampling as defaults.

### 6.3 Pixel-style masks

- 16×16 layers intentionally match a low-resolution block-art vocabulary.
- Keep palette outside the texture so one mask serves many biomes/materials.
- Use per-layer wrapping through `DataArrayTexture` to avoid atlas bleed.
- Use nearest magnification.
- Supply per-layer mipmaps or fade the layer before minification shimmer.
- Rotate/mirror from a small deterministic set only when direction is not semantically important.

### 6.4 Canvas textures

`CanvasTexture` is useful for text/signs but should not become a per-building material factory.

If introduced later:

- one shared atlas or strict LRU;
- ≤ 4 live 64×32 sign tiles on low profile;
- map-derived text only;
- regenerate only on label set changes;
- dispose evicted canvases/textures;
- keep geographic labels in the existing DOM path until 3D sign value is proven.

## 7. Vegetation research decision

### 7.1 Candidate methods

| Method | Strength | Weakness | Decision here |
|---|---|---|---|
| stochastic recursive/L-system grammar | compact, fast, deterministic, explicit depth, easy species recipes | can self-intersect or look too symmetric | **baseline** with envelope/occupancy constraints |
| Weber–Penn-style level parameters | strong species controls, recursion-level LOD, proven distant degradation | many parameters; realistic mesh detail exceeds style needs | borrow level, taper, crown, and pruning concepts |
| space colonization | natural irregular crowns, responds to obstacles/neighbor space | attraction-point search is costlier and less predictable | optional archetype compiler, not per placed tree |
| hand-written fixed templates | fastest and easy to budget | repetition; weak response to environment | far LOD and special palms/grass only |
| full botanical simulation | realism | too expensive/complex | reject |

Runions, Lane, and Prusinkiewicz show that competition for space can generate plausible trees/shrubs and adapt to obstacles. Weber and Penn show explicit recursion levels and graceful geometric degradation at distance. For this browser target, use a fast recursive skeleton with a coarse crown envelope; optionally run a small capped space-colonization pass only when compiling a handful of shared biome archetypes in the worker.

### 7.2 Do not recurse per rendered instance

Compile morphology in two layers:

1. **Archetype cache:** 2/3/4 variants per family for low/balanced/high, compiled once per environment recipe version.
2. **Placement instance:** stable variant index, position, yaw, non-uniform scale, palette, age, wind stiffness, and owner.

Hundreds of trees reuse the archetypes. Instance seeds do not create unique geometry unless a rare hero/landmark budget explicitly permits it.

## 8. Vegetation intermediate representation

```js
PlantSkeleton = {
  family,
  seed,
  envelope,
  nodes: [
    { position, parent, depth, radius, stiffness, phaseGroup, organ }
  ],
  clusters: [
    { center, extent, paletteSlot, depth, lodImportance }
  ],
  roots: [...],
  bounds,
};
```

Generation uses keyed random channels, not one mutable random stream:

```text
hash(recipeVersion, family, archetypeIndex, nodePath, "length")
hash(recipeVersion, family, archetypeIndex, nodePath, "azimuth")
hash(recipeVersion, family, archetypeIndex, nodePath, "palette")
```

Changing leaf color rules therefore cannot change branch count or placement.

### 8.1 Generic bounded recursion

```text
grow(parentNode, depth):
  if depth == cap or projected/relative size below threshold:
      emit terminal crown/leaf cluster
      return

  choose child count from family table and node-path hash
  for each child up to remaining node budget:
      direction = parent direction
                + family branch angle/azimuth
                + tropism (up/light/gravity)
                + bounded stochastic bend
      length    = parent length × family length ratio
      thickness = parent thickness × family taper
      reject/redirect if coarse occupancy or envelope fails
      emit child
      grow(child, depth + 1)
```

Hard termination conditions:

- recursion depth cap;
- branch/node count cap;
- minimum relative length/thickness;
- envelope boundary;
- occupancy rejection count;
- geometry/triangle budget.

## 9. Family grammars

| Family | Skeleton/box grammar | Depth cap | Near detail | Mid/far simplification |
|---|---|---:|---|---|
| rounded broadleaf | tapered trunk → 3–5 primary branches → 1–3 secondary branches → 3–7 crown clusters | 3 | asymmetric smaller crown boxes and 2–4 visible twigs | mid keeps primaries + 3 masses; far trunk + 1–2 masses |
| spreading fig/banyan | short thick trunk → wide near-horizontal primaries → droop/prop-root candidates → broad crown | 3 | ≤ 4 prop roots only where ground/support clear | omit prop roots/twigs; preserve wide silhouette |
| upright sal/teak-like | tall trunk → steep alternating branches → compact vertical crown | 3 | narrow branch boxes, tier variation | one trunk + 2–3 vertical masses |
| umbrella/thorn | trunk fork → sparse radial branches → flat top clusters | 3 | visible gaps are important; few small terminal boxes | preserve flat crown, never fill into one round cube unless far |
| conifer | central trunk → 4–7 hashed whorls → tapering branch tiers | 2 | small tip boxes and irregular missing sectors | reduce whorl count; far cone made from 2–3 stacked boxes |
| palm | 3–6 offset trunk segments with lean → 6–9 radial frond chains | 1 | each frond 2–3 tapered boxes; fruit cluster rare | mid one box/frond; far crown cross/mass + trunk |
| bamboo clump | 5–12 slightly leaning culms → node bands → upper paired leaves | 1 | culm height/color variation; 1–2 leaf boxes each | fewer culms; node bands become shader |
| mangrove | short trunks → 4–8 arch/stilt roots → low dense crown | 2 | roots respect water/ground boundary and remain sparse | omit small roots, keep characteristic outer root pair |
| shrub | 3–7 basal stems → one split each → 2–5 crown/leaf clusters | 2 | gaps and uneven heights | 2–3 masses; far one mass |
| herb/flower | stem → opposite/alternate leaf boxes → optional head/petals | 1 | 3–8 boxes total, not 12 by default on low | mid 2–4 boxes; far one color tuft |
| grass/sedge | radial 3–6 blade boxes with height/lean gradient | 0 | no recursive nodes; selective seed head | mid two crossed boxes; far one tuft or shader motif |
| reed | 2–5 upright segmented stems → narrow leaf/seed accents | 1 | water-edge aligned clustering | fewer stems; no individual nodes |
| vine/climber | support-edge path → sparse alternating leaf modules | 1 | only on selected facade/fence/trunk supports | shader/one strip or omitted |
| crop tuft | 3–6 aligned stems/leaves driven by field row frame | 1 | crop-stage head/flower | one/two boxes per tuft; retain row pattern in shader |

These are stylized morphology families, not claims about exact species at a coordinate unless map/environment evidence supports that identification.

### 9.1 Environment and biome variants

A biome preset changes **probabilities and grammar parameters**, not the execution architecture or budgets.

| Environmental recipe | Family mix | Grammar changes | Understory/ground cover |
|---|---|---|---|
| humid tropical | rounded/spreading broadleaf, palm, bamboo | greater crown density and depth; longer droop; saturated dapple | herbs, ferns, flowers; mangrove/reed only near suitable water |
| subtropical plains | rounded/upright broadleaf, orchard-like forms, occasional palm | medium crowns, seasonal palette and age spread | grass, crop tufts, herbs, field-edge shrubs |
| dry deciduous/savanna | upright and umbrella/thorn forms | fewer terminal clusters, wider gaps, shorter branches | sparse yellow grass, thorn shrub, exposed soil |
| arid/semi-arid | umbrella/thorn, compact shrub, rare palm | depth and crown density reduced; roots/lean more visible | sparse tufts/herbs correlated with drainage rather than uniform fill |
| temperate upland | mixed broadleaf and conifer | stronger height taper and irregular tier spacing | shrubs, herbs, leaf litter or frost by season/elevation |
| alpine/highland | low conifer where supported, otherwise shrubs/herbs | wind-shaped lean, low envelopes, no implausible dense canopy | rock-linked herbs and coarse low grass |
| riparian/wetland | spreading broadleaf, bamboo, reed, mangrove where climatically valid | water-directed roots, flatter crowns, clump spacing | sedge/reed bands, wet masks, insects with strict caps |
| dense urban | compact street broadleaf, palms where appropriate, planters | crown pruned from facades/traffic; shallower recursion | sparse verge grass, planter shrubs/herbs |

Blend neighboring recipe weights continuously as already specified in `VISUAL_BIOME_BEAUTIFICATION_RESEARCH.md`; do not select one hard biome at a tile seam. Stable environment quantization may select cached archetypes, while palette and density can vary continuously. Public map/climate evidence should select broad morphology rather than fabricate an exact species.

## 10. Branch and box compilation

### 10.1 Oriented segment box

For a skeleton edge from `a` to `b`:

- center at `(a+b)/2`;
- box length is `|b-a|` plus a 3–8% joint overlap;
- thickness interpolates by depth/age;
- quaternion aligns local Y to normalized `(b-a)`;
- a small junction block is added only when needed to hide a fork crack.

The compiler—not the scene graph—applies this transform to vertices.

### 10.2 Face reduction

Priority order:

1. omit end caps where connected segments bury them;
2. omit faces fully contained by axis-aligned crown neighbors;
3. merge adjacent coplanar crown/voxel faces when material/normal/LOD role matches;
4. retain independent branch side faces where a full union would cost too much;
5. never spend expensive runtime CSG on branch intersections.

A naive box is 12 triangles. An uncapped connected rectangular segment can use 8 side triangles; exposed-face merging can reduce touching crown blocks much further.

### 10.3 Per-vertex attributes

Pack only what the chosen material consumes:

| Attribute | Suggested packing | Purpose |
|---|---|---|
| position/normal | existing float attributes initially | geometry |
| color/palette role | normalized RGB/byte or existing vertex color | bark/leaf/face tint |
| bend weight | normalized byte | trunk-to-tip sway |
| phase group | normalized byte, 0–3 primary groups | coherent branch motion |
| detail role | normalized byte | crown/branch/root behavior and LOD shader |
| local pivot/axis | only balanced/high branch-bend geometry | branch-local bending |

Low profile can use height-weighted global sway and omit local-pivot attributes.

## 11. LOD compilation and switching

### 11.1 Compile from one skeleton

| LOD | Retains | Replaces/omits |
|---|---|---|
| Near | trunk, primary/secondary branches, selected twigs/roots, multiple crown clusters | microscopic organs remain shader/color |
| Mid | trunk, primary branches, major roots, 2–5 crown clusters | secondary branches fold into crown masses |
| Far | one trunk/stem plus 1–3 characteristic masses | all small boxes, roots, nodes, relief |
| Beyond | fog/cull or environment color | no impostor required initially |

All LODs share pivot, overall envelope, stable palette, and placement. Lower quality must not consume a different RNG sequence.

### 11.2 Switching policy

- choose by projected bounding height/width, not fixed world distance alone;
- use 15–20% hysteresis;
- stagger reevaluation by spatial hash so a grove does not switch in one frame;
- update LOD membership after a meaningful focus-cell/camera-distance change, not every tiny movement;
- hard switches are acceptable behind fog/hysteresis; dither crossfade is optional and must not permanently draw both LODs;
- never keep near geometry because a tile’s combined bounding sphere is visible.

### 11.3 Box/triangle caps per archetype

Caps include roots and crown modules. “Triangles” is the naive complete-box ceiling; exposed-face compilation should beat it.

| Family | Near boxes / naive tris | Mid | Far | Low-profile default |
|---|---:|---:|---:|---|
| large broadleaf/conifer | 28 / 336 | 12 / 144 | 3 / 36 | cap near at 18; depth ≤ 2 |
| spreading/banyan/mangrove | 32 / 384 | 14 / 168 | 4 / 48 | cap near at 20; ≤ 4 roots |
| palm | 24 / 288 | 10 / 120 | 3 / 36 | cap near at 16 |
| bamboo clump | 20 / 240 | 8 / 96 | 3 / 36 | cap near at 12 |
| shrub | 12 / 144 | 6 / 72 | 2 / 24 | 8 / 96 |
| herb/flower/reed | 8 / 96 | 4 / 48 | 1 / 12 | 3–5 / 36–60 |
| grass/crop tuft | 5 / 60 | 2 / 24 | 1 / 12 | 2–3 / 24–36 |

A richer near tree is permitted because relatively few large trees are close. Dense ground-cover families get smaller per-instance budgets than they have today.

## 12. Placement, clearance, and obstacle response

### 12.1 Role-specific clearances

| Plant part | Placement rule | Collision rule |
|---|---|---|
| trunk/base | exact building rings expanded by trunk/base margin; road/water/support test | optional tight trunk solid only for large trees |
| root | must lie on valid ground/support and outside routes/buildings | visual by default |
| crown | may overhang low-priority ground cover/road verge; must not enter building mass | camera fade eligible; not player solid |
| branch | clipped/pruned against building/bridge envelope in archetype/placement adaptation | non-solid |
| shrub/herb | small actual base extent, not universal `.22` building halo | non-solid |
| crop/grass | mapped land kind + route clearance | non-solid |

### 12.2 Lightweight obstacle adaptation

Use three levels:

1. **Anchor rejection:** exact ring/road/water test using declared base radius.
2. **Envelope adaptation:** sample 8–16 directions around crown/root envelope against nearby obstacle distances; shrink or flatten blocked sectors.
3. **Branch occupancy:** during archetype adaptation, redirect/prune a branch after 1–2 failed cells.

Do not run full space colonization for every instance. For a street tree beside a facade, a deterministic asymmetric crown scale away from the wall is usually enough.

### 12.3 Ecological placement

Retain the existing world-coordinate octave field and add correlations:

- canopy shade reduces dense grass and enables litter/mushrooms;
- water distance enables reeds/insects and changes root grammar;
- urban intensity chooses compact street trees, planters, and fewer large roots;
- cropland produces aligned row frames instead of random trees;
- climate/biome weights choose family pools and palette, not abrupt tile identity;
- plant age controls scale, branch depth, and crown density from an independent hash channel.

### 12.4 Boundary ownership

The anchor’s half-open source tile owns the placement and all of its LOD records. A crown may cross a tile edge without duplication. Streaming relevance expands by declared overhang as specified in `CLIPPING_AND_LAYERING_RESEARCH.md`.

## 13. Wind grouping

No vegetation instance matrix should be updated on the CPU each frame.

### 13.1 Three motion bands

1. **Whole-plant sway:** one global wind vector, instance phase from world position hash, amplitude scaled by height/stiffness.
2. **Primary branch bend:** at most four phase groups encoded in vertices; slower and smaller than independent random motion.
3. **Leaf/twig flutter:** high-frequency small displacement only on near balanced/high, derived from vertex/detail hash.

Roots and the lower trunk use zero/low bend weight. Crown boxes can shear slightly while preserving blocky form.

### 13.2 Quality

| Feature | Low | Balanced | High |
|---|---|---|---|
| whole-plant sway | yes | yes | yes |
| branch groups | no or 2 | up to 4 | up to 4 + pivot data |
| detail flutter | no | selected near | near |
| CPU matrix updates | none | none | none |
| reduced-motion | static or very slow | suppress gust/flutter | suppress gust/flutter |

Wind phase and palette come from independent deterministic channels.

## 14. Procedural-object detail framework

### 14.1 Recipe output

```js
ObjectRecipe = {
  id,
  owner,
  support,
  authoritativeFootprint,
  height,
  silhouette: [],   // macro modules
  surface: [],      // meso relief or shader assignments
  accents: [],      // near-only small boxes
  visualBounds,
  solidProxies: [], // independently authored; usually unchanged
  interactionProxies: [],
  cameraRoles: [],
};
```

Small box output never enters `solidProxies` implicitly.

### 14.2 Slot resolver

Each parent exposes named slots:

```text
roof.insetCells
facade.edge/floor/roadFacing
bridge.deckSide/pier/railSpan
vehicle.bodyTop/bodyEnd/wheelCorners
rock.surface/top/side
prop.base/top/front
landmark.approach/opening/corner/tier
```

A module declares minimum dimensions, support normal, allowed overlap roles, clearance, LOD importance, and deterministic candidates. The resolver reserves silhouette/functional openings before accents.

### 14.3 Silhouette, surface, accent

| Level | Question | Examples | Collision default |
|---|---|---|---|
| silhouette | does it change recognition against the sky/background? | roof step, tower, balcony mass, bridge rail, vehicle cabin, major rock shard | only separately justified structural proxy |
| surface | does it create readable relief/shading from ordinary range? | sill, awning, cornice, solar panel, stair band | none |
| accent | is it near-only color/story detail? | lamp, AC box, mirror, bumper, finial, flower, sign trim | none |

Use shader masks when the answer is only “surface color.”

## 15. Modular detail grammars

### 15.1 Mapped buildings

**Authoritative input:** exact horizontal footprint rings; vertical height may be approximate.

```text
footprint extrusion
  ├─ roofline: parapet / stepped edge / terrace mass
  ├─ roof slots: tank / stair head / vent / solar / shade frame
  ├─ facade rhythm: analytical floors/windows/material
  ├─ road-facing slot: door / canopy / balcony emphasis
  └─ base: plinth / drain / stain / optional stoop visual
```

Rules:

- mapped ring never expands to include decoration;
- rooftop corners must fit an inset roof polygon and avoid holes;
- ordinary buildings use shader facade detail and 0–4 silhouette modules;
- only a bounded near/hero subset gets 4–20 surface/accent boxes;
- repeated windows remain shader cells, not thousands of cubes;
- facade relief projects outward visually but is non-solid in coordinate mode unless a future gameplay requirement explicitly creates a tight proxy;
- entrance slots stay clear;
- road-facing side derives from nearest suitable road segment, not feature index.

Candidate regional/style recipes can vary colors, shade devices, roof tanks, parapets, balconies, and screens without claiming an unmapped building identity.

### 15.2 Roofs

| Module | Boxes | LOD | Constraint |
|---|---:|---|---|
| parapet | edge strip geometry, not one cube/vertex | far/near | follows valid roof boundary; avoid excessive hidden underside |
| water tank | 1–3 | mid/near | all corners inside inset roof |
| stair head | 1–2 | mid/near | largest valid roof cell |
| solar group | 2–6 repeated panels | near | faces deterministic sunward direction, support legs optional high only |
| vent/chimney | 1–2 | near | stable sparse slot |
| shade frame | 4–8 | near hero | budgeted; no collider |
| sloped/tiled roof | macro wedge/stepped boxes + shader tile mask | far/near | footprint-contained; no per-tile geometry |

### 15.3 Facades

- analytical window/floor grid remains the base;
- add one road-facing entrance emphasis where wall length permits;
- cornice/spandrel strips compile as long boxes/quads, not repeated cubes;
- balcony = slab + front/side rail suggestion, max one/two visible rhythms per selected building;
- awning = one tilted/thin box with fabric mask;
- AC/utility boxes = sparse near-only accents;
- jali = one alpha-tested/dither mask plane or shallow box, not many holes built from cubes;
- drainpipe/wire suggestions are rare and should use a narrow box/line only above the micro-size threshold.

### 15.4 Street furniture

| Object | Silhouette grammar | Surface/accent | Solid/query policy |
|---|---|---|---|
| lamp | pole + arm + head | emissive/color face at night | pole solid only if gameplay needs it; otherwise visual |
| bench | seat + back + two legs | wood/metal masks | non-solid baseline |
| bollard | post + cap | stripe mask | optional tight solid in curated; visual in coordinate low |
| bin | body + lid | face/color label | visual |
| sign | pole + one/two plates | map/context symbol | optional pole proxy only |
| bus shelter | posts + roof + back/bench | opaque/dither panel | structural compound if gameplay requires |
| utility box | body + door inset | vent/grid shader | visual or tight box, never clearance halo |
| fence | repeated posts + long rails | no per-picket microboxes far | rail/post compound only if it closes traversal |

Place from road tangent/normal and reserve carriageway, sidewalk, crossing, and entrance corridors.

### 15.5 Rocks and geology

```text
hero mass
  ├─ 1–3 intersecting angular secondary masses
  ├─ 0–3 chips/plates near only
  └─ strata/speckle/moss shader
```

- use non-uniform scale and deterministic rotation;
- one hero plus satellites forms a cluster better than many equal rocks;
- small rocks are visual;
- a gameplay-blocking rock gets one/two tight OBB/convex proxies around major masses only;
- collision never uses the whole visual cluster AABB.

### 15.6 Vehicles

```text
chassis/body → cabin/roof → bumpers → wheel blocks → light/window color accents
```

| Tier | Boxes | Notes |
|---|---:|---|
| far | 2–3 | body + cabin, readable color |
| mid | 5–8 | wheels or dark underbody, windows |
| near | 8–14 | bumper, lights, cargo/roof accent; no mirror/antenna if subpixel |

A solid parked/moving vehicle uses one tight oriented body footprint plus optional cabin/head-height proxy. Wheels, mirrors, bumpers, cargo detail, and lights do not inflate the hitbox. Dynamic vehicles register in the capped dynamic grid.

### 15.7 Bridges

- deck and traversable support remain authoritative;
- rails use long segments and existing tight AABBs/compounds;
- piers align with water/terrain support and are structural only if reachable;
- repeated rail posts use instancing or merged exposed faces;
- lamps, signs, brackets, cables, and decorative caps are non-solid;
- bridge/tunnel physical level comes from semantic layering, never a decal Y bias;
- opening/clearance tests include player and camera profiles.

### 15.8 Landmarks

Landmarks receive the largest one-object detail budget but still obey openings and compounds.

- identify a small set of load-bearing masses and true openings first;
- reserve approach axis, arch/door voids, stairs, and viewing corridors;
- compile repeated tiers, columns, spokes, crenellations, and trim from loops;
- visual finials/spokes do not enlarge structural collision;
- never assign one landmark-wide AABB when the player should pass through an arch;
- 80–220 boxes can be acceptable for one visible hero only after hidden-face compilation and batching.

### 15.9 Props and food

- 2–12 boxes for ordinary near prop;
- 12–32 for one hero food/kiosk where it is a focal collectible;
- small plates, layers, handles, and toppings remain visual;
- interaction trigger is intentionally separate and may be generous;
- props do not become player blockers unless a deliberate solid proxy is authored;
- a visual bob/spin does not require its trigger to rebuild from visual `Box3` every frame if a stable spherical interaction range suffices.

## 16. Batching and ownership options

### 16.1 Rejected

- one `Mesh` per box;
- one material per color;
- one collider per box;
- one unique generated tree geometry per tree;
- four resident copies of every family/LOD without a draw-call audit;
- transparent cross-card foliage as the main architecture;
- runtime Boolean union of every box.

### 16.2 Recommended baseline

**Compiled archetype geometry + global family/LOD pools**

- compile each family variant/LOD into exposed-face `BufferGeometry`;
- one shared material per compatible palette/wind family;
- place instances in a bounded pool across resident tiles;
- store owner tile and stable placement ID alongside every pool record;
- remove/repack by owner on eviction;
- custom instance attributes carry palette/age/stiffness where driver-safe;
- retain the existing custom attribute path rather than Three’s problematic built-in `instanceColor` on constrained SwiftShader.

This can reduce the current “family × resident tile” draw multiplication, but it needs careful lifecycle tests.

### 16.3 Alternative: `BatchedMesh`

Three r170 `BatchedMesh` supports multiple geometry IDs, instances, per-object visibility/culling, deletion, and optimization. It is attractive for many archetype variants in one material, but adopt it only if tests prove:

- palette/color works on the constrained driver path;
- custom wind data can be derived from geometry/world transform without unsupported per-instance attributes;
- delete/optimize does not create streaming spikes;
- context loss/disposal is clean;
- fallback draw behavior remains acceptable without optional multi-draw support.

### 16.4 Curated `VoxelBatch`

Keep it for landmark/one-off box assemblies. Improve it later by:

- separating visual box instances from explicit structural proxies;
- optionally grouping stable repeated modules;
- avoiding one giant batch whose bounding sphere defeats useful culling;
- compiling hidden faces for very dense static hero assemblies only when profiling justifies the build cost.

## 17. Budgets

The previous beautification budgets remain the global envelope; numbers below allocate that envelope and must not be added on top.

### 17.1 Shared resources

| Resource | Low | Balanced | High/desktop |
|---|---:|---:|---:|
| Generated texture memory, total including current water normal | ≤ 256 KB | ≤ 512 KB | ≤ 2 MB |
| Geometry variants/major family | 2 | 3 | 4 |
| Cached plant/object archetype geometries | ≤ 48 | ≤ 80 | ≤ 128 |
| Added archetype geometry GPU memory | ≤ 1.5 MB | ≤ 3 MB | ≤ 6 MB |
| Added steady draw calls, all beautification | ≤ 8 | ≤ 14 | ≤ 22 |
| Shader programs added | ≤ 4 | ≤ 6 | ≤ 10 |
| Main-thread texture-generation slice | ≤ 4 ms | ≤ 6 ms | ≤ 8 ms |
| Worker archetype compile slice | ≤ 3 ms | ≤ 4 ms | ≤ 6 ms |

Texture generation can be split/yielded if the device exceeds the slice. The first usable road/world phase must not wait for optional style layers.

### 17.2 Visible geometry

| Resource | Low | Balanced | High/desktop |
|---|---:|---:|---:|
| Active coordinate placement records | keep existing max ≤ 5,360 across four full tiles | same unless separately justified | ≤ 1.25× existing |
| Vegetation/detail box modules after LOD | ≤ 6k | ≤ 12k | ≤ 22k |
| Vegetation triangles in ordinary view | ≤ 75k | ≤ 150k | ≤ 260k |
| Non-vegetation small-box detail triangles | ≤ 20k | ≤ 40k | ≤ 70k |
| Total **added** ordinary-view triangles vs current agreed baseline | ≤ 35k | ≤ 70k | ≤ 130k |
| Near rich large plants | ≤ 24 | ≤ 48 | ≤ 80 |
| Near selected detailed buildings | ≤ 8 | ≤ 16 | ≤ 28 |
| One visible hero landmark box budget | ≤ 120 | ≤ 220 | ≤ 400 |
| Visual boxes that create colliders automatically | **0** | **0** | **0** |

The new ground-cover geometry should usually **reduce** current triangles. New herbs/plants replace some existing placements; they do not raise `MAX_GROUND_COVER` merely because more families exist.

### 17.3 Wind and updates

| Work | Low | Balanced | High |
|---|---:|---:|---:|
| CPU vegetation matrix updates/frame | 0 | 0 | 0 |
| LOD membership reevaluation | ≤ 4 Hz or focus-cell change | ≤ 6 Hz | ≤ 10 Hz |
| Environment/material uniform updates | on change / ≤ 10 Hz | ≤ 15 Hz | ≤ 30 Hz |
| Per-frame heap allocation | 0 steady state | 0 | 0 |

## 18. Diagnostics

### 18.1 Material diagnostics

- generated texture dimensions, format, mip count, estimated bytes, seed/version, checksum;
- material sample/hash tier and active distance branch;
- shader program count and compile time;
- texture repeat/atlas layer view;
- UV/world-coordinate seam view;
- high-frequency alias heat map using projected texel/detail size;
- per-material color-space assertion.

### 18.2 Plant/object diagnostics

- skeleton nodes by depth and phase group;
- crown/root envelope and obstacle samples;
- box count, exposed faces, triangles before/after compilation;
- near/mid/far side-by-side silhouette;
- projected detail-size heat map;
- placement owner, variant, age, palette, wind stiffness;
- support slots and occupancy rejects;
- visual bounds versus all role-specific proxies;
- draw pool/family/LOD and owner handle.

### 18.3 Counters

```text
plants by family / variant / LOD
boxes emitted / boxes omitted / end caps removed / faces merged
triangles by vegetation / building detail / props / landmarks
LOD switches / hysteresis holds
placement rejects: road / building / water / support / occupancy / budget
texture bytes / samples / shader variants
pool instances / holes / repacks / eviction time
small visual boxes with any collision proxy (must remain zero unless explicit role)
```

## 19. Acceptance tests

### 19.1 Procedural textures

1. Same library version/seed produces byte-identical arrays and checksums across reloads.
2. Every periodic texture tiles seamlessly in X/Y; every array layer’s independent mips stay in-layer.
3. No atlas/array bleed appears at grazing ground angles.
4. Scalar/normal textures use `NoColorSpace`; stored color uses sRGB annotation.
5. Low library including existing water normal remains ≤ 256 KB estimated GPU memory.
6. At low pixel ratio, moving camera shows no unacceptable road/grass/facade shimmer; offending micro patterns fade or mip.
7. Texture generation does not block the roads-first phase or exceed the time slice.
8. Shader quality changes update uniforms/defines only at setup, not recompile every weather transition.
9. Context loss/Exit disposes all generated textures and program references.

### 19.2 Vegetation determinism and form

1. Fixed recipe/version/archetype hash reproduces identical skeleton and LOD geometry.
2. Palette changes do not move branches; LOD/quality changes do not move placement anchors.
3. Every recursion terminates under depth, node, envelope, and retry caps.
4. At least three large-plant silhouettes appear during a suitable 30 m game-space walk, with biome-appropriate family selection.
5. Near, mid, and far silhouettes retain the family identity (umbrella, palm, conifer, bamboo, etc.).
6. No required detail narrower than the low-profile screen threshold remains in far geometry.
7. Connected branches have no obvious cracks; hidden end caps/faces are reduced.
8. Branch/crown self-intersections are within declared overlap roles; invalid intersections are rejected/pruned.
9. Roots/crowns do not enter mapped building mass or required route corridors.
10. Tile eviction/reload reproduces variant, LOD source, and owner.

### 19.3 Placement and ecology

1. Trunk uses exact ring/base clearance; shrubs/herbs no longer inherit one universal `.22` halo.
2. Ground cover stays out of roads, entrances, water, spawn, and reserved gameplay routes.
3. Crown overhang and root behavior follow declared role rules.
4. Crop/grass rows align coherently; riparian plants correlate with water; shade modifies understory.
5. No boundary duplicate/gap comes from independent tile seeds.
6. Large visual overhang remains resident through expanded owner relevance.

### 19.4 Wind

1. Vegetation uses zero per-instance CPU matrix updates.
2. Lower trunk/root remains stable while tips move.
3. One plant moves coherently; adjacent plants do not share an obvious identical phase.
4. Wind does not open branch joints or move collision proxies.
5. Reduced-motion disables gust/flutter and retains a calm readable world.

### 19.5 Small-box object detail

1. Every recipe categorizes modules as silhouette, surface, or accent.
2. Enabling all visual detail leaves authoritative mapped building rings byte-identical.
3. Rooftop details remain inside concave polygons and outside holes.
4. Facade details fit wall slots, face outward, and preserve entrances.
5. Vehicle wheels/mirrors/lights do not enlarge body collision.
6. Landmark arches/openings use compounds, never a landmark-wide AABB.
7. A failed module exhausts bounded attempts and skips; no infinite loop or floating fallback.
8. No per-box mesh/material/collider/listener/timer is created.

### 19.6 Performance and visual audit

Capture moving TPP and close FPP at the same matrix already defined in the visual research, including Meerut, a dense urban tile, open cropland, wetland/coast, forest/mountain, and arid terrain.

For each quality profile record:

- FPS, average CPU, worst stable frame gap, long tasks;
- draw calls, triangles, geometries, textures/programs;
- resident tiles and placement/LOD counts;
- worker build and archetype compile time;
- texture bytes and generation time;
- screenshots from stationary and moving cameras to reveal shimmer/popping.

Low profile must remain at the existing 30 FPS target on constrained software/mobile audits. If the triangle budget passes but frame time fails, degrade measured bottlenecks rather than adding a higher nominal cap.

## 20. Degradation order

Under sustained pressure:

1. remove micro style masks and detail normal strength;
2. shorten near-detail distance and reduce rich-plant count;
3. use low archetype box caps and far LOD earlier;
4. remove optional roots, twigs, facade accents, and rock chips;
5. reduce geometry variants, preserving family silhouette diversity where possible;
6. reduce ground-cover density only after simplifying its geometry;
7. retain macro palette, mapped roads/buildings/water, exact collision, and major vegetation silhouettes.

Never degrade by:

- replacing procedural masks with downloaded high-resolution textures;
- creating one draw/collider per box;
- changing seeds/placements frame to frame;
- making every plant one identical cube before removing invisible micro detail;
- increasing hitboxes to match visual detail;
- dropping roads-first streaming or exact mapped footprint ownership.

## 21. Phased recommendation

### Phase 0 — measurement and compiler prototype

- Add triangle/box/face diagnostics for current 12 coordinate archetypes.
- Establish `U`, semantic detail roles, keyed random channels, and recipe versioning.
- Prototype end-cap removal and exposed-face compilation in tests only.
- Benchmark global family pools versus existing tile-local meshes and a gated `BatchedMesh` experiment.

### Phase 1 — texture library

- Generate `surfaceNoise`, `styleMasks`, `dither`, and palette LUT once.
- Add deterministic checksum/seam/color-space tests.
- Replace or supplement expensive repeated hashes only after per-material profiling.
- Add distance filtering before expanding the pattern catalogue.

### Phase 2 — vegetation grammar

- Implement broadleaf, palm, shrub, herb, grass, and bamboo skeleton recipes first.
- Compile low near/mid/far geometries with strict caps.
- Reuse existing placement counts and exact obstacle logic.
- Add GPU whole-plant sway after static LOD correctness.

### Phase 3 — obstacle adaptation and biome variants

- Add role-specific base/crown/root clearances.
- Add coarse crown pruning away from buildings.
- Connect continuous environment weights from the visual research.
- Add conifer, umbrella, mangrove, reed, crop, and vine only as their environments require.

### Phase 4 — procedural object detail

- Replace unsafe roof anchors and centralize support slots.
- Add near-only pooled building, roof, facade, street, rock, and vehicle modules.
- Preserve shader detail as the default for ordinary mapped buildings.
- Add structural landmark/bridge compounds independently from visuals.

### Phase 5 — polish only after budgets pass

- branch-group/detail wind;
- selected dither transitions;
- richer hero landmark detail;
- optional space-colonized shared archetypes;
- higher-tier normal/triplanar material branches.

### 21.1 Implemented resident-pool checkpoint (`VEG-06`)

The low-profile baseline now follows Section 16.2 without adopting the gated `BatchedMesh` alternative:

- `PlantRenderPools` converts each compiled indexed family/variant/LOD source into deterministic de-indexed `BufferGeometry`. The two low archetype variants occupy paired position/normal/packed-role streams and a custom per-instance variant selector, so one family/LOD draw supports both variants without relying on optional multi-draw behavior.
- One global pool group spans every resident coordinate tile. CPU records retain source owner and stable placement ID even when a plant's visual envelope crosses a tile edge; eviction removes exactly that owner and repacks each affected pool by sorted stable ID.
- Custom `gdoPlantPalette`, normalized `gdoPlantTraits` (age, stiffness, phase), and `gdoPlantVariant` attributes extend the proven custom-attribute path. Three's built-in `instanceColor` is absent. Packed per-vertex palette, bend, phase, detail-role, and LOD values survive variant pairing for later `VEG-09` wind.
- Each record belongs to exactly one near/mid/far pool, or no draw pool beyond the cull threshold. Individual camera/FOV/viewport projection, hysteresis, focus cells, four-Hz policy, and eight stable schedule slots come from `VEG-05`. Repacking writes matrices only when ownership or LOD membership changes; an unchanged frame performs no vegetation matrix upload or pool allocation.
- All three family tiers are prepared only after a tile reaches its usable buildings/collision phase, preserving roads-first startup. Non-plant props and bounded CPU-animated birds/bees retain their existing tile-owned paths.
- The low hard limits are four owners, 5,360 records, 18 family/LOD pools, 48 source geometries, 1.5 MiB static uploaded geometry, 75,000 visible plant triangles, and at most eight draw additions over the replaced tile-local plant families. Context restoration marks retained attributes for upload; final disposal releases meshes, geometry tiers, material, selector state, and the reference-counted compiler library.
- At this `VEG-06` checkpoint, before the later role-clearance filters, the densest canonical provider-equivalence fixture recorded 1,259 plants, 14 active pools, 30 source geometries, 168,780 static GPU-geometry bytes, 11,066 visible plant triangles, and an eight-draw delta. These are deterministic Node/Three structure measurements, not browser/mobile visual-performance proof.

Automated coverage includes deterministic source uploads, paired variants, custom shader composition, one-active-LOD membership, staggered projected-size changes, owner eviction/repack, GPU-record remount reproduction, no per-tile pool multiplication, all low caps, context restoration, and disposal. Browser capture remains unavailable, so this checkpoint does not claim moving visual acceptance or constrained-device frame-time acceptance.

### 21.2 Implemented hydrology and ecological-clearance checkpoint (`LAY-04`, `TER-07`, `VEG-07`)

`VEG-07` declared `TER-07` as a dependency, and `TER-07` in turn required `LAY-04`; those prerequisites were therefore implemented in this slice rather than silently treating queued work as complete:

- `GeoWaterDomains` packs mapped water polygons, ring/polygon offsets, broad-phase bounds, waterway centrelines/half-widths/classes, and mapped wetland polygons into versioned typed arrays. Its bounded query returns signed water distance, nearest water anchor, an explicit waterway class when present (polygon class remains `TER-08`), ecological ground/bank/shoreline/wetland/water domain, and ground-support validity. The low contract caps polygon vertices and waterway segments, records cap events, transfers with the worker context, remains resident for later effects, and releases with its source tile.
- Waterway ribbons whose complete width intersects exact polygon water are conservatively omitted from the transparent context mesh. Their query segments remain in the water domain, so overlap removal does not erase support/ecology truth and requires no runtime clipping CSG. This closes the deterministic `LAY-04` mesh gate while the broader moving transparent-water audit in `LAY-03` remains active and is not claimed here.
- `PlantClearance` derives base radius, horizontal root extent/depth, crown radius, and world scale from the semantic family recipe plus the actual decoration scale. Canopy trees, palms, shrubs, herbs, grass, and ground cover no longer share `.22`. Base anchors test exact building rings (including courtyard holes), ground-grade route width plus the declared base, water edge distance, and terrain slope/support. Declared roots additionally stay outside exact buildings, routes, and unsupported water/shore extents. Grass/ground cover also use mapped land kind; their tiny actual bases remain non-solid.
- Crown and branch policy is intentionally different from anchor/root policy. Crowns may cross source-tile edges, low-priority non-solid ground cover, and road verges without changing the half-open source owner. Building proximity invokes at most 16 deterministic inner/outer envelope samples and a bounded asymmetric scale/shift. One `gdoPlantClearance` `vec4` applies only to branch, frond, blade, leaf, and flower roles; trunk/stem/culm anchors and roots remain fixed. The complete paired low upload uses exactly 16 vertex-attribute locations, creates no per-plant geometry or collision proxy, and does no full per-instance space colonization.
- Context diagnostics report candidates, accepted/rejected/adapted counts, semantic role, minimum/maximum declared extents, named acceptance/rejection/adaptation reasons, tested/blocked obstacle samples, and nature/ground-cover/road/building/water-domain cap events. World diagnostics aggregate rejection, adaptation, sample, and resident water-domain counters.

The deterministic gates cover exact outer rings and courtyard holes, actual herb/tree extent differences, root route/water support, allowed crown-over-verge behavior, mapped ground-cover land kinds, bounded crown adaptation, transparent overlap suppression, domain caps, OpenMapTiles/Shortbread equivalence, fixture byte equivalence, half-open anchors, owner eviction/remount, context restoration, fallback tiles, and low resource ceilings. At this checkpoint, before `VEG-08` changed family/density response, `npm run check` passed 110 tests and built 108 Vite modules. The dense provider-equivalence upload then contained 1,258 plants in 14 active pools over 30 source geometries, 168,780 static GPU-geometry bytes, 11,072 visible triangles, and an eight-draw delta (5 near, 26 mid, 555 far, 672 beyond). These remain historical Node/Three structural measurements. Browser capture was unavailable, so no moving visual or constrained-mobile frame-time acceptance was claimed.

### 21.3 Implemented continuous artistic morphology checkpoint (`VEG-08`)

The morphology stage now follows Sections 5 and 7 without expanding geometry beyond the existing low two-variant cap:

- `PlantMorphology` samples a pure versioned fallback at each candidate. Latitude and smoothly interpolated 6,400-unit absolute-coordinate anomaly cells establish broad temperature/moisture variation; the deterministic terrain query, `TER-07` signed water/wetland role, mapped land kind, and bounded road/building proximity act as local modifiers. Tropical, subtropical, arid, upland, riparian, and urban scores remain blended and normalized rather than collapsing into a source-tile enum.
- The fallback performs no climate, elevation, land-cover, or species request. Its metadata names `latitude-map-water-terrain-v1`, and profile labels are explicitly broad artistic direction rather than scientific climate or exact species identification.
- Family and density selection plus two-variant recipe choice, X/Y/Z scale/aspect, palette, age, and stiffness all derive from the same profile. Riparian/tropical weighting exposes the already compiled bamboo family geographically. Arid, urban, route, building, unsupported water, and disallowed mapped-land evidence reduce or reject vegetation through continuous density plus the existing exact clearance path.
- Every decoration has one aligned 13-byte transfer record: three conservatively quantized morphology axes; variant, palette, age, and stiffness bytes; and three profile IDs with three weights that sum to 255. The tile display summary transfers ten bounded field bytes, the same dominant-three representation, and one blended ground colour. No dense environment raster or per-tile recipe cache exists.
- Morphology width is composed into `VEG-07` before acceptance using the widest horizontal axis. Crown adaptation remains branch-organ-only, and local shifts are corrected for the rendered nonuniform axes; anchors, roots, ownership, stable IDs, collision, one-active-LOD membership, and eviction/remount behavior remain unchanged.
- `GeoWorld` now acquires one fixed versioned morphology recipe/LOD library at all coordinates instead of keying geometry by the session origin. The global ground colour approaches focus-profile changes at a bounded 10 Hz, avoiding abrupt shared-material assignment while leaving mapped vertex colours authoritative.

The automated gates cover finite and malformed input, six-influence response, macro interpolation and exact shared-position seams, dominant-three quantization, correlated family/variant/trait response, bamboo reachability, provider equivalence, compact aligned transfer, nonuniform pool placement, fixed cross-coordinate recipe sharing, exact clearance composition, fixture determinism, owner remount, and all low ceilings. `npm run check` passes 118 tests and builds 109 Vite modules. The provider-equivalence upload contains 1,044 plants in 11 active pools over 36 source geometries, 208,452 static GPU-geometry bytes, 11,190 visible triangles, and a four-draw delta (0 near, 35 mid, 461 far, 548 beyond). These are Node/Three structural measurements. Browser capture remains unavailable, so this checkpoint does not claim the moving FPP/TPP visual audit or constrained-mobile frame-time acceptance.

### 21.4 Implemented whole-plant GPU wind checkpoint (`VEG-09`)

The first wind tier now follows Sections 12 and 16 while keeping detail bending separate:

- A versioned `PlantWindState` owns exactly one global normalized X/Z direction, strength, gustiness, and a precision-safe wrapping clock. The shared shader generates smoothed low-frequency whole-plant, gust-envelope, and turbulence waves; no plant owns a timer or CPU oscillator.
- The paired-variant vertex path consumes mixed source position/metadata, applies existing crown adaptation, then uses object height, packed bend byte, exact root detail role, normalized per-instance stiffness, stable per-instance phase, and stable world-origin phase. Phase-group metadata is deliberately not consumed, preventing this slice from silently becoming deferred `VEG-10`.
- World direction is transformed into object space through normalized model/instance axes, so instance yaw does not rotate the apparent global field. Horizontal displacement is capped by `.055` shader amplitude and a `.06` uploaded geometry culling margin. Lower sections respond progressively, root-role vertices remain exact, and one plant retains a coherent wave rather than independent per-vertex noise.
- Reduced motion zeroes gust/turbulence and caps remaining calm strength. Invalid fields fall back to defaults, clock precision wraps continuously after 65,536 seconds, uniform objects survive context restoration, and disposal releases wind state with the one shared plant material.
- Collision, support, clearances, anchors, source owners, LOD membership, and instance matrices are not deformed. Ordinary wind frames perform one shared scalar uniform write, zero CPU vegetation matrix updates, and zero steady-frame wind allocation. The low budget collector makes all three limits explicit.

Tests mirror the shader field on the CPU to prove determinism, bounds, fixed roots/ground, tip/bend/stiffness response, adjacent stable-phase variation, yaw/world alignment, reduced motion, wrapping, malformed fallback, context/disposal continuity, shader composition, unchanged instance buffers, and culling reserve. The closing `VEG-09` gate passed 125 tests and built 110 Vite modules. Geometry, record, draw, triangle, and byte totals remain those of `VEG-08`. Browser capture remains unavailable, so no moving wind visual or constrained-mobile timing acceptance is claimed.

### 21.5 Implemented checkpoint: compact water class/flow inputs (`TER-08`)

The version-2 hydrology contract now carries a byte-sized provider-neutral class per water polygon and waterway plus normalized signed 16-bit flow components. Flowing polygons accept only explicit normalized input or a bounded same-class touched stream/canal/river centreline; mapped line endpoint order stays authoritative, while lakes/oceans/unmatched water remain still. The fields transfer with the source-owned tile, add no material, texture, draw, or steady-frame simulation, and canonical fixtures peak at 77 water-domain bytes/tile under a 512 KiB hard low-profile ceiling.

This supplies compact inputs for the existing generated-water-normal and shared-material architecture without prematurely implementing `ENV-03`. Future class palettes, wave bands, foam, shallow/deep tint, and rain response must consume this shared schema rather than add per-tile textures/materials or an unbounded flow simulation. Automated tests cover aliases, provider semantic equivalence, reversed geometry order, still water, malformed input, transfer, remount, deterministic association pruning, diagnostics, and bytes; the integrated gate now passes 128 tests and builds 110 Vite modules. No browser moving-water visual acceptance is claimed.

### 21.6 Implemented checkpoint: mapped building/roof/facade grammar (`DET-04`)

The object contract is now `gdo:objectGrammar:v2`. Ordinary mapped buildings retain their one-draw analytical window/frame material, footprint extrusion, parapet, and exact-slot tank baseline. A geometry-hashed, order-independent priority then selects at most eight buildings from the current source tile for one separate visual-only batch. A capped 8-unit road index ignores non-ground transport and derives the nearest suitable outer wall geometrically; that wall may receive an outward entrance panel, canopy, cornice, one upper balcony rhythm, and a sparse utility box. Missing/too-distant mapped roads produce no fabricated entrance direction. Remaining exact concave/hole-safe roof slots may receive one stair head, a solar pair, or a vent pair, and invalid/occupied slots are skipped.

Oriented boxes retain silhouette/surface/accent roles and explicit visual bounds, but every generated solid, interaction, and camera proxy list stays empty. Enabling the batch leaves mapped collider AABBs, exact polygon/ring arrays, spans, and masks byte-identical. Only the focused source tile exposes its detail mesh, so at most eight detailed buildings and one added draw are visible; eviction disposes the tile-owned typed geometry and remount reproduces it. Hard low limits are 4,096 indexed road segments, 32,768 road-facing tests/tile, eight buildings, 96 boxes, 20,000 triangles, 256 KiB typed geometry, and one added draw. The dense canonical fixture uses 2,956 road tests, eight buildings, 88 boxes, 1,056 triangles, and 88,704 bytes; every selected recipe has at least four boxes while remaining below its 20-box ceiling.

Automated tests cover road-order independence, outward orientation, entrance reservation, roof containment, missing-road fallback, malformed/capped roads, stable capped selection, provider equivalence, visual/collision isolation, focus-tile visibility, transfer, eviction/remount, diagnostics, and all budget gates. The integrated gate passes 134 tests and builds 110 Vite modules. Browser capture remains unavailable, so no moving FPP/TPP facade-pop, composition, or constrained-mobile frame-time acceptance is claimed.

### 21.7 Implemented checkpoint: street-furniture grammar (`DET-05`)

The new `gdo:streetFurniture:v1` contract compiles seven fixed `DET-02` families: lamps, benches, bollards, bins, signs, bus shelters, and utility boxes. Each recipe separates silhouette, surface, and accent modules and declares far/mid/near importance. The shared object compiler emits complete modules in that order under four-module/eight-box family caps, so reductions omit accents before structural silhouette. Visual bounds remain descriptive only: every furniture recipe has empty solid, camera, interaction, and clearance proxy arrays.

Placement comes from canonical physical-level-zero road geometry rather than provider feature indices. Segment endpoint orientation, width, and normalized kind form a quantized key; tangent/normal frames, keyed channels, bounded stable-ID collision resolution, and a half-open source-tile clip make the six-float `x, z, scale, family, yaw, stableId` stream reproducible across provider aliases, feature reorder, line reversal, eviction, and remount. Conservative reservations protect the source carriageway and sidewalk offset, segment midpoint crossing area and endpoints, nearby road/intersection ribbons, exact mapped building perimeter/entrance belts, water domains, the spawn calm area, existing ambience anchors, and already accepted furniture. Non-ground and unsuitable roads are ignored. Missing roads yield no furniture, while malformed or truncated road/building/water/ambience domains fail closed rather than trust an incomplete obstacle set.

Rendering uses seven merged fixed geometries and one owner-scoped global `InstancedMesh` per family, not one geometry/material/listener/timer/collider per box. Four source owners and 256 records are the resident maximum. Atomic owner replacement checks entry, active-draw, visible-triangle, and fixed GPU ceilings before repacking; owner keys and 24-bit geometry-derived IDs determine upload order. Worker transfer, cancellation boundaries, tile replacement/eviction, context restoration, disposal, fixture fingerprints, diagnostics, and the lazy debug overlay all retain the dedicated stream. Pool replacement leaves every tile collider/ring/span/mask/grid reference untouched.

Low-profile gates are 256 resident entries, seven fixed source families and at most seven added draws, 25,000 visible triangles, 256 KiB fixed pool GPU storage, 1,536 placement bytes/tile, 32,768 reservation tests/tile, and zero steady-frame matrix updates. The canonical provider-equivalence mount uses four records, three active family draws, 108 triangles, 138,376 bytes of fixed geometry/matrix capacity, 96 transferred bytes, and 22 tests. The dense fixture uses 36 records, five active family draws, 1,224 triangles, 864 transferred bytes, and 1,018 tests. The integrated gate passes 141 tests and builds 119 Vite modules. Browser capture remains unavailable, so this checkpoint makes no moving FPP/TPP furniture-composition, pop, or constrained-mobile frame-time claim.

## 22. Sources

### Three.js textures, geometry, and batching

- [Three.js textures manual](https://threejs.org/manual/en/textures.html) — texture memory is approximately `width × height × 4 × 1.33` bytes for RGBA with mips; mips reduce distant flicker.
- [Three.js `DataTexture`](https://threejs.org/docs/pages/DataTexture.html), [`DataArrayTexture`](https://threejs.org/docs/pages/DataArrayTexture.html), and [`CanvasTexture`](https://threejs.org/docs/pages/CanvasTexture.html) — raw generated data, array layers, filters, updates, and canvas-backed textures.
- [Three.js voxel geometry manual](https://threejs.org/manual/en/voxel-geometry.html) — per-voxel scene objects are too expensive; chunk/face geometry is the appropriate representation.
- [Three.js `InstancedMesh`](https://threejs.org/docs/pages/InstancedMesh.html) and [`BatchedMesh`](https://threejs.org/docs/pages/BatchedMesh.html) — repeated and varied geometry batching/culling.
- [Three.js transparency manual](https://threejs.org/manual/en/transparency.html) — alpha test for sharp foliage and the limits of object/triangle sorting.
- [0 FPS: Meshing in a Minecraft Game, part 2](https://0fps.net/2012/07/07/meshing-minecraft-part-2/) — greedy/monotone voxel face reduction, costs, and relevance when smaller cubes increase geometry.

### Procedural texture generation

- [GPU Gems 2, Chapter 26: Improved Perlin Noise](https://developer.nvidia.com/gpugems/gpugems2/part-iii-high-quality-rendering/chapter-26-implementing-improved-perlin-noise) — procedural noise saves texture memory but increases shader computation.
- [GPU Gems, Chapter 5: Improved Noise](https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-5-implementing-improved-perlin-noise) — band-limited noise, procedural material expressions, and avoiding frequencies above the pixel sample rate.
- [GPU Gems 3, Chapter 1: Procedural Terrain](https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-1-generating-complex-procedural-terrains-using-gpu) — small repeating noise, multi-scale frequencies, world-space projection, color, and normal perturbation.
- [Minecraft Wiki texture packs](https://minecraft.wiki/w/Texture_pack) — the classic block-art baseline uses 16×16 block/item textures; this research uses that only as a style-resolution reference.

### Vegetation grammars and LOD

- [Prusinkiewicz and Lindenmayer, *The Algorithmic Beauty of Plants*](http://algorithmicbotany.org/papers/abop/abop.pdf) — L-systems, bracketed branching, and plant-form grammars.
- [Weber and Penn, *Creation and Rendering of Realistic Trees*](https://dl.acm.org/doi/10.1145/218380.218427) — recursion-level tree parameters and graceful geometric degradation at distance.
- [Runions, Lane, and Prusinkiewicz, *Modeling Trees with a Space Colonization Algorithm*](https://algorithmicbotany.org/papers/colonization.egwnp2007.large.pdf) — crown envelopes, attraction points, competition for space, shrubs, and obstacle adaptation.
- [Algorithms for Procedural Generation and Display of Trees](https://www.zemris.fer.hr/~zeljkam/radovi/19_Mipro_Nuic.pdf) — L-system speed versus space-colonization shape control and bounded abstract skeleton generation.
- [Procedural Generation and Rendering of Forests](https://arxiv.org/pdf/2208.01471) — seeded L-system forests, LOD, branch self-intersection risk, and pre-generation for runtime performance.
- [GPU-Generated Procedural Wind Animations for Trees](https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-6-gpu-generated-procedural-wind-animations-trees) — instancing, stochastic wind fields, and simulation LOD.
- [Vegetation Procedural Animation and Shading in Crysis](https://developer.nvidia.com/gpugems/gpugems3/part-iii-rendering/chapter-16-vegetation-procedural-animation-and-shading-crysis) — main/detail bending, phase, stiffness, smoothed waves, and precomputed attributes.

### Related repository research

- [`VISUAL_BIOME_BEAUTIFICATION_RESEARCH.md`](./VISUAL_BIOME_BEAUTIFICATION_RESEARCH.md) — continuous environment fields, morphology families, wind, effects, composition, and parent budgets.
- [`CLIPPING_AND_LAYERING_RESEARCH.md`](./CLIPPING_AND_LAYERING_RESEARCH.md) — role-specific proxies, support domains, camera/player sweeps, semantic layers, and tile ownership.
- [`MINIMAL_PHYSICS_RESEARCH.md`](./MINIMAL_PHYSICS_RESEARCH.md) — physics scope, deterministic stepping, static-proxy architecture, engine comparison, and degradation.

## 23. Decision summary

1. New texture data stays generated, shared, versioned, and under 256 KB total on low including water normals.
2. Shader color/masks describe microdetail; boxes describe silhouette and selected relief.
3. Dense ground cover gets fewer boxes per instance than today, not more.
4. A bounded stochastic recursive grammar is the baseline; space colonization is optional for a few cached archetypes.
5. Each family compiles one skeleton into near/mid/far exposed-face geometries.
6. Quality and palette changes do not change placement or collision seeds.
7. Wind is vertex-shader grouped and performs zero vegetation matrix updates on the CPU.
8. Small visual boxes never automatically create gameplay hitboxes.
9. Ordinary mapped buildings remain shader-detailed; selected nearby/hero objects receive pooled box modules.
10. Tile ownership remains exact even when visual modules cross boundaries.
11. Existing added draw/triangle/texture budgets are global ceilings and do not stack with this proposal.
12. The first implementation work should reduce current hidden faces and ground-cover triangle cost before adding any new box families.
