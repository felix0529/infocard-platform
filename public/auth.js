/**
 * 认证与会话管理（前端）+ 应用引导
 * - 全局 fetch 拦截：自动附加 Authorization，401 时跳转登录页
 * - 启动时校验会话、拉取当前用户 / 权限
 * - 基于权限生成并过滤左侧 Sidebar 导航，负责视图切换
 * - 右上角用户菜单：展示当前用户，支持修改密码 / 退出登录
 */
(function () {
  'use strict';

  const TOKEN_KEY = 'fj_token';
  const LOGIN_URL = './login.html';

  // ---------- 全局 fetch 拦截：自动加 token、401 跳登录 ----------
  const rawFetch = window.fetch;
  window.fetch = function (input, init) {
    init = init || {};
    init.headers = new Headers(init.headers || {});
    const token = localStorage.getItem(TOKEN_KEY);
    if (token && !init.headers.has('Authorization')) {
      init.headers.set('Authorization', 'Bearer ' + token);
    }
    return rawFetch(input, init).then(res => {
      if (res.status === 401 && !String(input).includes('/api/auth/login')) {
        localStorage.removeItem(TOKEN_KEY);
        if (!location.pathname.endsWith('login.html')) location.replace(LOGIN_URL);
        const err = new Error('未登录或会话已过期');
        err.__unauthorized = true;
        throw err;
      }
      return res;
    });
  };

  // ---------- 视图定义 ----------
  const VIEWS = {
    dashboard: { nav: 'navDash',      view: 'viewDash',      perm: 'dashboard:view', title: '数据看板', crumb: '首页 / 总览 / 数据看板' },
    list:      { nav: 'navList',      view: 'viewList',      perm: 'idcard:list',    title: '人员列表', crumb: '首页 / 管理 / 人员列表' },
    users:     { nav: 'navSysUsers',  view: 'viewSysUsers',  perm: 'system:user:view', title: '用户管理', crumb: '首页 / 系统 / 用户管理' },
    roles:     { nav: 'navSysRoles',  view: 'viewSysRoles',  perm: 'system:role:view', title: '角色管理', crumb: '首页 / 系统 / 角色管理' }
  };

  // 视图显示钩子（供 app.js / dashboard.js / sys.js 注册）
  const viewHooks = {};
  const APP_VIEW = {
    onShow(view, fn) { (viewHooks[view] = viewHooks[view] || []).push(fn); },
    notify(view) { (viewHooks[view] || []).forEach(fn => fn()); }
  };

  const state = {
    ready: false,
    user: null,
    isAdmin: false,
    roles: [],
    perms: []
  };

  const auth = {
    state,
    hasPerm(key) { return state.isAdmin || state.perms.includes(key); },
    canEditList() { return auth.hasPerm('idcard:edit'); },

    async ensure() {
      const token = localStorage.getItem(TOKEN_KEY);
      if (!token) { location.replace(LOGIN_URL); return false; }
      try {
        const res = await fetch('/api/auth/me', { cache: 'no-store' });
        if (res.status === 401) return false;
        if (!res.ok) { location.replace(LOGIN_URL); return false; }
        const d = (await res.json()).data;
        state.user = d.user;
        state.roles = d.roles || [];
        state.perms = d.perms || [];
        state.isAdmin = !!d.isAdmin || state.perms.includes('*');
        state.ready = true;
        return true;
      } catch (e) {
        if (e.__unauthorized) return false;
        state.ready = true;
        return true; // 网络异常时允许先用本地态渲染
      }
    },

    async whenReady() {
      await auth.ensure();
      return state.ready;
    },

    logout() {
      localStorage.removeItem(TOKEN_KEY);
      fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
      location.replace(LOGIN_URL);
    }
  };

  // ---------- 视图切换 ----------
  function permittedKeys() {
    return Object.keys(VIEWS).filter(k => auth.hasPerm(VIEWS[k].perm));
  }

  function switchView(key) {
    if (!VIEWS[key] || !auth.hasPerm(VIEWS[key].perm)) return;
    for (const k in VIEWS) {
      const v = document.getElementById(VIEWS[k].view);
      if (v) v.hidden = k !== key;
      const nav = document.getElementById(VIEWS[k].nav);
      if (nav) nav.classList.toggle('active', k === key);
    }
    updatePageHeader(key);
    document.dispatchEvent(new CustomEvent('app:view', { detail: key }));
    APP_VIEW.notify(key);
  }

  function updatePageHeader(key) {
    const meta = VIEWS[key];
    if (!meta) return;
    const title = document.getElementById('pageTitle');
    const crumb = document.getElementById('pageBreadcrumb');
    if (title) title.textContent = meta.title;
    if (crumb) crumb.textContent = meta.crumb;
    document.title = meta.title + ' · 身份信息管理';
  }

  // ---------- 页面引导（权限门控 + 导航装配） ----------
  function bootApp() {
    renderUserBadges();
    setupSidebar();

    // 1) 按权限隐藏导航项
    const keys = permittedKeys();
    for (const k in VIEWS) {
      const nav = document.getElementById(VIEWS[k].nav);
      if (nav) {
        nav.style.display = auth.hasPerm(VIEWS[k].perm) ? '' : 'none';
      }
    }
    // 隐藏空的分组标题
    document.querySelectorAll('.nav-group').forEach(g => {
      const visible = g.querySelectorAll('.nav-item:not([style*="display: none"])').length;
      g.style.display = visible ? '' : 'none';
    });

    // 2) 业务维护入口（新增身份按钮）
    const addBtn = document.getElementById('btnAdd');
    if (addBtn) addBtn.style.display = auth.canEditList() ? '' : 'none';

    // 3) 无任何可用页面
    if (keys.length === 0) {
      switchViewTo('viewNoPerm');
      document.getElementById('btnNoPermLogout') &&
        document.getElementById('btnNoPermLogout').addEventListener('click', auth.logout);
      return;
    }

    // 4) 绑定导航点击
    for (const k in VIEWS) {
      const nav = document.getElementById(VIEWS[k].nav);
      if (nav) nav.addEventListener('click', () => switchView(k));
    }

    // 5) 默认视图：优先数据看板，否则回退列表 / 第一个有权限的视图
    const def = keys.includes('dashboard') ? 'dashboard' : (keys.includes('list') ? 'list' : keys[0]);
    displayNoPerm(false);
    switchView(def);
  }

  function displayNoPerm(show) {
    const v = document.getElementById('viewNoPerm');
    if (v) v.hidden = !show;
  }
  function switchViewTo(id) {
    for (const k in VIEWS) {
      const v = document.getElementById(VIEWS[k].view);
      if (v) v.hidden = true;
      const nav = document.getElementById(VIEWS[k].nav);
      if (nav) nav.classList.remove('active');
    }
    const v = document.getElementById(id);
    if (v) v.hidden = false;
    document.getElementById('pageTitle').textContent = '无权限';
    document.getElementById('pageBreadcrumb').textContent = '首页 / 无权限';
  }

  // ---------- Sidebar 折叠 ----------
  function setupSidebar() {
    const app = document.getElementById('app');
    const toggles = [document.getElementById('sidebarToggle'), document.getElementById('headerToggle')];
    const collapsed = localStorage.getItem('fj_sidebar_collapsed') === '1';
    if (collapsed) app.classList.add('collapsed');

    function toggle() {
      const isCollapsed = app.classList.toggle('collapsed');
      localStorage.setItem('fj_sidebar_collapsed', isCollapsed ? '1' : '0');
    }
    toggles.forEach(btn => btn && btn.addEventListener('click', toggle));
  }

  // ---------- 轻量 Toast（auth.js 独立提供，避免依赖 app.js） ----------
  let toastTimer = null;
  function toast(msg, type) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast ' + (type || 'success') + ' show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  // ---------- 用户信息：右上角用户菜单 ----------
  function renderUserBadges() {
    const nick = state.user ? (state.user.nickname || state.user.username) : '';
    const first = nick ? nick.charAt(0) : '?';
    const roleText = state.isAdmin ? '超级管理员' : (state.roles.map(r => r.roleName).join('、') || '普通用户');

    const top = document.getElementById('userBadge');
    if (top) {
      top.innerHTML =
        '<span class="user-chip-avatar">' + first + '</span>' +
        '<span class="user-chip-name">' + nick + '</span>' +
        (state.isAdmin ? '<i class="user-chip-admin" title="超级管理员">A</i>' : '') +
        '<svg class="user-chip-arrow" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
    }

    const ddAvatar = document.getElementById('ddAvatar');
    const ddName = document.getElementById('ddName');
    const ddRole = document.getElementById('ddRole');
    if (ddAvatar) ddAvatar.textContent = first;
    if (ddName) ddName.textContent = nick || '-';
    if (ddRole) ddRole.textContent = roleText;
  }

  // ---------- 右上角用户下拉菜单 ----------
  function setupUserMenu() {
    const menu = document.getElementById('userMenu');
    const badge = document.getElementById('userBadge');
    const dd = document.getElementById('userDropdown');
    if (!menu || !badge || !dd) return;

    function open(show) {
      dd.hidden = !show;
      badge.setAttribute('aria-expanded', String(show));
    }

    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      open(dd.hidden);
    });
    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target)) open(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') open(false);
    });
  }

  // ---------- 修改当前用户密码 ----------
  function setupPwdDialog() {
    const overlay = document.getElementById('pwdOverlay');
    const dlg = document.getElementById('pwdDialog');
    const err = document.getElementById('pwdErr');
    if (!overlay || !dlg) return;

    function reset() {
      ['pOld', 'pNew', 'pNew2'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
      if (err) err.textContent = '';
      const btn = document.getElementById('btnPwdConfirm');
      if (btn) { btn.disabled = false; btn.textContent = '确认修改'; }
    }
    function openPwd() {
      reset();
      overlay.hidden = false;
      dlg.hidden = false;
      setTimeout(() => { const el = document.getElementById('pOld'); if (el) el.focus(); }, 30);
    }
    function closePwd() {
      overlay.hidden = true;
      dlg.hidden = true;
    }

    const btnChange = document.getElementById('btnChangePwd');
    if (btnChange) {
      btnChange.addEventListener('click', () => {
        const dd = document.getElementById('userDropdown');
        if (dd) dd.hidden = true;
        openPwd();
      });
    }
    const closeBtn = document.getElementById('btnPwdClose');
    if (closeBtn) closeBtn.addEventListener('click', closePwd);
    const cancelBtn = document.getElementById('btnPwdCancel');
    if (cancelBtn) cancelBtn.addEventListener('click', closePwd);
    overlay.addEventListener('click', closePwd);

    const confirmBtn = document.getElementById('btnPwdConfirm');
    if (confirmBtn) {
      confirmBtn.addEventListener('click', async () => {
        const oldP = (document.getElementById('pOld').value || '').trim();
        const n1 = document.getElementById('pNew').value;
        const n2 = document.getElementById('pNew2').value;
        if (!oldP) { if (err) err.textContent = '请输入原密码'; return; }
        if (n1.length < 6) { if (err) err.textContent = '新密码长度至少 6 位'; return; }
        if (n1.length > 32) { if (err) err.textContent = '新密码长度不能超过 32 位'; return; }
        if (n1 !== n2) { if (err) err.textContent = '两次输入的新密码不一致'; return; }
        confirmBtn.disabled = true;
        confirmBtn.textContent = '提交中…';
        try {
          const res = await fetch('/api/auth/password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldPassword: oldP, newPassword: n1 })
          });
          const j = await res.json().catch(() => ({}));
          if (!res.ok || !j.ok) throw new Error(j.message || '密码修改失败');
          closePwd();
          toast('密码修改成功', 'success');
        } catch (e) {
          if (err) err.textContent = e.message;
          confirmBtn.disabled = false;
          confirmBtn.textContent = '确认修改';
        }
      });
    }
    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !confirmBtn.disabled) confirmBtn.click();
    });
  }

  // ---------- 启动 ----------
  document.addEventListener('DOMContentLoaded', function () {
    const btn = document.getElementById('btnLogout');
    if (btn) btn.addEventListener('click', auth.logout);

    window.APP_AUTH = auth;
    window.APP_VIEW = APP_VIEW;

    setupUserMenu();
    setupPwdDialog();

    auth.whenReady().then(ok => {
      if (!ok) return; // 已跳转登录页
      bootApp();
    });
  });

  window.APP_AUTH = auth;
  window.APP_VIEW = APP_VIEW;
})();
