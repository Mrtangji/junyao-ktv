// MP3/MV 网络下载存储目录配置（纯环境变量，容器启动时确定）。
// 点唱榜/搜索下载的歌默认存 MV_DIR（docker-compose 挂载的 /mv，按歌手分子目录）；
// 若 MP3 与 MV 分开存放（如 MV 在 /mv、MP3+LRC 在 /mp3），在 docker-compose 里设
// 环境变量 MP3_DIR=/mp3 并挂载对应目录即可，不提供网页设置项。
//
// 曲库扫描会同时覆盖 MV_DIR 与 MP3_DIR（互不包含时），LRC 歌词与 MP3 同目录
// 放置（歌手/歌手 - 歌名.lrc），扫描时自动关联入库。
const path = require('path');

const MV_DIR = process.env.MV_DIR || '/mv';
const MP3_DIR = process.env.MP3_DIR || MV_DIR;

// 实际生效的下载目录（下载落盘、扫描曲库都用它）
function getMp3Dir() {
  return path.resolve(MP3_DIR);
}

module.exports = { MV_DIR, MP3_DIR, getMp3Dir };
