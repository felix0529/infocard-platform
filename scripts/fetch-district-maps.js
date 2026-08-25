/**
 * 预下载有数据城市的区级地图（DataV areas_v3）到 public/maps/district/
 * 仅下载实际存在人员的城市，文件名为城市6位adcode，例如 440100.json
 * 用法：node scripts/fetch-district-maps.js
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

// 有数据省份的 2 位区划前缀 → 6 位省级 adcode
const PROV_6 = {
  '11':'110000','12':'120000','13':'130000','14':'140000','15':'150000','21':'210000','22':'220000',
  '23':'230000','31':'310000','32':'320000','33':'330000','34':'340000','35':'350000','36':'360000',
  '37':'370000','41':'410000','42':'420000','43':'430000','44':'440000','45':'450000','46':'460000',
  '50':'500000','51':'510000','52':'520000','53':'530000','61':'610000','62':'620000','63':'630000',
  '64':'640000','65':'650000'
};
const POPULATED = ['43','13','44','14','36','42','41','32','33','35','34','51','12','23','61','11','37','45','52','22','31','21','63','65','46','53','62'];

const API = 'http://127.0.0.1:5173/api/dashboard/region';
const OUT = path.join(__dirname, '..', 'public', 'maps', 'district');

function get(url) {
  return new Promise((resolve, reject) => {
    const r = fetch(url).then(r => r.json()).then(resolve).catch(reject);
  });
}
function download(u) {
  return new Promise((resolve, reject) => {
    https.get(u, res => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const cityCodes = new Set();
  for (const k2 of POPULATED) {
    const provAd = PROV_6[k2];
    const r = await get(`${API}?level=city&parent=${provAd}&hasRecord=all`);
    (r.data || []).forEach(c => { if (c.code) cityCodes.add(String(c.code).slice(0, 4)); });
  }
  console.log('有数据的城市(4位):', cityCodes.size, [...cityCodes].join(','));
  let ok = 0, miss = 0;
  for (const c4 of cityCodes) {
    const c6 = c4 + '00';
    const fp = path.join(OUT, c6 + '.json');
    if (fs.existsSync(fp)) { ok++; continue; }
    const geo = await download(`https://geo.datav.aliyun.com/areas_v3/bound/${c6}_full.json`);
    if (geo && geo.features && geo.features.length) {
      fs.writeFileSync(fp, JSON.stringify(geo));
      ok++;
    } else { miss++; console.log('  无区地图:', c4); }
    await new Promise(r => setTimeout(r, 60));
  }
  console.log(`完成：已获取 ${ok} 个城市区地图，缺失 ${miss} 个`);
})();