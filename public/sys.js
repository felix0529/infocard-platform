/**
 * 系统管理 —— 用户管理 / 角色管理（RBAC 界面）
 * - 用户：增删改、启停、分配角色（一个用户可绑定多个角色，权限取并集）
 * - 角色：增删改、权限分配、启停（业务维度、可复用）
 * - 内置超级管理员 admin 固定拥有全部权限，不做数据过滤，不可删除/禁用
 */
(function () {
  'use strict';
  if (!window.APP_AUTH) return;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const els = {
    search: document.getElementById('sysUserSearch'),
    btnAddUser: document.getElementById('btnAddUser'),
    btnAddRole: document.getElementById('btnAddRole'),
    userBody: document.getElementById('sysUserBody'),
    userEmpty: document.getElementById('sysUserEmpty'),
    userCount: document.getElementById('sysUserCount'),
    roleBody: document.getElementById('sysRoleBody'),
    roleEmpty: document.getElementById('sysRoleEmpty'),
    roleCount: document.getElementById('sysRoleCount')
  };

  let rolesCache = [];   // 角色列表
  let permsCache = [];   // 权限清单
  let usersCache = [];
  let searchTerm = '';

  // ---------- 工具 ----------
  async function api(path, opts) {
    const res = await fetch(path, {
      method: (opts && opts.method) || 'GET',
      headers: opts && opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts && opts.body ? JSON.stringify(opts.body) : undefined
    });
    const j = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error('登录已过期');
    if (!res.ok || !j.ok) throw new Error(j.message || res.statusText || '操作失败');
    return j;
  }
  function openOverlay(id) { const o = document.getElementById(id); if (o) o.hidden = false; }
  function closeOverlay(id) { const o = document.getElementById(id); if (o) o.hidden = true; }

  // ---------- 用户 ----------
  async function loadUsers() {
    try {
      const j = await api('/api/system/users');
      usersCache = j.data || [];
      renderUsers();
    } catch (e) { toast(e.message, 'error'); }
  }
  function renderUsers() {
    const q = searchTerm;
    const list = q ? usersCache.filter(u => (u.username + ' ' + u.nickname).includes(q)) : usersCache;
    els.userCount.textContent = `共 ${list.length} 个用户`;
    if (!list.length) { els.userBody.innerHTML = ''; els.userEmpty.hidden = false; return; }
    els.userEmpty.hidden = true;
    els.userBody.innerHTML = list.map(u => {
      const rolesHtml = u.roles.length
        ? u.roles.map(r => `<span class="rel-tag${r.isAdmin ? ' admin' : ''}">${esc(r.roleName)}</span>`).join('')
        : '<span class="dim">未分配角色</span>';
      const statusHtml = u.status === '1'
        ? `<span class="st-enable" data-uid="${u.id}" title="点击禁用">启用</span>`
        : `<span class="st-disable" data-uid="${u.id}" title="点击启用">禁用</span>`;
      const canEdit = u.username !== 'admin';
      const actions = `
        <button class="row-btn edit" data-act="edit" data-uid="${u.id}" title="编辑 / 分配角色">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
        </button>
        ${canEdit ? `
        <button class="row-btn del" data-act="del" data-uid="${u.id}" title="删除">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
        </button>` : ''}`;
      const self = window.APP_AUTH.state.user && window.APP_AUTH.state.user.id === u.id;
      return `<tr>
        <td>${esc(u.username)}${u.isAdmin ? '<span class="crow-admin">超管</span>' : ''}${self ? '<span class="crow-self">当前</span>' : ''}</td>
        <td>${esc(u.nickname)}</td>
        <td>${statusHtml}</td>
        <td><div class="rel-list">${rolesHtml}</div></td>
        <td><div class="row-actions">${actions}</div></td>
      </tr>`;
    }).join('');
  }

  // ---------- 角色 ----------
  async function loadRoles() {
    try {
      const [r, p] = await Promise.all([api('/api/system/roles'), api('/api/system/perms')]);
      rolesCache = r.data || [];
      permsCache = p.data || [];
      renderRoles();
    } catch (e) { toast(e.message, 'error'); }
  }
  function renderRoles() {
    els.roleCount.textContent = `共 ${rolesCache.length} 个角色`;
    if (!rolesCache.length) { els.roleBody.innerHTML = ''; els.roleEmpty.hidden = false; return; }
    els.roleEmpty.hidden = true;
    els.roleBody.innerHTML = rolesCache.map(r => {
      const permsHtml = r.isAdmin
        ? '<span class="dim">全部权限（超级管理员）</span>'
        : (r.perms && r.perms.length
            ? r.perms.map(p => { const pm = permsCache.find(x => x.key === p); return `<span class="rel-tag">${esc(pm ? pm.name : p)}</span>`; }).join('')
            : '<span class="dim">未分配权限</span>');
      const statusHtml = r.isAdmin
        ? '<span class="st-enable" title="内置角色，不可禁用">启用</span>'
        : (r.status === '1'
            ? `<span class="st-enable toggle" data-rid="${r.id}" title="点击禁用：该角色下所有用户将失去权限">启用</span>`
            : `<span class="st-disable toggle" data-rid="${r.id}" title="点击启用">禁用</span>`);
      const actions = `
        <button class="row-btn edit" data-act="edit" data-rid="${r.id}" title="编辑 / 分配权限">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
        </button>
        ${!r.isAdmin ? `
        <button class="row-btn del" data-act="del" data-rid="${r.id}" title="删除">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
        </button>` : ''}`;
      return `<tr>
        <td>${esc(r.roleName)}${r.isAdmin ? '<span class="crow-admin">内置</span>' : ''}</td>
        <td><span class="mono key">${esc(r.roleKey)}</span></td>
        <td>${statusHtml}</td>
        <td>${r.userCount}</td>
        <td><div class="rel-list">${permsHtml}</div></td>
        <td><div class="row-actions">${actions}</div></td>
      </tr>`;
    }).join('');
  }

  // ---------- 权限分组 ----------
  function groupPerms() {
    const map = {};
    (permsCache || []).forEach(p => { (map[p.group] = map[p.group] || []).push(p); });
    return map;
  }

  // ---------- 事件委托 ----------
  els.userBody.addEventListener('click', (e) => {
    const st = e.target.closest('.st-enable, .st-disable');
    if (st) { const uid = st.getAttribute('data-uid'); if (uid) return setUserStatus(uid); }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const uid = btn.getAttribute('data-uid');
    if (btn.dataset.act === 'edit' && uid) return openUserDialog(Number(uid));
    if (btn.dataset.act === 'del' && uid) return confirmDelUser(Number(uid));
  });
  els.roleBody.addEventListener('click', (e) => {
    const st = e.target.closest('.toggle');
    if (st) { const rid = st.getAttribute('data-rid'); if (rid) return setRoleStatus(rid); }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const rid = btn.getAttribute('data-rid');
    if (btn.dataset.act === 'edit' && rid) return openRoleDialog(Number(rid));
    if (btn.dataset.act === 'del' && rid) return confirmDelRole(Number(rid));
  });

  els.btnAddUser.addEventListener('click', () => openUserDialog());
  els.btnAddRole.addEventListener('click', () => openRoleDialog());
  els.search.addEventListener('input', (e) => { searchTerm = e.target.value.trim(); renderUsers(); });

  // ---------- 用户：状态 / 增删 / 弹窗 ----------
  async function setUserStatus(uid) {
    const u = usersCache.find(x => x.id === Number(uid));
    if (!u || u.username === 'admin') return;
    try { await api('/api/system/users/' + uid, { method: 'PUT', body: { status: u.status === '1' ? '0' : '1' } }); toast('状态已更新'); loadUsers(); }
    catch (e) { toast(e.message, 'error'); }
  }
  function openUserDialog(uid) {
    const u = uid ? usersCache.find(x => x.id === uid) : null;
    const isAdminUser = !!(u && u.username === 'admin');
    const roleOpts = rolesCache.map(r => {
      const checked = u ? u.roles.some(x => x.id === r.id) : false;
      return `<label class="chk"><input type="checkbox" name="urole" value="${r.id}" ${checked ? 'checked' : ''} ${r.status === '0' ? 'disabled' : ''} ${isAdminUser ? 'disabled' : ''}/><span>${esc(r.roleName)}${r.status === '0' ? '（已禁用）' : ''}</span></label>`;
    }).join('');
    const html = `
      <div class="overlay" id="sysUserOverlay" hidden></div>
      <div class="dialog" id="sysUserDialog" role="dialog" aria-modal="true">
        <div class="dialog-head"><h3>${u ? '编辑用户' : '新增用户'}</h3><button class="icon-btn" data-x="user">✕</button></div>
        <p class="dialog-sub">${isAdminUser ? '内置管理员不可删除/禁用，角色固定为超级管理员。' : '一个用户可绑定多个角色，权限取并集。'}</p>
        <div class="field"><label>用户名</label><input id="sysIfName" value="${u ? esc(u.username) : ''}" ${u ? 'readonly' : ''} maxlength="32" placeholder="登录用户名"/></div>
        <div class="field"><label>昵称</label><input id="sysIfNick" value="${u ? esc(u.nickname) : ''}" maxlength="20" placeholder="显示名称"/></div>
        <div class="field"><label>密码 ${u ? '（留空则不修改）' : '<em>*</em>'}</label><input id="sysIfPwd" type="password" maxlength="32" autocomplete="new-password" placeholder="${u ? '不修改密码请留空' : '至少 6 位'}"/></div>
        <div class="field"><label>状态</label>
          <div class="seg"><button type="button" class="seg-btn active" data-on="1" id="sysIfOn">启用</button><button type="button" class="seg-btn" data-on="0" id="sysIfOff">禁用</button></div>
        </div>
        <div class="field"><label>分配角色</label><div class="chk-grid" id="sysUserRoles">${roleOpts}</div></div>
        <p class="sys-err" id="sysUserErr"></p>
        <div class="dialog-actions">
          <button class="btn" data-x="user">取消</button>
          <button class="btn btn-primary" id="sysUserSave">${u ? '保存' : '创建'}</button>
        </div>
      </div>`;
    mountDialog('sysUserOverlay', 'sysUserDialog', html, () => {
      let status = u ? u.status : '1';
      document.getElementById('sysIfOn').onclick = () => { status = '1'; setSeg('user', '1'); };
      document.getElementById('sysIfOff').onclick = () => { status = '0'; setSeg('user', '0'); };
      setSeg('user', status);
      document.getElementById('sysUserSave').onclick = async () => {
        const body = {
          nickname: document.getElementById('sysIfNick').value.trim(),
          status,
          roleIds: Array.from(document.querySelectorAll('#sysUserRoles input[name="urole"]:checked')).map(i => Number(i.value))
        };
        if (!u) {
          body.username = document.getElementById('sysIfName').value.trim();
          body.password = document.getElementById('sysIfPwd').value;
        } else {
          const pwd = document.getElementById('sysIfPwd').value;
          if (pwd) body.password = pwd;
          if (isAdminUser) delete body.roleIds;
        }
        try {
          if (u) await api('/api/system/users/' + u.id, { method: 'PUT', body });
          else await api('/api/system/users', { method: 'POST', body });
          unmountDialog('sysUserOverlay', 'sysUserDialog');
          toast('保存成功'); loadUsers(); loadRoles();
        } catch (e) { document.getElementById('sysUserErr').textContent = e.message; }
      };
    });
  }

  // ---------- 角色：状态 / 增删 / 弹窗 ----------
  async function setRoleStatus(rid) {
    const r = rolesCache.find(x => x.id === Number(rid));
    if (!r || r.isAdmin) return;
    if (r.status === '1') {
      if (!confirm('禁用后，该角色下所有用户将立即失去对应权限。确认禁用此角色？')) return;
      await api('/api/system/roles/' + rid + '/status', { method: 'PUT', body: { status: '0' } });
    } else {
      await api('/api/system/roles/' + rid + '/status', { method: 'PUT', body: { status: '1' } });
    }
    toast('角色状态已更新'); loadRoles(); loadUsers();
  }
  function openRoleDialog(rid) {
    const r = rid ? rolesCache.find(x => x.id === rid) : null;
    const isAdmin = !!(r && r.isAdmin);
    const groups = groupPerms();
    const permHtml = Object.keys(groups).map(g => {
      const items = groups[g].map(p => {
        const checked = isAdmin || (r && (r.perms || []).includes(p.key));
        return `<label class="chk"><input type="checkbox" name="rperm" value="${p.key}" ${checked ? 'checked' : ''} ${isAdmin ? 'disabled' : ''}/><span>${esc(p.name)}</span></label>`;
      }).join('');
      return `<div class="perm-group"><div class="perm-group-name">${esc(g)}</div><div class="chk-grid">${items}</div></div>`;
    }).join('');
    const html = `
      <div class="overlay" id="sysRoleOverlay" hidden></div>
      <div class="dialog" id="sysRoleDialog" role="dialog" aria-modal="true">
        <div class="dialog-head"><h3>${r ? '编辑角色' : '新增角色'}</h3><button class="icon-btn" data-x="role">✕</button></div>
        <p class="dialog-sub">${isAdmin ? '内置超级管理员角色：拥有全部权限，不可修改/禁用/删除。' : '角色按业务维度复用，避免一人一角色。'}</p>
        <div class="dialog-grid2">
          <div class="field"><label>角色名称 <em>*</em></label><input id="sysIfRoleName" value="${r ? esc(r.roleName) : ''}" ${isAdmin ? 'readonly' : ''} maxlength="20" placeholder="如：名单专员"/></div>
          <div class="field"><label>角色标识 <em>*</em></label><input id="sysIfRoleKey" value="${r ? esc(r.roleKey) : ''}" ${r ? 'readonly' : ''} maxlength="32" placeholder="如：r_clerk"/></div>
        </div>
        <div class="field"><label>备注</label><input id="sysIfRemark" value="${r ? esc(r.remark) : ''}" ${isAdmin ? 'readonly' : ''} maxlength="100" placeholder="选填"/></div>
        <div class="field"><label>状态</label>
          <div class="seg"><button type="button" class="seg-btn active" data-on="1" id="sysIfStOn">启用</button><button type="button" class="seg-btn" data-on="0" id="sysIfStOff">禁用</button></div>
        </div>
        <div class="field"><label>功能权限</label>${permHtml}</div>
        <p class="sys-err" id="sysRoleErr"></p>
        <div class="dialog-actions">
          <button class="btn" data-x="role">取消</button>
          <button class="btn btn-primary" id="sysRoleSave">${r ? '保存' : '创建'}</button>
        </div>
      </div>`;
    mountDialog('sysRoleOverlay', 'sysRoleDialog', html, () => {
      let status = r ? r.status : '1';
      if (!isAdmin) {
        document.getElementById('sysIfStOn').onclick = () => { status = '1'; setSeg('role', '1'); };
        document.getElementById('sysIfStOff').onclick = () => { status = '0'; setSeg('role', '0'); };
      }
      setSeg('role', status, isAdmin);
      const dlgNode = document.getElementById('__sysRoleDialog');
      document.getElementById('sysRoleSave').onclick = async () => {
        const body = {
          roleName: document.getElementById('sysIfRoleName').value.trim(),
          status,
          remark: document.getElementById('sysIfRemark').value.trim(),
          perms: Array.from(dlgNode.querySelectorAll('input[name="rperm"]:checked')).map(i => i.value)
        };
        try {
          if (r) await api('/api/system/roles/' + r.id, { method: 'PUT', body });
          else { body.roleKey = document.getElementById('sysIfRoleKey').value.trim(); await api('/api/system/roles', { method: 'POST', body }); }
          unmountDialog('sysRoleOverlay', 'sysRoleDialog');
          toast('保存成功'); loadRoles();
        } catch (e) { document.getElementById('sysRoleErr').textContent = e.message; }
      };
    });
  }

  // ---------- 删除确认 ----------
  function confirmDelUser(uid) {
    const u = usersCache.find(x => x.id === uid);
    buildConfirm('删除用户', `确认删除用户「${esc(u ? u.username : '')}」？此操作不可撤销。`, async () => {
      try { await api('/api/system/users/' + uid, { method: 'DELETE' }); toast('已删除'); loadUsers(); }
      catch (e) { toast(e.message, 'error'); }
    });
  }
  function confirmDelRole(rid) {
    const r = rolesCache.find(x => x.id === rid);
    buildConfirm('删除角色', `确认删除角色「${esc(r ? r.roleName : '')}」？`, async () => {
      try { await api('/api/system/roles/' + rid, { method: 'DELETE' }); toast('已删除'); loadRoles(); }
      catch (e) { toast(e.message, 'error'); }
    });
  }
  function buildConfirm(title, msg, yes) {
    const html = `
      <div class="overlay" id="sysCfmOverlay" hidden></div>
      <div class="dialog sm" id="sysCfmDialog" role="dialog" aria-modal="true">
        <div class="dialog-icon"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg></div>
        <h3>${title}</h3><p>${msg}</p>
        <div class="dialog-actions"><button class="btn" data-x="cfm">取消</button><button class="btn btn-danger" id="sysCfmYes">确认删除</button></div>
      </div>`;
    mountDialog('sysCfmOverlay', 'sysCfmDialog', html, () => {
      document.getElementById('sysCfmYes').onclick = async () => { unmountDialog('sysCfmOverlay', 'sysCfmDialog'); await yes(); };
    });
  }

  // ---------- 弹窗挂载/卸载 ----------
  function mountDialog(ovId, dlgId, html, after) {
    const src = document.createElement('div'); src.innerHTML = html;
    const overlay = src.querySelector('#' + ovId); overlay.id = '__' + ovId;
    const dialog = src.querySelector('#' + dlgId); dialog.id = '__' + dlgId;
    overlay.hidden = false;
    overlay.style.setProperty('display', 'grid', 'important');
    document.body.appendChild(overlay); document.body.appendChild(dialog);
    overlay.addEventListener('click', overlay.onclick = (e) => { if (e.target === overlay) { unmountDialog('__' + ovId, '__' + dlgId); } });
    dialog.addEventListener('click', (e) => { if (e.target.closest('[data-x]')) unmountDialog('__' + ovId, '__' + dlgId); });
    after && after();
  }
  function unmountDialog(ovId, dlgId) {
    clearDialogs();
  }
  function clearDialogs() {
    document.querySelectorAll('#__sysUserOverlay,#__sysUserDialog,#__sysRoleOverlay,#__sysRoleDialog,#__sysCfmOverlay,#__sysCfmDialog').forEach(n => n.remove());
  }
  function setSeg(kind, on) {
    // 用户对话框 seg 前缀 sysIf，角色对话框前缀 sysIfSt
    const a = document.getElementById(kind === 'user' ? 'sysIfOn' : 'sysIfStOn');
    const b = document.getElementById(kind === 'user' ? 'sysIfOff' : 'sysIfStOff');
    if (!a || !b) return;
    a.classList.toggle('active', on === '1');
    b.classList.toggle('active', on !== '1');
  }

  // ---------- 视图钩子 ----------
  if (window.APP_VIEW) {
    window.APP_VIEW.onShow('users', () => { loadUsers(); });
    window.APP_VIEW.onShow('roles', () => { loadRoles(); });
  }

  // 兜底：若 auth 引导后默认视图即用户/角色（本脚本挂载钩子晚于引导，手动补触发）
  if (window.APP_VIEW && window.APP_VIEW.notify) {
    if (document.getElementById('viewSysUsers') && !document.getElementById('viewSysUsers').hidden) window.APP_VIEW.notify('users');
    if (document.getElementById('viewSysRoles') && !document.getElementById('viewSysRoles').hidden) window.APP_VIEW.notify('roles');
  }
})();