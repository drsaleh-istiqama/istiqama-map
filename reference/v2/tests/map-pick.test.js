import test from 'node:test';
import assert from 'node:assert/strict';
import { createMapPickSession } from '../src/map-pick.js';

test('map picking keeps the form location until the user confirms a new point', () => {
  const session = createMapPickSession({ lat:-5.1, lng:39.7 });
  session.choose({ lat:-6.2, lng:39.2 });
  assert.deepEqual(session.cancel(), { lat:-5.1, lng:39.7 });
});

test('map picking returns the selected point on confirmation', () => {
  const session = createMapPickSession(null);
  assert.equal(session.canConfirm(), false);
  session.choose({ lat:-5.0551234, lng:39.7299876 });
  assert.equal(session.canConfirm(), true);
  assert.deepEqual(session.confirm(), { lat:-5.055123, lng:39.729988 });
});

test('map picking rejects invalid coordinates', () => {
  const session = createMapPickSession(null);
  assert.throws(() => session.choose({ lat:100, lng:39 }), /إحداثيات/);
});
