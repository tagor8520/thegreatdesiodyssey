/**
 * `GME-06` — discovery journal (Node tier).
 *
 * Registered gate (feature-roadmap/README.md order 135):
 *   "Deterministic place IDs and bounded local state"
 *
 * Both clauses are properties, not appearances, so both are measured here rather than
 * described. "Deterministic" means the id is a pure function of the place: the same place
 * seen in a second session, in a different walk order, after a tile rebuild, or after a
 * round trip through JSON must yield the same id — and the journal built from those ids
 * must hold the same entries. "Bounded" means the memory a player holds is a function of
 * `capacity` alone: crossing the map ten times over must not move the byte count by one.
 *
 * The first run of this module found two real defects that this file now pins: the id was
 * quantised at 0.5 units, so a 0.2-unit anchor shift produced a *different* id (rounding
 * flips at every bucket edge) and a rebuilt tile would have logged a second discovery; and
 * eviction returned its slot to the free list without taking it back out, so the journal
 * grew past its own capacity (size 5 with capacity 4).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DiscoveryJournal,
  GEO_DISCOVERY_CAPACITY,
  GEO_DISCOVERY_CELL_SIZE,
  GEO_DISCOVERY_KINDS,
  discoveryKind,
  discoveryPlaceId,
} from './DiscoveryJournal.js';

const place = (name, kind, x, z, extra = {}) => ({ name, kind, x, z, ...extra });

test('a place id is a pure function of the place', () => {
  const id = discoveryPlaceId('Sardar Patel Marg', 'street', 12.1, -4.3);
  assert.equal(id, discoveryPlaceId('Sardar Patel Marg', 'street', 12.1, -4.3), 'the same place yields the same id');
  assert.equal(id, discoveryPlaceId('  sardar   PATEL marg ', 'Street', 12.1, -4.3),
    'case and whitespace are folded: providers disagree about both, and that is one street');

  // Determinism is not order: ids depend on the place, never on how many were seen first.
  const other = discoveryPlaceId('Chariot Way', 'street', 40, 40);
  assert.notEqual(id, other);
  assert.equal(discoveryPlaceId('Chariot Way', 'street', 40, 40), other, 'a second computation is unaffected by the first');

  // The kind participates, so a street and a water body at the same anchor stay distinct.
  assert.notEqual(id, discoveryPlaceId('Sardar Patel Marg', 'water', 12.1, -4.3));
  // So does the cell — two same-named places a cell apart are two places.
  assert.notEqual(id, discoveryPlaceId('Sardar Patel Marg', 'street', 12.1 + GEO_DISCOVERY_CELL_SIZE, -4.3));

  // And the id survives the trip through a save file: it is a printable string with no
  // characters that need escaping, which is what lets `NET-01` persist it verbatim.
  assert.equal(typeof id, 'string');
  assert.match(id, /^[a-z-]+:[a-z0-9-]+:[0-9a-f]{8}$/);
  assert.equal(JSON.parse(JSON.stringify(id)), id);

  assert.throws(() => discoveryPlaceId('', 'street', 0, 0), /non-empty name/);
  assert.throws(() => discoveryPlaceId('A', '', 0, 0), /non-empty kind/);
  assert.throws(() => discoveryPlaceId('A', 'street', NaN, 0), /finite coordinates/);
});

test('a rebuilt anchor inside the same cell is the same place, and the journal says so once', () => {
  // The defect this pins: the first implementation quantised at 0.5 units and a 0.2-unit
  // shift crossed a bucket edge, so the same street came back as a new discovery.
  const anchor = place('Sardar Patel Marg', 'street', GEO_DISCOVERY_CELL_SIZE * 3 + 0.4, -4.3);
  const rebuilt = place('Sardar Patel Marg', 'street', anchor.x + 0.2, anchor.z - 0.2);
  assert.equal(discoveryPlaceId(anchor.name, anchor.kind, anchor.x, anchor.z),
    discoveryPlaceId(rebuilt.name, rebuilt.kind, rebuilt.x, rebuilt.z));

  const journal = new DiscoveryJournal();
  assert.equal(journal.update({ x: anchor.x, z: anchor.z }, [anchor]), 1, 'walking into the street discovers it');
  assert.equal(journal.update({ x: rebuilt.x, z: rebuilt.z }, [rebuilt]), 0, 'the rebuilt anchor is the same place, not a second one');
  assert.equal(journal.size, 1);
  assert.equal(journal.diagnostics().discoveries, 1);
  assert.equal(journal.diagnostics().rediscovered, 1);

  // Across a whole cell edge the shift is a different place: the quantisation is coarse,
  // not absent, and the boundary is where the cell says it is.
  assert.notEqual(discoveryPlaceId(anchor.name, anchor.kind, anchor.x, anchor.z),
    discoveryPlaceId(anchor.name, anchor.kind, anchor.x + GEO_DISCOVERY_CELL_SIZE, anchor.z));
});

test('two sessions over the same places hold the same journal, whatever order they walked', () => {
  const places = [];
  for (let index = 0; index < 12; index++) {
    places.push(place(`Place ${index}`, index % 3 === 0 ? 'street' : 'place', index * 40 - 100, index * 17 - 60));
  }
  const walk = order => {
    const journal = new DiscoveryJournal();
    for (const index of order) journal.update({ x: places[index].x, z: places[index].z }, [places[index]]);
    return journal;
  };
  const forwards = walk([...places.keys()]);
  const backwards = walk([...places.keys()].reverse());
  const nameAndId = journal => journal.list().map(entry => `${entry.id} ${entry.name} ${entry.kind}`).sort();

  assert.deepEqual(nameAndId(forwards), nameAndId(backwards),
    'the same set of places is the same journal: walk order cannot change identity');
  assert.equal(forwards.size, places.length);
  assert.equal(backwards.size, places.length);
  for (const entry of forwards.list()) {
    const looked = backwards.find({ id: entry.id });
    assert.ok(looked, `an id from one session resolves in the other: ${entry.id}`);
    assert.equal(looked.name, entry.name);
    assert.equal(looked.kind, entry.kind);
    assert.equal(looked.x, entry.x);
    assert.equal(looked.z, entry.z);
  }
  // A name lookup reaches the same entry as the id lookup.
  const first = forwards.list()[0];
  assert.equal(forwards.find({ name: first.name, kind: first.kind }).id, first.id);
  assert.equal(forwards.has(first.id), true);
  assert.equal(forwards.find({ id: 'street:nope:00000000' }), null);
});

test('capacity is a hard bound and the bytes never grow with the journey', () => {
  const capacity = 16;
  const journal = new DiscoveryJournal({ capacity });
  const bytesAtConstruction = journal.diagnostics().bytes;
  assert.equal(journal.size, 0);

  const walkers = [];
  for (let step = 0; step < 2000; step++) {
    // Two candidates per step, at the player's own feet, never revisited: an exploring
    // player, not a looping one. 4000 discoveries into 16 slots.
    const x = (step % 97) * 250, z = Math.floor(step / 97) * 250;
    walkers.length = 0;
    walkers.push(place(`Step ${step} A`, 'place', x, z));
    walkers.push(place(`Step ${step} B`, 'street', x, z));
    journal.update({ x, z }, walkers);
    assert.ok(journal.size <= capacity, `size ${journal.size} must not exceed capacity ${capacity} at step ${step}`);
  }
  assert.equal(journal.size, capacity, 'a long journey fills the journal and stops there');
  assert.equal(journal.diagnostics().bytes, bytesAtConstruction, 'the storage is preallocated: bytes do not move');
  assert.equal(journal.ids.length, capacity);
  assert.equal(journal.positions.length, capacity * 2);
  // 4000 places offered to 16 slots, and the books balance: what entered minus what was
  // displaced is what is held, and nothing is unaccounted for.
  const longReport = journal.diagnostics();
  assert.equal(longReport.discoveries - longReport.evicted, journal.size);
  assert.equal(longReport.discoveries + longReport.declined + longReport.rediscovered + longReport.rejected, 4000);
  assert.ok(longReport.evicted > 0, 'a journey longer than the capacity must displace entries');

  // Eviction is deterministic when the clock is equal: the smallest id leaves first, so the
  // same places offered in a different order leave the same survivors.
  const first = new DiscoveryJournal({ capacity: 3 });
  const second = new DiscoveryJournal({ capacity: 3 });
  const six = Array.from({ length: 6 }, (_, index) => place(`Tie ${index}`, 'place', index * 500, 0));
  for (const entry of six) first.update({ x: entry.x, z: 0 }, [entry]);
  for (const entry of [...six].reverse()) second.update({ x: entry.x, z: 0 }, [entry]);
  const survivors = journal => journal.list().map(entry => entry.id).sort();
  assert.deepEqual(survivors(first), survivors(second),
    'with equal discovery clocks the journal keeps the same places regardless of arrival order');

  // A journal at capacity still answers quickly and still discovers inside its radius.
  assert.equal(first.has(survivors(first)[0]), true);
});

test('the radius, the kinds and the clock are the documented contract', () => {
  assert.equal(discoveryKind('landmark').label, 'Landmark');
  assert.equal(discoveryKind('no-such-kind'), GEO_DISCOVERY_KINDS.default, 'an unknown kind falls back rather than throwing');

  const journal = new DiscoveryJournal();
  const landmark = place('Gateway', 'landmark', 0, 0);
  const radius = discoveryKind('landmark').radius;
  // Exactly on the boundary counts as inside: the runtime asks "am I there yet", and a
  // player standing on the edge has arrived.
  assert.equal(journal.update({ x: radius, z: 0 }, [landmark]), 1);
  const far = new DiscoveryJournal();
  assert.equal(far.update({ x: radius + 0.001, z: 0 }, [landmark]), 0, 'a step outside the radius is not a discovery');

  // A place may carry its own radius, and it wins over the kind's.
  const scaled = new DiscoveryJournal();
  assert.equal(scaled.update({ x: 90, z: 0 }, [place('Gateway', 'landmark', 0, 0, { radius: 100 })]), 1,
    'a place may carry its own radius, and the kind default does not apply');
  const unscaled = new DiscoveryJournal();
  assert.equal(unscaled.update({ x: 90, z: 0 }, [place('Gateway', 'landmark', 0, 0)]), 0,
    'the same walk with the kind default radius is still outside it');

  // The clock is monotonic and is what the journal reports.
  const clocked = new DiscoveryJournal();
  clocked.update({ x: 0, z: 0 }, [], { now: 120 });
  assert.equal(clocked.diagnostics().clock, 120);
  assert.throws(() => clocked.update({ x: 0, z: 0 }, [], { now: 119 }), /monotonically/);
  assert.throws(() => clocked.update({ x: NaN, z: 0 }, []), /finite position/);
  clocked.update({ x: 0, z: 0 }, [place('Late', 'place', 0, 0)]);
  assert.equal(clocked.list()[0].discoveredAt, 120, 'an entry carries the reading it was discovered at');
});

test('a malformed place is refused without taking the journal down', () => {
  const journal = new DiscoveryJournal();
  // A label with no name, or with a broken anchor, must not throw inside the frame loop:
  // it is counted as a rejection and the pass continues to the next candidate.
  assert.equal(journal.update({ x: 0, z: 0 }, [place('', 'street', 0, 0), place('Good', 'place', 3, 0)]), 1);
  assert.equal(journal.size, 1);
  assert.equal(journal.diagnostics().rejected, 1);
  assert.match(journal.diagnostics().lastRejection.reason, /non-empty name/);
  assert.equal(journal.diagnostics().lastDiscovery.name, 'Good');

  // And a candidate list that is absent or empty is a no-op, not an error.
  assert.equal(journal.update({ x: 0, z: 0 }, []), 0);
  assert.equal(journal.update({ x: 0, z: 0 }, undefined), 0);
  assert.equal(journal.size, 1);
});

test('work per pass is bounded by the candidate list the runtime supplies', () => {
  // The runtime passes resident places only, so the per-frame cost is a function of what is
  // streamed in. 5000 candidates in one pass must still land inside the capacity, and the
  // journal must not allocate per candidate.
  const journal = new DiscoveryJournal({ capacity: GEO_DISCOVERY_CAPACITY });
  const bytesAtConstruction = journal.diagnostics().bytes;
  const crowd = [];
  for (let index = 0; index < 5000; index++) {
    // All inside the default radius, all distinct names: the bound under test is the
    // journal's, not the radius's.
    crowd.push(place(`Crowd ${index}`, 'place', index % 8, Math.floor(index / 8) * 0.05));
  }
  const discovered = journal.update({ x: 0, z: 0 }, crowd);
  assert.equal(journal.size, GEO_DISCOVERY_CAPACITY, 'one pass fills a journal at most to capacity');
  assert.equal(discovered, journal.diagnostics().discoveries, 'the pass returns what entered the journal');
  // The bookkeeping adds up in both directions: what entered minus what was displaced is
  // exactly what is held, and what was neither held nor displaced was declined.
  const report = journal.diagnostics();
  assert.equal(report.discoveries - report.evicted, journal.size, 'discovered - evicted === size');
  assert.equal(report.discoveries + report.declined + report.rediscovered + report.rejected, 5000,
    'every candidate is accounted for exactly once');
  assert.ok(report.declined > 0, 'a crowd into a smaller journal must decline places rather than lie about them');
  assert.equal(report.bytes, bytesAtConstruction);
  assert.equal(report.considered, 5000, 'every candidate is considered exactly once');
  // A second identical pass is quiet: the held places are recognised, and the rest are
  // declined again rather than announced as discoveries on every frame.
  assert.equal(journal.update({ x: 0, z: 0 }, crowd), 0, 'the second pass discovers nothing');
  assert.equal(journal.diagnostics().discoveries, report.discoveries, 'and announces nothing');
  assert.equal(journal.diagnostics().rediscovered, GEO_DISCOVERY_CAPACITY, 'the held places are recognised');
  assert.equal(journal.diagnostics().size, GEO_DISCOVERY_CAPACITY);

  // `list` writes into the caller's array, so a HUD refreshing once a second allocates one
  // array a second rather than one entry per place per frame.
  const reused = [];
  const first = journal.list(reused);
  assert.equal(first.length, GEO_DISCOVERY_CAPACITY);
  assert.equal(journal.list(reused), first, 'the caller owns the array, and it is refilled');

  assert.throws(() => new DiscoveryJournal({ capacity: 0 }), /positive integer/);
});

test('lifecycle: the reset clears the entries and the counters together', () => {
  const journal = new DiscoveryJournal({ capacity: 4 });
  const bytes = journal.diagnostics().bytes;
  journal.update({ x: 0, z: 0 }, [place('One', 'place', 0, 0), place('Two', 'street', 5, 5)], { now: 60 });
  assert.equal(journal.size, 2);
  const heldId = journal.list()[0].id;
  const cleared = journal.reset();
  assert.equal(cleared.size, 0, 'no entries outlive the reset');
  assert.equal(journal.has(heldId), false, 'a reset id is unknown again');
  assert.equal(journal.ids.every(id => id === null), true, 'no slot still holds an id');
  assert.equal(journal.ids.length, 4, 'the slots themselves are not thrown away');
  assert.equal(cleared.clock, 0);
  assert.equal(cleared.discoveries, 0);
  assert.equal(cleared.rediscovered, 0);
  assert.equal(cleared.evicted, 0);
  assert.equal(cleared.declined, 0);
  assert.equal(cleared.updates, 0);
  assert.equal(cleared.bytes, bytes, 'the storage is unchanged: a reset is not a reallocation');
  assert.equal(journal.list().length, 0);
  // A journal that has been reset still works, and still evicts correctly.
  for (let index = 0; index < 8; index++) {
    journal.update({ x: index * 500, z: 0 }, [place(`Again ${index}`, 'place', index * 500, 0)], { now: 100 + index });
  }
  assert.equal(journal.size, 4);
  const again = journal.diagnostics();
  assert.equal(again.discoveries - again.evicted, 4, 'the books balance after a reset too');
  assert.equal(again.considered, 8);
});
