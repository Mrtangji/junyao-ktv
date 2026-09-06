// 歌曲语言识别：把每首歌归到 中文 / 粤语 / 英语 / 韩语 / 日语 五类之一，
// 供「歌星」「点歌」「搜索」面板按语言筛选。
//
// 判定规则（按顺序短路）：
//   1. 标题或歌手含谚文(Hangul, U+AC00–U+D7A3)          -> 韩语
//   2. 标题或歌手含假名(Hiragana/Katakana, U+3040–U+30FF)-> 日语
//   3. 歌手在「已知日本歌手」名单里                       -> 日语
//      （补 #2 覆盖不到的纯汉字/纯拉丁日本歌手，如 米津玄師、LiSA）
//   4. 标题无中日韩文字（纯拉丁/数字/符号）：
//        - 歌手在粤语名单 -> 粤语；歌手含汉字 -> 中文；否则 -> 英语
//      （英文歌名不等于英文歌，所以这里要看歌手，不能直接判英语）
//   5. 标题含汉字：歌手在粤语名单 -> 粤语；否则 -> 中文
//
// 注意：粤语与中文同为汉字，单看文字无法区分，只能靠歌手名单近似；
// 同理，纯汉字/纯拉丁的日本歌手也只能靠名单。两份名单见下方
// CANTONESE_ARTISTS / JAPANESE_ARTISTS，可按实际曲库自行扩充
// （这是最可行的近似：不做音频分析就无法逐首判断歌曲语种）。
//
// 关键实现细节：下面三个判定函数用「码点数字区间比较」(0xAC00 等十六进制常量)
// 而不是正则字符区间 [\uAC00-\uD7A3]，彻底规避 JSON 参数把 \uXXXX 解释成真实
// 字符、进而把区间算错的坑（曾因此把所有汉字误判成韩语）。
const CANTONESE_ARTISTS = new Set([
  '张学友', '刘德华', '陈奕迅', '杨千嬅', '容祖儿', '谢霆锋', 'Twins', '谭咏麟',
  '张国荣', '梅艳芳', '许冠杰', 'Beyond', '黄家驹', '陈慧娴', '关淑怡', '黎瑞恩',
  '彭羚', '郑秀文', '古巨基', '李克勤', '林峰', '吴雨霏', '薛凯琪', '方大同',
  '侧田', '卫兰', '卫诗', '泳儿', '钟欣潼', '蔡卓妍', '谢安琪', '邓紫棋',
  '张敬轩', '林子祥', '叶蒨文', '叶德娴', '陈慧琳', '郑伊健', '梁汉文', '苏永康',
  '许志安', '郑中基', '关心妍', '王菀之', '张继聪', '胡杏儿', '少女标本', '糖妹',
  '王祖蓝', '李蕙敏', '何韵诗', 'at17', 'RubberBand', '农夫', '蓝奕邦', '黄耀明',
  '达明一派', '草蜢', '温拿', '汪明荃', '叶丽仪', '雷安娜', '陈百强', '邝美云',
  '周慧敏', '黎明的', '梁咏琪', '杨采妮', '汤宝如', '周俊伟', 'Shine', 'EO2',
]);

// 日本歌手名单：主要收录「名字里没有假名」的常见日本歌手——含假名的（如
// 宇多田ヒカル）已由规则 #2 命中，无需重复登记。
const JAPANESE_ARTISTS = new Set([
  '米津玄師', '椎名林檎', '中島美嘉', '絢香', '平原綾香', '玉置浩二', '中森明菜',
  '山口百恵', '松田聖子', '近藤真彦', '安全地帯', '松任谷由実', '小田和正',
  '谷村新司', '五輪真弓', '久石譲', '坂本龍一', '喜多郎', '森山直太朗', '斉藤和義',
  '山口智子', '德永英明', '徳永英明', '河合奈保子', '柏原芳恵', '岩崎宏美',
  'LiSA', 'Aimer', 'YUI', 'aiko', 'Ado', 'YOASOBI', 'RADWIMPS', 'ONE OK ROCK',
  'King Gnu', 'Official髭男dism', 'Mrs. GREEN APPLE', 'back number',
  'Kenshi Yonezu', 'Hikaru Utada', 'Ayumi Hamasaki', 'Namie Amuro',
]);

// 名单匹配：去首尾空格 + 忽略大小写（中文不受影响，拉丁艺名如 LiSA/Twins
// 才能稳定命中）。
function inSet(set, name) {
  if (!name) return false;
  return set.has(String(name).trim()) || set.has(String(name).trim().toLowerCase());
}

function hasHangul(s) {
  for (const ch of s) { const c = ch.codePointAt(0); if (c >= 0xAC00 && c <= 0xD7A3) return true; }
  return false;
}
function hasKana(s) {
  for (const ch of s) { const c = ch.codePointAt(0); if (c >= 0x3040 && c <= 0x30FF) return true; }
  return false;
}
function hasCJK(s) {
  for (const ch of s) { const c = ch.codePointAt(0); if (c >= 0x4E00 && c <= 0x9FFF) return true; }
  return false;
}

function detectLang(title, artist) {
  const t = String(title || '');
  const a = String(artist || '');
  // 1) 谚文 -> 韩语
  if (hasHangul(t) || hasHangul(a)) return '韩语';
  // 2) 假名 -> 日语（歌手名含假名也算，覆盖「英文歌名 + 日文歌手」的情况）
  if (hasKana(t) || hasKana(a)) return '日语';
  // 3) 已知日本歌手（纯汉字/纯拉丁名字，靠名单补）
  if (inSet(JAPANESE_ARTISTS, a)) return '日语';
  // 4) 标题无中日韩文字：英文歌名不等于英文歌，先看歌手再决定
  if (!hasCJK(t)) {
    if (inSet(CANTONESE_ARTISTS, a)) return '粤语';
    if (hasCJK(a)) return '中文';
    return '英语';
  }
  // 5) 标题含汉字：粤语歌手 -> 粤语，否则中文
  if (inSet(CANTONESE_ARTISTS, a)) return '粤语';
  return '中文';
}

module.exports = { detectLang, CANTONESE_ARTISTS, JAPANESE_ARTISTS };
