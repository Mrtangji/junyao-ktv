// ============ 四平台在线音乐 SDK（酷我 kw / 网易云 wy / QQ音乐 tx / 酷狗 kg） ============
// 移植自 lx-music-desktop src/renderer/utils/musicSdk/{kw,wy,tx,kg}/，适配本服务端
// 的 httpReq（见 lxmusic.js internals）。提供统一的 search / boards / boardSongs / lyric。
// 歌曲条目统一形状：{ songmid, name, singer, duration(秒), pic, album, src, ...平台附加字段 }
//   - src 平台标识，点歌/下载时透传给 lxmusic.downloadSong(source=src) 选对应脚本源
// 歌词统一返回标准 LRC 文本（逐字歌词一律降级为逐行 LRC）。
'use strict';

const crypto = require('crypto');
const zlib = require('zlib');
const { httpReq } = require('./lxmusic').internals;

const decodeName = (str = '') =>
  String(str ?? '').replace(/(?:&amp;|&lt;|&gt;|&quot;|&apos;|&#039;|&nbsp;)/gm, s => ({
    '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#039;': "'",
  }[s] || s));

const numFix = (num, length = 2) => String(num).padStart(length, '0');
const formatPlayTime = (time) => {
  const m = Math.trunc(time / 60), s = Math.trunc(time % 60);
  return m === 0 && s === 0 ? '--/--' : numFix(m) + ':' + numFix(s);
};

const formatSingerName = (singers, nameKey = 'name', join = '、') => {
  if (Array.isArray(singers)) {
    const arr = [];
    for (const item of singers) { if (item && item[nameKey]) arr.push(item[nameKey]); }
    return decodeName(arr.join(join));
  }
  return decodeName(String(singers ?? ''));
};

const parseJson = (body) => {
  if (typeof body !== 'string') return body;
  try { return JSON.parse(body); } catch (e) { return null; }
};

// ---------- 网易云 wy：eapi/weapi 加密（NeteaseCloudMusicApi 移植） ----------
const wyIv = Buffer.from('0102030405060708');
const wyPresetKey = Buffer.from('0CoJUm6Qyw8W8jud');
const wyBase62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const wyPublicKey = '-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB\n-----END PUBLIC KEY-----';
const wyEapiKey = 'e82ckenh8dichen8';

const wyAesEncrypt = (buffer, mode, key, iv) => {
  const cipher = crypto.createCipheriv(mode, key, iv);
  return Buffer.concat([cipher.update(buffer), cipher.final()]);
};
const wyRsaEncrypt = (buffer, key) => {
  buffer = Buffer.concat([Buffer.alloc(128 - buffer.length), buffer]);
  return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_NO_PADDING }, buffer);
};
const wyWeapi = (object) => {
  const text = JSON.stringify(object);
  const secretKey = crypto.randomBytes(16).map(n => wyBase62.charCodeAt(n % 62));
  return {
    params: wyAesEncrypt(Buffer.from(wyAesEncrypt(Buffer.from(text), 'aes-128-cbc', wyPresetKey, wyIv).toString('base64')), 'aes-128-cbc', secretKey, wyIv).toString('base64'),
    encSecKey: wyRsaEncrypt(Buffer.from([...secretKey].reverse()), wyPublicKey).toString('hex'),
  };
};
const wyEapi = (url, object) => {
  const text = typeof object === 'object' ? JSON.stringify(object) : object;
  const message = `nobody${url}use${text}md5forencrypt`;
  const digest = crypto.createHash('md5').update(message).digest('hex');
  const data = `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
  return { params: wyAesEncrypt(Buffer.from(data), 'aes-128-ecb', wyEapiKey, '').toString('hex').toUpperCase() };
};
const WY_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36',
  origin: 'https://music.163.com',
};
const wyEapiRequest = (url, data) => httpReq('http://interface.music.163.com/eapi/batch', {
  method: 'post', headers: WY_HEADERS, form: wyEapi(url, data),
});

// ---------- QQ音乐 tx：zzc 签名（sha1） ----------
const TX_PART_1 = [23, 14, 6, 36, 16, 40, 7, 19];
const TX_PART_2 = [16, 1, 32, 12, 19, 27, 8, 5];
const TX_SCRAMBLE = [89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121, 179];
const txZzcSign = (text) => {
  const hash = crypto.createHash('sha1').update(text).digest('hex');
  const part1 = TX_PART_1.map(i => hash[i]).join('');
  const part2 = TX_PART_2.map(i => hash[i]).join('');
  const part3 = TX_SCRAMBLE.map((v, i) => v ^ parseInt(hash.slice(i * 2, i * 2 + 2), 16));
  const b64 = Buffer.from(part3).toString('base64').replace(/[\\/+=]/g, '');
  return `zzc${part1}${b64}${part2}`.toLowerCase();
};
const txSignRequest = async (data) => {
  const sign = txZzcSign(JSON.stringify(data));
  return httpReq(`https://u.y.qq.com/cgi-bin/musics.fcg?sign=${sign}`, {
    method: 'post',
    headers: { 'User-Agent': 'QQMusic 14090508(android 12)' },
    body: JSON.stringify(data),
  });
};

// ---------- QRC 歌词解密（3DES-ECB 变体 + inflate，LX 纯 JS 移植） ----------
// 注意：QRC 用非标准 DES 变体（S2[23]=15、S4[53]=10），不能用 node crypto 的 3DES。
const QRC_SBOX = [
  [14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7,0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8,4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0,15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
  [15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10,3,13,4,7,15,2,8,15,12,0,1,10,6,9,11,5,0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15,13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
  [10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8,13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1,13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7,1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
  [7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15,13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9,10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4,3,15,0,6,10,10,13,8,9,4,5,11,12,7,2,14],
  [2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9,14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6,4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14,11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
  [12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11,10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8,9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6,4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
  [4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1,13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6,1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2,6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
  [13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7,1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2,7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8,2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11],
];
const QRC_KEY_SHIFT = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const QRC_PERM_C = [56,48,40,32,24,16,8,0,57,49,41,33,25,17,9,1,58,50,42,34,26,18,10,2,59,51,43,35];
const QRC_PERM_D = [62,54,46,38,30,22,14,6,61,53,45,37,29,21,13,5,60,52,44,36,28,20,12,4,27,19,11,3];
const QRC_COMPRESSION = [13,16,10,23,0,4,2,27,14,5,20,9,22,18,11,3,25,7,15,6,26,19,12,1,40,51,30,36,46,54,29,39,50,44,32,47,43,48,38,55,33,52,45,41,49,35,28,31];
const qrcBitnum = (a, b, c) => (((a[((b / 32) | 0) * 4 + 3 - (((b % 32) / 8) | 0)] >>> (7 - (b % 8))) & 1) << c) >>> 0;
const qrcBitnumIntr = (a, b, c) => (((a >>> (31 - b)) & 1) << c) >>> 0;
const qrcBitnumIntl = (a, b, c) => (((((a << b) >>> 0) & 0x80000000) >>> 0) >>> c) >>> 0;
const qrcSboxBit = a => (a & 32) | ((a & 31) >>> 1) | ((a & 1) << 4);
const qrcInitialPermutation = (input) => {
  const s0 = (
    qrcBitnum(input,57,31)|qrcBitnum(input,49,30)|qrcBitnum(input,41,29)|qrcBitnum(input,33,28)|
    qrcBitnum(input,25,27)|qrcBitnum(input,17,26)|qrcBitnum(input,9,25)|qrcBitnum(input,1,24)|
    qrcBitnum(input,59,23)|qrcBitnum(input,51,22)|qrcBitnum(input,43,21)|qrcBitnum(input,35,20)|
    qrcBitnum(input,27,19)|qrcBitnum(input,19,18)|qrcBitnum(input,11,17)|qrcBitnum(input,3,16)|
    qrcBitnum(input,61,15)|qrcBitnum(input,53,14)|qrcBitnum(input,45,13)|qrcBitnum(input,37,12)|
    qrcBitnum(input,29,11)|qrcBitnum(input,21,10)|qrcBitnum(input,13,9)|qrcBitnum(input,5,8)|
    qrcBitnum(input,63,7)|qrcBitnum(input,55,6)|qrcBitnum(input,47,5)|qrcBitnum(input,39,4)|
    qrcBitnum(input,31,3)|qrcBitnum(input,23,2)|qrcBitnum(input,15,1)|qrcBitnum(input,7,0)
  ) >>> 0;
  const s1 = (
    qrcBitnum(input,56,31)|qrcBitnum(input,48,30)|qrcBitnum(input,40,29)|qrcBitnum(input,32,28)|
    qrcBitnum(input,24,27)|qrcBitnum(input,16,26)|qrcBitnum(input,8,25)|qrcBitnum(input,0,24)|
    qrcBitnum(input,58,23)|qrcBitnum(input,50,22)|qrcBitnum(input,42,21)|qrcBitnum(input,34,20)|
    qrcBitnum(input,26,19)|qrcBitnum(input,18,18)|qrcBitnum(input,10,17)|qrcBitnum(input,2,16)|
    qrcBitnum(input,60,15)|qrcBitnum(input,52,14)|qrcBitnum(input,44,13)|qrcBitnum(input,36,12)|
    qrcBitnum(input,28,11)|qrcBitnum(input,20,10)|qrcBitnum(input,12,9)|qrcBitnum(input,4,8)|
    qrcBitnum(input,62,7)|qrcBitnum(input,54,6)|qrcBitnum(input,46,5)|qrcBitnum(input,38,4)|
    qrcBitnum(input,30,3)|qrcBitnum(input,22,2)|qrcBitnum(input,14,1)|qrcBitnum(input,6,0)
  ) >>> 0;
  return [s0, s1];
};
const qrcInversePermutation = (s0, s1, out) => {
  out[3] = (qrcBitnumIntr(s1,7,7)|qrcBitnumIntr(s0,7,6)|qrcBitnumIntr(s1,15,5)|qrcBitnumIntr(s0,15,4)|qrcBitnumIntr(s1,23,3)|qrcBitnumIntr(s0,23,2)|qrcBitnumIntr(s1,31,1)|qrcBitnumIntr(s0,31,0)) & 0xff;
  out[2] = (qrcBitnumIntr(s1,6,7)|qrcBitnumIntr(s0,6,6)|qrcBitnumIntr(s1,14,5)|qrcBitnumIntr(s0,14,4)|qrcBitnumIntr(s1,22,3)|qrcBitnumIntr(s0,22,2)|qrcBitnumIntr(s1,30,1)|qrcBitnumIntr(s0,30,0)) & 0xff;
  out[1] = (qrcBitnumIntr(s1,5,7)|qrcBitnumIntr(s0,5,6)|qrcBitnumIntr(s1,13,5)|qrcBitnumIntr(s0,13,4)|qrcBitnumIntr(s1,21,3)|qrcBitnumIntr(s0,21,2)|qrcBitnumIntr(s1,29,1)|qrcBitnumIntr(s0,29,0)) & 0xff;
  out[0] = (qrcBitnumIntr(s1,4,7)|qrcBitnumIntr(s0,4,6)|qrcBitnumIntr(s1,12,5)|qrcBitnumIntr(s0,12,4)|qrcBitnumIntr(s1,20,3)|qrcBitnumIntr(s0,20,2)|qrcBitnumIntr(s1,28,1)|qrcBitnumIntr(s0,28,0)) & 0xff;
  out[7] = (qrcBitnumIntr(s1,3,7)|qrcBitnumIntr(s0,3,6)|qrcBitnumIntr(s1,11,5)|qrcBitnumIntr(s0,11,4)|qrcBitnumIntr(s1,19,3)|qrcBitnumIntr(s0,19,2)|qrcBitnumIntr(s1,27,1)|qrcBitnumIntr(s0,27,0)) & 0xff;
  out[6] = (qrcBitnumIntr(s1,2,7)|qrcBitnumIntr(s0,2,6)|qrcBitnumIntr(s1,10,5)|qrcBitnumIntr(s0,10,4)|qrcBitnumIntr(s1,18,3)|qrcBitnumIntr(s0,18,2)|qrcBitnumIntr(s1,26,1)|qrcBitnumIntr(s0,26,0)) & 0xff;
  out[5] = (qrcBitnumIntr(s1,1,7)|qrcBitnumIntr(s0,1,6)|qrcBitnumIntr(s1,9,5)|qrcBitnumIntr(s0,9,4)|qrcBitnumIntr(s1,17,3)|qrcBitnumIntr(s0,17,2)|qrcBitnumIntr(s1,25,1)|qrcBitnumIntr(s0,25,0)) & 0xff;
  out[4] = (qrcBitnumIntr(s1,0,7)|qrcBitnumIntr(s0,0,6)|qrcBitnumIntr(s1,8,5)|qrcBitnumIntr(s0,8,4)|qrcBitnumIntr(s1,16,3)|qrcBitnumIntr(s0,16,2)|qrcBitnumIntr(s1,24,1)|qrcBitnumIntr(s0,24,0)) & 0xff;
};
const qrcDesF = (state, key) => {
  const t1 = (
    qrcBitnumIntl(state,31,0)|(((state & 0xF0000000) >>> 0) >>> 1)|qrcBitnumIntl(state,4,5)|
    qrcBitnumIntl(state,3,6)|(((state & 0x0F000000) >>> 0) >>> 3)|qrcBitnumIntl(state,8,11)|
    qrcBitnumIntl(state,7,12)|(((state & 0x00F00000) >>> 0) >>> 5)|qrcBitnumIntl(state,12,17)|
    qrcBitnumIntl(state,11,18)|(((state & 0x000F0000) >>> 0) >>> 7)|qrcBitnumIntl(state,16,23)
  ) >>> 0;
  const t2 = (
    qrcBitnumIntl(state,15,0)|(((state & 0x0000F000) << 15) >>> 0)|qrcBitnumIntl(state,20,5)|
    qrcBitnumIntl(state,19,6)|(((state & 0x00000F00) << 13) >>> 0)|qrcBitnumIntl(state,24,11)|
    qrcBitnumIntl(state,23,12)|(((state & 0x000000F0) << 11) >>> 0)|qrcBitnumIntl(state,28,17)|
    qrcBitnumIntl(state,27,18)|(((state & 0x0000000F) << 9) >>> 0)|qrcBitnumIntl(state,0,23)
  ) >>> 0;
  const lrg = [(t1>>>24)&0xFF,(t1>>>16)&0xFF,(t1>>>8)&0xFF,(t2>>>24)&0xFF,(t2>>>16)&0xFF,(t2>>>8)&0xFF];
  for (let i = 0; i < 6; i++) lrg[i] ^= key[i];
  const s = (
    (QRC_SBOX[0][qrcSboxBit(lrg[0]>>>2)]<<28)|
    (QRC_SBOX[1][qrcSboxBit(((lrg[0]&0x03)<<4)|(lrg[1]>>>4))]<<24)|
    (QRC_SBOX[2][qrcSboxBit(((lrg[1]&0x0F)<<2)|(lrg[2]>>>6))]<<20)|
    (QRC_SBOX[3][qrcSboxBit(lrg[2]&0x3F)]<<16)|
    (QRC_SBOX[4][qrcSboxBit(lrg[3]>>>2)]<<12)|
    (QRC_SBOX[5][qrcSboxBit(((lrg[3]&0x03)<<4)|(lrg[4]>>>4))]<<8)|
    (QRC_SBOX[6][qrcSboxBit(((lrg[4]&0x0F)<<2)|(lrg[5]>>>6))]<<4)|
    QRC_SBOX[7][qrcSboxBit(lrg[5]&0x3F)]
  ) >>> 0;
  return (
    qrcBitnumIntl(s,15,0)|qrcBitnumIntl(s,6,1)|qrcBitnumIntl(s,19,2)|qrcBitnumIntl(s,20,3)|
    qrcBitnumIntl(s,28,4)|qrcBitnumIntl(s,11,5)|qrcBitnumIntl(s,27,6)|qrcBitnumIntl(s,16,7)|
    qrcBitnumIntl(s,0,8)|qrcBitnumIntl(s,14,9)|qrcBitnumIntl(s,22,10)|qrcBitnumIntl(s,25,11)|
    qrcBitnumIntl(s,4,12)|qrcBitnumIntl(s,17,13)|qrcBitnumIntl(s,30,14)|qrcBitnumIntl(s,9,15)|
    qrcBitnumIntl(s,1,16)|qrcBitnumIntl(s,7,17)|qrcBitnumIntl(s,23,18)|qrcBitnumIntl(s,13,19)|
    qrcBitnumIntl(s,31,20)|qrcBitnumIntl(s,26,21)|qrcBitnumIntl(s,2,22)|qrcBitnumIntl(s,8,23)|
    qrcBitnumIntl(s,18,24)|qrcBitnumIntl(s,12,25)|qrcBitnumIntl(s,29,26)|qrcBitnumIntl(s,5,27)|
    qrcBitnumIntl(s,21,28)|qrcBitnumIntl(s,10,29)|qrcBitnumIntl(s,3,30)|qrcBitnumIntl(s,24,31)
  ) >>> 0;
};
const qrcDesCrypt = (input, schedule, output) => {
  let [s0, s1] = qrcInitialPermutation(input);
  for (let i = 0; i < 15; i++) {
    const prev = s1;
    s1 = (qrcDesF(s1, schedule[i]) ^ s0) >>> 0;
    s0 = prev;
  }
  s0 = (qrcDesF(s1, schedule[15]) ^ s0) >>> 0;
  qrcInversePermutation(s0, s1, output);
};
const qrcKeySchedule = (key, decrypt) => {
  const schedule = Array.from({ length: 16 }, () => new Uint8Array(6));
  let c = 0, d = 0;
  for (let i = 0; i < 28; i++) {
    c = (c | qrcBitnum(key, QRC_PERM_C[i], 31 - i)) >>> 0;
    d = (d | qrcBitnum(key, QRC_PERM_D[i], 31 - i)) >>> 0;
  }
  for (let i = 0; i < 16; i++) {
    c = ((((c << QRC_KEY_SHIFT[i]) >>> 0) | (c >>> (28 - QRC_KEY_SHIFT[i]))) & 0xFFFFFFF0) >>> 0;
    d = ((((d << QRC_KEY_SHIFT[i]) >>> 0) | (d >>> (28 - QRC_KEY_SHIFT[i]))) & 0xFFFFFFF0) >>> 0;
    const togen = decrypt ? 15 - i : i;
    for (let j = 0; j < 24; j++) schedule[togen][(j / 8) | 0] |= qrcBitnumIntr(c, QRC_COMPRESSION[j], 7 - (j % 8));
    for (let j = 24; j < 48; j++) schedule[togen][(j / 8) | 0] |= qrcBitnumIntr(d, QRC_COMPRESSION[j] - 27, 7 - (j % 8));
  }
  return schedule;
};
const QRC_KEY = Buffer.from([0x21,0x40,0x23,0x29,0x28,0x2a,0x24,0x25,0x31,0x32,0x33,0x5a,0x58,0x43,0x21,0x40,0x21,0x40,0x23,0x29,0x28,0x4e,0x48,0x4c]);
const decodeQrc = async (hexData) => {
  if (!hexData || hexData.length % 2 !== 0) return '';
  const encrypted = Buffer.from(hexData, 'hex');
  if (!encrypted.length) return '';
  const schedule = [
    qrcKeySchedule(QRC_KEY.subarray(16, 24), true),
    qrcKeySchedule(QRC_KEY.subarray(8, 16), false),
    qrcKeySchedule(QRC_KEY.subarray(0, 8), true),
  ];
  const mid = new Uint8Array(8);
  const out = new Uint8Array(8);
  for (let i = 0; i + 8 <= encrypted.length; i += 8) {
    const block = encrypted.subarray(i, i + 8);
    // 3DES 解密（EDE3 反序）：D(k3) → D(k2) → D(k1)
    qrcDesCrypt(block, schedule[0], mid);
    qrcDesCrypt(mid, schedule[1], out);
    qrcDesCrypt(out, schedule[2], mid);
    encrypted.set(mid, i);
  }
  try {
    const result = await new Promise((resolve, reject) =>
      zlib.inflate(encrypted, { finishFlush: zlib.constants.Z_SYNC_FLUSH }, (e, r) => e ? reject(e) : resolve(r)));
    return result.toString('utf8');
  } catch (e) { return ''; }
};

// QRC 逐字歌词 → 逐行 LRC（[start,dur] 行 → [mm:ss.xxx] 行，去掉逐字时间轴）
const qrcParseLrc = (lrc) => {
  lrc = String(lrc || '').trim().replace(/\r/g, '');
  if (!lrc) return '';
  const lines = lrc.split('\n');
  const out = [];
  for (let line of lines) {
    line = line.trim();
    let m = /^\[(\d+),\d+\]/.exec(line);
    if (m) {
      const t = parseInt(m[1]);
      const ms = (t % 1000).toString().padStart(3, '0');
      const mm = String(Math.trunc(t / 60000)).padStart(2, '0');
      const ss = String(Math.trunc(t / 1000) % 60).padStart(2, '0');
      out.push(`[${mm}:${ss}.${ms}]${line.replace(/^\[(\d+),\d+\]/, '').replace(/\(\d+,\d+,\d+\)/g, '')}`);
    } else if (/^\[[\d:.]+\]/.test(line) || line.startsWith('[offset')) {
      out.push(line);
    }
  }
  return out.join('\n');
};
const txRemoveTag = (str) => String(str || '').replace(/^[\S\s]*?LyricContent="/, '').replace(/"\/>[\S\s]*?$/, '');

// ---------- 酷狗 KRC 解密（XOR + inflate） ----------
const KRC_ENC_KEY = Buffer.from([0x40,0x47,0x61,0x77,0x5e,0x32,0x74,0x47,0x51,0x36,0x31,0x2d,0xce,0xd2,0x6e,0x69], 'binary');
const decodeKrcLyric = async (str) => {
  if (!str || !str.length) return '';
  const buf = Buffer.from(str, 'base64').subarray(4);
  for (let i = 0, len = buf.length; i < len; i++) buf[i] = buf[i] ^ KRC_ENC_KEY[i % 16];
  const result = await new Promise((resolve, reject) => zlib.inflate(buf, (e, r) => e ? reject(e) : resolve(r)));
  let text = result.toString().replace(/\r/g, '');
  text = text.replace(/^.*\[id:\$\w+\]\n/, '');
  // 逐字 → 逐行
  const out = [];
  for (let line of text.split('\n')) {
    const m = /^\[((\d+),\d+)\]/.exec(line);
    if (m) {
      let time = parseInt(m[2]);
      const ms = (time % 1000).toString().padStart(3, '0');
      time /= 1000;
      const mm = String(Math.trunc(time / 60)).padStart(2, '0');
      const ss = String(Math.trunc(time) % 60).padStart(2, '0');
      out.push(`[${mm}:${ss}.${ms}]${line.replace(m[0], '').replace(/<\d+,\d+,\d+>/g, '')}`);
    } else if (/^\[[\d:.]+\]/.test(line)) {
      out.push(line);
    }
  }
  return decodeName(out.join('\n').replace(/<\d+,\d+>/g, ''));
};

// ---------- kw：委托 lxmusic 内置酷我 ----------
const lxmusic = require('./lxmusic');

async function kwSearch(q, page, limit) {
  const r = await lxmusic.kwSearch(q, page, limit);
  r.list = r.list.map(m => ({ ...m, src: 'kw', duration: m.duration || 0 }));
  return r;
}
async function kwBoards() { return { list: lxmusic.KW_BOARDS.map(b => ({ bangid: b.bangid, name: b.name })) }; }
async function kwBoardSongs(bangid, page, limit) {
  const r = await lxmusic.kwBoardSongs(bangid, page, limit);
  r.list = r.list.map(m => ({ ...m, src: 'kw', duration: m.duration || 0 }));
  return r;
}
async function kwLyricText(song) {
  return lxmusic.kwLyric(song.songmid);
}

// ---------- wy ----------
// 网易云的音质标注走 privilege.maxbr（999000+=无损SQ，1900000=hires）；
// 老接口/歌曲详情则直接给 h(320k)/m/l/sq/hr 这些质量对象。两者都没有 → 空数组（未标注）。
const wyQualityTypes = (item) => {
  const p = item.privilege;
  const t = [];
  if (p) {
    const br = Math.max(+(p.maxbr || 0), +(p.downloadMaxbr || 0), +(p.playMaxbr || 0));
    if (br >= 1900000) t.push('flac24bit');
    if (br >= 900000) t.push('flac');
    if (br >= 320000) t.push('320k');
    if (br >= 128000) t.push('128k');
    return t;
  }
  const has = (q) => !!(q && (+q.size > 0 || +q.br > 0));
  if (has(item.hr)) t.push('flac24bit');
  if (has(item.sq)) t.push('flac');
  if (has(item.h)) t.push('320k');
  if (has(item.l)) t.push('128k');
  return t;
};
const wyFormatSong = (item) => ({
  songmid: String(item.id),
  name: item.name || '',
  singer: (item.ar || []).map(s => s.name).filter(Boolean).join('、'),
  album: (item.al && item.al.name) || '',
  pic: (item.al && item.al.picUrl) || '',
  duration: item.dt ? Math.round(item.dt / 1000) : 0,
  types: wyQualityTypes(item),
  src: 'wy',
});
async function wySearch(q, page, limit) {
  const resp = await wyEapiRequest('/api/search/song/list/page', {
    keyword: q, needCorrect: '1', channel: 'typing', offset: limit * (page - 1), scene: 'normal', total: page === 1, limit,
  });
  const body = parseJson(resp.body);
  if (!body || body.code !== 200) throw new Error('网易云搜索失败');
  const list = (body.data && body.data.resources || []).map(r => wyFormatSong(r.baseInfo && r.baseInfo.simpleSongData || {}));
  return { list: list.filter(m => m.name), total: (body.data && body.data.totalCount) || list.length, page, limit };
}
async function wyBoards() {
  return {
    list: [
      { bangid: '19723756', name: '飙升榜' }, { bangid: '3778678', name: '热歌榜' },
      { bangid: '3779629', name: '新歌榜' }, { bangid: '2884035', name: '原创榜' },
      { bangid: '21845217', name: 'KTV唛榜' }, { bangid: '2250011882', name: '抖音榜' },
      { bangid: '991319590', name: '说唱榜' }, { bangid: '71384707', name: '古典榜' },
      { bangid: '1978921795', name: '电音榜' }, { bangid: '745956260', name: '韩语榜' },
      { bangid: '60198', name: '美国Billboard榜' }, { bangid: '2809513713', name: '欧美热歌榜' },
      { bangid: '5059633707', name: '摇滚榜' }, { bangid: '5059642708', name: '国风榜' },
    ],
  };
}
async function wyBoardSongs(bangid, page, limit) {
  const resp = await httpReq('https://music.163.com/weapi/v3/playlist/detail', {
    method: 'post', headers: WY_HEADERS, form: wyWeapi({ id: String(bangid), n: 100000, p: 1 }),
  });
  const body = parseJson(resp.body);
  if (!body || body.code !== 200 || !body.playlist) throw new Error('网易云榜单获取失败');
  const ids = (body.playlist.trackIds || []).map(t => t.id);
  const slice = ids.slice((page - 1) * limit, page * limit);
  if (!slice.length) return { list: [], total: ids.length, page, limit };
  const resp2 = await httpReq('https://music.163.com/weapi/v3/song/detail', {
    method: 'post', headers: WY_HEADERS,
    form: wyWeapi({ c: '[' + slice.map(id => `{"id":${id}}`).join(',') + ']', ids: '[' + slice.join(',') + ']' }),
  });
  const body2 = parseJson(resp2.body);
  if (!body2 || body2.code !== 200 || !body2.songs) throw new Error('网易云歌曲详情获取失败');
  const list = body2.songs.map(wyFormatSong).filter(m => m.name);
  return { list, total: ids.length, page, limit };
}
async function wyLyricText(song) {
  const resp = await httpReq('https://interface3.music.163.com/eapi/song/lyric/v1', {
    method: 'post', headers: WY_HEADERS,
    form: wyEapi('/api/song/lyric/v1', { id: song.songmid, cp: false, tv: 0, lv: 0, rv: 0, kv: 0, yv: 0, ytv: 0, yrv: 0 }),
  });
  const body = parseJson(resp.body);
  const lrc = body && body.lrc && body.lrc.lyric;
  if (!lrc || !/\[\d{1,2}:\d{2}/.test(lrc)) throw new Error('网易云歌词获取失败');
  return lrc;
}

// ---------- tx ----------
// QQ 搜索响应 file 里各音质的体积字段（>0 表示该音质可下载），据此还原 types。
const txQualityTypes = (file) => {
  if (!file) return [];
  const t = [];
  if (+file.size_hires > 0 || +file.size_360ra > 0) t.push('flac24bit');
  if (+file.size_flac > 0 || +file.size_ape > 0 || +file.size_wav > 0) t.push('flac');
  if (+file.size_320mp3 > 0) t.push('320k');
  if (+file.size_128mp3 > 0) t.push('128k');
  return t;
};
const txFormatSong = (item) => ({
  songmid: item.mid,
  songId: item.id,
  name: item.title || '',
  singer: formatSingerName(item.singer, 'name'),
  album: (item.album && item.album.name) || '',
  pic: (item.album && item.album.mid)
    ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${item.album.mid}.jpg`
    : (item.singer && item.singer.length ? `https://y.gtimg.cn/music/photo_new/T001R500x500M000${item.singer[0].mid}.jpg` : ''),
  duration: item.interval || 0,
  strMediaMid: item.file && item.file.media_mid,
  types: txQualityTypes(item.file),
  src: 'tx',
});
async function txSearch(q, page, limit) {
  const resp = await txSignRequest({
    comm: { _channelid: '0', _os_version: '6.2.9200-2', ct: '19', cv: '2151', guid: '1F70E520B2EAA7D25E11760783C53CA9', patch: '118', psrf_access_token_expiresAt: 0, psrf_qqaccess_token: '', psrf_qqopenid: '', psrf_qqunionid: '', tmeAppID: 'qqmusic', tmeLoginType: 0, uin: '0', wid: '7223299733393904640' },
    'music.search.SearchCgiService': {
      module: 'music.search.SearchCgiService', method: 'DoSearchForQQMusicDesktop',
      param: { grp: 1, num_per_page: limit, page_num: page, query: q, remoteplace: 'txt.newclient.top', search_type: 0, searchid: txSearchId() },
    },
  });
  const body = parseJson(resp.body);
  const req = body && (body['music.search.SearchCgiService'] || body.req);
  if (!req || body.code != 0 || req.code != 0) throw new Error('QQ音乐搜索失败');
  const songs = req.data && req.data.body && req.data.body.song && req.data.body.song.list || [];
  const list = songs.filter(m => m.file && m.file.media_mid).map(txFormatSong);
  const total = (req.data && req.data.meta && req.data.meta.sum) || list.length;
  return { list, total, page, limit };
}
function txSearchId() {
  let guid = '';
  for (let i = 0; i < 32; i++) guid += Math.floor(Math.random() * 16).toString(16);
  return guid.toUpperCase() + String(Math.floor(Math.random() * 100000)).padStart(5, '0');
}
async function txBoards() {
  return {
    list: [
      { bangid: '4', name: '流行指数榜' }, { bangid: '26', name: '热歌榜' }, { bangid: '27', name: '新歌榜' },
      { bangid: '62', name: '飙升榜' }, { bangid: '58', name: '说唱榜' }, { bangid: '57', name: '喜力电音榜' },
      { bangid: '28', name: '网络歌曲榜' }, { bangid: '5', name: '内地榜' }, { bangid: '3', name: '欧美榜' },
      { bangid: '59', name: '香港地区榜' }, { bangid: '16', name: '韩国榜' }, { bangid: '60', name: '抖快榜' },
      { bangid: '29', name: '影视金曲榜' }, { bangid: '17', name: '日本榜' }, { bangid: '36', name: 'K歌金曲榜' },
      { bangid: '61', name: '台湾地区榜' }, { bangid: '63', name: 'DJ舞曲榜' }, { bangid: '65', name: '国风热歌榜' },
    ],
  };
}
const txPeriods = new Map(); // bangid -> period
async function txGetPeriod(bangid) {
  if (txPeriods.has(bangid)) return txPeriods.get(bangid);
  const resp = await httpReq('https://c.y.qq.com/node/pc/wk_v15/top.html');
  const html = String(resp.body || '');
  const items = html.match(/<i class="play_cover__btn c_tx_link js_icon_play" data-listkey=".+?" data-listname=".+?" data-tid=".+?" data-date=".+?" .+?<\/i>/g) || [];
  for (const item of items) {
    const m = /data-listname="(.+?)" data-tid=".*?\/(.+?)" data-date="(.+?)" .+?<\/i>/.exec(item);
    if (m) txPeriods.set(m[2], m[3]);
  }
  const period = txPeriods.get(String(bangid));
  if (!period) throw new Error('QQ音乐榜单周期获取失败');
  return period;
}
async function txBoardSongs(bangid, page, limit) {
  let period = '';
  try { period = await txGetPeriod(bangid); } catch (e) { period = ''; }
  const resp = await httpReq('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'post',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)' },
    body: JSON.stringify({
      toplist: { module: 'musicToplist.ToplistInfoServer', method: 'GetDetail', param: { topid: parseInt(bangid), num: 300, period } },
      comm: { uin: 0, format: 'json', ct: 20, cv: 1859 },
    }),
  });
  const body = parseJson(resp.body);
  const data = body && body.toplist && body.toplist.data;
  if (!data || !data.songInfoList) throw new Error('QQ音乐榜单获取失败');
  const list = data.songInfoList.filter(m => m.file && m.file.media_mid).map(txFormatSong);
  return { list, total: list.length, page: 1, limit };
}
async function txGetSongId(song) {
  if (song.songId) return song.songId;
  const resp = await httpReq('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'post',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)' },
    body: JSON.stringify({
      comm: { ct: '19', cv: '1859', uin: '0' },
      req: { module: 'music.pf_song_detail_svr', method: 'get_song_detail_yqq', param: { song_type: 0, song_mid: song.songmid } },
    }),
  });
  const body = parseJson(resp.body);
  if (!body || body.code != 0 || !body.req || body.req.code != 0) throw new Error('QQ音乐歌曲信息获取失败');
  const id = body.req.data && body.req.data.track_info && body.req.data.track_info.id;
  if (!id) throw new Error('QQ音乐歌曲信息获取失败');
  return id;
}
async function txLyricText(song) {
  const songId = await txGetSongId(song);
  const resp = await httpReq('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'post',
    headers: { referer: 'https://y.qq.com', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.198 Safari/537.36' },
    body: JSON.stringify({
      comm: { ct: '19', cv: '1859', uin: '0' },
      req: {
        method: 'GetPlayLyricInfo', module: 'music.musichallSong.PlayLyricInfo',
        param: { format: 'json', crypt: 1, ct: 19, cv: 1873, interval: 0, lrc_t: 0, qrc: 1, qrc_t: 0, roma: 1, roma_t: 0, songID: songId, trans: 1, trans_t: 0, type: -1 },
      },
    }),
  });
  const body = parseJson(resp.body);
  const data = body && body.req && body.req.data;
  if (!data || !data.lyric) throw new Error('QQ音乐歌词获取失败');
  let lrc = data.lyric;
  if (/^[0-9a-fA-F]+$/.test(lrc.slice(0, 64)) && lrc.length % 2 === 0) {
    lrc = await decodeQrc(lrc); // hex 密文 → 解密
  }
  lrc = txRemoveTag(lrc);
  const parsed = qrcParseLrc(lrc);
  if (!/\[\d{1,3}:\d{2}/.test(parsed)) throw new Error('QQ音乐歌词解析失败');
  return parsed;
}

// ---------- kg ----------
// 酷狗搜索响应里的音质字段：File=128k / HQ=320k / SQ=无损 / Res、Super=高解析母带。
// 统一解析成 types（与酷我 N_MINFO 的产物同名同义），供「只收无损」筛选使用。
// 字段全为空时返回空数组，表示"平台未标注音质"——调用方不能据此判定为无无损。
const kgQualityTypes = (item) => {
  const t = [];
  if (+item.SuperFileSize > 0 || +item.ResFileSize > 0) t.push('flac24bit');
  if (+item.SQFileSize > 0) t.push('flac');
  if (+item.HQFileSize > 0) t.push('320k');
  if (+item.FileSize > 0) t.push('128k');
  return t;
};
const kgFormatSong = (item) => ({
  songmid: String(item.Audioid != null ? item.Audioid : item.audio_id),
  name: decodeName((item.OriSongName || item.songname || '') + (item.Suffix ? ` ${item.Suffix}` : '')),
  singer: formatSingerName(item.Singers || item.authors, item.Singers ? 'name' : 'author_name'),
  album: decodeName(item.AlbumName || item.remark || ''),
  pic: null,
  duration: item.Duration || item.duration || 0,
  hash: item.FileHash || item.hash,
  albumAudioId: String(item.MixSongID != null ? item.MixSongID : item.album_audio_id),
  types: kgQualityTypes(item),
  src: 'kg',
});
async function kgSearch(q, page, limit) {
  const resp = await httpReq(`http://songsearch.kugou.com/song_search_v2?platform=AndroidFilter&iscorrection=1&keyword=${encodeURIComponent(q)}&hifiquality=0&pagesize=${limit}&PrivilegeFilter=0&page=${page}`);
  const body = parseJson(resp.body);
  if (!body || body.error_code !== 0 || !body.data) throw new Error('酷狗搜索失败');
  const seen = new Set();
  const list = [];
  for (const item of body.data.lists || []) {
    const key = item.Audioid + String(item.FileHash);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(kgFormatSong(item));
    for (const child of item.Grp || []) {
      const k2 = child.Audioid + String(child.FileHash);
      if (seen.has(k2)) continue;
      seen.add(k2);
      list.push(kgFormatSong(child));
    }
  }
  return { list, total: body.data.total || list.length, page, limit };
}
async function kgBoards() {
  return {
    list: [
      { bangid: '8888', name: 'TOP500' }, { bangid: '6666', name: '飙升榜' }, { bangid: '23784', name: '网络红歌榜' },
      { bangid: '52144', name: '抖音热歌榜' }, { bangid: '52767', name: '快手热歌榜' }, { bangid: '24971', name: 'DJ热歌榜' },
      { bangid: '31308', name: '内地榜' }, { bangid: '33160', name: '电音榜' }, { bangid: '31313', name: '香港地区榜' },
      { bangid: '31310', name: '欧美榜' }, { bangid: '33165', name: '粤语金曲榜' }, { bangid: '33166', name: '欧美金曲榜' },
      { bangid: '33163', name: '影视金曲榜' }, { bangid: '33161', name: '古风新歌榜' }, { bangid: '31311', name: '韩国榜' },
      { bangid: '31312', name: '日本榜' }, { bangid: '49225', name: '80后热歌榜' }, { bangid: '49223', name: '90后热歌榜' },
      { bangid: '49224', name: '00后热歌榜' }, { bangid: '51340', name: '伤感榜' },
    ],
  };
}
async function kgBoardSongs(bangid, page, limit) {
  const url = `http://mobilecdnbj.kugou.com/api/v3/rank/song?version=9108&ranktype=1&plat=0&pagesize=${limit}&area_code=1&page=${page}&rankid=${encodeURIComponent(bangid)}&with_res_tag=0&show_portrait_mv=1`;
  const resp = await httpReq(url);
  const body = parseJson(resp.body);
  if (!body || body.errcode != 0 || !body.data) throw new Error('酷狗榜单获取失败');
  const list = (body.data.info || []).map(kgFormatSong).filter(m => m.name);
  return { list, total: body.data.total || list.length, page, limit };
}
async function kgLyricText(song) {
  const time = song.duration ? song.duration * 1000 : 0;
  const headers = { 'KG-RC': 1, 'KG-THash': 'expand_search_manager.cpp:852736169:451', 'User-Agent': 'KuGou2012-9020-ExpandSearchManager' };
  const r1 = await httpReq(`http://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=${encodeURIComponent(song.name)}&hash=${song.hash || ''}&timelength=${time}&lrctxt=1`, { headers });
  const b1 = parseJson(r1.body);
  const cand = b1 && Array.isArray(b1.candidates) && b1.candidates[0];
  if (!cand) throw new Error('酷狗歌词未找到');
  const fmt = (cand.krctype == 1 && cand.contenttype != 1) ? 'krc' : 'lrc';
  const r2 = await httpReq(`http://lyrics.kugou.com/download?ver=1&client=pc&id=${cand.id}&accesskey=${cand.accesskey}&fmt=${fmt}&charset=utf8`, { headers });
  const b2 = parseJson(r2.body);
  if (!b2 || !b2.content) throw new Error('酷狗歌词下载失败');
  if (b2.fmt === 'krc') return decodeKrcLyric(b2.content);
  return Buffer.from(b2.content, 'base64').toString('utf-8');
}

// ---------- 统一入口 ----------
const SOURCES = [
  { id: 'kw', name: '酷我' },
  { id: 'wy', name: '网易云' },
  { id: 'tx', name: 'QQ音乐' },
  { id: 'kg', name: '酷狗' },
];
const isValidSource = (s) => SOURCES.some(x => x.id === s);

async function search(src, q, page = 1, limit = 30) {
  src = isValidSource(src) ? src : 'kw';
  limit = Math.min(Math.max(1, limit), 100);
  if (src === 'kw') return kwSearch(q, page, limit);
  if (src === 'wy') return wySearch(q, page, limit);
  if (src === 'tx') return txSearch(q, page, limit);
  return kgSearch(q, page, limit);
}
async function boards(src) {
  src = isValidSource(src) ? src : 'kw';
  if (src === 'kw') return kwBoards();
  if (src === 'wy') return wyBoards();
  if (src === 'tx') return txBoards();
  return kgBoards();
}
async function boardSongs(src, bangid, page = 1, limit = 100) {
  src = isValidSource(src) ? src : 'kw';
  limit = Math.min(Math.max(1, limit), 300);
  if (src === 'kw') return kwBoardSongs(bangid, page, limit);
  if (src === 'wy') return wyBoardSongs(bangid, page, limit);
  if (src === 'tx') return txBoardSongs(bangid, page, limit);
  return kgBoardSongs(bangid, page, limit);
}
async function lyricText(src, song) {
  src = isValidSource(src) ? src : 'kw';
  if (src === 'kw') return kwLyricText(song);
  if (src === 'wy') return wyLyricText(song);
  if (src === 'tx') return txLyricText(song);
  return kgLyricText(song);
}

module.exports = { SOURCES, isValidSource, search, boards, boardSongs, lyricText, decodeQrc,
  // 测试用：各平台"音质字段 → types"的解析函数
  _qualityTypes: { kw: null, wy: wyQualityTypes, tx: txQualityTypes, kg: kgQualityTypes },
};
