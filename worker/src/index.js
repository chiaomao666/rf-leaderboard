const MODES = new Set(['1v1', '3v3']);
const MODE_LIST = ['1v1', '3v3'];
const MAX_ENTRIES = 5000;
const MAX_SNAPSHOTS_PER_MODE = 100;
const MIN_CAPTURE_INTERVAL_MS = 60_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_NATIONS = 64;
const GAME_WS_TIMEOUT_MS = 30_000;

// 這個 API 有兩種完全不同來源的呼叫者：
//   1. 排行榜網站（https://chiaomao666.github.io）讀取 /api/rankings/history、/api/rankings/nations
//   2. 遊戲本體（本機用 file:// 開啟，Origin 是字面上的 "null"）寫入 /api/rankings/capture、/api/rankings/nations
// 寫入端本來就靠 X-RF-Ranking-Secret 驗證，不是靠 CORS 擋壞人，
// 所以這裡直接放行任何來源，改用密鑰做真正的存取控制。
function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'Content-Type, X-RF-Ranking-Secret',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders() } });
}
function cleanEntry(raw, rank) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? raw.playerId ?? raw.user_id ?? '').trim();
  const name = String(raw.name ?? raw.nickname ?? raw.playerName ?? '').trim().slice(0, 120);
  const organization = String(raw.organization ?? raw.union ?? raw.guild ?? '').trim().slice(0, 120);
  if (!id && !name) return null;
  const score = Number.isFinite(Number(raw.score ?? raw.rating ?? raw.points)) ? Number(raw.score ?? raw.rating ?? raw.points) : null;
  const nationId = Number.isFinite(Number(raw.nationId ?? raw.nation_id)) ? Number(raw.nationId ?? raw.nation_id) : null;
  return { id: id.slice(0, 80), name, organization, rank: Number(raw.rank) > 0 ? Number(raw.rank) : rank, score, nationId };
}
function cleanNation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = Number(raw.id);
  if (!Number.isFinite(id)) return null;
  const name = String(raw.name ?? '').trim().slice(0, 60);
  const title = String(raw.title ?? '').trim().slice(0, 80);
  if (!name && !title) return null;
  return {
    id,
    name,
    title,
    flag: String(raw.flag ?? '').trim().slice(0, 200),
    colorIcon: String(raw.colorIcon ?? raw.color_icon ?? '').trim().slice(0, 200),
  };
}
async function readJson(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_BODY_BYTES) throw new Error('payload too large');
  return request.json();
}
async function prune(env, mode) {
  await env.DB.prepare('DELETE FROM ranking_snapshots WHERE mode = ?1 AND id NOT IN (SELECT id FROM ranking_snapshots WHERE mode = ?1 ORDER BY captured_at DESC LIMIT ?2)').bind(mode, MAX_SNAPSHOTS_PER_MODE).run();
}

// ---------------------------------------------------------------
//  寫入 D1（HTTP 上傳端點與排程抓取共用）
// ---------------------------------------------------------------
async function storeSnapshots(env, capturedAt, requested) {
  const accepted = [];
  const skipped = [];
  for (const [mode, rawEntries] of requested) {
    if (!MODES.has(mode)) { skipped.push({ mode, reason: 'invalid_mode' }); continue; }
    const entries = Array.isArray(rawEntries) ? rawEntries.slice(0, MAX_ENTRIES).map(cleanEntry).filter(Boolean) : [];
    if (!entries.length) { skipped.push({ mode, reason: 'entries_required' }); continue; }
    const latest = await env.DB.prepare('SELECT captured_at FROM ranking_snapshots WHERE mode = ?1 ORDER BY captured_at DESC LIMIT 1').bind(mode).first();
    if (latest && capturedAt - Number(latest.captured_at) < MIN_CAPTURE_INTERVAL_MS) {
      skipped.push({ mode, reason: 'rate_limited', nextAllowedAt: Number(latest.captured_at) + MIN_CAPTURE_INTERVAL_MS });
      continue;
    }
    await env.DB.prepare('INSERT INTO ranking_snapshots (mode, captured_at, entry_count, payload) VALUES (?1, ?2, ?3, ?4)').bind(mode, capturedAt, entries.length, JSON.stringify(entries)).run();
    await prune(env, mode);
    accepted.push({ mode, entryCount: entries.length });
  }
  return { accepted, skipped };
}

async function storeMedals(env, playerId, scores, capturedAt) {
  const stmts = [];
  for (const [mode, entry] of Object.entries(scores)) {
    if (!MODES.has(mode)) continue;
    const rank = Number(entry?.rank);
    const score = Number(entry?.score ?? 0);
    const medalId = entry?.medalId != null && Number.isFinite(Number(entry.medalId)) ? Number(entry.medalId) : null;
    if (!Number.isFinite(rank)) continue;
    stmts.push(env.DB.prepare(
      'INSERT INTO player_medals (player_id, mode, rank, score, medal_id, captured_at) VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(player_id, mode) DO UPDATE SET rank=excluded.rank, score=excluded.score, medal_id=excluded.medal_id, captured_at=excluded.captured_at'
    ).bind(playerId, mode, rank, Number.isFinite(score) ? score : 0, medalId, capturedAt));
  }
  if (!stmts.length) return 0;
  await env.DB.batch(stmts);
  return stmts.length;
}

// ---------------------------------------------------------------
//  直接連遊戲 WebSocket 抓資料（取代原本要開遊戲才會動的 mod）
//  Token 只能查詢該 token 所屬的玩家頻道；排行榜是全服共用，所以一個帳號就夠。
// ---------------------------------------------------------------
function orgName(o) {
  if (o && typeof o === 'object') return String(o.name ?? o.title ?? '');
  return String(o ?? '');
}
function rowsFrom(list) {
  if (!Array.isArray(list)) return [];
  const rows = [];
  list.forEach((p, i) => {
    if (!p || typeof p !== 'object') return;
    const id = String(p.id ?? p.playerId ?? '');
    if (!id && !p.name) return;
    const row = {
      id,
      name: String(p.name ?? ''),
      organization: orgName(p.organization),
      rank: Number(p.rank) > 0 ? Number(p.rank) : i + 1, // 陣列順序就是名次
    };
    if (p.nation_id != null && Number.isFinite(Number(p.nation_id))) row.nationId = Number(p.nation_id);
    rows.push(row);
  });
  return rows;
}
function rankingsFrom(response) {
  if (!response || typeof response !== 'object') return null;
  const modes = {};
  for (const mode of MODE_LIST) {
    const rows = rowsFrom(response[mode]);
    if (rows.length) modes[mode] = rows;
  }
  return Object.keys(modes).length ? modes : null;
}
function medalsFrom(response) {
  if (!response || typeof response !== 'object') return null;
  const scores = {};
  for (const mode of MODE_LIST) {
    const e = response[mode];
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const rank = Number(e.rank);
    if (!Number.isFinite(rank)) continue;
    const score = Number(e.score);
    const medalId = e.medal_id != null && Number.isFinite(Number(e.medal_id)) ? Number(e.medal_id) : null;
    scores[mode] = { rank, score: Number.isFinite(score) ? score : 0, medalId };
  }
  return Object.keys(scores).length ? scores : null;
}

async function pullFromGame(env) {
  const token = String(env.GAME_TOKEN || '').trim();
  const playerId = String(env.GAME_PLAYER_ID || '').trim();
  if (!token || !playerId) throw new Error('GAME_TOKEN / GAME_PLAYER_ID not configured');
  const topic = `player:${playerId}`;
  // Workers 對外連 WebSocket：用 https:// 加 Upgrade header，再取 response.webSocket。
  // token 不做 encodeURIComponent，跟主控台實測成功的網址完全一致。
  const url = `https://api.komisureiya.com/socket/websocket?userToken=${token}&locale=zh_TW&vsn=2.0.0`;
  const headers = { Upgrade: 'websocket' };
  if (env.GAME_ORIGIN) headers.Origin = env.GAME_ORIGIN; // 萬一伺服器檢查 Origin 時才需要設定
  const resp = await fetch(url, { headers });
  const ws = resp.webSocket;
  if (!ws) throw new Error(`websocket upgrade failed: HTTP ${resp.status}`);
  ws.accept();

  return new Promise((resolve, reject) => {
    const result = { playerId, rankings: null, medals: null };
    let done = false;
    let joined = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(1000, 'done'); } catch (_) { /* ignore */ }
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('game websocket timeout')), GAME_WS_TIMEOUT_MS);

    ws.addEventListener('message', (event) => {
      let m;
      try { m = JSON.parse(event.data); } catch (_) { return; }
      // Phoenix V2：[joinRef, ref, topic, event, payload]
      if (!Array.isArray(m) || m.length < 5) return;
      const [, ref, msgTopic, evt, payload] = m;
      if (msgTopic !== topic || evt !== 'phx_reply') return;
      if (payload?.status !== 'ok') return finish(new Error(`request ref=${ref} rejected: ${payload?.status}（token 可能已過期）`));
      if (ref === '1' && !joined) {
        joined = true;
        ws.send(JSON.stringify(['1', '2', topic, 'rankings', {}]));
        ws.send(JSON.stringify(['1', '3', topic, 'medals', {}]));
      } else if (ref === '2') {
        result.rankings = payload.response;
      } else if (ref === '3') {
        result.medals = payload.response;
      }
      if (result.rankings && result.medals) finish();
    });
    ws.addEventListener('close', () => finish(new Error('game websocket closed before all replies arrived')));
    ws.addEventListener('error', () => finish(new Error('game websocket error')));
    ws.send(JSON.stringify(['1', '1', topic, 'phx_join', { fake: 'ChannelPlayer', fake2: 1 }]));
  });
}

async function runPull(env) {
  const { playerId, rankings, medals } = await pullFromGame(env);
  const capturedAt = Date.now();
  const summary = { ok: true, capturedAt, snapshots: null, medalsUpdated: 0 };
  const modes = rankingsFrom(rankings);
  if (modes) summary.snapshots = await storeSnapshots(env, capturedAt, Object.entries(modes));
  else summary.snapshotsError = 'no 1v1/3v3 ranking data in reply';
  const scores = medalsFrom(medals);
  if (scores) summary.medalsUpdated = await storeMedals(env, playerId, scores, capturedAt);
  else summary.medalsError = 'no 1v1/3v3 medals data in reply';
  return summary;
}

export default {
  // Cron Trigger（wrangler.toml 的 [triggers]）：每小時自動抓一次，不需要開遊戲或網站。
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runPull(env).then(
      (summary) => console.log('[pull] ok', JSON.stringify(summary)),
      (error) => console.error('[pull] failed', error?.message || error),
    ));
  },

  async fetch(request, env) {
    // 204 是 null-body status，Response 不能帶 body，否則 Worker 內部直接拋例外。
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });

    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true, service: 'rf-ranking-monitor' }, 200);

    // 手動觸發一次抓取（測試用，需寫入密鑰）
    if (url.pathname === '/api/rankings/pull' && request.method === 'POST') {
      if (!env.RANKING_WRITE_SECRET || request.headers.get('X-RF-Ranking-Secret') !== env.RANKING_WRITE_SECRET) return json({ ok: false, error: 'unauthorized' }, 401);
      try { return json(await runPull(env), 200); }
      catch (error) { return json({ ok: false, error: error.message || 'pull failed' }, 502); }
    }

    if (url.pathname === '/api/rankings/capture' && request.method === 'POST') {
      if (!env.RANKING_WRITE_SECRET || request.headers.get('X-RF-Ranking-Secret') !== env.RANKING_WRITE_SECRET) return json({ ok: false, error: 'unauthorized' }, 401);
      try {
        const body = await readJson(request);
        const capturedAt = Number(body.capturedAt) || Date.now();
        const requested = body.modes && typeof body.modes === 'object'
          ? Object.entries(body.modes)
          : [[String(body.mode || ''), body.entries]];
        const { accepted, skipped } = await storeSnapshots(env, capturedAt, requested);
        if (!accepted.length && !skipped.length) return json({ ok: false, error: 'modes or entries required' }, 400);
        return json({ ok: true, accepted: accepted.length > 0, capturedAt, acceptedModes: accepted, skipped }, 202);
      } catch (error) { return json({ ok: false, error: error.message || 'invalid request' }, 400); }
    }

    if (url.pathname === '/api/rankings/history' && request.method === 'GET') {
      const mode = String(url.searchParams.get('mode') || '1v1');
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 50)));
      if (!MODES.has(mode)) return json({ ok: false, error: 'invalid mode' }, 400);
      const result = await env.DB.prepare('SELECT id, mode, captured_at AS capturedAt, entry_count AS entryCount, payload FROM ranking_snapshots WHERE mode = ?1 ORDER BY captured_at DESC LIMIT ?2').bind(mode, limit).all();
      return json({ ok: true, snapshots: (result.results || []).map((row) => ({ id: row.id, mode: row.mode, capturedAt: row.capturedAt, entryCount: row.entryCount, entries: JSON.parse(row.payload) })) }, 200);
    }

    // 陣營清單幾乎是靜態參照資料（全玩家共用），寫入時直接 upsert，不像排行榜快照要留歷史。
    if (url.pathname === '/api/rankings/nations' && request.method === 'POST') {
      if (!env.RANKING_WRITE_SECRET || request.headers.get('X-RF-Ranking-Secret') !== env.RANKING_WRITE_SECRET) return json({ ok: false, error: 'unauthorized' }, 401);
      try {
        const body = await readJson(request);
        const nations = Array.isArray(body.nations) ? body.nations.slice(0, MAX_NATIONS).map(cleanNation).filter(Boolean) : [];
        if (!nations.length) return json({ ok: false, error: 'nations required' }, 400);
        const now = Date.now();
        const statements = nations.map((n) => env.DB.prepare(
          'INSERT INTO nations (id, name, title, flag, color_icon, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ' +
          'ON CONFLICT(id) DO UPDATE SET name = excluded.name, title = excluded.title, flag = excluded.flag, color_icon = excluded.color_icon, updated_at = excluded.updated_at'
        ).bind(n.id, n.name, n.title, n.flag, n.colorIcon, now));
        await env.DB.batch(statements);
        return json({ ok: true, upserted: nations.length }, 202);
      } catch (error) { return json({ ok: false, error: error.message || 'invalid request' }, 400); }
    }

    if (url.pathname === '/api/rankings/nations' && request.method === 'GET') {
      const result = await env.DB.prepare('SELECT id, name, title, flag, color_icon AS colorIcon FROM nations ORDER BY id ASC').all();
      return json({ ok: true, nations: result.results || [] }, 200);
    }

    // ---- 積分上傳 (POST /api/medals/capture) ----
    if (url.pathname === '/api/medals/capture' && request.method === 'POST') {
      if (!env.RANKING_WRITE_SECRET || request.headers.get('X-RF-Ranking-Secret') !== env.RANKING_WRITE_SECRET) return json({ ok: false, error: 'unauthorized' }, 401);
      let body;
      try { body = await readJson(request); } catch (error) { return json({ ok: false, error: error.message || 'invalid request' }, 400); }
      const playerId = String(body?.playerId || '').trim().slice(0, 80);
      if (!playerId) return json({ ok: false, error: 'missing playerId' }, 400);
      const scores = body?.scores;
      if (!scores || typeof scores !== 'object') return json({ ok: false, error: 'missing scores' }, 400);
      try {
        const updated = await storeMedals(env, playerId, scores, Date.now());
        if (!updated) return json({ ok: false, error: 'no valid modes' }, 400);
        return json({ ok: true, updated }, 202);
      } catch (error) { return json({ ok: false, error: error.message || 'db error' }, 500); }
    }

    // ---- 積分查詢 (GET /api/medals) ----
    // 公開端點，依積分排序；只回傳 playerId 與積分，玩家名稱由前端用 ID 對應排行榜快照。
    if (url.pathname === '/api/medals' && request.method === 'GET') {
      const mode = url.searchParams.get('mode') || '1v1';
      if (!MODES.has(mode)) return json({ ok: false, error: 'invalid mode' }, 400);
      const limit = Math.min(900, Math.max(1, Number(url.searchParams.get('limit') || 100) || 100));
      const offset = Math.max(0, Number(url.searchParams.get('offset') || 0) || 0);
      const q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
      let query = 'SELECT pm.player_id, pm.mode, pm.rank AS medals_rank, pm.score, pm.medal_id, pm.captured_at FROM player_medals pm WHERE pm.mode = ?';
      const params = [mode];
      if (q) {
        const escaped = q.replace(/[\\%_]/g, (c) => '\\' + c);
        query += " AND pm.player_id LIKE ? ESCAPE '\\'";
        params.push(`%${escaped}%`);
      }
      query += ' ORDER BY pm.score DESC, pm.rank ASC LIMIT ? OFFSET ?';
      params.push(limit, offset);
      try {
        const rows = await env.DB.prepare(query).bind(...params).all();
        const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM player_medals WHERE mode = ?').bind(mode).first();
        return json({ ok: true, mode, total: Number(total?.n || 0), limit, offset, entries: (rows.results || []).map((r) => ({ playerId: r.player_id, rank: Number(r.medals_rank), score: Number(r.score), medalId: r.medal_id, capturedAt: Number(r.captured_at) })) }, 200);
      } catch (error) { return json({ ok: false, error: error.message || 'db error' }, 500); }
    }

    return json({ ok: false, error: 'not found' }, 404);
  },
};
