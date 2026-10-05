import './style.css';
import { MODES, normalizedEntries, latestPair, deltaFor, rankDelta, nationRanks, buildNationMap, nationFor, HIDDEN_FILTER_NATION_IDS } from './ranking.js';

// 公開網站，不再要求使用者手動填 Worker API 位址；直接寫死正式站台。
// 若之後要換 Worker 網域，改這個常數即可。
const DEFAULT_API_ORIGIN = 'https://rf-ranking-monitor-api.chengyen1209.workers.dev';

const state = { mode: '1v1', query: '', nation: '', sort: 'rank', snapshots: [], nations: [], medals: new Map(), pull: null, sessionTokenUpdatedAt: null, loading: false, error: '' };
const app = document.querySelector('#app');

function apiOrigin() {
  // 保留 window.RF_RANKING_API_ORIGIN 這個開發用 override（例如本機測試指向 dev worker），
  // 一般使用者不會碰到，畫面上完全不會有輸入框。
  return (window.RF_RANKING_API_ORIGIN || DEFAULT_API_ORIGIN).replace(/\/$/, '');
}
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatGap(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '未知';
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 1) return '不到 1 分鐘';
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  return [d ? `${d} 天` : '', h ? `${h} 小時` : '', m ? `${m} 分鐘` : ''].filter(Boolean).join(' ');
}

// 自動抓取狀態（Worker 每小時排程的結果）。token 過期時這裡會直接顯示失敗原因。
const STALE_PULL_MS = 3 * 60 * 60 * 1000;
function pullStatusHtml() {
  const s = state.pull;
  const tokenNote = state.sessionTokenUpdatedAt
    ? ` · 遊戲憑證已更新 ${esc(new Date(state.sessionTokenUpdatedAt).toLocaleString())}`
    : ' · 尚未收到遊戲憑證更新';
  if (!s) return `<div class="pull-status warn">${tokenNote.trim()}</div>`;
  const okAt = s.successAt ? new Date(s.successAt).toLocaleString() : '';
  const accountNote = s.account ? `［${esc(s.account)}］` : '';
  if (!s.ok) return `<div class="pull-status bad">自動抓取失敗${accountNote}：${esc(s.error || '未知錯誤')}${okAt ? `（上次成功 ${esc(okAt)}）` : ''}${tokenNote}</div>`;
  if (Date.now() - s.attemptedAt > STALE_PULL_MS) return `<div class="pull-status warn">自動抓取已超過 3 小時沒有執行（上次 ${esc(new Date(s.attemptedAt).toLocaleString())}）${tokenNote}</div>`;
  return `<div class="pull-status ok">自動抓取正常${accountNote} · 上次成功 ${esc(okAt)}${tokenNote}</div>`;
}

function render() {
  const [latest, previous] = latestPair(state.snapshots);
  const current = normalizedEntries(latest);
  const before = normalizedEntries(previous);
  const nationMap = buildNationMap(state.nations);
  const query = state.query.trim().toLowerCase();
  const filtered = current.filter((p) => {
    if (state.nation !== '' && String(p.nationId) !== state.nation) return false;
    if (!query) return true;
    const nationName = nationFor(p, nationMap)?.name || '';
    return `${p.id} ${p.name} ${p.organization} ${nationName}`.toLowerCase().includes(query);
  });
  if (state.sort === 'score') {
    const scoreOf = (p) => state.medals.get(p.id)?.score;
    filtered.sort((a, b) => {
      const sa = scoreOf(a), sb = scoreOf(b);
      if (sa == null && sb == null) return a.rank - b.rank;
      if (sa == null) return 1;
      if (sb == null) return -1;
      return sb - sa || a.rank - b.rank;
    });
  }
  const scored = current.filter((p) => state.medals.has(p.id)).length;
  const moved = current.filter((p) => deltaFor(p, before).value !== null && deltaFor(p, before).value !== 0).length;
  const latestAt = latest ? Number(latest.capturedAt || latest.createdAt) : 0;
  const previousAt = previous ? Number(previous.capturedAt || previous.createdAt) : 0;
  const previousLabel = previousAt ? new Date(previousAt).toLocaleString() : '';
  const gapText = latestAt && previousAt ? formatGap(latestAt - previousAt) : '';
  const compareNote = previousAt ? `與 ${esc(previousLabel)} 的快照比較（相隔 ${esc(gapText)}）` : '沒有上一份快照可比較';
  const captured = latest ? new Date(Number(latest.capturedAt || latest.createdAt)).toLocaleString() : '尚未載入';
  // 表格欄位：一般模式 7 欄；選了特定陣營時，前面多一欄「陣營排名」，變化欄改成「陣營／全服」兩個變化。
  // 陣營名次一律用完整快照（未經篩選／搜尋）計算，所以搜尋不會讓名次跳動。
  const byNation = state.nation !== '';
  const nationNow = byNation ? nationRanks(current) : null;
  const nationBefore = byNation ? nationRanks(before) : null;
  const shortDelta = (d) => `<span class="${d.cls}">${d.value === null ? '新' : d.label}</span>`;
  const columns = [
    byNation && { th: '陣營排名', td: (p) => `<td class="rank">${nationNow.get(p.id) ?? '—'}</td>` },
    { th: '全服排名', td: (p) => `<td class="rank">${p.rank}</td>` },
    byNation
      ? { th: '陣營／全服排名變化', td: (p) => `<td>${shortDelta(rankDelta(nationBefore.get(p.id), nationNow.get(p.id)))}<span class="delta-sep"> / </span>${shortDelta(deltaFor(p, before))}</td>` }
      : { th: '變化', td: (p) => { const d = deltaFor(p, before); return `<td class="${d.cls}">${d.label}</td>`; } },
    { th: '積分', td: (p) => { const medal = state.medals.get(p.id); return `<td class="score">${medal ? Number(medal.score).toLocaleString() : '—'}</td>`; } },
    { th: '玩家', td: (p) => `<td>${esc(p.name)}</td>` },
    { th: '聯盟／組織', td: (p) => `<td>${esc(p.organization)}</td>` },
    { th: '陣營', td: (p) => `<td>${esc(nationFor(p, nationMap)?.name || '—')}</td>` },
    { th: '玩家 ID', td: (p) => `<td>${esc(p.id || '—')}</td>` },
  ].filter(Boolean);
  app.innerHTML = `<main class="shell">
    <header class="topbar"><div><div class="eyebrow">RF RANKING MONITOR</div><h1>排行榜排名變化監控</h1><p class="subtitle">保存整份排行榜快照，追蹤所有玩家的名次升降。</p></div><div class="status-wrap"><div class="status"><i class="status-dot ${latest ? 'live' : ''}"></i>${state.loading ? '正在同步…' : state.error ? '同步失敗' : latest ? `最後快照 ${esc(captured)}` : '等待資料'}</div>${pullStatusHtml()}</div></header>
    <section class="toolbar"><label class="control"><span>排行榜模式</span><select id="mode">${MODES.map((m) => `<option ${m === state.mode ? 'selected' : ''}>${m}</option>`).join('')}</select></label><label class="control"><span>陣營篩選</span><select id="nation"><option value="">全部陣營</option>${[...nationMap.entries()].filter(([id]) => !HIDDEN_FILTER_NATION_IDS.has(id)).sort((a, b) => a[0] - b[0]).map(([id, n]) => `<option value="${id}" ${String(id) === state.nation ? 'selected' : ''}>${esc(n.name)}</option>`).join('')}</select></label><label class="control"><span>排序方式</span><select id="sort"><option value="rank" ${state.sort === 'rank' ? 'selected' : ''}>依名次</option><option value="score" ${state.sort === 'score' ? 'selected' : ''}>依積分</option></select></label><label class="control"><span>搜尋玩家／聯盟／陣營／ID</span><input id="query" value="${esc(state.query)}" placeholder="輸入關鍵字" /></label><button id="refresh">重新同步</button></section>
    ${state.error ? `<div class="panel empty">${esc(state.error)}</div>` : ''}
    <section class="cards"><div class="card"><div class="card-label">目前玩家數</div><div class="card-value">${current.length}</div><div class="card-note">${state.mode} 最新快照</div></div><div class="card"><div class="card-label">排名變動</div><div class="card-value">${moved}</div><div class="card-note">${compareNote}</div></div><div class="card"><div class="card-label">上升玩家</div><div class="card-value">${current.filter((p) => deltaFor(p, before).value > 0).length}</div><div class="card-note">名次提高</div></div><div class="card"><div class="card-label">下降玩家</div><div class="card-value">${current.filter((p) => deltaFor(p, before).value < 0).length}</div><div class="card-note">名次降低</div></div></section>
    <section class="panel"><div class="panel-head"><div><h2>${state.mode} 全排行榜</h2><small>${state.snapshots.length} 份快照 · ${compareNote} · 目前顯示 ${filtered.length} 人 · 已有積分 ${scored} 人</small></div><button class="secondary" id="clear">清除本機快取</button></div><div class="table-wrap">${filtered.length ? `<table><thead><tr>${columns.map((c) => `<th>${c.th}</th>`).join('')}</tr></thead><tbody>${filtered.map((p) => `<tr>${columns.map((c) => c.td(p)).join('')}</tr>`).join('')}</tbody></table>` : '<div class="empty">尚無排行榜資料。請確認遊戲端 mod 是否正常運作，並取得一次完整排行榜快照。</div>'}</div></section>
    <footer class="footer">本網站為獨立排行榜監控頁面；快照只由固定的 Worker API 提供，不會向官方伺服器發送請求。</footer>
  </main>`;
  document.querySelector('#mode').onchange = (e) => { state.mode = e.target.value; load(); loadMedals(); };
  document.querySelector('#sort').onchange = (e) => { state.sort = e.target.value; render(); };
  document.querySelector('#nation').onchange = (e) => { state.nation = e.target.value; render(); };
  let isComposing = false;
  const queryEl = document.querySelector('#query');
  queryEl.addEventListener('compositionstart', () => { isComposing = true; });
  queryEl.addEventListener('compositionend', (e) => {
    isComposing = false;
    const cursor = e.target.selectionStart;
    state.query = e.target.value;
    render();
    const next = document.querySelector('#query');
    if (next) { next.focus(); next.setSelectionRange(cursor, cursor); }
  });
  queryEl.oninput = (e) => {
    if (isComposing) return; // 注音/倉頡等輸入法組字中，不觸發搜尋
    const cursor = e.target.selectionStart;
    state.query = e.target.value;
    render();
    const next = document.querySelector('#query');
    if (next) { next.focus(); next.setSelectionRange(cursor, cursor); }
  };
  document.querySelector('#refresh').onclick = () => { load(); loadNations(); loadMedals(); loadStatus(); };
  document.querySelector('#clear').onclick = () => { state.snapshots = []; render(); };
}
async function load(silent = false) {
  const origin = apiOrigin();
  if (!silent) { state.loading = true; state.error = ''; render(); }
  try {
    const response = await fetch(`${origin}/api/rankings/history?mode=${encodeURIComponent(state.mode)}&limit=50`, { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok || body.ok !== true) throw new Error(body.error || `HTTP ${response.status}`);
    state.snapshots = Array.isArray(body.snapshots) ? body.snapshots : [];
  } catch (error) { if (!silent) state.error = `無法載入排行榜：${error.message}`; }
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
async function loadStatus() {
  // Worker 排程抓取的結果；失敗不影響排行榜顯示。
  try {
    const response = await fetch(`${apiOrigin()}/api/status`, { cache: 'no-store' });
    const body = await response.json();
    if (response.ok && body.ok === true) {
      state.pull = body.lastPull || null;
      state.sessionTokenUpdatedAt = Number.isFinite(Number(body.sessionTokenUpdatedAt)) ? Number(body.sessionTokenUpdatedAt) : null;
      render();
    }
  } catch (error) { console.warn('無法載入抓取狀態：', error); }
}
async function loadMedals() {
  // 積分只有遊戲端 mod 攔截到的玩家才有，跟排行榜快照分開取；失敗不影響排行榜顯示。
  const mode = state.mode;
  const map = new Map();
  try {
    const pageSize = 900;
    for (let offset = 0; offset < 5400; offset += pageSize) {
      const response = await fetch(`${apiOrigin()}/api/medals?mode=${encodeURIComponent(mode)}&limit=${pageSize}&offset=${offset}`, { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok || body.ok !== true) throw new Error(body.error || `HTTP ${response.status}`);
      const entries = Array.isArray(body.entries) ? body.entries : [];
      for (const e of entries) map.set(String(e.playerId), e);
      if (offset + pageSize >= Number(body.total || 0) || !entries.length) break;
    }
    if (mode !== state.mode) return; // 載入途中使用者已切換模式，丟棄過期結果
    state.medals = map;
    render();
  } catch (error) { console.warn('無法載入積分：', error); }
}
render();
load();
loadNations();
loadMedals();
loadStatus();

// 網站自動更新：每 5 分鐘在背景重新抓一次（快照本身是遊戲端每小時上傳，這裡只是讓畫面跟上）。
// 正在輸入搜尋時不更新，避免輸入框失去焦點。
const AUTO_REFRESH_MS = 5 * 60 * 1000;
setInterval(() => {
  if (document.hidden || state.loading) return;
  if (document.activeElement && document.activeElement.id === 'query') return;
  load(true);
  loadMedals();
  loadStatus();
}, AUTO_REFRESH_MS);
