export const MODES = ['1v1', '3v3'];

export function entriesFrom(snapshot) {
  const entries = snapshot?.entries || snapshot?.players || snapshot?.data || [];
  return Array.isArray(entries) ? entries : [];
}

export function normalizedEntries(snapshot) {
  return entriesFrom(snapshot).map((p, index) => ({
    id: String(p.id ?? p.playerId ?? p.user_id ?? ''),
    name: p.name ?? p.nickname ?? p.playerName ?? '未提供名稱',
    organization: typeof (p.organization ?? p.union ?? p.guild) === 'object'
      ? (p.organization ?? p.union ?? p.guild)?.name ?? (p.organization ?? p.union ?? p.guild)?.title ?? '未提供聯盟'
      : p.organization ?? p.union ?? p.guild ?? '未提供聯盟',
    rank: Number(p.rank ?? index + 1),
    nationId: Number.isFinite(Number(p.nationId ?? p.nation_id)) ? Number(p.nationId ?? p.nation_id) : null,
    // 排行榜快照本身只有名次；積分另外從 /api/medals 取得，在 main.js 用玩家 ID 合併。
  })).filter((p) => p.id || p.name);
}

export function latestPair(snapshots) {
  const sorted = [...(Array.isArray(snapshots) ? snapshots : [])].sort((a, b) => Number(b.capturedAt || b.createdAt || 0) - Number(a.capturedAt || a.createdAt || 0));
  return [sorted[0], sorted[1]];
}

// 名次升降：previousRank / currentRank 任一邊沒有（例如上一份快照沒這個人）就視為首次出現。
export function rankDelta(previousRank, currentRank) {
  if (previousRank == null || currentRank == null) return { value: null, label: '首次出現', cls: 'delta-same' };
  const value = previousRank - currentRank;
  if (value > 0) return { value, label: `↑ ${value}`, cls: 'delta-up' };
  if (value < 0) return { value, label: `↓ ${Math.abs(value)}`, cls: 'delta-down' };
  return { value: 0, label: '—', cls: 'delta-same' };
}

export function deltaFor(player, previousEntries) {
  const before = (previousEntries || []).find((p) => p.id && p.id === player.id);
  return rankDelta(before ? before.rank : null, player.rank);
}

// 玩家在自己陣營內的名次：依全服名次由小到大，在同一陣營內依序數 1、2、3…
// 回傳 Map<玩家 ID, 陣營名次>。沒有陣營或沒有 ID 的玩家不會出現在結果裡。
export function nationRanks(entries) {
  const counters = new Map();
  const ranks = new Map();
  for (const p of [...(entries || [])].sort((a, b) => a.rank - b.rank)) {
    if (p.nationId == null || !p.id) continue;
    const next = (counters.get(p.nationId) || 0) + 1;
    counters.set(p.nationId, next);
    ranks.set(p.id, next);
  }
  return ranks;
}

// 不出現在「陣營篩選」下拉選單的陣營 ID：自由勢力（9）沒有玩家隸屬，不需要列出。
export const HIDDEN_FILTER_NATION_IDS = new Set([9]);

// 遊戲陣營靜態清單（nation_id -> 名稱），作為 fallback 備用
// 即使 Worker 沒有回傳陣營資料也能正確顯示
export const STATIC_NATION_MAP = new Map([
  [1,  { name: '紅軍',     flag: '/images/home/flag/bigflag01CM.png' }],
  [2,  { name: '臺灣',     flag: '/images/home/flag/bigflag08TW.png' }],
  [3,  { name: '香港',     flag: '/images/home/flag/bigflag02HK.png' }],
  [4,  { name: '藏國',     flag: '/images/home/flag/bigflag04TB.png' }],
  [5,  { name: '維吾爾',   flag: '/images/home/flag/bigflag06UG.png' }],
  [6,  { name: '哈薩克',   flag: '/images/home/flag/bigflag05KZ.png' }],
  [7,  { name: '滿洲',     flag: '/images/home/flag/bigflag07MC.png' }],
  [8,  { name: '蒙古',     flag: '/images/home/flag/bigflag03MG.png' }],
  [9,  { name: '自由勢力', flag: '/images/home/flag/bigflag00FREE.png' }],
  [10, { name: '反賊聯盟', flag: '/images/home/flag/bigflag09RB01.png' }],
]);

// 陣營清單是全玩家共用的靜態參照資料（id -> 名稱/旗幟），跟排行榜快照分開拿。
export function buildNationMap(nations) {
  // 先用靜態清單初始化，再用動態資料覆蓋（有的話）
  const map = new Map(STATIC_NATION_MAP);
  for (const n of Array.isArray(nations) ? nations : []) {
    const id = Number(n?.id);
    if (!Number.isFinite(id)) continue;
    map.set(id, { name: n.name || n.title || `陣營 ${id}`, title: n.title || '', flag: n.flag || '', colorIcon: n.colorIcon || n.color_icon || '' });
  }
  return map;
}

export function nationFor(player, nationMap) {
  if (player.nationId == null || !nationMap) return null;
  return nationMap.get(player.nationId) || null;
}
