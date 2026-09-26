import * as THREE from 'three';
import { GDO_FEATURE_VERSIONS, featureNamespace } from './FeatureVersions.js';

export const GDO_MATERIAL_LIBRARY_NAMESPACE = featureNamespace('materialLibrary');
export const GDO_MATERIAL_LIBRARY_SEED = 0x4d41544c ^ GDO_FEATURE_VERSIONS.materialLibrary;
export const GDO_STYLE_MASK_NAMES = Object.freeze([
  'brick', 'paver', 'bark', 'leaf', 'jali', 'roofTile', 'fabric', 'stone',
  'asphalt', 'plaster', 'wear', 'wood', 'corrugated', 'rust', 'frond', 'flower',
  'gravel', 'crack', 'litter', 'paddy', 'foam', 'rain', 'snow', 'moss',
]);

export const GDO_MATERIAL_DETAIL_PROFILES = Object.freeze({
  low: Object.freeze({ strength: .72, styleStrength: .58, fadeNear: 10, fadeFar: 54, minimumPixels: 1.8 }),
  balanced: Object.freeze({ strength: .90, styleStrength: .76, fadeNear: 18, fadeFar: 82, minimumPixels: 1.55 }),
  high: Object.freeze({ strength: 1, styleStrength: .92, fadeNear: 28, fadeFar: 120, minimumPixels: 1.35 }),
});

export const GDO_MATERIAL_RECIPES = Object.freeze({
  ground: Object.freeze({ style: 'litter', macroScale: .12, styleScale: .50, macroStrength: .16, styleStrength: .10, paletteRow: 0 }),
  land: Object.freeze({ style: 'paddy', macroScale: .10, styleScale: .42, macroStrength: .14, styleStrength: .08, paletteRow: 1 }),
  road: Object.freeze({ style: 'asphalt', macroScale: .20, styleScale: 2.4, macroStrength: .10, styleStrength: .09, paletteRow: 2 }),
  facade: Object.freeze({ style: 'plaster', macroScale: .16, styleScale: .70, macroStrength: .10, styleStrength: .07, paletteRow: 3 }),
  roof: Object.freeze({ style: 'roofTile', macroScale: .15, styleScale: 1.1, macroStrength: .11, styleStrength: .10, paletteRow: 4 }),
  bark: Object.freeze({ style: 'bark', macroScale: .18, styleScale: 1.6, macroStrength: .12, styleStrength: .13, paletteRow: 5 }),
  leaf: Object.freeze({ style: 'leaf', macroScale: .13, styleScale: 1.2, macroStrength: .15, styleStrength: .11, paletteRow: 6 }),
  water: Object.freeze({ style: 'foam', macroScale: .07, styleScale: .8, macroStrength: .07, styleStrength: .04, paletteRow: 7 }),
  voxel: Object.freeze({ style: 'stone', macroScale: .10, styleScale: .65, macroStrength: .07, styleStrength: .05, paletteRow: 3 }),
  decoration: Object.freeze({ style: 'leaf', macroScale: .14, styleScale: 1.0, macroStrength: .09, styleStrength: .06, paletteRow: 6 }),
});

const SURFACE_SIZE = 64;
const STYLE_SIZE = 16;
const STYLE_ATLAS_SIZE = 128;
const STYLE_COLUMNS = 6;
const STYLE_CELL_SIZE = 21;
const STYLE_GUTTER = 2;
const DITHER_SIZE = 8;
const PALETTE_WIDTH = 32;
const PALETTE_HEIGHT = 8;
const WATER_SIZE = 128;
const MIP_FACTOR = 4 / 3;

function mix32(value) {
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return value >>> 0;
}

function hash01(x, y, seed) {
  return mix32(Math.imul(x | 0, 0x1f123bb5) ^ Math.imul(y | 0, 0x5f356495) ^ seed) / 4294967296;
}

function smooth(value) { return value * value * (3 - 2 * value); }
function wrap(value, period) { return ((value % period) + period) % period; }

function periodicValueNoise(x, y, period, seed) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const tx = smooth(x - x0), ty = smooth(y - y0);
  const sample = (sx, sy) => hash01(wrap(sx, period), wrap(sy, period), seed);
  const first = sample(x0, y0) * (1 - tx) + sample(x0 + 1, y0) * tx;
  const second = sample(x0, y0 + 1) * (1 - tx) + sample(x0 + 1, y0 + 1) * tx;
  return first * (1 - ty) + second * ty;
}

function periodicCellDistance(x, y, cells, seed) {
  let closest = Infinity;
  const baseX = Math.floor(x), baseY = Math.floor(y);
  for (let offsetY = -1; offsetY <= 1; offsetY++) for (let offsetX = -1; offsetX <= 1; offsetX++) {
    const cellX = baseX + offsetX, cellY = baseY + offsetY;
    const wrappedX = wrap(cellX, cells), wrappedY = wrap(cellY, cells);
    const pointX = cellX + .18 + hash01(wrappedX, wrappedY, seed) * .64;
    const pointY = cellY + .18 + hash01(wrappedX, wrappedY, seed ^ 0x85ebca6b) * .64;
    closest = Math.min(closest, Math.hypot(x - pointX, y - pointY));
  }
  return Math.min(1, closest);
}

function fillSurfaceNoiseRows(data, startY, endY, seed) {
  const denominator = SURFACE_SIZE - 1;
  for (let y = startY; y < endY; y++) for (let x = 0; x < SURFACE_SIZE; x++) {
    const u = x / denominator, v = y / denominator;
    const macro = periodicValueNoise(u * 8, v * 8, 8, seed ^ 0x243f6a88);
    const fine = periodicValueNoise(u * 24, v * 24, 24, seed ^ 0x85a308d3);
    const cellular = periodicCellDistance(u * 10, v * 10, 10, seed ^ 0x13198a2e);
    const wear = Math.max(0, Math.min(1,
      periodicValueNoise(u * 6, v * 6, 6, seed ^ 0x9e3779b9) * .72 + Math.abs(v - .5) * .56));
    const offset = (y * SURFACE_SIZE + x) * 4;
    data[offset] = Math.round(macro * 255);
    data[offset + 1] = Math.round(fine * 255);
    data[offset + 2] = Math.round(cellular * 255);
    data[offset + 3] = Math.round(wear * 255);
  }
  return data;
}

export function generateSurfaceNoiseData(seed = GDO_MATERIAL_LIBRARY_SEED) {
  return fillSurfaceNoiseRows(new Uint8Array(SURFACE_SIZE * SURFACE_SIZE * 4), 0, SURFACE_SIZE, seed);
}

function stylePixel(name, x, y, seed) {
  // Fifteen unique samples plus one repeated edge guarantee exact periodicity.
  const sx = x === STYLE_SIZE - 1 ? 0 : x;
  const sy = y === STYLE_SIZE - 1 ? 0 : y;
  const unitX = sx / (STYLE_SIZE - 1), unitY = sy / (STYLE_SIZE - 1);
  const hash = hash01(sx, sy, seed);
  const edgeX = Math.min(sx % 4, 4 - sx % 4), edgeY = Math.min(sy % 4, 4 - sy % 4);
  let primary = hash, secondary = hash01(sx, sy, seed ^ 0x85ebca6b), edge = Math.min(1, Math.min(edgeX, edgeY));
  if (name === 'brick') primary = Number((sy % 4 === 0) || ((sx + (Math.floor(sy / 4) % 2) * 2) % 6 === 0));
  else if (name === 'paver') primary = Number(sx % 4 === 0 || sy % 4 === 0);
  else if (name === 'bark') primary = Math.abs((sx % 5) - 2) / 2;
  else if (name === 'leaf') primary = Math.max(Number(Math.abs(sx - sy) <= 1), Number(Math.abs((STYLE_SIZE - 1 - sx) - sy) <= 1) * .7);
  else if (name === 'jali') primary = Number((sx + sy) % 5 <= 1 || Math.abs(sx - sy) % 5 <= 1);
  else if (name === 'roofTile') primary = Number(sy % 4 === 0 || (sx + (Math.floor(sy / 4) % 2) * 2) % 5 === 0);
  else if (name === 'fabric') primary = Number(sx % 4 < 2) * .65 + Number(sy % 4 < 2) * .35;
  else if (name === 'stone') primary = Number((sx + Math.floor(hash * 2)) % 6 === 0 || (sy + Math.floor(secondary * 2)) % 5 === 0);
  else if (name === 'asphalt') primary = secondary > .72 ? 1 : secondary * .45;
  else if (name === 'plaster') primary = .35 + secondary * .45;
  else if (name === 'wear') primary = Number(hash > .72) * secondary;
  else if (name === 'wood') primary = Math.abs((sx + Math.floor(secondary * 2)) % 6 - 3) / 3;
  else if (name === 'corrugated') primary = Math.abs((sx % 4) - 2) / 2;
  else if (name === 'rust') primary = Number(hash > .62) * (.4 + secondary * .6);
  else if (name === 'frond') primary = Math.max(0, 1 - Math.abs(unitY - .5) * 2) * Number(sx % 3 !== 0);
  else if (name === 'flower') primary = Math.max(0, 1 - Math.hypot(unitX - .5, unitY - .5) * 2);
  else if (name === 'gravel') primary = Number(hash > .58);
  else if (name === 'crack') primary = Number(Math.abs(primary - secondary) < .10);
  else if (name === 'litter') primary = Number(hash > .80);
  else if (name === 'paddy') primary = Number(sx % 5 === 0 || sy % 5 === 0);
  else if (name === 'foam') primary = Number(hash > .68) * Math.max(0, 1 - Math.abs(unitY - .5) * 1.5);
  else if (name === 'rain') primary = Number((sx + sy * 2) % 7 === 0);
  else if (name === 'snow') primary = Number((sx * 3 + sy * 5) % 11 < 2);
  else if (name === 'moss') primary = Number(periodicValueNoise(sx / 3, sy / 3, 5, seed) > .54);
  return [primary, secondary, edge, Number(hash > .76) * secondary].map(value => Math.round(Math.max(0, Math.min(1, value)) * 255));
}

function createStyleRects() {
  const rects = {};
  GDO_STYLE_MASK_NAMES.forEach((name, layer) => {
    const innerX = layer % STYLE_COLUMNS * STYLE_CELL_SIZE + STYLE_GUTTER;
    const innerY = Math.floor(layer / STYLE_COLUMNS) * STYLE_CELL_SIZE + STYLE_GUTTER;
    rects[name] = Object.freeze([
      (innerX + .5) / STYLE_ATLAS_SIZE,
      (innerY + .5) / STYLE_ATLAS_SIZE,
      (STYLE_SIZE - 1) / STYLE_ATLAS_SIZE,
      (STYLE_SIZE - 1) / STYLE_ATLAS_SIZE,
    ]);
  });
  return Object.freeze(rects);
}

function fillStyleAtlasLayer(data, layer, seed) {
  const name = GDO_STYLE_MASK_NAMES[layer];
  const cellX = layer % STYLE_COLUMNS * STYLE_CELL_SIZE;
  const cellY = Math.floor(layer / STYLE_COLUMNS) * STYLE_CELL_SIZE;
  const pixels = new Uint8Array(STYLE_SIZE * STYLE_SIZE * 4);
  for (let y = 0; y < STYLE_SIZE; y++) for (let x = 0; x < STYLE_SIZE; x++) {
    pixels.set(stylePixel(name, x, y, seed ^ Math.imul(layer + 1, 0x9e3779b1)), (y * STYLE_SIZE + x) * 4);
  }
  for (let y = 0; y < STYLE_CELL_SIZE; y++) for (let x = 0; x < STYLE_CELL_SIZE; x++) {
    const sourceX = Math.max(0, Math.min(STYLE_SIZE - 1, x - STYLE_GUTTER));
    const sourceY = Math.max(0, Math.min(STYLE_SIZE - 1, y - STYLE_GUTTER));
    const source = (sourceY * STYLE_SIZE + sourceX) * 4;
    const target = ((cellY + y) * STYLE_ATLAS_SIZE + cellX + x) * 4;
    data.set(pixels.subarray(source, source + 4), target);
  }
}

export function generateStyleAtlasData(seed = GDO_MATERIAL_LIBRARY_SEED) {
  const data = new Uint8Array(STYLE_ATLAS_SIZE * STYLE_ATLAS_SIZE * 4);
  for (let layer = 0; layer < GDO_STYLE_MASK_NAMES.length; layer++) fillStyleAtlasLayer(data, layer, seed);
  return Object.freeze({ data, rects: createStyleRects() });
}

export function generateDitherData() {
  const bayer = [
    0,48,12,60,3,51,15,63, 32,16,44,28,35,19,47,31,
    8,56,4,52,11,59,7,55, 40,24,36,20,43,27,39,23,
    2,50,14,62,1,49,13,61, 34,18,46,30,33,17,45,29,
    10,58,6,54,9,57,5,53, 42,26,38,22,41,25,37,21,
  ];
  return new Uint8Array(bayer.map(value => Math.round((value + .5) / 64 * 255)));
}

const PALETTE_ROWS = Object.freeze([
  ['#43653c','#71945b','#9b744d','#d8ba78'], ['#365f32','#6d983f','#8d7045','#cbb36f'],
  ['#30383a','#4d5554','#777d75','#f2dc9b'], ['#6f382d','#c56545','#e4bb83','#f2e8cb'],
  ['#5a3529','#9a6041','#c88f5d','#e4c38a'], ['#3a2418','#6d4528','#977044','#bd9866'],
  ['#264b2b','#54784b','#71945b','#a1b86a'], ['#073b5a','#0a557e','#147aab','#6fb8cf'],
]);

function srgbBytes(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

export function generatePaletteData() {
  const data = new Uint8Array(PALETTE_WIDTH * PALETTE_HEIGHT * 4);
  for (let row = 0; row < PALETTE_HEIGHT; row++) for (let x = 0; x < PALETTE_WIDTH; x++) {
    const position = x / (PALETTE_WIDTH - 1) * (PALETTE_ROWS[row].length - 1);
    const first = Math.floor(position), second = Math.min(PALETTE_ROWS[row].length - 1, first + 1), amount = position - first;
    const a = srgbBytes(PALETTE_ROWS[row][first]), b = srgbBytes(PALETTE_ROWS[row][second]);
    const offset = (row * PALETTE_WIDTH + x) * 4;
    for (let channel = 0; channel < 3; channel++) data[offset + channel] = Math.round(a[channel] * (1 - amount) + b[channel] * amount);
    data[offset + 3] = 255;
  }
  return data;
}

function fillWaterNormalRows(data, size, startY, endY) {
  const denominator = size - 1;
  for (let y = startY; y < endY; y++) for (let x = 0; x < size; x++) {
    const u = x / denominator * Math.PI * 2, v = y / denominator * Math.PI * 2;
    const dx = .22 * Math.cos(3 * u + 2 * v) + .12 * Math.cos(7 * u - 4 * v);
    const dy = .15 * Math.cos(3 * u + 2 * v) - .09 * Math.cos(7 * u - 4 * v);
    const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
    const offset = (y * size + x) * 4;
    data[offset] = Math.round((-dx * inverseLength * .5 + .5) * 255);
    data[offset + 1] = Math.round((-dy * inverseLength * .5 + .5) * 255);
    data[offset + 2] = Math.round((inverseLength * .5 + .5) * 255);
    data[offset + 3] = 255;
  }
  return data;
}

export function generateWaterNormalData(size = WATER_SIZE) {
  if (!Number.isInteger(size) || size < 4 || size > 512) throw new RangeError('Invalid generated water-normal size');
  return fillWaterNormalRows(new Uint8Array(size * size * 4), size, 0, size);
}

export function materialDataChecksum(data) {
  if (!(data instanceof Uint8Array)) throw new TypeError('Material checksums require Uint8Array data');
  let hash = 2166136261;
  for (const byte of data) { hash ^= byte; hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function dataTexture(data, width, height, format, name, {
  colorSpace = THREE.NoColorSpace,
  wrap = THREE.RepeatWrapping,
  magFilter = THREE.LinearFilter,
  minFilter = THREE.LinearMipmapLinearFilter,
  mipmaps = true,
  ownership = 'shared-procedural-engine',
} = {}) {
  const texture = new THREE.DataTexture(data, width, height, format);
  texture.name = name;
  texture.userData.proceduralMaterial = Object.freeze({
    namespace: GDO_MATERIAL_LIBRARY_NAMESPACE,
    owner: ownership,
    lifecycle: ownership === 'shared-procedural-engine' ? 'reference-counted' : 'caller-owned',
  });
  texture.colorSpace = colorSpace;
  texture.wrapS = texture.wrapT = wrap;
  texture.magFilter = magFilter;
  texture.minFilter = minFilter;
  texture.generateMipmaps = mipmaps;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

export function createWaterNormalTexture(size = WATER_SIZE, repeat = 24) {
  const texture = dataTexture(generateWaterNormalData(size), size, size, THREE.RGBAFormat, 'gdo:waterNormal', {
    ownership: 'caller',
  });
  texture.repeat.set(repeat, repeat);
  return texture;
}

const PINNED_CHECKSUMS = Object.freeze({
  surfaceNoise: '55400a48', styleMasks: '9461769d', dither: '285622a5',
  paletteLUT: '098d901e', waterNormal: '1e66cc41',
});
const MATERIAL_GENERATION_SLICE_MS = 4;

function createMaterialLibrary() {
  const started = performance.now();
  const surfaceData = new Uint8Array(SURFACE_SIZE * SURFACE_SIZE * 4);
  const styleData = new Uint8Array(STYLE_ATLAS_SIZE * STYLE_ATLAS_SIZE * 4);
  const ditherData = new Uint8Array(DITHER_SIZE * DITHER_SIZE);
  const paletteData = new Uint8Array(PALETTE_WIDTH * PALETTE_HEIGHT * 4);
  const waterData = new Uint8Array(WATER_SIZE * WATER_SIZE * 4);
  const styleRects = createStyleRects();
  const textures = Object.freeze({
    surfaceNoise: dataTexture(surfaceData, SURFACE_SIZE, SURFACE_SIZE, THREE.RGBAFormat, 'gdo:surfaceNoise'),
    styleMasks: dataTexture(styleData, STYLE_ATLAS_SIZE, STYLE_ATLAS_SIZE, THREE.RGBAFormat, 'gdo:styleMasks', {
      magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter, mipmaps: false,
    }),
    dither: dataTexture(ditherData, DITHER_SIZE, DITHER_SIZE, THREE.RedFormat, 'gdo:dither', {
      magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter, mipmaps: false,
    }),
    paletteLUT: dataTexture(paletteData, PALETTE_WIDTH, PALETTE_HEIGHT, THREE.RGBAFormat, 'gdo:paletteLUT', {
      colorSpace: THREE.SRGBColorSpace, wrap: THREE.ClampToEdgeWrapping,
      magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter, mipmaps: false,
    }),
    waterNormal: dataTexture(waterData, WATER_SIZE, WATER_SIZE, THREE.RGBAFormat, 'gdo:waterNormal'),
  });
  textures.waterNormal.repeat.set(24, 24);
  const records = Object.freeze([
    Object.freeze({ name: 'surfaceNoise', width: SURFACE_SIZE, height: SURFACE_SIZE, format: 'RGBA8', mipCount: 7, estimatedBytes: Math.ceil(surfaceData.byteLength * MIP_FACTOR), checksum: PINNED_CHECKSUMS.surfaceNoise, colorSpace: 'none', wrap: 'repeat', magFilter: 'linear', minFilter: 'linear-mipmap-linear', ownership: 'shared-engine' }),
    Object.freeze({ name: 'styleMasks', width: STYLE_ATLAS_SIZE, height: STYLE_ATLAS_SIZE, layers: 24, gutterPixels: STYLE_GUTTER, format: 'RGBA8 atlas', mipCount: 1, estimatedBytes: styleData.byteLength, checksum: PINNED_CHECKSUMS.styleMasks, colorSpace: 'none', wrap: 'repeat', magFilter: 'nearest', minFilter: 'nearest', ownership: 'shared-engine' }),
    Object.freeze({ name: 'dither', width: DITHER_SIZE, height: DITHER_SIZE, format: 'R8', mipCount: 1, estimatedBytes: ditherData.byteLength, checksum: PINNED_CHECKSUMS.dither, colorSpace: 'none', wrap: 'repeat', magFilter: 'nearest', minFilter: 'nearest', ownership: 'shared-engine' }),
    Object.freeze({ name: 'paletteLUT', width: PALETTE_WIDTH, height: PALETTE_HEIGHT, format: 'RGBA8', mipCount: 1, estimatedBytes: paletteData.byteLength, checksum: PINNED_CHECKSUMS.paletteLUT, colorSpace: 'srgb', wrap: 'clamp', magFilter: 'nearest', minFilter: 'nearest', ownership: 'shared-engine' }),
    Object.freeze({ name: 'waterNormal', width: WATER_SIZE, height: WATER_SIZE, format: 'RGBA8', mipCount: 8, estimatedBytes: Math.ceil(waterData.byteLength * MIP_FACTOR), checksum: PINNED_CHECKSUMS.waterNormal, colorSpace: 'none', wrap: 'repeat', magFilter: 'linear', minFilter: 'linear-mipmap-linear', ownership: 'shared-engine' }),
  ]);
  let resolveReady;
  const whenReady = new Promise(resolve => { resolveReady = resolve; });
  const state = {
    ready: false,
    cancelled: false,
    deferred: typeof window !== 'undefined' && typeof globalThis.setTimeout === 'function',
    slices: 0,
    maximumSliceMilliseconds: 0,
    maximumTaskMilliseconds: 0,
    finishedAt: 0,
    startupMilliseconds: 0,
    timer: null,
  };
  const diagnostics = Object.freeze({
    namespace: GDO_MATERIAL_LIBRARY_NAMESPACE,
    seed: GDO_MATERIAL_LIBRARY_SEED,
    get ready() { return state.ready; },
    get deferred() { return state.deferred; },
    get generationSlices() { return state.slices; },
    get maximumSliceMilliseconds() { return state.maximumSliceMilliseconds; },
    get maximumTaskMilliseconds() { return state.maximumTaskMilliseconds; },
    sliceMilliseconds: MATERIAL_GENERATION_SLICE_MS,
    get startupMilliseconds() { return state.startupMilliseconds; },
    get generationMilliseconds() { return (state.finishedAt || performance.now()) - started; },
    estimatedBytes: records.reduce((total, record) => total + record.estimatedBytes, 0),
    records,
  });

  const tasks = [];
  for (let row = 0; row < SURFACE_SIZE; row += 4) {
    tasks.push(() => fillSurfaceNoiseRows(surfaceData, row, Math.min(row + 4, SURFACE_SIZE), GDO_MATERIAL_LIBRARY_SEED));
  }
  for (let layer = 0; layer < GDO_STYLE_MASK_NAMES.length; layer++) {
    tasks.push(() => fillStyleAtlasLayer(styleData, layer, GDO_MATERIAL_LIBRARY_SEED));
  }
  tasks.push(() => ditherData.set(generateDitherData()), () => paletteData.set(generatePaletteData()));
  for (let row = 0; row < WATER_SIZE; row += 8) {
    tasks.push(() => fillWaterNormalRows(waterData, WATER_SIZE, row, Math.min(row + 8, WATER_SIZE)));
  }
  const finish = () => {
    state.ready = true;
    state.finishedAt = performance.now();
    for (const texture of Object.values(textures)) texture.needsUpdate = true;
    resolveReady(true);
  };
  const runTask = () => {
    const task = tasks.shift();
    if (!task) return;
    const taskStarted = performance.now();
    task();
    state.maximumTaskMilliseconds = Math.max(state.maximumTaskMilliseconds, performance.now() - taskStarted);
  };
  const runSlice = () => {
    if (state.cancelled) return;
    const sliceStarted = performance.now();
    // One task always runs even when it alone exceeds the budget, so a slice is
    // bounded by the budget plus the longest indivisible task, never by the
    // budget alone.
    runTask();
    while (tasks.length && performance.now() - sliceStarted < MATERIAL_GENERATION_SLICE_MS) runTask();
    const elapsed = performance.now() - sliceStarted;
    state.slices++;
    state.maximumSliceMilliseconds = Math.max(state.maximumSliceMilliseconds, elapsed);
    if (tasks.length && state.deferred) state.timer = globalThis.setTimeout(runSlice, 0);
    else if (!tasks.length) finish();
  };
  if (state.deferred) {
    state.startupMilliseconds = performance.now() - started;
    state.timer = globalThis.setTimeout(runSlice, 0);
  } else {
    runSlice();
    // Unit/build environments run to completion for direct byte assertions.
    while (tasks.length && !state.cancelled) runSlice();
    state.startupMilliseconds = state.generationMilliseconds;
  }
  return Object.freeze({
    textures,
    styleRects,
    diagnostics,
    recipes: GDO_MATERIAL_RECIPES,
    whenReady,
    cancelGeneration() {
      state.cancelled = true;
      resolveReady(false);
      if (state.timer != null) globalThis.clearTimeout?.(state.timer);
    },
  });
}

let sharedLibrary = null, libraryReferences = 0;

export function acquireProceduralMaterialLibrary() {
  if (!sharedLibrary) sharedLibrary = createMaterialLibrary();
  libraryReferences++;
  let released = false;
  return Object.freeze({
    library: sharedLibrary,
    release() {
      if (released) return;
      released = true;
      libraryReferences = Math.max(0, libraryReferences - 1);
      if (libraryReferences === 0 && sharedLibrary) {
        sharedLibrary.cancelGeneration();
        for (const texture of Object.values(sharedLibrary.textures)) texture.dispose();
        sharedLibrary = null;
      }
    },
  });
}

export function activeProceduralMaterialLibrary() { return sharedLibrary; }

export function proceduralMaterialLibraryStats() {
  return Object.freeze({ references: libraryReferences, active: Boolean(sharedLibrary), estimatedBytes: sharedLibrary?.diagnostics.estimatedBytes ?? 0 });
}

function styleRect(library, style) {
  const rect = library?.styleRects?.[style];
  if (!rect) throw new RangeError(`Unknown procedural style mask: ${style}`);
  return new THREE.Vector4(...rect);
}

/** Add one packed mask/noise sample path without replacing a material's existing shader hook. */
export function configureSemanticMaterial(material, semantic, library, profileName = 'low') {
  const recipe = GDO_MATERIAL_RECIPES[semantic], profile = GDO_MATERIAL_DETAIL_PROFILES[profileName];
  if (!material?.isMaterial || !recipe) throw new TypeError(`Unknown semantic material: ${semantic}`);
  if (!library?.textures || !profile) throw new RangeError(`Invalid material library/profile: ${profileName}`);
  if (material.userData.gdoSemanticMaterial) return material;
  const uniforms = {
    gdoSurfaceNoise: { value: library.textures.surfaceNoise },
    gdoStyleMasks: { value: library.textures.styleMasks },
    gdoPaletteLUT: { value: library.textures.paletteLUT },
    gdoStyleRect: { value: styleRect(library, recipe.style) },
    gdoPaletteRow: { value: recipe.paletteRow },
    gdoMacroScale: { value: recipe.macroScale },
    gdoStyleScale: { value: recipe.styleScale },
    gdoMacroStrength: { value: recipe.macroStrength * profile.strength },
    gdoStyleStrength: { value: recipe.styleStrength * profile.styleStrength },
    gdoDetailFade: { value: new THREE.Vector2(profile.fadeNear, profile.fadeFar) },
    gdoMinimumPixels: { value: profile.minimumPixels },
  };
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = shader => {
    previousCompile(shader);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGdoMaterialWorld;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGdoMaterialWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vGdoMaterialWorld;
        uniform sampler2D gdoSurfaceNoise;
        uniform sampler2D gdoStyleMasks;
        uniform sampler2D gdoPaletteLUT;
        uniform vec4 gdoStyleRect;
        uniform vec2 gdoDetailFade;
        uniform float gdoPaletteRow;
        uniform float gdoMacroScale;
        uniform float gdoStyleScale;
        uniform float gdoMacroStrength;
        uniform float gdoStyleStrength;
        uniform float gdoMinimumPixels;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec2 gdoCoord = vec2(vGdoMaterialWorld.x + vGdoMaterialWorld.z,
          vGdoMaterialWorld.y * 1.7 + vGdoMaterialWorld.z - vGdoMaterialWorld.x * 0.31);
        vec4 gdoNoise = texture2D(gdoSurfaceNoise, gdoCoord * gdoMacroScale);
        float gdoDistance = distance(cameraPosition, vGdoMaterialWorld);
        float gdoDistanceVisibility = 1.0 - smoothstep(gdoDetailFade.x, gdoDetailFade.y, gdoDistance);
        vec2 gdoStyleCoord = gdoCoord * gdoStyleScale;
        vec2 gdoStyleUv = fract(gdoStyleCoord);
        float gdoFootprint = max(fwidth(gdoStyleCoord.x), fwidth(gdoStyleCoord.y)) * 16.0 * gdoMinimumPixels;
        float gdoStyleVisibility = (1.0 - smoothstep(0.42, 1.0, gdoFootprint)) * gdoDistanceVisibility;
        vec4 gdoStyle = texture2D(gdoStyleMasks, gdoStyleRect.xy + gdoStyleUv * gdoStyleRect.zw);
        vec3 gdoPalette = texture2D(gdoPaletteLUT, vec2(gdoNoise.r, (gdoPaletteRow + 0.5) / 8.0)).rgb;
        float gdoPaletteLuma = max(0.2, dot(gdoPalette, vec3(0.2126, 0.7152, 0.0722)));
        vec3 gdoPaletteTint = clamp(gdoPalette / gdoPaletteLuma, vec3(0.72), vec3(1.28));
        float gdoMacroTone = mix(1.0 - gdoMacroStrength, 1.0 + gdoMacroStrength, gdoNoise.r);
        float gdoStyleTone = mix(1.0, mix(1.0 - gdoStyleStrength, 1.0 + gdoStyleStrength, gdoStyle.r), gdoStyleVisibility);
        diffuseColor.rgb *= mix(vec3(1.0), gdoPaletteTint, 0.06) * gdoMacroTone * gdoStyleTone;`);
  };
  material.customProgramCacheKey = () => `${previousKey()}:${GDO_MATERIAL_LIBRARY_NAMESPACE}:${semantic}`;
  material.userData.gdoSemanticMaterial = Object.freeze({ semantic, recipe, uniforms, profile: profileName });
  return material;
}

/** Profile changes are uniform-only; the shader program key remains stable. */
export function setSemanticMaterialDetail(material, profileName) {
  const state = material?.userData?.gdoSemanticMaterial, profile = GDO_MATERIAL_DETAIL_PROFILES[profileName];
  if (!state || !profile) return false;
  state.uniforms.gdoMacroStrength.value = state.recipe.macroStrength * profile.strength;
  state.uniforms.gdoStyleStrength.value = state.recipe.styleStrength * profile.styleStrength;
  state.uniforms.gdoDetailFade.value.set(profile.fadeNear, profile.fadeFar);
  state.uniforms.gdoMinimumPixels.value = profile.minimumPixels;
  return true;
}
