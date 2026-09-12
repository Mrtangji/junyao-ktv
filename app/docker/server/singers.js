// ============ 歌手名字段处理（口径与 lx-music-desktop 的 common.ts 一致） ============
// 各平台的 singer 字段都是"多位歌手用分隔符拼接"的字符串：
//   · LX/酷我/网易云/QQ/酷狗 一律用「、」拼接（见 boardsdk 的 formatSingerName）
//   · 少数来源用「/」「;」「；」「|」
// **故意不把「&」和「,」当分隔符**——否则会把 Simon & Garfunkel、
// Tyler, The Creator 这类"单个乐队/艺人名"切错，进而把目录建歪。
'use strict';

const SINGER_SPLIT_RE = /[、;；|/]/;

/** 「周杰伦、费玉清」→ ['周杰伦','费玉清']；单一歌手 → [歌手]；空值 → [] */
function splitSingers(singer) {
  const str = String(singer == null ? '' : singer).trim();
  if (!str) return [];
  return str.split(SINGER_SPLIT_RE).map(s => s.trim()).filter(Boolean);
}

/**
 * 取第一位歌手，用于「按歌手分文件夹」的目录名。
 * 「周杰伦、费玉清」→「周杰伦」；「A/B」→「A」；单一歌手原样返回；空值 → ''
 * 合作曲统一落到第一位歌手的目录，避免建出「周杰伦、费玉清」这种拼出来的目录。
 */
function firstSinger(singer) { return splitSingers(singer)[0] || ''; }

/** 歌手人数（合唱人数）。用于「合唱人数限制」：超过上限的歌视为大合唱，批量下载时跳过 */
function singerCount(singer) { return splitSingers(singer).length; }

module.exports = { splitSingers, firstSinger, singerCount, SINGER_SPLIT_RE };
