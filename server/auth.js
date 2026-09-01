/**
 * 认证与 RBAC（基于角色的访问控制）模块
 * - 数据持久化到 auth-data.json（users / roles / userRoles）
 * - 一个用户可分配多个角色，权限取并集；仅"启用"角色生效
 * - 内置超级管理员角色 admin，拥有全部权限，不做数据过滤
 * - token 为进程内内存会话（随机串），重启后需重新登录
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, 'auth-data.json');

// ---------- 权限清单 ----------
const PERMISSIONS = [
  { key: 'idcard:list', name: '人员列表', group: '业务' },
  { key: 'idcard:edit', name: '人员列表·维护', group: '业务' },
  { key: 'dashboard:view', name: '数据看板', group: '业务' },
  { key: 'system:user:view', name: '用户管理·查看', group: '系统' },
  { key: 'system:user:edit', name: '用户管理·维护', group: '系统' },
  { key: 'system:role:view', name: '角色管理·查看', group: '系统' },
  { key: 'system:role:edit', name: '角色管理·维护', group: '系统' }
];
const ALL_PERM = '*';

// ---------- 持久化 ----------
function load() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    if (data && Array.isArray(data.users) && Array.isArray(data.roles)) return data;
    throw new Error('结构不完整');
  } catch {
    return seed();
  }
}

function seed() {
  const salt = crypto.randomBytes(16).toString('hex');
  const data = {
    users: [{
      id: 1, username: 'admin', nickname: '管理员',
      salt, hash: hashPwd('admin123', salt), status: '1'
    }],
    roles: [{
      id: 1, roleKey: 'admin', roleName: '超级管理员',
      status: '1', isAdmin: true, perms: [ALL_PERM],
      remark: '内置超级管理员角色，拥有全部权限'
    }],
    userRoles: [{ userId: 1, roleId: 1 }]
  };
  persist(data);
  return data;
}

let state = load();

function persist(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data || state, null, 2), 'utf-8');
}

function nextId(list) {
  return list.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0) + 1;
}

// ---------- 密码 ----------
function hashPwd(pwd, salt) {
  return crypto.scryptSync(String(pwd), salt, 32).toString('hex');
}
function verifyPwd(pwd, salt, hash) {
  return hashPwd(pwd, salt) === hash;
}
// 重置用户密码（更换 salt 后重新哈希）
function setPassword(user, pwd) {
  const salt = crypto.randomBytes(16).toString('hex');
  user.salt = salt;
  user.hash = hashPwd(pwd, salt);
  persist();
}

// ---------- 权限解析 ----------
// 返回业务权限 key 集合（admin 角色 → 全部权限）
function permsForUser(userId) {
  const roleIds = state.userRoles.filter(r => r.userId === userId).map(r => r.roleId);
  const roles = state.roles.filter(r => roleIds.includes(r.id) && r.status === '1');
  const perms = new Set();
  for (const r of roles) {
    if (r.isAdmin) return { perms: ['*'], roles };
    for (const p of (r.perms || [])) perms.add(p);
  }
  return { perms: [...perms], roles };
}

// ---------- 会话 ----------
const tokens = new Map(); // token -> { userId, exp }

function createToken(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, { userId, exp: Date.now() + 24 * 3600 * 1000 }); // 24h
  return token;
}
function resolveToken(token) {
  const rec = token && tokens.get(token);
  if (!rec) return null;
  if (rec.exp < Date.now()) { tokens.delete(token); return null; }
  return rec;
}

// 用户对外展示对象（不含敏感字段）
function publicUser(u) {
  const { perms } = permsForUser(u.id);
  return {
    id: u.id, username: u.username, nickname: u.nickname,
    status: u.status, perms
  };
}

// ---------- 中间件 ----------
// 解析 Authorization: Bearer <token>，注入 req.auth
function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const rec = resolveToken(token);
  if (!rec) return res.status(401).json({ ok: false, message: '未登录或登录已过期' });
  const user = state.users.find(u => u.id === rec.userId);
  if (!user) return res.status(401).json({ ok: false, message: '用户不存在' });
  if (user.status !== '1') return res.status(401).json({ ok: false, message: '账号已被禁用' });
  const { perms, roles } = permsForUser(user.id);
  const isAdmin = perms.includes(ALL_PERM);
  req.auth = {
    user: publicUser(user),
    perms,
    isAdmin,
    roles: roles.map(r => ({ id: r.id, roleKey: r.roleKey, roleName: r.roleName, isAdmin: !!r.isAdmin }))
  };
  next();
}

// 校验是否拥有某权限（可选）；admin 自动放行
function requirePerm(perm) {
  return (req, res, next) => {
    if (!req.auth) return res.status(401).json({ ok: false, message: '未登录' });
    if (req.auth.isAdmin || req.auth.perms.includes(perm)) return next();
    return res.status(403).json({ ok: false, message: '无权限访问该功能' });
  };
}

// ---------- 存储操作（供路由使用） ----------
// 是否内置超级管理员：护佑 admin 角色与 admin 用户不被删改
function isAdminRole(r) { return !!r.isAdmin; }

function listRoles() {
  const countMap = {};
  for (const { userId, roleId } of state.userRoles) countMap[roleId] = (countMap[roleId] || 0) + 1;
  return state.roles.map(r => ({
    id: r.id, roleKey: r.roleKey, roleName: r.roleName,
    status: r.status, isAdmin: !!r.isAdmin, remark: r.remark || '',
    perms: r.isAdmin ? [ALL_PERM] : (r.perms || []),
    userCount: countMap[r.id] || 0
  }));
}

function listUsers() {
  return state.users.map(u => {
    const roleIds = state.userRoles.filter(x => x.userId === u.id).map(x => x.roleId);
    const roles = state.roles.filter(r => roleIds.includes(r.id)).map(r => ({
      id: r.id, roleKey: r.roleKey, roleName: r.roleName, isAdmin: !!r.isAdmin
    }));
    return {
      id: u.id, username: u.username, nickname: u.nickname,
      status: u.status, roles, isAdmin: roles.some(r => r.isAdmin)
    };
  });
}

function setUserRoles(userId, roleIds) {
  const ids = [...new Set((roleIds || []).map(Number).filter(Number.isInteger))];
  const valid = new Set(state.roles.map(r => r.id));
  state.userRoles = state.userRoles.filter(x => x.userId !== userId);
  for (const rid of ids) if (valid.has(rid)) state.userRoles.push({ userId, roleId: rid });
  persist();
}

function findRole(kind, by) {
  if (kind === 'key') return state.roles.find(r => r.roleKey === by);
  return state.roles.find(r => r.id === Number(by));
}

function findUser(by, value) {
  const key = by === 'username' ? 'username' : 'id';
  return state.users.find(u => (key === 'id' ? Number(u.id) === Number(value) : u.username === value));
}

module.exports = {
  PERMISSIONS, ALL_PERM,
  createToken, publicUser, hashPwd, verifyPwd, setPassword, permsForUser,
  requireAuth, requirePerm,
  persist, nextId,
  isAdminRole, listRoles, listUsers, setUserRoles,
  findRole, findUser,
  currentUsers: () => state.users, currentRoles: () => state.roles
};