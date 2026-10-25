import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_LOCATIONS,
  GDO_LOCATION_GROUPS,
  GDO_LOCATION_IDS,
  GDO_LOCATIONS_NAMESPACE,
  describePlace,
  formatCoordinate,
  locationsInGroup,
  resolveLocation,
} from './locations.js';

/**
 * The launcher's place deck is the game's only default, so it has to be honest:
 * every entry a real coordinate, no entry a duplicate, no group empty, and no
 * silent fallback when a place is unknown.
 */

test('the catalogue is a real, non-duplicated shortlist inside the map', () => {
  assert.equal(GDO_LOCATIONS_NAMESPACE, 'gdo:locations:v1');
  assert.ok(GDO_LOCATIONS.length >= 12, `expected a usable deck, found ${GDO_LOCATIONS.length}`);
  assert.equal(new Set(GDO_LOCATION_IDS).size, GDO_LOCATION_IDS.length, 'ids are unique');
  const names = new Set(GDO_LOCATIONS.map(location => location.name));
  assert.equal(names.size, GDO_LOCATIONS.length, 'no place is listed twice');

  for (const location of GDO_LOCATIONS) {
    assert.ok(location.id && location.name && location.city && location.region, `${location.id} is labelled`);
    assert.ok(location.blurb.length > 20, `${location.id} explains itself`);
    // Every entry must be a coordinate the world can actually mount.
    assert.ok(Number.isFinite(location.latitude) && Math.abs(location.latitude) < 85.05112878, `${location.id} latitude`);
    assert.ok(Number.isFinite(location.longitude) && Math.abs(location.longitude) <= 180, `${location.id} longitude`);
    assert.ok(GDO_LOCATION_GROUPS.some(group => group.id === location.group), `${location.id} has a real group`);
  }

  // Groups are non-empty and ordered; the deck renders them in this order.
  assert.deepEqual(GDO_LOCATION_GROUPS.map(group => group.id),
    ['capital', 'metro', 'heritage', 'coast', 'highland']);
  for (const group of GDO_LOCATION_GROUPS) {
    assert.ok(locationsInGroup(group.id).length > 0, `group ${group.id} has places`);
  }
});

test('Meerut is in the deck but is not the first thing offered', () => {
  const meerut = GDO_LOCATIONS.find(location => location.city === 'Meerut');
  assert.ok(meerut, 'the engine-tuning city is still listed');
  assert.notEqual(GDO_LOCATIONS[0].id, meerut.id, 'the first card is not a hard-coded default');
  assert.equal(resolveLocation(meerut.id).id, meerut.id);
});

test('resolveLocation answers by id and refuses anything else', () => {
  assert.equal(resolveLocation('delhi-india-gate').city, 'New Delhi');
  assert.equal(resolveLocation('nope'), null);
  assert.equal(resolveLocation(''), null);
  assert.equal(resolveLocation(null), null);
  assert.equal(resolveLocation(42), null);
});

test('describePlace turns an id or a typed coordinate into a launch, and refuses the rest', () => {
  const byId = describePlace({ kind: 'location', id: 'mumbai-gateway' });
  assert.equal(byId.ok, true);
  assert.equal(byId.kind, 'location');
  assert.equal(byId.latitude, 18.9220);
  assert.match(byId.subtitle, /Mumbai · Maharashtra/);

  // A bare id is the strong name, so it wins without an explicit kind.
  assert.equal(describePlace({ id: 'jaipur-hawa-mahal' }).name, 'Hawa Mahal');
  assert.equal(describePlace({ kind: 'location', id: 'atlantis' }).refusal, 'unknown-location');

  const typed = describePlace({ kind: 'coordinate', latitude: '26.9124', longitude: '75.7873' });
  assert.equal(typed.ok, true);
  assert.equal(typed.latitude, 26.9124);
  assert.equal(typed.name, 'Dropped pin');
  assert.match(typed.subtitle, /26\.9124° N, 75\.7873° E/);

  const named = describePlace({ latitude: 26.9124, longitude: 75.7873, name: '  Jaipur pin  ' });
  assert.equal(named.name, 'Jaipur pin');

  // Out of range, empty, and hostile input are refusals with a reason — never a
  // quiet default to some other place.
  assert.equal(describePlace({ latitude: 91, longitude: 0 }).refusal, 'bad-coordinate');
  assert.equal(describePlace({ latitude: 0, longitude: 181 }).refusal, 'bad-coordinate');
  assert.equal(describePlace({ latitude: 'north', longitude: 0 }).refusal, 'bad-coordinate');
  assert.equal(describePlace(null).refusal, 'bad-input');
  assert.equal(describePlace('delhi').refusal, 'bad-input');
});

test('formatCoordinate uses the hemisphere notation the HUD reads', () => {
  assert.equal(formatCoordinate(28.9845, 77.7064), '28.9845° N, 77.7064° E');
  assert.equal(formatCoordinate(-33.9249, -18.4241, 2), '33.92° S, 18.42° W');
  assert.equal(formatCoordinate(0, 0, 1), '0.0° N, 0.0° E');
  assert.equal(formatCoordinate('x', 0), '—');
});
