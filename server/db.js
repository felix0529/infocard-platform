/**
 * 数据访问层
 * - 默认连接 MySQL infocard_test 库的 fj_id_card 表
 * - 可通过 .env 文件或环境变量覆盖 DB_HOST/PORT/USER/PASSWORD/NAME
 * - 若连接失败则使用内存演示数据回退，保证前端可离线预览
 */
const fs = require('fs');
const path = require('path');
const { parseIdCard, relationLabel } = require('./idcard');

// ---------- 加载 .env ----------
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  try {
    const txt = fs.readFileSync(envPath, 'utf-8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*(DB_\w+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}
loadEnv();

// ---------- 数据库配置 ----------
const DB = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'trae',
  password: process.env.DB_PASSWORD || 'myTrae_2026',
  database: process.env.DB_NAME || 'infocard_test'
};

const JSON_SEED = path.join(__dirname, '..', 'seed-demo.json');

function loadDemoRows() {
  try {
    const raw = fs.readFileSync(JSON_SEED, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

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
  } else {
    // 演示模式：无 cdsgus 数据，默认 false
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

async function testConnection() {
  if (!mysqlAvailable) return false;
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (e) {
    // 回退到演示数据
    mysqlAvailable = false;
    return false;
  }
}

const MODE = { name: 'demo', rows: loadDemoRows() };
let nextId = MODE.rows.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1;

function persistDemo() {
  try {
    fs.writeFileSync(JSON_SEED, JSON.stringify(MODE.rows, null, 2), 'utf-8');
  } catch (e) {
    // ignore
  }
}

// ---------- 仓储接口 ----------
function applyFilters(rows, opts = {}) {
  let out = rows;
  const { q, relation, nomobile } = opts;
  if (nomobile) out = out.filter(r => !(r.mobile && r.mobile.trim()));
  if (relation != null && relation !== '') {
    const v = relation === 'null' ? null : Number(relation);
    out = out.filter(r => (r.relation == null ? null : Number(r.relation)) === v);
  }
  if (q) {
    const kw = String(q).toLowerCase().trim();
    if (kw) {
      out = out.filter(r =>
        String(r.name || '').toLowerCase().includes(kw) ||
        String(r.card_no || '').toLowerCase().includes(kw) ||
        String(r.mobile || '').trim().toLowerCase().includes(kw)
      );
    }
  }
  return out;
}

// ---------- 看板统计：筛选与聚合辅助 ----------
// 已登记/登记年份 → 动态 WHERE（作用于主表别名 f）
// scope = { hasRecord: 'all'|'yes'|'no', regYear: string|null }
function dashboardWhere(scope = {}) {
  const { hasRecord = 'all', regYear } = scope;
  const cond = [];
  if (hasRecord === 'yes') {
    if (regYear) {
      // 该身份证在 cdsgus 中有记录，且存在任意一条记录的年份 = regYear
      cond.push(`EXISTS (SELECT 1 FROM cdsgus d WHERE d.ctfid = f.card_no AND LEFT(d.Version, 4) = ${Number(regYear)})`);
    } else {
      cond.push('EXISTS (SELECT 1 FROM cdsgus d WHERE d.ctfid = f.card_no)');
    }
  } else if (hasRecord === 'no') {
    cond.push('NOT EXISTS (SELECT 1 FROM cdsgus d WHERE d.ctfid = f.card_no)');
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
    parts.push(`LEFT(f.name,1) = ${escVal(filters.surname)}`);
  }
  if (filters.birthYear && /^\d{4}$/.test(String(filters.birthYear))) {
    parts.push(`LEFT(f.birth_date_str,4) = ${escVal(String(filters.birthYear))}`);
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
  if (filters.mobileProvince) {
    if (String(filters.mobileProvince) === '未知') {
      parts.push(`NOT EXISTS (SELECT 1 FROM fj_mobile_segment m2 WHERE LEFT(f.mobile,7)=m2.segment AND m2.province IS NOT NULL AND m2.province <> '')`);
    } else {
      parts.push(`EXISTS (SELECT 1 FROM fj_mobile_segment m2 WHERE LEFT(f.mobile,7)=m2.segment AND m2.province = ${escVal(filters.mobileProvince)})`);
    }
  }
  if (filters.carrier) {
    if (String(filters.carrier) === '未知') {
      parts.push(`NOT EXISTS (SELECT 1 FROM fj_mobile_segment m2 WHERE LEFT(f.mobile,7)=m2.segment AND m2.carrier IS NOT NULL AND m2.carrier <> '')`);
    } else {
      parts.push(`EXISTS (SELECT 1 FROM fj_mobile_segment m2 WHERE LEFT(f.mobile,7)=m2.segment AND m2.carrier = ${escVal(filters.carrier)})`);
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
  return parts.join(' AND ');
}

const repo = {
  async query(opts = {}) {
    const { page = 1, pageSize = 20, q, relation, nomobile } = opts;
    const size = Math.max(1, Math.min(500, Number(pageSize) || 20));
    const current = Math.max(1, Number(page) || 1);
    const offset = (current - 1) * size;

    let total;
    let pageRows;

    if (mysqlAvailable) {
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
      const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
      const [countRes] = await pool.query(`SELECT COUNT(*) AS c FROM fj_id_card ${where}`, args);
      total = Number(countRes[0]?.c || 0);
      const sql_ = `SELECT f.id, f.name, f.card_no, f.mobile, f.relation, f.remark, f.region_code,
                           r.province AS reg_province, r.city AS reg_city, r.district AS reg_district
                    FROM fj_id_card f
                    LEFT JOIN fj_admin_region r ON f.region_code = r.region_code
                    ${where} ORDER BY f.id LIMIT ? OFFSET ?`;
      const [rows] = await pool.query(sql_, [...args, size, offset]);
      pageRows = rows.map(r => enrich({ ...r, gender_code: null }));
    } else {
      const all = MODE.rows.map(r => enrich(r));
      const filtered = applyFilters(all, { q, relation, nomobile });
      total = filtered.length;
      pageRows = filtered.slice(offset, offset + size);
    }

    const totalPages = Math.max(1, Math.ceil(total / size));
    await markHasRecord(pageRows);
    return { rows: pageRows, total, page: current, pageSize: size, totalPages };
  },

  async list() { return (await repo.query({ pageSize: 1000 })).rows; },

  async get(id) {
    if (mysqlAvailable) {
      const [rows] = await pool.query(
        'SELECT id, name, card_no, mobile, relation, remark, region_code, birth_date_str, birth_mmdd, gender_code FROM fj_id_card WHERE id=? LIMIT 1',
        [Number(id)]
      );
      if (!rows.length) return null;
      return enrich(rows[0]);
    }
    const row = MODE.rows.find(r => r.id === Number(id));
    return row ? enrich(row) : null;
  },

  // 详情：人员基础信息 + 三表关联推导（地区/年龄/阶段/星座/手机归属/运营商）
  async personDetail(id) {
    if (mysqlAvailable) {
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
    }
    // demo 模式
    const found = MODE.rows.find(r => r.id === Number(id));
    if (!found) return null;
    const person = enrich(found);
    person.cdsgus = [];
    person.age = null;
    person.age_stage = null;
    person.constellation = '';
    person.mobile_region = '';
    person.mob_carrier = '';
    person.mob_carrier_type = '';
    person.full_region = person.region_name || '—';
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
      return repo.get(res.insertId);
    }
    const id = nextId++;
    MODE.rows.push({ id, name, card_no: cardNo, mobile: mob, relation: relation == null ? null : Number(relation), remark: remarkVal });
    persistDemo();
    return repo.get(id);
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
      await pool.query(
        'UPDATE fj_id_card SET name=?, card_no=?, mobile=?, relation=?, remark=? WHERE id=?',
        [name, cardNo, mob, relation == null ? null : Number(relation), remarkVal, Number(id)]
      );
      return repo.get(id);
    }
    const row = MODE.rows.find(r => r.id === Number(id));
    if (!row) return null;
    Object.assign(row, { name, card_no: cardNo, mobile: mob, relation: relation == null ? null : Number(relation), remark: remarkVal });
    persistDemo();
    return repo.get(id);
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
    const row = MODE.rows.find(r => r.card_no && String(r.card_no).trim() === c && r.id !== excludeId);
    return row || null;
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
    const row = MODE.rows.find(r => r.mobile && String(r.mobile).trim() === mob && r.id !== excludeId);
    return row || null;
  },

  async stats() {
    if (mysqlAvailable) {
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
    const all = MODE.rows.map(r => enrich(r));
    const byRelation = {};
    for (const r of all) {
      const key = r.relation == null ? 'null' : String(r.relation);
      byRelation[key] = (byRelation[key] || 0) + 1;
    }
    return {
      total: all.length,
      noMobile: all.filter(r => !(r.mobile && r.mobile.trim())).length,
      byRelation
    };
  },

  async remove(id) {
    if (mysqlAvailable) {
      const [res] = await pool.query('DELETE FROM fj_id_card WHERE id=?', [Number(id)]);
      return (res.affectedRows || 0) > 0;
    }
    const idx = MODE.rows.findIndex(r => r.id === Number(id));
    if (idx === -1) return false;
    MODE.rows.splice(idx, 1);
    persistDemo();
    return true;
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

  // 人员信息维度聚合
  async dashboard(scope = {}) {
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

    const [g, s, rp, by, bm, con, rel, ag, ags] = await Promise.all([
      pool.query(qGender), pool.query(qSurname), pool.query(qRegionProv),
      pool.query(qBirthYear), pool.query(qBirthMonth), pool.query(qConstellation), pool.query(qRelation),
      pool.query(qAge), pool.query(qAgeStage)
    ]);

    const counts = await (async () => {
      const [t] = await pool.query(`SELECT COUNT(*) AS total ${base}`);
      const [w] = await pool.query(`SELECT COUNT(*) AS total ${base} ${condClause(where, `EXISTS (SELECT 1 FROM cdsgus d WHERE d.ctfid = f.card_no)`)}`);
      const total = Number(t[0]?.total || 0);
      const withRecord = Number(w[0]?.total || 0);
      return { total, withRecord, withoutRecord: total - withRecord };
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

  // 手机信息维度聚合
  async dashboardMobile(scope = {}) {
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
    let sql;
    if (level === 'province') {
      sql = `SELECT r.province AS province, LEFT(f.region_code,2) AS code, COUNT(*) AS count
        FROM fj_id_card f LEFT JOIN fj_admin_region r ON f.region_code = r.region_code
        ${andCond(where, `f.region_code IS NOT NULL`)}
        GROUP BY r.province, LEFT(f.region_code,2) HAVING count > 0 ORDER BY count DESC`;
    } else if (level === 'city') {
      const p2 = String(parent || '').slice(0, 2);
      sql = `SELECT r.province AS province, r.city AS city, LEFT(f.region_code,4) AS code, COUNT(*) AS count
        FROM fj_id_card f LEFT JOIN fj_admin_region r ON f.region_code = r.region_code
        ${andCond(where, `LEFT(f.region_code,2) = '${p2}'`)}
        GROUP BY r.province, r.city, LEFT(f.region_code,4) HAVING count > 0 ORDER BY count DESC`;
    } else { // district，parent 为 4 位市码
      const c4 = String(parent || '').slice(0, 4);
      sql = `SELECT r.province AS province, r.city AS city, r.district AS district, f.region_code AS code, COUNT(*) AS count
        FROM fj_id_card f LEFT JOIN fj_admin_region r ON f.region_code = r.region_code
        ${andCond(where, `LEFT(f.region_code,4) = '${c4}'`)}
        GROUP BY r.province, r.city, r.district, f.region_code HAVING count > 0 ORDER BY count DESC`;
    }
    const [rows] = await pool.query(sql);
    return rows;
  },

  // 人员明细（供弹窗展示），分页；district 层支持完整6位区码或4位市码
  // filters 用于支持看板图表点击下钻：gender/surname/birthYear/birthMonth/constellation/age/ageStage/relation/mobileProvince/carrier/hasRec/hasMob
  async dashboardPeople({ level, parent, scope = {}, page = 1, pageSize = 20, filters = {} }) {
    if (!mysqlAvailable) return null;
    const where = dashboardWhere(scope);
    const p = String(parent || '');
    let codeExpr = '1=1'; // 默认全部（全国 / 无地区过滤）
    if (p) {
      if (level === 'province') codeExpr = `LEFT(f.region_code,2) = '${p.slice(0, 2)}'`;
      else if (level === 'city') codeExpr = `LEFT(f.region_code,4) = '${p.slice(0, 4)}'`;
      else if (level === 'district') {
        // 6 位区码 → 精确匹配该区；4 位市码 → 匹配该市下所有区
        codeExpr = p.length >= 6 ? `f.region_code = '${p.slice(0, 6)}'` : `LEFT(f.region_code,4) = '${p.slice(0, 4)}'`;
      }
    }

    // 合并地区条件与图表维度过滤条件
    const filterClause = dashboardFilterClause(filters);
    const allExtra = [codeExpr, filterClause].filter(s => s && s !== '1=1').join(' AND ');
    const cond = allExtra ? andCond(where, allExtra) : where;

    const size = Math.max(1, Math.min(500, Number(pageSize) || 20));
    const current = Math.max(1, Number(page) || 1);
    const offset = (current - 1) * size;

    const [countRes] = await pool.query(`SELECT COUNT(*) AS c FROM fj_id_card f ${cond}`);
    const total = Number(countRes[0]?.c || 0);
    const [rows] = await pool.query(
      `SELECT f.id, f.name, f.card_no, f.mobile, f.relation, f.card_len, f.region_code, f.birth_date_str, f.gender_code,
              r.province AS reg_province, r.city AS reg_city, r.district AS reg_district
       FROM fj_id_card f LEFT JOIN fj_admin_region r ON f.region_code = r.region_code
       ${cond} ORDER BY LEFT(f.name,1) DESC, f.id DESC LIMIT ${size} OFFSET ${offset}`
    );
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

  // 登记年份枚举：根据 scope 过滤
  // hasRecord=yes  → 仅显示 fj_id_card 中有 cdsgus 记录的年份
  // 其他情况       → 显示 cdsgus 中全部年份
  async dashboardRegYears(scope = {}) {
    if (!mysqlAvailable) return [];
    const { hasRecord = 'all' } = scope;
    let sql;
    if (hasRecord === 'yes') {
      // 只统计 fj_id_card 中存在 cdsgus 记录的身份证对应的版本年份
      sql = `SELECT DISTINCT LEFT(d.Version,4) AS y
             FROM cdsgus d
             WHERE d.Version IS NOT NULL AND TRIM(d.Version) <> ''
             AND EXISTS (SELECT 1 FROM fj_id_card f WHERE f.card_no = d.CtFId)
             ORDER BY y DESC`;
    } else {
      sql = `SELECT DISTINCT LEFT(Version,4) AS y FROM cdsgus WHERE Version IS NOT NULL AND TRIM(Version) <> '' ORDER BY y DESC`;
    }
    const [rows] = await pool.query(sql);
    return rows.map(r => String(r.y));
  }
};

module.exports = { repo, initMysql, testConnection, getMode: () => MODE.name, setMode: m => (MODE.name = m) };