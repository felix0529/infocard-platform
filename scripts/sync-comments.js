// 从测试库同步表注释与列注释到生产库（只改元数据注释，不改动列定义/索引/数据）
// 用法：node sync-comments.js --dry-run   # 仅生成语句不执行
//       node sync-comments.js             # 生成并执行
//       node sync-comments.js --table=cdsgus --dry-run  # 只看单表
const mysql = require('mysql2/promise');

const CFG = { host: '127.0.0.1', port: 3306, user: 'trae', password: 'myTrae_2026' };
const PROD = 'infocard';
const TEST = 'infocard_test';
const dryRun = process.argv.includes('--dry-run');
const only = (process.argv.find(a => a.startsWith('--table=')) || '').split('=')[1];

(async () => {
  const conn = await mysql.createConnection(CFG);
  const esc = v => conn.escape(v);

  const [tTab] = await conn.query(
    `SELECT TABLE_NAME, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA=?`, [TEST]);
  const [tCol] = await conn.query(
    `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_COMMENT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=?`, [TEST]);
  const [pT] = await conn.query(
    `SELECT TABLE_NAME, TABLE_COMMENT FROM information_schema.TABLES
     WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE'`, [PROD]);
  const [pC] = await conn.query(
    `SELECT c.TABLE_NAME, c.COLUMN_NAME, c.COLUMN_TYPE, c.COLLATION_NAME, c.IS_NULLABLE, c.COLUMN_DEFAULT,
            c.EXTRA, c.GENERATION_EXPRESSION, c.COLUMN_COMMENT
     FROM information_schema.COLUMNS c
     JOIN information_schema.TABLES t ON t.TABLE_SCHEMA=c.TABLE_SCHEMA AND t.TABLE_NAME=c.TABLE_NAME
     WHERE c.TABLE_SCHEMA=? AND t.TABLE_TYPE='BASE TABLE'`, [PROD]);

  const testTabMap = new Map(tTab.map(r => [r.TABLE_NAME, r.TABLE_COMMENT]));
  const testColMap = new Map(tCol.map(r => [r.TABLE_NAME + '.' + r.COLUMN_NAME, r.COLUMN_COMMENT]));

  function buildColumnDef(c) {
    let d = '`' + c.COLUMN_NAME + '` ' + c.COLUMN_TYPE;
    if (c.COLLATION_NAME) d += ' COLLATE ' + c.COLLATION_NAME;
    if (c.EXTRA && c.EXTRA.includes('GENERATED')) { // 生成列
      // information_schema 输出会对 ' 和 \ 转义，需还原后再嵌入 SQL
      const expr = String(c.GENERATION_EXPRESSION).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
      d += ' GENERATED ALWAYS AS (' + expr + ') STORED';
      if (c.IS_NULLABLE === 'NO') d += ' NOT NULL';
      return d;
    }
    d += c.IS_NULLABLE === 'NO' ? ' NOT NULL' : ' NULL';
    if (c.COLUMN_DEFAULT !== null) {
      const dv = String(c.COLUMN_DEFAULT);
      if (c.EXTRA && c.EXTRA.includes('DEFAULT_GENERATED')) {
        d += ' DEFAULT ' + dv; // 表达式默认值
      } else if (/^CURRENT_TIMESTAMP(\(\d+\))?$/i.test(dv)) {
        d += ' DEFAULT ' + dv;
      } else {
        d += ' DEFAULT ' + esc(dv);
      }
    }
    if (c.EXTRA && c.EXTRA.includes('auto_increment')) d += ' AUTO_INCREMENT';
    const om = c.EXTRA && c.EXTRA.match(/on update (CURRENT_TIMESTAMP(\(\d+\))?)/i);
    if (om) d += ' ON UPDATE ' + om[1];
    return d;
  }

  const sqls = [];
  // 表注释
  for (const r of pT) {
    if (only && r.TABLE_NAME !== only) continue;
    const tgt = testTabMap.get(r.TABLE_NAME);
    if (tgt === undefined) continue;
    if ((r.TABLE_COMMENT || '') !== (tgt || '')) {
      sqls.push(`ALTER TABLE \`${PROD}\`.\`${r.TABLE_NAME}\` COMMENT = ${esc(tgt || '')};`);
    }
  }
  // 列注释
  for (const c of pC) {
    if (only && c.TABLE_NAME !== only) continue;
    const key = c.TABLE_NAME + '.' + c.COLUMN_NAME;
    const tgt = testColMap.get(key);
    if (tgt === undefined) continue;
    if ((c.COLUMN_COMMENT || '') === (tgt || '')) continue;
    const def = buildColumnDef(c);
    sqls.push(`ALTER TABLE \`${PROD}\`.\`${c.TABLE_NAME}\` MODIFY COLUMN ${def} COMMENT ${esc(tgt || '')};`);
  }

  console.log('待执行语句数:', sqls.length);
  sqls.forEach(s => console.log(s));
  console.log('---');

  if (!dryRun && sqls.length) {
    let ok = 0, fail = 0;
    for (const s of sqls) {
      try {
        await conn.query(s);
        ok++;
        console.log('OK  ', s.replace(/\s+/g, ' ').slice(0, 120));
      } catch (e) {
        fail++;
        console.error('FAIL', s);
        console.error('     ', e.message);
      }
    }
    console.log(`完成: 成功 ${ok}, 失败 ${fail}`);
  } else {
    console.log(dryRun ? '[dry-run] 未执行任何变更' : '[无变更]');
  }
  await conn.end();
})().catch(e => { console.error(e); process.exit(1); });
