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
  update: (id, payload) => fetch(`/api/id-cards/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(r => r.json()),
  remove: (id) => fetch(`/api/id-cards/${id}`, { method: 'DELETE' }).then(r => r.json()),
  detail: (id) => fetch(`/api/id-cards/${id}/detail`).then(r => r.json()),
  stats: () => fetch('/api/id-cards/stats').then(r => r.json())
};

// ---------- 关系（内置 + 自定义，负数编码为自定义） ----------
const BASE_RELATIONS = [
  { value: 0, label: '亲属', builtin: true },
  { value: 1, label: '朋友', builtin: true },
  { value: 2, label: '同事(瑞联)', builtin: true },
  { value: 3, label: '同事(优品)', builtin: true },
  { value: 4, label: '同事(大自然)', builtin: true },
  { value: 5, label: '同事(财税)', builtin: true },
  { value: null, label: '其他', builtin: true }
];
const CUSTOM_REL_KEY = 'fj_id_card.custom_relations';
const CUSTOM_MAX = 6;

function getCustomRelations() {
  try {
    const raw = localStorage.getItem(CUSTOM_REL_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function saveCustomRelations(list) {
  try { localStorage.setItem(CUSTOM_REL_KEY, JSON.stringify(list.slice(0, CUSTOM_MAX))); } catch {}
}
function getAllRelations() { return [...getCustomRelations(), ...BASE_RELATIONS]; }
function relationLabel(v) {
  const r = getAllRelations().find(x => (x.value == null && v == null) || (x.value === v));
  return r ? r.label : (v == null ? '其他' : String(v));
}
function relationIsCustom(v) {
  return getCustomRelations().some(x => (x.value == null && v == null) || x.value === v);
}
const REL_TAG = (v) => {
  if (v == null) return 'tag-null';
  if (relationIsCustom(v)) return 'tag-custom';
  return `tag-${Number(v)}`;
};

// ---------- 分页 & 筛选状态 ----------
const state = {
  page: 1,
  pageSize: 20,
  total: 0,
  totalPages: 1,
  rows: [],
  q: '',
  filter: 'all',
  stats: { total: 0, noMobile: 0, byRelation: {} }
};

let editingId = null;
let deleteTargetId = null;
let searchTimer = null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const els = {
  badge: $('#modeBadge'), modeText: $('#modeText'),
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
  detailDialog: $('#detailDialog'), detailOverlay: $('#detailOverlay'), btnDetailClose: $('#btnDetailClose'), btnDetailCancel: $('#btnDetailCancel'),
  detailBody: $('#detailBody'),
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
    return full ? escapeHtml(full) : '—';
  }

  return `
    <tr data-id="${r.id}">
      <td>
        <div class="name-cell">
          <span class="avatar ${avatarCls}">${initials(r.name)}</span>
          <span class="name-main">${escapeHtml(r.name) || '—'}</span>
        </div>
      </td>
      <td>${genderTag}</td>
      <td><span class="mono">${maskCard(r.card_no)}</span></td>
      <td><span class="birth">${birth}</span></td>
      <td><span class="region">${regionCell(r)}</span></td>
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
    const hasFilterOrQuery = state.filter !== 'all' || state.q.trim();
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
  if (state.filter === 'nomobile') params.nomobile = '1';
  else if (state.filter.startsWith('r')) params.relation = state.filter.slice(1);
  try {
    const [res, statsRes] = await Promise.all([
      API.list(params),
      API.stats().catch(() => null)
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
    setMode(res.mode);
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

function setMode(mode) {
  els.badge.dataset.mode = mode || 'demo';
  if (mode === 'mysql') {
    els.modeText.textContent = '已连接 MySQL · infocard_test.fj_id_card';
  } else {
    els.modeText.textContent = '演示数据模式';
  }
}

// ---------- 筛选 chips ----------
function buildFiltersMeta() {
  // 关系标签（内置 + 自定义）按名称升序排列
  const relChips = [
    ...BASE_RELATIONS.map(r => ({ key: 'r' + (r.value == null ? 'null' : String(r.value)), label: r.label })),
    ...getCustomRelations().map(r => ({ key: 'r' + String(r.value), label: r.label, custom: true }))
  ].sort((a, b) => String(a.label).localeCompare(String(b.label), 'zh'));
  return [
    { key: 'all', label: '全部' },
    ...relChips,
    { key: 'nomobile', label: '待补手机号' }
  ];
}
function renderFilters() {
  const meta = buildFiltersMeta();
  const s = state.stats;
  els.filters.innerHTML = meta.map(f => {
    const active = state.filter === f.key ? 'active' : '';
    let count = '';
    if (f.key === 'all') count = s.total;
    else if (f.key === 'nomobile') count = s.noMobile;
    else if (f.key.startsWith('r')) {
      const relKey = f.key.slice(1);
      count = s.byRelation[relKey] || 0;
    }
    const title = count != null ? `${escapeHtml(f.label)}：${count} 条` : escapeHtml(f.label);
    return `<button class="chip ${active}" role="tab" data-key="${f.key}" title="${title}">${escapeHtml(f.label)} <span class="chip-count">${count}</span></button>`;
  }).join('');
}

// ---------- 表单：重置/打开 ----------
function buildRelationRadios() {
  const items = getAllRelations();
  els.relationRadios.innerHTML = items.map(r => {
    const val = r.value == null ? 'null' : String(r.value);
    const extra = !r.builtin ? ' custom' : '';
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
function renderDetail({ person, cdsgus }) {
  const genderCls = person.gender_code == null ? 'none' : (person.gender_code === 1 ? 'male' : 'female');
  const cards = (cdsgus && cdsgus.length) ? cdsgus : [];
  const pFields = PERSON_FIELDS.map(([k, label]) =>
    `<div class="kv"><span class="k">${label}</span><span class="v">${fieldVal(person, k)}</span></div>`
  ).join('');

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
  else if (!parseCard(cardNo)) { setFieldError('fCardNo', '身份证号需为 15 或 18 位'); okFlag = false; }

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
    setMode(res.mode);
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
    setMode(res.mode);
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
  els.relDialog.hidden = false;
  els.relOverlay.hidden = false;
  setTimeout(() => els.fCustomRelLabel.focus(), 50);
}
function closeCustomRelDialog() {
  els.relDialog.hidden = true;
  els.relOverlay.hidden = true;
}
function confirmAddCustomRel() {
  const label = els.fCustomRelLabel.value.trim().replace(/（/g, '(').replace(/）/g, ')');
  const errEl = els.customRelErr;
  const inputEl = els.fCustomRelLabel;
  errEl.textContent = ''; inputEl.classList.remove('invalid');

  if (!label) { errEl.textContent = '请输入关系名称'; inputEl.classList.add('invalid'); return; }
  if (label.length > 10) { errEl.textContent = '名称最长 10 个字符'; inputEl.classList.add('invalid'); return; }

  const customs = getCustomRelations();
  // 先从「已存在同名」中命中优先（不重复新增）
  const builtin = BASE_RELATIONS.find(r => r.label === label);
  if (builtin) { errEl.textContent = `已存在相同关系：${label}`; inputEl.classList.add('invalid'); return; }
  const existing = customs.find(c => c.label === label);
  if (existing) {
    // 选上它然后关闭
    setRelationChecked(existing.value);
    closeCustomRelDialog();
    toast('已选择现有自定义关系');
    return;
  }
  if (customs.length >= CUSTOM_MAX) {
    errEl.textContent = `自定义关系已达上限 ${CUSTOM_MAX} 个，请先移除不再使用的关系`;
    inputEl.classList.add('invalid');
    return;
  }
  // 自定义关系编号使用负整数，避免与系统内置 0~5 冲突（MySQL 的 fj_id_card.relation 是 int，可以为负）
  let nextVal = -1;
  const existingValues = new Set(customs.map(c => c.value));
  while (existingValues.has(nextVal)) nextVal -= 1;
  const newRel = { value: nextVal, label, custom: true };
  const updated = [newRel, ...customs].slice(0, CUSTOM_MAX);
  saveCustomRelations(updated);
  buildRelationRadios();
  renderFilters();
  setRelationChecked(nextVal);
  closeCustomRelDialog();
  toast(`已添加自定义关系：${label}`);
}

// ---------- 事件绑定 ----------
function bindEvents() {
  els.btnRefresh.addEventListener('click', () => load(false));
  els.btnAdd.addEventListener('click', openCreate);

  els.search.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = val;
      state.page = 1;
      load(false);
    }, 220);
  });

  // 筛选 chips
  els.filters.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.filter = chip.dataset.key;
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

  // Esc 关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!els.relDialog.hidden) closeCustomRelDialog();
      else if (!els.delDialog.hidden) closeDelete();
      else if (!els.detailDialog.hidden) closeDetail();
      else if (!els.drawer.hidden) closeDrawer();
    }
  });
}

// ---------- 启动 ----------
buildRelationRadios();
renderFilters();
bindEvents();

// 列表懒加载：进入列表视图（且已通过登录鉴权）时首次加载，由 auth.js 引导触发
if (window.APP_VIEW) {
  let listLoaded = false;
  window.APP_VIEW.onShow('list', () => {
    if (!listLoaded) { listLoaded = true; load(true); }
  });
}