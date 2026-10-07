/**
 * `DET-09` — landmark grammar and openings.
 *
 * Registered gate (feature-roadmap/README.md order 098):
 *   "Repeated modules batched; arches never use one enclosing AABB"
 *
 * Research (`PROCEDURAL_TEXTURES_AND_SMALL_BOX_GRAMMARS_RESEARCH.md`):
 *   §15.8 *"Landmarks receive the largest one-object detail budget but still obey openings and
 *   compounds"*: identify the load-bearing masses and true openings first; reserve the
 *   approach axis, arch voids, stairs and viewing corridors; **compile repeated tiers,
 *   columns, spokes, crenellations and trim from loops**; visual finials/spokes do not enlarge
 *   structural collision; **never assign one landmark-wide AABB when the player should pass
 *   through an arch**; 80–220 boxes are acceptable for one visible hero after batching.
 *   §16.4 — keep the curated `VoxelBatch` for landmark assemblies, but *"separate visual box
 *   instances from explicit structural proxies"*.
 *   §17.2 — one visible hero landmark: **≤ 120 / ≤ 220 / ≤ 400 boxes by profile**, and
 *   **visual boxes that create colliders automatically: 0**.
 *   §19.5 — item 1 (every recipe categorizes modules as silhouette/surface/accent), item 6
 *   (arches use compounds, never a landmark-wide AABB) and item 8 (no per-box mesh, material
 *   or collider).
 *
 * WHAT THIS REPLACES, AND WHY THE GATE IS MEASURABLE
 * -------------------------------------------------
 * The two shipped landmarks were hand-written loops inside `BiomeManager` (`gateway()` and
 * `chariot()`), and their camera blockers were a **second, hand-written list** that had to be
 * kept in step by hand. Nothing declared that the Gateway has an opening: a reader had to
 * infer it from the shape of two loops, and nothing would have stopped a later edit from
 * filling it. The landmark is now a **declarative artifact that is compiled**:
 *
 * 1. **Repeated modules are declared once and expanded from loops.** A module carries a
 *    `repeat` descriptor (`grid`, `walk`, `arc`, `ring`, `stack`, `line`) instead of a list of
 *    boxes, and a `grid` may compose an inner repeat (`each`), which is how a wheel is written
 *    as *four positions × sixteen rim stones* rather than as sixty-four literals. "Batched" is
 *    then structural rather than hopeful: every box of a landmark is stamped into **one
 *    `VoxelBatch`**, whose build path instances by material family with colour as an instance
 *    attribute, so the draw cost of a 108-box monument is the number of *families* — not the
 *    number of boxes and not the number of colours. `landmarkBatches()` reports that plan so
 *    the claim is counted rather than asserted.
 * 2. **The opening is declared, and no box may enter it.** A landmark declares its `voids` as
 *    *profiles* — a stack of bands, each with a free half-width — which is the shape a stepped
 *    arch actually has: full width between the piers, narrowing as the voussoirs step inward.
 *    The compiler drops and counts any box, or proxy, whose footprint enters the free core of
 *    a band, so §15.8's *"never one landmark-wide AABB"* is a property of the artifact: a
 *    single box spanning the landmark cannot exist, because it would intersect a band. The
 *    intrusion count is a **defect counter**, not a tolerance — the shipped definitions must
 *    compile to zero.
 * 3. **Proxies are declared per module site, never inferred from drawings.** A proxy is
 *    emitted **once per outer repeat site**, so a wheel is one collider slab rather than
 *    sixteen rim colliders and eight spoke colliders (§19.5 item 8). `structural: false`
 *    modules — finials, spokes, crenellations, trim — emit **no** proxy at all, which is
 *    §15.8's *"visual finials/spokes do not enlarge structural collision"* and §17.2's
 *    *"visual boxes that create colliders automatically: 0"* expressed as one rule. A mass
 *    whose collision is larger than its drawing declares that explicitly (the Gateway tower).
 * 4. **Budgets are enforced.** An expansion that exceeds the profile's box budget loses its
 *    accents first, then surface, and never silhouette; `diagnostics.budgetSkips` says how
 *    many were dropped rather than leaving it to be discovered in a profile sweep.
 *
 * The ported corpus is faithful to the shipped geometry — `GeoLandmarkGrammar.test.js`
 * compiles both landmarks and compares every box against a legacy table transcribed from the
 * pre-`DET-09` source, so the change is provably cosmetic-neutral.
 */

/** §17.2: "One visible hero landmark box budget" per profile. */
export const GEO_LANDMARK_BOX_BUDGETS = Object.freeze({ low: 120, balanced: 220, high: 400 });

/** §19.5 item 1: every module is categorized. */
export const GEO_LANDMARK_ROLE = Object.freeze({
  SILHOUETTE: 'silhouette',
  SURFACE: 'surface',
  ACCENT: 'accent',
});

/** Drop order when a definition exceeds its budget: accents first, then surface, never silhouette. */
const ROLE_PRIORITY = Object.freeze({ accent: 0, surface: 1, silhouette: 2 });

/** The repeat vocabularies the research names: tiers, columns, spokes, crenellations, trim. */
export const GEO_LANDMARK_REPEAT_KINDS = Object.freeze(['grid', 'walk', 'arc', 'ring', 'stack', 'line']);

/**
 * How far a drawn box may reach past a declared free width before it counts as an intrusion.
 *
 * The voussoirs of the shipped arch are *defined* by the band edges — a step's inner edge is
 * exactly the width the band declares — and `4.3 - 0.7` is `3.5999999999999996` in binary
 * floating point, so an exact comparison would reject the arch stones it was measured from.
 * A tenth of a millimetre of slack is far below anything a player or a camera can observe,
 * and it is applied in both directions (a box intruding by more than this is dropped).
 */
export const GEO_LANDMARK_VOID_TOLERANCE = 1e-4;

function assertFinite(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`Landmark ${label} must be finite, received ${value}`);
  return value;
}

function assertPositive(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`Landmark ${label} must be finite and positive`);
  return value;
}

/**
 * Expand one repeat descriptor into its **outer site** list.
 *
 * Every kind is closed-form: step `index` is a function of `index` alone, never of the
 * previous step, so the expansion is deterministic and can be truncated at any index without
 * changing the steps before it.
 */
function expandRepeat(repeat) {
  if (!repeat) return [{ offset: [0, 0, 0], sizeDelta: [0, 0, 0], rotation: null, step: 0, kind: 'single' }];
  const { kind } = repeat;
  if (!GEO_LANDMARK_REPEAT_KINDS.includes(kind)) throw new RangeError(`Unknown landmark repeat kind: ${kind}`);
  const steps = [];
  if (kind === 'grid') {
    for (const x of repeat.xOffsets ?? [0]) for (const z of repeat.zOffsets ?? [0]) {
      steps.push({ offset: [x, 0, z], sizeDelta: [0, 0, 0], rotation: null, step: steps.length, kind });
    }
  } else if (kind === 'walk') {
    // A stepped run — arch voussoirs climbing toward the crown. `mirror: 'x'` emits the same
    // run on both sides of the axis, which is how the two halves of an arch are one module.
    for (const side of repeat.mirror ? [1, -1] : [1]) {
      for (let index = 0; index < repeat.count; index++) {
        steps.push({
          offset: [
            side * (repeat.start[0] + index * repeat.step[0]),
            repeat.start[1] + index * repeat.step[1],
            repeat.start[2] + index * repeat.step[2],
          ],
          sizeDelta: [0, 0, 0], rotation: null, step: index, kind,
        });
      }
    }
  } else if (kind === 'arc') {
    // Radial placement in the x–y plane (a wheel facing along z), each box tilted by its own
    // radial angle. The module's box position *is* the wheel centre.
    for (let index = 0; index < repeat.count; index++) {
      const angle = index * (Math.PI * 2 / repeat.count);
      const radius = repeat.radius ?? 0;
      steps.push({
        offset: [Math.sin(angle) * radius, Math.cos(angle) * radius, 0],
        sizeDelta: [0, 0, 0], rotation: [0, 0, -angle], step: index, kind,
      });
    }
  } else if (kind === 'ring') {
    // Same position, rotating in place — the spokes inside a wheel.
    for (let index = 0; index < repeat.count; index++) {
      const angle = index * (Math.PI * 2 / repeat.count);
      steps.push({ offset: [0, 0, 0], sizeDelta: [0, 0, 0], rotation: [0, 0, angle], step: index, kind });
    }
  } else if (kind === 'stack') {
    // Tiers that shrink with height — §15.8's "repeated tiers ... from loops".
    for (let index = 0; index < repeat.count; index++) {
      steps.push({
        offset: [0, repeat.startY + index * repeat.stepY, 0],
        sizeDelta: [
          (repeat.sizeStep?.[0] ?? 0) * index,
          (repeat.sizeStep?.[1] ?? 0) * index,
          (repeat.sizeStep?.[2] ?? 0) * index,
        ],
        rotation: null, step: index, kind,
      });
    }
  } else if (kind === 'line') {
    const step = repeat.step ?? 1;
    const count = Math.floor((repeat.to - repeat.from) / step) + 1;
    for (let index = 0; index < count; index++) {
      const value = repeat.from + index * step;
      steps.push({
        offset: repeat.axis === 'z' ? [0, 0, value] : [value, 0, 0],
        sizeDelta: [0, 0, 0], rotation: null, step: index, kind,
      });
    }
  }
  return steps;
}

function normalizeVoid(voidId, definition) {
  if (!Array.isArray(definition.bands) || !definition.bands.length) {
    throw new TypeError(`Landmark void ${voidId} needs at least one band`);
  }
  let previousTop = -Infinity;
  const bands = definition.bands.map((band, index) => {
    if (!Number.isFinite(band.top) || band.top <= previousTop) {
      throw new RangeError(`Landmark void ${voidId} band ${index} must have an increasing top`);
    }
    previousTop = band.top;
    return Object.freeze({
      top: band.top,
      halfWidth: assertPositive(band.halfWidth, `void ${voidId} band ${index} halfWidth`),
    });
  });
  return Object.freeze({
    id: voidId,
    bottom: assertFinite(definition.bottom, `void ${voidId} bottom`),
    // The free corridor's half-depth along the passage axis, not the landmark's depth.
    halfDepth: assertPositive(definition.halfDepth, `void ${voidId} halfDepth`),
    headHeight: assertFinite(definition.headHeight ?? bands[0].top, `void ${voidId} headHeight`),
    bands: Object.freeze(bands),
    axis: definition.axis ?? 'z',
    offsetX: definition.offsetX ?? 0,
    offsetZ: definition.offsetZ ?? 0,
  });
}

/**
 * The free half-width of a void at a given height, or 0 outside its profile.
 *
 * "Outside" is both ends: below `bottom` is the plinth or the ground, and **above the last
 * band's top the opening has ended** — there is no free width left, which is what makes the
 * lintel above an arch legal and makes a probe above the arch head correctly report a blocked
 * passage rather than squeezing between two voussoirs. A band is a *slice* of the opening, not
 * a width that continues upward.
 */
export function landmarkVoidHalfWidthAt(voidDefinition, y) {
  if (y < voidDefinition.bottom) return 0;
  for (const band of voidDefinition.bands) if (y < band.top) return band.halfWidth;
  return 0;
}

/**
 * Does a box's footprint enter the free core of a void?
 *
 * Footprint (x/z) plus vertical overlap, band by band: a box whose y-range misses the void
 * may pass over or under the opening — that is how a lintel sits above an arch — but a box
 * that shares a band's height must keep clear of that band's free width. Testing bands rather
 * than one box is what makes a *stepped* arch expressible.
 */
export function boxIntrudesIntoVoid(box, voidDefinition, originX = 0, originZ = 0) {
  const boxBottom = box.y - box.sizeY / 2, boxTop = box.y + box.sizeY / 2;
  const lastBand = voidDefinition.bands[voidDefinition.bands.length - 1];
  if (boxTop <= voidDefinition.bottom + GEO_LANDMARK_VOID_TOLERANCE || boxBottom >= lastBand.top - GEO_LANDMARK_VOID_TOLERANCE) return false;
  const voidX = originX + voidDefinition.offsetX, voidZ = originZ + voidDefinition.offsetZ;
  const boxLeft = box.x - box.sizeX / 2, boxRight = box.x + box.sizeX / 2;
  const boxNear = box.z - box.sizeZ / 2, boxFar = box.z + box.sizeZ / 2;
  if (boxFar <= voidZ - voidDefinition.halfDepth + GEO_LANDMARK_VOID_TOLERANCE) return false;
  if (boxNear >= voidZ + voidDefinition.halfDepth - GEO_LANDMARK_VOID_TOLERANCE) return false;
  for (const band of voidDefinition.bands) {
    const bandBottom = Math.max(boxBottom, voidDefinition.bottom);
    const bandTop = Math.min(boxTop, band.top);
    // The tolerance applies vertically too, and it must: a voussoir whose lower face is the
    // band boundary itself overlaps the band below by 1e-15 in binary floating point, and
    // treating that as a real overlap rejected two stones of the shipped arch.
    if (bandTop <= bandBottom + GEO_LANDMARK_VOID_TOLERANCE) continue;
    const free = band.halfWidth - GEO_LANDMARK_VOID_TOLERANCE;
    if (boxRight > voidX - free && boxLeft < voidX + free) return true;
  }
  return false;
}

function normalizeModule(definition, index, role) {
  const id = definition.id ?? `module-${index}`;
  const box = definition.box;
  if (!box) throw new TypeError(`Landmark module ${id} needs a box`);
  return Object.freeze({
    id,
    role,
    order: Number.isFinite(definition.order) ? definition.order : index,
    repeat: definition.repeat ?? null,
    box: Object.freeze({
      x: assertFinite(box.x ?? 0, `module ${id} box.x`),
      // `y` defaults to the base for a module whose placement comes from its repeat (a stack
      // supplies its own tiers, a walk its own climb); a literal module must still say where
      // it stands, which the parity table checks rather than this default.
      y: assertFinite(box.y ?? 0, `module ${id} box.y`),
      z: assertFinite(box.z ?? 0, `module ${id} box.z`),
      sizeX: assertPositive(box.sizeX, `module ${id} box.sizeX`),
      sizeY: assertPositive(box.sizeY, `module ${id} box.sizeY`),
      sizeZ: assertPositive(box.sizeZ, `module ${id} box.sizeZ`),
      rotation: Object.freeze(box.rotation ?? [0, 0, 0]),
      color: box.color,
      metalness: box.metalness ?? 0,
    }),
    // `structural: true` derives one proxy per outer repeat site from the drawn box; an
    // explicit `proxy` overrides its size (a mass whose collision is larger than its drawing);
    // everything else contributes no collider at all.
    structural: definition.structural === true,
    proxy: definition.proxy ? Object.freeze({ ...definition.proxy }) : null,
    // A repeating run that alternates colour — the shipped chariot roof does exactly this —
    // is one module with a cycle rather than two modules whose steps interleave, which keeps
    // every module a single material family *and* keeps proxy ids unique.
    colorCycle: Array.isArray(definition.colorCycle) && definition.colorCycle.length
      ? Object.freeze([...definition.colorCycle])
      : null,
    // An optional id template for the derived proxies. The `curated-camera` gate addresses
    // blockers by id, so a module that owned a stable name before the port keeps it; the
    // placeholders are filled from the *site* (`{x}`, `{y}`, `{z}`, `{side}`, `{step}`).
    proxyId: typeof definition.proxyId === 'string' ? definition.proxyId : null,
    // The pre-`DET-09` ids indexed the chariot's wheels and columns by the *descriptor*
    // offset it looped over (±5) rather than by the offsets they were drawn at (±6.5 and
    // ±3.5), and two families used different multipliers to get there. `{ndz}` plus this
    // scale reproduces that historical numbering, so the ids a gate already addresses stay
    // the same across the port instead of the port silently renaming them.
    proxyIdScale: Number.isFinite(definition.proxyIdScale) ? definition.proxyIdScale : 0,
  });
}

/** Fill a module's proxy-id template from one repeat site. */
export function landmarkProxyId(module, siteStep, offset) {
  if (module.proxyId) {
    return module.proxyId
      .replaceAll('{x}', String(offset[0]))
      .replaceAll('{y}', String(offset[1]))
      .replaceAll('{z}', String(offset[2]))
      .replaceAll('{ndz}', String(module.proxyIdScale ? Math.round(offset[2] / module.proxyIdScale) : offset[2]))
      .replaceAll('{side}', String(Math.sign(offset[0])))
      .replaceAll('{step}', String(siteStep));
  }
  return `${module.id}${module.repeat ? `:${siteStep}` : ''}`;
}

/** Build an immutable landmark definition from a declarative description. */
export function createLandmarkDefinition({ id, base = 3, masses = [], repeats = [], accents = [], voids = [], approach = null } = {}) {
  if (typeof id !== 'string' || !id) throw new TypeError('Landmark definitions require a stable id');
  for (const group of [masses, repeats, accents]) {
    if (!Array.isArray(group)) throw new TypeError(`Landmark ${id} groups must be arrays`);
  }
  const modules = [
    ...masses.map((module, index) => normalizeModule(module, index, GEO_LANDMARK_ROLE.SILHOUETTE)),
    ...repeats.map((module, index) => normalizeModule(module, index, module.role ?? GEO_LANDMARK_ROLE.SURFACE)),
    ...accents.map((module, index) => normalizeModule(module, index, GEO_LANDMARK_ROLE.ACCENT)),
  ];
  const voidMap = {};
  for (const definition of voids) voidMap[definition.id] = normalizeVoid(definition.id, definition);
  // §19.5 item 1 with teeth: an accent that wants to block something is a contradiction —
  // either it is masonry (move it into `repeats` with `structural: true`) or it is decoration
  // (drop the proxy). Rejecting it at definition time is cheaper than discovering it in a
  // profile sweep.
  for (const module of modules) {
    if (module.role === GEO_LANDMARK_ROLE.ACCENT && (module.structural || module.proxy)) {
      throw new TypeError(`Landmark ${id} module ${module.id} is an accent that declares collision: move it to repeats or drop the proxy`);
    }
  }
  return Object.freeze({
    id,
    base: assertFinite(base, `${id} base`),
    modules: Object.freeze(modules),
    voids: Object.freeze(voidMap),
    approach: approach ? Object.freeze({ ...approach }) : null,
  });
}

/**
 * Compile a landmark at a profile: expand every repeat from its loop, enforce the box budget,
 * refuse any box that would enter a declared opening, and derive the structural proxies.
 *
 * `diagnostics.intrusions` counts boxes dropped because they would have filled an opening and
 * `proxyIntrusions` counts declared proxies that would have — both are **defect counters**,
 * and the registered gate requires zero for the shipped definitions rather than tolerating a
 * non-zero value.
 */
export function compileLandmark(definition, { profile = 'low', origin = { x: 0, z: 0 } } = {}) {
  if (!definition || typeof definition.id !== 'string') throw new TypeError('compileLandmark needs a definition');
  const budget = GEO_LANDMARK_BOX_BUDGETS[profile];
  if (!budget) throw new RangeError(`Unknown landmark profile: ${profile}`);
  const originX = assertFinite(origin.x, 'origin.x'), originZ = assertFinite(origin.z, 'origin.z');
  const voids = Object.values(definition.voids);

  // One entry per outer site: its drawn boxes (site ⊕ inner repeat) and its single proxy.
  const sites = [];
  for (const module of definition.modules) {
    for (const site of expandRepeat(module.repeat)) {
      const inner = module.repeat?.each ? expandRepeat(module.repeat.each) : [{ offset: [0, 0, 0], sizeDelta: [0, 0, 0], rotation: null, step: 0 }];
      const boxes = [];
      for (const step of inner) {
        const box = {
          moduleId: module.id,
          role: module.role,
          repeatIndex: inner.length > 1 ? step.step : site.step,
          siteIndex: site.step,
          // "Repeated" means the box came from a declared loop rather than a literal — the
          // number the gate reports as the landmark's repeated share.
          repeated: !!module.repeat,
          x: originX + module.box.x + site.offset[0] + step.offset[0],
          y: definition.base + module.box.y + site.offset[1] + step.offset[1],
          z: originZ + module.box.z + site.offset[2] + step.offset[2],
          sizeX: module.box.sizeX + site.sizeDelta[0] + step.sizeDelta[0],
          sizeY: module.box.sizeY + site.sizeDelta[1] + step.sizeDelta[1],
          sizeZ: module.box.sizeZ + site.sizeDelta[2] + step.sizeDelta[2],
          rotation: step.rotation ?? module.box.rotation,
          color: module.colorCycle ? module.colorCycle[site.step % module.colorCycle.length] : module.box.color,
          metalness: module.box.metalness,
        };
        if (box.sizeX <= 0 || box.sizeY <= 0 || box.sizeZ <= 0) continue;
        boxes.push(box);
      }
      if (!boxes.length) continue;
      // The proxy is sized from the *site*, so a wheel is one slab and never sixteen stones
      // plus eight spokes (§19.5 item 8), and it is positioned at the site's own centre.
      const anchor = boxes[0];
      sites.push({
        module,
        order: module.order,
        boxes,
        proxy: module.structural || module.proxy
          ? {
            x: originX + (module.proxy?.x ?? module.box.x) + site.offset[0],
            y: definition.base + (module.proxy?.y ?? module.box.y) + site.offset[1],
            z: originZ + (module.proxy?.z ?? module.box.z) + site.offset[2],
            sizeX: module.proxy?.sizeX ?? anchor.sizeX,
            sizeY: module.proxy?.sizeY ?? anchor.sizeY,
            sizeZ: module.proxy?.sizeZ ?? anchor.sizeZ,
            id: `${definition.id}:${landmarkProxyId(module, site.step, site.offset)}`,
          }
          : null,
      });
    }
  }
  // Budget enforcement drops accents first, then surface, and never a load-bearing mass.
  sites.sort((first, second) =>
    ROLE_PRIORITY[second.module.role] - ROLE_PRIORITY[first.module.role] ||
    first.order - second.order ||
    first.module.id.localeCompare(second.module.id) ||
    first.boxes[0].siteIndex - second.boxes[0].siteIndex);

  const boxes = [], proxies = [];
  let budgetSkips = 0, intrusions = 0, proxyIntrusions = 0;
  const voidReport = {};
  for (const voidDefinition of voids) voidReport[voidDefinition.id] = { bands: voidDefinition.bands.length, intrusions: 0 };

  const intrudesAnywhere = box => {
    for (const voidDefinition of voids) {
      if (boxIntrudesIntoVoid(box, voidDefinition, originX, originZ)) return voidDefinition.id;
    }
    return null;
  };

  for (const site of sites) {
    // Budget is counted in boxes, so a site is admitted only if it fits whole: a wheel with
    // half its rim missing is worse than no wheel, and a half-emitted silhouette is a hole.
    if (boxes.length + site.boxes.length > budget) { budgetSkips += site.boxes.length; continue; }
    let blockedBy = null;
    for (const box of site.boxes) { blockedBy = intrudesAnywhere(box); if (blockedBy) break; }
    if (blockedBy) {
      intrusions += site.boxes.length;
      voidReport[blockedBy].intrusions += site.boxes.length;
      continue;
    }
    for (const box of site.boxes) boxes.push(Object.freeze({ ...box, rotation: Object.freeze([...box.rotation]) }));
    if (site.proxy) {
      if (intrudesAnywhere(site.proxy)) {
        proxyIntrusions++;
        voidReport[intrudesAnywhere(site.proxy)].intrusions++;
      } else proxies.push(Object.freeze({ ...site.proxy, structural: true }));
    }
  }

  const roles = { silhouette: 0, surface: 0, accent: 0 };
  for (const box of boxes) roles[box.role]++;
  const repeatedBoxes = boxes.filter(box => box.repeated).length;
  return Object.freeze({
    id: definition.id,
    profile,
    origin: Object.freeze({ x: originX, z: originZ }),
    base: definition.base,
    budget,
    boxes: Object.freeze(boxes),
    proxies: Object.freeze(proxies),
    voids: definition.voids,
    approach: definition.approach,
    roles: Object.freeze(roles),
    diagnostics: Object.freeze({
      declaredModules: definition.modules.length,
      repeatedModules: definition.modules.filter(module => module.repeat).length,
      sites: sites.length,
      repeatedBoxes,
      emittedBoxes: boxes.length,
      budgetSkips,
      intrusions,
      proxyIntrusions,
      proxies: proxies.length,
      // The share of the landmark that comes from a declared loop rather than a literal: the
      // number that makes "repeated modules batched" a statement about this artifact.
      repeatedShare: boxes.length ? repeatedBoxes / boxes.length : 0,
      voidReport: Object.freeze(voidReport),
    }),
  });
}

/**
 * The draw plan: how many instanced draws this landmark costs.
 *
 * `VoxelBatch` builds one `InstancedMesh` per material family (its `metalness` key, with
 * colour carried as an instance attribute), so a landmark's draw cost is the number of
 * families it uses — not the number of boxes and not the number of colours. The gate counts
 * this, so "batched" is a number rather than an intention.
 */
export function landmarkBatches(compiled) {
  const families = new Map();
  for (const box of compiled.boxes) {
    if (!families.has(box.metalness)) families.set(box.metalness, []);
    families.get(box.metalness).push(box);
  }
  return [...families.entries()].map(([metalness, boxes]) => Object.freeze({
    metalness, boxes: boxes.length, boxesPerDraw: boxes.length,
  }));
}

/**
 * Stamp a compiled landmark into any `box(x, y, z, sx, sy, sz, color, rotation, metalness)`
 * sink — the runtime passes its `VoxelBatch`, so the grammar never imports the renderer.
 */
export function stampLandmark(compiled, sink) {
  if (!sink || typeof sink.box !== 'function') throw new TypeError('stampLandmark needs a box sink');
  for (const box of compiled.boxes) {
    sink.box(box.x, box.y, box.z, box.sizeX, box.sizeY, box.sizeZ, box.color, [...box.rotation], box.metalness);
  }
  return compiled.boxes.length;
}

/**
 * The camera blockers a compiled landmark declares — §19.5 item 6's compound.
 *
 * Plain descriptors, not `Box3` instances, so this module stays renderer-free and equally
 * usable in a worker; the runtime wraps them. Everything a landmark does not declare
 * structural is absent by construction, which is what keeps a finial, a spoke or a
 * crenellation from silently becoming a wall.
 */
export function landmarkCameraBlockers(compiled) {
  return compiled.proxies.map(proxy => ({ ...proxy, role: 'camera-blocker' }));
}

/**
 * Is the declared passage walkable — a straight segment at `y` through the void, clear of
 * every drawn box by `radius`?
 *
 * This is the property §15.8 actually cares about ("never assign one landmark-wide AABB when
 * the player should pass through an arch"), and it is checked against the *drawn* geometry as
 * well as the proxies, because a visual box that filled the opening would be just as wrong as
 * a collider that did.
 */
export function landmarkPassageClear(compiled, { y, fromZ, toZ, x = null, radius = 0 } = {}) {
  const voidDefinition = Object.values(compiled.voids)[0];
  if (!voidDefinition) return false;
  const voidX = compiled.origin.x + voidDefinition.offsetX;
  const voidZ = compiled.origin.z + voidDefinition.offsetZ;
  const probeX = x ?? voidX;
  const halfWidth = landmarkVoidHalfWidthAt(voidDefinition, y);
  if (halfWidth <= radius) return false;
  if (Math.abs(probeX - voidX) > halfWidth - radius) return false;
  const start = Math.min(fromZ, toZ), end = Math.max(fromZ, toZ);
  if (start > voidZ - voidDefinition.halfDepth || end < voidZ + voidDefinition.halfDepth) return false;
  return !compiled.boxes.some(box =>
    Math.abs(box.z - voidZ) < box.sizeZ / 2 + voidDefinition.halfDepth + radius &&
    Math.abs(box.y - y) < box.sizeY / 2 + radius &&
    Math.abs(box.x - probeX) < box.sizeX / 2 + radius);
}
