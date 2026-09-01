/**
 * fj_id_card 个人身份信息管理 — Express 后端
 * 提供 REST API：列表 / 详情 / 新增 / 修改 / 删除
 */
const path = require('path');
const express = require('express');
const cors = require('cors');
const { repo, initMysql, testConnection, getEnvInfo, initRelationTable, syncTableComments, rebuildInfoView, listRelations, createRelation, deleteRelation } = require('./db');
const { parseIdCard } = require('./idcard');
const { requireAuth, requirePerm } = require('./auth');
const { authRouter, rbacRouter } = require('./rbac');

const app = express();
const PORT = process.env.PORT || 5173;

app.use(cors());
app.use(express.json());

// 静态托管前端（no-cache：强制浏览器每次向服务器校验版本，避免缓存旧版 JS/CSS 导致功能与接口口径不一致）
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir, {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
}));

// 静态托管地图 geoJSON（ECharts 省市地图）
app.use('/maps', express.static(path.join(__dirname, '..', 'public', 'maps')));

// 认证路由（login 公开；me/logout 内部自校验）
app.use('/api/auth', authRouter);

// 环境信息（公开，登录页/首页徽标使用）
app.get('/api/env', (req, res) => {
  res.json({ ok: true, data: getEnvInfo() });
});

// 除登录外的所有 /api 均需登录
app.use('/api', requireAuth);

// 系统管理（RBAC）——用户管理 / 角色管理
app.use('/api/system', rbacRouter);

const ok = (data, meta = {}) => ({ ok: true, data, env: getEnvInfo(), ...meta });
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
      if (!p || p.invalid || p.cardLen !== 18) errors.push('身份证号格式不正确（需为 18 位）');
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

// 解析看板全局筛选参数（hasRecord: all/yes/no；relations: 逗号分隔的关系值，含 'null' 表示无关系）
function parseDashScope(qs) {
  const hasRecord = ['yes', 'no'].includes(qs.hasRecord) ? qs.hasRecord : 'all';
  let relations = null;
  if (qs.relations != null && qs.relations !== '') {
    const parts = String(qs.relations).split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length) {
      relations = [];
      for (const p of parts) {
        if (p === 'null') relations.push('null');
        else if (/^-?\d+$/.test(p)) relations.push(p);
      }
    }
  }
  return { hasRecord, relations };
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
    data: result.rows,
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    totalPages: result.totalPages
  });
}));

app.get('/api/id-cards/stats', requirePerm('idcard:list'), asyncWrap(async (req, res) => {
  const { q, relation, nomobile } = req.query;
  const s = await repo.stats({
    q: q || undefined,
    relation: relation != null ? relation : undefined,
    nomobile: nomobile ? '1' : undefined
  });
  res.json({ ok: true, ...s });
}));

// ---------- 关系字典（单一数据源：内置 0~5 + 自定义负整数） ----------
app.get('/api/relations', requirePerm('idcard:list'), asyncWrap(async (req, res) => {
  // useCache=false：确保新增/改名/删除后前端立即可见最新字典
  const rows = await listRelations(false);
  res.json({ ok: true, data: rows });
}));

app.post('/api/relations', requirePerm('idcard:edit'), asyncWrap(async (req, res) => {
  const createdBy = (req.user && req.user.id) || null;
  const r = await createRelation((req.body || {}).label, createdBy);
  res.status(201).json({ ok: true, data: r });
}));

app.delete('/api/relations/:value', requirePerm('idcard:edit'), asyncWrap(async (req, res) => {
  // reassignTo 可省略（被引用则拦截 409）；或传 'null'（置空）/ 目标 value（改派后删）
  const reassignTo = req.query.reassignTo !== undefined ? req.query.reassignTo : undefined;
  try {
    const r = await deleteRelation(req.params.value, reassignTo);
    res.json({ ok: true, data: r });
  } catch (e) {
    if (e.code === 'RELATION_IN_USE') {
      res.status(409).json({ ok: false, code: 'RELATION_IN_USE', usage: e.usage, message: e.message });
      return;
    }
    throw e;
  }
}));

// ---------- 看板分析 ----------
app.get('/api/dashboard/stats', requirePerm('dashboard:view'), asyncWrap(async (req, res) => {
  const scope = parseDashScope(req.query);
  const [person, mobile] = await Promise.all([
    repo.dashboard(scope),
    repo.dashboardMobile(scope)
  ]);
  res.json({ ok: true, data: { person, mobile } });
}));

app.get('/api/dashboard/region', requirePerm('dashboard:view'), asyncWrap(async (req, res) => {
  const level = String(req.query.level || 'province');
  const parent = String(req.query.parent || '');
  const scope = parseDashScope(req.query);
  const data = await repo.dashboardRegionTree(level, parent, scope);
  res.json({ ok: true, data });
}));

app.get('/api/dashboard/people', requirePerm('dashboard:view'), asyncWrap(async (req, res) => {
  const scope = parseDashScope(req.query);
  const filters = parseDashFilters(req.query);
  const result = await repo.dashboardPeople({
    level: req.query.level, parent: req.query.parent,
    scope, page: req.query.page, pageSize: req.query.pageSize, filters,
    q: req.query.q
  });
  res.json({ ok: true, data: result });
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

// 批量导入人员：校验口径与手动新增一致；任一数据异常则整体不导入（详见 db.importBatch）
app.post('/api/id-cards/import', requirePerm('idcard:edit'), asyncWrap(async (req, res) => {
  const items = Array.isArray((req.body || {}).items) ? req.body.items : [];
  try {
    const result = await repo.importBatch(items, (req.user && req.user.id) || null);
    res.json(ok(result));
  } catch (e) {
    if (e.code === 'IMPORT_INVALID') {
      res.status(422).json({ ok: false, code: 'IMPORT_INVALID', message: e.message, errors: e.errors || [] });
      return;
    }
    throw e;
  }
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
  res.status(err.status || 500).json({ ok: false, message: err.message || '服务器错误', env: getEnvInfo() });
});

// ---------- 启动 ----------
async function start() {
  initMysql();
  const env = getEnvInfo();
  const connected = await testConnection();
  if (!connected) {
    // 已移除演示数据回退：MySQL 连接失败即退出，避免在无数据库状态下提供服务
    console.error(`[db] MySQL 连接失败，进程退出。请检查 ${env.profile === 'prod' ? '.env.prod' : '.env'} 配置（host/port/user/password/database）。`);
    process.exit(1);
  }
  console.log(`[db] 已连接 MySQL — 环境[${env.name}] (${env.profile}) — 数据库 ${env.database}`);
  // 初始化改为后台异步执行,不阻塞服务启动:
  // 生产库 fj_id_card/cdsgus 等大表 ALTER 较慢,await 会拖垮启动甚至触发环境回收。
  // 初始化失败不影响服务运行(注释/视图均不影响业务功能),仅记录日志。
  initRelationTable().catch(e => console.error('[db] initRelationTable 失败:', e.message));
  syncTableComments().catch(e => console.error('[db] syncTableComments 失败:', e.message));
  rebuildInfoView().catch(e => console.error('[db] rebuildInfoView 失败:', e.message));
  app.listen(PORT, () => {
    console.log(`[server] fj_id_card 身份信息管理已启动: http://localhost:${PORT}`);
  });
}

start();