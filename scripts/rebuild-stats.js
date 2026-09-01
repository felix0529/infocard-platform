#!/usr/bin/env node
/**
 * 看板预聚合统计重建脚本
 *
 * 逐块扫描 fj_id_card（并关联 cdsgus 取登记年份），生成看板统计表 fj_id_card_stats。
 * 统计表将看板落地页的 9+ 个全表 GROUP BY 聚合变为"一次扫描 + 预写统计"，从而避免
 * 超大表（千万级）实时聚合导致的临时表空间耗尽（ER_RECORD_FILE_FULL）与超时。
 *
 * 覆盖维度（与 server/db.js 中 dashboard/dashboardMobile 的 SQL 语义保持一一对应）：
 *   gender / surname / region2 / birthyear / birthmonth / constellation /
 *   relation / age / agestage / mprov / mcarrier / c(计数) / m(手机计数) / regyear
 *
 * 每个维度按「筛选范围」拆分存储（dim 后缀）：
 *   @all    全部人员
 *   @rec1   有 cdsgus 登记记录的人员
 *   @rec0   无登记记录的人员
 *   @yrXXXX 在 XXXX 年存在登记记录的人员
 *
 * 用法：
 *   node scripts/rebuild-stats.js            # 测试库（.env）
 *   node scripts/rebuild-stats.js --prod     # 生产库（.env + .env.prod）
 * 可选环境变量：
 *   STATS_CHUNK=200000  每块扫描行数（默认 200000）
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

// ---------- 与 server/db.js 一致的 .env 加载 ----------
const realKeys = new Set(Object.keys(process.env));
const isProd = process.env.PROFILE ? String(process.env.PROFILE).toLowerCase() === 'prod' : process.argv.includes('--prod');
for (const name of ['.env', isProd ? '.env.prod' : null].filter(Boolean)) {
  const envPath = path.join(__dirname, '..', name);
  try {
    const txt = fs.readFileSync(envPath, 'utf-8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*(DB_\w+|ENV_LABEL)\s*=\s*(.*)\s*$/);
      if (m && !realKeys.has(m[1])) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}
const DB = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'trae',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || (isProd ? 'infocard' : 'infocard_test')
};
if (!DB.password) {
  console.error('[rebuild-stats] 未配置数据库密码：请在项目根目录 .env' + (isProd ? ' / .env.prod' : '') + ' 中设置 DB_PASSWORD');
  process.exit(1);
}

const CHUNK = Math.max(1000, Number(process.env.STATS_CHUNK || 200000));
// cdsgus 批量 IN 查询的卡号批次：CtfId 索引 key_len=1023B，IN 列表过大（超出 range_optimizer_max_mem_size=8MB）
// 时优化器会退化为全表扫描（实测 IN(10000)=19.6s，IN(4000)=1.0s）。上限取 5000，默认 4000 留余量
const BATCH = Math.min(5000, Number(process.env.STATS_BATCH || 4000));
// cdsgus 批次查询并发数：受 pool.connectionLimit 上限约束，纯 SELECT 无临时表竞争，可安全并行
const PARALLEL = Math.min(4, Number(process.env.STATS_PARALLEL || 4));

// 受限并发执行器：固定 limit 路 worker 顺序取任务，保持与串行完全等价的结果顺序
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }));
  return results;
}
const NULL_SENT = '__null__';    // 与 server/db.js 中的 NULL_KEY 保持一致
// 影子表原子切换：STATS_SWAP=1 时写入 fj_id_card_stats_new，完成后 RENAME 原子切换为主表，
// 全程主统计表保持可用，避免重建期间看板回退到慢速实时聚合
const SWAP = process.env.STATS_SWAP === '1';
const REAL_TBL = 'fj_id_card_stats';
const TBL = SWAP ? REAL_TBL + '_new' : REAL_TBL;

// ---------- 行级派生（与 SQL 语义完全一致） ----------
// TIMESTAMPDIFF(YEAR, STR_TO_DATE(ymd,'%Y%m%d'), CURDATE()) 的 JS 等价实现
function ageOf(ymd, now) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(ymd || ''));
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null; // 非法日期 STR_TO_DATE 返回 NULL
  let age = now.getFullYear() - y;
  if (now.getMonth() + 1 < mo || (now.getMonth() + 1 === mo && now.getDate() < d)) age--;
  return age;
}
function ageStageOf(age) {
  if (age == null) return null;
  if (age <= 6) return '幼儿（0-6岁）';
  if (age <= 12) return '少儿（7-12岁）';
  if (age <= 17) return '少年（13-17岁）';
  if (age <= 35) return '青年（18-35岁）';
  if (age <= 50) return '中年（36-50岁）';
  if (age <= 65) return '老年（51-65岁）';
  return '高龄（65岁以上）';
}
function constellationOf(mmd, consts) {
  if (mmd == null) return null;
  const mmdNum = Number(mmd);
  for (const c of consts) {
    const s = Number(c.start_mmdd), e = Number(c.end_mmdd);
    if ((s <= e && mmdNum >= s && mmdNum <= e) || (s > e && (mmdNum >= s || mmdNum <= e))) return c.name;
  }
  return null;
}

async function main() {
  const t0 = Date.now();
  const pool = mysql.createPool({
    host: DB.host, port: DB.port, user: DB.user, password: DB.password, database: DB.database,
    waitForConnections: true, connectionLimit: 4
  });
  console.log(`[rebuild-stats] 目标数据库：${DB.database}（${isProd ? '生产' : '测试'}） 块大小：${CHUNK}`);

  // 小表预载：星座区间、手机号段
  const [consts] = await pool.query('SELECT name, start_mmdd, end_mmdd FROM fj_constellation WHERE start_mmdd IS NOT NULL');
  const [segs] = await pool.query('SELECT segment, province, carrier FROM fj_mobile_segment');
  const segMap = {};
  for (const s of segs) segMap[String(s.segment)] = s;
  console.log(`[rebuild-stats] 星座规则 ${consts.length} 条，号段 ${segs.length} 条`);

  // 行级字段换算
  const bin = (dim, scope, bucket) => {
    const k = dim + '@' + scope + '|' + String(bucket == null ? NULL_SENT : bucket);
    acc.set(k, (acc.get(k) || 0) + 1);
  };

  const acc = new Map();       // dim@scope|bucket -> cnt

  let lastId = 0, rowsDone = 0;
  for (;;) {
    const [rows] = await pool.query(
      `SELECT id, card_no, gender_code, name, region_code, birth_date_str, birth_mmdd, relation, mobile
       FROM fj_id_card WHERE id > ? ORDER BY id LIMIT ?`, [lastId, CHUNK]);
    if (!rows.length) break;
    lastId = rows[rows.length - 1].id;
    rowsDone += rows.length;

    // 分批查询本块卡号在 cdsgus 的登记信息（并行批次，串行结果等价）
    // 口径说明：hasRecord（rec1/rec0）以「是否存在任意 cdsgus 记录」为准，
    //           与列表/明细下钻的 EXISTS 口径一致；years 仅由 Version 非空的记录决定（供 yrXXXX 年份分布）。
    const cardInfo = new Map();   // cid -> { has:boolean, years:Set }
    const batches = [];
    for (let i = 0; i < rows.length; i += BATCH) {
      batches.push(rows.slice(i, i + BATCH).map(r => String(r.card_no)).filter(Boolean));
    }
    const batchMaps = await mapLimit(batches, PARALLEL, async (chunk) => {
      if (!chunk.length) return null;
      const ph = chunk.map(() => '?').join(',');
      const [recs] = await pool.query(
        `SELECT CtfId AS cid, Version FROM cdsgus WHERE CtfId IN (${ph})`, chunk);
      const m = new Map();
      for (const rec of recs) {
        const cid = String(rec.cid);
        if (!m.has(cid)) m.set(cid, { has: true, years: new Set() });
        const v = rec.Version;
        if (v != null && String(v).trim() !== '') m.get(cid).years.add(String(v).slice(0, 4));
      }
      return m;
    });
    for (const m of batchMaps) {
      if (!m) continue;
      for (const [cid, info] of m) {
        if (!cardInfo.has(cid)) cardInfo.set(cid, { has: false, years: new Set() });
        const cur = cardInfo.get(cid);
        if (info.has) cur.has = true;
        info.years.forEach(y => cur.years.add(y));
      }
    }

    const now = new Date();
    for (const r of rows) {
      const info = cardInfo.get(String(r.card_no)) || { has: false, years: new Set() };
      const hasRecord = info.has;            // 任意 cdsgus 记录即记为已记录（与列表口径一致）
      const yrs = [...info.years];
      const scopes = ['all'];
      if (hasRecord) { scopes.push('rec1'); for (const y of yrs) scopes.push('yr' + y); }
      else scopes.push('rec0');

      const gender = r.gender_code == null ? null : Number(r.gender_code);
      const nm = r.name ? String(r.name) : '';
      const surname = nm ? nm.slice(0, 1) : '';
      const bds = r.birth_date_str == null ? null : String(r.birth_date_str);
      const hasBd = bds != null && bds !== '';
      const region2 = r.region_code == null ? null : String(r.region_code).slice(0, 2);
      const birthYear = bds == null ? null : bds.slice(0, 4);
      const birthMonth = bds == null ? null : bds.slice(4, 6); // 空串 '' 也计入（与 SQL IS NOT NULL 一致）
      const age = hasBd ? ageOf(bds, now) : null;
      const stage = hasBd ? ageStageOf(age) : null;
      const con = r.birth_mmdd == null ? null : constellationOf(Number(r.birth_mmdd), consts);
      const rel = r.relation == null ? null : Number(r.relation);
      const hasMob = !!(r.mobile != null && String(r.mobile).trim() !== '');
      const seg = hasMob ? segMap[String(r.mobile).trim().slice(0, 7)] : null;
      const mprov = !hasMob ? null : (seg && seg.province) ? String(seg.province) : '未知';
      const mcar = !hasMob ? null : (seg && seg.carrier) ? String(seg.carrier) : '未知';

      for (const s of scopes) {
        bin('c', s, 'total');
        if (yrs.length) bin('c', s, 'hasrec'); else bin('c', s, 'norec');
        // 登记年份按"每人每年"计数（s 形如 yrXXXX），供年份分布展示使用
        if (s.charAt(0) === 'y' && s.charAt(1) === 'r') bin('regyear', 'yes', s.slice(2));
        bin('gender', s, gender);
        if (nm) bin('surname', s, surname);
        if (region2 != null) bin('region2', s, region2);
        if (birthYear != null) bin('birthyear', s, birthYear);
        if (bds != null) bin('birthmonth', s, birthMonth);
        bin('constellation', s, con);
        bin('relation', s, rel);
        if (hasBd) { bin('age', s, age); bin('agestage', s, stage); }
        bin('m', s, 'total');
        if (hasMob) { bin('m', s, 'withmob'); bin('mprov', s, mprov); bin('mcarrier', s, mcar); }
        else bin('m', s, 'nomob');
      }
    }
    console.log(`[rebuild-stats] 已处理 ${rowsDone} 行...`);
  }
  console.log(`[rebuild-stats] 扫描完成：${rowsDone} 行，计数键 ${acc.size} 个`);

  // 透写统计表：影子表模式先建新表写数据（主表全程可读），普通模式直接 TRUNCATE 重建
  // 注意 COLLATE 必须为 utf8mb4_bin：默认 _0900_ai_ci 大小写不敏感，姓首字母 'L'/'l' 等会撞主键（Duplicate entry）
  const DDL = `CREATE TABLE IF NOT EXISTS \`${TBL}\` (
    dim varchar(24) NOT NULL COMMENT '维度键',
    bucket varchar(64) NOT NULL COMMENT '维度取值',
    cnt bigint NOT NULL DEFAULT 0 COMMENT '计数',
    updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (dim, bucket)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin COMMENT='看板预聚合统计表（分块重建脚本维护）'`;
  if (SWAP) await pool.query(`DROP TABLE IF EXISTS \`${TBL}\``);
  await pool.query(DDL);
  if (!SWAP) await pool.query(`TRUNCATE TABLE \`${TBL}\``);
  let inserted = 0;
  const values = [];
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const [k, cnt] of acc) {
      const sep = k.indexOf('|');
      values.push([k.slice(0, sep), k.slice(sep + 1), cnt]);
      if (values.length >= 5000) {
        await conn.query(`INSERT INTO \`${TBL}\` (dim, bucket, cnt) VALUES ?`, [values]);
        inserted += values.length;
        values.length = 0;
      }
    }
    if (values.length) {
      await conn.query(`INSERT INTO \`${TBL}\` (dim, bucket, cnt) VALUES ?`, [values]);
      inserted += values.length;
    }
    await conn.commit();
    // 影子表模式：原子切换为主表并删除备份
    if (SWAP) {
      await conn.query(`RENAME TABLE \`${REAL_TBL}\` TO \`${REAL_TBL}_bak\`, \`${TBL}\` TO \`${REAL_TBL}\``);
      await conn.query(`DROP TABLE IF EXISTS \`${REAL_TBL}_bak\``);
      console.log('[rebuild-stats] 统计表已原子切换（shadow swap）');
    }
    console.log(`[rebuild-stats] 写入完成：${inserted} 行，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  await pool.end();
}

main().catch((e) => {
  console.error('[rebuild-stats] 失败：', e.message);
  process.exit(1);
});