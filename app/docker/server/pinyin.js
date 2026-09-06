// 服务端拼音工具：扫描曲库时为每首歌预计算「全拼」与「拼音首字母」，
// 让点歌面板的字母键盘(以及搜索框输入拼音)走服务端索引查询，
// 避免把整库 4 万首一次性拉到前端再过滤。
//
// 为什么不直接用前端的 getPY/localeCompare('zh-CN')：
//   前端依赖 JS 引擎的 ICU 中文排序来判断拼音首字母，而服务端 Docker 精简
//   镜像常常不带 full-ICU，localeCompare('zh-CN') 会退化成按 Unicode 码点比较，
//   结果整片错误。所以这里用 pinyin-pro——纯 JS 词典、不依赖 ICU，准确且可移植。
//
// 降级策略：若 pinyin-pro 未安装，toPinyin/toPinyinInitial 返回空串，拼音列留空。
//   此时中文歌名/歌手搜索照常工作，仅「拼音首字母搜索」暂不可用，并在启动时报明确告警。

let pinyinFn = null;
try {
  const mod = require('pinyin-pro');
  pinyinFn = mod && mod.pinyin;
  if (typeof pinyinFn !== 'function') pinyinFn = null;
} catch (e) {
  console.warn('[pinyin] 未找到 pinyin-pro，拼音首字母搜索将不可用，请执行 npm install pinyin-pro');
}

// 只保留 a-z0-9，去掉空格/标点/连字符，统一小写，方便做前缀匹配。
// 例：'zhoujielun - qingtian' -> 'zhoujielunqingtian'，'zjl - qt' -> 'zjlqt'
function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function toPinyin(str) {
  if (!pinyinFn) return '';
  try {
    return normalize(pinyinFn(str, { toneType: 'none', type: 'array' }).join(''));
  } catch (e) {
    return '';
  }
}

function toPinyinInitial(str) {
  if (!pinyinFn) return '';
  try {
    return normalize(pinyinFn(str, { pattern: 'first', toneType: 'none', type: 'array' }).join(''));
  } catch (e) {
    return '';
  }
}

module.exports = { toPinyin, toPinyinInitial, pinyinReady: !!pinyinFn };
