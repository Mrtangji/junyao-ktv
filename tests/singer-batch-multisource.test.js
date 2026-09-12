// 回归测试：歌手批量下载「对齐 lx 版」的四项做法——多音源合并、只收无损、
// 翻页开关、音源级节流。
//
// 跑法（仓库根目录或本目录均可）：
//   NODE_PATH='C:\Users\Administrator\.workbuddy\binaries\node\workspace\node_modules' \
//   node tests/singer-batch-multisource.test.js
//
// 原理：require 真实模块，只把 boardsdk.search 换成假实现（记录调用、返回构造数据），
// 于是"合并去重/筛选/翻页/节流"这些真实逻辑都被跑到，且不联网。
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

const SERVER_DIR = path.join(__dirname, '..', 'app', 'docker', 'server');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmul-'));
process.env.DATA_DIR = tmp;
process.env.MV_DIR = path.join(tmp, 'mv');
process.env.MP3_DIR = path.join(tmp, 'mv');
fs.mkdirSync(process.env.MV_DIR, { recursive: true });

const boardsdk = require(path.join(SERVER_DIR, 'boardsdk'));
const sb = require(path.join(SERVER_DIR, 'singer-batch'));
const { collectSinger, collectFromSource, hasLossless, typesSayNoLossless, buildFilterRegs } = sb._internals;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`); };
const song = (over = {}) => ({
  songmid: 'm1', name: '晴天', singer: '周杰伦', duration: 269, types: ['flac'], src: 'kw', ...over,
});
// 收集选项：默认不限时长、不过滤词、翻页开启
const OPTS = (over = {}) => ({ filterRegs: [], minDur: 0, maxDur: 0, sqOnly: false, autoPage: true, preferLossless: true, ...over });

(async () => {
  console.log('=== A. 音质标注解析（boardsdk 统一成 types）===');
  {
    const Q = boardsdk._qualityTypes;
    ok('酷狗：SQFileSize>0 → flac，Res/Super → flac24bit',
      JSON.stringify(Q.kg({ SQFileSize: 31633244, HQFileSize: 10792943, FileSize: 4317292 }).slice(0, 2)) === '["flac","320k"]' &&
      JSON.stringify(Q.kg({ SuperFileSize: 1 })) === '["flac24bit"]');
    ok('酷狗：字段全空 → 空数组（未标注）', Q.kg({}).length === 0);
    ok('QQ：size_flac>0 → flac，size_hires>0 → flac24bit',
      JSON.stringify(Q.tx({ size_flac: 1, size_320mp3: 1 })) === '["flac","320k"]' &&
      JSON.stringify(Q.tx({ size_hires: 1 })) === '["flac24bit"]');
    ok('QQ：无 file → 空数组', Q.tx(undefined).length === 0);
    ok('网易云：privilege.maxbr=999000 → flac', JSON.stringify(Q.wy({ privilege: { maxbr: 999000 } })) === '["flac","320k","128k"]');
    ok('网易云：maxbr=320000 → 只有有损', JSON.stringify(Q.wy({ privilege: { maxbr: 320000 } })) === '["320k","128k"]');
    ok('网易云：老接口 sq 对象 → flac', JSON.stringify(Q.wy({ sq: { size: 1 }, h: { size: 1 } })) === '["flac","320k"]');
    ok('flac24bit 也算无损', hasLossless(['flac24bit']) === true);
    ok('只有 320k/128k → 判无无损', typesSayNoLossless({ types: ['320k', '128k'] }) === true);
    ok('未标注音质（空数组）→ 不判无无损', typesSayNoLossless({ types: [] }) === false);
    ok('未标注音质（undefined）→ 不判无无损', typesSayNoLossless({}) === false);
    ok('320k+flac 混合 → 不判无无损', typesSayNoLossless({ types: ['320k', 'flac'] }) === false);
  }

  console.log('=== B. 多音源合并：四家搜完合并去重，单家抽风不影响其它 ===');
  {
    const calls = [];
    boardsdk.search = async (src, q, page, limit) => {
      calls.push(`${src}#${page}`);
      if (src === 'kw') return { list: [song({ songmid: 'kw1', types: ['320k'] })], total: 1, page, limit };
      if (src === 'wy') return { list: [song({ songmid: 'wy1', src: 'wy', types: ['flac'] })], total: 1, page, limit };
      if (src === 'tx') throw new Error('接口抽风');
      return { list: [song({ songmid: 'kg1', src: 'kg', name: '七里香', types: ['flac24bit'] })], total: 1, page, limit };
    };
    const songs = await collectSinger('周杰伦', 'all', OPTS());
    ok('四家都被搜到（tx 失败也照搜）', calls.filter((c, i, a) => a.indexOf(c) === i).length === 4, calls.join(' '));
    ok('跨源按「歌名+歌手」去重后 2 首（晴天/七里香）', songs.length === 2, JSON.stringify(songs.map(s => s.name + '@' + s.src)));
    const qing = songs.find(s => s.name === '晴天');
    ok('同一首歌多家都有 → 保留标注有无损的那条', qing && qing.src === 'wy', qing && qing.src);
    ok('换源时优先无损源，且不丢只在一家出现的歌', !!songs.find(s => s.name === '七里香'));
  }

  console.log('=== C. 只收无损：平台明确标注无无损 → 收集阶段就跳过 ===');
  {
    boardsdk.search = async (src, q, page, limit) => ({
      list: [
        song({ songmid: 'a', name: '只有320K', types: ['320k', '128k'] }),
        song({ songmid: 'b', name: '没标注', types: [] }),
        song({ songmid: 'c', name: '有无损', types: ['flac'] }),
      ], total: 3, page, limit,
    });
    const off = await collectFromSource('周杰伦', 'kw', OPTS({ sqOnly: false, autoPage: false }));
    ok('未开只收无损 → 三首都收', off.length === 3, String(off.length));
    const on = await collectFromSource('周杰伦', 'kw', OPTS({ sqOnly: true, autoPage: false }));
    ok('开了只收无损 → 跳过硬标注无无损的那首', on.length === 2 && !on.find(s => s.name === '只有320K'), on.map(s => s.name).join('/'));
    ok('未标注音质的歌保留（交给下载时兜底判定）', !!on.find(s => s.name === '没标注'));
  }

  console.log('=== D. 翻页开关 + 音源级节流 ===');
  {
    let pages = 0;
    const times = [];
    boardsdk.search = async (src, q, page, limit) => {
      pages++; times.push(Date.now());
      // 第 1 页给满（30 条），第 2 页给 2 条 → 自然结束
      const n = page === 1 ? 30 : 2;
      const list = Array.from({ length: n }, (_, i) => song({ songmid: `p${page}_${i}`, name: `歌 ${page}-${i}` }));
      return { list, total: 90, page, limit };
    };
    pages = 0; times.length = 0;
    const one = await collectFromSource('周杰伦', 'kw', OPTS({ autoPage: false }));
    ok('autoPage=false → 只请求 1 次（不翻页）', pages === 1 && one.length === 30, `pages=${pages} n=${one.length}`);
    pages = 0; times.length = 0;
    const all = await collectFromSource('周杰伦', 'kw', OPTS({ autoPage: true }));
    ok('autoPage=true → 翻到第 2 页', pages === 2 && all.length === 32, `pages=${pages} n=${all.length}`);
    const gap = times.length > 1 ? times[1] - times[0] : 0;
    ok('同音源两次请求间隔 ≥350ms（音源级节流）', gap >= 350, `${gap}ms`);
  }

  console.log('=== E. 过滤词/时长规则不被改动破坏 ===');
  {
    const regs = buildFilterRegs('现场,live,+');
    ok('中文子串匹配命中「演唱会现场版」', regs.some(r => r.test('演唱会现场版')));
    ok('英文词边界：live 命中 Live 版', regs.some(r => r.test('歌曲 Live')));
    ok('英文词边界：不误杀 Oliver', !regs.some(r => r.test('Oliver')));
    const words = sb.DEFAULT_FILTER_WORDS;
    ok('过滤词已补 KTV 厂商词（麦颂/雷石/视易/海媚/音创）',
      ['麦颂', '雷石', '视易', '星网视易', '阳光视翰', '海媚', '音创', '巨嗨', '雷客', '音王'].every(w => words.includes(w)));
    boardsdk.search = async (src, q, page, limit) => ({
      list: [song({ songmid: 'x', name: '正常歌', duration: 300 }), song({ songmid: 'y', name: '短歌', duration: 30 })],
      total: 2, page, limit,
    });
    const r = await collectFromSource('周杰伦', 'kw', OPTS({ autoPage: false, minDur: 60 }));  // 1 分钟下限
    ok('时长下限按「分钟→秒」换算生效（30 秒的被滤掉）', r.length === 1 && r[0].name === '正常歌', r.map(x => x.name).join('/'));
  }

  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();
