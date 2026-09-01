/**
 * 数据访问层
 * - 通过 .env（测试）/.env.prod（生产）或环境变量配置 MySQL 连接
 * - 连接失败时由服务启动流程（server/index.js）显式退出，不提供演示数据回退
 */
const fs = require('fs');
const path = require('path');
const { parseIdCard } = require('./idcard');

// ---------- 运行环境 Profile ----------
// test（默认，开发/测试库）| prod（生产库）
// 启用生产：`node server/index.js --prod` 或环境变量 PROFILE=prod
const IS_PROD = process.env.PROFILE ? String(process.env.PROFILE).toLowerCase() === 'prod' : process.argv.includes('--prod');

// ---------- 加载 .env ----------
// 优先级：真实环境变量 > .env.prod（若生产） > .env
// 先快照真实环境变量键，文件仅填充/覆盖"真实环境未设置"的键，后加载的文件覆盖先加载的
function loadEnv() {
  const realKeys = new Set(Object.keys(process.env));
  const files = ['.env', IS_PROD ? '.env.prod' : null].filter(Boolean);
  for (const name of files) {
    const envPath = path.join(__dirname, '..', name);
    try {
      const txt = fs.readFileSync(envPath, 'utf-8');
      for (const line of txt.split('\n')) {
        const m = line.match(/^\s*(DB_\w+|ENV_LABEL)\s*=\s*(.*)\s*$/);
        if (m && !realKeys.has(m[1])) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    } catch {}
  }
}
loadEnv();

// ---------- 数据库配置 ----------
const DB = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'trae',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || (IS_PROD ? 'infocard' : 'infocard_test')
};
const ENV_LABEL = process.env.ENV_LABEL || (IS_PROD ? '生产库' : '测试库');

// 年龄 → 年龄阶段
function ageStage(age) {
  if (age == null) return null;
  if (age <= 6) return '幼儿（0-6岁）';
  if (age <= 12) return '少儿（7-12岁）';
  if (age <= 17) return '少年（13-17岁）';
  if (age <= 35) return '青年（18-35岁）';
  if (age <= 50) return '中年（36-50岁）';
  if (age <= 65) return '老年（51-65岁）';
  return '高龄（65岁以上）';
}

function enrich(row) {
  const parsed = parseIdCard(row.card_no);
  const p = parsed && !parsed.invalid ? parsed : { genderCode: null, regionCode: '', regionName: '—', birth: '—' };
  return {
    id: row.id,
    name: row.name || '',
    card_no: row.card_no || '',
    mobile: row.mobile ? String(row.mobile).trim() : '',
    relation: row.relation == null ? null : Number(row.relation),
    relation_label: relationLabel(row.relation == null ? null : Number(row.relation)),
    remark: row.remark ? String(row.remark) : '',
    card_len: row.card_len ?? p.cardLen ?? 0,
    region_code: row.region_code ?? p.regionCode ?? '',
    region_name: row.region_name || p.regionName || '',
    reg_province: row.reg_province || '',
    reg_city: row.reg_city || '',
    reg_district: row.reg_district || '',
    birth_date_str: row.birth_date_str ?? p.birthDateStr ?? '',
    birth: row.birth || p.birth || '—',
    gender_code: row.gender_code ?? p.genderCode,
    gender_name: row.gender_name || (p.genderCode === 1 ? '男' : p.genderCode === 0 ? '女' : '—'),
    hasRecord: false
  };
}

// 用身份证号批量标记是否有记录（查询 cdsgus.CtFId）
async function markHasRecord(rows) {
  const cardNos = rows.map(r => (r.card_no || '').trim()).filter(Boolean);
  if (!cardNos.length) return rows;
  if (mysqlAvailable) {
    // 分批（每批 ≤500），防止超长 IN 列表
    const found = new Set();
    for (let i = 0; i < cardNos.length; i += 500) {
      const chunk = cardNos.slice(i, i + 500);
      const ph = chunk.map(() => '?').join(',');
      const [res] = await pool.query(`SELECT DISTINCT CtfId FROM cdsgus WHERE CtfId IN (${ph})`, chunk);
      for (const r of res) found.add(String(r.CtFId != null ? r.CtFId : r.CtfId));
    }
    for (const row of rows) {
      const c = (row.card_no || '').trim();
      if (c && found.has(c)) row.hasRecord = true;
    }
  }
  return rows;
}

// ---------- MySQL 连接 ----------
let pool = null;
let mysqlAvailable = false;

function initMysql() {
  try {
    const mysql = require('mysql2/promise');
    pool = mysql.createPool({
      host: DB.host,
      port: DB.port,
      user: DB.user,
      password: DB.password,
      database: DB.database,
      waitForConnections: true,
      connectionLimit: 5,
      namedPlaceholders: true
    });
    mysqlAvailable = true;
  } catch (e) {
    mysqlAvailable = false;
    pool = null;
  }
}

// ---------- 关系字典表（单一数据源：内置 0~5 + 自定义负整数） ----------
// 关系标签统一从这里取，前端/列表/看板不再各自硬编码 BASE_RELATIONS / RELATIONS 数组。
const RELATION_TABLE = 'fj_id_card_relation';
const BUILTIN_RELATIONS = [
  { value: 0, label: '亲属', sort: 0 },
  { value: 1, label: '朋友', sort: 1 },
  { value: 2, label: '同事(瑞联)', sort: 2 },
  { value: 3, label: '同事(优品)', sort: 3 },
  { value: 4, label: '同事(大自然)', sort: 4 },
  { value: 5, label: '同事(财税)', sort: 5 }
];
const RELATION_CACHE_TTL = 60 * 1000;
let relationCache = { at: 0, rows: null };

// 幂等建表 + 写入内置种子（0~5 不可删，可改名由接口 UPDATE 实现）
async function initRelationTable() {
  if (!mysqlAvailable) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${RELATION_TABLE} (
      value      INT         NOT NULL COMMENT '关系编码:0~5 为内置关系,负整数(如 -1) 为用户自定义关系',
      label      VARCHAR(20) NOT NULL COMMENT '关系名称(最长 10 个汉字/字符)',
      is_builtin TINYINT     NOT NULL DEFAULT 0 COMMENT '是否内置:1=内置关系不可删除,0=自定义关系可删除',
      sort       INT         NOT NULL DEFAULT 0 COMMENT '展示排序,数值越小越靠前',
      created_by INT         NULL     COMMENT '创建人用户ID(审计用,可选)',
      created_at DATETIME    DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
      PRIMARY KEY (value),
      UNIQUE KEY uk_relation_label (label)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='身份证关系字典:关系编码与名称的单一数据源,列表/表单/看板/筛选统一从此读取'
  `);
  for (const r of BUILTIN_RELATIONS) {
    await pool.query(
      `INSERT IGNORE INTO ${RELATION_TABLE} (value, label, is_builtin, sort) VALUES (?, ?, 1, ?)`,
      [r.value, r.label, r.sort]
    );
  }
  // 对已存在(非本次新建)的表补充字段/表注释,幂等执行,失败忽略
  const commentSQL = [
    `ALTER TABLE ${RELATION_TABLE} MODIFY COLUMN value INT NOT NULL COMMENT '关系编码:0~5 为内置关系,负整数(如 -1) 为用户自定义关系'`,
    `ALTER TABLE ${RELATION_TABLE} MODIFY COLUMN label VARCHAR(20) NOT NULL COMMENT '关系名称(最长 10 个汉字/字符)'`,
    `ALTER TABLE ${RELATION_TABLE} MODIFY COLUMN is_builtin TINYINT NOT NULL DEFAULT 0 COMMENT '是否内置:1=内置关系不可删除,0=自定义关系可删除'`,
    `ALTER TABLE ${RELATION_TABLE} MODIFY COLUMN sort INT NOT NULL DEFAULT 0 COMMENT '展示排序,数值越小越靠前'`,
    `ALTER TABLE ${RELATION_TABLE} MODIFY COLUMN created_by INT NULL COMMENT '创建人用户ID(审计用,可选)'`,
    `ALTER TABLE ${RELATION_TABLE} MODIFY COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间'`,
    `ALTER TABLE ${RELATION_TABLE} COMMENT='身份证关系字典:关系编码与名称的单一数据源,列表/表单/看板/筛选统一从此读取'`
  ];
  for (const s of commentSQL) {
    try { await pool.query(s); } catch { /* 注释已存在或非预期变更,忽略 */ }
  }
  relationCache = { at: 0, rows: null };
}

// 幂等同步全库表/字段注释（已存在表也能补齐,失败忽略）
async function syncTableComments() {
  if (!mysqlAvailable) return;
  const stmts = [
    // ---- fj_id_card ----
    "ALTER TABLE fj_id_card MODIFY COLUMN id INT NOT NULL AUTO_INCREMENT COMMENT '主键ID'",
    "ALTER TABLE fj_id_card MODIFY COLUMN name VARCHAR(20) NULL COMMENT '姓名'",
    "ALTER TABLE fj_id_card MODIFY COLUMN card_no VARCHAR(40) NULL COMMENT '身份证号(15位或18位)'",
    "ALTER TABLE fj_id_card MODIFY COLUMN mobile VARCHAR(255) NULL COMMENT '手机号'",
    "ALTER TABLE fj_id_card MODIFY COLUMN relation INT NULL COMMENT '关系编码:0~5内置,负整数为自定义,详见 fj_id_card_relation 字典表,NULL=未设置关系'",
    "ALTER TABLE fj_id_card MODIFY COLUMN remark VARCHAR(500) NULL COMMENT '备注'",
    "ALTER TABLE fj_id_card MODIFY COLUMN card_len INT NULL COMMENT '身份证长度(15或18)'",
    "ALTER TABLE fj_id_card MODIFY COLUMN region_code VARCHAR(6) NULL COMMENT '行政区划代码(身份证前6位)'",
    "ALTER TABLE fj_id_card MODIFY COLUMN birth_date_str VARCHAR(8) NULL COMMENT '出生日期(YYYYMMDD格式字符串)'",
    "ALTER TABLE fj_id_card MODIFY COLUMN gender_code INT NULL COMMENT '性别码(1=男,0=女,从身份证解析)'",
    "ALTER TABLE fj_id_card MODIFY COLUMN birth_mmdd INT NULL COMMENT '出生月日(MMDD格式,用于星座匹配)'",
    "ALTER TABLE fj_id_card COMMENT='身份证人员主表:存储姓名/身份证号/手机号/关系等核心字段'",

    // ---- cdsgus ----
    "ALTER TABLE cdsgus MODIFY COLUMN Name VARCHAR(255) NULL COMMENT '姓名'",
    "ALTER TABLE cdsgus MODIFY COLUMN CardNo VARCHAR(255) NULL COMMENT '身份证号'",
    "ALTER TABLE cdsgus MODIFY COLUMN Descriot VARCHAR(255) NULL COMMENT '描述/备注'",
    "ALTER TABLE cdsgus MODIFY COLUMN CtfTp VARCHAR(255) NULL COMMENT '证件类型(如 ID-身份证)'",
    "ALTER TABLE cdsgus MODIFY COLUMN CtfId VARCHAR(255) NULL COMMENT '证件号码(身份证号,用于与 fj_id_card.card_no 关联)'",
    "ALTER TABLE cdsgus MODIFY COLUMN Gender VARCHAR(255) NULL COMMENT '性别(M/F/其他)'",
    "ALTER TABLE cdsgus MODIFY COLUMN Birthday VARCHAR(255) NULL COMMENT '出生日期'",
    "ALTER TABLE cdsgus MODIFY COLUMN Address VARCHAR(255) NULL COMMENT '地址'",
    "ALTER TABLE cdsgus MODIFY COLUMN Zip VARCHAR(255) NULL COMMENT '邮编'",
    "ALTER TABLE cdsgus MODIFY COLUMN Dirty VARCHAR(255) NULL COMMENT '数据脏标记(数据质量标记)'",
    "ALTER TABLE cdsgus MODIFY COLUMN District1 VARCHAR(255) NULL COMMENT '行政区1(省/直辖市)'",
    "ALTER TABLE cdsgus MODIFY COLUMN District2 VARCHAR(255) NULL COMMENT '行政区2(市/州)'",
    "ALTER TABLE cdsgus MODIFY COLUMN District3 VARCHAR(255) NULL COMMENT '行政区3(区/县)'",
    "ALTER TABLE cdsgus MODIFY COLUMN District4 VARCHAR(255) NULL COMMENT '行政区4(街道/乡镇)'",
    "ALTER TABLE cdsgus MODIFY COLUMN District5 VARCHAR(255) NULL COMMENT '行政区5(路/段)'",
    "ALTER TABLE cdsgus MODIFY COLUMN District6 VARCHAR(255) NULL COMMENT '行政区6(号/弄)'",
    "ALTER TABLE cdsgus MODIFY COLUMN FirstNm VARCHAR(255) NULL COMMENT '名(英文/拼音)'",
    "ALTER TABLE cdsgus MODIFY COLUMN LastNm VARCHAR(255) NULL COMMENT '姓(英文/拼音)'",
    "ALTER TABLE cdsgus MODIFY COLUMN Duty VARCHAR(255) NULL COMMENT '职务/职业'",
    "ALTER TABLE cdsgus MODIFY COLUMN Mobile VARCHAR(255) NULL COMMENT '手机号'",
    "ALTER TABLE cdsgus MODIFY COLUMN Tel VARCHAR(255) NULL COMMENT '固定电话'",
    "ALTER TABLE cdsgus MODIFY COLUMN Fax VARCHAR(255) NULL COMMENT '传真'",
    "ALTER TABLE cdsgus MODIFY COLUMN EMail VARCHAR(255) NULL COMMENT '电子邮箱'",
    "ALTER TABLE cdsgus MODIFY COLUMN Nation VARCHAR(255) NULL COMMENT '民族/国籍'",
    "ALTER TABLE cdsgus MODIFY COLUMN Taste VARCHAR(255) NULL COMMENT '口味偏好/其他偏好'",
    "ALTER TABLE cdsgus MODIFY COLUMN Education VARCHAR(255) NULL COMMENT '学历'",
    "ALTER TABLE cdsgus MODIFY COLUMN Company VARCHAR(255) NULL COMMENT '公司/单位名称'",
    "ALTER TABLE cdsgus MODIFY COLUMN CTel VARCHAR(255) NULL COMMENT '公司电话'",
    "ALTER TABLE cdsgus MODIFY COLUMN CAddress VARCHAR(255) NULL COMMENT '公司地址'",
    "ALTER TABLE cdsgus MODIFY COLUMN CZip VARCHAR(255) NULL COMMENT '公司邮编'",
    "ALTER TABLE cdsgus MODIFY COLUMN Family VARCHAR(255) NULL COMMENT '家庭信息'",
    "ALTER TABLE cdsgus MODIFY COLUMN Version VARCHAR(255) NULL COMMENT '登记时间(YYYY-MM-DD HH:MM:SS格式,用于判断是否有记录)'",
    "ALTER TABLE cdsgus MODIFY COLUMN id INT NOT NULL COMMENT '自增主键ID'",
    "ALTER TABLE cdsgus COMMENT='原始记录表:身份证关联的第三方记录数据(数据备份时间:2013年5月27日)'",

    // ---- fj_admin_region ----
    "ALTER TABLE fj_admin_region COMMENT='行政区划字典表:存储省市区三级代码与名称'",

    // ---- fj_constellation ----
    "ALTER TABLE fj_constellation MODIFY COLUMN id INT NOT NULL COMMENT '自增主键ID'",
    "ALTER TABLE fj_constellation COMMENT='星座字典表:存储12星座的名称与日期范围(MMDD格式)'",

    // ---- fj_id_card_stats ----
    "ALTER TABLE fj_id_card_stats COMMENT='看板预聚合统计表:按维度(dim)+取值(bucket)分块存储计数,由 rebuild-stats 脚本维护'",

    // ---- fj_mobile_segment ----
    "ALTER TABLE fj_mobile_segment COMMENT='手机号段字典表:前7位号段对应的归属地/运营商信息'"
  ];
  for (const s of stmts) {
    try { await pool.query(s); } catch { /* 字段不存在或注释已存在,忽略 */ }
  }
}

// 幂等重建视图 v_fj_id_card_info
// 变更点:1) 关系标签从 fj_id_card_relation 字典表 JOIN 取;2) 是否有记录 = card_no 能否关联到 cdsgus.CtfId(纯等值,去掉 regexp_like 校验)
async function rebuildInfoView() {
  if (!mysqlAvailable) return;
  const ddl = `
    CREATE OR REPLACE VIEW v_fj_id_card_info AS
    WITH base AS (
      SELECT
        f.name            AS name,
        f.card_no         AS card_no,
        f.mobile          AS mobile,
        f.relation        AS relation,
        f.region_code     AS region_code,
        f.birth_date_str  AS birth_date_str,
        f.birth_mmdd      AS birth_mmdd,
        STR_TO_DATE(f.birth_date_str, '%Y%m%d') AS birth_date,
        CASE WHEN f.gender_code = 1 THEN '男' WHEN f.gender_code = 0 THEN '女' ELSE NULL END COLLATE utf8mb4_0900_ai_ci AS gender,
        CASE WHEN f.birth_date_str IS NOT NULL AND STR_TO_DATE(f.birth_date_str, '%Y%m%d') IS NOT NULL
             THEN TIMESTAMPDIFF(YEAR, STR_TO_DATE(f.birth_date_str, '%Y%m%d'), CURDATE())
             ELSE NULL END AS age
      FROM fj_id_card f
    ),
    base_stage AS (
      SELECT
        b.*,
        CASE WHEN b.age IS NULL THEN NULL
             WHEN b.age <= 6  THEN '婴幼儿(0-6岁)'
             WHEN b.age <= 12 THEN '儿童(7-12岁)'
             WHEN b.age <= 17 THEN '少年(13-17岁)'
             WHEN b.age <= 35 THEN '青年(18-35岁)'
             WHEN b.age <= 50 THEN '中年(36-50岁)'
             WHEN b.age <= 65 THEN '中老年(51-65岁)'
             ELSE '老年(65岁以上)' END COLLATE utf8mb4_0900_ai_ci AS age_stage
      FROM base b
    ),
    j AS (
      SELECT
        b.name, b.card_no, b.mobile, b.relation, b.region_code,
        b.birth_date_str, b.birth_mmdd, b.birth_date, b.gender, b.age, b.age_stage,
        r.province  AS province,
        r.city      AS city,
        r.district  AS district,
        c.name      AS constellation,
        d.Address   AS Address,
        d.EMail     AS EMail,
        d.CtfId     AS CtfId,
        m.province  AS m_province,
        m.city      AS m_city,
        m.carrier   AS carrier,
        rel.label   AS relation_label,
        COALESCE(
          CASE WHEN d.Version IS NOT NULL AND d.Version <> ''
                    AND STR_TO_DATE(d.Version, '%Y-%m-%d %H:%i:%s') IS NOT NULL
               THEN STR_TO_DATE(d.Version, '%Y-%m-%d %H:%i:%s')
               ELSE NULL END,
          '2013-05-27'
        ) AS record_time,
        CASE WHEN b.birth_date IS NOT NULL AND d.CtfId IS NOT NULL AND d.CtfId <> ''
             THEN TIMESTAMPDIFF(YEAR, b.birth_date,
                COALESCE(
                  CASE WHEN d.Version IS NOT NULL AND d.Version <> ''
                            AND STR_TO_DATE(d.Version, '%Y-%m-%d %H:%i:%s') IS NOT NULL
                       THEN STR_TO_DATE(d.Version, '%Y-%m-%d %H:%i:%s')
                       ELSE NULL END,
                  '2013-05-27'))
             ELSE NULL END AS record_age
      FROM base_stage b
      LEFT JOIN fj_admin_region    r   ON b.region_code = r.region_code
      LEFT JOIN fj_constellation   c   ON b.birth_mmdd IS NOT NULL
          AND ( (c.start_mmdd <= c.end_mmdd AND b.birth_mmdd BETWEEN c.start_mmdd AND c.end_mmdd)
             OR (c.start_mmdd > c.end_mmdd  AND (b.birth_mmdd >= c.start_mmdd OR b.birth_mmdd <= c.end_mmdd)) )
      LEFT JOIN cdsgus             d   ON b.card_no = d.CtfId
      LEFT JOIN fj_mobile_segment  m   ON SUBSTR(b.mobile, 1, 7) = m.segment
      LEFT JOIN fj_id_card_relation rel ON b.relation = rel.value
    )
    SELECT
      j.name            AS '姓名',
      j.card_no         AS '身份证号',
      j.mobile          AS '手机号',
      CASE WHEN j.m_province IS NULL THEN NULL
           WHEN j.m_city IS NULL OR j.m_city = '' THEN j.m_province
           ELSE CONCAT(j.m_province, ' ', j.m_city)
      END               AS '手机归属地',
      j.carrier         AS '运营商',
      COALESCE(j.relation_label, CASE WHEN j.relation IS NULL THEN '无关系' ELSE CONCAT('关系', j.relation) END)
                        COLLATE utf8mb4_0900_ai_ci AS '关系',
      j.gender          AS '性别',
      j.birth_date      AS '出生日期',
      YEAR(j.birth_date)   AS '出生年份',
      MONTH(j.birth_date)  AS '出生月份',
      j.age             AS '当前年龄',
      j.age_stage       AS '年龄阶段',
      j.constellation   AS '星座',
      j.province        AS '省',
      j.city            AS '市',
      j.district        AS '区',
      j.Address         AS '户籍地址',
      j.EMail           AS '邮箱',
      CASE WHEN j.CtfId IS NOT NULL AND j.CtfId <> '' THEN 1 ELSE 0 END AS '是否有记录',
      CASE WHEN j.CtfId IS NOT NULL AND j.CtfId <> ''
           THEN DATE_FORMAT(j.record_time, '%Y-%m-%d %H:%i:%s')
           ELSE NULL END AS '记录时间',
      j.record_age     AS '记录年龄',
      CASE WHEN j.record_age IS NULL THEN NULL
           WHEN j.record_age <= 6  THEN '婴幼儿(0-6岁)'
           WHEN j.record_age <= 12 THEN '儿童(7-12岁)'
           WHEN j.record_age <= 17 THEN '少年(13-17岁)'
           WHEN j.record_age <= 35 THEN '青年(18-35岁)'
           WHEN j.record_age <= 50 THEN '中年(36-50岁)'
           WHEN j.record_age <= 65 THEN '中老年(51-65岁)'
           ELSE '老年(65岁以上)' END COLLATE utf8mb4_0900_ai_ci AS '记录年龄阶段'
    FROM j
  `;
  // 视图 DEFINER 可能是 root@localhost,trae 用户 CREATE OR REPLACE/DROP 会报 SYSTEM_USER 权限不足
  // 改用 ALTER VIEW:替换视图定义但不变更属主,避免权限问题
  try {
    await pool.query(ddl.replace('CREATE OR REPLACE VIEW v_fj_id_card_info', 'ALTER VIEW v_fj_id_card_info'));
  } catch (e) {
    // 视图 DEFINER=root@localhost 时,trae 无 SYSTEM_USER 权限修改 —— 视图由 DBA 用 root 维护,此处跳过
    if (/SYSTEM_USER|definer|access denied/i.test(e.message)) {
      console.warn('[db] 视图 v_fj_id_card_info 由 root@localhost 维护,跳过自动重建(trae 无权限,属正常)');
      return;
    }
    // 非权限错误则尝试 CREATE OR REPLACE(首次创建场景)
    try {
      await pool.query(ddl);
    } catch (e2) {
      console.error('[db] 重建视图 v_fj_id_card_info 失败:', e2.message);
    }
  }
}

// 读取完整字典（含缓存）。返回 [{value,label,is_builtin,sort,created_by}]
async function listRelations(useCache = true) {
  if (!mysqlAvailable) return BUILTIN_RELATIONS.map(r => ({ ...r, is_builtin: true }));
  if (useCache && relationCache.rows && Date.now() - relationCache.at < RELATION_CACHE_TTL) {
    return relationCache.rows;
  }
  const [rows] = await pool.query(
    `SELECT value, label, is_builtin, sort, created_by FROM ${RELATION_TABLE} ORDER BY sort, value`
  );
  const data = rows.map(r => ({
    value: r.value, label: r.label, is_builtin: !!r.is_builtin,
    sort: r.sort, created_by: r.created_by
  }));
  relationCache = { at: Date.now(), rows: data };
  return data;
}

// 同步解析关系标签：缓存命中优先，未命中回退内置，再不命中回退「关系N」
function relationLabel(v) {
  if (v == null) return '无关系';
  const rows = relationCache.rows;
  if (rows) {
    const hit = rows.find(r => r.value === Number(v));
    if (hit) return hit.label;
  }
  const b = BUILTIN_RELATIONS.find(r => r.value === Number(v));
  if (b) return b.label;
  return '关系' + v;
}

// 下一个自定义编号：当前最小负整数 - 1（保证全局唯一、不与内置冲突）
async function nextCustomValue() {
  const [rows] = await pool.query(`SELECT MIN(value) AS m FROM ${RELATION_TABLE}`);
  const min = rows[0] && rows[0].m != null ? Number(rows[0].m) : 0;
  return min - 1;
}

// 该关系在 fj_id_card 中被引用次数（走 idx_relation 覆盖索引，亚秒级）
async function relationUsageCount(value) {
  const [rows] = await pool.query(`SELECT COUNT(*) AS c FROM fj_id_card WHERE relation = ?`, [Number(value)]);
  return rows[0] ? Number(rows[0].c) : 0;
}

// 新增自定义关系：后端分配编号，校验名称/重名/上限
async function createRelation(label, createdBy) {
  const trimmed = String(label == null ? '' : label).trim();
  if (!trimmed) throw new Error('关系名称不能为空');
  if (trimmed.length > 10) throw new Error('名称最长 10 个字符');
  const existing = await listRelations(false);
  if (existing.some(r => r.label === trimmed)) throw new Error('已存在相同关系：' + trimmed);
  const customCount = existing.filter(r => !r.is_builtin).length;
  if (customCount >= 6) throw new Error('自定义关系已达上限 6 个，请先移除不再使用的关系');
  const value = await nextCustomValue();
  await pool.query(
    `INSERT INTO ${RELATION_TABLE} (value, label, is_builtin, sort, created_by) VALUES (?, ?, 0, ?, ?)`,
    [value, trimmed, customCount, createdBy || null]
  );
  relationCache = { at: 0, rows: null };
  return { value, label: trimmed };
}

// 删除自定义关系：被引用且无 reassignTo 时抛 {code:'RELATION_IN_USE', usage}；
// 传入 reassignTo('null' 或目标 value) 则先改派再物理删除。
async function deleteRelation(value, reassignTo) {
  const numVal = Number(value);
  const rows = await listRelations(false);
  const target = rows.find(r => r.value === numVal);
  if (!target) throw new Error('关系不存在');
  if (target.is_builtin) throw new Error('内置关系不可删除');
  const usage = await relationUsageCount(numVal);
  if (usage > 0 && reassignTo === undefined) {
    const err = new Error('该关系已被引用，无法删除');
    err.code = 'RELATION_IN_USE';
    err.usage = usage;
    throw err;
  }
  if (usage > 0) {
    if (reassignTo === 'null' || reassignTo == null) {
      await pool.query(`UPDATE fj_id_card SET relation = NULL WHERE relation = ?`, [numVal]);
    } else {
      const tgt = rows.find(r => r.value === Number(reassignTo));
      if (!tgt) throw new Error('改派目标关系不存在');
      if (tgt.value === numVal) throw new Error('不能改派到自身');
      await pool.query(`UPDATE fj_id_card SET relation = ? WHERE relation = ?`, [Number(reassignTo), numVal]);
    }
  }
  await pool.query(`DELETE FROM ${RELATION_TABLE} WHERE value = ?`, [numVal]);
  relationCache = { at: 0, rows: null };
  return { usage };
}

async function testConnection() {
  if (!mysqlAvailable) return false;
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (e) {
    // 连接异常：置为不可用，由服务启动流程决定是否退出
    mysqlAvailable = false;
    return false;
  }
}

// ---------- 环境信息（前端徽标 / 响应 meta / 启动日志） ----------
function getProfile() {
  return IS_PROD ? 'prod' : 'test';
}
function getEnvInfo() {
  return {
    profile: getProfile(),
    name: ENV_LABEL,
    database: DB.database,
    mysql: mysqlAvailable
  };
}

// ---------- 看板统计：筛选与聚合辅助 ----------
// 已登记 → 动态 WHERE（作用于主表别名 f）
// scope = { hasRecord: 'all'|'yes'|'no', relations: string[] }
function dashboardWhere(scope = {}) {
  const { hasRecord = 'all', relations } = scope;
  const cond = [];
  if (hasRecord === 'yes') {
    cond.push('EXISTS (SELECT 1 FROM cdsgus d WHERE d.ctfid = f.card_no)');
  } else if (hasRecord === 'no') {
    cond.push('NOT EXISTS (SELECT 1 FROM cdsgus d WHERE d.ctfid = f.card_no)');
  }
  // 关系多选：relations 为数组（含 'null' 哨兵表示无关系）。非 null 关系走实时聚合（idx_relation 覆盖索引），
  // 与图表点击关系下钻复用同一套过滤，口径一致；统计表无按 relation 拆分的预聚合维度。
  if (Array.isArray(relations) && relations.length) {
    const parts = [];
    const nums = [];
    let hasNull = false;
    for (const v of relations) {
      if (v === 'null' || v == null) hasNull = true;
      else nums.push(Number(v));
    }
    const inList = nums.length ? `f.relation IN (${nums.join(',')})` : null;
    if (hasNull && inList) parts.push(`(f.relation IS NULL OR ${inList})`);
    else if (hasNull) parts.push('f.relation IS NULL');
    else if (inList) parts.push(inList);
    if (parts.length) cond.push('(' + parts.join(' OR ') + ')');
  }
  return cond.length ? 'WHERE ' + cond.join(' AND ') : '';
}

function baseFrom(where) {
  return `FROM fj_id_card f ${where}`;
}
// 追加条件：where 为空则用 WHERE 开头，非空则用 AND 开头，避免 "AND" 悬空
function andCond(where, sql) {
  return `${where ? where + ' AND ' : 'WHERE '}${sql}`;
}
// 追加条件（用于已含 where 的 base FROM）：base 已带 WHERE 时仅追加 AND
function condClause(where, sql) {
  return `${where ? 'AND ' : 'WHERE '}${sql}`;
}

// 安全转义字符串字面量（用于点击维度过滤的字符串值，值来源为图表自身聚合结果）
function escVal(v) {
  const s = String(v == null ? '' : v);
  return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

// 年龄阶段白名单（与 CASE 表达式一一对应）
const STAGE_NAMES = new Set([
  '幼儿（0-6岁）', '少儿（7-12岁）', '少年（13-17岁）',
  '青年（18-35岁）', '中年（36-50岁）', '老年（51-65岁）', '高龄（65岁以上）'
]);

// 根据看板图表点击产生的 filters 对象，构造附加 WHERE 片段（不含前导 WHERE/AND）
// filters 形如 { gender, surname, birthYear, birthMonth, constellation, age, ageStage, relation, mobileProvince, carrier, hasRec, hasMob }
function dashboardFilterClause(filters = {}) {
  const ageExpr = `TIMESTAMPDIFF(YEAR, STR_TO_DATE(f.birth_date_str,'%Y%m%d'), CURDATE())`;
  const parts = [];
  if (filters.gender === '0' || filters.gender === '1') {
    parts.push(`f.gender_code = ${Number(filters.gender)}`);
  } else if (filters.gender === 'null') {
    parts.push(`f.gender_code IS NULL`);
  }
  if (filters.surname && String(filters.surname).length === 1) {
    // 前缀 LIKE 命中 index_name_mobile，避免 1868 万行 LEFT() 函数扫描
    parts.push(`f.name LIKE ${escVal(filters.surname + '%')}`);
  }
  if (filters.birthYear && /^\d{4}$/.test(String(filters.birthYear))) {
    // 前缀 LIKE 命中 idx_birth_date
    parts.push(`f.birth_date_str LIKE ${escVal(String(filters.birthYear) + '%')}`);
  }
  if (filters.birthMonth && /^\d{1,2}$/.test(String(filters.birthMonth))) {
    const mm = String(filters.birthMonth).padStart(2, '0');
    parts.push(`SUBSTRING(f.birth_date_str,5,2) = ${escVal(mm)}`);
  }
  if (filters.constellation) {
    parts.push(`EXISTS (SELECT 1 FROM fj_constellation c WHERE ((c.start_mmdd<=c.end_mmdd AND f.birth_mmdd BETWEEN c.start_mmdd AND c.end_mmdd) OR (c.start_mmdd>c.end_mmdd AND (f.birth_mmdd>=c.start_mmdd OR f.birth_mmdd<=c.end_mmdd))) AND c.name = ${escVal(filters.constellation)})`);
  }
  if (filters.age != null && /^\d+$/.test(String(filters.age))) {
    parts.push(`${ageExpr} = ${Number(filters.age)}`);
  }
  if (filters.ageStage && STAGE_NAMES.has(String(filters.ageStage))) {
    parts.push(`(CASE WHEN ${ageExpr} <= 6 THEN '幼儿（0-6岁）'
        WHEN ${ageExpr} <= 12 THEN '少儿（7-12岁）'
        WHEN ${ageExpr} <= 17 THEN '少年（13-17岁）'
        WHEN ${ageExpr} <= 35 THEN '青年（18-35岁）'
        WHEN ${ageExpr} <= 50 THEN '中年（36-50岁）'
        WHEN ${ageExpr} <= 65 THEN '老年（51-65岁）'
        ELSE '高龄（65岁以上）' END) = ${escVal(filters.ageStage)}`);
  }
  if (filters.relation === 'null') {
    parts.push(`f.relation IS NULL`);
  } else if (filters.relation != null && /^-?\d+$/.test(String(filters.relation))) {
    parts.push(`f.relation = ${Number(filters.relation)}`);
  }
  // 手机前缀段关联：m2.segment = LEFT(f.mobile,7) 可命中 idx_mobile_d7 函数索引，
  // 取代 LEFT(f.mobile,7)=m2.segment 的每行函数计算 + 全表哈希连接
  if (filters.mobileProvince) {
    if (String(filters.mobileProvince) === '未知') {
      parts.push(`NOT EXISTS (SELECT 1 FROM fj_mobile_segment m2 WHERE LEFT(f.mobile,7)=m2.segment AND m2.province IS NOT NULL AND m2.province <> '')`);
    } else {
      parts.push(`EXISTS (SELECT 1 FROM fj_mobile_segment m2 WHERE m2.segment = LEFT(f.mobile,7) AND m2.province = ${escVal(filters.mobileProvince)})`);
    }
  }
  if (filters.carrier) {
    if (String(filters.carrier) === '未知') {
      parts.push(`NOT EXISTS (SELECT 1 FROM fj_mobile_segment m2 WHERE LEFT(f.mobile,7)=m2.segment AND m2.carrier IS NOT NULL AND m2.carrier <> '')`);
    } else {
      parts.push(`EXISTS (SELECT 1 FROM fj_mobile_segment m2 WHERE m2.segment = LEFT(f.mobile,7) AND m2.carrier = ${escVal(filters.carrier)})`);
    }
  }
  if (filters.hasRec === 'yes') {
    parts.push(`EXISTS (SELECT 1 FROM cdsgus d WHERE d.ctfid = f.card_no)`);
  } else if (filters.hasRec === 'no') {
    parts.push(`NOT EXISTS (SELECT 1 FROM cdsgus d WHERE d.ctfid = f.card_no)`);
  }
  if (filters.hasMob === '1') {
    parts.push(`f.mobile IS NOT NULL AND TRIM(f.mobile) <> ''`);
  } else if (filters.hasMob === '0') {
    parts.push(`(f.mobile IS NULL OR TRIM(f.mobile) = '')`);
  }
  // 本年新增：created_at 落在今年（指标口径：YEAR(f.created_at) = 当前年），命中 idx_created_at
  if (filters.yearAdd === '1') {
    parts.push(`f.created_at >= ${escVal(new Date().getFullYear() + '-01-01 00:00:00')}`);
  }
  return parts.join(' AND ');
}

// ---------- 看板预聚合统计表 ----------
// fj_id_card_stats(dim, bucket, cnt) 由 scripts/rebuild-stats.js 维护。
// 看板接口优先读统计表，缺失（未重建）时回退到实时聚合。
const NULL_KEY = '__null__';   // 与重建脚本 NULL_SENT 保持一致：统计表中 NULL 值的 bucket 表示

// ---------- 实时增量维护 fj_id_card_stats ----------
// 新增/修改/删除人员时，对本人的各维度统计键做 ±1 同步，避免每次都全量重建统计表。
// 行级口径与 scripts/rebuild-stats.js 保持一一对应。
const ROW_COLS = 'id, name, card_no, mobile, relation, remark, region_code, birth_date_str, birth_mmdd, gender_code, created_at';

// 年龄（TIMESTAMPDIFF(YEAR, STR_TO_DATE(ymd,'%Y%m%d'), CURDATE()) 的 JS 等价实现）
function ageOf(ymd, now) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(ymd || ''));
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  let age = now.getFullYear() - y;
  if (now.getMonth() + 1 < mo || (now.getMonth() + 1 === mo && now.getDate() < d)) age--;
  return age;
}

// 出生日月 → 星座
function constellationOf(mmd, consts) {
  if (mmd == null) return null;
  const n = Number(mmd);
  for (const c of consts) {
    const s = Number(c.start_mmdd), e = Number(c.end_mmdd);
    if ((s <= e && n >= s && n <= e) || (s > e && (n >= s || n <= e))) return c.name;
  }
  return null;
}

// 星座规则 / 手机号段缓存（口径变更时需全量重建统计表并重启服务）
let statsRefCache = null;
async function statsRefData() {
  if (!mysqlAvailable) return null;
  if (statsRefCache) return statsRefCache;
  const [consts] = await pool.query('SELECT name, start_mmdd, end_mmdd FROM fj_constellation WHERE start_mmdd IS NOT NULL');
  const [segs] = await pool.query('SELECT segment, province, carrier FROM fj_mobile_segment');
  const segMap = {};
  for (const s of segs) segMap[String(s.segment)] = s;
  statsRefCache = { consts, segMap };
  return statsRefCache;
}

// 某身份证在 cdsgus 中是否存在任意登记记录（决定 rec1/rec0，不要求 Version 非空）。
// 与列表/明细下钻的 hasRecord 口径（EXISTS cdsgus 任意记录）保持一致。
async function cdsgusHasRecord(cardNo) {
  const c = String(cardNo || '').trim();
  if (!c || !mysqlAvailable) return false;
  const [rows] = await pool.query('SELECT 1 FROM cdsgus WHERE CtfId = ? LIMIT 1', [c]);
  return rows.length > 0;
}

// 关系维度：有关系人员实时聚合（idx_relation 覆盖索引），无关系计数走统计表 relation@__null__
// 需求 3.1：有关系人员实时获取，无关系人员从统计表获取
async function dashboardRelationLive(scope = {}) {
  if (!mysqlAvailable) return [];
  const where = dashboardWhere(scope);
  const [rows] = await pool.query(
    `SELECT f.relation AS \`key\`, COUNT(*) AS count FROM fj_id_card f ${andCond(where, 'f.relation IS NOT NULL')} GROUP BY f.relation ORDER BY count DESC`
  );
  return rows.map(r => ({ key: Number(r.key), count: Number(r.count) }));
}

// 全局关系筛选 → 有关系人群的实时维度桶（复用 buildStatsKeys，与统计表行级口径逐维一致）
// 返回 { includeNull, allMap, selMap }；allMap=全部有关系者、selMap=所选关系者（dim -> bucket -> count，
// dim 不含 @suffix，与 buildStatsKeys 前缀一致）。非关系筛选或引用缺失时返回 null。
// 统计表读取结果与该差分包叠加即可得到任意关系筛选后的各维度计数，避免千万级全表扫描：
//   勾选「无关系」时 filtered = 统计表全量 − 全有关系实时值 + 所选关系实时值
//   仅选具体关系时 filtered = 所选关系实时值
let relDeltaCache = { key: '', ts: 0, data: null };
async function relationDeltaBuckets(suf, scope = {}) {
  if (!mysqlAvailable) return null;
  const selRels = Array.isArray(scope.relations) ? scope.relations : [];
  if (!selRels.length) return null;
  const includeNull = selRels.includes('null');
  const nums = selRels.filter(v => v !== 'null' && v != null).map(Number);
  const ref = await statsRefData();
  if (!ref) return null;
  const ckey = `${suf}|${selRels.join(',')}`;
  if (relDeltaCache.key === ckey && Date.now() - relDeltaCache.ts < 5000) return relDeltaCache.data;
  // WHERE：有关系 + 与统计表后缀对应的 hasRecord 条件（rec1/rec0 与 c@rec1/c@rec0 口径一致）
  const conds = ['f.relation IS NOT NULL'];
  if (suf === 'rec1') conds.push('EXISTS (SELECT 1 FROM cdsgus d WHERE d.ctfid = f.card_no)');
  else if (suf === 'rec0') conds.push('NOT EXISTS (SELECT 1 FROM cdsgus d WHERE d.ctfid = f.card_no)');
  const [rows] = await pool.query(
    `SELECT ${ROW_COLS} FROM fj_id_card f WHERE ${conds.join(' AND ')} LIMIT 200000`
  );
  const allMap = {}, selMap = {};
  const put = (mm, dim, bucket) => {
    (mm[dim] = mm[dim] || {})[bucket] = (mm[dim][bucket] || 0) + 1;
  };
  for (const row of rows) {
    const sel = row.relation == null ? false : nums.includes(Number(row.relation));
    const keys = buildStatsKeys(row, ref.consts, ref.segMap, suf === 'rec1');
    for (const k of keys) {
      const at = k.indexOf('@'), sep = k.indexOf('|');
      if (at < 0 || sep < 0) continue;
      if (k.slice(at + 1, sep) !== suf) continue; // 只收集与统计表后缀一致的维度键
      const bucket = k.slice(sep + 1);
      put(allMap, k.slice(0, at), bucket);
      if (sel) put(selMap, k.slice(0, at), bucket);
    }
  }
  relDeltaCache = { key: ckey, ts: Date.now(), data: { includeNull, allMap, selMap } };
  return relDeltaCache.data;
}

// 把关系差分包应用到统计表读取结果 st（g 以 `dim@scope` 为键）。
// 使全部分组卡片/图表（人员与手机面板）统一响应全局关系筛选。
function applyRelationDelta(st, relDelta) {
  if (!relDelta) return;
  const { includeNull, allMap, selMap } = relDelta;
  for (const fullKey of Object.keys(st.g)) {
    const at = fullKey.indexOf('@');
    const dim = at > 0 ? fullKey.slice(0, at) : fullKey;
    const full = st.g[fullKey] || {};
    const allR = allMap[dim] || {};
    const selR = selMap[dim] || {};
    const res = {};
    for (const b of new Set([...Object.keys(full), ...Object.keys(allR), ...Object.keys(selR)])) {
      const v = includeNull
        ? Number(full[b] || 0) - Number(allR[b] || 0) + Number(selR[b] || 0)
        : Number(selR[b] || 0);
      if (v > 0) res[b] = v;
    }
    st.g[fullKey] = res;
  }
}

// 单行人员的全部统计键（dim@scope|bucket），与重建存储过程逐维度对应
// hasRecord：是否存在任意 cdsgus 记录（决定 rec1/rec0 口径，与列表/下钻一致）
function buildStatsKeys(row, consts, segMap, hasRecord) {
  const keys = [];
  const scopes = ['all', hasRecord ? 'rec1' : 'rec0'];
  const push = (dim, scope, bucket) => keys.push(dim + '@' + scope + '|' + String(bucket == null ? NULL_KEY : bucket));

  const gender = row.gender_code == null ? null : Number(row.gender_code);
  const nm = row.name ? String(row.name) : '';
  const surname = nm ? nm.slice(0, 1) : '';
  const bds = row.birth_date_str == null ? null : String(row.birth_date_str);
  const hasBd = bds != null && bds !== '';
  const region2 = row.region_code == null ? null : String(row.region_code).slice(0, 2);
  const birthYear = bds == null ? null : bds.slice(0, 4);
  const birthMonth = bds == null ? null : bds.slice(4, 6);
  const now = new Date();
  const age = hasBd ? ageOf(bds, now) : null;
  const stage = hasBd ? ageStage(age) : null;
  const con = row.birth_mmdd == null ? null : constellationOf(Number(row.birth_mmdd), consts);
  const rel = row.relation == null ? null : Number(row.relation);
  // 创建年份（本年新增指标）；mysql2 默认将 DATETIME 解析为 Date，兼容字符串回退
  const cy = row.created_at == null ? null
    : (row.created_at instanceof Date ? row.created_at.getFullYear() : Number(String(row.created_at).slice(0, 4)));
  const mob = row.mobile != null ? String(row.mobile).trim() : '';
  const hasMob = mob !== '';
  const seg = hasMob ? segMap[mob.slice(0, 7)] : null;
  const mprov = !hasMob ? null : (seg && seg.province) ? String(seg.province) : '未知';
  const mcar = !hasMob ? null : (seg && seg.carrier) ? String(seg.carrier) : '未知';

  for (const s of scopes) {
    push('c', s, 'total');
    if (hasRecord) push('c', s, 'hasrec'); else push('c', s, 'norec');
    push('gender', s, gender);
    if (nm) push('surname', s, surname);
    if (region2 != null) push('region2', s, region2);
    if (birthYear != null) push('birthyear', s, birthYear);
    if (bds != null) push('birthmonth', s, birthMonth);
    push('constellation', s, con);
    // 关系仅存无关系（__null__）：有关系人员实时聚合（idx_relation 覆盖索引），与重建存储过程口径一致
    if (rel == null) push('relation', s, NULL_KEY);
    push('cy', s, cy);
    if (hasBd) { push('age', s, age); push('agestage', s, stage); }
    push('m', s, 'total');
    if (hasMob) { push('m', s, 'withmob'); push('mprov', s, mprov); push('mcarrier', s, mcar); }
    else push('m', s, 'nomob');
  }
  return keys;
}

// 统计表尚未重建时不拦截（看板会自动回退到实时聚合）
async function statsAvailable() {
  try {
    const [t] = await pool.query("SHOW TABLES LIKE 'fj_id_card_stats'");
    return t.length > 0;
  } catch { return false; }
}

// 将单个人员的计数并入/移出统计表：delta = 1（新增/修改后）或 -1（删除/修改前）
// hasRecord：是否存在任意 cdsgus 记录（决定 rec1/rec0 口径，与列表/下钻一致）
async function statsAdjust(row, delta, hasRecord) {
  if (!mysqlAvailable || !row) return;
  if (!await statsAvailable()) return;
  const ref = await statsRefData();
  if (!ref) return;
  const keys = buildStatsKeys(row, ref.consts, ref.segMap, hasRecord);
  if (!keys.length) return;
  const conn = await pool.getConnection();
  try {
    await conn.query('START TRANSACTION');
    for (let i = 0; i < keys.length; i += 500) {
      const slice = keys.slice(i, i + 500);
      const vals = slice.map(k => {
        const sep = k.indexOf('|');
        return [k.slice(0, sep), k.slice(sep + 1), delta];
      });
      await conn.query(
        'INSERT INTO fj_id_card_stats (dim, bucket, cnt) VALUES ? ON DUPLICATE KEY UPDATE cnt = cnt + VALUES(cnt)',
        [vals]
      );
      // 计数归零/为负的统计键直接删除，避免图表残留 value=0 的空 bucket（如 age => null）
      const pairs = slice.map(k => {
        const sep = k.indexOf('|');
        return [k.slice(0, sep), k.slice(sep + 1)];
      });
      const cases = pairs.map(() => '(dim = ? AND bucket = ?)').join(' OR ');
      await conn.query(`DELETE FROM fj_id_card_stats WHERE cnt <= 0 AND (${cases})`, pairs.flat());
    }
    await conn.query('COMMIT');
  } catch (e) {
    await conn.query('ROLLBACK').catch(() => {});
    // 统计表仅为加速层，失败不影响业务写入，下次全量重建会修正
    console.error('[statsAdjust] 统计表增量更新失败：', e.message);
  } finally {
    conn.release();
  }
}

// 在指定连接上执行统计表增量（供批量导入在同一事务内使用，任一步失败随事务整体回滚）
async function applyStatsKeysOn(conn, keys, delta) {
  if (!keys.length) return;
  for (let i = 0; i < keys.length; i += 500) {
    const slice = keys.slice(i, i + 500);
    const vals = slice.map(k => {
      const sep = k.indexOf('|');
      return [k.slice(0, sep), k.slice(sep + 1), delta];
    });
    await conn.query(
      'INSERT INTO fj_id_card_stats (dim, bucket, cnt) VALUES ? ON DUPLICATE KEY UPDATE cnt = cnt + VALUES(cnt)',
      [vals]
    );
    const pairs = slice.map(k => {
      const sep = k.indexOf('|');
      return [k.slice(0, sep), k.slice(sep + 1)];
    });
    const cases = pairs.map(() => '(dim = ? AND bucket = ?)').join(' OR ');
    await conn.query(`DELETE FROM fj_id_card_stats WHERE cnt <= 0 AND (${cases})`, pairs.flat());
  }
}

// 指定连接查询 cdsgus 是否有登记（与 cdsgusHasRecord 同口径，事务内使用保证与写入同一致性）
async function cdsgusHasRecordOn(conn, cardNo) {
  const [rows] = await conn.query('SELECT 1 FROM cdsgus WHERE CtfId = ? LIMIT 1', [String(cardNo || '').trim()]);
  return rows.length > 0;
}

// 看板筛选范围 -> 统计表 dim 后缀：all | rec1 | rec0
function dashScopeSuffix(scope = {}) {
  const hasRecord = scope.hasRecord === 'yes' || scope.hasRecord === 'no' ? scope.hasRecord : 'all';
  if (hasRecord === 'yes') return 'rec1';
  if (hasRecord === 'no') return 'rec0';
  return 'all';
}

// 图表点击过滤键 -> 预聚合统计表维度名（用于明细 total 快路径）
const DIM_BY_FILTER = {
  gender: 'gender', surname: 'surname', birthYear: 'birthyear', birthMonth: 'birthmonth',
  constellation: 'constellation', relation: 'relation', age: 'age', ageStage: 'agestage',
  mobileProvince: 'mprov', carrier: 'mcarrier', hasMob: 'm'
};

// 统计表 bucket -> 接口 key（数值维度还原数字，NULL 哨兵还原 null）
function dashKey(dim, bucket) {
  if (bucket === NULL_KEY) return null;
  if (dim === 'gender' || dim === 'age' || dim === 'relation') {
    const n = Number(bucket);
    return Number.isNaN(n) ? bucket : n;
  }
  return bucket;
}

// 看板图表维度的排序规则（与实时 SQL 的 ORDER BY 一致；空数组表示前端自行排序）
const DASH_DIMS = ['gender', 'surname', 'region2', 'birthyear', 'birthmonth', 'constellation', 'relation', 'age', 'agestage'];
// 统计表维度名 -> 接口输出字段名
const DASH_OUT = {
  gender: 'gender', surname: 'surname', region2: 'regionProvince',
  birthyear: 'birthYear', birthmonth: 'birthMonth', constellation: 'constellation',
  relation: 'relation', age: 'age', agestage: 'ageStage'
};
const DASH_ORDER = {
  surname: 'dc', region2: 'dc',            // count DESC
  birthyear: 'ka', birthmonth: 'ka', age: 'ka', // key ASC
  agestage: 'dc'                           // count DESC
};

function valToSqlParamList(arr) {
  return arr.map(() => '?').join(',');
}

// ---------- 列表 COUNT 缓存（关键词/组合筛选实时 COUNT 的防抖） ----------
// 关键词 LIKE '%kw%' 前导通配无法走索引，1868 万行 COUNT(*) 约 10s；翻页/筛选会重复触发。
// 以「筛选条件」为 key 缓存结果，TTL 内复用；写操作后失效。
const COUNT_CACHE_TTL = 60 * 1000;
const countCache = new Map(); // key -> { total, ts }
function countCacheKey(q, nomobile, relation) {
  return [`${q || ''}`, nomobile ? 1 : 0, relation == null ? '' : String(relation)].join('|');
}
function getCachedCount(key) {
  const hit = countCache.get(key);
  if (hit && Date.now() - hit.ts < COUNT_CACHE_TTL) return hit.total;
  return null;
}
function setCachedCount(key, total) {
  countCache.set(key, { total, ts: Date.now() });
}
function invalidateCountCache() {
  countCache.clear();
}

// 构建列表/统计共用的 WHERE 条件（搜索 + 筛选），保证二者口径一致
function buildListWhere({ q, relation, nomobile } = {}) {
  const cond = [];
  const args = [];
  if (q) {
    const kw = `%${String(q).trim().replace(/[%_\\]/g, ch => '\\' + ch)}%`;
    cond.push('(name LIKE ? OR card_no LIKE ? OR mobile LIKE ?)');
    args.push(kw, kw, kw);
  }
  if (nomobile) { cond.push('(mobile IS NULL OR TRIM(mobile) = "")'); }
  if (relation != null && relation !== '') {
    if (relation === 'null') { cond.push('relation IS NULL'); }
    else { cond.push('relation = ?'); args.push(Number(relation)); }
  }
  return { where: cond.length ? 'WHERE ' + cond.join(' AND ') : '', args };
}

// LIKE 通配符转义 + 字符串字面量转义（用于明细弹窗关键词模糊匹配，内联风格与 dashboardFilterClause 一致）
function likeClause(col, kw) {
  const escaped = '%' + String(kw).replace(/[\\%_]/g, m => '\\' + m) + '%';
  return `${col} LIKE ${escVal(escaped)}`;
}

const repo = {
  async query(opts = {}) {
    const { page = 1, pageSize = 20, q, relation, nomobile } = opts;
    const size = Math.max(1, Math.min(500, Number(pageSize) || 20));
    const current = Math.max(1, Number(page) || 1);
    const offset = (current - 1) * size;

    let total;
    let pageRows;

    if (!mysqlAvailable) throw new Error('数据库未连接，请检查数据库配置');
    const { where, args } = buildListWhere({ q, relation, nomobile });
    // 无关键词搜索且为单一筛选时，优先读预聚合统计表计数，避免 1868 万行 COUNT(*) 全扫：
    //   无筛选 → c@all.total；仅无手机 → m@all.nomob；仅关系 → relation@all.<关系值>
    // （nomobile + relation 组合筛选统计表无对应维度，走实时 COUNT）
    total = null;
    const ck = countCacheKey(q, nomobile, relation);
    if (!q) {
      let sd = null;
      if (relation == null || relation === '') sd = nomobile ? ['m@all', 'nomob'] : ['c@all', 'total'];
      else if (!nomobile) sd = ['relation@all', relation === 'null' ? NULL_KEY : String(Number(relation))];
      if (sd) {
        const [cRows] = await pool.query(
          'SELECT cnt FROM fj_id_card_stats WHERE dim = ? AND bucket = ?', sd
        );
        if (cRows.length) total = Number(cRows[0].cnt);
      }
    }
    // 关键词/组合筛选：先查 COUNT 缓存（避免每次翻页重跑 ~10s 全表扫描）
    if (total == null) {
      const cached = getCachedCount(ck);
      if (cached != null) total = cached;
    }
    if (total == null) {
      const [countRes] = await pool.query(`SELECT COUNT(*) AS c FROM fj_id_card ${where}`, args);
      total = Number(countRes[0]?.c || 0);
      setCachedCount(ck, total);
    }
    const sql_ = `SELECT f.id, f.name, f.card_no, f.mobile, f.relation, f.remark, f.region_code,
                         r.province AS reg_province, r.city AS reg_city, r.district AS reg_district
                  FROM fj_id_card f
                  LEFT JOIN fj_admin_region r ON f.region_code = r.region_code
                  ${where} ORDER BY f.id LIMIT ? OFFSET ?`;
    const [rows] = await pool.query(sql_, [...args, size, offset]);
    pageRows = rows.map(r => enrich({ ...r, gender_code: null }));

    const totalPages = Math.max(1, Math.ceil(total / size));
    await markHasRecord(pageRows);
    return { rows: pageRows, total, page: current, pageSize: size, totalPages };
  },

  async get(id) {
    if (!mysqlAvailable) throw new Error('数据库未连接，请检查数据库配置');
    const [rows] = await pool.query(
      'SELECT id, name, card_no, mobile, relation, remark, region_code, birth_date_str, birth_mmdd, gender_code FROM fj_id_card WHERE id=? LIMIT 1',
      [Number(id)]
    );
    if (!rows.length) return null;
    return enrich(rows[0]);
  },

  // 详情：人员基础信息 + 三表关联推导（地区/年龄/阶段/星座/手机归属/运营商）
  async personDetail(id) {
    if (!mysqlAvailable) throw new Error('数据库未连接，请检查数据库配置');
    const [rows] = await pool.query(
      `SELECT f.id, f.name, f.card_no, f.mobile, f.relation, f.remark, f.region_code,
              f.birth_date_str, f.birth_mmdd, f.gender_code,
              DATE_FORMAT(STR_TO_DATE(f.birth_date_str, '%Y%m%d'), '%Y-%m-%d') AS birth_date,
              r.province AS reg_province, r.city AS reg_city, r.district AS reg_district,
              c.name AS constellation,
              TIMESTAMPDIFF(YEAR, STR_TO_DATE(f.birth_date_str, '%Y%m%d'), CURDATE()) AS age,
              m.province AS mob_province, m.city AS mob_city, m.carrier AS mob_carrier,
              m.carrier_type AS mob_carrier_type, m.segment AS mob_segment
       FROM fj_id_card f
       LEFT JOIN fj_admin_region r ON f.region_code = r.region_code
       LEFT JOIN fj_constellation c ON f.birth_mmdd IS NOT NULL
            AND ((c.start_mmdd <= c.end_mmdd AND f.birth_mmdd BETWEEN c.start_mmdd AND c.end_mmdd)
              OR (c.start_mmdd > c.end_mmdd AND (f.birth_mmdd >= c.start_mmdd OR f.birth_mmdd <= c.end_mmdd)))
       LEFT JOIN fj_mobile_segment m ON LEFT(f.mobile, 7) = m.segment
       WHERE f.id = ? LIMIT 1`,
      [Number(id)]
    );
    if (!rows.length) return null;
    const raw = rows[0];
    const person = enrich(raw);
    // 关联推导
    person.region_province = raw.reg_province || '';
    person.region_city = raw.reg_city || '';
    person.region_district = raw.reg_district || '';
    person.constellation = raw.constellation || '';
    person.age = raw.age == null ? null : Number(raw.age);
    person.age_stage = ageStage(raw.age);
    person.mob_province = raw.mob_province || '';
    person.mob_city = raw.mob_city || '';
    person.mob_carrier = raw.mob_carrier || '';
    person.mob_carrier_type = raw.mob_carrier_type || '';
    person.hasRecord = false;
    // cdsgus 登记信息
    person.cdsgus = await repo.cdsgusByCard(person.card_no);
    if (person.cdsgus && person.cdsgus.length) person.hasRecord = true;
    // 手机所属地区完整名
    const mp = person.mob_province, mc = person.mob_city;
    person.mobile_region = (mp && mc && mp !== mc) ? `${mp} ${mc}` : (mp || mc || '');
    // 地区完整名
    const rp = person.region_province, rc = person.region_city, rd = person.region_district;
    const parts = [rp, rc, rd].filter(Boolean);
    person.full_region = parts.join(' ') || person.region_name || '—';
    return person;
  },

  async create({ name, card_no, mobile, relation, remark }) {
    const remarkVal = remark ? String(remark) : '';
    const mob = (mobile || '').trim();
    const cardNo = (card_no || '').trim();
    // 身份证号唯一性校验
    const dupCard = await this.findByCard(cardNo);
    if (dupCard) throw new Error('该身份证号已存在（所属：' + (dupCard.name || '未命名') + '），请核实');
    // 手机号唯一性校验（仅非空手机号，数据库层已有历史重复数据，故用应用层校验）
    if (mob) {
      const dup = await this.findByMobile(mob);
      if (dup) throw new Error('该手机号已存在（所属：' + (dup.name || '未命名') + '），请勿重复使用');
    }
    if (mysqlAvailable) {
      const [res] = await pool.query(
        'INSERT INTO fj_id_card (name, card_no, mobile, relation, remark) VALUES (?, ?, ?, ?, ?)',
        [name, cardNo, mob, relation == null ? null : Number(relation), remarkVal]
      );
      const newId = res.insertId;
      invalidateCountCache(); // 数据变更使列表 COUNT 缓存失效
      // 读取触发器/存储过程推导后的完整行，同步并入统计表（新增 +1）
      const [nrows] = await pool.query(`SELECT ${ROW_COLS} FROM fj_id_card WHERE id = ?`, [newId]);
      if (nrows.length) {
        const hasRecord = await cdsgusHasRecord(nrows[0].card_no);
        await statsAdjust(nrows[0], 1, hasRecord);
      }
      return repo.get(newId);
    }
    throw new Error('数据库未连接，无法新增人员');
  },

  async update(id, { name, card_no, mobile, relation, remark }) {
    const remarkVal = remark ? String(remark) : '';
    const mob = (mobile || '').trim();
    const cardNo = (card_no || '').trim();
    // 身份证号唯一性校验（排除自身）
    const dupCard = await this.findByCard(cardNo, Number(id));
    if (dupCard) throw new Error('该身份证号已存在（所属：' + (dupCard.name || '未命名') + '），请核实');
    // 手机号唯一性校验（排除自身）
    if (mob) {
      const dup = await this.findByMobile(mob, Number(id));
      if (dup) throw new Error('该手机号已存在（所属：' + (dup.name || '未命名') + '），请勿重复使用');
    }
    if (mysqlAvailable) {
      // 修改前：读旧行并按旧身份证的登记年份从统计表移除（-1）
      const [oldRows] = await pool.query(`SELECT ${ROW_COLS} FROM fj_id_card WHERE id = ?`, [Number(id)]);
      await pool.query(
        'UPDATE fj_id_card SET name=?, card_no=?, mobile=?, relation=?, remark=? WHERE id=?',
        [name, cardNo, mob, relation == null ? null : Number(relation), remarkVal, Number(id)]
      );
      invalidateCountCache(); // 数据变更使列表 COUNT 缓存失效
      // 修改后：读新行并按新身份证的登记年份并入统计表（+1）
      const [newRows] = await pool.query(`SELECT ${ROW_COLS} FROM fj_id_card WHERE id = ?`, [Number(id)]);
      if (oldRows.length) {
        const oHas = await cdsgusHasRecord(oldRows[0].card_no);
        await statsAdjust(oldRows[0], -1, oHas);
      }
      if (newRows.length) {
        const nHas = await cdsgusHasRecord(newRows[0].card_no);
        await statsAdjust(newRows[0], 1, nHas);
      }
      return repo.get(id);
    }
    throw new Error('数据库未连接，无法更新人员');
  },

  // 按身份证号查找记录（可选排除指定 id），用于唯一性校验
  async findByCard(cardNo, excludeId) {
    const c = String(cardNo || '').trim();
    if (!c) return null;
    if (mysqlAvailable) {
      const excludeSql = excludeId ? ' AND id != ?' : '';
      const args = excludeId ? [c, Number(excludeId)] : [c];
      const [rows] = await pool.query(
        'SELECT id, name, card_no FROM fj_id_card WHERE card_no = ?' + excludeSql + ' LIMIT 1',
        args
      );
      return rows.length ? rows[0] : null;
    }
    return null;
  },

  // 按手机号查找记录（可选排除指定 id），用于唯一性校验
  async findByMobile(mobile, excludeId) {
    const mob = String(mobile || '').trim();
    if (!mob) return null;
    if (mysqlAvailable) {
      const excludeSql = excludeId ? ' AND id != ?' : '';
      const args = excludeId ? [mob, Number(excludeId)] : [mob];
      const [rows] = await pool.query(
        'SELECT id, name, mobile FROM fj_id_card WHERE mobile = ?' + excludeSql + ' LIMIT 1',
        args
      );
      return rows.length ? rows[0] : null;
    }
    return null;
  },

  // 按身份证号集合批量查询已存在记录（导入全局唯一性校验用，返回 Map:card_no -> {name}）
  async findByCards(cardNos) {
    const map = new Map();
    const list = Array.from(new Set((cardNos || []).filter(c => String(c || '').trim())));
    if (!mysqlAvailable || !list.length) return map;
    for (let i = 0; i < list.length; i += 500) {
      const chunk = list.slice(i, i + 500);
      const ph = chunk.map(() => '?').join(',');
      const [rows] = await pool.query(`SELECT card_no, name FROM fj_id_card WHERE card_no IN (${ph})`, chunk);
      for (const r of rows) if (!map.has(String(r.card_no))) map.set(String(r.card_no), r);
    }
    return map;
  },

  // 按手机号集合批量查询已存在记录（导入全局唯一性校验用，返回 Map:mobile -> {name}）
  async findByMobiles(mobiles) {
    const map = new Map();
    const list = Array.from(new Set((mobiles || []).filter(m => String(m || '').trim())));
    if (!mysqlAvailable || !list.length) return map;
    for (let i = 0; i < list.length; i += 500) {
      const chunk = list.slice(i, i + 500);
      const ph = chunk.map(() => '?').join(',');
      const [rows] = await pool.query(`SELECT mobile, name FROM fj_id_card WHERE mobile IN (${ph})`, chunk);
      for (const r of rows) if (!map.has(String(r.mobile))) map.set(String(r.mobile), r);
    }
    return map;
  },

  // 批量导入人员（与手动新增同校验口径）。任一数据异常则整体不导入：
  // - 校验：姓名必填≤20、身份证 18 位合法且全局唯一、手机号选填但格式正确且全局唯一、备注≤500、文件内去重
  // - 关系：按名称匹配关系字典（中文括号统一转英文括号），不存在则自动新增（负整数编码，不受自定义 6 个上限约束）
  // - 事务：新增关系 + 人员插入 + 统计表增量在同一事务内，任一步失败整体回滚
  async importBatch(items, createdBy) {
    if (!mysqlAvailable) throw new Error('数据库未连接，无法导入人员');
    if (!Array.isArray(items) || !items.length) throw new Error('导入数据为空');
    if (items.length > 5000) throw new Error('单次导入最多 5000 条，请拆分后分批导入');

    const trim = (s) => String(s == null ? '' : s).trim();
    const normCard = (s) => trim(s);
    const normMob = (s) => trim(s).replace(/[-\s]/g, '');
    const normRel = (s) => trim(s).replace(/（/g, '(').replace(/）/g, ')');

    const errors = [];
    const seenCard = new Map(); // 文件内身份证去重：card_no -> 行号
    const seenMob = new Map();  // 文件内手机号去重：mobile -> 行号

    // ---- 1) 逐条格式校验（行号 = 模板数据行：第 1 行为表头） ----
    const rows = [];
    for (let i = 0; i < items.length; i++) {
      const raw = items[i] || {};
      const rowNo = i + 2;
      const name = trim(raw.name);
      const cardNo = normCard(raw.card_no);
      const mobile = normMob(raw.mobile);
      const relation = normRel(raw.relation);
      const remark = trim(raw.remark);
      const bad = [];
      if (!name) bad.push('姓名不能为空');
      else if (name.length > 20) bad.push('姓名最长 20 个字符');
      if (!cardNo) bad.push('身份证号不能为空');
      else {
        const p = parseIdCard(cardNo);
        if (!p || p.invalid || p.cardLen !== 18) bad.push('身份证号需为 18 位合法号码');
      }
      if (mobile && !/^1\d{10}$/.test(mobile)) bad.push('手机号需为 11 位数字且以 1 开头');
      if (remark.length > 500) bad.push('备注最长 500 个字符');
      if (cardNo && seenCard.has(cardNo)) bad.push(`文件内身份证号重复（第 ${seenCard.get(cardNo)} 行）`);
      if (mobile && seenMob.has(mobile)) bad.push(`文件内手机号重复（第 ${seenMob.get(mobile)} 行）`);
      if (bad.length) {
        errors.push({ row: rowNo, name: name || '(未命名)', msg: bad.join('；') });
        continue;
      }
      if (cardNo) seenCard.set(cardNo, rowNo);
      if (mobile) seenMob.set(mobile, rowNo);
      rows.push({ name, card_no: cardNo, mobile, relation, remark, rowNo });
    }

    // ---- 2) 与库内既有数据冲突（身份证/手机号全局唯一，与手动新增同口径） ----
    if (!errors.length) {
      const byCard = await this.findByCards(rows.map(r => r.card_no));
      for (const r of rows) {
        const dup = byCard.get(r.card_no);
        if (dup) errors.push({ row: r.rowNo, name: r.name, msg: `身份证号已存在（所属：${dup.name || '未命名'}）` });
      }
      const mobiles = rows.map(r => r.mobile).filter(Boolean);
      const byMob = await this.findByMobiles(mobiles);
      for (const r of rows) {
        if (!r.mobile) continue;
        const dup = byMob.get(r.mobile);
        if (dup) errors.push({ row: r.rowNo, name: r.name, msg: `手机号已存在（所属：${dup.name || '未命名'}）` });
      }
    }
    if (errors.length) {
      const err = new Error(`共 ${errors.length} 条数据存在异常，本次未导入任何数据`);
      err.code = 'IMPORT_INVALID';
      err.errors = errors;
      throw err;
    }

    // ---- 3) 关系解析：按名称匹配字典，不存在则自动新增（负整数编码） ----
    const relRows = await listRelations(false);
    const relMap = new Map(relRows.map(r => [r.label, r.value]));
    const pendingRels = [];  // {label, value, sort} 待事务内入库的新关系
    let customValue = null;  // 惰性计算：当前最小负整数 - 1
    let nextSort = relRows.reduce((m, r) => Math.max(m, r.sort || 0), 0);
    for (const r of rows) {
      if (!r.relation) { r.value = null; continue; }
      if (!relMap.has(r.relation)) {
        if (customValue == null) customValue = await nextCustomValue();
        relMap.set(r.relation, customValue);
        pendingRels.push({ label: r.relation, value: customValue, sort: ++nextSort });
        customValue -= 1;
      }
      r.value = relMap.get(r.relation);
    }

    // ---- 4) 事务导入：新关系 + 人员批量插入 + 统计表增量，任一步失败整体回滚 ----
    const conn = await pool.getConnection();
    try {
      await conn.query('START TRANSACTION');
      for (const pr of pendingRels) {
        await conn.query(
          `INSERT INTO ${RELATION_TABLE} (value, label, is_builtin, sort, created_by) VALUES (?, ?, 0, ?, ?)`,
          [pr.value, pr.label, pr.sort, createdBy || null]
        );
      }
      const ref = await statsRefData();
      const statsOk = !!(ref && await statsAvailable());
      for (let i = 0; i < rows.length; i += 500) {
        const slice = rows.slice(i, i + 500);
        const ph = slice.map(() => '(?,?,?,?,?)').join(',');
        const vals = slice.flatMap(r => [r.name, r.card_no, r.mobile, r.value, r.remark]);
        await conn.query(
          `INSERT INTO fj_id_card (name, card_no, mobile, relation, remark) VALUES ${ph}`,
          vals
        );
        // 回读完整行（触发器填充 region_code/birth 等派生字段），同步统计表保证看板口径一致
        const cards = slice.map(r => r.card_no);
        const cph = cards.map(() => '?').join(',');
        const [inserted] = await conn.query(
          `SELECT ${ROW_COLS} FROM fj_id_card WHERE card_no IN (${cph})`,
          cards
        );
        if (statsOk) {
          for (const row of inserted) {
            const hasRec = await cdsgusHasRecordOn(conn, row.card_no);
            const keys = buildStatsKeys(row, ref.consts, ref.segMap, hasRec);
            await applyStatsKeysOn(conn, keys, 1);
          }
        }
      }
      await conn.query('COMMIT');
    } catch (e) {
      await conn.query('ROLLBACK').catch(() => {});
      // 唯一约束冲突（并发写入等极端情况）转为可读提示
      if (e && e.code === 'ER_DUP_ENTRY' && /^Duplicate entry '([^']+)'/.test(e.message || '')) {
        const dupVal = e.message.match(/^Duplicate entry '([^']+)'/)[1];
        throw new Error(`导入失败：存在唯一性冲突（${dupVal} 已在库中），已整体回滚，请修正后重新导入`);
      }
      throw e;
    } finally {
      conn.release();
    }
    invalidateCountCache();
    relationCache = { at: 0, rows: null }; // 可能自动新增了关系，清字典缓存
    return { imported: rows.length, newRelations: pendingRels.length };
  },

  async stats(opts = {}) {
    if (!mysqlAvailable) throw new Error('数据库未连接，无法读取统计数据');
    const { q, relation, nomobile } = opts;
    const hasFilter = q || nomobile || (relation != null && relation !== '');

    // 无筛选：优先读预聚合统计表（总数/无手机/关系分布），避免 1868 万行聚合
    if (!hasFilter) {
      const [rows] = await pool.query(
        `SELECT dim, bucket, cnt FROM fj_id_card_stats WHERE dim IN ('c@all','m@all','relation@all')`
      );
      const gm = {};
      for (const r of rows) (gm[r.dim] = gm[r.dim] || {})[r.bucket] = Number(r.cnt);
      const c = gm['c@all'] || {};
      if (c.total != null) {
        const m = gm['m@all'] || {};
        const byRelation = {};
        for (const [k, v] of Object.entries(gm['relation@all'] || {})) {
          byRelation[k === NULL_KEY ? 'null' : k] = v;
        }
        return {
          total: c.total,
          noMobile: m.nomob != null ? m.nomob : c.total - (m.withmob || 0),
          byRelation
        };
      }
      // 统计表缺失，回退实时聚合
      const [[totalRow], [noMobileRow], [relRows]] = await Promise.all([
        pool.query('SELECT COUNT(*) AS c FROM fj_id_card'),
        pool.query("SELECT COUNT(*) AS c FROM fj_id_card WHERE mobile IS NULL OR TRIM(mobile) = ''"),
        pool.query('SELECT relation, COUNT(*) AS c FROM fj_id_card GROUP BY relation')
      ]);
      const byRelation = {};
      for (const r of relRows) {
        const key = r.relation == null ? 'null' : String(r.relation);
        byRelation[key] = Number(r.c);
      }
      return {
        total: Number(totalRow[0].c),
        noMobile: Number(noMobileRow[0].c),
        byRelation
      };
    }

    // 有筛选（搜索/关系/无手机）：复用列表 WHERE，走已缓存的 COUNT，避免每页重复全扫
    const { where, args } = buildListWhere({ q, relation, nomobile });
    const ck = countCacheKey(q, nomobile, relation);
    let total = getCachedCount(ck);
    if (total == null) {
      const [countRes] = await pool.query(`SELECT COUNT(*) AS c FROM fj_id_card ${where}`, args);
      total = Number(countRes[0]?.c || 0);
      setCachedCount(ck, total);
    }
    // 无手机数：在筛选基础上叠加 mobile 空条件（复用同一缓存 key 派生，避免重复全扫）
    let noMobile = 0;
    const noMobWhere = where
      ? `${where} AND (mobile IS NULL OR TRIM(mobile) = '')`
      : 'WHERE (mobile IS NULL OR TRIM(mobile) = \'\')';
    const nk = countCacheKey(q, nomobile ? nomobile : 'subnomob', relation);
    const nCached = getCachedCount(nk);
    if (nCached != null) noMobile = nCached;
    else {
      const [nmRes] = await pool.query(`SELECT COUNT(*) AS c FROM fj_id_card ${noMobWhere}`, args);
      noMobile = Number(nmRes[0]?.c || 0);
      setCachedCount(nk, noMobile);
    }
    // 关系分布：带搜索条件时无法低成本聚合，置空由前端隐藏（避免展示全库值误导）
    return { total, noMobile, byRelation: {} };
  },

  async remove(id) {
    if (mysqlAvailable) {
      // 删除前：读被删行并按身份证的登记年份从统计表移除（-1）
      const [oldRows] = await pool.query(`SELECT ${ROW_COLS} FROM fj_id_card WHERE id = ?`, [Number(id)]);
      const [res] = await pool.query('DELETE FROM fj_id_card WHERE id=?', [Number(id)]);
      invalidateCountCache(); // 数据变更使列表 COUNT 缓存失效
      if ((res.affectedRows || 0) > 0 && oldRows.length) {
        const hasRecord = await cdsgusHasRecord(oldRows[0].card_no);
        await statsAdjust(oldRows[0], -1, hasRecord);
      }
      return (res.affectedRows || 0) > 0;
    }
    throw new Error('数据库未连接，无法删除人员');
  },

  // 按身份证号查询 cdsgus 登记信息（同一卡号可能存在多条登记）
  async cdsgusByCard(cardNo) {
    const c = String(cardNo || '').trim();
    if (!c) return [];
    if (!mysqlAvailable) return [];
    const [rows] = await pool.query(
      `SELECT id, Name, CardNo, Descriot, CtfTp, CtfId, Gender, Birthday, Address, Zip,
              Nation, Education, Company, EMail, Mobile, Tel, Duty, Version, Family
       FROM cdsgus WHERE CtfId = ? ORDER BY id`,
      [c]
    );
    return rows.map(r => ({
      id: r.id,
      name: r.Name || '',
      card_type: r.CtfTp || '',
      card_no: r.CtfId || '',
      gender: r.Gender || '',
      birthday: r.Birthday || '',
      address: r.Address || '',
      nation: r.Nation || '',
      education: r.Education || '',
      company: r.Company || '',
      email: r.EMail || '',
      mobile: r.Mobile || '',
      tel: r.Tel || '',
      duty: r.Duty || '',
      version: r.Version || ''
    }));
  },

  // ---------- 看板分析 ----------

  // 人员信息维度聚合：实时版本（统计表未重建时的回退路径）
  async dashboardLive(scope = {}) {
    if (!mysqlAvailable) return null;
    const where = dashboardWhere(scope);
    const base = baseFrom(where);

    const qGender = `SELECT f.gender_code AS \`key\`, COUNT(*) AS count ${base} GROUP BY f.gender_code`;
    const qSurname = `SELECT LEFT(f.name,1) AS \`key\`, COUNT(*) AS count ${base} ${condClause(where, `f.name<>''`)} GROUP BY LEFT(f.name,1) ORDER BY count DESC`;
    const qRegionProv = `SELECT LEFT(f.region_code,2) AS k2, COUNT(*) AS count ${base} ${condClause(where, `f.region_code IS NOT NULL`)} GROUP BY LEFT(f.region_code,2) ORDER BY count DESC`;
    const qBirthYear = `SELECT LEFT(f.birth_date_str,4) AS \`key\`, COUNT(*) AS count ${base} ${condClause(where, `f.birth_date_str IS NOT NULL AND f.birth_date_str <> ''`)} GROUP BY LEFT(f.birth_date_str,4) ORDER BY \`key\``;
    const qBirthMonth = `SELECT SUBSTRING(f.birth_date_str,5,2) AS \`key\`, COUNT(*) AS count ${base} ${condClause(where, `f.birth_date_str IS NOT NULL`)} GROUP BY SUBSTRING(f.birth_date_str,5,2) ORDER BY \`key\``;
    const qConstellation = `SELECT c.name AS \`key\`, COUNT(*) AS count FROM fj_id_card f LEFT JOIN fj_constellation c ON f.birth_mmdd IS NOT NULL AND ((c.start_mmdd<=c.end_mmdd AND f.birth_mmdd BETWEEN c.start_mmdd AND c.end_mmdd) OR (c.start_mmdd>c.end_mmdd AND (f.birth_mmdd>=c.start_mmdd OR f.birth_mmdd<=c.end_mmdd))) ${where} GROUP BY c.name`;
    const qRelation = `SELECT f.relation AS \`key\`, COUNT(*) AS count ${base} GROUP BY f.relation`;

    const ageExpr = `TIMESTAMPDIFF(YEAR, STR_TO_DATE(f.birth_date_str,'%Y%m%d'), CURDATE())`;
    const qAge = `SELECT ${ageExpr} AS \`key\`, COUNT(*) AS count ${base} ${condClause(where, `f.birth_date_str IS NOT NULL AND f.birth_date_str <> ''`)} GROUP BY ${ageExpr} ORDER BY \`key\``;
    const qAgeStage = `SELECT
      CASE WHEN ${ageExpr} <= 6 THEN '幼儿（0-6岁）'
           WHEN ${ageExpr} <= 12 THEN '少儿（7-12岁）'
           WHEN ${ageExpr} <= 17 THEN '少年（13-17岁）'
           WHEN ${ageExpr} <= 35 THEN '青年（18-35岁）'
           WHEN ${ageExpr} <= 50 THEN '中年（36-50岁）'
           WHEN ${ageExpr} <= 65 THEN '老年（51-65岁）'
           ELSE '高龄（65岁以上）' END AS \`key\`,
      COUNT(*) AS count ${base} ${condClause(where, `f.birth_date_str IS NOT NULL AND f.birth_date_str <> ''`)} GROUP BY \`key\` ORDER BY count DESC`;

    const qCy = `SELECT YEAR(f.created_at) AS \`key\`, COUNT(*) AS count ${base} GROUP BY YEAR(f.created_at)`;
    const [g, s, rp, by, bm, con, rel, ag, ags, cyRows] = await Promise.all([
      pool.query(qGender), pool.query(qSurname), pool.query(qRegionProv),
      pool.query(qBirthYear), pool.query(qBirthMonth), pool.query(qConstellation), pool.query(qRelation),
      pool.query(qAge), pool.query(qAgeStage), pool.query(qCy)
    ]);

    const counts = await (async () => {
      const [t] = await pool.query(`SELECT COUNT(*) AS total ${base}`);
      const [w] = await pool.query(`SELECT COUNT(*) AS total ${base} ${condClause(where, `EXISTS (SELECT 1 FROM cdsgus d WHERE d.ctfid = f.card_no)`)}`);
      const total = Number(t[0]?.total || 0);
      const withRecord = Number(w[0]?.total || 0);
      const gMap = {};
      for (const r of g[0]) gMap[String(r.key)] = Number(r.count);
      const cyMap = {};
      for (const r of cyRows[0]) cyMap[String(r.key)] = Number(r.count);
      return {
        total,
        withRecord,
        withoutRecord: total - withRecord,
        male: Number(gMap['1'] || 0),
        female: Number(gMap['0'] || 0),
        newThisYear: Number(cyMap[String(new Date().getFullYear())] || 0)
      };
    })();

    return {
      counts,
      gender: g[0],
      surname: s[0],
      regionProvince: rp[0],
      birthYear: by[0],
      birthMonth: bm[0],
      constellation: con[0],
      age: ag[0],
      ageStage: ags[0],
      relation: rel[0]
    };
  },

  // 手机信息维度聚合：实时版本（统计表未重建时的回退路径）
  async dashboardMobileLive(scope = {}) {
    if (!mysqlAvailable) return null;
    const where = dashboardWhere(scope);
    const base = baseFrom(where);

    const qWith = `SELECT COUNT(*) AS total ${base} ${condClause(where, `f.mobile IS NOT NULL AND TRIM(f.mobile) <> ''`)}`;
    const qTotal = `SELECT COUNT(*) AS total ${base}`;
    const qProv = `SELECT COALESCE(NULLIF(m.province,''),'未知') AS \`key\`, COUNT(*) AS count
      FROM fj_id_card f LEFT JOIN fj_mobile_segment m ON LEFT(f.mobile,7)=m.segment
      ${andCond(where, `f.mobile IS NOT NULL AND TRIM(f.mobile) <> ''`)}
      GROUP BY COALESCE(NULLIF(m.province,''),'未知') ORDER BY count DESC`;
    const qCarrier = `SELECT COALESCE(NULLIF(m.carrier,''),'未知') AS \`key\`, COUNT(*) AS count
      FROM fj_id_card f LEFT JOIN fj_mobile_segment m ON LEFT(f.mobile,7)=m.segment
      ${andCond(where, `f.mobile IS NOT NULL AND TRIM(f.mobile) <> ''`)}
      GROUP BY COALESCE(NULLIF(m.carrier,''),'未知') ORDER BY count DESC`;

    const [tot, withM, prov, car] = await Promise.all([
      pool.query(qTotal), pool.query(qWith), pool.query(qProv), pool.query(qCarrier)
    ]);
    const total = Number((tot[0] && tot[0][0] && tot[0][0].total) || 0);
    const withMobile = Number((withM[0] && withM[0][0] && withM[0][0].total) || 0);
    return {
      counts: { total, withMobile, withoutMobile: total - withMobile },
      mobileProvince: prov[0],
      carrier: car[0]
    };
  },

  // 地区下钻：level=province|city|district + parent 返回同层地区列表及人数
  // 数据侧 region_code 为 6 位区级码；city 层按前2位省份聚合、district 层按前4位城市聚合
  async dashboardRegionTree(level, parent, scope = {}) {
    if (!mysqlAvailable) return null;
    const where = dashboardWhere(scope);

    if (level === 'province') {
      // 省级优先读统计表 region2@<scope>（毫秒级），避免 1868 万行全表 GROUP BY
      const suf = dashScopeSuffix(scope);
      const [rows] = await pool.query(
        `SELECT bucket, cnt FROM fj_id_card_stats WHERE dim = ?`, ['region2@' + suf]
      );
      if (rows.length) {
        // 全局关系筛选 → 省级计数同步差分（与看板地域图表口径一致）
        const relDelta = await relationDeltaBuckets(suf, scope);
        const cnt = {};
        for (const r of rows) cnt[r.bucket] = Number(r.cnt);
        if (relDelta) {
          const { includeNull, allMap, selMap } = relDelta;
          const allR = allMap['region2'] || {}, selR = selMap['region2'] || {};
          const f = {};
          for (const b of new Set([...Object.keys(cnt), ...Object.keys(allR), ...Object.keys(selR)])) {
            const v = includeNull
              ? Number(cnt[b] || 0) - Number(allR[b] || 0) + Number(selR[b] || 0)
              : Number(selR[b] || 0);
            if (v > 0) f[b] = v;
          }
          for (const k of Object.keys(cnt)) if (!(k in f)) delete cnt[k];
          Object.assign(cnt, f);
        }
        // 2 位前缀 -> 省份名映射（行政区域表小表查询）
        const [prov] = await pool.query(
          `SELECT DISTINCT LEFT(region_code,2) AS code, province FROM fj_admin_region
           WHERE province IS NOT NULL AND TRIM(province) <> ''`
        );
        const nameMap = {};
        for (const r of prov) if (!nameMap[r.code]) nameMap[r.code] = r.province;
        return Object.entries(cnt)
          .map(([b, c]) => ({ province: nameMap[b] || b, code: b, count: Number(c) }))
          .sort((a, b) => b.count - a.count);
      }
      // 统计表缺失 -> 回退实时查询
      const [res] = await pool.query(
        `SELECT r.province AS province, LEFT(f.region_code,2) AS code, COUNT(*) AS count
         FROM fj_id_card f LEFT JOIN fj_admin_region r ON f.region_code = r.region_code
         ${andCond(where, `f.region_code IS NOT NULL`)}
         GROUP BY r.province, LEFT(f.region_code,2) HAVING count > 0 ORDER BY count DESC`
      );
      return res;
    }

    let sql;
    if (level === 'city') {
      const p2 = String(parent || '').slice(0, 2);
      // LIKE 前缀命中 idx_region_code，避免对 1868 万行做 LEFT() 函数扫描
      sql = `SELECT r.province AS province, r.city AS city, LEFT(f.region_code,4) AS code, COUNT(*) AS count
        FROM fj_id_card f LEFT JOIN fj_admin_region r ON f.region_code = r.region_code
        ${andCond(where, `f.region_code LIKE '${p2}%'`)}
        GROUP BY r.province, r.city, LEFT(f.region_code,4) HAVING count > 0 ORDER BY count DESC`;
    } else { // district，parent 为 4 位市码
      const c4 = String(parent || '').slice(0, 4);
      sql = `SELECT r.province AS province, r.city AS city, r.district AS district, f.region_code AS code, COUNT(*) AS count
        FROM fj_id_card f LEFT JOIN fj_admin_region r ON f.region_code = r.region_code
        ${andCond(where, `f.region_code LIKE '${c4}%'`)}
        GROUP BY r.province, r.city, r.district, f.region_code HAVING count > 0 ORDER BY count DESC`;
    }
    const [rows] = await pool.query(sql);
    return rows;
  },

  // 人员明细（供弹窗展示），分页；district 层支持完整6位区码或4位市码
  // filters 用于支持看板图表点击下钻：gender/surname/birthYear/birthMonth/constellation/age/ageStage/relation/mobileProvince/carrier/hasRec/hasMob
  async dashboardPeople({ level, parent, scope = {}, page = 1, pageSize = 20, filters = {}, q }) {
    if (!mysqlAvailable) return null;
    // 图表点击维度 -> 预聚合统计表维度名（filters 键与统计表 dim 同名，值口径见 DIM 快路径）
    // hasRec 与 scope.hasRecord 语义相同：统计卡点击传入 filters.hasRec，
    // 提升为 scope 以便纯 scope 场景复用统计表计数（否则 NOT EXISTS 反连接全表扫描 120s+）
    if (filters.hasRec === 'yes' || filters.hasRec === 'no') {
      if (scope.hasRecord === 'all' || scope.hasRecord === undefined) scope = { ...scope, hasRecord: filters.hasRec };
      delete filters.hasRec;
    }
    const where = dashboardWhere(scope);
    const p = String(parent || '');
    let codeExpr = '1=1'; // 默认全部（全国 / 无地区过滤）
    if (p) {
      if (level === 'province') codeExpr = `f.region_code LIKE '${p.slice(0, 2)}%'`;
      else if (level === 'city') codeExpr = `f.region_code LIKE '${p.slice(0, 4)}%'`;
      else if (level === 'district') {
        // 6 位区码 → 精确匹配该区；4 位市码 → 匹配该市下所有区
        codeExpr = p.length >= 6 ? `f.region_code = '${p.slice(0, 6)}'` : `f.region_code LIKE '${p.slice(0, 4)}%'`;
      }
    }

    // 合并地区条件与图表维度过滤条件
    const filterClause = dashboardFilterClause(filters);
    // 明细弹窗关键词模糊匹配：姓名 / 身份证号 / 手机号
    const kw = String(q || '').trim();
    const qClause = kw ? `(${likeClause('f.name', kw)} OR ${likeClause('f.card_no', kw)} OR ${likeClause('f.mobile', kw)})` : '';
    const allExtra = [codeExpr, filterClause, qClause].filter(s => s && s !== '1=1').join(' AND ');
    const cond = allExtra ? andCond(where, allExtra) : where;

    const size = Math.max(1, Math.min(500, Number(pageSize) || 20));
    const current = Math.max(1, Number(page) || 1);
    const offset = (current - 1) * size;

    // total 走预聚合统计表快路径（避免 1868 万行 COUNT/反连接/函数扫描），
    // 与明细行查询并行执行，缩短弹窗首屏等待时间
    const suf = dashScopeSuffix(scope);
    const statsCnt = async (dimScope, bucket) => {
      const [rows] = await pool.query(
        'SELECT cnt AS c FROM fj_id_card_stats WHERE dim = ? AND bucket = ? LIMIT 1',
        [dimScope, String(bucket)]
      );
      return rows.length ? Number(rows[0].c) : null;
    };
    const totalPromise = (async () => {
      // 关系筛选（scope.relations）会改变结果集口径：统计表 c@/region2/单维 bucket 均为全局计数，
      // 不反映关系筛选，命中关系筛选时必须跳过这些快路径，走通用 COUNT（f.relation 走 idx_relation 亚秒级）
      const hasRelScope = Array.isArray(scope.relations) && scope.relations.length;
      // 带关键词搜索时统计表无对应维度，直接回退通用 COUNT
      if (!kw) {
        // 1) 纯 scope（无地区/维度过滤，且无关系筛选）→ c@ 计数
        if (!p && !filterClause && !hasRelScope) {
          const [cRows] = await pool.query(
            `SELECT bucket, cnt FROM fj_id_card_stats WHERE dim = ?`,
            ['c@' + suf]
          );
          if (cRows.length) {
            const cm = {};
            for (const r of cRows) cm[r.bucket] = Number(r.cnt);
            if (suf === 'all' || suf.startsWith('yr')) return cm.total || 0;
            if (suf === 'rec1') return cm.hasrec || 0;
            if (suf === 'rec0') return cm.norec || 0;
          }
        }
        // 2) 省级下钻：region_code LIKE 'xx%' 与 region2 维度（前2位）口径一致（无关系筛选时）
        if (!filterClause && !hasRelScope && p && level === 'province') {
          const c = await statsCnt('region2@' + suf, p.slice(0, 2));
          if (c != null) return c;
        }
        // 3) 单维过滤（图表点击维度，无关系筛选）：值口径与 SQL 过滤条件一致时直接取统计表
        if (!p && filterClause && !hasRelScope) {
          const dims = Object.entries(filters).filter(([, v]) => v !== undefined && v !== null && v !== '');
          if (dims.length === 1) {
            const [dk, dv] = dims[0];
            const dim = DIM_BY_FILTER[dk];
            if (dim) {
              let bucket = String(dv);
              if (dk === 'birthMonth') bucket = String(dv).padStart(2, '0');
              else if (dk === 'gender' || dk === 'relation') bucket = dv === 'null' ? NULL_KEY : String(Number(dv));
              else if (dk === 'hasMob') bucket = dv === '1' ? 'withmob' : 'nomob';
              // 归属地/运营商"未知"口径不一致（SQL NOT EXISTS 会把无手机号行也计入），回退实时 COUNT
              if ((dk === 'mobileProvince' || dk === 'carrier') && bucket === '未知') bucket = null;
              if (bucket != null) {
                const c = await statsCnt(dim + '@' + suf, bucket);
                if (c != null) return c;
              }
            }
          }
        }
      }
      // 4) 兜底：通用 COUNT
      const [countRes] = await pool.query(`SELECT COUNT(*) AS c FROM fj_id_card f ${cond}`);
      return Number(countRes[0]?.c || 0);
    })();
    // 主键倒序排序，命中 PRIMARY 索引快速取页；禁止 LEFT()/函数排序（否则 1868 万行全表 filesort）
    // 有地区前缀过滤时 FORCE INDEX 引导优化器走 idx_region_code（否则可能误选 PRIMARY 倒序全表扫描）
    const forceIdx = p ? ' FORCE INDEX (idx_region_code)' : '';
    const rowsPromise = pool.query(
      `SELECT f.id, f.name, f.card_no, f.mobile, f.relation, f.region_code, f.birth_date_str, f.gender_code,
              r.province AS reg_province, r.city AS reg_city, r.district AS reg_district
       FROM fj_id_card f${forceIdx} LEFT JOIN fj_admin_region r ON f.region_code = r.region_code
       ${cond} ORDER BY f.id DESC LIMIT ${size} OFFSET ${offset}`
    );
    const [total, [rows]] = await Promise.all([totalPromise, rowsPromise]);
    // enrich 字段转换 + 标记是否登记
    const pageRows = rows.map(r => enrich({ ...r }));
    await markHasRecord(pageRows);
    return {
      rows: pageRows,
      total,
      page: current,
      pageSize: size,
      totalPages: Math.max(1, Math.ceil(total / size))
    };
  },

  // ---------- 看板预聚合统计表读取（主路径） ----------

  // 读统计表：某筛选范围下各维度计数
  // 返回 null 表示统计表无该范围数据（触发调用方回退实时聚合）
  async dashboardStatsRead(scope = {}) {
    if (!mysqlAvailable) return null;
    // 注意：关系多选（scope.relations 非空）不再整体回退实时聚合。
    // 口径拆分（与需求 3.1 一致）：
    //   1) 关系分布饼图：无关系取统计表 relation@__null__，有关系通过 dashboardRelationLive 实时聚合（idx_relation 覆盖索引，亚秒级）；
    //   2) 其余统计卡与图表：仍读统计表（按是否记录/全量范围），不随关系筛选逐维实时聚合，保证千万级表率上毫秒级出数。
    // 因此这里仅按 hasRecord 维度切分统计表维度后缀，relations 不影响统计表读取。
    const suf = dashScopeSuffix(scope);
    const dims = [].concat(DASH_DIMS.map(d => d + '@' + suf), ['c@' + suf, 'cy@' + suf]);
    const [rows] = await pool.query(
      `SELECT dim, bucket, cnt FROM fj_id_card_stats WHERE dim IN (${valToSqlParamList(dims)})`,
      dims
    );
    if (!rows.length) return null;
    const g = {};
    for (const r of rows) {
      const c = Number(r.cnt);
      if (c <= 0) continue; // 跳过统计表残留的 0/负计数 bucket，图表不渲染无意义空值
      (g[r.dim] = g[r.dim] || {})[r.bucket] = c;
    }
    return { suf, g };
  },

  // 人员信息维度聚合（优先统计表，未重建则实时回退）
  async dashboard(scope = {}) {
    if (!mysqlAvailable) return null;
    const st = await this.dashboardStatsRead(scope);
    if (st) {
      // 全局关系筛选 → 全部卡片/图表统一差分口径（有关系仅数百行，idx_relation 亚秒级）：
      //   无关系 = 统计表全量 − 全有关系实时值，有关系 = 所选关系实时值
      const relDelta = await relationDeltaBuckets(st.suf, scope);
      if (relDelta) applyRelationDelta(st, relDelta);
      const c = st.g['c@' + st.suf] || {};
      const gMap = st.g['gender@' + st.suf] || {};
      const cyMap = st.g['cy@' + st.suf] || {};
      const out = {
        counts: {
          total: Number(c.total || 0),
          withRecord: Number(c.hasrec || 0),
          withoutRecord: Number(c.norec || 0),
          // 关键指标卡：男性/女性（人数 + 占比由前端按 total 计算）、本年新增
          male: Number(gMap['1'] || 0),
          female: Number(gMap['0'] || 0),
          newThisYear: Number(cyMap[String(new Date().getFullYear())] || 0)
        },
        gender: [], surname: [], regionProvince: [], birthYear: [], birthMonth: [],
        constellation: [], relation: [], age: [], ageStage: []
      };
      for (const d of DASH_DIMS) {
        // 关系单独处理：无关系计数取统计表，有关系计数实时聚合（见下方）
        if (d === 'relation') continue;
        const m = st.g[d + '@' + st.suf] || {};
        let arr = Object.entries(m).map(([b, count]) => ({ key: dashKey(d, b), count }));
        const ord = DASH_ORDER[d];
        if (ord === 'ka') arr.sort((a, b) => String(a.key).localeCompare(String(b.key)));
        else if (ord === 'dc') arr.sort((a, b) => b.count - a.count);
        if (d === 'region2') out.regionProvince = arr.map(x => ({ k2: x.key, count: x.count }));
        else out[DASH_OUT[d]] = arr;
      }
      // 需求 3.1：无关系（__null__）从统计表获取，有关系人员实时聚合（idx_relation 覆盖索引）
      // 仅当用户未筛关系（全部）或明确勾选了「无关系」时，无关系人数才计入饼图；
      // 只选了具体关系时，无关系人员不属于筛选范围，relNull 置 0（否则会把全量无关系误入所选关系切片）
      const selRels = Array.isArray(scope.relations) ? scope.relations : [];
      const includeNull = selRels.length === 0 || selRels.includes('null');
      const relNull = includeNull ? Number((st.g['relation@' + st.suf] || {})[NULL_KEY] || 0) : 0;
      const relLive = await dashboardRelationLive(scope);
      out.relation = [];
      if (relNull > 0) out.relation.push({ key: null, count: relNull });
      for (const r of relLive) out.relation.push({ key: r.key, count: r.count });
      return out;
    }
    return this.dashboardLive(scope);
  },

  // 手机信息维度聚合（优先统计表，未重建则实时回退）
  async dashboardMobile(scope = {}) {
    if (!mysqlAvailable) return null;
    const suf = dashScopeSuffix(scope);
    const dims = ['m@' + suf, 'mprov@' + suf, 'mcarrier@' + suf];
    const [rows] = await pool.query(
      `SELECT dim, bucket, cnt FROM fj_id_card_stats WHERE dim IN (${valToSqlParamList(dims)})`,
      dims
    );
    if (!rows.length) return this.dashboardMobileLive(scope);
    const g = {};
    for (const r of rows) (g[r.dim] = g[r.dim] || {})[r.bucket] = Number(r.cnt);
    // 全局关系筛选 → 手机卡片/图表统一差分口径（与 dashboard() 一致）
    const relDelta = await relationDeltaBuckets(suf, scope);
    if (relDelta) applyRelationDelta({ g }, relDelta);
    const m = g['m@' + suf] || {};
    const toArr = (kv) => Object.entries(kv || {}).map(([b, count]) => ({ key: b, count })).sort((a, b) => b.count - a.count);
    return {
      counts: { total: Number(m.total || 0), withMobile: Number(m.withmob || 0), withoutMobile: Number(m.nomob || 0) },
      mobileProvince: toArr(g['mprov@' + suf]),
      carrier: toArr(g['mcarrier@' + suf])
    };
  }
};

module.exports = {
  repo, initMysql, testConnection, getEnvInfo,
  initRelationTable, syncTableComments, rebuildInfoView, listRelations, createRelation, deleteRelation
};