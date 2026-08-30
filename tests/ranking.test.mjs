import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizedEntries, latestPair, deltaFor } from '../src/ranking.js';

test('normalizes a full ranking snapshot and preserves organization names', () => {
  const entries = normalizedEntries({ entries: [{ id: 832459, name: '俏貓', organization: { name: '紅蝶' }, rank: 4, score: 1200 }] });
  assert.deepEqual(entries[0], { id: '832459', name: '俏貓', organization: '紅蝶', rank: 4, score: 1200 });
});

test('calculates rank movement for every player between snapshots', () => {
  const current = normalizedEntries({ entries: [{ id: 1, name: 'A', rank: 2 }, { id: 2, name: 'B', rank: 5 }] });
  const previous = normalizedEntries({ entries: [{ id: 1, name: 'A', rank: 6 }, { id: 2, name: 'B', rank: 3 }] });
  assert.equal(deltaFor(current[0], previous).value, 4);
  assert.equal(deltaFor(current[1], previous).value, -2);
});

test('orders snapshots by capture time and handles first appearance', () => {
  const [latest, previous] = latestPair([{ capturedAt: 1000, entries: [] }, { capturedAt: 2000, entries: [{ id: 7, name: '新玩家' }] }]);
  assert.equal(latest.capturedAt, 2000);
  assert.equal(deltaFor(normalizedEntries(latest)[0], normalizedEntries(previous)).value, null);
});
