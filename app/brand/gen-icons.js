#!/usr/bin/env node
/**
 * 品牌图标生成器 —— 唯一设计源，一次生成所有尺寸的图标。
 *
 * 设计：品牌渐变（紫 #c736f7 → 青 #36d9f7）圆角方块 + 几何粗体白色 K。
 * K 用三条圆头描边构成（竖笔 + 上臂 + 下腿）。描边宽度(66)与占幅是按
 * 16px favicon 调过的：太细则小尺寸糊成一团，太粗则中缝三角缺口会闭合。
 *
 * 产出：
 *   app/docker/web/assets/        → favicon.svg / favicon.ico / apple-touch-icon.png
 *                                    icon-192.png / icon-512.png / site.webmanifest
 *   android/app/src/main/res/     → mipmap-*dpi/ic_launcher(.round).png（API<26 传统图标）
 *                                    mipmap-anydpi-v26/*.xml + drawable-*dpi/ic_launcher_{background,foreground}.png
 *                                    （API26+ 自适应图标，含 Android13 主题图标单色层）
 *   ICON.PNG / ICON_256.PNG       → 仓库根品牌导出图
 *
 * 运行：
 *   NODE_PATH="<node-ws>/node_modules" node app/brand/gen-icons.js
 * 依赖 sharp（SVG 光栅化）：
 *   npm i sharp   （装到 workbuddy 托管 node 工作区即可，见 NODE_PATH）
 */
'use strict';
const fs = require('fs');
const path = require('path');

let sharp;
try {
  sharp = require('sharp');
} catch (e) {
  console.error([
    '',
    '缺少依赖 sharp（用于把 SVG 光栅化成 PNG/ICO）。',
    'sharp 不随仓库分发，需装到 node 工作区后通过 NODE_PATH 引入：',
    '  1) cd <node 工作区> && npm i sharp',
    '  2) NODE_PATH=<node 工作区>/node_modules node app/brand/gen-icons.js',
    '',
  ].join('\n'));
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '../..');
const BRAND_DIR = __dirname;
const WEB_ASSETS = path.join(ROOT, 'app/docker/web/assets');
const ANDROID_RES = path.join(ROOT, 'android/app/src/main/res');

// ---------------------------------------------------------------- DESIGN
const C_DEEP = '#8a1ee0';   // 渐变起点：深紫
const C_ACCENT = '#c736f7'; // 品牌主色（与 web 端 --accent 一致）
const C_CYAN = '#36d9f7';   // 渐变终点（与 web 端 --cyan 一致）
const THEME_COLOR = C_ACCENT;

/** K 的三条描边（坐标基于 512 画布） */
const K_STROKES = [
  'M 168 112 L 168 400',   // 竖笔
  'M 356 112 L 168 256',   // 上臂
  'M 192 268 L 366 400',   // 下腿
];
const K_WIDTH = 66;          // 描边宽度
// K 的实际包围盒（含圆头端点），由几何推算得出，供自适应图标居中/定尺用
const K_BBOX = { x0: 135, y0: 79, x1: 392.3, y1: 433, w: 257.3, h: 354 };

const GRAD_DEFS = `
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${C_DEEP}"/>
      <stop offset="0.48" stop-color="${C_ACCENT}"/>
      <stop offset="1" stop-color="${C_CYAN}"/>
    </linearGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.26"/>
      <stop offset="0.55" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>`;

function kGroup(extraAttrs = '') {
  const paths = K_STROKES.map(d => `    <path d="${d}"/>`).join('\n');
  return `<g ${extraAttrs}fill="none" stroke="#ffffff" stroke-width="${K_WIDTH}" stroke-linecap="round">\n${paths}\n  </g>`;
}

/** 主图标：圆角方块 + K（用于 favicon / apple-touch-icon / 传统 mipmap / 商店图） */
function svgIcon(radius = 116) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="骏耀K歌">
  <title>骏耀K歌</title>
  <defs>${GRAD_DEFS}
    <clipPath id="clip"><rect width="512" height="512" rx="${radius}"/></clipPath>
  </defs>
  <g clip-path="url(#clip)">
    <rect width="512" height="512" fill="url(#bg)"/>
    <rect width="512" height="300" fill="url(#gloss)"/>
  </g>
  ${kGroup()}
</svg>
`;
}

/** 圆形图标：给 Android 7 及以下的 ic_launcher_round 用 */
function svgRound() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="骏耀K歌">
  <defs>${GRAD_DEFS}
    <clipPath id="clip"><circle cx="256" cy="256" r="256"/></clipPath>
  </defs>
  <g clip-path="url(#clip)">
    <rect width="512" height="512" fill="url(#bg)"/>
    <rect width="512" height="300" fill="url(#gloss)"/>
  </g>
  ${kGroup()}
</svg>
`;
}

/** 自适应图标背景层：满幅渐变（108dp 画布，无圆角，交给系统裁剪） */
function svgAdaptiveBg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="108" height="108">
  <defs>${GRAD_DEFS}</defs>
  <rect width="108" height="108" fill="url(#bg)"/>
  <rect width="108" height="63" fill="url(#gloss)"/>
</svg>
`;
}

/**
 * 自适应图标前景层：只有 K，居中且限制在安全区内。
 *
 * Android 自适应图标两层都是 108dp，但只有**中心 72dp** 会出现在蒙版视口里
 * （外圈 18dp 留作蒙版/视差余量）。所以这里让 K 的包围盒高 = 48dp：
 * 相对可见区 72dp 约 67%，与主图标里 K 占 69% 的观感一致；
 * 同时 48dp 远小于安全区圆（66dp 直径），圆形蒙版下也不会被切到。
 */
function svgAdaptiveFg() {
  const s = 48 / K_BBOX.h;
  const cx = (K_BBOX.x0 + K_BBOX.x1) / 2;   // K 包围盒中心（512 空间）
  const cy = (K_BBOX.y0 + K_BBOX.y1) / 2;
  const tf = `transform="translate(54 54) scale(${s.toFixed(6)}) translate(${-cx.toFixed(2)} ${-cy.toFixed(2)})" `;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="108" height="108">
  ${kGroup(tf)}
</svg>
`;
}

// ------------------------------------------------------------- 工具函数
/** 把 SVG 光栅化成 size×size PNG。先按目标 3~8 倍渲染再缩放，得到干净的抗锯齿边缘。 */
async function raster(svg, svgPx, size) {
  const factor = size <= 64 ? 8 : 3;
  const density = Math.ceil((72 * size * factor) / svgPx);
  return sharp(Buffer.from(svg), { density })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
}

function write(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  console.log(`  ${rel}${Buffer.isBuffer(buf) ? `  (${(buf.length / 1024).toFixed(1)} KB)` : ''}`);
}

/** 组装多尺寸 ICO。Vista+ 的 ICO 允许每帧直接放 PNG，省去 BMP 调色板那套。 */
function buildIco(frames) {
  const n = frames.length;
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);  // reserved
  head.writeUInt16LE(1, 2);  // type = icon
  head.writeUInt16LE(n, 4);  // count
  const entries = [];
  let offset = 6 + n * 16;
  for (const { size, buf } of frames) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);  // 256 用 0 表示
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);   // 调色板数
    e.writeUInt8(0, 3);   // reserved
    e.writeUInt16LE(1, 4);   // color planes
    e.writeUInt16LE(32, 6);  // bpp
    e.writeUInt32LE(buf.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += buf.length;
  }
  return Buffer.concat([head, ...entries, ...frames.map(f => f.buf)]);
}

// ------------------------------------------------------------------ MAIN
(async () => {
  const icon = svgIcon();
  const round = svgRound();
  const adBg = svgAdaptiveBg();
  const adFg = svgAdaptiveFg();

  console.log('\n[master] 写入设计源 SVG');
  write(path.join(BRAND_DIR, 'logo.svg'), icon);
  write(path.join(BRAND_DIR, 'logo-round.svg'), round);

  console.log('\n[web] 浏览器图标 → app/docker/web/assets/');
  write(path.join(WEB_ASSETS, 'favicon.svg'), icon);
  const icoSizes = [16, 32, 48];
  const icoFrames = [];
  for (const s of icoSizes) icoFrames.push({ size: s, buf: await raster(icon, 512, s) });
  write(path.join(WEB_ASSETS, 'favicon.ico'), buildIco(icoFrames));
  for (const [name, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
    write(path.join(WEB_ASSETS, name), await raster(icon, 512, size));
  }
  write(path.join(WEB_ASSETS, 'site.webmanifest'), Buffer.from(JSON.stringify({
    name: '骏耀K歌', short_name: '骏耀K歌', start_url: '/tv/', scope: '/',
    display: 'standalone', background_color: '#07071a', theme_color: THEME_COLOR,
    icons: [
      { src: '/assets/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/assets/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/assets/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }, null, 2) + '\n'));

  console.log('\n[android] 传统图标（API<26）→ android/app/src/main/res/mipmap-*dpi/');
  const LEGACY = [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]];
  for (const [dpi, size] of LEGACY) {
    write(path.join(ANDROID_RES, `mipmap-${dpi}/ic_launcher.png`), await raster(icon, 512, size));
    write(path.join(ANDROID_RES, `mipmap-${dpi}/ic_launcher_round.png`), await raster(round, 512, size));
  }

  console.log('\n[android] 自适应图标素材（API26+）→ drawable-*dpi/');
  const ADAPTIVE = [['mdpi', 108], ['hdpi', 162], ['xhdpi', 216], ['xxhdpi', 324], ['xxxhdpi', 432]];
  for (const [dpi, size] of ADAPTIVE) {
    write(path.join(ANDROID_RES, `drawable-${dpi}/ic_launcher_background.png`), await raster(adBg, 108, size));
    write(path.join(ANDROID_RES, `drawable-${dpi}/ic_launcher_foreground.png`), await raster(adFg, 108, size));
  }

  console.log('\n[android] 自适应图标描述文件 → mipmap-anydpi-v26/');
  const adaptiveXml = `<?xml version="1.0" encoding="utf-8"?>
<!-- 自适应图标：背景=品牌渐变（满幅），前景=居中的 K（限制在中心 66dp 安全区内）。
     API<26 的机器不走这里，用的是 mipmap-*dpi/ic_launcher.png。
     monochrome 是 Android 13+ 的"主题图标"单色层，取前景的 alpha 由系统着色。 -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background"/>
    <foreground android:drawable="@drawable/ic_launcher_foreground"/>
    <monochrome android:drawable="@drawable/ic_launcher_foreground"/>
</adaptive-icon>
`;
  write(path.join(ANDROID_RES, 'mipmap-anydpi-v26/ic_launcher.xml'), Buffer.from(adaptiveXml));
  write(path.join(ANDROID_RES, 'mipmap-anydpi-v26/ic_launcher_round.xml'), Buffer.from(adaptiveXml));

  console.log('\n[repo] 品牌导出图 → 仓库根');
  write(path.join(ROOT, 'ICON.PNG'), await raster(icon, 512, 64));
  write(path.join(ROOT, 'ICON_256.PNG'), await raster(icon, 512, 256));

  console.log('\n完成。\n');
})().catch(e => { console.error('生成失败：', e); process.exit(1); });
