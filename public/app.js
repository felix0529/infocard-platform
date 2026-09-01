/* =====================================================
   fj_id_card 身份信息管理 — 前端逻辑 v2
   - 分页（服务端 page / pageSize）
   - 搜索 / 筛选（服务端 q / relation / nomobile）
   - 新增表单 100% 重置（派生面板/校验/关系默认）
   - 统一固定行高，移除 ID 副行与顶部统计条
   - 关系标签字体更紧凑 + 自定义关系（localStorage）
   ===================================================== */
'use strict';

const API = {
  list: (q) => {
    const url = new URL('/api/id-cards', location.origin);
    Object.entries(q || {}).forEach(([k, v]) => {
      if (v == null || v === '' || v === false) return;
      url.searchParams.set(k, String(v));
    });
    return fetch(url.toString()).then(r => r.json());
  },
  create: (payload) => fetch('/api/id-cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(r => r.json()),
  importCards: (items) => fetch('/api/id-cards/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items })
  }).then(r => r.json()),
  update: (id, payload) => fetch(`/api/id-cards/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(r => r.json()),
  remove: (id) => fetch(`/api/id-cards/${id}`, { method: 'DELETE' }).then(r => r.json()),
  detail: (id) => fetch(`/api/id-cards/${id}/detail`).then(r => r.json()),
  stats: (q) => {
    const params = q || {};
    const url = new URL('/api/id-cards/stats', location.origin);
    Object.entries(params).forEach(([k, v]) => {
      if (v == null || v === '' || v === false) return;
      url.searchParams.set(k, String(v));
    });
    return fetch(url.toString()).then(r => r.json());
  },
  getRelations: () => fetch('/api/relations').then(r => r.json()),
  createRelation: (label) => fetch('/api/relations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label })
  }).then(r => r.json()),
  deleteRelation: (value, reassignTo) => {
    const qs = reassignTo != null ? ('?reassignTo=' + encodeURIComponent(String(reassignTo))) : '';
    return fetch('/api/relations/' + encodeURIComponent(String(value)) + qs, { method: 'DELETE' }).then(r => r.json());
  }
};

// ---------- 关系字典（单一数据源：从后端 /api/relations 拉取，全局共享、跨设备同步） ----------
// 启动后由 loadRelations() 填充 window.FJ_RELATIONS；旧版浏览器本地自定义关系在首次启动时迁移到云端。
let FJ_RELATIONS = [
  // 兜底：拉取失败时使用默认内置，保证列表/表单仍可用
  { value: 0, label: '亲属', is_builtin: true, sort: 0 },
  { value: 1, label: '朋友', is_builtin: true, sort: 1 },
  { value: 2, label: '同事(瑞联)', is_builtin: true, sort: 2 },
  { value: 3, label: '同事(优品)', is_builtin: true, sort: 3 },
  { value: 4, label: '同事(大自然)', is_builtin: true, sort: 4 },
  { value: 5, label: '同事(财税)', is_builtin: true, sort: 5 }
];
window.FJ_RELATIONS = FJ_RELATIONS;
const CUSTOM_MAX = 6;
const CUSTOM_REL_KEY = 'fj_id_card.custom_relations'; // 仅用于一次性迁移，迁移后清除

function getAllRelations() { return FJ_RELATIONS; }
function relationLabel(v) {
  if (v == null) return '无关系';
  const r = FJ_RELATIONS.find(x => x.value === Number(v));
  return r ? r.label : ('关系' + v);
}
function relationIsCustom(v) {
  const r = FJ_RELATIONS.find(x => x.value === Number(v));
  return !!(r && !r.is_builtin);
}
const REL_TAG = (v) => {
  if (v == null) return 'tag-null';
  if (relationIsCustom(v)) return 'tag-custom';
  return `tag-${Number(v)}`;
};

// 从云端拉取关系字典，填充 FJ_RELATIONS 并重建依赖 UI；首次成功时迁移本地旧自定义关系
async function loadRelations() {
  try {
    const res = await API.getRelations();
    if (!res || !res.ok || !Array.isArray(res.data)) return;
    FJ_RELATIONS = res.data.map(r => ({ value: r.value, label: r.label, is_builtin: !!r.is_builtin, sort: r.sort }));
    window.FJ_RELATIONS = FJ_RELATIONS;
    await migrateLocalRelations();
    buildRelationRadios();
    renderFilters();
    if (window.__refreshDashboardRelations) window.__refreshDashboardRelations();
  } catch (e) {
    console.warn('[relations] 拉取失败，使用兜底内置', e);
  }
}
// 一次性迁移：把本机旧自定义关系（localStorage）上传到云端（按名称去重），随后清除本地键
async function migrateLocalRelations() {
  try {
    const raw = localStorage.getItem(CUSTOM_REL_KEY);
    if (!raw) return;
    const local = JSON.parse(raw);
    if (!Array.isArray(local) || !local.length) { localStorage.removeItem(CUSTOM_REL_KEY); return; }
    const cloudLabels = new Set(FJ_RELATIONS.map(r => r.label));
    for (const c of local) {
      const label = c && c.label ? String(c.label).trim() : '';
      if (label && !cloudLabels.has(label)) await API.createRelation(label).catch(() => {});
    }
    localStorage.removeItem(CUSTOM_REL_KEY);
  } catch {}
}

// ---------- 分页 & 筛选状态 ----------
// 关系 chip 与 待补手机号 chip 可同时选中：
//   relationFilter: null（无关系筛选） | 'r0' | 'r1' | ... | 'rnull'（无关系）
//   nomobileFilter: 是否勾选「待补手机号」
const state = {
  page: 1,
  pageSize: 20,
  total: 0,
  totalPages: 1,
  rows: [],
  q: '',
  relationFilter: null,
  nomobileFilter: false,
  stats: { total: 0, noMobile: 0, byRelation: {} }
};

let editingId = null;
let deleteTargetId = null;

const $ = (sel) => document.querySelector(sel);
const els = {
  tbody: $('#tbody'), empty: $('#emptyState'), emptySub: $('#emptySub'),
  countText: $('#countText'), search: $('#searchInput'), filters: $('#filters'),
  pager: $('#pager'), pageSizeSel: $('#pageSize'),
  drawer: $('#drawer'), drawerOverlay: $('#drawerOverlay'), drawerTitle: $('#drawerTitle'),
  form: $('#idForm'), fName: $('#fName'), fCardNo: $('#fCardNo'), fMobile: $('#fMobile'), fRemark: $('#fRemark'),
  derive: $('#derivePanel'), dRegion: $('#dRegion'), dBirth: $('#dBirth'), dGender: $('#dGender'),
  relationRadios: $('#relationRadios'), btnSubmit: $('#btnSubmit'),
  btnCancel: $('#btnCancel'), btnDrawerClose: $('#btnDrawerClose'),
  btnAddRelation: $('#btnAddRelation'),
  delDialog: $('#delDialog'), delOverlay: $('#delOverlay'), delTitle: $('#delTitle'), delSub: $('#delSub'),
  btnDelConfirm: $('#btnDelConfirm'), btnDelCancel: $('#btnDelCancel'),
  relDialog: $('#relDialog'), relOverlay: $('#relOverlay'),
  fCustomRelLabel: $('#fCustomRelLabel'), customRelErr: $('#customRelErr'),
  btnRelClose: $('#btnRelClose'), btnRelCancel: $('#btnRelCancel'), btnRelConfirm: $('#btnRelConfirm'),
  relList: $('#relList'),
  relReassignDialog: $('#relReassignDialog'), relReassignOverlay: $('#relReassignOverlay'),
  relReassignSub: $('#relReassignSub'), relReassignTarget: $('#relReassignTarget'),
  btnRelReassignCancel: $('#btnRelReassignCancel'), btnRelReassignConfirm: $('#btnRelReassignConfirm'),
  detailDialog: $('#detailDialog'), detailOverlay: $('#detailOverlay'), btnDetailClose: $('#btnDetailClose'), btnDetailCancel: $('#btnDetailCancel'),
  detailBody: $('#detailBody'),
  btnImport: $('#btnImport'), importDialog: $('#importDialog'), importOverlay: $('#importOverlay'),
  btnImportClose: $('#btnImportClose'), btnImportCancel: $('#btnImportCancel'), btnImportSubmit: $('#btnImportSubmit'),
  importDrop: $('#importDrop'), importFile: $('#importFile'), importFileName: $('#importFileName'),
  importErr: $('#importErr'), importErr2: $('#importErr2'), importResult: $('#importResult'),
  btnDownloadTemplate: $('#btnDownloadTemplate'),
  toast: $('#toast'), btnRefresh: $('#btnRefresh'), btnAdd: $('#btnAdd')
};

// ---------- Toast ----------
let toastTimer = null;
function toast(msg, type = 'success') {
  els.toast.textContent = msg;
  els.toast.className = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2600);
}

// ---------- 派生展示 ----------
function parseCard(raw) {
  const cardNo = String(raw || '').trim();
  if (/^\d{17}[\dXx]$/.test(cardNo)) {
    return {
      region: regionName(cardNo.slice(0, 6)),
      birth: `${cardNo.slice(6, 10)}-${cardNo.slice(10, 12)}-${cardNo.slice(12, 14)}`,
      gender: Number(cardNo[16]) % 2 === 1 ? 1 : 0,
      len: 18
    };
  }
  if (/^\d{15}$/.test(cardNo)) {
    return {
      region: regionName(cardNo.slice(0, 6)),
      birth: `19${cardNo.slice(6, 8)}-${cardNo.slice(8, 10)}-${cardNo.slice(10, 12)}`,
      gender: Number(cardNo[14]) % 2 === 1 ? 1 : 0,
      len: 15
    };
  }
  return null;
}
const REGION = {
  '11':'北京市','12':'天津市','13':'河北省','14':'山西省','15':'内蒙古自治区','21':'辽宁省','22':'吉林省','23':'黑龙江省','31':'上海市','32':'江苏省','33':'浙江省','34':'安徽省','35':'福建省','36':'江西省','37':'山东省','41':'河南省','42':'湖北省','43':'湖南省','44':'广东省','45':'广西壮族自治区','46':'海南省','50':'重庆市','51':'四川省','52':'贵州省','53':'云南省','54':'西藏自治区','61':'陕西省','62':'甘肃省','63':'青海省','64':'宁夏回族自治区','65':'新疆维吾尔自治区','71':'台湾省','81':'香港特别行政区','82':'澳门特别行政区'
};
function regionName(code) {
  if (REGION[code]) return REGION[code];
  if (code && REGION[code.slice(0, 2)]) return REGION[code.slice(0, 2)];
  return '未知地区';
}

function maskCard(cardNo) {
  const c = String(cardNo || '');
  if (c.length < 8) return c;
  return c.slice(0, 4) + ' •••••••• ' + c.slice(-4);
}
function initials(name) {
  return String(name || '?').slice(0, 1).toUpperCase();
}
function displayBirth(r) {
  if (r.birth && r.birth !== '—') return r.birth;
  const p = parseCard(r.card_no);
  return p ? p.birth : '—';
}
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------- 渲染：分页器 ----------
function renderPager() {
  const { page, totalPages } = state;
  const buttons = [];
  const push = (label, target, opts = {}) => {
    const cls = ['page-btn'];
    if (opts.active) cls.push('active');
    const disabled = opts.disabled ? 'disabled' : '';
    const targetAttr = target == null ? '' : `data-page="${target}"`;
    buttons.push(`<button class="${cls.join(' ')}" ${disabled} ${targetAttr}>${label}</button>`);
  };
  push('‹', Math.max(1, page - 1), { disabled: page === 1 });
  const pushPage = (p) => push(String(p), p, { active: p === page });

  const window = [];
  window.push(1);
  for (let i = page - 1; i <= page + 1; i++) if (i > 1 && i < totalPages) window.push(i);
  if (totalPages > 1) window.push(totalPages);
  const windows = [...new Set(window)].sort((a, b) => a - b);

  let last = 0;
  for (const p of windows) {
    if (p - last > 1) buttons.push(`<span class="page-ellipsis">…</span>`);
    pushPage(p);
    last = p;
  }
  push('›', Math.min(totalPages, page + 1), { disabled: page === totalPages });
  els.pager.innerHTML = buttons.join('');
}

// ---------- 渲染：表格 ----------
function rowHtml(r) {
  const genderTag = r.gender_code == null
    ? `<span class="gender-tag none">—</span>`
    : `<span class="gender-tag ${r.gender_code === 1 ? 'male' : 'female'}">${r.gender_name}</span>`;
  const avatarCls = r.gender_code == null ? 'none' : (r.gender_code === 1 ? 'male' : 'female');
  const hasMobile = r.mobile && r.mobile.trim();
  const mobileHtml = hasMobile
    ? `<span class="phone" title="手机号">${escapeHtml(hasMobile)}</span>`
    : `<span class="phone empty">—</span>`;
  const relVal = r.relation == null ? 'null' : String(r.relation);
  const birth = displayBirth(r);
  // 户籍地区显示到区：拼接省市区；缺失时回退到 region_name
  function regionCell(row) {
    const parts = [row.reg_province, row.reg_city, row.reg_district].filter(v => v && String(v).trim());
    const full = parts.length ? parts.join('') : row.region_name;
    // 列宽有限会被省略号截断，加 title 支持鼠标悬停查看完整户籍地址
    return full ? `<span class="region" title="${escapeHtml(full)}">${escapeHtml(full)}</span>` : '—';
  }

  return `
    <tr data-id="${r.id}">
      <td>
        <div class="name-cell">
          <span class="avatar ${avatarCls}">${initials(r.name)}</span>
          <span class="name-main" title="${escapeHtml(r.name || '')}">${escapeHtml(r.name) || '—'}</span>
        </div>
      </td>
      <td class="col-gender">${genderTag}</td>
      <td><span class="mono">${maskCard(r.card_no)}</span></td>
      <td><span class="birth">${birth}</span></td>
      <td>${regionCell(r)}</td>
      <td>${mobileHtml}</td>
      <td><span class="tag ${REL_TAG(relVal)}" title="${escapeHtml(r.relation_label || '其他')}">${escapeHtml(r.relation_label || '其他')}</span></td>
      <td>${r.hasRecord
        ? `<span class="has-record yes">是</span>`
        : `<span class="has-record no">否</span>`}</td>
      <td>
        <div class="row-actions">
          <button class="row-btn view" data-action="view" title="查看详情" aria-label="查看详情">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
          ${canEditList() ? `
          <button class="row-btn edit" data-action="edit" title="编辑" aria-label="编辑">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
          </button>
          <button class="row-btn del" data-action="remove" title="删除" aria-label="删除">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
          </button>` : ''}
        </div>
      </td>
    </tr>`;
}

// 是否有权维护人员档案（新增/编辑/删除）
function canEditList() {
  return !window.APP_AUTH || window.APP_AUTH.canEditList();
}

function renderTable() {
  const { rows, total, page, pageSize, totalPages } = state;
  els.countText.textContent = `共 ${total.toLocaleString()} 条 · 第 ${page}/${totalPages} 页 · 每页 ${pageSize} 条`;
  if (!rows.length) {
    els.tbody.innerHTML = '';
    els.empty.hidden = false;
    const hasFilterOrQuery = state.relationFilter || state.nomobileFilter || state.q.trim();
    els.emptySub.textContent = hasFilterOrQuery
      ? '试试调整筛选或搜索关键词。'
      : '还没有档案，点击右上角「新增身份」。';
    els.pager.innerHTML = '';
    return;
  }
  els.empty.hidden = true;
  els.tbody.innerHTML = rows.map(rowHtml).join('');
  renderPager();
}

function showSkeleton() {
  const rows = Array.from({ length: Math.min(5, state.pageSize) }, () =>
    `<tr class="skeleton">
      <td><div class="skeleton-bar" style="width:60%"></div></td>
      <td><div class="skeleton-bar" style="width:40%"></div></td>
      <td><div class="skeleton-bar" style="width:80%"></div></td>
      <td><div class="skeleton-bar" style="width:70%"></div></td>
      <td><div class="skeleton-bar" style="width:60%"></div></td>
      <td><div class="skeleton-bar" style="width:70%"></div></td>
      <td><div class="skeleton-bar" style="width:50%"></div></td>
      <td><div class="skeleton-bar" style="width:50%"></div></td>
      <td></td>
    </tr>`
  ).join('');
  els.tbody.innerHTML = rows;
}

// ---------- 加载 ----------
async function load(resetPage = false) {
  if (resetPage) state.page = 1;
  showSkeleton();
  const params = {
    page: state.page,
    pageSize: state.pageSize,
    q: state.q || undefined
  };
  // 关系 chip 与 待补手机号 chip 可同时生效：分别传 relation / nomobile
  if (state.nomobileFilter) params.nomobile = '1';
  if (state.relationFilter) params.relation = state.relationFilter.slice(1);
  try {
    const [res, statsRes] = await Promise.all([
      API.list(params),
      API.stats(params).catch(() => null)
    ]);
    if (!res.ok) throw new Error(res.message || '加载失败');
    state.rows = res.data || [];
    state.total = Number(res.total || 0);
    state.totalPages = Number(res.totalPages || 1);
    state.page = Number(res.page || state.page);
    state.pageSize = Number(res.pageSize || state.pageSize);
    if (statsRes && statsRes.ok) {
      state.stats = {
        total: Number(statsRes.total || 0),
        noMobile: Number(statsRes.noMobile || 0),
        byRelation: statsRes.byRelation || {}
      };
      renderFilters();
    }
    if (state.page > state.totalPages && state.totalPages > 0) {
      state.page = state.totalPages;
      return load(false);
    }
    renderTable();
  } catch (e) {
    state.rows = [];
    state.total = 0; state.totalPages = 1;
    renderTable();
    els.empty.hidden = false;
    els.emptySub.textContent = '无法连接后端服务，请确认服务已启动。';
    toast(e.message || '数据加载失败', 'error');
  }
}

// ---------- 筛选 chips ----------
function buildFiltersMeta() {
  // 关系标签（内置 + 自定义）按 fj_id_card_relation.sort 字段升序排列，统一从云端字典 FJ_RELATIONS 取
  const relChips = getAllRelations()
    .map(r => ({ key: 'r' + (r.value == null ? 'null' : String(r.value)), label: r.label, custom: !r.is_builtin, sort: r.sort }))
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  return [
    { key: 'all', label: '全部' },
    { key: 'rnull', label: '无关系' },
    ...relChips,
    { key: 'nomobile', label: '待补手机号' }
  ];
}
function renderFilters() {
  const meta = buildFiltersMeta();
  const s = state.stats;
  // 关系 chip 与 待补手机号 chip 可同时为 active；只有「全部」在两者皆空时 active
  const hasAnyFilter = !!state.relationFilter || state.nomobileFilter;
  els.filters.innerHTML = meta.map(f => {
    let active = '';
    if (f.key === 'all') active = hasAnyFilter ? '' : 'active';
    else if (f.key === 'nomobile') active = state.nomobileFilter ? 'active' : '';
    else active = state.relationFilter === f.key ? 'active' : '';
    // 统计数统一千分位格式化
    let count = '';
    if (f.key === 'all') count = s.total != null ? Number(s.total).toLocaleString() : '';
    else if (f.key === 'nomobile') count = s.noMobile != null ? Number(s.noMobile).toLocaleString() : '';
    const showCount = count !== '';
    const title = showCount ? `${escapeHtml(f.label)}：${count} 条` : escapeHtml(f.label);
    const countHtml = showCount ? `<span class="chip-count">${count}</span>` : '';
    return `<button class="chip ${active}" role="tab" data-key="${f.key}" title="${title}">${escapeHtml(f.label)} ${countHtml}</button>`;
  }).join('');
}

// ---------- 表单：重置/打开 ----------
function buildRelationRadios() {
  // 表单单选额外提供「无关系」默认项（不进字典表）；其余从云端字典动态生成
  const items = [{ value: null, label: '无关系', is_builtin: true }, ...getAllRelations()];
  els.relationRadios.innerHTML = items.map(r => {
    const val = r.value == null ? 'null' : String(r.value);
    const extra = (!r.is_builtin && r.value != null) ? ' custom' : '';
    return `<label class="rel-opt${extra}" title="${escapeHtml(r.label)}"><input type="radio" name="relation" value="${val}">${escapeHtml(r.label)}</label>`;
  }).join('');
}
function setRelationChecked(v) {
  const val = v == null ? 'null' : String(v);
  // 若关系值不存在当前列表（自定义关系被清了），先不选中，或选 null
  const input = els.relationRadios.querySelector(`input[value="${val}"]`)
    || els.relationRadios.querySelector('input[value="null"]');
  if (input) input.checked = true;
}
function resetRelationToDefault() {
  // 默认选「其他」
  const input = els.relationRadios.querySelector('input[value="null"]');
  if (input) input.checked = true;
  else if (els.relationRadios.firstElementChild?.firstElementChild) els.relationRadios.firstElementChild.firstElementChild.checked = true;
}

function updateDerive() {
  const p = parseCard(els.fCardNo.value);
  if (!p) { els.derive.hidden = true; return; }
  els.derive.hidden = false;
  els.dRegion.textContent = p.region;
  els.dBirth.textContent = p.birth;
  els.dGender.textContent = p.gender === 1 ? '男' : '女';
}

function openCreate() {
  editingId = null;
  els.drawerTitle.textContent = '新增身份档案';
  els.btnSubmit.textContent = '保存档案';
  clearErrors();
  // 全部字段显式清空（属性 + DOM 属性双重清）
  els.fName.value = '';
  els.fCardNo.value = '';
  els.fMobile.value = '';
  els.fRemark.value = '';
  resetRelationToDefault();
  // 强制清空派生面板，不依赖 parseCard 返回 null
  els.dRegion.textContent = '—';
  els.dBirth.textContent = '—';
  els.dGender.textContent = '—';
  els.derive.hidden = true;
  els.drawer.hidden = false;
  els.drawerOverlay.hidden = false;
  document.body.style.overflow = 'hidden';
  setTimeout(() => els.fName.focus(), 80);
}

function openEdit(row) {
  editingId = row.id;
  els.drawerTitle.textContent = `编辑 · ${row.name}`;
  els.btnSubmit.textContent = '保存修改';
  clearErrors();
  els.fName.value = row.name || '';
  els.fCardNo.value = row.card_no || '';
  els.fMobile.value = (row.mobile || '').trim();
  els.fRemark.value = row.remark || '';
  setRelationChecked(row.relation == null ? null : Number(row.relation));
  updateDerive();
  els.drawer.hidden = false;
  els.drawerOverlay.hidden = false;
  document.body.style.overflow = 'hidden';
}

// ---------- 人员详情 ----------
function openDetail(row) {
  els.detailDialog.hidden = false;
  els.detailOverlay.hidden = false;
  document.body.style.overflow = 'hidden';
  els.detailBody.innerHTML = `<div class="detail-loading">加载中…</div>`;
  API.detail(row.id).then(res => {
    if (!res.ok) throw new Error(res.message || '加载失败');
    renderDetail(res.data);
  }).catch(err => {
    els.detailBody.innerHTML = `<div class="detail-loading">加载失败：${escapeHtml(err.message)}</div>`;
  });
}
function closeDetail() {
  els.detailDialog.hidden = true;
  els.detailOverlay.hidden = true;
  document.body.style.overflow = '';
  els.detailBody.innerHTML = '';
}

const PERSON_FIELDS = [
  ['birth', '出生日期'], ['full_region', '户籍地区']
];
const CDSGUS_FIELDS = [
  ['name', '姓名'], ['card_type', '证件类型'], ['card_no', '证件号'], ['gender', '性别'],
  ['birthday', '生日'], ['address', '地址'], ['nation', '民族'], ['education', '学历'],
  ['company', '单位'], ['duty', '职务'], ['mobile', '手机'], ['tel', '电话'],
  ['email', '邮箱'], ['version', '版本时间']
];

function fieldVal(obj, key) {
  let v = obj ? obj[key] : '';
  if (v == null || v === '') return '—';
  return escapeHtml(String(v));
}
// 户籍地区字段：单行完整显示不省略，值超宽时字段内横向滚动查看全部（title 悬停亦可看完整值）
const PERSON_FIELD_CLS = { full_region: 'nowrap' };
function renderDetail({ person, cdsgus }) {
  const genderCls = person.gender_code == null ? 'none' : (person.gender_code === 1 ? 'male' : 'female');
  const cards = (cdsgus && cdsgus.length) ? cdsgus : [];
  const pFields = PERSON_FIELDS.map(([k, label]) => {
    const raw = person && person[k] != null && person[k] !== '' ? String(person[k]) : '';
    const valHtml = raw ? escapeHtml(raw) : '—';
    const cls = PERSON_FIELD_CLS[k] ? ` ${PERSON_FIELD_CLS[k]}` : '';
    const title = (PERSON_FIELD_CLS[k] === 'nowrap' && raw) ? ` title="${escapeHtml(raw)}"` : '';
    // 户籍地区占满整行，加宽保证单行完整显示
    const kvCls = k === 'full_region' ? ' kv-wide' : '';
    return `<div class="kv${kvCls}"><span class="k">${label}</span><span class="v${cls}"${title}>${valHtml}</span></div>`;
  }).join('');

  // 头部推导信息卡（年龄段 / 人生阶段 / 星座）
  const statAge = person.age != null ? `${person.age} 岁` : '—';
  const statItems = [
    ['年龄', statAge],
    ['人生阶段', person.age_stage || '—'],
    ['星座', person.constellation || '—']
  ].map(([k, v]) => `<div class="stat"><span class="stat-k">${k}</span><span class="stat-v">${escapeHtml(String(v))}</span></div>`).join('');

  // 手机信息
  const mobItems = [
    ['手机号', person.mobile || '—'],
    ['手机归属', person.mobile_region || '—'],
    ['运营商', [person.mob_carrier, person.mob_carrier_type].filter(Boolean).join('·') || '—']
  ].map(([k, v]) => `<div class="kv"><span class="k">${k}</span><span class="v">${escapeHtml(String(v))}</span></div>`).join('');

  const regSection = cards.length
    ? `<div class="detail-section">
        <div class="section-title">人员登记记录 <span class="reg-count">${cards.length} 条</span></div>
        <div class="reg-list">${cards.map((c, i) => `
          <div class="reg-card">
            <div class="reg-head"><span class="reg-idx">#${i + 1}</span>${fieldVal(c, 'name')}<span class="reg-time">${fieldVal(c, 'version')}</span></div>
            <div class="reg-grid">${CDSGUS_FIELDS.map(([k, label]) =>
              `<div class="kv"><span class="k">${label}</span><span class="v">${fieldVal(c, k)}</span></div>`
            ).join('')}</div>
          </div>`).join('')}</div>
      </div>`
    : `<div class="detail-empty"><span class="empty-icon">${'📭'}</span>该人员暂无 cdsgus 登记记录</div>`;

  const hasRecordBadge = person.hasRecord
    ? `<span class="record-badge yes">有登记</span>`
    : `<span class="record-badge no">无登记</span>`;

  els.detailBody.innerHTML = `
    <div class="detail-hero">
      <div class="detail-hero-bg ${genderCls}"></div>
      <div class="person-card">
        <span class="avatar xl ${genderCls}">${initials(person.name)}</span>
        <div class="person-main">
          <div class="person-name-row">
            <span class="person-name">${escapeHtml(person.name) || '—'}</span>
            <span class="person-relation">${fieldVal(person, 'relation_label')}</span>
            <span class="person-gender ${genderCls}">${fieldVal(person, 'gender_name')}</span>
            ${hasRecordBadge}
          </div>
          <div class="person-meta">身份证 ${fieldVal(person, 'card_no')}</div>
        </div>
      </div>
      <div class="stat-grid">${statItems}</div>
    </div>

    <div class="detail-person detail-panel">
      <div class="panel-title">基础信息</div>
      <div class="kv-grid">${pFields}</div>
      <div class="panel-title sub">手机信息</div>
      <div class="kv-grid">${mobItems}</div>
    </div>
    ${person.remark ? `<div class="detail-panel remark-panel">
      <div class="panel-title">备注</div>
      <p class="remark-text">${escapeHtml(person.remark)}</p>
    </div>` : ''}
    ${regSection}`;
}

function closeDrawer() {
  els.drawer.hidden = true;
  els.drawerOverlay.hidden = true;
  document.body.style.overflow = '';
  // 关闭时清理表单，防止下次打开残留旧数据
  els.fName.value = '';
  els.fCardNo.value = '';
  els.fMobile.value = '';
  els.fRemark.value = '';
  els.dRegion.textContent = '—';
  els.dBirth.textContent = '—';
  els.dGender.textContent = '—';
  els.derive.hidden = true;
  clearErrors();
  resetRelationToDefault();
}

function clearErrors() {
  ['fName', 'fCardNo', 'fMobile'].forEach(id => {
    const input = $('#' + id);
    const err = els.form.querySelector(`.field-err[data-for="${id}"]`);
    input.classList.remove('invalid');
    if (err) err.textContent = '';
  });
}

function setFieldError(id, msg) {
  const input = $('#' + id);
  const err = els.form.querySelector(`.field-err[data-for="${id}"]`);
  input.classList.toggle('invalid', !!msg);
  if (err) err.textContent = msg || '';
}

function validateForm() {
  let okFlag = true;
  clearErrors();
  const name = els.fName.value.trim();
  const cardNo = els.fCardNo.value.trim();
  const mobile = els.fMobile.value.trim();

  if (!name) { setFieldError('fName', '请输入姓名'); okFlag = false; }
  else if (name.length > 20) { setFieldError('fName', '姓名最长 20 个字符'); okFlag = false; }

  if (!cardNo) { setFieldError('fCardNo', '请输入身份证号'); okFlag = false; }
  else if (!parseCard(cardNo) || parseCard(cardNo).len !== 18) { setFieldError('fCardNo', '身份证号需为 18 位'); okFlag = false; }

  if (mobile && !/^1\d{10}$/.test(mobile)) { setFieldError('fMobile', '手机号需为 11 位数字，以 1 开头'); okFlag = false; }

  const remark = els.fRemark.value.trim();

  return { okFlag, name, cardNo, mobile, remark };
}

async function submitForm(e) {
  e.preventDefault();
  const { okFlag, name, cardNo, mobile, remark } = validateForm();
  if (!okFlag) return;

  const relationRadio = els.relationRadios.querySelector('input[name="relation"]:checked');
  const relation = relationRadio ? (relationRadio.value === 'null' ? null : Number(relationRadio.value)) : null;

  els.btnSubmit.disabled = true;
  els.btnSubmit.textContent = '保存中…';
  try {
    const payload = { name, card_no: cardNo, mobile, relation, remark };
    const res = editingId ? await API.update(editingId, payload) : await API.create(payload);
    if (!res.ok) throw new Error(res.message || '保存失败');
    toast(editingId ? '档案已更新' : '档案已创建');
    // 若新增，默认回到第一页查看新记录
    const gotoFirst = !editingId;
    closeDrawer();
    // 更新关系展示（刷新筛选 chips）
    renderFilters();
    await load(gotoFirst);
  } catch (err) {
    toast(err.message || '保存失败', 'error');
  } finally {
    els.btnSubmit.disabled = false;
    els.btnSubmit.textContent = editingId ? '保存修改' : '保存档案';
  }
}

// ---------- 删除 ----------
function openDelete(row) {
  deleteTargetId = row.id;
  els.delTitle.textContent = `确认删除「${row.name}」？`;
  els.delSub.textContent = `身份证号 ${maskCard(row.card_no)}，此操作不可撤销。`;
  els.delDialog.hidden = false;
  els.delOverlay.hidden = false;
}
function closeDelete() {
  deleteTargetId = null;
  els.delDialog.hidden = true;
  els.delOverlay.hidden = true;
}
async function confirmDelete() {
  if (deleteTargetId == null) return;
  els.btnDelConfirm.disabled = true;
  try {
    const res = await API.remove(deleteTargetId);
    if (!res.ok) throw new Error(res.message || '删除失败');
    toast('档案已删除');
    closeDelete();
    await load(false);
  } catch (err) {
    toast(err.message || '删除失败', 'error');
    closeDelete();
  } finally {
    els.btnDelConfirm.disabled = false;
  }
}

// ---------- 自定义关系弹窗 ----------
function openCustomRelDialog() {
  els.fCustomRelLabel.value = '';
  els.customRelErr.textContent = '';
  els.fCustomRelLabel.classList.remove('invalid');
  renderRelList();
  els.relDialog.hidden = false;
  els.relOverlay.hidden = false;
  setTimeout(() => els.fCustomRelLabel.focus(), 50);
}
function closeCustomRelDialog() {
  els.relDialog.hidden = true;
  els.relOverlay.hidden = true;
}

// 渲染「关系管理」对话框中已有自定义关系列表（含删除按钮）
function renderRelList() {
  const customs = FJ_RELATIONS.filter(r => !r.is_builtin);
  if (!customs.length) {
    els.relList.innerHTML = '<p class="rel-empty">暂无自定义关系，可在上方添加。</p>';
    return;
  }
  els.relList.innerHTML = customs.map(r => `
    <div class="rel-row" data-value="${r.value}">
      <span class="rel-name">${escapeHtml(r.label)}</span>
      <button type="button" class="btn btn-danger sm" data-del="${r.value}">删除</button>
    </div>`).join('');
}

// 删除自定义关系：被引用时弹改派选择，否则直接物理删除
async function removeRelation(value) {
  const res = await API.deleteRelation(value);
  if (res && res.ok) {
    await loadRelations();
    renderRelList();
    toast('关系已删除');
    return;
  }
  if (res && res.code === 'RELATION_IN_USE') {
    openReassignDialog(value, res.usage);
    return;
  }
  toast((res && res.message) || '删除失败', 'error');
}

// 改派并删除：先将被引用记录改派到目标关系（null=清空），再物理删除字典项
let pendingReassignValue = null;
function openReassignDialog(value, usage) {
  pendingReassignValue = value;
  els.relReassignSub.textContent = `该关系被 ${usage} 条记录引用。删除前请选择改派目标（被引用记录将改派到所选关系）。`;
  const opts = [
    { value: 'null', label: '无关系（清空关系）' },
    ...FJ_RELATIONS.filter(r => r.value !== value).map(r => ({ value: String(r.value), label: r.label }))
  ];
  els.relReassignTarget.innerHTML = opts.map(o => `<option value="${o.value}">${escapeHtml(o.label)}</option>`).join('');
  els.relReassignDialog.hidden = false;
  els.relReassignOverlay.hidden = false;
}
function closeReassignDialog() {
  els.relReassignDialog.hidden = true;
  els.relReassignOverlay.hidden = true;
  pendingReassignValue = null;
}
async function confirmReassignDelete() {
  if (pendingReassignValue == null) return;
  const target = els.relReassignTarget.value; // 'null' 或 value
  const res = await API.deleteRelation(pendingReassignValue, target);
  if (!res || !res.ok) { toast((res && res.message) || '删除失败', 'error'); return; }
  closeReassignDialog();
  await loadRelations();
  renderRelList();
  toast('关系已删除（被引用记录已改派）');
}
async function confirmAddCustomRel() {
  const label = els.fCustomRelLabel.value.trim().replace(/（/g, '(').replace(/）/g, ')');
  const errEl = els.customRelErr;
  const inputEl = els.fCustomRelLabel;
  errEl.textContent = ''; inputEl.classList.remove('invalid');

  if (!label) { errEl.textContent = '请输入关系名称'; inputEl.classList.add('invalid'); return; }
  if (label.length > 10) { errEl.textContent = '名称最长 10 个字符'; inputEl.classList.add('invalid'); return; }

  // 从云端字典命中已存在同名（含内置）
  const exists = FJ_RELATIONS.find(r => r.label === label);
  if (exists) {
    setRelationChecked(exists.value);
    closeCustomRelDialog();
    toast('已选择现有关系');
    return;
  }
  const customCount = FJ_RELATIONS.filter(r => !r.is_builtin).length;
  if (customCount >= CUSTOM_MAX) {
    errEl.textContent = `自定义关系已达上限 ${CUSTOM_MAX} 个，请先移除不再使用的关系`;
    inputEl.classList.add('invalid');
    return;
  }
  els.btnRelConfirm.disabled = true;
  try {
    const res = await API.createRelation(label);
    if (!res || !res.ok) throw new Error((res && res.message) || '添加失败');
    await loadRelations();          // 刷新云端字典 + 重建 radios/filters
    setRelationChecked(res.data.value);
    closeCustomRelDialog();
    toast(`已添加关系：${label}`);
  } catch (e) {
    errEl.textContent = e.message || '添加失败';
    inputEl.classList.add('invalid');
  } finally {
    els.btnRelConfirm.disabled = false;
  }
}

// ---------- 批量导入 ----------
let importItems = [];      // 当前待导入数据（解析自所选文件）
let importLoaded = false;  // 是否已成功解析出可导入数据

function openImportDialog() {
  importItems = [];
  importLoaded = false;
  els.importFile.value = '';
  els.importFileName.textContent = '';
  els.importErr.textContent = '';
  els.importErr2.textContent = '';
  els.importResult.hidden = true;
  els.importResult.innerHTML = '';
  els.btnImportSubmit.disabled = true;
  els.btnImportSubmit.textContent = '开始导入';
  els.importDialog.hidden = false;
  els.importOverlay.hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeImportDialog() {
  els.importDialog.hidden = true;
  els.importOverlay.hidden = true;
  document.body.style.overflow = '';
  els.importFile.value = '';
}

// 下载导入模板（.xlsx，含表头与一行示例）
function downloadImportTemplate() {
  if (!window.XLSX) {
    toast('导入组件未加载，请刷新页面后重试（或手动创建 CSV：表头 姓名,身份证号,手机号,关系,备注）', 'error');
    return;
  }
  const ws = XLSX.utils.aoa_to_sheet([
    ['姓名', '身份证号', '手机号', '关系', '备注'],
    ['张三', '110101199001011234', '13800138000', '亲属', '示例数据，可删除本行']
  ]);
  ws['!cols'] = [{ wch: 10 }, { wch: 22 }, { wch: 14 }, { wch: 12 }, { wch: 24 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '导入模板');
  XLSX.writeFile(wb, '身份导入模板.xlsx');
}

// 解析文件（.xlsx/.xls/.csv）→ items：[{name, card_no, mobile, relation, remark}]
async function parseImportFile(file) {
  if (!window.XLSX) throw new Error('导入组件未加载，请刷新页面后重试');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error('文件中没有可读取的工作表');
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  if (!aoa.length) throw new Error('文件内容为空');
  const head = (aoa[0] || []).map(h => String(h == null ? '' : h).trim());
  const idx = {
    name: head.indexOf('姓名'),
    card: head.indexOf('身份证号'),
    mobile: head.indexOf('手机号'),
    relation: head.indexOf('关系'),
    remark: head.indexOf('备注')
  };
  if (idx.name < 0 || idx.card < 0) {
    throw new Error('模板表头需包含「姓名」「身份证号」（手机号/关系/备注可选），请下载模板后填写');
  }
  const items = [];
  for (let i = 1; i < aoa.length; i++) {
    const row = aoa[i];
    const isEmpty = !row || row.every(c => String(c == null ? '' : c).trim() === '');
    if (isEmpty) continue;
    const get = (k) => (idx[k] >= 0 && row[idx[k]] != null ? String(row[idx[k]]).trim() : '');
    items.push({ name: get('name'), card_no: get('card'), mobile: get('mobile'), relation: get('relation'), remark: get('remark') });
  }
  if (!items.length) throw new Error('文件中没有可导入的数据行');
  return items;
}

async function handleImportFile(file) {
  try {
    if (!file) throw new Error('请选择文件');
    importItems = await parseImportFile(file);
    importLoaded = true;
    els.importFileName.textContent = `已选：${file.name}（${importItems.length} 条数据）`;
    els.importErr.textContent = '';
    els.btnImportSubmit.disabled = false;
  } catch (e) {
    importItems = [];
    importLoaded = false;
    els.importFileName.textContent = '';
    els.btnImportSubmit.disabled = true;
    els.importErr.textContent = e.message || '文件解析失败，请检查格式';
  }
}

// 校验失败明细渲染（导入弹窗内，红底列表，最多展示 20 条）
function renderImportErrors(errors) {
  const list = (errors || []).map(e =>
    `<div class="import-err-item"><span class="ie-row">第 ${e.row} 行</span><span class="ie-name">${escapeHtml(e.name || '(未命名)')}</span><span class="ie-msg">${escapeHtml(e.msg)}</span></div>`
  ).join('');
  const total = (errors || []).length;
  const more = total > 20 ? `<div class="import-err-more">… 其余 ${total - 20} 条未展示，请修正后重新导入</div>` : '';
  els.importResult.hidden = false;
  els.importResult.className = 'import-result err';
  els.importResult.innerHTML = `<div class="import-err-sum">共 ${total} 条数据存在异常，本次未导入任何数据</div>${list}${more}`;
}

async function submitImport() {
  if (!importLoaded || !importItems.length) return;
  els.btnImportSubmit.disabled = true;
  els.btnImportSubmit.textContent = '导入中…';
  els.importErr2.textContent = '';
  try {
    const res = await API.importCards(importItems);
    if (!res.ok) {
      if (res.code === 'IMPORT_INVALID') {
        renderImportErrors(res.errors);
        throw new Error(res.message || '部分数据异常，未导入');
      }
      throw new Error(res.message || '导入失败');
    }
    const n = Number(res.data && res.data.imported) || 0;
    const newRels = Number(res.data && res.data.newRelations) || 0;
    toast(`导入成功 ${n} 条`);
    closeImportDialog();
    loadRelations(); // 导入可能自动新增了关系，刷新关系字典
    load(true);      // 回到第一页查看新导入记录
  } catch (e) {
    if (importLoaded) {
      els.importErr2.textContent = e.message || '导入失败';
    }
  } finally {
    els.btnImportSubmit.disabled = false;
    els.btnImportSubmit.textContent = '开始导入';
  }
}

// ---------- 事件绑定 ----------
function bindEvents() {
  els.btnRefresh.addEventListener('click', () => load(false));
  els.btnAdd.addEventListener('click', openCreate);

  // 需求：筛选条件输入关键字后，按回车键才触发检索
  els.search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    state.q = e.target.value.trim();
    state.page = 1;
    load(false);
  });

  // 需求：点击搜索框右侧原生清除按钮（x）清空关键词后，触发无关键词检索
  // type="search" 的原生 x 清除会触发 search 事件；手动清空再回车则走上方 keydown 分支
  els.search.addEventListener('search', (e) => {
    const v = e.target.value.trim();
    // 仅当关键词真的变化时才重新查询，避免重复加载
    if (v === state.q) return;
    state.q = v;
    state.page = 1;
    load(false);
  });

  // 筛选 chips：关系 chip 与 待补手机号 chip 可同时选中；点击「全部」清空全部筛选
  els.filters.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const key = chip.dataset.key;
    if (key === 'all') {
      state.relationFilter = null;
      state.nomobileFilter = false;
    } else if (key === 'nomobile') {
      state.nomobileFilter = !state.nomobileFilter;
    } else {
      // 关系 chip：再次点击同一 chip 取消选中
      state.relationFilter = (state.relationFilter === key) ? null : key;
    }
    state.page = 1;
    renderFilters();
    load(false);
  });

  // 每页条数
  els.pageSizeSel.addEventListener('change', (e) => {
    state.pageSize = Number(e.target.value) || 20;
    state.page = 1;
    load(false);
  });

  // 分页器
  els.pager.addEventListener('click', (e) => {
    const btn = e.target.closest('.page-btn');
    if (!btn || btn.disabled) return;
    const target = btn.dataset.page;
    if (target == null) return;
    state.page = Math.max(1, Number(target));
    load(false);
  });

  // 行操作
  els.tbody.addEventListener('click', (e) => {
    const btn = e.target.closest('.row-btn');
    if (!btn) return;
    const id = Number(btn.closest('tr').dataset.id);
    const row = state.rows.find(r => r.id === id);
    if (!row) return;
    if (btn.dataset.action === 'view') openDetail(row);
    else if (btn.dataset.action === 'edit') openEdit(row);
    else if (btn.dataset.action === 'remove') openDelete(row);
  });

  // 抽屉表单
  els.form.addEventListener('submit', submitForm);
  els.btnCancel.addEventListener('click', closeDrawer);
  els.btnDrawerClose.addEventListener('click', closeDrawer);
  els.drawerOverlay.addEventListener('click', closeDrawer);
  els.fCardNo.addEventListener('input', updateDerive);

  // 删除对话框
  els.btnDelCancel.addEventListener('click', closeDelete);
  els.btnDelConfirm.addEventListener('click', confirmDelete);
  els.delOverlay.addEventListener('click', closeDelete);

  // 人员详情
  els.btnDetailClose.addEventListener('click', closeDetail);
  els.btnDetailCancel.addEventListener('click', closeDetail);
  els.detailOverlay.addEventListener('click', (e) => {
    if (e.target === els.detailOverlay) closeDetail();
  });

  // 自定义关系
  els.btnAddRelation.addEventListener('click', openCustomRelDialog);
  els.btnRelClose.addEventListener('click', closeCustomRelDialog);
  els.btnRelCancel.addEventListener('click', closeCustomRelDialog);
  els.relOverlay.addEventListener('click', closeCustomRelDialog);
  els.btnRelConfirm.addEventListener('click', confirmAddCustomRel);
  els.fCustomRelLabel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirmAddCustomRel(); }
  });
  // 关系管理：列表删除
  els.relList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-del]');
    if (!btn) return;
    removeRelation(Number(btn.dataset.del));
  });
  // 改派并删除弹窗
  els.btnRelReassignConfirm.addEventListener('click', confirmReassignDelete);
  els.btnRelReassignCancel.addEventListener('click', closeReassignDialog);
  els.relReassignOverlay.addEventListener('click', closeReassignDialog);
  els.relReassignDialog.querySelector('.icon-btn').addEventListener('click', closeReassignDialog);

  // 批量导入身份
  els.btnImport.addEventListener('click', openImportDialog);
  els.btnImportClose.addEventListener('click', closeImportDialog);
  els.btnImportCancel.addEventListener('click', closeImportDialog);
  els.importOverlay.addEventListener('click', closeImportDialog);
  els.btnDownloadTemplate.addEventListener('click', downloadImportTemplate);
  els.importDrop.addEventListener('click', () => els.importFile.click());
  els.importDrop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.importFile.click(); }
  });
  // 拖拽选择文件
  ['dragenter', 'dragover'].forEach(ev => els.importDrop.addEventListener(ev, (e) => {
    e.preventDefault();
    els.importDrop.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach(ev => els.importDrop.addEventListener(ev, (e) => {
    e.preventDefault();
    els.importDrop.classList.remove('dragover');
  }));
  els.importDrop.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleImportFile(f);
  });
  els.importFile.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) handleImportFile(f);
  });
  els.btnImportSubmit.addEventListener('click', submitImport);

  // Esc 关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!els.relDialog.hidden) closeCustomRelDialog();
      else if (!els.relReassignDialog.hidden) closeReassignDialog();
      else if (!els.delDialog.hidden) closeDelete();
      else if (!els.detailDialog.hidden) closeDetail();
      else if (!els.importDialog.hidden) closeImportDialog();
      else if (!els.drawer.hidden) closeDrawer();
    }
  });
}

// ---------- 启动 ----------
buildRelationRadios();
renderFilters();
bindEvents();
loadRelations(); // 拉取云端关系字典（跨设备共享），成功后重建 radios/filters

// 列表懒加载：进入列表视图（且已通过登录鉴权）时首次加载，由 auth.js 引导触发
if (window.APP_VIEW) {
  let listLoaded = false;
  window.APP_VIEW.onShow('list', () => {
    if (!listLoaded) { listLoaded = true; load(true); }
  });
}