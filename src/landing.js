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

function renderLanding(message = '') {
  if (!container) return;
  container.innerHTML = landingMarkup();
  const curatedButton = container.querySelector('.odyssey-start');
  const form = container.querySelector('.odyssey-coordinate-form');
  const sample = container.querySelector('.odyssey-sample-coordinate');
  const note = container.querySelector('.odyssey-start-note');
  if (message) note.textContent = message;
  curatedButton.addEventListener('click', () => launchGame({ mode: 'curated' }), { once: true });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(form);
    const latitude = Number(String(data.get('latitude')).trim());
    const longitude = Number(String(data.get('longitude')).trim());
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -85.05112878 || latitude > 85.05112878 || longitude < -180 || longitude > 180) {
      note.textContent = 'Enter a valid latitude (-85.0511 to 85.0511) and longitude (-180 to 180).';
      return;
    }
    void launchGame({ mode: 'coordinates', latitude, longitude });
  });
  sample.addEventListener('click', () => {
    form.elements.latitude.value = sample.dataset.lat;
    form.elements.longitude.value = sample.dataset.lon;
    form.elements.latitude.focus();
  });
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
      provider.url.includes('{z}') && provider.url.includes('{x}') && provider.url.includes('{y}'))
      // `MAP-08` needs the serving provider's schema to normalize classes and
      // levels, so a declared shortbread/openmaptiles spelling travels with the
      // descriptor; `MAP-09` only persists a payload when the provider declares
      // how it must be credited, so attribution travels with it too.
      .map(provider => Object.freeze({
        id: provider.id, label: provider.label, url: provider.url,
        ...(typeof provider.schema === 'string' && provider.schema.trim() ? { schema: provider.schema.trim() } : {}),
        ...(typeof provider.attribution === 'string' && provider.attribution.trim() && provider.attribution.length <= 160
          ? { attribution: provider.attribution.trim() } : {}),
      }));
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
  mountedGame?.dispose();
  renderLanding();
}

if (container) renderLanding();

if (import.meta.hot) import.meta.hot.dispose(() => game?.dispose());
