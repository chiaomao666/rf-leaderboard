const MODES = new Set(['1v1', '3v3']);
const MODE_LIST = ['1v1', '3v3'];
const MAX_ENTRIES = 5000;
const MAX_SNAPSHOTS_PER_MODE = 100;
const MIN_CAPTURE_INTERVAL_MS = 60_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_NATIONS = 64;
const GAME_WS_TIMEOUT_MS = 30_000;
const MAX_GAME_TOKEN_LENGTH = 4096;

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
    // 檢查與寫入在同一個 SQL statement 內完成，避免兩個請求同時通過
    // 時間檢查而插入重複快照。較舊的遲到封包也不應插入。
    const inserted = await env.DB.prepare(
      'INSERT INTO ranking_snapshots (mode, captured_at, entry_count, payload) ' +
      'SELECT ?1, ?2, ?3, ?4 WHERE NOT EXISTS ' +
      '(SELECT 1 FROM ranking_snapshots WHERE mode = ?1 AND captured_at > ?5)'
    ).bind(mode, capturedAt, entries.length, JSON.stringify(entries), capturedAt - MIN_CAPTURE_INTERVAL_MS).run();
    if (Number(inserted.meta?.changes || 0) === 0) {
      const latest = await env.DB.prepare('SELECT captured_at FROM ranking_snapshots WHERE mode = ?1 ORDER BY captured_at DESC LIMIT 1').bind(mode).first();
      skipped.push({ mode, reason: 'rate_limited', nextAllowedAt: Number(latest.captured_at) + MIN_CAPTURE_INTERVAL_MS });
      continue;
    }
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

// 遊戲端登入後回報的短期 token。每個遊戲帳號各自保存一筆，讓排程可以
// 繼續輪替帳號；token 不經由任何 GET API 回傳，也不寫入前端。
async function storeReportedGameToken(env, playerId, token) {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS game_session_tokens (player_id TEXT PRIMARY KEY, token TEXT NOT NULL, updated_at INTEGER NOT NULL)').run();
  await env.DB.prepare('INSERT INTO game_session_tokens (player_id, token, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(player_id) DO UPDATE SET token = excluded.token, updated_at = excluded.updated_at').bind(playerId, token, Date.now()).run();
}

async function readReportedGameToken(env, playerId) {
  try {
    const row = await env.DB.prepare('SELECT token FROM game_session_tokens WHERE player_id = ?1').bind(playerId).first();
    const token = String(row?.token || '').trim();
    return token || null;
  } catch (_) {
    // 尚未有遊戲端回報或舊 D1 尚未建立資料表時，沿用既有 Worker secret。
    return null;
  }
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

// 多帳號設定：GAME_ACCOUNTS 是一段 JSON 陣列字串，例如
//   [{"token":"...","playerId":"832459","label":"帳號A"},{"token":"...","playerId":"111111","label":"帳號B"}]
// 用 `npx wrangler secret put GAME_ACCOUNTS` 貼上整段 JSON（一行）。
// 沒有設定 GAME_ACCOUNTS 的話，fallback 用單一的 GAME_TOKEN / GAME_PLAYER_ID（跟原本一樣）。
function parseAccounts(env) {
  if (env.GAME_ACCOUNTS) {
    try {
      const list = JSON.parse(env.GAME_ACCOUNTS);
      if (Array.isArray(list)) {
        const accounts = list.map((a, i) => ({
          token: String(a?.token || '').trim(),
          playerId: String(a?.playerId ?? a?.player_id ?? '').trim(),
          label: String(a?.label || a?.playerId || `帳號${i + 1}`).slice(0, 40),
        })).filter((a) => a.token && a.playerId);
        if (accounts.length) return accounts;
      }
    } catch (error) { console.error('[accounts] GAME_ACCOUNTS 格式錯誤（需要 JSON 陣列）：', error.message); }
  }
  const token = String(env.GAME_TOKEN || '').trim();
  const playerId = String(env.GAME_PLAYER_ID || '').trim();
  return token && playerId ? [{ token, playerId, label: playerId }] : [];
}

// 多帳號時輪流抓取；驗證失敗時，同次排程繼續下一個帳號，每個帳號最多一次。
// 用 D1 記住下一次該輪到第幾個帳號，重新部署或 Worker 重啟都不會跳號或重置。
async function pickAccount(env) {
  const accounts = parseAccounts(env);
  if (!accounts.length) throw new Error('尚未設定帳號（GAME_TOKEN/GAME_PLAYER_ID 或 GAME_ACCOUNTS）');
  // 本機 mod 會為「各自的 playerId」回報最新 token。排程仍照原定順序
  // 輪替帳號，只在輪到該帳號時覆蓋它自己的舊 token。
  if (accounts.length === 1) {
    const account = accounts[0];
    const reportedToken = await readReportedGameToken(env, account.playerId);
    return { ...account, token: reportedToken || account.token, label: reportedToken ? `${account.label}（自動更新）` : account.label, index: 0, total: 1 };
  }
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS rotation_state (id INTEGER PRIMARY KEY CHECK (id = 1), idx INTEGER NOT NULL)').run();
  const row = await env.DB.prepare('SELECT idx FROM rotation_state WHERE id = 1').first();
  const idx = row ? Number(row.idx) % accounts.length : 0;
  const next = (idx + 1) % accounts.length;
  await env.DB.prepare('INSERT INTO rotation_state (id, idx) VALUES (1, ?1) ON CONFLICT(id) DO UPDATE SET idx = excluded.idx').bind(next).run();
  const account = accounts[idx];
  const reportedToken = await readReportedGameToken(env, account.playerId);
  return { ...account, token: reportedToken || account.token, label: reportedToken ? `${account.label}（自動更新）` : account.label, index: idx, total: accounts.length };
}

async function pullFromGame(env, token, playerId) {
  if (!token || !playerId) throw new Error('缺少帳號 token 或 player id');
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

// 記錄最近一次抓取的結果，讓網站能顯示「自動抓取是否正常」。
// 資料表用 CREATE TABLE IF NOT EXISTS 自動建立，不需要另外跑 migration。
async function recordPull(env, ok, error, account) {
  const now = Date.now();
  try {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS pull_status (id INTEGER PRIMARY KEY CHECK (id = 1), ok INTEGER NOT NULL, attempted_at INTEGER NOT NULL, success_at INTEGER, error TEXT, account TEXT)').run();
    // 給部署在「新增 account 欄位」之前就建立過 pull_status 的舊資料庫補欄位；欄位已存在時會出錯，忽略即可。
    try { await env.DB.prepare('ALTER TABLE pull_status ADD COLUMN account TEXT').run(); } catch (_) { /* 欄位已存在 */ }
    await env.DB.prepare(
      'INSERT INTO pull_status (id, ok, attempted_at, success_at, error, account) VALUES (1, ?1, ?2, ?3, ?4, ?5) ' +
      'ON CONFLICT(id) DO UPDATE SET ok = excluded.ok, attempted_at = excluded.attempted_at, error = excluded.error, account = excluded.account, ' +
      'success_at = CASE WHEN excluded.ok = 1 THEN excluded.attempted_at ELSE pull_status.success_at END'
    ).bind(ok ? 1 : 0, now, ok ? now : null, ok ? null : String(error || 'unknown error').slice(0, 200), account || null).run();
  } catch (e) { console.error('[pull] failed to record status', e?.message || e); }
}

// 抓取 + 記錄結果（排程與手動觸發共用）。
async function runPullAndRecord(env) {
  try {
    const summary = await runPull(env);
    if (summary.snapshotsError) await recordPull(env, false, summary.snapshotsError, summary.account);
    else await recordPull(env, true, null, summary.account);
    return summary;
  } catch (error) {
    await recordPull(env, false, error?.message || error, error?.account || null);
    throw error;
  }
}

// GAME_LOGIN_ACCOUNTS 只存於 Cloudflare secret，按 playerId 對應帳密。
// 每輪最多重新登入各帳號一次；不記錄帳密、token 或官方原始回應。
async function refreshAllGameTokens(env) {
  if (!env.GAME_LOGIN_ACCOUNTS) throw new Error('所有帳號驗證失敗；尚未設定 GAME_LOGIN_ACCOUNTS，無法自動重新登入');
  let credentials;
  try { credentials = JSON.parse(env.GAME_LOGIN_ACCOUNTS); }
  catch (_) { throw new Error('GAME_LOGIN_ACCOUNTS 格式錯誤'); }
  if (!Array.isArray(credentials)) throw new Error('GAME_LOGIN_ACCOUNTS 必須為陣列');
  let refreshed = 0;
  const failed = [];
  for (const account of parseAccounts(env)) {
    const login = credentials.find((entry) => String(entry?.playerId || '') === account.playerId);
    if (!login || typeof login.email !== 'string' || !login.email.trim() || typeof login.password !== 'string' || !login.password) {
      failed.push({ account: account.label, reason: '未設定登入帳密' });
      continue;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch('https://api.komisureiya.com/api/users/log_in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', Accept: 'application/json' },
        body: new URLSearchParams({
          'user[email]': login.email.trim(), 'user[password]': login.password,
          locale: 'zh_TW', app_version: env.GAME_APP_VERSION || '2.28', key: 't9cTpsbSCYcJgsrrC',
        }).toString(),
        signal: controller.signal,
      });
      if (!response.ok) {
        failed.push({ account: account.label, reason: `登入 HTTP ${response.status}` });
        // 限流或官方故障時停止後續登入，交由下一次整點排程再試。
        if (response.status === 429 || response.status >= 500) break;
        continue;
      }
      const body = await response.json();
      const token = body?.data?.user_token;
      if (body?.status !== 'ok' || String(body?.data?.user_id) !== account.playerId
        || typeof token !== 'string' || token.length < 16 || token.length > MAX_GAME_TOKEN_LENGTH) {
        failed.push({ account: account.label, reason: '登入未成功或玩家 ID 不符' });
        continue;
      }
      await storeReportedGameToken(env, account.playerId, token);
      refreshed += 1;
    } catch (_) {
      failed.push({ account: account.label, reason: '登入連線、回應或憑證儲存失敗' });
    } finally { clearTimeout(timeout); }
  }
  if (!refreshed) throw new Error(`所有帳號自動更新憑證失敗：${failed.map((entry) => `${entry.account}：${entry.reason}`).join('；')}`);
  return { refreshed, failed };
}

async function runPull(env, allowRefresh = true) {
  let account = await pickAccount(env);
  let pulled;
  const skippedAccounts = [];
  for (let attempt = 0; attempt < account.total; attempt += 1) {
    try {
      pulled = await pullFromGame(env, account.token, account.playerId);
      break;
    } catch (error) {
      error.account = account.label;
      // 只有明確的驗證拒絕才換帳號；網路、官方限流與服務故障不重試，
      // 避免對同一個服務連續送出沒有幫助的請求。
      const message = String(error?.message || 'pull failed');
      const rejected = /^websocket upgrade failed: HTTP (401|403)$/.test(message)
        || /^request ref=1 rejected:/.test(message);
      if (!rejected) throw error;
      skippedAccounts.push({ account: account.label, reason: message });
      if (attempt + 1 >= account.total) {
        if (allowRefresh) {
          const refresh = await refreshAllGameTokens(env);
          // 一次排程只允許一輪自動登入，避免更新失敗時無限循環。
          const retry = await runPull(env, false);
          return { ...retry, skippedAccounts: [...skippedAccounts, ...retry.skippedAccounts], credentialsRefresh: refresh };
        }
        const exhausted = new Error(`所有 ${account.total} 個帳號驗證失敗，需更新各帳號憑證；最後錯誤：${message}`);
        exhausted.account = account.label;
        throw exhausted;
      }
      account = await pickAccount(env);
    }
  }
  const { playerId, rankings, medals } = pulled;
  const capturedAt = Date.now();
  const summary = { ok: true, capturedAt, account: account.label, accountIndex: account.index, accountTotal: account.total, skippedAccounts, snapshots: null, medalsUpdated: 0 };
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
    ctx.waitUntil(runPullAndRecord(env).then(
      (summary) => console.log('[pull] ok', JSON.stringify(summary)),
      (error) => console.error('[pull] failed', error?.message || error),
    ));
  },

  async fetch(request, env) {
    // 204 是 null-body status，Response 不能帶 body，否則 Worker 內部直接拋例外。
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });

    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true, service: 'rf-ranking-monitor' }, 200);

    // 最近一次自動抓取的結果（公開；只有時間與簡短錯誤原因）
    if (url.pathname === '/api/status' && request.method === 'GET') {
      try {
        const row = await env.DB.prepare('SELECT ok, attempted_at, success_at, error, account FROM pull_status WHERE id = 1').first();
        let sessionTokenUpdatedAt = null;
        try {
          const session = await env.DB.prepare('SELECT MAX(updated_at) AS updated_at FROM game_session_tokens').first();
          if (session?.updated_at != null) sessionTokenUpdatedAt = Number(session.updated_at);
        } catch (_) { /* 尚未由新版遊戲端回報過 token */ }
        return json({ ok: true, lastPull: row ? { ok: Number(row.ok) === 1, attemptedAt: Number(row.attempted_at), successAt: row.success_at == null ? null : Number(row.success_at), error: row.error || '', account: row.account || null } : null, sessionTokenUpdatedAt }, 200);
      } catch (_) { return json({ ok: true, lastPull: null, sessionTokenUpdatedAt: null }, 200); } // 資料表還沒建立（尚未抓取過）
    }

    // 手動觸發一次抓取（測試用，需寫入密鑰）
    if (url.pathname === '/api/rankings/pull' && request.method === 'POST') {
      if (!env.RANKING_WRITE_SECRET || request.headers.get('X-RF-Ranking-Secret') !== env.RANKING_WRITE_SECRET) return json({ ok: false, error: 'unauthorized' }, 401);
      try { return json(await runPullAndRecord(env), 200); }
      catch (error) { return json({ ok: false, error: error.message || 'pull failed' }, 502); }
    }

    // 遊戲本機 mod 在官方 WebSocket 建立時回報當次短期 token。和既有的
    // /capture 共用寫入密鑰，token 永遠不會在公開讀取 API 或網站顯示。
    if (url.pathname === '/api/rankings/session-token' && request.method === 'POST') {
      if (!env.RANKING_WRITE_SECRET || request.headers.get('X-RF-Ranking-Secret') !== env.RANKING_WRITE_SECRET) return json({ ok: false, error: 'unauthorized' }, 401);
      try {
        const body = await readJson(request);
        const token = typeof body?.token === 'string' ? body.token.trim() : '';
        const playerId = typeof body?.playerId === 'string' || typeof body?.playerId === 'number' ? String(body.playerId).trim() : '';
        if (token.length < 16 || token.length > MAX_GAME_TOKEN_LENGTH || !/^\d{1,80}$/.test(playerId)) return json({ ok: false, error: 'invalid token report' }, 400);
        await storeReportedGameToken(env, playerId, token);
        return json({ ok: true, updatedAt: Date.now() }, 202);
      } catch (error) { return json({ ok: false, error: error.message || 'invalid request' }, 400); }
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
      const result = await env.DB.prepare('SELECT id, mode, captured_at AS capturedAt, entry_count AS entryCount, payload FROM ranking_snapshots WHERE mode = ?1 ORDER BY captured_at DESC, id DESC LIMIT ?2').bind(mode, MAX_SNAPSHOTS_PER_MODE).all();
      // 舊版曾並行寫入相隔幾毫秒的相同資料；讀取時略過重複副本，
      // 保留 D1 原始歷史。整點捕捉的相同榜單仍各自保留。
      const unique = [];
      for (const row of result.results || []) {
        const previous = unique[unique.length - 1];
        if (previous && Number(previous.capturedAt) - Number(row.capturedAt) < MIN_CAPTURE_INTERVAL_MS && previous.payload === row.payload) continue;
        unique.push(row);
      }
      return json({ ok: true, snapshots: unique.slice(0, limit).map((row) => ({ id: row.id, mode: row.mode, capturedAt: row.capturedAt, entryCount: row.entryCount, entries: JSON.parse(row.payload) })) }, 200);
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
