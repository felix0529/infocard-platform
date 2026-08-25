/**
 * 身份证号解析工具
 * 从 15/18 位身份证号推导：行政区划、出生日期、性别、长度
 */
const REGION_MAP = {
  '11': '北京市', '1101': '东城区', '1102': '西城区', '110105': '朝阳区', '110108': '海淀区',
  '12': '天津市', '13': '河北省', '14': '山西省', '15': '内蒙古自治区',
  '21': '辽宁省', '22': '吉林省', '23': '黑龙江省',
  '31': '上海市', '32': '江苏省', '33': '浙江省', '34': '安徽省',
  '35': '福建省', '36': '江西省', '37': '山东省',
  '41': '河南省', '42': '湖北省', '43': '湖南省', '44': '广东省', '45': '广西壮族自治区',
  '46': '海南省', '50': '重庆市', '51': '四川省', '52': '贵州省', '53': '云南省',
  '54': '西藏自治区', '61': '陕西省', '62': '甘肃省', '63': '青海省', '64': '宁夏回族自治区',
  '65': '新疆维吾尔自治区', '71': '台湾省', '81': '香港特别行政区', '82': '澳门特别行政区'
};

function regionName(code) {
  if (!code) return '—';
  const p2 = code.slice(0, 2);
  if (REGION_MAP[code]) return REGION_MAP[code];
  if (REGION_MAP[p2]) return REGION_MAP[p2];
  return '未知地区';
}

/**
 * 解析身份证号
 * @param {string} cardNo
 * @returns {null | {cardNo, cardLen, regionCode, regionName, birthDateStr, genderCode, genderName, birth, valid}}
 */
function parseIdCard(raw) {
  const cardNo = String(raw || '').trim();
  if (!cardNo) return null;

  let num = cardNo.toUpperCase().replace(/\s/g, '');
  let birth, genderCode;

  if (/^\d{17}[\dX]$/.test(num)) {
    // 18 位
    birth = `${num.slice(6, 10)}-${num.slice(10, 12)}-${num.slice(12, 14)}`;
    genderCode = parseInt(num[16], 10) % 2; // 1男 0女
    return {
      cardNo,
      cardLen: 18,
      regionCode: num.slice(0, 6),
      regionName: regionName(num.slice(0, 6)),
      birthDateStr: num.slice(6, 14),
      birth,
      genderCode,
      genderName: genderCode === 1 ? '男' : '女'
    };
  }

  if (/^\d{15}$/.test(num)) {
    // 15 位
    birth = `19${num.slice(6, 8)}-${num.slice(8, 10)}-${num.slice(10, 12)}`;
    genderCode = parseInt(num[14], 10) % 2;
    return {
      cardNo,
      cardLen: 15,
      regionCode: num.slice(0, 6),
      regionName: regionName(num.slice(0, 6)),
      birthDateStr: `19${num.slice(6, 8)}${num.slice(8, 10)}${num.slice(10, 12)}`,
      birth,
      genderCode,
      genderName: genderCode === 1 ? '男' : '女'
    };
  }

  return { cardNo, cardLen: 0, regionCode: '', regionName: '—', birthDateStr: '', birth: '—', genderCode: null, genderName: '—', invalid: true };
}

const RELATIONS = [
  { value: 0, label: '亲属' },
  { value: 1, label: '朋友' },
  { value: 2, label: '同事(瑞联)' },
  { value: 3, label: '同事(优品)' },
  { value: 4, label: '同事(大自然)' },
  { value: 5, label: '同事(财税)' },
  { value: null, label: '其他' }
];

function relationLabel(v) {
  const found = RELATIONS.find(r => r.value === v);
  return found ? found.label : '其他';
}

module.exports = { parseIdCard, regionName, RELATIONS, relationLabel };