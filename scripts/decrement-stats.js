#!/usr/bin/env node
/**
 * 统计表增量减量脚本
 *
 * 对已删除的测试数据，按 buildStatsKeys 口径计算其全部统计键，
 * 对 fj_id_card_stats 做 cnt - 1 操作（与 statsAdjust(delta=-1) 完全等价）。
 *
 * 用法：
 *   node scripts/decrement-stats.js            # 测试库
 *   node scripts/decrement-stats.js --prod     # 生产库
 *   node scripts/decrement-stats.js --prod --dry  # 只打印不执行
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

// ---------- env 加载（与 rebuild-stats.js 一致）----------
const realKeys = new Set(Object.keys(process.env));
const isProd = process.env.PROFILE ? String(process.env.PROFILE).toLowerCase() === 'prod' : process.argv.includes('--prod');
const dryRun = process.argv.includes('--dry');
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
  console.error('[decrement-stats] 未配置数据库密码：请在项目根目录 .env' + (isProd ? ' / .env.prod' : '') + ' 中设置 DB_PASSWORD');
  process.exit(1);
}

// ---------- 104 条已删除测试数据 [name, card_no, mobile] ----------
const RECORDS = [
  // 100 条（姓名含 测试/test）
  ['测试', '100105198704301651', '13000088888'],
  ['测试', '101110197909090099', '13199999999'],
  ['测试', '110101198506020046', '13588966989'],
  ['test', '110101198701011111', '13691581234'],
  ['测试预订', '110105198301130147', null],
  ['测试预订', '110107197402111111', null],
  ['测试预订', '110107197402190012', null],
  ['测试预定', '110107197402190035', null],
  ['测试用户', '110107197402191111', null],
  ['测试', '110110199909090000', null],
  ['测试', '110114198803291352', '13152776581'],
  ['测试', '111111111111111', '13333888888'],
  ['测试', '120101196512021152', '15611930228'],
  ['testpayment', '120101197709240413', '13324567899'],
  ['系统测试', '120102198601055314', null],
  ['孙民举(公安上传测试)', '120111197512064571', null],
  ['测试', '120222198510097010', null],
  ['Test', '123456198001011001', '12345671001'],
  ['Test4103', '123456198001014103', '12345674103'],
  ['Test5004', '123456198001015004', '12345675004'],
  ['Test5006', '123456198001015006', '12345675006'],
  ['Test5007', '123456198001015007', '12345675007'],
  ['Test5011', '123456198001015011', '12345675011'],
  ['Test5012', '123456198001015012', '12345675012'],
  ['Test5013', '123456198001015013', '12345675013'],
  ['Test5014', '123456198001015014', '12345675014'],
  ['Test', '130102198001012001', '12345672001'],
  ['测试', '140101198502131524', '18612345689'],
  ['跟单测试', '14030419810214112x', '15300111122'],
  ['测试1', '142726198903112112', '123456'],
  ['测试', '210211197507127897', '13312456785'],
  ['测试早餐', '210703198704293220', null],
  ['测试', '210832198001010335', '15102409955'],
  ['测试3', '211302197707171612', '13512133649'],
  ['测试1', '211302197707171613', '13512133640'],
  ['onlyfortest', '220103198706130234', '18811110000'],
  ['测试', '220204198302160912', '15901594390'],
  ['测试', '220303198305063022', '13585858585'],
  ['test', '230106197812090814', '18601295602'],
  ['test', '230107198402132315', '13263225563'],
  ['test', '310100198506020274', null],
  ['test', '310100198506020813', null],
  ['测试', '31010119700303001X', '13809871234'],
  ['test', '310101198405061577', '13667767766'],
  ['test', '310101198811184014', '13391061814'],
  ['TEST33', '310102197707292842', '13386076181'],
  ['测试2', '31010519850708501X', '13524189552'],
  ['test', '310105198801013219', '13445678901'],
  ['测试', '310105198801033219', '13482069234'],
  ['test', '310105198801043215', '13482069356'],
  ['测试', '310106197807202011', '13701645060'],
  ['测试', '310107196103030547', null],
  ['测试人员', '310107198207071333', '13900139000'],
  ['测试用户', '310107198207111337', '15800158000'],
  ['test', '310108198306061332', '13801699023'],
  ['测试订单', '310108198306071223', '18601860123'],
  ['测试订单', '310109198305061334', '13701370137'],
  ['测试单', '310109198312121110', '13013111111'],
  ['测试单', '310109198312121111', '13817014338'],
  ['test', '310109198703131111', '13619912540'],
  ['袁婕测试', '310109199007112061', '13564838831'],
  ['测试', '310110101020205', '13774473039'],
  ['dwtest00', '310110198705281500', '12312312300'],
  ['dwtest02', '310110198705281516', '12312312314'],
  ['dwtest01', '310110198705281517', '13701859533'],
  ['dwtest03', '310110198705281518', '12312312333'],
  ['dwtest99', '310110198705281599', '12312312399'],
  ['测试111', '310110198805041121', '13701665622'],
  ['test', '310111199003031111', '13456789021'],
  ['测试', '310115198809283840', '13445685231'],
  ['test', '310228198811084014', '13391022222'],
  ['test10', '310229198801114014', '13478945612'],
  ['test0727', '310230198312111121', '13818662356'],
  ['test0810', '310230198312151031', '13521451262'],
  ['jjinntest', '311111200806041111', '13222223589'],
  ['testbest', '320104198604100420', '13986054231'],
  ['测试', '320207198306252421', '13816424123'],
  ['测试', '320207198306252422', '13816424120'],
  ['测试1', '320303198207012341', null],
  ['test1101', '320323198703191234', '15821460299'],
  ['test009', '320323198703281621', '15821957044'],
  ['test1100', '32032319870330126X', '15026511007'],
  ['test_xu', '320323199003281261', '15821457071'],
  ['test', '320324198211023558', '13611598848'],
  ['test', '320456198503150012', '13762654632'],
  ['锦江测试1', '320502197711222029', '10101666'],
  ['test11', '320586198607205620', '13951899222'],
  ['测试', '320683199012146555', null],
  ['test111', '320923199008060336', '155555000'],
  ['测试', '320924198501046205', '15921637699'],
  ['测试', '320924198705064789', '13985647485'],
  ['test', '324223198711111234', '13922221121'],
  ['测试号', '325456197512230210', '13566655456'],
  ['test22', '330102197708222418', '13919809875'],
  ['test23', '330123198804210039', '13588234587'],
  ['test123test', '330203198309281232', '13456745678'],
  ['test', '333333191101011111', '13606806672'],
  ['测试一', '340209198710051382', '15810409496'],
  ['test', '340211198910108220', '15044456665'],
  ['test', '340321198710102223', '15000112125'],
  // 4 条（身份证号 9999 开头）
  ['蔣芳芳', '999900198109192192', null],
  ['蘛巳', '999911191006231251', null],
  ['马林', '999944198903231018', '15614725836'],
  ['吴双', '999992198504041211', '15923257868'],
];

// ---------- 行级派生（与 db.js / rebuild-stats.js 完全一致）----------
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

// 从 card_no 派生数据库中 STORED GENERATED 列的值
function deriveRow(name, cardNo, mobile) {
  const c = String(cardNo || '').trim();
  let region_code, birth_date_str, gender_code, birth_mmdd;
  if (c.length === 18) {
    region_code = c.slice(0, 6);
    birth_date_str = c.slice(6, 14);
    gender_code = Number(c[16]) % 2 === 1 ? 1 : 0;
    birth_mmdd = Number(c.slice(10, 14));
  } else if (c.length === 15) {
    region_code = c.slice(0, 6);
    birth_date_str = '19' + c.slice(6, 12);
    gender_code = Number(c[14]) % 2 === 1 ? 1 : 0;
    birth_mmdd = Number(c.slice(8, 12));
  } else {
    return null; // 非法长度，跳过
  }
  const mob = mobile && mobile !== '—' ? String(mobile).trim() : '';
  return {
    name, card_no: c, mobile: mob,
    region_code, birth_date_str, gender_code, birth_mmdd,
    relation: null // 已确认全部为 NULL
  };
}

// 与 db.js buildStatsKeys 完全一致的逻辑
function buildStatsKeys(row, years, consts, segMap) {
  const keys = [];
  const scopes = ['all'];
  if (years.length) { scopes.push('rec1'); for (const y of years) scopes.push('yr' + y); }
  else scopes.push('rec0');
  const NULL_KEY = '__null__';
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
  const stage = hasBd ? ageStageOf(age) : null;
  const con = row.birth_mmdd == null ? null : constellationOf(Number(row.birth_mmdd), consts);
  const rel = row.relation == null ? null : Number(row.relation);
  const mob = row.mobile != null ? String(row.mobile).trim() : '';
  const hasMob = mob !== '';
  const seg = hasMob ? segMap[mob.slice(0, 7)] : null;
  const mprov = !hasMob ? null : (seg && seg.province) ? String(seg.province) : '未知';
  const mcar = !hasMob ? null : (seg && seg.carrier) ? String(seg.carrier) : '未知';

  for (const s of scopes) {
    push('c', s, 'total');
    if (years.length) push('c', s, 'hasrec'); else push('c', s, 'norec');
    if (s.charAt(0) === 'y' && s.charAt(1) === 'r') push('regyear', 'yes', s.slice(2));
    push('gender', s, gender);
    if (nm) push('surname', s, surname);
    if (region2 != null) push('region2', s, region2);
    if (birthYear != null) push('birthyear', s, birthYear);
    if (bds != null) push('birthmonth', s, birthMonth);
    push('constellation', s, con);
    push('relation', s, rel);
    if (hasBd) { push('age', s, age); push('agestage', s, stage); }
    push('m', s, 'total');
    if (hasMob) { push('m', s, 'withmob'); push('mprov', s, mprov); push('mcarrier', s, mcar); }
    else push('m', s, 'nomob');
  }
  return keys;
}

async function main() {
  const t0 = Date.now();
  const pool = mysql.createPool({
    host: DB.host, port: DB.port, user: DB.user, password: DB.password, database: DB.database,
    waitForConnections: true, connectionLimit: 4
  });
  console.log(`[decrement-stats] 目标数据库：${DB.database}（${isProd ? '生产' : '测试'}）  记录数：${RECORDS.length}  dryRun=${dryRun}`);

  // 小表预载
  const [consts] = await pool.query('SELECT name, start_mmdd, end_mmdd FROM fj_constellation WHERE start_mmdd IS NOT NULL');
  const [segs] = await pool.query('SELECT segment, province, carrier FROM fj_mobile_segment');
  const segMap = {};
  for (const s of segs) segMap[String(s.segment)] = s;
  console.log(`[decrement-stats] 星座规则 ${consts.length} 条，号段 ${segs.length} 条`);

  // 派生行数据
  const rows = RECORDS.map(([n, c, m]) => deriveRow(n, c, m)).filter(Boolean);
  console.log(`[decrement-stats] 有效派生行：${rows.length}/${RECORDS.length}`);

  // 批量查询 cdsgus 登记年份
  const yearsByCard = new Map();
  const cardNos = rows.map(r => r.card_no).filter(Boolean);
  // 分批 IN 查询，每批 4000
  for (let i = 0; i < cardNos.length; i += 4000) {
    const chunk = cardNos.slice(i, i + 4000);
    const ph = chunk.map(() => '?').join(',');
    const [recs] = await pool.query(
      `SELECT CtfId AS cid, SUBSTRING(Version,1,4) AS y FROM cdsgus
       WHERE CtfId IN (${ph}) AND Version IS NOT NULL AND TRIM(Version) <> ''`, chunk);
    for (const rec of recs) {
      const cid = String(rec.cid);
      if (!yearsByCard.has(cid)) yearsByCard.set(cid, new Set());
      yearsByCard.get(cid).add(String(rec.y));
    }
  }
  const hasRecCount = [...yearsByCard.values()].filter(s => s.size > 0).length;
  console.log(`[decrement-stats] cdsgus 有登记记录的卡号：${hasRecCount} 条`);

  // 计算全部统计键并聚合
  const acc = new Map(); // key → count（每条记录贡献 1）
  for (const row of rows) {
    const yrs = [...(yearsByCard.get(row.card_no) || [])];
    const keys = buildStatsKeys(row, yrs, consts, segMap);
    for (const k of keys) {
      acc.set(k, (acc.get(k) || 0) + 1);
    }
  }
  console.log(`[decrement-stats] 聚合统计键：${acc.size} 个，总减量数：${[...acc.values()].reduce((a, b) => a + b, 0)}`);

  // 维度摘要
  const dimSummary = {};
  for (const [k, cnt] of acc) {
    const dim = k.split('@')[0];
    dimSummary[dim] = (dimSummary[dim] || 0) + cnt;
  }
  console.log('[decrement-stats] 维度减量摘要：');
  for (const [dim, cnt] of Object.entries(dimSummary).sort()) {
    console.log(`  ${dim}: -${cnt}`);
  }

  // 打印前 20 个键的详情
  console.log('[decrement-stats] 前 20 个统计键：');
  let i = 0;
  for (const [k, cnt] of acc) {
    if (i++ >= 20) break;
    const sep = k.indexOf('|');
    console.log(`  dim=${k.slice(0, sep)}  bucket=${k.slice(sep + 1)}  delta=-${cnt}`);
  }

  if (dryRun) {
    console.log('[decrement-stats] dryRun 模式，不执行更新。');
    await pool.end();
    return;
  }

  // 执行减量更新
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 修正前 total
    const [before] = await conn.query("SELECT cnt FROM fj_id_card_stats WHERE dim='c@all' AND bucket='total'");
    const beforeTotal = before.length ? Number(before[0].cnt) : 0;
    console.log(`[decrement-stats] 修正前 c@all|total = ${beforeTotal}`);

    let updated = 0;
    const entries = [...acc.entries()];
    for (let i = 0; i < entries.length; i += 500) {
      const slice = entries.slice(i, i + 500);
      const vals = slice.map(([k, cnt]) => {
        const sep = k.indexOf('|');
        return [k.slice(0, sep), k.slice(sep + 1), -cnt]; // 负值，用于 cnt + VALUES(cnt)
      });
      await conn.query(
        'INSERT INTO fj_id_card_stats (dim, bucket, cnt) VALUES ? ON DUPLICATE KEY UPDATE cnt = cnt + VALUES(cnt)',
        [vals]
      );
      // 删除 cnt <= 0 的键
      const pairs = slice.map(([k]) => {
        const sep = k.indexOf('|');
        return [k.slice(0, sep), k.slice(sep + 1)];
      });
      const cases = pairs.map(() => '(dim = ? AND bucket = ?)').join(' OR ');
      await conn.query(`DELETE FROM fj_id_card_stats WHERE cnt <= 0 AND (${cases})`, pairs.flat());
      updated += slice.length;
    }
    await conn.commit();

    // 修正后 total
    const [after] = await conn.query("SELECT cnt FROM fj_id_card_stats WHERE dim='c@all' AND bucket='total'");
    const afterTotal = after.length ? Number(after[0].cnt) : 0;
    console.log(`[decrement-stats] 修正后 c@all|total = ${afterTotal}  (减少 ${beforeTotal - afterTotal})`);

    // 主表实际数
    const [real] = await pool.query('SELECT COUNT(*) AS total FROM fj_id_card');
    const realTotal = Number(real[0].total);
    console.log(`[decrement-stats] 主表实际总数 = ${realTotal}`);
    console.log(`[decrement-stats] 剩余差异 = ${afterTotal - realTotal}`);

    console.log(`[decrement-stats] 完成，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    await conn.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
  await pool.end();
}

main().catch((e) => {
  console.error('[decrement-stats] 失败：', e.message);
  process.exit(1);
});
