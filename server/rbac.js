/**
 * 认证与系统管理（RBAC）路由
 * 挂载方式：
 *   /api/auth       -> authRouter（login 公开，me/logout 需登录）
 *   /api/system/*   -> rbacRouter（需登录 + 权限校验）
 */
const express = require('express');
const auth = require('./auth');
const { getEnvInfo } = require('./db');

// ---------- 认证路由 ----------
const authRouter = express.Router();

// 登录（公开）
authRouter.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = auth.findUser('username', String(username || ''));
  if (!user || !auth.verifyPwd(password || '', user.salt, user.hash)) {
    return res.status(400).json({ ok: false, message: '用户名或密码错误' });
  }
  if (user.status !== '1') return res.status(400).json({ ok: false, message: '账号已被禁用，请联系管理员' });
  const token = auth.createToken(user.id);
  const { perms } = auth.permsForUser(user.id);
  res.json({ ok: true, env: getEnvInfo(), data: { token, user: auth.publicUser(user), perms } });
});

// 当前登录用户信息（需登录）
authRouter.get('/me', auth.requireAuth, (req, res) => {
  res.json({ ok: true, env: getEnvInfo(), data: req.auth });
});

// 登出（需登录）
authRouter.post('/logout', auth.requireAuth, (req, res) => {
  res.json({ ok: true, data: { loggedOut: true } });
});

// 修改当前登录用户密码（需登录）
authRouter.post('/password', auth.requireAuth, (req, res) => {
  const user = auth.findUser('id', req.auth.user.id);
  if (!user) return res.status(404).json({ ok: false, message: '用户不存在' });
  const { oldPassword, newPassword } = req.body || {};
  if (!auth.verifyPwd(String(oldPassword || ''), user.salt, user.hash)) {
    return res.status(400).json({ ok: false, message: '原密码不正确' });
  }
  const pwd = String(newPassword || '');
  if (pwd.length < 6) return res.status(400).json({ ok: false, message: '新密码长度至少 6 位' });
  if (pwd.length > 32) return res.status(400).json({ ok: false, message: '新密码长度不能超过 32 位' });
  auth.setPassword(user, pwd);
  res.json({ ok: true, data: { changed: true } });
});

// ---------- 系统管理路由（RBAC） ----------
const rbacRouter = express.Router();

// 权限清单（供角色分配权限时勾选）
rbacRouter.get('/perms', auth.requireAuth, auth.requirePerm('system:role:view'), (req, res) => {
  res.json({ ok: true, data: auth.PERMISSIONS });
});

// ---------- 角色 ----------
rbacRouter.get('/roles', auth.requireAuth, auth.requirePerm('system:role:view'), (req, res) => {
  res.json({ ok: true, data: auth.listRoles() });
});

rbacRouter.post('/roles', auth.requireAuth, auth.requirePerm('system:role:edit'), (req, res) => {
  const b = req.body || {};
  const roleName = String(b.roleName || '').trim();
  const roleKey = String(b.roleKey || '').trim();
  if (!roleName) return res.status(400).json({ ok: false, message: '角色名称不能为空' });
  if (!roleKey) return res.status(400).json({ ok: false, message: '角色标识不能为空' });
  if (!/^[a-zA-Z:_-]+$/.test(roleKey)) return res.status(400).json({ ok: false, message: '角色标识仅支持字母、数字、下划线、冒号' });
  if (auth.findRole('key', roleKey)) return res.status(400).json({ ok: false, message: '角色标识已存在' });
  const roles = auth.currentRoles();
  const perms = Array.isArray(b.perms) ? b.perms.filter(p => typeof p === 'string') : [];
  roles.push({
    id: auth.nextId(roles), roleKey, roleName,
    status: b.status === '0' ? '0' : '1',
    isAdmin: false, perms, remark: String(b.remark || '').trim()
  });
  auth.persist();
  res.json({ ok: true, data: auth.listRoles() });
});

rbacRouter.put('/roles/:id', auth.requireAuth, auth.requirePerm('system:role:edit'), (req, res) => {
  const role = auth.findRole('id', req.params.id);
  if (!role) return res.status(404).json({ ok: false, message: '角色不存在' });
  if (auth.isAdminRole(role)) return res.status(400).json({ ok: false, message: '内置超级管理员角色不可修改' });
  const b = req.body || {};
  if (b.roleName !== undefined) role.roleName = String(b.roleName || '').trim() || role.roleName;
  if (b.status !== undefined) role.status = b.status === '0' ? '0' : '1';
  if (b.remark !== undefined) role.remark = String(b.remark || '').trim();
  if (Array.isArray(b.perms)) role.perms = b.perms.filter(p => typeof p === 'string');
  auth.persist();
  res.json({ ok: true, data: auth.listRoles() });
});

rbacRouter.put('/roles/:id/status', auth.requireAuth, auth.requirePerm('system:role:edit'), (req, res) => {
  const role = auth.findRole('id', req.params.id);
  if (!role) return res.status(404).json({ ok: false, message: '角色不存在' });
  if (auth.isAdminRole(role)) return res.status(400).json({ ok: false, message: '内置超级管理员角色不可禁用' });
  role.status = req.body.status === '0' ? '0' : '1';
  auth.persist();
  res.json({ ok: true, data: auth.listRoles() });
});

rbacRouter.delete('/roles/:id', auth.requireAuth, auth.requirePerm('system:role:edit'), (req, res) => {
  const role = auth.findRole('id', req.params.id);
  if (!role) return res.status(404).json({ ok: false, message: '角色不存在' });
  if (auth.isAdminRole(role)) return res.status(400).json({ ok: false, message: '内置超级管理员角色不可删除' });
  const inUse = (auth.listRoles().find(r => r.id === role.id) || {}).userCount || 0;
  if (inUse > 0) return res.status(400).json({ ok: false, message: '该角色仍被用户使用，请先解除分配或改为禁用' });
  const roles = auth.currentRoles();
  roles.splice(roles.findIndex(r => r.id === role.id), 1);
  auth.persist();
  res.json({ ok: true, data: auth.listRoles() });
});

// ---------- 用户 ----------
rbacRouter.get('/users', auth.requireAuth, auth.requirePerm('system:user:view'), (req, res) => {
  res.json({ ok: true, data: auth.listUsers() });
});

rbacRouter.post('/users', auth.requireAuth, auth.requirePerm('system:user:edit'), (req, res) => {
  const b = req.body || {};
  const username = String(b.username || '').trim();
  const nickname = String(b.nickname || '').trim() || username;
  const password = String(b.password || '');
  if (!username) return res.status(400).json({ ok: false, message: '用户名不能为空' });
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) return res.status(400).json({ ok: false, message: '用户名需为 3-32 位字母/数字/点/下划线/横线' });
  if (auth.findUser('username', username)) return res.status(400).json({ ok: false, message: '用户名已存在' });
  if (password.length < 6) return res.status(400).json({ ok: false, message: '密码至少 6 位' });
  const users = auth.currentUsers();
  const salt = require('crypto').randomBytes(16).toString('hex');
  users.push({
    id: auth.nextId(users), username, nickname,
    salt, hash: auth.hashPwd(password, salt), status: b.status === '0' ? '0' : '1'
  });
  const newUser = users[users.length - 1];
  if (Array.isArray(b.roleIds)) auth.setUserRoles(newUser.id, b.roleIds);
  res.json({ ok: true, data: auth.listUsers() });
});

rbacRouter.put('/users/:id', auth.requireAuth, auth.requirePerm('system:user:edit'), (req, res) => {
  const user = auth.findUser('id', req.params.id);
  if (!user) return res.status(404).json({ ok: false, message: '用户不存在' });
  const b = req.body || {};
  if (user.username === 'admin' && b.status === '0') {
    return res.status(400).json({ ok: false, message: '内置管理员账号不可禁用' });
  }
  if (b.nickname !== undefined) user.nickname = String(b.nickname || '').trim() || user.nickname;
  if (b.status !== undefined) user.status = b.status === '0' ? '0' : '1';
  if (b.password && String(b.password).length >= 6) {
    user.salt = require('crypto').randomBytes(16).toString('hex');
    user.hash = auth.hashPwd(String(b.password), user.salt);
  }
  if (user.username !== 'admin' && Array.isArray(b.roleIds)) auth.setUserRoles(user.id, b.roleIds);
  auth.persist();
  res.json({ ok: true, data: auth.listUsers() });
});

rbacRouter.delete('/users/:id', auth.requireAuth, auth.requirePerm('system:user:edit'), (req, res) => {
  const user = auth.findUser('id', req.params.id);
  if (!user) return res.status(404).json({ ok: false, message: '用户不存在' });
  if (user.username === 'admin') return res.status(400).json({ ok: false, message: '内置管理员账号不可删除' });
  if (req.auth.user.id === user.id) return res.status(400).json({ ok: false, message: '不能删除当前登录账号' });
  const users = auth.currentUsers();
  users.splice(users.findIndex(u => u.id === user.id), 1);
  auth.setUserRoles(user.id, []); // 已移除关联
  auth.persist();
  res.json({ ok: true, data: auth.listUsers() });
});

module.exports = { authRouter, rbacRouter };