# MAP-10 — Tile Hosting Decision (PMTiles v3 on object storage)

**Status:** approved · **Type:** decision record + provider contract · **Row:** 029, P2
**Decided:** 2026-10-25 · **Gate:** *"Only after hosting/range-request operational decision."*
**Ships with:** `MAP-10a` (`src/geo/PmtilesSource.js`, `gdo:pmtiles:v1`) — the reader half, which needs no bucket.
**Left for `MAP-10b`:** the build pipeline, the bucket, and the first `map-providers.json` entry with `kind: 'pmtiles'`.

> This document decides **where a project-controlled tileset would live**, **what
> shape it may take**, and **the four measurements that would justify building it**.
> It ships with a reader, not with a tileset: `MAP-10a` makes a PMTiles archive a
> legal map provider and reads tiles out of one over HTTP range requests, tested
> against an archive synthesised in memory. No bucket exists, no account was
> touched, and `public/map-providers.json` is unchanged — the two public providers
> in it remain the default path.

## 1. Scope

This decides whether the game ever serves its **own** vector tiles, and if so in
what format, from what kind of host, at what coverage, and at what cost.

It does not decide the pipeline's internals (Overture → filtered GeoParquet →
PMTiles), the CDN vendor's account configuration, or the first extract's cut lines;
those are `MAP-10b` and need the owner's account. It does not replace the public
providers: they stay as fallback and the offline-free path must keep working if the
project host disappears.

## 2. Starting facts this decision has to respect

| Fact | Where it lives | Consequence |
|---|---|---|
| Tiles arrive as raw vector tiles and are decoded before anything is stored | `GeoTileCacheFetch.js` (`decode` before store), `MAP-09` | A hosted tileset must be a **vector** tileset. Raster would bypass the schema adapter and the building/road/wall builders. |
| The persistent cache is keyed by `providerId:zoom/x/y` and holds **decoded payloads** | `GeoTileCache.js` `tileCacheKey` | An archive keeps its provider id and credit, so cache keys and TTL policy work unchanged. The cache must never store byte ranges. |
| Two public providers have no contract: rate limits, CORS, and schema changes are theirs to make | `MAP_STREAMING_RESEARCH.md` §known limitations #5 | Provider availability is the standing risk this row exists to retire (partially — see §7). |
| One served tile is a small payload, but a *country* at z15 is tens of gigabytes | measured in §5 | "Host the whole planet" is refused explicitly, not by accident. |
| `mapTileUrl` substitutes `{z}/{x}/{y}` with `urlX`/`urlY` verbatim — there is no y flip | `GeoTileCacheFetch.js` `mapTileUrl`, `GeoWorld.js:1240` | PMTiles addresses XYZ directly, so the archive and the XYZ providers are addressed identically. |
| A tile source is ≈ 214 game units at Meerut latitude; z14 is the chunk decision already taken | `MAP_STREAMING_RESEARCH.md` z14 chunk decision | Archive grain matches the streaming grain: regional extracts at z14 base with z15/z16 overviews. |

## 3. The decision

**PMTiles v3 archives, read over HTTP range requests, on Cloudflare R2 behind a
CDN.** One file per region. The client reads a 127-byte header, then the root
directory, then one range per tile.

Why PMTiles and not a tile server:

| Option | Verdict | Reason |
|---|---|---|
| **PMTiles v3 on R2 + CDN** | **chosen** | Static object; no server to run, patch, scale, or pay for at idle. Range requests are the only API. R2 charges nothing for egress, which is the line item that makes tile serving expensive. |
| A tile server (Martin/Tegola/`pmtiles serve`) | refused | It is a host to operate and secure, for a dataset that fits in a static object. It reintroduces the uptime problem we are trying to remove. |
| XYZ directory of `.pbf` files on R2 | refused | 10⁵–10⁶ small objects; one object per tile makes listing, atomic replacement, and integrity checking worse, and each tile is a full request with no shared structure. |
| Keep only the public providers | deferred | Correct today: they are free and cover the world. This becomes wrong the moment §8's triggers fire. |
| Mapbox/MapTiler hosted vector tiles | refused | Adds a vendor key, a billing relationship, and a licence on the *output* of a project whose map is the point. Also not ours to style. |

**Decision 3.1** — the archive is the provider. A provider entry gains
`kind: 'pmtiles'` (or simply a `.pmtiles` URL); `id`, `label`, `attribution`, and
`schema` are unchanged, so `MAP-09`'s cache key, credit gate, and decode
validation apply to it without modification. *Landed in `MAP-10a`:*
`resolveMapProvider` / `providerKind` in `src/geo/PmtilesSource.js`.

**Decision 3.2** — the cache stores decoded tile payloads, **never ranges**. A tile
read from an archive is decompressed before the decoder sees it, so what `MAP-09`
persists is the same payload it persists for the XYZ providers. Caching ranges of a
multi-gigabyte archive would be a second, unbounded cache that the eviction policy
does not understand.

**Decision 3.3** — the reader pins exactly two ranges and pays one per tile. Header
(127 B) and root directory are read once per source and kept; leaf directories are
fetched only when the root points at one and are cached by `offset:length`
(`maxLeafDepth` 3, `maxCachedLeaves` 16), so an archive that needs a deep tree does
not re-read its tree per tile.

**Decision 3.4** — compression is named, not guessed. Directories and tiles support
`none` and `gzip`; `brotli` and `zstd` are refused **by name**
(`unsupported-compression`) rather than handed to the vector-tile decoder. This is
a **build constraint on `MAP-10b`**: the pipeline must emit gzip, and a
`pmtiles`-produced archive with brotli directories must be re-encoded (or the reader
extended) before it is uploaded.

## 4. Provider contract (`gdo:pmtiles:v1`)

```
provider = { id, kind: 'pmtiles', url: 'https://…/region.pmtiles',
             label, attribution, schema }
```

| Field | Rule | Refusal if violated |
|---|---|---|
| `id` | non-empty string; keys the cache | `bad-provider` |
| `url` | an archive, not a template — no `{z}` | `bad-provider` (`pmtiles-url-must-be-an-archive`) |
| `kind` | `pmtiles` or `xyz`; unknown kinds are refused, not coerced | `unsupported-kind` |
| `attribution` | required for caching (a provider without credit is never stored) | cache skipped, `MAP-09` policy |
| `schema` | passed through to the schema adapter; `null` means "probe as before" | — |
| archive header | magic `PMTiles`, version **3**, 127 bytes | `bad-header`, `unsupported-version` |
| archive zoom range | `minZoom ≤ z ≤ maxZoom` | `out-of-zoom` |
| tile address | present in the directory tree | `tile-not-found` |
| directory depth | ≤ 3 leaf hops | `too-many-leaves` |
| range response | 206, or 200 with the object sliced; short body refused | `range-failed` |

A refusal never silently falls through to a provider *inside* the reader; it is
returned to `TileCacheFetcher`, which moves to the next provider — the same
fallback the XYZ path already uses.

## 5. Coverage and cost — the numbers the decision rests on

Measured against the shape of the data the game actually needs (buildings, roads,
walls, waterways — not POIs, not landcover beyond what the schema adapter reads),
using the gzip `.pbf` payloads the current providers serve as the size proxy:

| Extract | Approx. archive size | Fits |
|---|---|---|
| Meerut city (z14 base, z15/z16 for the play area) | < 0.1 GB | one golden-city test |
| Delhi NCR | **0.3 – 0.8 GB** | the first real extract |
| One large state (Karnataka, Punjab, Tamil Nadu per `CNT-04`) | **1 – 3 GB** each | per-state rollout |
| All India at z14 | **tens of GB** | refused until a trigger in §8 fires |
| All India at z16, or the planet | 10²–10³ GB | **refused** |

Cost at R2 list prices (egress free, storage $0.015/GB-month, Class B
read ~$0.36/million):

| Traffic | Ranges/month | Class B cost | Storage |
|---|---|---|---|
| 1 000 players × 50 tiles/day | ~1.5 M | ~$0.54 | $0.02 (Delhi NCR) |
| 10 000 players × 50 tiles/day | ~15 M | ~$5.40 | $0.02 |
| Same, all-India archive | ~15 M | ~$5.40 | ~$0.50 |

**Conclusion:** at any plausible player count the bill is the CDN's rounding error,
and it is *flat* rather than per-request vendor pricing — which is precisely why
this option is chosen over a hosted tile vendor, and why the cost is not the thing
that should hold the work back. **The risk is operational, not financial:** an
archive that is stale, misprojected, or missing a region is worse than a public
provider that is merely slow.

## 6. What this decision refuses

1. **A planet-scale or all-India archive now.** Tens of gigabytes of build time and
   transfer for regions no session has visited.
2. **z16 densification of a whole region.** The z16 tier exists for the play area,
   not for the extract.
3. **An application server for tiles.** If a request needs a server, the answer is
   a bigger archive, not a service.
4. **Replacing the public providers.** They remain the default and the fallback;
   a project archive is *preferred*, never *required*.
5. **Storing byte ranges in the tile cache.** Payloads only (§3.2).
6. **Brotli/zstd archives** until the reader or the pipeline handles them (§3.4).
7. **A build pipeline in this change.** `MAP-10b` owns the pipeline, the bucket,
   the CDN config, and the first provider entry; this row ships the decision and
   the reader.

## 7. What this does and does not solve

It removes the *dependency* on a third party for the regions we extract, and it
makes the hosted path a plain static object — the cheapest thing to keep alive.

It does **not** remove the public providers, so `MAP_STREAMING_RESEARCH.md`
§known-limitation #5 (provider availability) narrows rather than closes: a player
outside an extracted region is still on the free providers. It also does not make
the extract self-updating; a stale archive is a `MAP-10b` operations problem, and
nothing in the reader detects staleness — the archive's *name* is the only freshness
signal the client sees today (§10).

## 8. Revisit triggers (any one of these re-opens the row)

1. **A public provider rate-limits, blocks, breaks CORS, or changes its schema**
   in a way that costs a play session.
2. **Measured coverage is poor in a target region** — missing buildings or roads
   where `CNT-04` says players are.
3. **A feature needs z15/z16 or custom chunk boundaries** that no public tileset
   publishes.
4. **Real players make traffic matter** — i.e. §5's per-request assumption stops
   being a rounding error, or a vendor starts charging for it.

When a trigger fires, the work is `MAP-10b`: build the extract for that region
only, upload to R2, add one `kind: 'pmtiles'` provider entry ahead of the public
ones, and leave everything else alone.

## 9. Consequences for `MAP-10a` (shipped) and `MAP-10b` (not started)

**`MAP-10a` — shipped with this record.**

- `src/geo/PmtilesSource.js` (`gdo:pmtiles:v1`): header parser, LEB128 directory
  codec, Hilbert tile ids, range fetcher, source with pinned header/root and
  cached leaves, provider resolution, and one `loadPmtilesTile` entry point.
- `src/geo/GeoTileWorker.js`: a `kind === 'pmtiles'` branch that calls
  `loadPmtilesTile`; everything downstream (decode, `MAP-09` policy, schema
  adapter) is untouched.
- `src/engine/FeatureVersions.js`: `pmtiles: 1`.
- `src/geo/PmtilesSource.test.js`: the whole contract exercised against an
  in-memory archive — tile-id round trip, directory round trip and run/leaf
  search, header refusals, two pinned ranges then one per tile, leaf cache hits,
  `tile-not-found` / `out-of-zoom`, gzip tiles and directories, provider detection,
  and range-fetcher validation (short body, 200-whole-object, HTTP failure).

**`MAP-10b` — needs the owner's account, not code permission.**

1. The pipeline: Overture → filtered GeoParquet → `tippecanoe`/`pmtiles` with
   **gzip** compression and a z14 base.
2. A golden-city extract (Meerut / Delhi NCR) built once and verified against the
   live providers tile-for-tile.
3. R2 bucket + CDN with `Range` preserved, correct `Access-Control-Allow-Origin`,
   and a long cache lifetime (the object is immutable; the *name* carries the date).
4. The first `map-providers.json` entry with `kind: 'pmtiles'`, `attribution`, and
   a `schema` that matches what was built — placed **before** the public providers
   only once step 2 passes.

## 10. Revisit of `MAP-09`'s assumption, restated

`MAP-09` caches per `providerId:zoom/x/y` and trusts the provider's `Cache-Control`
to bound staleness. A PMTiles archive has no per-tile `Cache-Control`; the branch in
`GeoTileWorker.js` therefore passes an empty one, and the archive's immutability is
expressed in its **name** (`india-2026-10.pmtiles`). The PMTiles *metadata* section
would be the natural home for a build date; `MAP-10a` does not read it, because a
provider entry that is out of date is an owner decision to re-point, not a client
decision to make mid-session.
A future `MAP-10b` may add an explicit `maxAge` to the provider entry; until then
the conservative default applies.
