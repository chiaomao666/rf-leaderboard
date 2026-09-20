import './style.css';
import { MODES, normalizedEntries, latestPair, deltaFor, buildNationMap, nationFor } from './ranking.js';

// 公開網站，不再要求使用者手動填 Worker API 位址；直接寫死正式站台。
// 若之後要換 Worker 網域，改這個常數即可。
const DEFAULT_API_ORIGIN = 'https://rf-ranking-monitor-api.chengyen1209.workers.dev';

const state = { mode: '1v1', query: '', snapshots: [], nations: [], loading: false, error: '' };
const app = document.querySelector('#app');

function apiOrigin() {
  // 保留 window.RF_RANKING_API_ORIGIN 這個開發用 override（例如本機測試指向 dev worker），
  // 一般使用者不會碰到，畫面上完全不會有輸入框。
  return (window.RF_RANKING_API_ORIGIN || DEFAULT_API_ORIGIN).replace(/\/$/, '');
}
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function render() {
  const [latest, previous] = latestPair(state.snapshots);
  const current = normalizedEntries(latest);
  const before = normalizedEntries(previous);
  const nationMap = buildNationMap(state.nations);
  const query = state.query.trim().toLowerCase();
  const filtered = current.filter((p) => {
    if (!query) return true;
    const nationName = nationFor(p, nationMap)?.name || '';
    return `${p.id} ${p.name} ${p.organization} ${nationName}`.toLowerCase().includes(query);
  });
  const moved = current.filter((p) => deltaFor(p, before).value !== null && deltaFor(p, before).value !== 0).length;
  const captured = latest ? new Date(Number(latest.capturedAt || latest.createdAt)).toLocaleString() : '尚未載入';
  app.innerHTML = `<main class="shell">
    <header class="topbar"><div><div class="eyebrow">RF RANKING MONITOR</div><h1>排行榜排名變化監控</h1><p class="subtitle">保存整份排行榜快照，追蹤所有玩家的名次升降。</p></div><div class="status"><i class="status-dot ${latest ? 'live' : ''}"></i>${state.loading ? '正在同步…' : state.error ? '同步失敗' : latest ? `最後快照 ${esc(captured)}` : '等待資料'}</div></header>
    <section class="toolbar"><label class="control"><span>排行榜模式</span><select id="mode">${MODES.map((m) => `<option ${m === state.mode ? 'selected' : ''}>${m}</option>`).join('')}</select></label><label class="control"><span>搜尋玩家／聯盟／陣營／ID</span><input id="query" value="${esc(state.query)}" placeholder="輸入關鍵字" /></label><button id="refresh">重新同步</button></section>
    ${state.error ? `<div class="panel empty">${esc(state.error)}</div>` : ''}
    ${state.mode === '5v5' && !state.loading && !state.error ? '<div class="panel empty">5v5 目前沒有已知的官方排行榜資料來源，此分頁可能會持續空白。</div>' : ''}
    <section class="cards"><div class="card"><div class="card-label">目前玩家數</div><div class="card-value">${current.length}</div><div class="card-note">${state.mode} 最新快照</div></div><div class="card"><div class="card-label">排名變動</div><div class="card-value">${moved}</div><div class="card-note">與上一份快照比較</div></div><div class="card"><div class="card-label">上升玩家</div><div class="card-value">${current.filter((p) => deltaFor(p, before).value > 0).length}</div><div class="card-note">名次提高</div></div><div class="card"><div class="card-label">下降玩家</div><div class="card-value">${current.filter((p) => deltaFor(p, before).value < 0).length}</div><div class="card-note">名次降低</div></div></section>
    <section class="panel"><div class="panel-head"><div><h2>${state.mode} 全排行榜</h2><small>${state.snapshots.length} 份快照 · 目前顯示 ${filtered.length} 人</small></div><button class="secondary" id="clear">清除本機快取</button></div><div class="table-wrap">${filtered.length ? `<table><thead><tr><th>目前排名</th><th>變化</th><th>玩家</th><th>陣營</th><th>聯盟／組織</th><th>玩家 ID</th></tr></thead><tbody>${filtered.map((p) => { const d = deltaFor(p, before); const nation = nationFor(p, nationMap); return `<tr><td class="rank">${p.rank}</td><td class="${d.cls}">${d.label}</td><td>${esc(p.name)}</td><td>${esc(nation?.name || '—')}</td><td>${esc(p.organization)}</td><td>${esc(p.id || '—')}</td></tr>`; }).join('')}</tbody></table>` : '<div class="empty">尚無排行榜資料。請確認遊戲端 mod 是否正常運作，並取得一次完整排行榜快照。</div>'}</div></section>
    <footer class="footer">本網站為獨立排行榜監控頁面；快照只由固定的 Worker API 提供，不會向官方伺服器發送請求。</footer>
  </main>`;
  document.querySelector('#mode').onchange = (e) => { state.mode = e.target.value; load(); };
  document.querySelector('#query').oninput = (e) => {
    const cursor = e.target.selectionStart;
    state.query = e.target.value;
    render();
    const next = document.querySelector('#query');
    if (next) { next.focus(); next.setSelectionRange(cursor, cursor); }
  };
  document.querySelector('#refresh').onclick = () => { load(); loadNations(); };
  document.querySelector('#clear').onclick = () => { state.snapshots = []; render(); };
}
async function load() {
  const origin = apiOrigin();
  state.loading = true; state.error = ''; render();
  try {
    const response = await fetch(`${origin}/api/rankings/history?mode=${encodeURIComponent(state.mode)}&limit=50`, { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok || body.ok !== true) throw new Error(body.error || `HTTP ${response.status}`);
    state.snapshots = Array.isArray(body.snapshots) ? body.snapshots : [];
  } catch (error) { state.error = `無法載入排行榜：${error.message}`; }
  finally { state.loading = false; render(); }
}
async function loadNations() {
  // 陣營清單是靜態參照資料，跟排行榜快照分開拿、不影響 loading/error 狀態顯示。
  try {
    const response = await fetch(`${apiOrigin()}/api/rankings/nations`, { cache: 'no-store' });
    const body = await response.json();
    if (response.ok && body.ok === true && Array.isArray(body.nations)) {
      state.nations = body.nations;
      render();
    }
  } catch (error) { console.warn('無法載入陣營清單：', error); }
}
render();
load();
loadNations();
