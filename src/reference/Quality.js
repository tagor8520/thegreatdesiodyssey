const PRESETS = Object.freeze({
  low: Object.freeze({
    name: 'low',
    label: 'Low power',
    targetFps: 30,
    pixelRatio: 0.85,
    minPixelRatio: 0.6,
    adaptiveResolution: true,
    antialias: false,
    powerPreference: 'low-power',
    ambientOcclusion: false,
    environmentMap: false,
    shadows: false,
    voxelShadows: false,
    shadowMapSize: 512,
    loadRadius: 90,
    unloadRadius: 122,
    streamBudgetMs: 2,
    decorationDensity: 0.55,
    itemRadius: 68,
    signTextureScale: 0.5,
    fogNear: 88,
    fogFar: 185,
    cameraFar: 300,
    overviewGlobal: false,
    overviewHeight: 72,
    overviewDistance: 88,
  }),
  balanced: Object.freeze({
    name: 'balanced',
    label: 'Balanced',
    targetFps: 60,
    pixelRatio: 1.1,
    minPixelRatio: 0.75,
    adaptiveResolution: true,
    antialias: true,
    powerPreference: 'default',
    ambientOcclusion: false,
    environmentMap: true,
    shadows: true,
    voxelShadows: false,
    shadowMapSize: 1024,
    loadRadius: 112,
    unloadRadius: 148,
    streamBudgetMs: 2.5,
    decorationDensity: 0.78,
    itemRadius: 92,
    signTextureScale: 0.75,
    fogNear: 135,
    fogFar: 290,
    cameraFar: 420,
    overviewGlobal: false,
    overviewHeight: 105,
    overviewDistance: 132,
  }),
  high: Object.freeze({
    name: 'high',
    label: 'High',
    targetFps: 60,
    pixelRatio: 1.5,
    minPixelRatio: 1,
    adaptiveResolution: false,
    antialias: true,
    powerPreference: 'high-performance',
    ambientOcclusion: true,
    environmentMap: true,
    shadows: true,
    voxelShadows: true,
    shadowMapSize: 2048,
    loadRadius: 150,
    unloadRadius: 190,
    streamBudgetMs: 3,
    decorationDensity: 1,
    itemRadius: Infinity,
    signTextureScale: 1,
    fogNear: 320,
    fogFar: 850,
    cameraFar: 900,
    overviewGlobal: true,
    overviewHeight: 195,
    overviewDistance: 262,
  }),
});

export const QUALITY_PRESETS = PRESETS;

function queryPreference(environment) {
  try {
    const value = new URLSearchParams(environment.location?.search ?? '').get('quality');
    return value && PRESETS[value] ? value : null;
  } catch {
    return null;
  }
}

/** Conservative capability selection: auto never wakes the expensive high profile. */
export function detectQuality(environment = globalThis) {
  const requested = queryPreference(environment);
  if (requested) return requested;

  const navigator = environment.navigator ?? {};
  const connection = navigator.connection ?? navigator.mozConnection ?? navigator.webkitConnection;
  const coarsePointer = environment.matchMedia?.('(pointer: coarse)').matches ?? false;
  const narrowScreen = (environment.screen?.width ?? 1920) <= 900;
  const constrainedMemory = Number.isFinite(navigator.deviceMemory) && navigator.deviceMemory <= 4;
  const constrainedCpu = Number.isFinite(navigator.hardwareConcurrency) && navigator.hardwareConcurrency <= 4;

  if (connection?.saveData || constrainedMemory || constrainedCpu || (coarsePointer && narrowScreen)) return 'low';
  return 'balanced';
}

/** Resolve an explicit profile name, `auto`, or a complete custom profile. */
export function resolveQuality(requested = 'auto', environment = globalThis) {
  if (requested && typeof requested === 'object') return requested;
  const name = requested === 'auto' || requested == null ? detectQuality(environment) : requested;
  if (!PRESETS[name]) throw new RangeError(`Unknown quality profile: ${name}`);
  return PRESETS[name];
}
