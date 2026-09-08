// 麦动 .ls 加密 TS 解密（Node 版，移植自 maidong app TsDecryptor.kt）
// =====================================================================
// ktv_api 换链对部分歌曲返回 .ls 直链：512 字节头 + 分段 AES-ECB 加密的
// MPEG-TS。maidong app 下载后用内置密钥表解密再播；这里做同款解密，
// 让批量下载/点唱下载拿到 .ls 时也能落成标准 .ts 入库。
// 头部布局（均在 512 字节头内）：
//   [0]        首字节 0x47 且无签名 = 明文 TS；否则看 [500..512) 签名
//   [500..512) 签名：THUNDERCRYP3 / HHCMUSECRYP1 / HHCMUSECRYP2
//   [53]&0x0f  密钥表下标（每张表 16 把 32 字节 AES-256 密钥）
//   [452]      段大小（KB）
//   [453]      加密模式（目前只支持 0）
//   [454]      加密段间隔（0 = 全部加密）
//   [457]      首个加密段序号
'use strict';

const fs = require('fs');
const crypto = require('crypto');

const HEADER_SIZE = 512;

const KEY_TABLES = {
  THUNDERCRYP3: [
    'c6d3cdd0f1ebf5ded4d7d3cebbd3dad2cecdd0b8deaccbead2c5cac3c2dba6ac',
    'f5deebd8d3ced7b9dad2d3d8d0bcd9f6cbd7c9c2cab1d0f0a6f8d0afd0d3b9d4',
    'c3d4d7b2c2d5aaeecbd3b7dcbcc6b4f4b7d4b2b2fed5e0cbd3d5b2d7c6b7cef3',
    'b6bdaea7ced2d2b4aac1bbd3cbc8b7d6aacbbdaecbd4cbb5f9daddc0cecbe4d7',
    'd7d3d4dde8cedaf3c7b4cbddd2d3aee7f5d6d6b2d2aed0c9cbcddbb2ddf0e6c9',
    'b4d3d3b0d9d6cbe2e2aeaea2d6b8c7b2c3c9e5bbd6d9c7bcaee2d2dababac1b2',
    'd9d6cbe2e2aeaea2d6b2c7b2c3e0e5bbd6d9c7bcaee2d2dababad6b2d3d3b1bb',
    'e2aeaea2d69dc7b2c35fe5bbd6d9c7bcaee2d2dababac2b2d3d3d9bbd6cbe2f0',
    '97bbecd2fab782f0c1d0f6b3bab2c8a9dec7d0ec62fdf8b1d3d2cebccef5c4dd',
    'eadcd4eecad6d3bec7ae81fde6badcd7eecf98d3c1f6d1cefac8d4c2b6d2c4c6',
    'e7bed4c1b5fdd8bcbfd7d0c867d3cbcbd1d4d1d6d4d8e1c8c4c7d1d6eedee1c8',
    'f2b1c8bdbbd4cfeff1b0d0f0d3cbddd4cec492d8d3c2b3e1daedb5fdb1bcf0d0',
    'd3cdd2d6d2f5d1dc81c1b3ba90eec2ee81cecece90c5fdc4ceb2d4cdc4bbd5f5',
    'f5cbaee0b9c9e8cafafae5bfcdcebccef5acc3c4b9d6bccdfadcc3f5bfd6b6d2',
    'd6d3c3b7dcdad2f4b7d6b3c3fedca3f4baccd2c2eeecf3e3b7c3cabdfefcbfab',
    'e0b4e4f8b8c9c9d3a3a5cfdad2cab5d2f3a6dbf3d6bfd2bfaecbcba5cec5bcc3',
  ],
  HHCMUSECRYP1: [
    'd7cad2d3d3b1e0d0d4cfcbc5bbb0b5f3d1d6d4d7a7aec3d4b6b2bad4f8bbf5b6',
    'd3cfd2d0b2b6d5d2bbf8dfb2babacebec3c3b4fdb7d7d6d7b8f7aed3c9c2d3ce',
    'cec4babde1b1f5bbc9b6d3b6edf8ebf8ceb2c5b2aabbf3bbc8d6d3d0cbd2d1c5',
    'f6f8dad0d4d0b6d3f2c5f8d0b5b7c7d3dcbad7e0bdb0c8c1f7aecaa6b6d6d0d4',
    'd4b1d2d7bbd8d3d3ceced7b2b4bdd3bbd1d6d4d6a7aebbd8ced1bed4e1a7fdf2',
    'd3d3d3eec7b9d6d2ddb1c1b2ced4d3b1cabbdad8d3b7cacedaf2c7c5d7d7b0c6',
    'd6d7b9c3aed3dbbbc7d4c6b9f3bbe4dbd6b8d6c6aeb8bee4d3d4b8d0ebdab8d0',
    'd0aabbaecbbad2d2f9cdd4e0b2b6c0b2bbf8f1bbd0babdbfd0cddac9d6b2d6d0',
    'd7b1b0b6d3a5b2f8cabec3c9b3d3f4f7ceced3d3dededadac7c7cad1f3f3c2d4',
    'f8c3d3c6c0c0b9c8d6f1b1e7b8d5d4c7bbdfbbd0b6d2cac8f8b2abe7bad7d4b4',
    'd6bbd2d5aebcb2feb2b2d7d2bbbbd3d4bcd6d4b5baaabbc2d6c8cec6aacbaaa9',
    'aee2c0ebd2b6d6d6d4f8aeaed0ced2d2ccded4d4c3b3b5c0f1dcc2f1c3b5c6d3',
    'cbb4b2dcb3d3bbb2c6d0d3d7dfc4e2d3cacbbeceaef9d8cab6d3c3d0f8fbcfa2',
    'aee1c0cfd2b6d6ced4aeaee4c0d2d2b2f1d4d4aecbc0c0cec0f1f1cad4bcc3d0',
    'bebad0c4b4f5a2d1bad7d7d3ced3d3d0d2cfd4cad4c4bbc2b1cec9b5f0caabdc',
    'bda2dee4d2bbd7cbe0d8d3f9d7d2d4d2e3b2bbd4d2b2cab9d4bbd3dbb7d3c6c6',
  ],
  HHCMUSECRYP2: [
    'b1b4d6d6f8f3aeaed5cab5b5dfc2d8c0b9cbb4b2fac0e6bbd6c9cdbfaefaf6c9',
    'c0dac9c9d5c9d3d3dfcfebebc1cdd6d6eeacaeaec3d2cbc9f1e2c0fad3bfbfb6',
    'd5b5b7bddfc0b2abc7d6b4c4faf7cbaad6d3ceb2c6c3e5bbb9d2d5ced9b2dfc5',
    'a8f8bfcdc1d6d7b7eedae4a3cacacacaebebebebd0c7c1c3d0bfb7f7b1cac9ce',
    'ced7d5d6aaf4dfc6d6c6d2c8aee4f2a8cacdc0d2c6e2fbb2d2cab6b1d4c6f8f8',
    'f8f8f8f8c8b1b1c4a1b8dcd3d6d6d6d6aeaeaeaecac7c5b1b5bfadb0b6b6b6b6',
    'c3b5cecbedc3b4e3cbcbd5b2e3e3bdbbcab6b6caa4e0f8a4d5d2c3d5dfb2eddf',
    'e1cbf2b8b8b4c7d4eff8a7f2b3bcc0c4b5d7efdac7cac0cda7aea1e2b3cdc1d6',
    'b6b9c7d4dba5fcf2b1b3beb9f8c7c3fab4d4b1d3ecf2a9c3c8c1cab2f1a6a6bb',
    'd9aef8fbcebebed5b4c3c3dfb6d2b6cec3b2f8b4c7b7b9d6c9f2faaed6b1c0d3',
    'c8d2b9d7a1f2cae3d3c1bed2c3b8fcb2d3d3cab9dadab3fab9b5bfd6fad0c9ae',
    'a6dad9aec7d0d0c8fce9d5a5d6d3d6c6d0daaee4d4bcb7c6add2d1dfc4b0cab9',
    'd2b6b8cebbfed1e1d6cad2b6d3aebbfeb5d6cacab1d3afaecebdb5cae1d9b1af',
    'd3e4aed0b6c9cab6f8c6c7f8b3b6ced2cbf8bde6d6d1cac7aef8a4bfd7d6b5b9',
    'b9bebec2fafcfcc3b4ceb4ceceaaceaad6c9d6c9aecfaecfc8c6c8c6abc6abc6',
    'f8f8dff8c7c9d2b7fcc6b2a5c8d6b9c4cbaecab1d6c9c9c6aec6cfe4b1d5b1b4',
  ],
};

/** 读 512 字节头判断是否为麦动加密文件。明文 TS（首字节 0x47 且无签名）返回 false。 */
function isEncryptedPath(p) {
  let fd;
  try {
    const st = fs.statSync(p);
    if (st.size <= HEADER_SIZE) return false;
    fd = fs.openSync(p, 'r');
    const h = Buffer.alloc(HEADER_SIZE);
    fs.readSync(fd, h, 0, HEADER_SIZE, 0);
    if (h[0] !== 0x47) return true;
    const sig = h.slice(500, 512).toString('latin1');
    return !!KEY_TABLES[sig];
  } catch (e) { return false; }
  finally { try { if (fd !== undefined) fs.closeSync(fd); } catch (e) {} }
}

/** 段序号是否需要解密：interval=0 全加密；否则首段 + 之后每隔 interval 段。 */
function _needDecrypt(i, first, interval) {
  if (interval === 0) return true;
  return i === first || (i > first && i % interval === 1);
}

/**
 * 解密 .ls → 明文数据（剥掉 512 字节头）。异步分段处理，不长时间占住事件循环。
 * 解密后尾部截齐到 188 字节整包（源文件末端可能有不足一个 TS 包的残段；
 * 对容器内容无害）。结果类型由调用方嗅探：0x47 开头 = 标准 TS；
 * "THUNDERSTONE_MUSIC" 开头 = 音乐容器（parseContainer 提取 mp3/歌词）。
 * 成功返回输出大小；失败抛错并保证不留半成品。
 */
async function decryptFile(input, output) {
  const st = fs.statSync(input);
  if (st.size <= HEADER_SIZE) throw new Error('加密文件过小');
  const fd = fs.openSync(input, 'r');
  const out = fs.openSync(output, 'w');
  try {
    const h = Buffer.alloc(HEADER_SIZE);
    fs.readSync(fd, h, 0, HEADER_SIZE, 0);
    const keys = KEY_TABLES[h.slice(500, 512).toString('latin1')];
    if (!keys) throw new Error('未知的加密签名: ' + JSON.stringify(h.slice(500, 512).toString('latin1')));
    const key = Buffer.from(keys[h[53] & 0x0f], 'hex');
    const segmentSize = h[452] * 1024;
    const mode = h[453];
    const interval = h[454];
    const firstEnc = h[457];
    if (!segmentSize) throw new Error('加密段大小无效');
    if (mode !== 0) throw new Error('不支持的加密模式: ' + mode);

    const seg = Buffer.alloc(segmentSize);
    let total = 0, segIndex = 0;
    for (;;) {
      let count = 0;
      while (count < segmentSize) {
        const n = fs.readSync(fd, seg, count, segmentSize - count, HEADER_SIZE + segIndex * segmentSize + count);
        if (n <= 0) break;
        count += n;
      }
      if (count <= 0) break;
      if (_needDecrypt(segIndex, firstEnc, interval)) {
        const decLen = count - (count % 16);
        if (decLen > 0) {
          const cipher = crypto.createDecipheriv('aes-256-ecb', key, null);
          cipher.setAutoPadding(false);
          const dec = Buffer.concat([cipher.update(seg.subarray(0, decLen)), cipher.final()]);
          fs.writeSync(out, dec, 0, dec.length, total);
          total += dec.length;
          if (decLen < count) { fs.writeSync(out, seg, decLen, count - decLen, total); total += count - decLen; }
        } else {
          fs.writeSync(out, seg, 0, count, total);
          total += count;
        }
      } else {
        fs.writeSync(out, seg, 0, count, total);
        total += count;
      }
      segIndex++;
      if ((segIndex % 64) === 0) await new Promise((r) => setImmediate(r)); // 让出事件循环
    }
    // 尾部截齐到 TS 整包（残段会产生不足 188 字节的尾巴）
    const aligned = total - (total % 188);
    if (aligned !== total) fs.ftruncateSync(out, aligned);
    return aligned;
  } catch (e) {
    try { fs.closeSync(out); } catch (e2) {}
    try { fs.unlinkSync(output); } catch (e3) {}
    throw e;
  } finally {
    try { fs.closeSync(fd); } catch (e2) {}
    try { fs.closeSync(out); } catch (e2) {}
  }
}

const CONTAINER_MAGIC = 'THUNDERSTONE_MUSIC';
const CONTAINER_ENTRY_BASE = 0x30;   // 目录表起点（数据区内）
const CONTAINER_ENTRY_SIZE = 40;     // name(32) + size(u32) + offset(u32)

/**
 * 解析 THUNDERSTONE_MUSIC 容器（入参为已解密文件路径，即剥头后的数据区）。
 * 布局：[0..0x30) 魔数 "THUNDERSTONE_MUSIC v1.0"；随后每 40 字节一个条目：
 * name(32, NUL 结尾) + size(u32 LE) + offset(u32 LE, 数据区内相对偏移)。
 * 条目数不外置，靠合法性终止：offset+size 越界、offset 落在目录表内、
 * 或 name 为空即停（首个条目的 offset 就是内容区起点）。
 * 返回 { entries: [{name,size,offset}] }；非容器返回 null。
 */
function parseContainer(p) {
  try {
    const st = fs.statSync(p);
    const fd = fs.openSync(p, 'r');
    try {
      const head = Buffer.alloc(CONTAINER_ENTRY_BASE);
      if (fs.readSync(fd, head, 0, CONTAINER_ENTRY_BASE, 0) < CONTAINER_ENTRY_BASE) return null;
      if (!head.toString('latin1', 0, CONTAINER_MAGIC.length).startsWith(CONTAINER_MAGIC)) return null;
      const entries = [];
      const ent = Buffer.alloc(CONTAINER_ENTRY_SIZE);
      for (let pos = CONTAINER_ENTRY_BASE; pos + CONTAINER_ENTRY_SIZE <= st.size; pos += CONTAINER_ENTRY_SIZE) {
        if (fs.readSync(fd, ent, 0, CONTAINER_ENTRY_SIZE, pos) < CONTAINER_ENTRY_SIZE) break;
        const nul = ent.subarray(0, 32).indexOf(0);
        const name = ent.toString('latin1', 0, nul < 0 ? 32 : nul).trim();
        const size = ent.readUInt32LE(32);
        const offset = ent.readUInt32LE(36);
        if (!name || !/^[A-Za-z0-9._\-]+$/.test(name)) break;              // 文件名只含安全字符
        if (offset < pos || offset + size > st.size) break;                // 越界 = 目录表结束
        entries.push({ name, size, offset });
      }
      return { entries };
    } finally { fs.closeSync(fd); }
  } catch (e) { return null; }
}

/** 从容器中提取条目到目标路径，返回提取字节数。 */
function extractEntry(containerPath, entry, dest) {
  const fd = fs.openSync(containerPath, 'r');
  try {
    const buf = Buffer.alloc(Math.min(entry.size, 1 << 20));
    const out = fs.openSync(dest, 'w');
    let total = 0;
    try {
      while (total < entry.size) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, entry.size - total), entry.offset + total);
        if (n <= 0) break;
        fs.writeSync(out, buf, 0, n, total);
        total += n;
      }
    } finally { fs.closeSync(out); }
    return total;
  } finally { fs.closeSync(fd); }
}

// 音频块交织粒度：L/R 两路 mp3 按 1024 字节块交替存放（L/R 条目指向同一块），
// 已实测验证：按 1024 拆流后两路均为完整可解码 mp3（时长一致、零解码错误）
const LS_INTERLEAVE = 1024;

/** 交织双流拆分：从音频块提取一路（even=L 声道流，odd=R 声道流）。
 *  注意：条目 size 是单流的字节数，实际存储为双流交织块，一直延伸到容器末尾，
 *  所以读到文件尾而不是 offset+size（实测只读一半会得到时长减半的流）。 */
function extractInterleavedStream(containerPath, entry, dest, which) {
  const end = fs.statSync(containerPath).size;
  const fd = fs.openSync(containerPath, 'r');
  const out = fs.openSync(dest, 'w');
  try {
    const buf = Buffer.alloc(LS_INTERLEAVE);
    let total = 0;
    for (let pos = entry.offset; pos + LS_INTERLEAVE <= end; pos += LS_INTERLEAVE * 2) {
      const src = pos + (which === 'odd' ? LS_INTERLEAVE : 0);
      const n = fs.readSync(fd, buf, 0, LS_INTERLEAVE, src);
      if (n <= 0) break;
      fs.writeSync(out, buf, 0, n, total);
      total += n;
    }
    return total;
  } finally { fs.closeSync(out); fs.closeSync(fd); }
}

/**
 * 下载产物统一处理入口（.ts 明文 / .ts 加密 / .ls 加密容器）。
 * @param {string} input 下载的临时文件路径
 * @param {object} opts outTs(明文 TS 落点) / outMp3(原唱 mp3 落点) /
 *   outLrc(歌词 utf8 lrc 落点) / accomp(1=原唱在R，2=原唱在L，来自 muse.db)
 * @returns {type:'plain',path} 未加密直接可用
 *          {type:'ts',path}    解密后的明文 TS
 *          {type:'audio',mp3,lrc}  容器解出的原唱 mp3（+可选 lrc）
 */
async function processDownload(input, opts = {}) {
  if (!isEncryptedPath(input)) return { type: 'plain', path: input };
  const dec = input + '.dec';
  await decryptFile(input, dec);
  const head = Buffer.alloc(1);
  const fd = fs.openSync(dec, 'r');
  fs.readSync(fd, head, 0, 1, 0);
  fs.closeSync(fd);
  if (head[0] === 0x47) {
    // 明文 TS
    if (opts.outTs) { fs.renameSync(dec, opts.outTs); return { type: 'ts', path: opts.outTs }; }
    return { type: 'ts', path: dec };
  }
  const c = parseContainer(dec);
  if (!c) { try { fs.unlinkSync(dec); } catch (e) {} throw new Error('.ls 解密结果无法识别（未知容器格式）'); }
  const out = { type: 'audio' };
  const audio = c.entries.find((e) => /\.mp3$/i.test(e.name));
  if (audio && opts.outMp3) {
    extractInterleavedStream(dec, audio, opts.outMp3, Number(opts.accomp) === 2 ? 'even' : 'odd');
    out.mp3 = opts.outMp3;
  }
  const txt = c.entries.find((e) => /\.txt$/i.test(e.name));
  if (txt && opts.outLrc) {
    const raw = Buffer.alloc(txt.size);
    const f2 = fs.openSync(dec, 'r');
    fs.readSync(f2, raw, 0, txt.size, txt.offset);
    fs.closeSync(f2);
    let text;
    try { text = new TextDecoder('gbk').decode(raw); } catch (e) { text = raw.toString('latin1'); }
    fs.writeFileSync(opts.outLrc, text.replace(/\r\n/g, '\n'), 'utf8');
    out.lrc = opts.outLrc;
  }
  try { fs.unlinkSync(dec); } catch (e) {}
  return out;
}

module.exports = { isEncryptedPath, decryptFile, parseContainer, extractEntry, processDownload, KEY_TABLES };
