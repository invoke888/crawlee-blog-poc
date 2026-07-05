/* 运维台前端(vanilla JS · 计划书 §8.2)*/
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = async (path, opts) => {
  const r = await fetch(path, opts ? { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } } : undefined);
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw Object.assign(new Error(e.message || `HTTP ${r.status}`), { data: e, status: r.status }); }
  return r.json();
};
const toast = (msg) => { const t = $('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2600); };
/* 时间显示铁律:一律北京时间 UTC+8 · 到秒不截断(2026-07-04 老板拍) */
const pad2 = (n) => String(n).padStart(2, '0');
const bj = (iso) => { const t = Date.parse(iso); if (Number.isNaN(t)) return null; const d = new Date(t + 8 * 3600000); return { y: d.getUTCFullYear(), mo: pad2(d.getUTCMonth() + 1), dd: pad2(d.getUTCDate()), h: pad2(d.getUTCHours()), mi: pad2(d.getUTCMinutes()), s: pad2(d.getUTCSeconds()) }; };
const fmtBJ = (iso) => { if (!iso) return '—'; const p = bj(iso); return p ? `${p.y}-${p.mo}-${p.dd} ${p.h}:${p.mi}:${p.s}` : iso; };
const fmtPub = (iso) => { if (!iso) return '—'; return iso.includes('T') ? fmtBJ(iso) : iso.slice(0, 10); }; // 站方只给日期的不硬造时间
const fmtT = (iso) => { if (!iso) return '—'; const p = bj(iso); return p ? `${p.mo}-${p.dd} ${p.h}:${p.mi}:${p.s}` : iso; };
const fmtD = (iso) => { if (!iso) return '—'; if (!iso.includes('T')) return iso.slice(0, 10); const p = bj(iso); return p ? `${p.y}-${p.mo}-${p.dd}` : iso.slice(0, 10); };
const dur = (s) => s == null ? '—' : s > 90 ? `${Math.floor(s / 60)}m${Math.round(s % 60)}s` : `${Math.round(s)}s`;
const stChip = (st) => ({ ok: '<span class="chip g">ok</span>', running: '<span class="chip y">跑批中</span>', failed: '<span class="chip r">failed</span>', timeout: '<span class="chip y">timeout</span>', crashed: '<span class="chip r">crashed</span>', skipped_overlap: '<span class="chip">skip</span>' }[st] || `<span class="chip">${esc(st)}</span>`);

/* ── 导航 ── */
document.querySelectorAll('aside a[data-p]').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('aside a[data-p]').forEach((x) => x.classList.remove('on'));
  document.querySelectorAll('.page').forEach((x) => x.classList.remove('on'));
  t.classList.add('on');
  $(t.dataset.p).classList.add('on');
  loaders[t.dataset.p]?.();
}));

/* ── 栏底调度状态(六页常驻 · 30s 轮询)── */
let authed = false; // 登录门厅(方案 C):未登录不发数据请求
let schedPaused = false;
async function refreshSched() {
  if (!authed) return;
  try {
    const s = await api('/api/schedule/state');
    schedPaused = !!s.paused;
    $('sched-dot').className = 'dot ' + (s.active ? 'y' : s.paused ? 'gray' : 'g');
    $('sched-label').textContent = s.active ? '批次进行中' : s.paused ? `已暂停${s.paused_at ? ' ' + Math.ceil((Date.now() - Date.parse(s.paused_at)) / 86400000) + '天' : ''}` : '调度运行中';
    const next = s.next_run_at ? Date.parse(s.next_run_at) - Date.now() : null;
    $('sched-next').textContent = s.paused ? '⏸' : next == null ? '…' : next <= 0 ? '即将' : `${String(Math.floor(next / 3600000)).padStart(2, '0')}:${String(Math.floor(next / 60000) % 60).padStart(2, '0')}:${String(Math.floor(next / 1000) % 60).padStart(2, '0')}`;
    $('sched-interval').textContent = `${Math.round(s.interval_ms / 60000)}min`;
    const tickAge = s.last_tick_at ? Date.now() - Date.parse(s.last_tick_at) : null;
    $('sched-heartbeat').textContent = tickAge != null && tickAge > 300000 ? '⚠️ 调度心跳超 5min' : '';
  } catch { $('sched-label').textContent = '连接失败'; }
}
$('sched-toggle').addEventListener('click', async () => {
  try { await api(schedPaused ? '/api/schedule/resume' : '/api/schedule/pause', { method: 'POST' }); toast(schedPaused ? '已恢复调度' : '已暂停调度'); refreshSched(); } catch (e) { toast(e.message); }
});
setInterval(refreshSched, 30000); setInterval(() => refreshSched(), 1000 * 60 * 0 + 1000); // 倒计时秒级刷新走下方
setInterval(() => { const el = $('sched-next'); if (el && !schedPaused) refreshSched; }, 1000);

/* ── 总览 ── */
async function loadOverview() {
  const [sum, runs] = await Promise.all([api('/api/summary'), api('/api/runs?limit=24')]);
  const lr = sum.lastRun || {};
  $('ov-pulse').innerHTML = `
    <span class="st"><span class="dot ${lr.status === 'ok' ? 'g' : lr.status === 'running' ? 'y' : 'r'}"></span> ${lr.status === 'running' ? 'RUN 进行中' : 'RUN ' + esc(lr.status || '—').toUpperCase()}</span>
    <span class="kv">触发<b>${lr.triggered_by === 'manual' ? '👆 手动' : '⏱ 定时'}</b></span>
    <span class="kv">完成时间<b>${fmtT(lr.finished_at)}</b></span>
    <span class="kv">耗时<b>${dur(lr.duration_s)}</b></span>
    <span class="kv">新增<b>+${lr.dataset_added ?? 0}</b></span>
    <span class="kv">失败<b>${lr.requests_failed ?? 0}/${lr.requests_total ?? 0}</b></span>
    <span class="kv">吞吐<b>${lr.rpm_actual ?? '—'} rpm</b></span>`;
  const cells = runs.slice().reverse();
  $('ov-cells').innerHTML = cells.map((r) => {
    const cls = r.status === 'ok' ? '' : r.status === 'timeout' ? 'warn' : r.status === 'skipped_overlap' || r.status === 'queued' ? 'gray' : 'bad';
    return `<div class="cell ${cls}" data-tip="${esc(fmtT(r.started_at))} · ${esc(r.status)} · +${r.dataset_added ?? 0}"></div>`;
  }).join('');
  const red = sum.openAlerts.find((a) => a.severity === 'red')?.c ?? 0;
  const yel = sum.openAlerts.find((a) => a.severity === 'yellow')?.c ?? 0;
  $('nav-alert-n').textContent = red + yel || '';
  $('ov-cards').innerHTML = `
    <div class="card"><div class="lab">今日新增博文</div><div class="v">${sum.todayAdded}</div></div>
    <div class="card"><div class="lab">活跃告警</div><div class="v" style="color:${red ? 'var(--bad)' : 'var(--ink)'}">${red + yel}</div><div class="sub">R${red} · Y${yel}</div></div>
    <div class="card"><div class="lab">有数据源</div><div class="v">${sum.withData}<span style="font-size:13px;color:var(--mute)">/${sum.sourcesTotal}</span></div></div>`;
  const days = sum.daily; const max = Math.max(1, ...days.map((x) => x.s || 0));
  $('ov-spark').innerHTML = days.length > 1 ? `<polyline fill="none" stroke="#8FB8DE" stroke-width="2" points="${days.map((x, i) => `${(i / (days.length - 1)) * 300},${52 - ((x.s || 0) / max) * 48}`).join(' ')}"/>` : '';
  const pmax = Math.max(1, ...sum.pipeToday.map((p) => p.s || 0));
  $('ov-pipes').innerHTML = sum.pipeToday.map((p) => `<div style="display:flex;gap:8px;align-items:center;font-size:12px;margin:6px 0"><span style="width:92px;color:var(--mute)">${esc(p.crawler)}</span><span style="height:11px;border-radius:3px;background:rgba(143,184,222,.35);width:${(p.s / pmax) * 55}%"></span><span>${p.s}</span></div>`).join('') || '<span class="mini">今日暂无</span>';
  $('ov-runs').innerHTML = runs.map((r) => `<tr><td>${esc(r.run_id.slice(4, 20))}${r.batch_type === 'single' ? ` <span class="badge">单源:${esc(r.scope || '')}</span>` : ''}</td><td>${r.triggered_by === 'manual' ? '👆' : '⏱'}</td><td>${fmtT(r.finished_at)}</td><td>${dur(r.duration_s)}</td><td>${r.dataset_added ?? '—'}</td><td>${r.requests_failed ?? '—'}</td><td>${r.rpm_actual ?? '—'}</td><td>${stChip(r.status)}${r.notes ? ` <span class="mini" title="${esc(r.notes)}">ⓘ</span>` : ''}</td></tr>`).join('');
}
$('btn-trigger').addEventListener('click', async () => {
  if (!confirm('立即触发一轮采集批次?')) return;
  $('btn-trigger').disabled = true;
  try { const r = await api('/api/schedule/trigger', { method: 'POST', body: '{}' }); toast(r.message); } catch (e) { toast(e.message); }
  setTimeout(() => { $('btn-trigger').disabled = false; loadOverview(); }, 3000);
});

/* ── 告警 ── */
function alertRow(a, withAck) {
  const cls = a.severity === 'red' ? '' : a.severity === 'yellow' ? 'y' : 'i';
  return `<div class="alertrow ${cls}"><span class="dot ${a.severity === 'red' ? 'r' : a.severity === 'yellow' ? 'y' : 'gray'}"></span>
    <span class="type">${esc(a.type)}</span><span class="sym">${esc(a.base_symbol || '—')}</span>
    <span class="det">${esc(a.detail)} ${a.token_id ? `<a href="#" onclick="openSource(${a.token_id});return false">查看源 ›</a>` : ''}</span>
    <span class="dur">${fmtT(a.created_at)}</span>
    ${withAck ? `<button class="btn" onclick="ackAlert(${a.alert_id})">ack</button>` : `<span class="mini">${esc(a.status)}</span>`}</div>`;
}
async function loadAlerts() {
  const all = await api('/api/alerts?status=all');
  const open = all.filter((a) => a.status === 'open');
  $('al-count').textContent = `(${open.length})`;
  $('al-open').innerHTML = open.map((a) => alertRow(a, true)).join('') || '<p class="mini">🟢 当前无活跃告警</p>';
  $('al-closed').innerHTML = all.filter((a) => a.status !== 'open').slice(0, 50).map((a) => alertRow(a, false)).join('') || '<p class="mini">无</p>';
}
window.ackAlert = async (id) => { try { await api(`/api/alerts/${id}/ack`, { method: 'POST' }); toast('已 ack'); loadAlerts(); } catch (e) { toast(e.message); } };
$('al-more-toggle').addEventListener('click', () => { const el = $('al-closed'); el.style.display = el.style.display === 'none' ? '' : 'none'; });

/* ── 源管理 ── */
let srcCache = [];
async function loadSources() {
  srcCache = await api('/api/sources');
  renderSources();
}
/* 列头排序(2026-07-04 老板拍:id/symbol/最近发布/博文数)· dir 1=asc -1=desc */
let srcSort = { key: '', dir: 1 };
function fdots(s) { // 完整度三点:最近采集 3 条全部有才亮(2026-07-05 老板抓口径 bug 后统一)
  if (!s.articles_total) return '<span class="mini">—</span>';
  const dot = (ok, lab) => `<span class="fdot ${ok ? 'on' : ''}" title="${lab}:最近3条${ok ? '均有' : '有缺'}"></span>`;
  return dot(s.latest_title_ok, '标题') + dot(s.latest_body_ok, '正文') + dot(s.latest_pub_ok, '发布时间');
}
function renderSources() {
  const kw = ($('src-q').value || '').toLowerCase();
  const cr = $('src-crawler').value;
  const af = $('src-alert').value;
  const ff = $('src-fields').value;
  let rows = srcCache.filter((s) => {
    if (kw && !(`${s.base_symbol} ${s.blog_url}`.toLowerCase().includes(kw))) return false;
    if (cr && s.crawler !== cr) return false;
    if (af === 'alert' && !(s.red_alerts + s.yellow_alerts)) return false;
    if (af === 'nodata' && s.last_article_at) return false;
    if (ff === 'no_title' && !(s.articles_total && !s.latest_title_ok)) return false;
    if (ff === 'no_body' && !(s.articles_total && !s.latest_body_ok)) return false;
    if (ff === 'no_pub' && !(s.articles_total && !s.latest_pub_ok)) return false;
    if (ff === 'full' && !(s.latest_title_ok && s.latest_body_ok && s.latest_pub_ok)) return false;
    return true;
  });
  if (srcSort.key) {
    const k = srcSort.key, dir = srcSort.dir;
    rows = rows.slice().sort((a, b) => {
      if (k === 'base_symbol') return dir * String(a[k] || '').localeCompare(String(b[k] || ''));
      if (k === 'latest_pub_at') { // 空值恒沉底
        const av = a[k] || '', bv = b[k] || '';
        if (!av && !bv) return 0; if (!av) return 1; if (!bv) return -1;
        return dir * av.localeCompare(bv);
      }
      return dir * ((Number(a[k]) || 0) - (Number(b[k]) || 0));
    });
  }
  document.querySelectorAll('#p-sources th.sortable').forEach((t) => {
    t.classList.toggle('asc', t.dataset.sort === srcSort.key && srcSort.dir === 1);
    t.classList.toggle('desc', t.dataset.sort === srcSort.key && srcSort.dir === -1);
  });
  $('src-count').textContent = `${rows.length}/${srcCache.length}`;
  $('src-body').innerHTML = rows.slice(0, 400).map((s) => `
    <tr><td><button class="btn" onclick="openSource(${s.token_id})" title="浮窗查看最近博文/错误">打开最近</button></td>
    <td class="mini">${s.token_id}</td><td><b>${esc(s.base_symbol)}</b></td>
    <td><a href="${esc(s.blog_url)}" target="_blank" rel="noopener">${esc(s.blog_url.replace(/^https?:\/\//, '').slice(0, 44))}</a></td>
    <td>${s.crawler ? `<span class="chip">${esc(s.crawler)}</span>` : '—'}</td>
    <td style="white-space:nowrap">${fdots(s)}</td>
    <td>${fmtPub(s.latest_pub_at)}</td>
    <td>${s.articles_total ? `<b>${s.articles_total}</b>` : '<span class="mini">0</span>'}</td>
    <td>${s.added_7d ?? 0}</td>
    <td${s.last_failed && s.last_requests && s.last_failed >= s.last_requests ? ' style="color:var(--bad)"' : ''}>${s.last_failed ?? 0}/${s.last_requests ?? 0}</td>
    <td>${s.red_alerts ? '<span class="dot r"></span>' : ''}${s.yellow_alerts ? '<span class="dot y"></span>' : ''}</td>
    <td><button class="btn" onclick="recrawl(${s.token_id},'${esc(s.base_symbol)}')">重采</button></td></tr>`).join('');
}
['src-q', 'src-crawler', 'src-alert', 'src-fields'].forEach((id) => $(id).addEventListener('input', renderSources));
document.querySelectorAll('#p-sources th.sortable').forEach((t) => t.addEventListener('click', () => {
  const k = t.dataset.sort;
  if (srcSort.key === k) srcSort.dir = -srcSort.dir;
  else srcSort = { key: k, dir: (k === 'latest_pub_at' || k === 'articles_total') ? -1 : 1 };
  renderSources();
}));
window.recrawl = async (tokenId, sym) => {
  if (!confirm(`单独重采 ${sym}?`)) return;
  try { const r = await api(`/api/sources/${tokenId}/recrawl`, { method: 'POST', body: '{}' }); toast(r.message); } catch (e) { toast(e.status === 409 ? '当前有批次在跑,请稍后' : e.message); }
};
/* 源详情浮窗(2026-07-04 老板拍):可拖拽/可调大小/置顶 · 点哪弹哪不用滚动 · 告警"查看源"同入口 */
window.openSource = async (tokenId) => {
  const d = await api(`/api/sources/${tokenId}`);
  const runsAsc = d.runs30.slice().reverse();
  const max = Math.max(1, ...runsAsc.map((r) => r.items_added));
  $('float-title').innerHTML = `${esc(d.source?.base_symbol || '')} <a class="mini" href="${esc(d.source?.blog_url || '#')}" target="_blank" rel="noopener" style="font-weight:400;margin-left:6px">${esc((d.source?.blog_url || '').replace(/^https?:\/\//, '').slice(0, 44))}</a>`;
  $('float-body').innerHTML = `
    <div class="mini">近 30 轮新增</div>
    <div class="bars">${runsAsc.map((r) => `<i title="${esc(fmtT(r.started_at))} +${r.items_added}" style="height:${Math.max(2, (r.items_added / max) * 100)}%"></i>`).join('') || '<span class="mini">无批次</span>'}</div>
    <div class="mini" style="margin:12px 0 4px">最近博文(时间到秒 · 正文前 60 字)</div>
    ${d.articles.map((a) => `<div class="det-sans" style="font-size:12px;margin:7px 0;line-height:1.55">
      <span class="mini" style="margin-right:8px">${fmtPub(a.published_at) !== '—' ? fmtPub(a.published_at) : `采集 ${fmtBJ(a.crawled_at)}`}</span>
      <a href="${esc(a.url)}" target="_blank" rel="noopener">${esc((a.title || a.url).slice(0, 72))}</a>
      ${(a.body_excerpt || a.description) ? `<div class="mini" style="margin-top:1px">${esc(String(a.body_excerpt || a.description).replace(/\s+/g, ' ').slice(0, 60))}…</div>` : ''}</div>`).join('') || '<div class="mini">无</div>'}
    <div class="mini" style="margin:12px 0 4px">最近错误</div>
    ${d.errors.slice(0, 8).map((e) => `<div style="font-size:11.5px;margin:3px 0"><span class="chip ${e.kind.startsWith('http_4') || e.kind === 'cf_challenge' ? 'r' : 'y'}">${esc(e.kind)}</span> <span class="mini">${esc((e.message || '').slice(0, 60))}</span></div>`).join('') || '<div class="mini">无</div>'}
    <div class="mini" style="margin-top:10px">告警史:${d.alerts.length ? d.alerts.slice(0, 3).map((a) => esc(a.type)).join(' · ') : '无'}</div>`;
  $('src-float').hidden = false;
};
(() => { /* 浮窗拖拽(标题栏)· 调大小走原生 resize */
  const f = $('src-float'), h = $('float-head');
  let sx = 0, sy = 0, ox = 0, oy = 0, drag = false;
  h.addEventListener('mousedown', (e) => {
    if (e.target.id === 'float-close') return;
    drag = true; sx = e.clientX; sy = e.clientY;
    const r = f.getBoundingClientRect(); ox = r.left; oy = r.top;
    f.style.right = 'auto'; f.style.left = `${ox}px`; f.style.top = `${oy}px`;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => { if (drag) { f.style.left = `${ox + e.clientX - sx}px`; f.style.top = `${Math.max(0, oy + e.clientY - sy)}px`; } });
  window.addEventListener('mouseup', () => { drag = false; });
  $('float-close').addEventListener('click', () => { f.hidden = true; });
})();

/* ── 博文 ── */
let artPage = 1;
async function loadArticles() {
  const p = new URLSearchParams({ page: artPage });
  if ($('art-q').value) p.set('q', $('art-q').value);
  if ($('art-sym').value) p.set('symbol', $('art-sym').value);
  if ($('art-crawler').value) p.set('crawler', $('art-crawler').value);
  if ($('art-push').value) p.set('push', $('art-push').value);
  if ($('art-fields').value) p.set('fields', $('art-fields').value);
  if ($('art-pub-from').value) p.set('pub_from', $('art-pub-from').value);
  if ($('art-pub-to').value) p.set('pub_to', $('art-pub-to').value);
  const d = await api(`/api/articles?${p}`);
  $('art-count').textContent = `共 ${d.total} 篇`;
  $('art-page').textContent = `${d.page} / ${Math.max(1, Math.ceil(d.total / d.per))}`;
  const pushChip = (a) => a.push_status === 'pushed' ? '<span class="chip g">已推</span>'
    : a.push_status === 'failed' ? `<span class="chip r" title="${esc(a.push_error || '')}">失败</span> <button class="btn" onclick="retryPush('${esc(a.url)}')">重推</button>`
    : a.push_status === 'skipped_backlog' ? `<span class="chip">存量不推</span> <button class="btn" onclick="retryPush('${esc(a.url)}')">推送</button>`
    : `<span class="chip y">未推</span> <button class="btn" onclick="retryPush('${esc(a.url)}')">推送</button>`;
  /* 列序(2026-07-04 老板拍):博客(点击跳博客站)/ 标题 / 正文 / 发布时间 / 采集时间 · 全时间到秒
     2026-07-06 老板拍布局:固定列宽 · 标题30字在上badge在下 · 正文窄 · 时间不换行 · push宽+存量可推 */
  $('art-body').innerHTML = d.rows.map((a) => `<tr>
    <td>${a.blog_url ? `<a href="${esc(a.blog_url)}" target="_blank" rel="noopener"><b>${esc(a.base_symbol)}</b></a>` : `<b>${esc(a.base_symbol)}</b>`}</td>
    <td class="det-sans c-title">${a.shared_count > 1 ? `<span class="badge">共享×${a.shared_count}</span> ` : ''}${a.desc_generic ? '<span class="badge" title="站级通用文案">站级文案</span> ' : ''}${!a.title ? '<span class="badge">缺title</span> ' : ''}${!a.published_at ? '<span class="badge">缺pub</span> ' : ''}<a href="${esc(a.url)}" target="_blank" rel="noopener" title="${esc(a.display_title || a.url)}">${esc((a.display_title || a.url).slice(0, 30))}</a></td>
    <td class="mini det-sans c-body" title="${esc(String(a.body_excerpt || a.display_desc || '').slice(0, 300))}">${esc(String(a.body_excerpt || a.display_desc || '').replace(/\s+/g, ' ').slice(0, 45))}</td>
    <td class="nw">${fmtPub(a.published_at)}</td><td class="nw">${fmtBJ(a.crawled_at)}</td>
    <td><span class="chip">${esc(a.crawler)}</span></td><td class="c-push">${pushChip(a)}</td></tr>`).join('');
}
$('art-search').addEventListener('click', () => { artPage = 1; loadArticles(); });
$('art-prev').addEventListener('click', () => { if (artPage > 1) { artPage -= 1; loadArticles(); } });
$('art-next').addEventListener('click', () => { artPage += 1; loadArticles(); });
window.retryPush = async (url) => {
  try {
    const r = await api('/api/push/retry', { method: 'POST', body: JSON.stringify({ urls: [url] }) });
    toast(r.skipped > 0 && !r.ok ? 'push 未接通(演练跳过 · 设置页配 URL/SECRET 后生效)' : `推送:ok ${r.ok} · fail ${r.failed}`);
    loadArticles();
  } catch (e) { toast(e.message); }
};

/* ── 错误日志 ── */
async function loadErrors() {
  const runs = await api('/api/runs?limit=20');
  $('err-run').innerHTML = '<option value="">近期全部批次</option>' + runs.map((r) => `<option value="${esc(r.run_id)}">${esc(r.run_id.slice(4, 20))}(${r.status})</option>`).join('');
  await searchErrors();
}
async function searchErrors() {
  const p = new URLSearchParams();
  if ($('err-run').value) p.set('run', $('err-run').value);
  if ($('err-kind').value) p.set('kind', $('err-kind').value);
  if ($('err-q').value) p.set('q', $('err-q').value);
  const d = await api(`/api/errors?${p}`);
  $('err-dist').innerHTML = d.dist.slice(0, 6).map((x) => `<div class="card"><div class="lab">${esc(x.kind)}</div><div class="v" style="font-size:19px;color:${x.kind.includes('403') || x.kind === 'cf_challenge' ? 'var(--bad)' : x.kind.includes('429') ? 'var(--warn)' : 'var(--ink)'}">${x.c}</div></div>`).join('') || '<div class="card"><div class="lab">本范围无错误</div><div class="v" style="font-size:19px">0</div></div>';
  $('err-body').innerHTML = d.rows.map((e) => `<tr><td>${fmtT(e.at)}</td><td><b>${esc(e.base_symbol || '—')}</b></td>
    <td><a href="${esc(e.url || '#')}" target="_blank" rel="noopener">${esc((e.url || '').replace(/^https?:\/\//, '').slice(0, 42))}</a></td>
    <td><span class="chip ${e.kind.includes('403') || e.kind.includes('5xx') || e.kind === 'cf_challenge' ? 'r' : e.kind.includes('429') || e.kind === 'timeout' ? 'y' : ''}">${esc(e.kind)}</span></td>
    <td>${e.http_status ?? '—'}${e.retry_after_s ? `<span class="mini" title="retry-after"> ⏲${e.retry_after_s}s</span>` : ''}</td>
    <td class="det-sans mini" title="${esc(e.message || '')}">${esc((e.message || '').slice(0, 52))}</td><td>${e.retries ?? '—'}</td></tr>`).join('') || '<tr><td colspan="7" class="mini">无记录(超 30 天明细已清理)</td></tr>';
}
$('err-search').addEventListener('click', searchErrors);

/* ── 设置 ── */
async function loadSettings() {
  const pools = await api('/api/proxy-config');
  const poolDesc = { main: '主力池 · general 采集 + 通用 RSS 直拉 + mirror', medium: 'medium 生态专用(RSS + slow 队列 medium 域)', slow: '限频域专用(slow 队列)' };
  $('set-proxy').innerHTML = pools.map((p) => `
    <div class="setcard" id="pool-${p.pool}">
      <h3>${p.pool} <span class="mini">${poolDesc[p.pool]}</span> ${p.follows_main ? '<span class="badge">跟随主力池</span>' : ''}</h3>
      <div class="setrow"><span class="k">当前串(脱敏)</span><span>${esc(p.masked || '(未配置)')}</span>
        <button class="btn" onclick="testPool('${p.pool}')">测试连通</button>
        <button class="btn" onclick="editPool('${p.pool}')">编辑</button>
        <span class="mini" id="pool-test-${p.pool}">${p.last_test_at ? `${p.last_test_ok ? '✅' : '❌'} ${fmtT(p.last_test_at)} ${p.last_test_egress_ip ? '出口 ' + esc(p.last_test_egress_ip) : ''} ${p.last_test_latency_ms ? p.last_test_latency_ms + 'ms' : ''}` : ''}</span></div>
      <div class="setrow" id="pool-edit-${p.pool}" style="display:none">
        <span class="k">新连接串</span><input class="wide" id="pool-input-${p.pool}" placeholder="socks5://user:pass@host:port">
        <button class="btn primary" onclick="savePool('${p.pool}',false)">测试并保存</button>
      </div>
    </div>`).join('');
  const cfg = await api('/api/app-config');
  const cats = { schedule: '调度', concurrency: '并发限速', crawl: '采集深度', alerts: '告警阈值', push: 'push' };
  const byCat = {};
  cfg.forEach((c) => { (byCat[c.category] = byCat[c.category] || []).push(c); });
  $('set-config').innerHTML = Object.entries(byCat).map(([cat, items]) => `
    <div class="setcard"><h3>${cats[cat] || cat}</h3>
      ${items.map((c) => `<div class="setrow"><span class="k det-sans">${esc(c.label)} <span class="mini">(${esc(c.key)})</span></span>
        <input id="cfg-${c.key}" value="${esc(c.value)}" ${c.value_type === 'secret' && c.value ? 'placeholder="已配置(输入新值覆盖)" value=""' : ''}>
        <button class="btn" onclick="saveCfg('${c.key}')">保存</button></div>`).join('')}
    </div>`).join('');
  const rv = await api('/api/rules-version');
  $('set-rules').textContent = rv.git_commit || '?';
}
window.testPool = async (pool) => {
  $(`pool-test-${pool}`).textContent = '测试中…';
  try {
    const r = await api(`/api/proxy-config/${pool}/test`, { method: 'POST', body: '{}' });
    $(`pool-test-${pool}`).textContent = r.ok ? `✅ 出口 ${r.ip} · ${r.latencyMs}ms` : r.verdict === 'target_flaky' ? '⚠️ 测试目标不稳(直连也失败)' : `❌ ${r.error || '池不通'}`;
  } catch (e) { $(`pool-test-${pool}`).textContent = `❌ ${e.message}`; }
};
window.editPool = (pool) => { const el = $(`pool-edit-${pool}`); el.style.display = el.style.display === 'none' ? '' : 'none'; };
window.savePool = async (pool, force) => {
  const value = $(`pool-input-${pool}`).value.trim();
  if (!value) { toast('请输入连接串'); return; }
  try {
    const r = await api(`/api/proxy-config/${pool}`, { method: 'PUT', body: JSON.stringify({ value, force }) });
    toast(r.message); loadSettings();
  } catch (e) {
    if (e.data?.error === 'test_failed') {
      if (confirm(`连通测试未通过(${e.data.test?.error || ''})。\n确认仍要保存?(将记入审计)`)) window.savePool(pool, true);
    } else toast(e.message);
  }
};
window.saveCfg = async (key) => {
  try { const r = await api('/api/app-config', { method: 'PUT', body: JSON.stringify({ key, value: $(`cfg-${key}`).value }) }); toast(r.message); } catch (e) { toast(e.message); }
};
$('set-audit-toggle').addEventListener('click', async () => {
  const el = $('set-audit');
  if (el.style.display === 'none') {
    const rows = await api('/api/proxy-config/audit');
    el.innerHTML = `<table><thead><tr><th>时间</th><th>项</th><th>旧</th><th>新</th><th>测试</th><th>IP</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${fmtT(r.at)}</td><td>${esc(r.config_key)}</td><td class="mini">${esc(r.old_value_masked || '')}</td><td class="mini">${esc(r.new_value_masked || '')}</td><td>${esc(r.test_result)}${r.saved_despite_test_failure ? ' <span class="chip r">强存</span>' : ''}</td><td class="mini">${esc(r.client_ip || '')}</td></tr>`).join('')}</tbody></table>`;
    el.style.display = '';
  } else el.style.display = 'none';
});

/* ── 装载表 ── */
const loaders = {
  'p-overview': loadOverview, 'p-alerts': loadAlerts, 'p-sources': loadSources,
  'p-articles': loadArticles, 'p-errors': loadErrors, 'p-settings': loadSettings,
};
setInterval(() => { if (authed && $('p-overview').classList.contains('on')) loadOverview(); }, 60000);

/* ── 登录门厅(方案 C 门厅 · 2026-07-04 老板拍):cookie 会话 · 登录后左侧点亮 ── */
function enter() {
  authed = true;
  document.body.classList.remove('boot', 'locked', 'unlocking');
  refreshSched();
  loadOverview();
}
async function boot() {
  try { await api('/api/me'); enter(); }
  catch {
    document.body.classList.remove('boot');
    document.body.classList.add('locked');
    $('sched-label').textContent = '未登录';
    $('sched-dot').className = 'dot gray';
    $('gate-u').focus();
  }
}
$('gate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const card = e.currentTarget, btn = $('gate-btn');
  card.classList.remove('no'); $('gate-err').hidden = true; btn.disabled = true;
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ user: $('gate-u').value, pass: $('gate-p').value }) });
    btn.textContent = '✓ 进入面板…';
    document.body.classList.remove('locked');
    document.body.classList.add('unlocking'); // 导航依次点亮 + 门厅淡出
    setTimeout(enter, 850);
  } catch (err) {
    btn.disabled = false;
    $('gate-err').textContent = err.message || '账号或密码不对';
    $('gate-err').hidden = false;
    void card.offsetWidth;
    card.classList.add('no');
  }
});
boot();
