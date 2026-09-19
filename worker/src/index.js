const MODES = new Set(['1v1', '3v3', '5v5']);
const MAX_ENTRIES = 5000;
const MAX_SNAPSHOTS_PER_MODE = 100;
const MIN_CAPTURE_INTERVAL_MS = 60_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

// 這個 API 有兩種完全不同來源的呼叫者：
//   1. 排行榜網站（https://chiaomao666.github.io）讀取 /api/rankings/history
//   2. 遊戲本體（本機用 file:// 開啟，Origin 是字面上的 "null"）寫入 /api/rankings/capture
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
  return { id: id.slice(0, 80), name, organization, rank: Number(raw.rank) > 0 ? Number(raw.rank) : rank, score };
}
async function readJson(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_BODY_BYTES) throw new Error('payload too large');
  return request.json();
}
async function prune(env, mode) {
  await env.DB.prepare('DELETE FROM ranking_snapshots WHERE mode = ?1 AND id NOT IN (SELECT id FROM ranking_snapshots WHERE mode = ?1 ORDER BY captured_at DESC LIMIT ?2)').bind(mode, MAX_SNAPSHOTS_PER_MODE).run();
}
export default {
  async fetch(request, env) {
    // 204 是 null-body status，Response 不能帶 body，否則 Worker 內部直接拋例外。
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });

    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true, service: 'rf-ranking-monitor' }, 200);
    if (url.pathname === '/api/rankings/capture' && request.method === 'POST') {
      if (!env.RANKING_WRITE_SECRET || request.headers.get('X-RF-Ranking-Secret') !== env.RANKING_WRITE_SECRET) return json({ ok: false, error: 'unauthorized' }, 401);
      try {
        const body = await readJson(request);
        const capturedAt = Number(body.capturedAt) || Date.now();
        const requested = body.modes && typeof body.modes === 'object'
          ? Object.entries(body.modes)
          : [[String(body.mode || ''), body.entries]];
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
        if (!accepted.length && !skipped.length) return json({ ok: false, error: 'modes or entries required' }, 400);
        return json({ ok: true, accepted: accepted.length > 0, capturedAt, acceptedModes: accepted, skipped }, 202);
      } catch (error) { return json({ ok: false, error: error.message || 'invalid request' }, 400); }
    }
    if (url.pathname === '/api/rankings/history' && request.method === 'GET') {
      const mode = String(url.searchParams.get('mode') || '5v5');
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 50)));
      if (!MODES.has(mode)) return json({ ok: false, error: 'invalid mode' }, 400);
      const result = await env.DB.prepare('SELECT id, mode, captured_at AS capturedAt, entry_count AS entryCount, payload FROM ranking_snapshots WHERE mode = ?1 ORDER BY captured_at DESC LIMIT ?2').bind(mode, limit).all();
      return json({ ok: true, snapshots: (result.results || []).map((row) => ({ id: row.id, mode: row.mode, capturedAt: row.capturedAt, entryCount: row.entryCount, entries: JSON.parse(row.payload) })) }, 200);
    }
    return json({ ok: false, error: 'not found' }, 404);
  },
};
