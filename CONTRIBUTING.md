# Contributing to The Great Desi Odyssey 🇮🇳

First off, thank you for considering contributing to **The Great Desi Odyssey**! We want to build the most epic, meme-filled, culturally rich virtual representation of India, and community contributions are the absolute best way to do that.

## 🤝 Code of Conduct

We are an inclusive, welcoming community. Whether you're adding a detailed monument or a niche regional meme, please ensure your contributions are:
1. **Respectful**: Celebrate the culture. Humor and memes are highly encouraged, but strictly avoid political, religious, or maliciously offensive content.
2. **Collaborative**: Be kind in code reviews and discussions. 

---

## 🛠️ How to Contribute (The Git Workflow)

1. **Fork** the repository to your own GitHub account.
2. **Clone** the project to your local machine:
   ```bash
   git clone https://github.com/your-username/thegreatdesiodyssey.git
   ```
3. **Create a Branch** for your feature or fix:
   ```bash
   git checkout -b feature/add-punjab-state
   ```
4. **Code** and test your changes locally (`npm run dev`).
5. **Commit** your changes with descriptive messages:
   ```bash
   git commit -m "feat: add Punjab state and Makki di Roti collectible"
   ```
6. **Push** to your fork and open a **Pull Request (PR)** against our `main` branch.

---

## 🗺️ Low-Code State and Landmark Format

Content is **data**, and it is checked before it reaches the game. A contributor
writes a state pack (JSON) or a landmark recipe (parametric modules), runs the
validation tool, and reads a report — no Three.js code is required for any
supported module.

### Validate before you commit

```bash
npm run validate:content                      # every shipped state pack
npm run validate:content -- path/to/pack.json # one pack or landmark file
npm run validate:content -- --landmarks       # the curated landmark recipes
npm run validate:content -- --json            # machine-readable verdicts
npm run validate:content -- --list            # provider credit lines
```

The tool prints a report per input, previews the compiled modules as a small
ASCII plan, and exits non-zero when anything fails, so it drops straight into CI.
In a running page the same tool is on the debug hook:
`__gdo.validateContent(pack)` returns `{ ok, text, summary }`, and
`__gdo.contentChecks()` lists the checks that ran.

| Check | What it refuses |
| --- | --- |
| `schema` | Unknown/duplicate ids, out-of-range numbers, bad colours, wrong versions (the versioned `gdo:contentSchema:v1` contract) |
| `bounds` | A spawn outside the declared area, or two spawns closer than 2 units |
| `budget` | Compiled module counts over the profile ceilings, or content the compiler had to prune |
| `attribution` | A mapped provider whose credit cannot be verified against `public/map-providers.json` |
| `openings` | Masonry that protrudes into a declared opening, or modules that had to be dropped from one |
| `determinism` | A second compile that does not reproduce the same fingerprint |

A check that cannot apply is reported as `skip` with its reason. Nothing is
silently repaired: if the tool fails your pack, fix the pack.

### State packs

Packs live in `public/content/states/<stateId>.json`. Required keys are
`stateId`, `stateName`, and `collectibles`; `schemaVersion`, `bgColor`,
`fogColor`, and `ambientColor` are optional, and a pack that derives from mapped
data must declare its providers in `sources` plus an `attribution` line.

**Example: `punjab.json`**
```json
{
  "schemaVersion": 1,
  "stateId": "punjab",
  "stateName": "Punjab",
  "bgColor": "#132238",
  "collectibles": [
    {
      "id": "makki_di_roti",
      "name": "Makki di Roti & Sarson da Saag",
      "icon": "🍲",
      "description": "🍲 Pure Desi Ghee power! +2x speed for 15s!",
      "buff": { "type": "speed", "multiplier": 2, "duration": 15000 },
      "spawnPosition": { "x": 10, "y": 1, "z": 200 },
      "voxels": [
        [0,0,0,"#DAA520"], [1,0,0,"#DAA520"], [2,0,0,"#DAA520"],
        [0,0,1,"#DAA520"], [1,0,1,"#006400"], [2,0,1,"#DAA520"],
        [0,0,2,"#DAA520"], [1,0,2,"#DAA520"], [2,0,2,"#DAA520"]
      ]
    }
  ]
}
```

| Limit | Value |
| --- | --- |
| Collectibles per pack | 16 |
| Voxels per collectible | 96 |
| Voxel coordinate / spawn coordinate | 12 / 64 |
| Name / description length | 64 / 180 characters |
| Buff multiplier / duration | 1–4 / 500–60,000 ms |

Buff `type` is one of `speed`, `jump`, `shield`, `stamina`, or `focus`. A
collectible compiles to one module per voxel, scaled and centred on its own
bounding box, and ships as a pick-up: it declares **no** solid hitbox.

### Landmark recipes

A landmark is declared as bounded parametric modules plus the openings that must
stay walkable, and lives beside the code that places it (for example
`src/reference/landmarkRecipes.js`). Four ops cover the shipped compounds:

```js
{
  id: 'gateway', color: '#c9a777',
  openings: [{ id: 'gateway:arch', at: [0, 8.675, 0], size: [9, 9.35, 9] }],
  modules: [
    { op: 'box',  id: 'gateway:plinth', at: [0, .75, 0], size: [22, 1.5, 12] },
    { op: 'grid', id: 'gateway:pier:{xSign}', at: [-5.75, 7.5, 0], size: [2.5, 13.5, 9], steps: [2, 1], step: [11.5, 0, 0] },
    { op: 'step', id: 'gateway:arch:{xSign}:{index}', count: 5, at: [-3.375, 16.35, 0], step: [1.125, 1.35, 0], size: [2.25, 1.35, 9] },
    { op: 'tier', id: 'gateway:tower:{xSign}:{index}', count: 4, at: [-11, 2.4, 0], step: [0, 2.4, 0], size: [3, 2.4, 3] }
  ]
}
```

* A recipe may declare at most 64 ops, each repeating at most 256 times.
* An `openings` entry is a **reservation**: nothing may stand in it. A module
  wholly inside one is dropped and reported by the validator, a module that
  merely borders it is listed as its boundary, and the tool sweeps the passage to
  prove it stays clear.
* Modules are visual/camera proxies. A solid proxy appears only when the recipe
  declares `collision: 'footprint'` (plus the `footprint` box); an interaction is
  never implied by geometry.
* Compiled modules come from data deterministically: same recipe, same
  fingerprint. Moving a recipe does not change its identity.

Nothing under `public/content/` is added by hand-editing a generated file: run
`npm run validate:content` and commit the pack together with its report.

---

## 🧊 Procedural Voxel Asset Guide

We have a strict **Zero External Assets** policy. All models must be procedurally generated arrays of voxels. 

When defining a 3D object in JavaScript or JSON, use the `[x, y, z, hexColor]` format.

*   `x`, `y`, `z`: Integer coordinates relative to the object's origin.
*   `hexColor`: A valid hex string (e.g., `"#FF5500"`).

**Example: Building a simple 3x3 flag**
```javascript
const flagVoxels = [
  // Saffron top
  [0, 2, 0, "#FF9933"], [1, 2, 0, "#FF9933"], [2, 2, 0, "#FF9933"],
  // White middle
  [0, 1, 0, "#FFFFFF"], [1, 1, 0, "#000080"], [2, 1, 0, "#FFFFFF"], // Navy blue chakra in center
  // Green bottom
  [0, 0, 0, "#138808"], [1, 0, 0, "#138808"], [2, 0, 0, "#138808"]
];
```

*Tip: Use an online voxel editor (like MagicaVoxel) to plan your coordinates, then map them into an array!*

---

## ✅ Testing & Pull Request Checklist

Before submitting a Pull Request, please ensure you have completed the following:

- [ ] **Run locally**: Did you run `npm run dev` and ensure there are no console errors?
- [ ] **No Z-Fighting**: Check that your newly added voxel models don't flicker against the ground or other models.
- [ ] **Performance**: Did you reuse materials or utilize the `VoxelBuilder` properly? Ensure your additions don't drop the framerate below 60FPS.
- [ ] **Zero Placeholders**: Ensure you haven't left any `// TODO: add voxels here` comments in production files.
- [ ] **Formatting**: Ensure your code matches the existing style (2-space indents, vanilla ES Modules).

We can't wait to see what you build! Be Creative! 🇮🇳

---

<div align="center">
  <a href="https://buymeacoffee.com/aayushraj1q" target="_blank">
    <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 40px !important;width: 145px !important;" >
  </a>
</div>
