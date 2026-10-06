import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { latestPair } from '../src/ranking.js';

const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE ranking_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, mode TEXT, captured_at INTEGER, entry_count INTEGER, payload TEXT)');
const env = { DB: { prepare(sql) {
  let args = {};
  const statement = db.prepare(sql.replace(/\?(\d+)/g, ':p$1'));
  return {
    bind(...values) { args = Object.fromEntries(values.map((value, index) => [`p${index + 1}`, value])); return this; },
    async first() { return statement.get(args); },
    async all() { return { results: statement.all(args) }; },
    async run() { return { meta: { changes: Number(statement.run(args).changes) } }; },
  };
} } };
const context = vm.createContext({ console, Date, Set, Response, URL });
vm.runInContext(fs.readFileSync(new URL('../worker/src/index.js', import.meta.url), 'utf8').replace('export default {', 'globalThis.worker = {'), context);
const data = [['1v1', [{ id: 1, name: 'A', rank: 2 }]]];
const concurrent = await Promise.all([context.storeSnapshots(env, 100000, data), context.storeSnapshots(env, 100003, data)]);
assert.equal(concurrent.reduce((sum, result) => sum + result.accepted.length, 0), 1);
assert.equal(db.prepare('SELECT count(*) AS n FROM ranking_snapshots').get().n, 1);
assert.equal((await context.storeSnapshots(env, 159999, data)).skipped.length, 1);
assert.equal((await context.storeSnapshots(env, 160000, data)).accepted.length, 1);
assert.equal((await context.storeSnapshots(env, 90000, data)).skipped.length, 1);
assert.equal((await context.storeSnapshots(env, 100000, [['3v3', data[0][1]]])).accepted.length, 1);

// 重現線上 #509/#508 的 3ms 重複；API 與前端應選上一份 17:03 快照。
db.exec('DELETE FROM ranking_snapshots');
const put = db.prepare('INSERT INTO ranking_snapshots (id,mode,captured_at,entry_count,payload) VALUES (?, ?, ?, ?, ?)');
const payload = JSON.stringify(data[0][1]);
put.run(509, '1v1', 1791279615319, 1, payload);
put.run(508, '1v1', 1791279615316, 1, payload);
put.run(506, '1v1', 1791277409553, 1, JSON.stringify([{ id: 1, name: 'A', rank: 3 }]));
const response = await context.worker.fetch(new Request('https://test/api/rankings/history?mode=1v1&limit=5'), env);
assert.deepEqual((await response.json()).snapshots.map((row) => row.id), [509, 506]);
const snapshots = db.prepare('SELECT id,captured_at AS capturedAt,payload FROM ranking_snapshots').all().map((row) => ({ ...row, entries: JSON.parse(row.payload) }));
assert.deepEqual(latestPair(snapshots).map((row) => row.id), [509, 506]);
assert.equal(latestPair([{ id: 2, capturedAt: 200000, entries: [] }, { id: 1, capturedAt: 140000, entries: [] }])[1].id, 1);
assert.equal(latestPair([{ id: 2, capturedAt: 200000, entries: [] }, { id: 1, capturedAt: 199997, entries: [] }])[1], undefined);
assert.equal(db.prepare('SELECT count(*) AS n FROM ranking_snapshots').get().n, 3);
db.close();
console.log('PASS: atomic concurrent writes, 60s boundary, stale packets, separate modes, API/frontend duplicate comparison, original history preserved');
