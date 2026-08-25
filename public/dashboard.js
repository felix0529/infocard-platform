/**
 * 看板分析 —— 全部交互与图表渲染
 * Tab 切换 / 全局筛选联动 / ECharts 多图表 / 地区地图下钻（省→市→区） / 明细弹窗分页
 */
(function () {
  'use strict';
  if (!window.echarts) { console.warn('[dashboard] 缺少 ECharts，看板图表不可用'); return; }

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const els = {
    navList: $('#navList'), navDash: $('#navDash'),
    viewList: $('#viewList'), viewDash: $('#viewDash'),
    hasRecord: $('#dashHasRecord'), regYear: $('#dashRegYear'),
    tabs: $$('.dash-tab'), panePerson: $('#panePerson'), paneMobile: $('#paneMobile'), paneRegion: $('#paneRegion'),
    countsPerson: $('#countsPerson'), countsMobile: $('#countsMobile'),
    peopleDialog: $('#peopleDialog'), peopleOverlay: $('#peopleOverlay'),
    peopleBody: $('#peopleBody'), peopleCount: $('#peopleCount'),
    peoplePager: $('#peoplePager'), peopleTitle: $('#peopleTitle'),
    btnPeopleClose: $('#btnPeopleClose')
  };

  const state = {
    scope: { hasRecord: 'all', regYear: null },
    activeTab: 'person',
    regionCtx: { level: 'province', parent: '', cities: {}, districts: [] },
    echarts: {}
  };

  // ---------- 基础工具 ----------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function bignum(n) { const v = Number(n); if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'; if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k'; return v; }
  function qs(obj) { return Object.entries(obj).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&'); }
  function relLabel(key) {
    const map = { 0: '亲属', 1: '朋友', 2: '同事(瑞联)', 3: '同事(优品)', 4: '同事(大自然)', 5: '同事(财税)' };
    if (key == null) return '其他';
    return map[key] || '其他';
  }

  // 省级 adcode（6 位）→ 用于地图下钻加载省市 geojson 与颜色映射
  const PROV_ADCODE = {
    '北京市': '110000', '天津市': '120000', '河北省': '130000', '山西省': '140000', '内蒙古自治区': '150000',
    '辽宁省': '210000', '吉林省': '220000', '黑龙江省': '230000', '上海市': '310000', '江苏省': '320000',
    '浙江省': '330000', '安徽省': '340000', '福建省': '350000', '江西省': '360000', '山东省': '370000',
    '河南省': '410000', '湖北省': '420000', '湖南省': '430000', '广东省': '440000', '广西壮族自治区': '450000',
    '海南省': '460000', '重庆市': '500000', '四川省': '510000', '贵州省': '520000', '云南省': '530000',
    '西藏自治区': '540000', '陕西省': '610000', '甘肃省': '620000', '青海省': '630000', '宁夏回族自治区': '640000',
    '新疆维吾尔自治区': '650000', '台湾省': '710000', '香港特别行政区': '810000', '澳门特别行政区': '820000'
  };

  function getChart(el) {
    const id = el.id;
    let inst = state.echarts[id];
    // 旧实例仍有效则直接复用
    if (inst) {
      try { if (!inst.isDisposed()) return inst; } catch (e) {}
      delete state.echarts[id];
    }
    // 清空所有子内容（含 loading 占位符），为 echarts.init 提供干净容器
    el.innerHTML = '';
    inst = echarts.init(el);
    state.echarts[id] = inst;
    return inst;
  }

  // ---------- 视图切换 --------------
  // 视图切换由 auth.js（APP_VIEW）统一管理；看板视图显示时触发加载与重排。
  // (原有 navList/navDash 点击绑定已迁移至 auth.js 的导航门控)

  // ---------- 全局筛选联动 ----------
  els.hasRecord.addEventListener('change', () => {
    state.scope.hasRecord = els.hasRecord.value;
    const yes = state.scope.hasRecord === 'yes';
    els.regYear.disabled = !yes;
    els.regYear.value = '';
    state.scope.regYear = null;
    // 立即清空年份选项，避免异步间隙闪现上一次的完整年份列表
    els.regYear.innerHTML = '<option value="">全部年份</option>';
    loadDashboard();
  });
  els.regYear.addEventListener('change', () => {
    state.scope.regYear = els.regYear.value || null;
    loadDashboard();
  });

  // ---------- 数据加载 ----------
  let dashReqSeq = 0; // 请求序号，用于丢弃过期的异步响应，避免竞态覆盖
  async function loadDashboard() {
    const seq = ++dashReqSeq;
    drawLoading();
    try {
      const r = await fetch('/api/dashboard/stats?' + qs(state.scope)).then(x => x.json());
      if (seq !== dashReqSeq) return;
      if (!r.ok) throw new Error(r.message || '看板加载失败');
      const person = r.data.person || {};
      const mobile = r.data.mobile || {};
      fillRegYears(r.data.regYears || []);
      renderCountsPerson(person);
      renderCountsMobile(mobile);
      renderChartsPerson(person);
      renderChartsMobile(mobile);
      // 渲染完成后触发 resize，确保 ECharts canvas 尺寸正确
      setTimeout(resizeAll, 0);
    } catch (e) { console.error('[dashboard]', e); }
  }

  function fillRegYears(years) {
    const keep = els.regYear.value;
    els.regYear.innerHTML = '<option value="">全部年份</option>' +
      years.map(y => `<option value="${y}">${y}年</option>`).join('');
    if (keep) els.regYear.value = keep;
  }

  // ---------- 统计卡 ----------
  function renderCountsPerson(p) {
    if (!p || !p.counts) return;
    const c = p.counts;
    const items = [
      { l: '人员总数', v: c.total, filters: {}, icon: 'users', color: 'blue' },
      { l: '已记录', v: c.withRecord, filters: { hasRec: 'yes' }, icon: 'check', color: 'green' },
      { l: '未记录', v: c.withoutRecord, filters: { hasRec: 'no' }, icon: 'clock', color: 'orange' }
    ];
    els.countsPerson.innerHTML = items.map((s, i) => renderStatCard(s)).join('');
    bindStatClicks(els.countsPerson, items);
  }
  function renderCountsMobile(m) {
    if (!m || !m.counts) return;
    const c = m.counts;
    const items = [
      { l: '人员总数', v: c.total, filters: {}, icon: 'users', color: 'blue' },
      { l: '已记录手机号', v: c.withMobile, filters: { hasMob: '1' }, icon: 'check', color: 'green' },
      { l: '待补手机号', v: c.withoutMobile, filters: { hasMob: '0' }, icon: 'alert', color: 'orange' }
    ];
    els.countsMobile.innerHTML = items.map((s, i) => renderStatCard(s)).join('');
    bindStatClicks(els.countsMobile, items);
  }

  // 统计卡：左侧图标 + 右侧数据（label/value/unit），更丰富的颜色与层次
  const STAT_ICONS = {
    users: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    clock: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    alert: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
  };
  function renderStatCard(s) {
    const icon = STAT_ICONS[s.icon] || '';
    return `<div class="dash-stat dash-stat-click stat-${s.color}" data-i="${0}">
      <div class="stat-icon">${icon}</div>
      <div class="stat-body">
        <div class="stat-label">${s.l}</div>
        <div class="stat-value">${s.v}<span class="stat-unit">人</span></div>
      </div>
    </div>`;
  }
  // 统计卡点击：打开明细弹窗（带对应过滤条件）
  function bindStatClicks(container, items) {
    container.querySelectorAll('[data-i]').forEach(el => el.addEventListener('click', () => {
      const s = items[Number(el.dataset.i)];
      openPeopleDialog({ label: s.l, filters: s.filters });
    }));
  }

  // ---------- Tab 切换 ----------
  els.tabs.forEach(tab => tab.addEventListener('click', () => {
    els.tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    state.activeTab = tab.dataset.tab;
    els.panePerson.hidden = state.activeTab !== 'person';
    els.paneMobile.hidden = state.activeTab !== 'mobile';
    els.paneRegion.hidden = state.activeTab !== 'region';
    setTimeout(resizeAll, 40);
  }));

  // ---------- 图表配置 ----------
  const PALETTE = ['#4353f7', '#6b5bf7', '#ec5d8f', '#2f6fed', '#22c55e', '#f59e0b', '#ef4444', '#0ea5e9', '#a855f7', '#14b8a6', '#eab308', '#84cc16'];

  function barOption(items, { horizontal = false } = {}) {
    const data = items || [];
    const names = data.map(d => d.key);
    const vals = data.map(d => d.count);
    return {
      grid: horizontal ? { left: 10, right: 40, top: 20, bottom: 20, containLabel: true } : { left: 40, right: 20, top: 30, bottom: 40 },
      tooltip: { trigger: 'axis', formatter: (ps) => (ps || []).map(p => `${p.name}: ${p.value} 人`).join('<br/>') },
      xAxis: horizontal ? { type: 'value' } : { type: 'category', data: names, axisLabel: { rotate: 40 } },
      yAxis: horizontal ? { type: 'category', data: names, inverse: true } : { type: 'value' },
      series: [{ type: 'bar', data: vals, barMaxWidth: 22, itemStyle: { color: '#4353f7', borderRadius: 4 },
        label: horizontal ? { show: true, position: 'right', color: '#4b5563', fontSize: 10 } : { show: true, position: 'top', color: '#4b5563', fontSize: 10 } }]
    };
  }
  function pieOption(items, { startAngle = 90 } = {}) {
    const data = (items || []).filter(d => Number(d.count) > 0)
      .map((d, i) => ({ name: String(d.key == null ? '未知' : d.key), value: Number(d.count), itemStyle: { color: PALETTE[i % PALETTE.length] }, _origKey: d.origKey }));
    const total = data.reduce((s, d) => s + d.value, 0) || 1;
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} 人 ({d}%)' },
      // 图例置于底部，完整展示「名称 + 人数 + 占比」，超出自动横向滚动
      legend: {
        bottom: 0, left: 'center', type: 'scroll',
        icon: 'circle', itemWidth: 8, itemHeight: 8, itemGap: 10,
        textStyle: { fontSize: 11, color: '#4b5563' },
        formatter: (name) => {
          const d = data.find(x => x.name === name);
          return d ? `${name} ${d.value}人 ${(d.value / total * 100).toFixed(1)}%` : name;
        }
      },
      series: [{
        type: 'pie',
        radius: ['38%', '60%'],
        center: ['50%', '38%'],
        startAngle, sort: 'none',
        padAngle: 1,
        itemStyle: { borderRadius: 4, borderColor: '#fff', borderWidth: 1 },
        // 占比内嵌于扇区（占比过小的扇区不显示，避免互相压盖），悬停/图例查看完整数据
        label: { show: true, position: 'inside', fontSize: 11, fontWeight: 600, color: '#16181d', formatter: (p) => p.percent >= 6 ? `${p.percent}%` : '' },
        labelLine: { show: false },
        labelLayout: { hideOverlap: true },
        emphasis: { scale: true, scaleSize: 4, label: { show: true, position: 'inside', formatter: (p) => `${p.name} ${p.value}人 ${p.percent}%` } },
        data
      }]
    };
  }

  // 折线图：重点高亮 Top3（更大圆点 + 值标签）
  function top3LineOption(items, nameUnit = '') {
    const names = (items || []).map(d => d.key);
    const vals = (items || []).map(d => Number(d.count) || 0);
    const rank = vals.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v).slice(0, 3);
    const topIdx = new Set(rank.map(r => r.i));
    const mark = rank.map(r => ({ coord: [String(names[r.i]), vals[r.i]], value: vals[r.i] }));
    return {
      grid: { left: 40, right: 24, top: 40, bottom: 40 },
      tooltip: { trigger: 'axis', formatter: (ps) => (ps || []).map(p => `${p.name}${nameUnit}: ${p.value} 人`).join('<br/>') },
      xAxis: { type: 'category', data: names, axisLabel: { rotate: 40 } },
      yAxis: { type: 'value' },
      series: [{
        type: 'line', smooth: true, data: vals,
        symbolSize: (v, p) => topIdx.has(p.dataIndex) ? 12 : 5,
        itemStyle: { color: '#4353f7' },
        lineStyle: { width: 2.5 },
        label: { show: true, position: 'top', color: '#d97706', fontWeight: 700, formatter: (p) => topIdx.has(p.dataIndex) ? p.value : '' },
        markPoint: { symbol: 'pin', symbolSize: 42, itemStyle: { color: '#ec5d8f' }, label: { formatter: p => p.value }, data: mark }
      }]
    };
  }

  // 星座开始日期排序（从 1-20 水瓶开始顺时针）
  const CONST_START = {
    '水瓶座': 1, '双鱼座': 2, '白羊座': 3, '金牛座': 4, '双子座': 5, '巨蟹座': 6,
    '狮子座': 7, '处女座': 8, '天秤座': 9, '天蝎座': 10, '射手座': 11, '摩羯座': 12
  };
  function sortConstellation(items) {
    return (items || []).slice().sort((a, b) => {
      const ka = CONST_START[a.key] || 99, kb = CONST_START[b.key] || 99;
      return ka - kb;
    });
  }

  // 姓氏 Top10（固定显示，无需缩放）
  function renderSurname(sur) {
    const top = (sur || []).slice(0, 10);
    const names = top.map(d => d.key);
    const vals = top.map(d => d.count);
    getChart($('#chartSurname')).setOption({
      grid: { top: 20, bottom: 20, left: 60, right: 30, containLabel: true },
      tooltip: { trigger: 'axis', formatter: (ps) => (ps || []).map(p => `${p.name}: ${p.value} 人`).join('<br/>') },
      xAxis: { type: 'value' },
      yAxis: { type: 'category', data: names, inverse: true },
      series: [{ type: 'bar', data: vals, barMaxWidth: 20, label: { show: true, position: 'right', color: '#4b5563' }, itemStyle: { color: '#4353f7', borderRadius: 4 } }]
    });
  }

  const STAGE_ORDER = ['幼儿（0-6岁）', '少儿（7-12岁）', '少年（13-17岁）', '青年（18-35岁）', '中年（36-50岁）', '老年（51-65岁）', '高龄（65岁以上）', '未知'];
  function renderAgeStage(stages) {
    const data = (stages || []).slice().sort((a, b) => {
      const ia = STAGE_ORDER.indexOf(String(a.key));
      const ib = STAGE_ORDER.indexOf(String(b.key));
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    const names = data.map(d => String(d.key));
    const vals = data.map(d => Number(d.count) || 0);
    getChart($('#chartAgeStage')).setOption({
      grid: { left: 40, right: 20, top: 32, bottom: 56 },
      tooltip: { trigger: 'axis', formatter: (ps) => (ps || []).map(p => `${p.name}: ${p.value} 人`).join('<br/>') },
      xAxis: { type: 'category', data: names, axisLabel: { interval: 0, rotate: 0, fontSize: 10 } },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', data: vals, barMaxWidth: 26, label: { show: true, position: 'top', color: '#4b5563', fontSize: 10 }, itemStyle: { color: '#4353f7', borderRadius: 4 } }]
    });
  }

  // 安全渲染单个图表：任一图表异常只影响自身，不拖垮整链渲染
  // click 为可选点击回调，渲染成功后绑定（绑定前先 off 避免重复）
  function safeRender(id, fn, click) {
    const el = $(id);
    if (!el) return;
    try {
      const c = getChart(el);
      fn(c);
      if (click) { c.off('click'); c.on('click', (p) => click(p, c)); }
    } catch (e) { console.error('[dashboard] 渲染失败', id, e); }
  }

  function arr(x) { return Array.isArray(x) ? x : []; }

  function renderChartsPerson(p) {
    if (!p) return;
    // 性别：环形图，点击切片按性别下钻
    safeRender('#chartGender',
      (c) => c.setOption(pieOption(arr(p.gender).map(k => ({ key: k.key == null ? '未知' : (k.key === 1 ? '男' : '女'), origKey: k.key, count: k.count })))),
      (param) => {
        if (!param || param.name == null) return;
        const ok = param.data && param.data._origKey;
        const filters = {};
        if (ok === null || ok === undefined) filters.gender = 'null';
        else if (ok === 0 || ok === 1) filters.gender = String(ok);
        else return;
        openPeopleDialog({ label: `性别：${param.name}`, filters });
      });
    // 姓氏：横向条形图，点击条按姓氏下钻
    safeRender('#chartSurname', () => renderSurname(arr(p.surname)), (param) => {
      if (!param || !param.name) return;
      openPeopleDialog({ label: `姓氏：${param.name}`, filters: { surname: param.name } });
    });
    // 出生年份：折线图，点击点按年份下钻
    safeRender('#chartBirthYear', (c) => c.setOption(top3LineOption(arr(p.birthYear), '年')), (param) => {
      if (!param || param.name == null) return;
      if (!/^\d{4}$/.test(String(param.name))) return;
      openPeopleDialog({ label: `出生年份：${param.name}年`, filters: { birthYear: String(param.name) } });
    });
    // 出生月份：柱形图，点击柱按月份下钻
    safeRender('#chartBirthMonth', (c) => c.setOption(barOption(arr(p.birthMonth).map(m => ({ key: `${Number(m.key)}月`, count: m.count })))), (param) => {
      if (!param || param.name == null) return;
      const mm = String(param.name).replace(/月$/, '');
      if (!/^\d{1,2}$/.test(mm)) return;
      openPeopleDialog({ label: `出生月份：${mm}月`, filters: { birthMonth: mm } });
    });
    // 星座：柱形图，按开始日期从小到大，点击柱按星座下钻
    safeRender('#chartConstellation', (c) => c.setOption(barOption(sortConstellation(arr(p.constellation)))), (param) => {
      if (!param || !param.name) return;
      openPeopleDialog({ label: `星座：${param.name}`, filters: { constellation: param.name } });
    });
    // 年龄：折线图，点击点按年龄下钻
    safeRender('#chartAge', (c) => c.setOption(top3LineOption(arr(p.age), '岁')), (param) => {
      if (!param || param.name == null) return;
      if (!/^\d+$/.test(String(param.name))) return;
      openPeopleDialog({ label: `年龄：${param.name}岁`, filters: { age: String(param.name) } });
    });
    // 年龄阶段：柱形图，点击柱按阶段下钻
    safeRender('#chartAgeStage', () => renderAgeStage(arr(p.ageStage)), (param) => {
      if (!param || !param.name) return;
      openPeopleDialog({ label: `年龄阶段：${param.name}`, filters: { ageStage: param.name } });
    });
    // 关系：环形图从12点起按名称升序顺时针，点击切片按关系下钻（保留原始 key 以支持自定义关系）
    const relItems = arr(p.relation).map(r => ({ key: relLabel(r.key), origKey: r.key, count: r.count }))
      .slice().sort((a, b) => String(a.key).localeCompare(String(b.key), 'zh'));
    safeRender('#chartRelation', (c) => c.setOption(pieOption(relItems)), (param) => {
      if (!param || param.name == null) return;
      const ok = param.data && param.data._origKey;
      const filters = {};
      if (ok === null || ok === undefined) filters.relation = 'null';
      else if (/^-?\d+$/.test(String(ok))) filters.relation = String(ok);
      else return;
      openPeopleDialog({ label: `关系：${param.name}`, filters });
    });
    resetRegion();
    renderRegionProvince(arr(p.regionProvince));
  }

  function renderChartsMobile(m) {
    if (!m) return;
    // 手机归属地：柱形图，点击柱按归属地下钻
    safeRender('#chartMobileProvince', (c) => c.setOption(barOption(arr(m.mobileProvince).map(d => ({ key: d.key, count: bignum(d.count) })))), (param) => {
      if (!param || param.name == null) return;
      openPeopleDialog({ label: `手机归属地：${param.name}`, filters: { mobileProvince: param.name } });
    });
    // 运营商：环形图，点击切片按运营商下钻
    safeRender('#chartCarrier', (c) => c.setOption(pieOption(arr(m.carrier).map(d => ({ key: d.key, count: d.count })))), (param) => {
      if (!param || param.name == null) return;
      openPeopleDialog({ label: `运营商：${param.name}`, filters: { carrier: param.name } });
    });
  }

  // ---------- 地区分布：全国 → 省 → 市 → 区（左地图/列表 + 右排名条联动） ----------
  async function loadMap(url) {
    try { const r = await fetch(url); if (!r.ok) return null; return await r.json(); }
    catch { return null; }
  }
  function resetRegion() {
    state.regionCtx = { level: 'province', parent: '', cities: {}, districts: [] };
    const tb = $('#regionToolbar'); if (tb) tb.innerHTML = '';
    disposeRank();
  }
  // 丢弃地图 / 排名条 的 ECharts 实例
  function disposeRegion() {
    const inst = state.echarts['chartRegion'];
    if (inst) { try { inst.dispose(); } catch (e) {} delete state.echarts['chartRegion']; }
    const box = $('#chartRegion'); if (box) box.innerHTML = '';
  }
  function disposeRank() {
    const inst = state.echarts['chartRegionRank'];
    if (inst) { try { inst.dispose(); } catch (e) {} delete state.echarts['chartRegionRank']; }
  }

  function makeMapOption(name, data) {
    const max = Math.max(1, ...data.map(d => Number(d.value) || 0));
    const isChina = name === 'china-dash';
    return {
      tooltip: { trigger: 'item', formatter: (p) => `${p.name}: ${p.value == null ? 0 : p.value} 人` },
      visualMap: { min: 0, max, left: 12, bottom: 10, inRange: { color: ['#eef0ff', '#4353f7'] } },
      series: [{
        type: 'map', map: name, roam: false, data,
        layoutCenter: ['50%', '50%'], layoutSize: '100%',
        zoom: isChina ? 1.2 : 1.0,
        label: {
          show: true,
          fontSize: isChina ? 10.5 : 10,
          lineHeight: 13,
          color: '#16181d',
          textBorderColor: '#ffffff', textBorderWidth: 3,
          // 有数据的省份显示"名称+人数"两行；无数据的省份仅单行名称，减少标签占位
          formatter: (p) => (Number(p.value) > 0) ? `${p.name}\n${p.value}` : p.name
        },
        // 自动隐藏互相遮挡的省份标签；悬停地图/排名条仍可查看详情
        labelLayout: { hideOverlap: true },
        emphasis: {
          label: { show: true, fontWeight: 700, color: '#16181d', textBorderColor: '#ffffff', textBorderWidth: 3 }
        }
      }]
    };
  }

  // 排名横条
  function rankBarOption(items) {
    const data = items.slice();
    return {
      grid: { left: 8, right: 34, top: 8, bottom: 8, containLabel: true },
      tooltip: { trigger: 'axis', formatter: p => (p[0] ? `${p[0].name}: ${p[0].value} 人` : '') },
      xAxis: { type: 'value' },
      yAxis: { type: 'category', data: data.map(d => d.name), inverse: true, axisLabel: { fontSize: 10 } },
      series: [{ type: 'bar', data: data.map(d => ({ name: d.name, value: d.value })), barMaxWidth: 16,
        itemStyle: { color: '#4353f7', borderRadius: 3 },
        label: { show: true, position: 'right', color: '#4b5563', fontSize: 10 },
        emphasis: { itemStyle: { color: '#ec5d8f' } } }]
    };
  }
  // 渲染右侧排名条
  function renderRegionRank(title, items, drillFn) {
    const ttEl = $('#regionRankTitle'); if (ttEl) ttEl.textContent = title;
    const el = $('#chartRegionRank'); if (!el) return;
    disposeRank();
    const chart = getChart(el);
    chart.setOption(rankBarOption(items || []));
    if (drillFn) { chart.off('click'); chart.on('click', (p) => { if (p.name) drillFn(p.name); }); }
    state.regionRankChart = chart;
  }
  // 排名条 → 地图 悬停联动
  function bindMapRank(mapChart, rankChart) {
    if (!mapChart || !rankChart) return;
    const hl = (t, n) => { try { t.dispatchAction({ type: 'highlight', name: n }); } catch (e) {} };
    const dl = (t, n) => { try { t.dispatchAction({ type: 'downplay', name: n }); } catch (e) {} };
    mapChart.on('mouseover', (p) => { if (p.name) hl(rankChart, p.name); });
    mapChart.on('mouseout', (p) => { if (p.name) dl(rankChart, p.name); });
    rankChart.on('mouseover', (p) => { if (p.name) hl(mapChart, p.name); });
    rankChart.on('mouseout', (p) => { if (p.name) dl(mapChart, p.name); });
  }
  // 顶部工具条（面包屑）
  function setToolbarCrumbs(crumbs) {
    const bar = $('#regionToolbar'); if (!bar) return;
    bar.innerHTML = '';
    (crumbs || []).forEach(c => {
      const el = document.createElement(c.back ? 'button' : 'span');
      el.className = 'city-chip';
      if (!c.back) el.style.cursor = 'default';
      el.textContent = c.label;
      if (c.back) el.addEventListener('click', c.back);
      bar.appendChild(el);
    });
  }
  // 过滤南沙群岛：移除独立的南海诸岛 feature，并裁剪所有特征纬度 < 17° 的坐标
  function stripNansha(geo) {
    const MIN_LAT = 17.0;
    const features = (geo.features || []).filter(f => {
      const nm = f.properties && f.properties.name;
      const ad = f.properties && f.properties.adcode;
      if (!nm) return false;
      if (nm === '南海诸岛') return false;
      if (String(ad) === '100000_JD') return false;
      return true;
    });
    // 裁剪每个 feature 的坐标，移除纬度 < 17.5 的部分
    function clipCoords(coords, lat) {
      if (!Array.isArray(coords) || coords.length === 0) return coords;
      if (typeof coords[0] === 'number') {
        return coords[1] >= lat ? coords : null;
      }
      if (typeof coords[0][0] === 'number') {
        // 这是一个环/线 [[lon,lat], [lon,lat], ...]
        const clipped = coords.filter(pt => pt[1] >= lat);
        return clipped.length >= 3 ? clipped : null; // 多边形至少需要3个点
      }
      // 嵌套多边形
      const result = coords.map(c => clipCoords(c, lat)).filter(c => c !== null);
      return result.length > 0 ? result : null;
    }
    const clipped = features.map(f => {
      const geom = f.geometry;
      if (!geom) return f;
      const newGeom = { type: geom.type, coordinates: clipCoords(geom.coordinates, MIN_LAT) };
      if (!newGeom.coordinates || (Array.isArray(newGeom.coordinates) && newGeom.coordinates.length === 0)) return null;
      return { ...f, geometry: newGeom };
    }).filter(Boolean);
    return { type: geo.type, features: clipped };
  }

  // 全国分布（省人数；去除南海诸岛 + 裁剪南沙区域坐标）
  async function renderRegionProvince(provItems) {
    const box = $('#chartRegion');
    disposeRegion();
    const chart = getChart(box);
    const geo = await loadMap('/maps/china.json');
    if (!geo) { box.innerHTML = '<div class="chart-loading">地图数据缺失</div>'; return; }
    const filtered = stripNansha(geo);
    const by2 = {};
    (provItems || []).forEach(d => { by2[d.k2] = Number(d.count); });
    const data = [];
    const rank = [];
    (filtered.features || []).forEach(f => {
      const nm = f.properties && f.properties.name;
      const ad = PROV_ADCODE[nm];
      const k2 = ad ? ad.slice(0, 2) : null;
      const value = k2 ? (by2[k2] || 0) : 0;
      data.push({ name: nm, value, _ad: ad });
      if (ad && value > 0) rank.push({ name: nm, value });
    });
    echarts.registerMap('china-dash', filtered);
    chart.clear();
    chart.setOption(makeMapOption('china-dash', data));
    rank.sort((a, b) => b.value - a.value);
    renderRegionRank('全国各省人数排名', rank, drillCity);
    setToolbarCrumbs([{ label: '全国' }]);
    chart.off('click');
    chart.on('click', (param) => drillCity(param.name));
    bindMapRank(chart, state.regionRankChart);
  }

  // 点击省 → 下钻市（地图 + chips 双入口，均可进入区）
  async function drillCity(provName) {
    const ad = PROV_ADCODE[provName];
    if (!ad) return;
    const scope = state.scope;
    const res = await fetch(`/api/dashboard/region?level=city&parent=${ad}&${qs(scope)}`).then(r => r.json());
    const cities = (res && res.data) || [];
    if (!cities.length) { toast('该省份暂无数据'); return; }
    const byName = {};
    const rank = [];
    cities.forEach(c => {
      if (!c.city) return;
      const code = c.code ? String(c.code).slice(0, 4) : '';
      byName[c.city] = code;
      rank.push({ name: c.city, code, value: Number(c.count) || 0 });
    });
    rank.sort((a, b) => b.value - a.value);
    state.regionCtx = { level: 'city', parent: ad, cities: byName, districts: [] };

    renderRegionRank(`${provName} · 各市人数排名`, rank,
      name => { const code = byName[name]; if (code) drillDistrict(name, code, provName, ad); else toast('缺少市编码'); });
    setToolbarCrumbs([{ label: '← 返回全国', back: renderNational }, { label: provName }]);

    const box = $('#chartRegion');
    disposeRegion();
    const chart = getChart(box);
    const geo = await loadMap(`/maps/province/${ad}.json`);
    if (!geo) { box.innerHTML = '<div class="chart-loading">无该省地图数据</div>'; return; }
    const countByName = {};
    cities.forEach(c => { if (c.city) countByName[c.city] = Number(c.count) || 0; });
    const data = (geo.features || []).map(f => {
      const nm = f.properties && f.properties.name;
      return { name: nm, value: countByName[nm] || 0, _code: byName[nm] || '' };
    });
    echarts.registerMap('dash-' + ad, geo);
    chart.clear();
    chart.setOption(makeMapOption('dash-' + ad, data));
    chart.off('click');
    chart.on('click', (param) => { const code = byName[param.name] || ''; if (code) drillDistrict(param.name, code, provName, ad); else toast('缺少市编码'); });
    bindMapRank(chart, state.regionRankChart);
  }

  // 返回全国
  async function renderNational() {
    const scope = state.scope;
    const r = await fetch('/api/dashboard/stats?' + qs(scope)).then(x => x.json());
    if (r.ok && r.data && r.data.person) { resetRegion(); renderRegionProvince(r.data.person.regionProvince); }
  }

  // 点击市 → 下钻区（地图方式展示；右侧区排名，点击区弹明细）
  async function drillDistrict(cityName, cityCode, provName, provAd) {
    if (!cityCode) { toast('缺少市编码'); return; }
    const scope = state.scope;
    const res = await fetch(`/api/dashboard/region?level=district&parent=${cityCode}&${qs(scope)}`).then(r => r.json());
    const districts = (res && res.data) || [];
    if (!districts.length) { toast('该市暂无区级数据'); return; }
    state.regionCtx.districts = districts;

    const byName = {};
    const rank = (districts || []).map(d => {
      const nm = d.district || d.city || '未知';
      const code = d.code ? String(d.code).slice(0, 6) : '';
      if (code) byName[nm] = code;
      return { name: nm, code, value: Number(d.count) || 0 };
    }).sort((a, b) => b.value - a.value);

    const openD = (name) => { const code = byName[name]; if (code) openPeopleDialog({ level: 'district', parent: code, label: `${cityName} · ${name}` }); else toast('缺少区编码'); };
    renderRegionRank(`${cityName} · 各区人数排名`, rank, openD);
    setToolbarCrumbs([{ label: `← ${provName}`, back: () => drillCity(provName) }, { label: `${cityName} · 区` }]);

    const box = $('#chartRegion');
    disposeRegion();
    const fullAd = String(cityCode).slice(0, 4) + '00';
    const geo = await loadMap(`/maps/district/${fullAd}.json`);
    if (!geo || !geo.features || !geo.features.length) {
      box.innerHTML = '<div class="chart-loading">该市暂无区级地图数据，请从右侧排名中选择</div>';
      return;
    }
    const countByCode = {};
    districts.forEach(d => { const c = String(d.code || '').slice(0, 6); if (c) countByCode[c] = Number(d.count) || 0; });
    const data = (geo.features || []).map(f => {
      const nm = f.properties && f.properties.name;
      const adc = f.properties && (f.properties.adcode || f.properties.ad) || '';
      const code = String(adc || '');
      return { name: nm, value: (code && countByCode[code]) || 0, _code: code || byName[nm] || '' };
    });
    echarts.registerMap('dash-dist-' + fullAd, geo);
    const chart = getChart(box);
    chart.clear();
    chart.setOption(makeMapOption('dash-dist-' + fullAd, data));
    chart.off('click');
    chart.on('click', (param) => { const nm = param.name; const code = byName[nm] || (param.data && param.data._code); if (code) openPeopleDialog({ level: 'district', parent: code, label: `${cityName} · ${nm}` }); else toast('该区无人员'); });
    bindMapRank(chart, state.regionRankChart);
  }

  // ---------- 明细弹窗（地区下钻 / 图表维度点击 共用） ----------
  // opts: { level?, parent?, label, filters? }
  // level/parent 用于地区下钻；filters 用于图表点击维度过滤
  let peopleCtx = null;
  async function openPeopleDialog(opts) {
    const o = opts || {};
    peopleCtx = { level: o.level || '', parent: o.parent || '', label: o.label || '明细', filters: o.filters || {} };
    els.peopleTitle.textContent = peopleCtx.label;
    els.peopleDialog.hidden = false;
    els.peopleOverlay.hidden = false;
    document.body.style.overflow = 'hidden';
    await loadPeople(1);
  }
  async function loadPeople(page) {
    const p = peopleCtx;
    if (!p) return;
    const params = Object.assign({ level: p.level, parent: p.parent, page, pageSize: 100 }, state.scope, p.filters);
    const url = `/api/dashboard/people?${qs(params)}`;
    const r = await fetch(url).then(x => x.json());
    if (!r.ok) return;
    const d = r.data;
    els.peopleCount.textContent = `共 ${d.total} 条`;
    els.peopleBody.innerHTML = '<table><thead><tr><th>姓名</th><th>性别</th><th>身份证号</th><th>手机号</th><th>出生日期</th><th>户籍（省市区）</th><th>关系</th><th>是否有记录</th></tr></thead><tbody>' +
      d.rows.map(rd => {
        const region = [rd.reg_province, rd.reg_city, rd.reg_district].filter(Boolean).join(' ') || '—';
        return `<tr><td>${esc(rd.name)}</td><td>${esc(rd.gender_name)}</td><td class="card-cell">${esc(rd.card_no)}</td><td>${esc(rd.mobile) || '—'}</td><td>${esc(rd.birth) || '—'}</td><td>${esc(region)}</td><td>${esc(rd.relation_label)}</td><td>${rd.hasRecord ? '是' : '否'}</td></tr>`;
      }).join('') + '</tbody></table>';
    els.peoplePager.innerHTML = pageLinks(d);
    bindPeoplePager(d);
  }
  function pageLinks(d) {
    if (d.totalPages <= 1) return '<button class="page-btn" disabled>‹</button><button class="page-btn active">1</button><button class="page-btn" disabled>›</button>';
    const p = d.page;
    const prev = p > 1 ? `<button class="page-btn" data-p="${p - 1}">‹</button>` : `<button class="page-btn" disabled>‹</button>`;
    const pages = [];
    for (let i = Math.max(1, p - 1); i <= Math.min(d.totalPages, p + 1); i++) pages.push(i);
    const core = pages.map(i => `<button class="page-btn ${i === p ? 'active' : ''}" data-p="${i}">${i}</button>`).join('');
    const next = p < d.totalPages ? `<button class="page-btn" data-p="${p + 1}">›</button>` : `<button class="page-btn" disabled>›</button>`;
    return prev + core + next;
  }
  function bindPeoplePager(d) {
    els.peoplePager.querySelectorAll('[data-p]').forEach(b => b.addEventListener('click', () => loadPeople(Number(b.dataset.p))));
  }
  function closePeople() { els.peopleDialog.hidden = true; els.peopleOverlay.hidden = true; document.body.style.overflow = ''; }
  els.btnPeopleClose.addEventListener('click', closePeople);
  els.peopleOverlay.addEventListener('click', closePeople);

  // ---------- 自适应与首屏 ----------
  function resizeAll() { Object.values(state.echarts).forEach(c => { try { c.resize(); } catch (e) {} }); }
  window.addEventListener('resize', resizeAll);

  function drawLoading() {
    ['#chartGender', '#chartSurname', '#chartRegion', '#chartRegionRank', '#chartBirthYear', '#chartBirthMonth', '#chartConstellation', '#chartAge', '#chartAgeStage', '#chartRelation', '#chartMobileProvince', '#chartCarrier'].forEach(selector => {
      const el = $(selector);
      if (!el) return;
      // 用 el.id（不带 #）作为 key，与 getChart 保持一致
      const key = el.id;
      const inst = state.echarts[key];
      if (inst) { try { inst.dispose(); } catch (e) {} delete state.echarts[key]; }
      el.innerHTML = '<div class="chart-loading">加载中…</div>';
    });
  }
  function toast(msg) {
    const t = $('#toast');
    if (!t) { alert(msg); return; }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // 进入看板视图时加载（由 auth.js 引导触发；确保仅在已登录且有权限时执行）
  if (window.APP_VIEW) {
    let dashLoaded = false;
    window.APP_VIEW.onShow('dashboard', () => {
      if (!dashLoaded) { dashLoaded = true; loadDashboard(); }
      setTimeout(resizeAll, 60);
    });
  }
})();