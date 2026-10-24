# NET-02 — Multiplayer Protocol Decision

**Status:** approved · **Type:** decision record (no runtime code) · **Row:** 171, P3
**Decided:** 2026-10-25 · **Gate:** *"Authority, interest management, IDs and abuse model documented."*
**Unblocks:** NET-03 (spatial interest management), NET-04 (avatars/interactions).

> This document is the contract NET-03 and NET-04 implement against. It ships no
> networking code and changes no runtime behaviour. Every number in it is a
> declared budget that a later row must assert; none is a measurement of a server
> that does not exist yet.

## 1. Scope

This decides **whether and how** a session layer may exist at all. It is not an
implementation plan. Its output is: an authority model, an identity rule, a
tick/interpolation budget, an interest-management contract, an abuse surface, and
an explicit list of what stays single-player.

The session model decided here is **co-op presence in a deterministic world**, not
a shared persistent world. Anything requiring server-side simulation of the world
(physics of props, traffic, weather reactions, ragdolls) is out of scope and stays
local.

## 2. Starting facts this decision has to respect

| Fact | Where it lives | Consequence |
|---|---|---|
| The world is a **deterministic function of (lat/lon, seed, content pack version)** | `GeoMath.js`, `GeoWorld.js`, `terrainSeedForCoordinate` | The network never transfers geometry. Both sides regenerate it. |
| A source tile is ≈ **214 game units** at Meerut latitude; low profile keeps 4 resident tiles | `tileSizeInGameUnits`, `GDO_LOW_PROFILE_BUDGETS` | Interest management must be sub-tile, cell-based, never tile-stepped. |
| Running speed is **3.8 game units/s** (`2.25` walking) | `GeoPlayer.js` | At 20 Hz a sprint is 0.19 units/tick — under one avatar height, so tick rate is not the visible problem; *jitter* is. |
| The avatar is ~0.2 game units tall (1:10 map scale); no independent limbs until physics | `MINIMAL_PHYSICS_RESEARCH.md` §7 | Remote avatar = one capsule + interpolated transform. No bone sync. |
| `NET-01` save is local, versioned, personal | `LocalSave.js` | Personal state is never uploaded; a session has no view of it. |
| `PHY-05` ragdoll island is explicitly **visual, engine-agnostic, local** | `RagdollIsland.js` | Ragdolls are cosmetic and never authoritative for others. |
| A WebSocket prototype exists and is **unused** | `src/network/MultiplayerClient.js` | It is client-authoritative, JSON, allocates per packet, has no auth or validation. It is **not** the protocol. |

**Decision 2.1** — `src/network/MultiplayerClient.js` is quarantined: it must not be
imported by any frame path. NET-04 replaces it (pooled buffers, binary frames,
validating decode) rather than evolving it, and it is deleted in that change. *Landed
in `NET-04`: the module was deleted and replaced by `src/engine/MultiplayerAvatars.js`.*

## 3. Authority model

**Decision 3.1 — The session server is authoritative for *consequences*; the client
is authoritative only for *itself and its cosmetics*.**

The test applied to every field: *if a client lies about this, does another player's
experience or any durable record change?* If yes → server. If no → client, and the
server only rate-limits it.

| Field | Owner | Rationale |
|---|---|---|
| Local player transform | **Client proposes, server adjudicates** | Others see only what the server accepted. |
| Remote player rendering, camera, animation blending | Client (each peer) | Cosmetic; cannot affect others. |
| Shared prop state (doors, pushables, breakables) | **Server** | Shared consequence; a lying client would desync everyone. |
| Ragdoll / pose-fall state | **Local only, never sent** | Cosmetic; `PHY-05` already proves it is visual. |
| Weather, time-of-day, fog | **Server sets seed + time base; clients derive** | Deterministic derivation, near-zero bandwidth, no desync path. |
| Personal discovery journal, progress, settings | **Local only, never sent** | `NET-01` is a personal save. Uploading it buys nothing and costs privacy. |
| Chat / presence text | Server relays, **does not persist** | No durable record to protect; moderation is policy, not protocol. |
| Player identity | **Server assigns** | Clients cannot choose or reuse ids. |

**Decision 3.2 — No client-authoritative persistence.** Nothing a session produces
survives the session. A session can therefore be lost at any moment with zero data
loss by design; this is what makes the abuse surface small.

**Decision 3.3 — Movement validation is a rule, not a re-simulation.** The server
checks three things per accepted tick and nothing else: speed ≤ **4.5 units/s**
(sprint 3.8 + 18% margin), per-tick displacement ≤ **0.6 units**, and vertical
position consistent with the deterministic support query ±0.5 units. No physics
re-simulation, no anti-cheat arms race.

## 4. Identity and identifiers

**Decision 4.1 — Three id namespaces, never interchangeable.**

| Kind | Shape | Lifetime | Validity rule |
|---|---|---|---|
| Session id | server-generated opaque token | one session | Required on every frame; unknown → drop frame, counted. |
| Player id | server-assigned `p:<16-bit slot>` within the session | session | Reused only after a slot's disconnect grace expires. |
| Entity id | `tile:zoom/x/y:polygonIndex` or `prop:<pool-id>` from deterministic generation | **regenerated identically on both sides** | Accepted only if it exists in the **sender's current interest set**; anything else is rejected as `unknown-entity`. |

**Decision 4.2 — Ids are opaque and interest-scoped.** A client may not reference an
entity it was not sent. This single rule closes id guessing, remote-object mutation,
and cross-cell probing in one place. It is enforced server-side and asserted in
NET-03's tests.

**Decision 4.3 — No persistent accounts in this row.** Identity is ephemeral per
session. Durable identity, handles, and cosmetics ownership are a separate decision
that this document does not make.

## 5. Tick, snapshot and interpolation budget

**Decision 5.1 — 20 Hz simulation, 20 Hz snapshots, 100 ms render delay.** The delay
is deliberately *more* than one tick and less than two, so a single dropped snapshot
interpolates rather than stalls. (The prototype's 100 ms is the one number worth
keeping; its 50 ms send throttle is not a budget because it is unenforced on the
receive side.)

| Quantity | Low | Balanced | High |
|---|---:|---:|---:|
| Server tick / snapshot rate | 20 Hz | 20 Hz | 20 Hz |
| Client upload rate (own transform) | 20 Hz | 20 Hz | 20 Hz |
| Render delay | 100 ms | 100 ms | 100 ms |
| Max extrapolation before freeze | 120 ms | 120 ms | 120 ms |
| Snapshot buffer depth | 3 | 3 | 4 |
| Max remote players tracked | **4** | 8 | 12 |
| Down budget | 4 kB/s | 8 kB/s | 16 kB/s |
| Up budget | 1 kB/s | 1 kB/s | 1 kB/s |

**Decision 5.2 — Quantised binary frames, fixed size per player.** No JSON. Per
remote player per snapshot:

| Field | Bits | Encoding |
|---|---:|---|
| x, z | 16 + 16 | cell-relative, ±64 units → 0.002 units |
| y | 8 | delta from deterministic terrain sample, ±2 units |
| yaw | 8 | 1.4° |
| locomotion + posture | 4 + 4 | declared enum |
| animation phase | 6 | cycle phase |
| interaction flags | 4 | declared bits |
| **Total** | **66 bits ≈ 9 bytes** | |

**Decision 5.3 — The budget asserts bytes, not feelings.** 9 B × 8 players × 20 Hz ≈
**1.44 kB/s** down plus a 12 B header per snapshot (≈ 0.24 kB/s) — inside the
balanced 8 kB/s ceiling with 5× headroom. NET-03 lands
`networkSnapshotBytesPerSecond`, `networkTrackedPlayers`, `networkSteadyFrameAllocations: 0`,
and `networkGeometryBytes: 0` in the `QLT-05` budget with these as the low-profile
ceilings.

**Decision 5.4 — Determinism replaces transfer.** The only world payload on join is
`{ seed, contentVersion, weatherMonth, timeBaseSeconds, sessionId }` — under **48
bytes, once**. Terrain, buildings, roads, plants, props, doors, and labels are
regenerated locally from that. `networkGeometryBytes: 0` is an invariant, not an
optimisation.

## 6. Interest management contract (the input NET-03 implements)

**Decision 6.1 — Interest is a cell neighbourhood around the local player, never the
global world.**

- Cell size: **32 game units** (≈ 1/6.7 tile).
- Track radius: enter at **64 units**, leave at **80 units** (1.25× hysteresis, so an
  entity oscillating on the boundary cannot churn).
- Hard cap: the profile's remote-player limit, sorted by distance; the surplus is
  simply not tracked and is reported as `interestOverflow`.
- Rebuild the set only when the player crosses a cell boundary (hysteresis + cells,
  never per frame) — the same rule `PHY-05` uses for its proxy set.
- Entities outside interest are **not simulated, not interpolated, and not
  rendered**; on re-entry they appear from the next snapshot, never from stale state.

**Decision 6.2 — What is never synchronized:** terrain and all generated geometry;
labels and POIs; pedestrians, traffic, ambient life; plants and wind; weather
particles; physics props' micro-state; ragdolls; discoveries; saves.

## 7. Abuse surface

Every threat below must be one of: *impossible by construction*, *rejected and
counted*, or *accepted with a named residual risk*. Nothing is "handled later"
silently.

| # | Threat | Mitigation | Class |
|---|---|---|---|
| 1 | Spoofed position / teleport | Server accepts ≤ 0.6 units/tick, ≤ 4.5 units/s, support-consistent y | rejected |
| 2 | Speed hack via high upload rate | Token bucket: 30 frames/s, burst 5; excess dropped, counted | rejected |
| 3 | Id forgery / mutating others' entities | Interest-scoped validity (§4.2); unknown ids dropped | impossible |
| 4 | Interest probing (asking for far entities) | Requests are player-anchored; there is no "query by id" verb at all | impossible |
| 5 | Snapshot / frame flooding | Pooled fixed-size frames; per-session budget; over-budget sessions throttled then disconnected | rejected |
| 6 | Malformed payload crash | Decode validates length + enum ranges before use, never throws into the frame (the `NET-01` pattern) | rejected |
| 7 | Allocation exhaustion via many small packets | Zero-allocation decode path asserted by test (`steadyFrameAllocations: 0`) | rejected |
| 8 | Reconnect churn (slot parking) | Disconnect grace 2 s, one reuse of a slot per session, counted | rejected |
| 9 | Name/chat abuse, harassment | Server relays only; length + charset limits; moderation is **policy**, not protocol | **residual** |
| 10 | Collusion / information advantage | Positions of *tracked* players are legitimately visible; no hidden state exists to leak | **accepted** |
| 11 | Save tampering for advantage | Saves are personal and local; a session never reads them, so there is nothing to gain | **impossible** |
| 12 | PII exposure | No accounts, no names required, no persistence; ephemeral ids only | **impossible** |
| 13 | DDoS against the relay | Out of scope for the client; needs hosting-layer mitigation (see §9) | **residual, ops** |

**Decision 7.1 — No credentials in the protocol.** No passwords, tokens, or
third-party identities travel in these frames; session ids are opaque and
short-lived.

## 8. What stays single-player

**Decision 8.1 — Single-player is the product; a session is an optional layer, and
its absence is byte-identical to today.**

| Stays single-player, permanently | Why |
|---|---|
| All world generation and streaming | Deterministic, local, per-device budgets |
| Discovery journal, progress, settings, save | Personal (`NET-01`), no authority to sync, privacy |
| Physics: pose fall, PBD puppet, ragdoll island, breakables, pushables | Cosmetic or local-consequence; server simulation is out of scope |
| Traffic, pedestrians, ambient life, weather, time-of-day | Derived locally from seed + environment |
| Navigation, minimap, guidance, activities | Local model |
| Rendering, LOD, budget enforcement | Device-local by definition |
| **Shared in a session** (the entire surface) | Player presence + shared prop interactions only |

**Decision 8.2 — Session loss is a no-op.** On disconnect: remote avatars fade and are
removed within 2 s, all owned resources release through the lifecycle ledger back to
baseline, and the world continues from local state. Nothing is rolled back, nothing
is restored, nothing is saved twice.

## 9. Explicitly not decided here (owner/ops input required)

1. **Hosting and cost ceiling** — relay provider, region, and whether the low profile
   is ever allowed to open a session at all (it costs the same as balanced here).
2. **Public vs. private** — if strangers can share a session, threat 9 stops being
   "residual policy" and needs a moderation decision.
3. **Identity** — whether durable handles/cosmetics are ever warranted.
4. **Latency target** — the 100 ms interpolation delay assumes ≤ 80 ms RTT; above
   that, the honest answer is a higher delay, not a faster tick.
5. **Regional map parity** — sessions are anchored to one coordinate; cross-region
   play is out of scope.

## 10. Consequences for NET-03 and NET-04

**NET-03 lands when:** the interest set is cell-derived with hysteresis and caps
(§6); a tracked-player snapshot encodes in ≤ 12 B and the whole stream stays inside
the profile ceiling (§5.3); the budget keys are asserted in `QLT-05`'s evaluator;
`networkGeometryBytes: 0` holds on join; and every id is interest-scoped (§4.2).

**NET-04 lands when:** interpolation runs on the 100 ms delay with a 120 ms
extrapolation cap; disconnect cleanup returns the lifecycle ledger to baseline; the
join payload is ≤ 48 B and contains no geometry; and threats 1–8 each have a test
that proves rejection *and* counts it.

## 11. Revisit triggers

Reopen this decision only if: a session must persist something; a shared prop must
survive a disconnect; the measured RTT in the target region exceeds 80 ms; or a
public-session requirement appears. Otherwise NET-03/04 implement this document as
written.

---

**Summary of the decision:** server-authoritative for consequences, client-authoritative
for itself; 20 Hz binary quantised snapshots at 9 B/player with a 100 ms interpolation
delay; cell-based interest with hysteresis and per-profile caps; three
non-interchangeable id namespaces with interest-scoped validity; a threat table where
every entry is impossible, rejected-and-counted, or a named residual; and a hard line
that the entire shipped game stays single-player, with a session as an optional layer
whose loss costs nothing.
