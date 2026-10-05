import './reference/landing.css';

const container = document.getElementById('reference-game');
let game = null;
let loading = false;

function landingMarkup() {
  return `
    <section class="odyssey-landing" aria-labelledby="odyssey-title">
      <header class="odyssey-brand"><span class="odyssey-emblem" aria-hidden="true">✦</span> AN ADVENTURE ACROSS INDIA</header>
      <nav class="odyssey-nav" aria-label="About the project">
        <a href="/vision.html">Vision</a>
        <a href="/contribution.html">Contribution</a>
        <a href="/tnc.html">T&amp;C</a>
      </nav>
      <div class="odyssey-intro">
        <div class="odyssey-eyebrow"><span></span> BUILDING VIRTUAL BHARAT</div>
        <h1 id="odyssey-title">The Great<br><span>Desi Odyssey</span></h1>
        <p>Big flavours. Little voxels.<br>One unforgettable journey.</p>
        <div class="odyssey-options">
          <div class="odyssey-option odyssey-option-curated">
            <div class="odyssey-option-label">CURATED ADVENTURE</div>
            <h2>Explore three states</h2>
            <p>Maharashtra, Karnataka and Kerala—landmarks, bridges and regional collectibles.</p>
            <button class="odyssey-start" type="button">Chaliye Shuru karte hain <span aria-hidden="true">↗</span></button>
          </div>
          <form class="odyssey-option odyssey-coordinate-form">
            <div class="odyssey-option-label">NEW · OPEN MAP MODE</div>
            <h2>Enter coordinates</h2>
            <p>Stream one small public map chunk, then grow its roads, water, landscape, local names and buildings on this device.</p>
            <div class="odyssey-coordinate-fields">
              <label>Latitude<input name="latitude" inputmode="decimal" autocomplete="off" placeholder="28.9845" required></label>
              <label>Longitude<input name="longitude" inputmode="decimal" autocomplete="off" placeholder="77.7064" required></label>
            </div>
            <button class="odyssey-coordinate-start" type="submit">Generate this place <span aria-hidden="true">↗</span></button>
            <button class="odyssey-sample-coordinate" type="button" data-lat="28.9845" data-lon="77.7064">Try Meerut coordinates</button>
          </form>
        </div>
        <div class="odyssey-start-note" role="status">The 3D engine loads only after you choose. Automatic low-power mode is used on constrained devices.</div>
      </div>
      <footer class="odyssey-footer">
        <a class="odyssey-pixellon" href="https://pixellon.in" target="_blank" rel="noreferrer">Built by Pixellon</a>
        <a class="odyssey-coffee" href="https://buymeacoffee.com/aayushraj1q" target="_blank" rel="noreferrer">☕ Buy me a coffee</a>
      </footer>
    </section>
  `;
}

/**
 * Landing input is delegated from the persistent host element rather than bound
 * to each rendered node.
 *
 * `renderLanding()` replaces the markup wholesale, so per-node handlers were
 * registered afresh on every exit from the game and left attached to the
 * discarded nodes. Nothing kept those nodes alive, so this never leaked in
 * practice — but it made a remount cycle accumulate subscriptions that could only
 * be reclaimed by GC, which is exactly the kind of growth FND-07 requires us to
 * disprove rather than assume. One delegated listener per event type keeps the
 * landing shell's subscription count constant across remounts.
 *
 * `landingWired` is module state, not a DOM flag: the flag must outlive the
 * element it guards, because the element is thrown away on every render.
 */
let landingWired = false;
function wireLanding() {
  if (!container || landingWired) return;
  landingWired = true;
  container.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('.odyssey-start')) { void launchGame({ mode: 'curated' }); return; }
    const sample = target.closest('.odyssey-sample-coordinate');
    if (!sample) return;
    const form = container.querySelector('.odyssey-coordinate-form');
    if (!form) return;
    form.elements.latitude.value = sample.dataset.lat;
    form.elements.longitude.value = sample.dataset.lon;
    form.elements.latitude.focus();
  });
  container.addEventListener('submit', event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.classList.contains('odyssey-coordinate-form')) return;
    event.preventDefault();
    const data = new FormData(form);
    const latitude = Number(String(data.get('latitude')).trim());
    const longitude = Number(String(data.get('longitude')).trim());
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -85.05112878 || latitude > 85.05112878 || longitude < -180 || longitude > 180) {
      const note = container.querySelector('.odyssey-start-note');
      if (note) note.textContent = 'Enter a valid latitude (-85.0511 to 85.0511) and longitude (-180 to 180).';
      return;
    }
    void launchGame({ mode: 'coordinates', latitude, longitude });
  });
}

function renderLanding(message = '') {
  if (!container) return;
  container.innerHTML = landingMarkup();
  if (message) {
    const note = container.querySelector('.odyssey-start-note');
    if (note) note.textContent = message;
  }
  wireLanding();
}

async function loadMapProviders() {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}map-providers.json`, { cache: 'no-cache', credentials: 'same-origin' });
    if (!response.ok) return undefined;
    const config = await response.json();
    const providers = config.providers?.filter(provider =>
      typeof provider?.id === 'string' && typeof provider?.label === 'string' &&
      typeof provider?.url === 'string' &&
      (provider.url.startsWith('https://') || (provider.url.startsWith('/') && !provider.url.startsWith('//'))) &&
      provider.url.includes('{z}') && provider.url.includes('{x}') && provider.url.includes('{y}'));
    return providers?.length ? providers : undefined;
  } catch {
    return undefined;
  }
}

async function launchGame(options) {
  if (!container || loading || game) return;
  loading = true;
  const buttons = container.querySelectorAll('button');
  const note = container.querySelector('.odyssey-start-note');
  buttons.forEach(button => { button.disabled = true; });
  if (note) note.textContent = options.mode === 'coordinates'
    ? 'Loading the local vector-tile worker. Roads will appear before buildings.'
    : 'Preparing an optimized 3D world for this device.';

  try {
    if (options.mode === 'coordinates') {
      const [{ mountGeoGame }, providers] = await Promise.all([
        import('./geo/GeoGame.js'),
        loadMapProviders(),
      ]);
      container.replaceChildren();
      game = mountGeoGame(container, {
        latitude: options.latitude,
        longitude: options.longitude,
        providers,
        onExitRequest: () => queueMicrotask(exitGame),
      });
    } else {
      const { mountReferenceGame } = await import('./reference/main.jsx');
      container.replaceChildren();
      game = mountReferenceGame(container, {
        initialStarted: true,
        onExitRequest: () => queueMicrotask(exitGame),
      });
    }
    // Development-only audit bridge. `tools/visual-audit` drives deterministic
    // camera/player scenarios through this handle instead of synthesising input
    // events. `import.meta.env.DEV` is statically false in production builds, so
    // Vite tree-shakes this branch and no audit handle ships to players.
    if (import.meta.env.DEV) {
      globalThis.__gdoAudit = {
        mode: options.mode ?? 'curated',
        game,
        /** Mounted runtimes, newest last; lets a scenario re-enter without reloading. */
        version: 'gdo:visualAudit:v1',
      };
    }
  } catch (error) {
    console.error(error);
    renderLanding(`Unable to start: ${error.message}`);
  } finally {
    loading = false;
  }
}

function exitGame() {
  const mountedGame = game;
  game = null;
  if (import.meta.env.DEV) delete globalThis.__gdoAudit;
  mountedGame?.dispose();
  renderLanding();
}

if (container) renderLanding();

if (import.meta.hot) import.meta.hot.dispose(() => game?.dispose());
