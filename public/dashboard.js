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
    viewList: $('#viewList'), viewDash: $('#viewDash'),
    hasRecordTrigger: $('#dashHasRecordTrigger'), hasRecordPanel: $('#dashHasRecordPanel'), hasRecordWrap: $('#dashHasRecordWrap'),
    relationWrap: $('#dashRelationWrap'), relationTrigger: $('#dashRelation'),
    relationPanel: $('#dashRelationPanel'), relationClear: $('#dashRelationClear'), relationOk: $('#dashRelationOk'),
    relationSelectAll: $('#dashRelationSelectAll'),
    tabs: $$('.dash-tab'), panePerson: $('#panePerson'), paneMobile: $('#paneMobile'), paneRegion: $('#paneRegion'),
    countsPerson: $('#countsPerson'), countsMobile: $('#countsMobile'),
    peopleDialog: $('#peopleDialog'), peopleOverlay: $('#peopleOverlay'),
    peopleBody: $('#peopleBody'), peopleCount: $('#peopleCount'),
    peoplePager: $('#peoplePager'), peopleTitle: $('#peopleTitle'),
    peopleSearch: $('#peopleSearch'), peopleSearchClear: $('#peopleSearchClear'),
    btnPeopleClose: $('#btnPeopleClose')
  };

  const state = {
    scope: { hasRecord: 'all', relations: [] },
    activeTab: 'person',
    regionCtx: { level: 'province', parent: '', cities: {}, districts: [] },
    echarts: {}
  };

  // ---------- 基础工具 ----------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  // 大数值压缩展示：统一使用 W（万）单位（保留一位小数并去掉多余的 .0）
  function bignum(n) {
    const v = Number(n);
    if (!isFinite(v)) return String(n == null ? '' : n);
    if (Math.abs(v) >= 1e4) return trim1(v / 1e4) + 'W';
    return String(v);
  }
  function trim1(x) { return String(Math.round(x * 10) / 10); }
  function qs(obj) {
    return Object.entries(obj)
      .filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0))
      .map(([k, v]) => `${k}=${encodeURIComponent(Array.isArray(v) ? v.join(',') : v)}`)
      .join('&');
  }
  // 关系标签统一由 relLabelText 解析（含自定义关系与无关系），见下方定义

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
  // 是否记录（单选框下拉，显示「是否记录：全部/是/否」）
  const HASREC_LABEL = { all: '全部', yes: '是', no: '否' };
  function syncHasRecordTrigger() {
    els.hasRecordTrigger.textContent = '是否记录：' + (HASREC_LABEL[state.scope.hasRecord] || '全部');
  }
  els.hasRecordTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    els.hasRecordPanel.hidden = !els.hasRecordPanel.hidden;
  });
  els.hasRecordPanel.addEventListener('change', (e) => {
    if (e.target.name !== 'dashHasRecord') return;
    state.scope.hasRecord = e.target.value;
    syncHasRecordTrigger();
    els.hasRecordPanel.hidden = true;
    loadDashboard();
  });
  // 点击面板外部关闭
  document.addEventListener('click', (e) => {
    if (!els.hasRecordPanel.hidden && !els.hasRecordWrap.contains(e.target)) els.hasRecordPanel.hidden = true;
  });
  syncHasRecordTrigger();

  // ---------- 关系多选筛选（默认全部；多选走实时聚合，含新增自定义关系零重建） ----------
  function relLabelText(v) {
    if (v == null || v === 'null') return '无关系';
    const relations = window.FJ_RELATIONS || [];   // 云端字典（app.js 启动时拉取并写入 window.FJ_RELATIONS）
    const hit = relations.find(r => String(r.value) === String(v));
    if (hit) return hit.label;
    return '自定义关系(' + v + ')';
  }
  function syncRelationTrigger() {
    const sel = state.scope.relations;
    if (!sel || !sel.length) els.relationTrigger.textContent = '关系：全部';
    else if (sel.length <= 2) els.relationTrigger.textContent = '关系：' + sel.map(relLabelText).join('、');
    else els.relationTrigger.textContent = `关系：已选 ${sel.length} 项`;
  }
  // 关系筛选 panel 从云端字典动态重建（无关系 + 内置 + 自定义），与 app.js 共用 window.FJ_RELATIONS
  function renderRelationPanel() {
    const relations = window.FJ_RELATIONS || [];
    const msActions = els.relationPanel.querySelector('.ms-actions');
    if (!msActions) return;
    // 清空旧的关系项（保留 .ms-actions 按钮区）
    Array.from(els.relationPanel.querySelectorAll('.ms-item')).forEach(el => el.remove());
    const items = [{ value: 'null', label: '无关系（NULL）' }, ...relations];
    for (const r of items) {
      const lbl = document.createElement('label');
      lbl.className = 'ms-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.value = String(r.value);
      lbl.appendChild(cb);
      lbl.appendChild(document.createTextNode(' ' + r.label));
      els.relationPanel.insertBefore(lbl, msActions);
    }
  }
  // 供 app.js 在字典刷新后调用（loadRelations 成功后重建看板关系筛选）
  window.__refreshDashboardRelations = renderRelationPanel;
  els.relationTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    els.relationPanel.hidden = !els.relationPanel.hidden;
  });
  els.relationOk.addEventListener('click', () => {
    els.relationPanel.hidden = true;
    const checked = Array.from(els.relationPanel.querySelectorAll('input[type=checkbox]:checked')).map(cb => cb.value);
    // 全选（含 null 在内所有项都被勾选）→ 视为"全部"，不传 relations，退化为统计表毫秒级
    const allBoxes = els.relationPanel.querySelectorAll('input[type=checkbox]');
    const isAll = checked.length === allBoxes.length;
    state.scope.relations = isAll ? [] : checked;
    syncRelationTrigger();
    loadDashboard();
  });
  els.relationClear.addEventListener('click', () => {
    els.relationPanel.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = false; });
    state.scope.relations = [];
    syncRelationTrigger();
    loadDashboard();
  });
  // 全选快捷操作：勾选全部关系项并立即生效（与「确定」的全选判定一致 → 视为全部，不传筛选）
  els.relationSelectAll.addEventListener('click', () => {
    els.relationPanel.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = true; });
    state.scope.relations = [];
    syncRelationTrigger();
    loadDashboard();
  });
  // 点击面板外部关闭
  document.addEventListener('click', (e) => {
    if (!els.relationPanel.hidden && !els.relationWrap.contains(e.target)) els.relationPanel.hidden = true;
  });
  syncRelationTrigger();

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
      renderCountsPerson(person);
      renderCountsMobile(mobile);
      renderChartsPerson(person);
      renderChartsMobile(mobile);
      // 渲染完成后触发 resize，确保 ECharts canvas 尺寸正确
      setTimeout(resizeAll, 0);
    } catch (e) {
      console.error('[dashboard]', e);
      // 兜底：加载/渲染失败时把 loading 占位替换为错误提示，避免界面一直停留在"加载中"
      const CHART_SELECTORS = ['#chartSurname', '#chartRegion', '#chartRegionRank', '#chartBirthYear', '#chartBirthMonth', '#chartConstellation', '#chartAge', '#chartAgeStage', '#chartRelation', '#chartMobileProvince', '#chartCarrier'];
      CHART_SELECTORS.forEach(selector => {
        const el = $(selector);
        if (el) el.innerHTML = '<div class="chart-loading">加载失败，请重试</div>';
      });
      toast('看板数据加载失败：' + ((e && e.message) || '未知错误'), 'error');
    }
  }

  // ---------- 统计卡 ----------
  function renderCountsPerson(p) {
    if (!p || !p.counts) return;
    const c = p.counts;
    const total = Number(c.total) || 0;
    const male = Number(c.male) || 0;
    const female = Number(c.female) || 0;
    const pct = (n) => (total > 0 ? ((n / total) * 100).toFixed(1) : '0') + '%';
    const items = [
      { l: '总人数', v: total, filters: {}, icon: 'users', color: 'blue' },
      { l: '男性', v: male, sub: '占比 ' + pct(male), filters: { gender: '1' }, icon: 'male', color: 'blue' },
      { l: '女性', v: female, sub: '占比 ' + pct(female), filters: { gender: '0' }, icon: 'female', color: 'pink' },
      { l: '本年新增', v: c.newThisYear, sub: '占比 ' + pct(c.newThisYear), filters: { yearAdd: '1' }, icon: 'new', color: 'green' }
    ];
    els.countsPerson.innerHTML = items.map((s, i) => renderStatCard(s, i)).join('');
    bindStatClicks(els.countsPerson, items);
  }
  function renderCountsMobile(m) {
    if (!m || !m.counts) return;
    const c = m.counts;
    const total = Number(c.total) || 0;
    const withM = Number(c.withMobile) || 0;
    const withoutM = Number(c.withoutMobile) || 0;
    const pct = (n) => (total > 0 ? ((n / total) * 100).toFixed(1) : '0') + '%';
    const items = [
      { l: '总人数', v: total, filters: {}, icon: 'users', color: 'blue' },
      { l: '已记录手机号', v: withM, sub: '占比 ' + pct(withM), filters: { hasMob: '1' }, icon: 'check', color: 'green' },
      { l: '待补手机号', v: withoutM, sub: '占比 ' + pct(withoutM), filters: { hasMob: '0' }, icon: 'alert', color: 'orange' }
    ];
    els.countsMobile.innerHTML = items.map((s, i) => renderStatCard(s, i)).join('');
    bindStatClicks(els.countsMobile, items);
  }

  // 统计卡：左侧图标 + 右侧数据（label/value/unit + 可选占比副行），更丰富的颜色与层次
  const STAT_ICONS = {
    users: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    male: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M12 12v7"/><path d="m9 21 3-3 3 3"/></svg>',
    female: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="7" r="4"/><path d="M12 11v8"/><path d="M8 16h8"/></svg>',
    new: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="M9 15h6"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    clock: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    alert: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
  };
  function renderStatCard(s, i) {
    const icon = STAT_ICONS[s.icon] || '';
    const clickable = s.click !== false;
    const sub = s.sub != null ? `<div class="stat-sub">${s.sub}</div>` : '';
    return `<div class="dash-stat ${clickable ? 'dash-stat-click' : ''} stat-${s.color}" data-i="${i}">
      <div class="stat-icon">${icon}</div>
      <div class="stat-body">
        <div class="stat-label">${s.l}</div>
        <div class="stat-value">${bignum(s.v)}<span class="stat-unit">人</span></div>
        ${sub}
      </div>
    </div>`;
  }
  // 统计卡点击：打开明细弹窗（带对应过滤条件）；click === false 的卡不响应
  function bindStatClicks(container, items) {
    container.querySelectorAll('[data-i]').forEach(el => el.addEventListener('click', () => {
      const s = items[Number(el.dataset.i)];
      if (!s || s.click === false) return;
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

  // 数值轴配置工厂：刻度与数据标签统一使用 W（万）压缩格式，保证大数值下纵坐标可读、不挤占
  function valAxisDef() { return { type: 'value', axisLabel: { formatter: bignum } }; }
  function barOption(items, { horizontal = false, hideLabels = false } = {}) {
    const data = items || [];
    const names = data.map(d => d.key);
    const vals = data.map(d => Number(d.count) || 0);
    const catAxis = { type: 'category', data: names, axisLabel: { rotate: 40 } };
    const catAxisH = { type: 'category', data: names, inverse: true };
    return {
      grid: horizontal ? { left: 10, right: 50, top: 20, bottom: 20, containLabel: true } : { left: 48, right: 20, top: 30, bottom: 40 },
      tooltip: { trigger: 'axis', formatter: (ps) => (ps || []).map(p => `${p.name}: ${bignum(p.value)} 人`).join('<br/>') },
      xAxis: horizontal ? valAxisDef() : catAxis,
      yAxis: horizontal ? catAxisH : valAxisDef(),
      series: [{ type: 'bar', data: vals, barMaxWidth: 22, itemStyle: { color: '#4353f7', borderRadius: 4 },
        label: { show: !hideLabels, position: horizontal ? 'right' : 'top', color: '#4b5563', fontSize: 10, formatter: (p) => bignum(p.value) } }]
    };
  }
  function pieOption(items, { startAngle = 90 } = {}) {
    const data = (items || []).filter(d => Number(d.count) > 0)
      .map((d, i) => ({ name: String(d.key == null ? '未知' : d.key), value: Number(d.count), itemStyle: { color: PALETTE[i % PALETTE.length] }, _origKey: d.origKey }));
    const total = data.reduce((s, d) => s + d.value, 0) || 1;
    return {
      tooltip: { trigger: 'item', formatter: (p) => `${p.name}: ${bignum(p.value)} 人 (${p.percent}%)` },
      // 图例置于底部，完整展示「名称 + 人数 + 占比」，超出自动横向滚动
      legend: {
        bottom: 0, left: 'center', type: 'scroll',
        icon: 'circle', itemWidth: 8, itemHeight: 8, itemGap: 10,
        textStyle: { fontSize: 11, color: '#4b5563' },
        formatter: (name) => {
          const d = data.find(x => x.name === name);
          return d ? `${name} ${bignum(d.value)}人 ${(d.value / total * 100).toFixed(1)}%` : name;
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
        emphasis: { scale: true, scaleSize: 4, label: { show: true, position: 'inside', formatter: (p) => `${p.name} ${bignum(p.value)}人 ${p.percent}%` } },
        data
      }]
    };
  }

  // 折线图：仅高亮 Top1（唯一更大圆点 + 值标签，其余点不显示标签避免重叠）
  function top1LineOption(items, nameUnit = '') {
    const names = (items || []).map(d => d.key);
    const vals = (items || []).map(d => Number(d.count) || 0);
    const rank = vals.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v).slice(0, 1);
    const topIdx = new Set(rank.map(r => r.i));
    const mark = rank.map(r => ({ coord: [String(names[r.i]), vals[r.i]], value: vals[r.i] }));
    return {
      grid: { left: 48, right: 24, top: 40, bottom: 40 },
      tooltip: { trigger: 'axis', formatter: (ps) => (ps || []).map(p => `${p.name}${nameUnit}: ${bignum(p.value)} 人`).join('<br/>') },
      xAxis: { type: 'category', data: names, axisLabel: { rotate: 40 } },
      yAxis: { type: 'value', axisLabel: { formatter: bignum } },
      series: [{
        type: 'line', smooth: true, data: vals,
        symbolSize: (v, p) => topIdx.has(p.dataIndex) ? 12 : 5,
        itemStyle: { color: '#4353f7' },
        lineStyle: { width: 2.5 },
        label: { show: true, position: 'top', color: '#d97706', fontWeight: 700, formatter: (p) => topIdx.has(p.dataIndex) ? bignum(p.value) : '' },
        markPoint: { symbol: 'pin', symbolSize: 42, itemStyle: { color: '#ec5d8f' }, label: { formatter: (p) => bignum(p.value) }, data: mark }
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
      grid: { top: 20, bottom: 20, left: 60, right: 34, containLabel: true },
      tooltip: { trigger: 'axis', formatter: (ps) => (ps || []).map(p => `${p.name}: ${bignum(p.value)} 人`).join('<br/>') },
      xAxis: { type: 'value', axisLabel: { formatter: bignum } },
      yAxis: { type: 'category', data: names, inverse: true },
      series: [{ type: 'bar', data: vals, barMaxWidth: 20, label: { show: true, position: 'right', color: '#4b5563', formatter: (p) => bignum(p.value) }, itemStyle: { color: '#4353f7', borderRadius: 4 } }]
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
      grid: { left: 48, right: 20, top: 32, bottom: 56 },
      tooltip: { trigger: 'axis', formatter: (ps) => (ps || []).map(p => `${p.name}: ${bignum(p.value)} 人`).join('<br/>') },
      xAxis: {
        type: 'category', data: names,
        // 标签拆成两行（阶段名 / 括号年龄范围分行），避免长标签横排重叠
        axisLabel: { interval: 0, rotate: 0, fontSize: 9, lineHeight: 12, formatter: (v) => String(v).replace('（', '\n（') }
      },
      yAxis: { type: 'value', axisLabel: { formatter: bignum } },
      series: [{ type: 'bar', data: vals, barMaxWidth: 26, label: { show: true, position: 'top', color: '#4b5563', fontSize: 10, formatter: (p) => bignum(p.value) }, itemStyle: { color: '#4353f7', borderRadius: 4 } }]
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
    // 姓氏：横向条形图，点击条按姓氏下钻
    safeRender('#chartSurname', () => renderSurname(arr(p.surname)), (param) => {
      if (!param || !param.name) return;
      openPeopleDialog({ label: `姓氏：${param.name}`, filters: { surname: param.name } });
    });
    // 出生年份：折线图，点击点按年份下钻
    safeRender('#chartBirthYear', (c) => c.setOption(top1LineOption(arr(p.birthYear), '年')), (param) => {
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
    // 年龄：折线图（横坐标按年龄从小到大排序），点击点按年龄下钻
    const ageSorted = arr(p.age).slice().sort((a, b) => (Number(a.key) || 0) - (Number(b.key) || 0));
    safeRender('#chartAge', (c) => c.setOption(top1LineOption(ageSorted, '岁')), (param) => {
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
    // 标签用 relLabelText（含内置 + 自定义关系 + 无关系），避免自定义/无关系被误显示成"其他"
    const relItems = arr(p.relation).map(r => ({ key: relLabelText(r.key), origKey: r.key, count: r.count }))
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
    // 手机归属地：柱形图，点击柱按归属地下钻（数据必须传原始数值，压缩格式由 barOption 的坐标轴/标签统一处理；
    // hideLabels 关闭柱顶数值标签，避免省份较多时标签互相重叠）
    // 需求：只统计有手机号的 —— 过滤 __null__（无手机号人群）
    const provData = arr(m.mobileProvince)
      .filter(d => d.key != null && d.key !== '__null__')
      .map(d => ({ key: d.key, count: Number(d.count) }));
    safeRender('#chartMobileProvince', (c) => c.setOption(barOption(provData, { hideLabels: true })), (param) => {
      if (!param || param.name == null) return;
      openPeopleDialog({ label: `手机归属地：${param.name}`, filters: { mobileProvince: param.name } });
    });
    // 运营商：环形图，点击切片按运营商下钻（同样过滤 __null__，只统计有手机号）
    const carrierData = arr(m.carrier)
      .filter(d => d.key != null && d.key !== '__null__')
      .map(d => ({ key: d.key, count: Number(d.count) }));
    safeRender('#chartCarrier', (c) => c.setOption(pieOption(carrierData)), (param) => {
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
      tooltip: { trigger: 'item', formatter: (p) => `${p.name}: ${bignum(p.value == null ? 0 : p.value)} 人` },
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
          // 有数据的省份显示"名称+压缩人数"两行；无数据的省份仅单行名称，减少标签占位
          formatter: (p) => (Number(p.value) > 0) ? `${p.name}\n${bignum(p.value)}` : p.name
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
      grid: { left: 8, right: 40, top: 8, bottom: 8, containLabel: true },
      tooltip: { trigger: 'axis', formatter: p => (p[0] ? `${p[0].name}: ${bignum(p[0].value)} 人` : '') },
      xAxis: { type: 'value', axisLabel: { formatter: bignum } },
      yAxis: { type: 'category', data: data.map(d => d.name), inverse: true, axisLabel: { fontSize: 10 } },
      series: [{ type: 'bar', data: data.map(d => ({ name: d.name, value: d.value })), barMaxWidth: 16,
        itemStyle: { color: '#4353f7', borderRadius: 3 },
        label: { show: true, position: 'right', color: '#4b5563', fontSize: 10, formatter: (p) => bignum(p.value) },
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
  let peopleSeq = 0; // 明细请求序号：切换下钻后递增，过期的异步响应被丢弃，避免串显示上一次下钻的明细
  async function openPeopleDialog(opts) {
    const o = opts || {};
    peopleCtx = { seq: ++peopleSeq, level: o.level || '', parent: o.parent || '', label: o.label || '明细', filters: o.filters || {} };
    els.peopleTitle.textContent = peopleCtx.label;
    // 每次打开新明细都重置搜索条件（姓名/身份证号/手机号模糊匹配）
    els.peopleSearch.value = '';
    els.peopleSearchClear.hidden = true;
    // 立即清空旧明细并进入加载态，防止切换下钻时残留上一条明细
    els.peopleCount.textContent = '查询中…';
    els.peopleBody.innerHTML = '<div class="people-loading">正在查询明细…</div>';
    els.peoplePager.innerHTML = '';
    els.peopleDialog.hidden = false;
    els.peopleOverlay.hidden = false;
    document.body.style.overflow = 'hidden';
    await loadPeople(1);
  }
  // 搜索：回车触发（与列表页交互一致），回到第一页加载
  els.peopleSearch.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!peopleCtx) return;
    loadPeople(1);
  });
  els.peopleSearch.addEventListener('input', () => {
    els.peopleSearchClear.hidden = !els.peopleSearch.value;
  });
  els.peopleSearchClear.addEventListener('click', () => {
    els.peopleSearch.value = '';
    els.peopleSearchClear.hidden = true;
    if (peopleCtx) loadPeople(1);
  });
  async function loadPeople(page) {
    const p = peopleCtx;
    if (!p) return;
    const mySeq = p.seq;
    // 合并全局 relations 与图表点击下钻的 relation 过滤（取交集，避免 Object.assign 覆盖导致口径丢失）
    const baseScope = { ...state.scope };
    const relFilter = p.filters.relation;
    if (relFilter != null) {
      const rf = String(relFilter);
      const cur = baseScope.relations || [];
      if (!cur.length) baseScope.relations = [rf];
      else baseScope.relations = cur.filter(v => v === rf); // 取交集
      // 注意：不能 delete p.filters.relation —— peopleCtx 会在翻页/关键词搜索时复用，
      // 删除后第二次 loadPeople 将丢失关系筛选，导致翻页加载全量数据。
      // 关系筛选已并入 baseScope.relations，构造 params 时显式排除单值 relation 即可。
    }
    const params = Object.assign({ level: p.level, parent: p.parent, page, pageSize: 100 }, baseScope);
    for (const [k, v] of Object.entries(p.filters || {})) {
      if (k === 'relation') continue; // 已并入 baseScope.relations（见上方合并逻辑）
      params[k] = v;
    }
    // 明细弹窗关键词模糊匹配：姓名/身份证号/手机号（空值由 qs() 自动过滤）
    const kw = els.peopleSearch.value.trim();
    if (kw) params.q = kw;
    const url = `/api/dashboard/people?${qs(params)}`;
    try {
      const r = await fetch(url).then(x => x.json());
      if (!r.ok) throw new Error(r.message || '明细加载失败');
      if (!peopleCtx || peopleCtx.seq !== mySeq) return; // 已切换到别的下钻，丢弃本次过期响应
      const d = r.data;
    els.peopleCount.textContent = `共 ${Number(d.total).toLocaleString('zh-CN')} 条`;
    els.peopleBody.innerHTML = '<table><thead><tr><th>姓名</th><th>性别</th><th>身份证号</th><th>手机号</th><th>出生日期</th><th>户籍（省市区）</th><th>关系</th><th>是否有记录</th><th class="col-op"><span class="col-op-inner">操作</span></th></tr></thead><tbody>' +
      d.rows.map(rd => {
        const region = [rd.reg_province, rd.reg_city, rd.reg_district].filter(Boolean).join(' ') || '—';
        return `<tr><td>${esc(rd.name)}</td><td>${esc(rd.gender_name)}</td><td class="card-cell">${esc(rd.card_no)}</td><td>${esc(rd.mobile) || '—'}</td><td>${esc(rd.birth) || '—'}</td><td title="${esc(region)}">${esc(region)}</td><td>${esc(rd.relation_label)}</td><td>${rd.hasRecord ? '是' : '否'}</td><td class="col-op"><span class="col-op-inner"><button class="row-btn view" data-action="view" data-id="${rd.id}" title="查看详情" aria-label="查看详情"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg></button></span></td></tr>`;
      }).join('') + '</tbody></table>';
    els.peoplePager.innerHTML = pageLinks(d);
    bindPeoplePager(d);
    } catch (err) {
      // 明细加载失败：明确提示，避免误以为弹窗还停留在上一次的数据
      console.error('[dashboard.people]', err);
      if (!peopleCtx || peopleCtx.seq !== mySeq) return;
      els.peopleCount.textContent = '加载失败';
      els.peopleBody.innerHTML = '<div class="people-loading">明细加载失败：' + esc((err && err.message) || '未知错误') + '</div>';
      els.peoplePager.innerHTML = '';
    }
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

  // 明细行“查看详情”：在当前页面直接打开该人员详情（不关闭明细弹窗、不跳转），
  // 关闭详情后明细弹窗原样保留，可继续查看下一条
  function viewDetail(id) {
    if (id == null) return;
    if (typeof window.openDetail === 'function') window.openDetail({ id });
    else toast('无法打开详情页');
  }
  els.peopleBody.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="view"]');
    if (!btn) return;
    viewDetail(Number(btn.dataset.id));
  });

  // ---------- 自适应与首屏 ----------
  function resizeAll() { Object.values(state.echarts).forEach(c => { try { c.resize(); } catch (e) {} }); }
  window.addEventListener('resize', resizeAll);

  function drawLoading() {
    ['#chartSurname', '#chartRegion', '#chartRegionRank', '#chartBirthYear', '#chartBirthMonth', '#chartConstellation', '#chartAge', '#chartAgeStage', '#chartRelation', '#chartMobileProvince', '#chartCarrier'].forEach(selector => {
      const el = $(selector);
      if (!el) return;
      // 用 el.id（不带 #）作为 key，与 getChart 保持一致
      const key = el.id;
      const inst = state.echarts[key];
      if (inst) { try { inst.dispose(); } catch (e) {} delete state.echarts[key]; }
      el.innerHTML = '<div class="chart-loading">加载中…</div>';
    });
  }
  // 进入看板视图时加载（由 auth.js 引导触发；确保仅在已登录且有权限时执行）
  if (window.APP_VIEW) {
    let dashLoaded = false;
    window.APP_VIEW.onShow('dashboard', () => {
      renderRelationPanel();   // 每次进入看板都按最新云端字典重建关系筛选
      if (!dashLoaded) { dashLoaded = true; loadDashboard(); }
      setTimeout(resizeAll, 60);
    });
  }
})();