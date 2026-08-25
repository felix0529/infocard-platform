/**
 * fj_id_card 个人身份信息管理 — Express 后端
 * 提供 REST API：列表 / 详情 / 新增 / 修改 / 删除
 */
const path = require('path');
const express = require('express');
const cors = require('cors');
const { repo, initMysql, testConnection, getMode, setMode } = require('./db');
const { parseIdCard } = require('./idcard');
const { requireAuth, requirePerm } = require('./auth');
const { authRouter, rbacRouter } = require('./rbac');

const app = express();
const PORT = process.env.PORT || 5173;

app.use(cors());
app.use(express.json());

// 静态托管前端
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// 静态托管地图 geoJSON（ECharts 省市地图）
app.use('/maps', express.static(path.join(__dirname, '..', 'public', 'maps')));

// 认证路由（login 公开；me/logout 内部自校验）
app.use('/api/auth', authRouter);

// 除登录外的所有 /api 均需登录
app.use('/api', requireAuth);

// 系统管理（RBAC）——用户管理 / 角色管理
app.use('/api/system', rbacRouter);

const ok = (data, meta = {}) => ({ ok: true, data, mode: getMode(), ...meta });
const fail = (msg, status = 400) => {
  const e = new Error(msg);
  e.status = status;
  return e;
};

// ---------- 校验 ----------
function validate(body, partial = false) {
  const errors = [];
  const v = {};

  if (!partial || body.name !== undefined) {
    v.name = String(body.name || '').trim();
    if (!v.name) errors.push('姓名不能为空');
    else if (v.name.length > 20) errors.push('姓名最长 20 个字符');
  } else v.name = undefined;

  if (!partial || body.card_no !== undefined) {
    v.card_no = String(body.card_no || '').trim();
    if (!v.card_no) errors.push('身份证号不能为空');
    else {
      const p = parseIdCard(v.card_no);
      if (!p || p.invalid || (p.cardLen !== 15 && p.cardLen !== 18)) errors.push('身份证号格式不正确（需 15 或 18 位）');
    }
  } else v.card_no = undefined;

  if (!partial || body.mobile !== undefined) {
    v.mobile = String(body.mobile || '').trim();
    if (v.mobile && !/^1\d{10}$/.test(v.mobile)) errors.push('手机号格式不正确（11 位，以 1 开头）');
  } else v.mobile = undefined;

  if (!partial || body.relation !== undefined) {
    v.relation = body.relation === '' || body.relation == null ? null : Number(body.relation);
    if (v.relation != null && !Number.isInteger(v.relation)) errors.push('关系参数不正确');
  } else v.relation = undefined;

  if (!partial || body.remark !== undefined) {
    v.remark = body.remark == null ? '' : String(body.remark).trim();
    if (v.remark.length > 500) errors.push('备注最长 500 个字符');
  } else v.remark = undefined;

  return { errors, v };
}

function asyncWrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// 解析看板全局筛选参数（hasRecord: all/yes/no；regYear: 4 位数字或 null）
function parseDashScope(qs) {
  const hasRecord = ['yes', 'no'].includes(qs.hasRecord) ? qs.hasRecord : 'all';
  const regYear = qs.regYear && /^\d{4}$/.test(String(qs.regYear)) ? String(qs.regYear) : null;
  return { hasRecord, regYear };
}

// 解析看板图表点击下钻的维度过滤参数（值来源为图表自身聚合结果，仍做白名单/格式校验）
function parseDashFilters(qs) {
  const f = {};
  if (qs.gender === '0' || qs.gender === '1' || qs.gender === 'null') f.gender = qs.gender;
  if (qs.surname && String(qs.surname).length === 1) f.surname = String(qs.surname);
  if (qs.birthYear && /^\d{4}$/.test(String(qs.birthYear))) f.birthYear = String(qs.birthYear);
  if (qs.birthMonth && /^\d{1,2}$/.test(String(qs.birthMonth))) f.birthMonth = String(qs.birthMonth);
  if (qs.constellation) f.constellation = String(qs.constellation);
  if (qs.age != null && /^\d+$/.test(String(qs.age))) f.age = String(qs.age);
  if (qs.ageStage) f.ageStage = String(qs.ageStage);
  if (qs.relation === 'null' || (qs.relation != null && /^-?\d+$/.test(String(qs.relation)))) f.relation = String(qs.relation);
  if (qs.mobileProvince) f.mobileProvince = String(qs.mobileProvince);
  if (qs.carrier) f.carrier = String(qs.carrier);
  if (qs.hasRec === 'yes' || qs.hasRec === 'no') f.hasRec = qs.hasRec;
  if (qs.hasMob === '1' || qs.hasMob === '0') f.hasMob = qs.hasMob;
  return f;
}

// ---------- 路由 ----------
app.get('/api/id-cards', requirePerm('idcard:list'), asyncWrap(async (req, res) => {
  const qs = req.query || {};
  const result = await repo.query({
    page: qs.page,
    pageSize: qs.pageSize,
    q: qs.q,
    relation: qs.relation,
    nomobile: qs.nomobile === '1' || qs.nomobile === 'true'
  });
  res.json({
    ok: true,
    mode: getMode(),
    data: result.rows,
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    totalPages: result.totalPages
  });
}));

app.get('/api/id-cards/stats', requirePerm('idcard:list'), asyncWrap(async (req, res) => {
  const s = await repo.stats();
  res.json({ ok: true, mode: getMode(), ...s });
}));

// ---------- 看板分析 ----------
app.get('/api/dashboard/stats', requirePerm('dashboard:view'), asyncWrap(async (req, res) => {
  const scope = parseDashScope(req.query);
  const [person, mobile, regYears] = await Promise.all([
    repo.dashboard(scope),
    repo.dashboardMobile(scope),
    repo.dashboardRegYears(scope)
  ]);
  res.json({ ok: true, mode: getMode(), data: { person, mobile, regYears } });
}));

app.get('/api/dashboard/region', requirePerm('dashboard:view'), asyncWrap(async (req, res) => {
  const level = String(req.query.level || 'province');
  const parent = String(req.query.parent || '');
  const scope = parseDashScope(req.query);
  const data = await repo.dashboardRegionTree(level, parent, scope);
  res.json({ ok: true, mode: getMode(), data });
}));

app.get('/api/dashboard/people', requirePerm('dashboard:view'), asyncWrap(async (req, res) => {
  const scope = parseDashScope(req.query);
  const filters = parseDashFilters(req.query);
  const result = await repo.dashboardPeople({
    level: req.query.level, parent: req.query.parent,
    scope, page: req.query.page, pageSize: req.query.pageSize, filters
  });
  res.json({ ok: true, mode: getMode(), data: result });
}));

app.get('/api/id-cards/:id', requirePerm('idcard:list'), asyncWrap(async (req, res) => {
  const row = await repo.get(req.params.id);
  if (!row) throw fail('未找到该记录', 404);
  res.json(ok(row));
}));

// 详情：人员信息 + 三表关联推导 + cdsgus 登记信息（同一身份证可能多条）
app.get('/api/id-cards/:id/detail', requirePerm('idcard:list'), asyncWrap(async (req, res) => {
  const person = await repo.personDetail(req.params.id);
  if (!person) throw fail('未找到该记录', 404);
  const { cdsgus, ...rest } = person;
  res.json(ok({ person: rest, cdsgus }));
}));

app.post('/api/id-cards', requirePerm('idcard:edit'), asyncWrap(async (req, res) => {
  const { errors, v } = validate(req.body || {});
  if (errors.length) throw fail(errors.join('；'), 422);
  const row = await repo.create(v);
  res.status(201).json(ok(row));
}));

app.put('/api/id-cards/:id', requirePerm('idcard:edit'), asyncWrap(async (req, res) => {
  const { errors, v } = validate(req.body || {}, true);
  if (errors.length) throw fail(errors.join('；'), 422);
  const row = await repo.update(req.params.id, v);
  if (!row) throw fail('未找到该记录', 404);
  res.json(ok(row));
}));

app.delete('/api/id-cards/:id', requirePerm('idcard:edit'), asyncWrap(async (req, res) => {
  const result = await repo.remove(req.params.id);
  if (!result) throw fail('未找到该记录', 404);
  res.json(ok({ id: Number(req.params.id) }));
}));

// ---------- 错误处理 ----------
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(err.status || 500).json({ ok: false, message: err.message || '服务器错误', mode: getMode() });
});

// ---------- 启动 ----------
async function start() {
  initMysql();
  const connected = await testConnection();
  setMode(connected ? 'mysql' : 'demo');
  if (connected) {
    console.log(`[db] 已连接 MySQL (${DB_NAME()}) — 使用真实 fj_id_card 表`);
  } else {
    console.log(`[db] 未连接 MySQL — 使用演示数据回退 (${process.env.DB_USER || 'root'}:${process.env.DB_PASSWORD ? '***' : '(空)'}@${process.env.DB_HOST || '127.0.0.1'})。可用环境变量 DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME 接入真实库。`);
  }
  app.listen(PORT, () => {
    console.log(`[server] fj_id_card 身份信息管理已启动: http://localhost:${PORT}`);
  });
}

function DB_NAME() {
  return process.env.DB_NAME || 'infocard_test';
}

start();