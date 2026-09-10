# 骏耀K歌（junyao-ktv）

局域网 K 歌系统 —— 手机扫码点歌，电视/投影仪大屏沉浸演唱。

一台服务器 + 一块大屏，局域网内所有设备扫码即可点歌、切歌、调音，无需额外硬件，无需公网，开箱即用。

---

## ✨ 功能特性

- **手机扫码点歌**：无需安装 App，扫码即可搜索歌曲、点歌、管理已点队列
- **大屏播放主页面**：支持三套视觉风格（简约卡片 / 暗夜霓虹 / 3D 轮播大屏），设置菜单三风格统一交互
- **多端角色管理**：局域网内任意设备可申请「播放端」或「控制端」角色，播放端可上锁防误抢，控制端遥控播放端的暂停/切歌/音量/全屏等操作
- **原唱 / 伴唱切换**：基于双音轨 MV 服务端按需提取，浏览器端无需支持多音轨即可切换
- **均衡器**：标准 / 人声增强 / 低音增强 / 明亮清晰等预设音效
- **曲库管理**：支持本地目录与网盘挂载目录混合曲库，后台可视化管理来源、批量清理孤儿曲目、文件名智能解析、歌手头像自动匹配
- **音频与 LRC 歌词**：支持扫描 `.mp3` 与无损/常见音频（`.flac` `.wav` `.m4a` `.aac` `.ogg` `.opus`）；与歌曲同名的 `.lrc` 文件会自动关联，电视端播放音频时按时间高亮显示上一句、当前句和下一句
- **硬件转码**：自动探测并使用 VAAPI（Intel/AMD 核显）或 NVENC（NVIDIA 显卡）硬件加速转码，无对应硬件时自动回退软件编码
- **管理后台**：曲库来源管理、终端设备管理、转码缓存清理策略配置，全部网页端可视化操作
- **Android 客户端**：面向电视盒子/投影仪场景的原生客户端，功能与网页大屏端对齐

---

## 🖥️ 系统组成

| 端 | 地址 | 说明 |
|---|---|---|
| 大屏播放主页面 | `/tv` | 电视/投影仪打开，K歌主界面 |
| 手机遥控端 | `/m` | 手机扫码打开，点歌与遥控 |
| 管理后台 | `/admin` | 曲库、设备、缓存等后台管理 |
| Android 客户端 | 见 `android/` | 电视盒子原生播放端，功能对齐网页 `/tv`；APK 由 CI 构建（Actions 产物 `junyao-ktv-apk`，或打 tag 时发布到 Release） |

浏览器打开服务器地址（如 `http://局域网IP:8080`）会看到一个导航首页，三个入口一目了然。

---

## 🚀 快速开始

只需 Docker，无需手动安装 Node.js / ffmpeg 等依赖。

### 1. 准备 `docker-compose.yaml`

```yaml
services:
  junyao-ktv:
    image: ma303973022/junyao-ktv:1.2.0
    container_name: junyao-ktv
    restart: unless-stopped
    ports:
      - "8080:8080"          # 访问端口：http://局域网IP:8080
      - "8443:8443"          # 不要删！自签 HTTPS，唱歌评分(麦克风)必须有这个口
    environment:
      - TZ=Asia/Shanghai
      - PORT=8080
      - HTTPS_PORT=8443      # 与上面的 8443 对应
      - DATA_DIR=/data
      - ADMIN_PASSWORD=admin888          # 管理后台("/admin")登录密码，建议改掉
      - VAAPI_DEVICE=/dev/dri/renderD128 # 核显硬件转码用，没有核显就删掉这行
      - HLS_CACHE_MAX_AGE_DAYS=3         # 转码缓存超过几天没人点就自动清理
      # 用 NVIDIA 显卡转码(NVENC)就取消下面两行注释，同时取消最下面 runtime: nvidia 的注释
      # - NVIDIA_VISIBLE_DEVICES=all
      # - NVIDIA_DRIVER_CAPABILITIES=compute,video,utility
    volumes:
      - /path/to/your/data:/data                 # 应用数据(数据库、封面等)，必须挂载

      # 曲库挂载：按需增删，本地曲库挂到 /mv/<自定义名>，网盘曲库挂到 /mv-net/<自定义名>
      - /path/to/local/library1:/mv/library1
      - /path/to/local/library2:/mv/library2
      - /path/to/netdisk/library:/mv-net/netdisk1
      - /path/to/singer/avatars:/singer           # 歌手头像目录，图片名对应歌手名，如 周杰伦.jpg
      # 挂载完成后，还需要去后台「曲库管理→曲库来源」里把新目录逐个启用，才会真正参与扫描
    devices:
      - /dev/dri:/dev/dri     # 核显硬件转码用，没有核显就删掉这行
    # runtime: nvidia         # 用 NVIDIA 显卡转码时取消注释(同时打开上面两行 NVIDIA 环境变量)
```


### 2. 启动

```bash
docker compose up -d
```

### 3. 访问

浏览器打开 `http://局域网IP:8080`，或直接访问 `/tv`（大屏）、`/m`（手机点歌）、`/admin`（管理后台）。

### 4. 曲库配置

进入「管理后台 → 曲库管理」，将挂载进容器的目录逐个启用为曲库来源，保存后即会自动扫描曲库，无需重建容器。

### 5. 音频与 LRC 歌词格式

将音频和歌词放在同一目录，并保持文件名主体一致：

```text
/mv/library1/周杰伦 - 晴天.mp3
/mv/library1/周杰伦 - 晴天.lrc
```

重新扫描后，音频文件会进入曲库。除 `.mp3` 外，**无损 `.flac` / `.wav`** 与 `.m4a` `.aac` `.ogg` `.opus` 也一并支持（曲库列表里无损文件带「无损」角标）。LRC 支持标准时间标签，例如 `[00:12.50]歌词内容`；一行包含多个时间标签、UTF-8 BOM 和大小写 `.LRC` 后缀也可以正常识别。**纯音频文件由播放端直传原文件、服务端零转码**——无损 `.flac`/`.wav` 与 320K `.mp3` 都是原汁原味，不会被压成 AAC 192K；只有 MV 走 HLS（需要视频轨和原/伴唱双音轨切换），极少见的多音轨音频也仍走 HLS 以保留切轨能力。若播放内核不认识某格式会自动回落 HLS，保证有声音优先。电视端显示同步歌词；没有 LRC 时仍可正常播放并显示“暂无 LRC 歌词”。

在线下载同样支持无损：管理后台「歌手批量下载」的下载格式选 **无损 FLAC**（电视端设置里的「点唱榜下载格式」会在 MP3 → FLAC → MV 之间循环），会先向音源请求 flac 音质，拿到无损就原样保存为 `.flac`（不转码），音源确实没有无损时自动回落 320K MP3。

---

## 🎤 唱歌评分（麦克风）

**安卓客户端不需要 HTTPS**：App 里用系统原生接口（`AudioRecord`）直接采集麦克风，音高在 App 内算好后再送进页面，完全不走浏览器的 `getUserMedia`，所以局域网 HTTP、老 WebView 内核都能正常评分。

**浏览器端（手机扫码 / 电脑）绕不过 HTTPS**：`getUserMedia` 只在「安全上下文」开放（`https://`、`http://localhost`、`http://127.0.0.1`、`file://`），这是浏览器内核级的安全策略，页面无法申请例外。

- 浏览器请打开 `https://局域网IP:8443/tv`（自签证书会报警告，点「高级 → 继续访问」即可）
- compose 里务必保留 `8443:8443` 映射：只映射 8080 的话，8443 在容器外不可达，**网页端的评分用不了**
- 评分参考曲线由服务端从原唱音轨提取，所以**本地模式（没连服务器）下评分不可用**，界面会直接说明

---

## ⚙️ 硬件转码

- **Intel / AMD 核显**：挂载 `/dev/dri` 设备节点即可自动启用 VAAPI 硬件转码
- **NVIDIA 显卡**：需安装 [nvidia-container-toolkit](https://github.com/NVIDIA/nvidia-container-toolkit)，并在 compose 中启用 `runtime: nvidia`
- 无对应硬件时自动回退到 CPU 软件转码，不影响正常使用
- **转码不降品质**：视频源是 H.264、音轨是 AAC 时一律直接封装拷贝（零转码）；确实需要重编码时按恒定 QP 22（≈CRF 20）出 H.264、AAC 320k 出音轨，硬件编码也显式指定同等质量参数，不会用编码器默认的低码率糊掉画质

---

## 🛠️ 技术栈

- **服务端**：Node.js + Express + WebSocket + better-sqlite3 + ffmpeg（HLS 转码）
- **前端**：原生 HTML/CSS/JS，无框架依赖，多主题风格通过 CSS 变量 + 状态属性驱动
- **客户端**：Android（Kotlin）
- **部署**：Docker / Docker Compose，支持 x86_64 与 aarch64 多架构镜像

---

## 📄 License

本项目仅供个人学习与局域网自用场景使用。

---

作者：清风渡客
