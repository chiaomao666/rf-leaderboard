export const MODES = ['1v1', '3v3', '5v5'];

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
    // 官方 1v1/3v3/5v5 個人排行榜不會回傳絕對分數，只有名次；不再帶 score 欄位。
  })).filter((p) => p.id || p.name);
}

export function latestPair(snapshots) {
  const sorted = [...(Array.isArray(snapshots) ? snapshots : [])].sort((a, b) => Number(b.capturedAt || b.createdAt || 0) - Number(a.capturedAt || a.createdAt || 0));
  return [sorted[0], sorted[1]];
}

export function deltaFor(player, previousEntries) {
  const before = (previousEntries || []).find((p) => p.id && p.id === player.id);
  if (!before) return { value: null, label: '首次出現', cls: 'delta-same' };
  const value = before.rank - player.rank;
  if (value > 0) return { value, label: `↑ ${value}`, cls: 'delta-up' };
  if (value < 0) return { value, label: `↓ ${Math.abs(value)}`, cls: 'delta-down' };
  return { value: 0, label: '—', cls: 'delta-same' };
}
