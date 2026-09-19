import './style.css';
import { MODES, normalizedEntries, latestPair, deltaFor } from './ranking.js';

const API_KEY = 'rf-ranking-api-origin';
// 遊戲目前只有 1v1/3v3 排行榜介面有對應的官方封包；5v5 沒有實際資料來源，預設不要選它。
const state = { mode: '1v1', query: '', snapshots: [], loading: false, error: '' };
const app = document.querySelector('#app');

function apiOrigin() {
  return (window.RF_RANKING_API_ORIGIN || localStorage.getItem(API_KEY) || '').replace(/\/$/, '');
}
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function render() {
  const [latest, previous] = latestPair(state.snapshots);
  const current = normalizedEntries(latest);
  const before = normalizedEntries(previous);
  const query = state.query.trim().toLowerCase();
  const filtered = current.filter((p) => !query || `${p.id} ${p.name} ${p.organization}`.toLowerCase().includes(query));
  const moved = current.filter((p) => deltaFor(p, before).value !== null && deltaFor(p, before).value !== 0).length;
  const captured = latest ? new Date(Number(latest.capturedAt || latest.createdAt)).toLocaleString() : '尚未載入';
  app.innerHTML = `<main class="shell">
    <header class="topbar"><div><div class="eyebrow">RF RANKING MONITOR</div><h1>排行榜排名變化監控</h1><p class="subtitle">保存整份排行榜快照，追蹤所有玩家的名次升降。</p></div><div class="status"><i class="status-dot ${latest ? 'live' : ''}"></i>${state.loading ? '正在同步…' : state.error ? '同步失敗' : latest ? `最後快照 ${esc(captured)}` : '等待資料'}</div></header>
    <section class="toolbar"><label class="control"><span>排行榜模式</span><select id="mode">${MODES.map((m) => `<option ${m === state.mode ? 'selected' : ''}>${m}</option>`).join('')}</select></label><label class="control"><span>搜尋玩家／聯盟／ID</span><input id="query" value="${esc(state.query)}" placeholder="輸入關鍵字" /></label><label class="control"><span>Worker API 位址</span><input id="api" value="${esc(apiOrigin())}" placeholder="https://…workers.dev" /></label><button id="refresh">重新同步</button></section>
    ${state.error ? `<div class="panel empty">${esc(state.error)}</div>` : ''}
    ${state.mode === '5v5' && !state.loading && !state.error ? '<div class="panel empty">5v5 目前沒有已知的官方排行榜資料來源，此分頁可能會持續空白。</div>' : ''}
    <section class="cards"><div class="card"><div class="card-label">目前玩家數</div><div class="card-value">${current.length}</div><div class="card-note">${state.mode} 最新快照</div></div><div class="card"><div class="card-label">排名變動</div><div class="card-value">${moved}</div><div class="card-note">與上一份快照比較</div></div><div class="card"><div class="card-label">上升玩家</div><div class="card-value">${current.filter((p) => deltaFor(p, before).value > 0).length}</div><div class="card-note">名次提高</div></div><div class="card"><div class="card-label">下降玩家</div><div class="card-value">${current.filter((p) => deltaFor(p, before).value < 0).length}</div><div class="card-note">名次降低</div></div></section>
    <section class="panel"><div class="panel-head"><div><h2>${state.mode} 全排行榜</h2><small>${state.snapshots.length} 份快照 · 目前顯示 ${filtered.length} 人</small></div><button class="secondary" id="clear">清除本機快取</button></div><div class="table-wrap">${filtered.length ? `<table><thead><tr><th>目前排名</th><th>變化</th><th>玩家</th><th>聯盟／組織</th><th>玩家 ID</th></tr></thead><tbody>${filtered.map((p) => { const d = deltaFor(p, before); return `<tr><td class="rank">${p.rank}</td><td class="${d.cls}">${d.label}</td><td>${esc(p.name)}</td><td>${esc(p.organization)}</td><td>${esc(p.id || '—')}</td></tr>`; }).join('')}</tbody></table>` : '<div class="empty">尚無排行榜資料。請確認 Worker API 位址，並讓遊戲端取得一次完整排行榜快照。</div>'}</div></section>
    <footer class="footer">本網站為獨立排行榜監控頁面；快照只由設定的 Worker API 提供，不會向官方伺服器發送請求。</footer>
  </main>`;
  document.querySelector('#mode').onchange = (e) => { state.mode = e.target.value; load(); };
  document.querySelector('#query').oninput = (e) => { state.query = e.target.value; render(); document.querySelector('#query')?.focus(); };
  document.querySelector('#api').onchange = (e) => { localStorage.setItem(API_KEY, e.target.value.trim()); };
  document.querySelector('#refresh').onclick = load;
  document.querySelector('#clear').onclick = () => { state.snapshots = []; render(); };
}
async function load() {
  const origin = apiOrigin();
  if (!origin) { state.error = '請先填入排行榜 Worker API 位址。'; render(); return; }
  state.loading = true; state.error = ''; render();
  try {
    const response = await fetch(`${origin}/api/rankings/history?mode=${encodeURIComponent(state.mode)}&limit=50`, { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok || body.ok !== true) throw new Error(body.error || `HTTP ${response.status}`);
    state.snapshots = Array.isArray(body.snapshots) ? body.snapshots : [];
  } catch (error) { state.error = `無法載入排行榜：${error.message}`; }
  finally { state.loading = false; render(); }
}
render();
if (apiOrigin()) load();
