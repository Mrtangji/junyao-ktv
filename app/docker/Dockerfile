# Node 22（2026-09）：TLS 指纹伪装实验的一部分——Node 20 与桌面版 Electron 的
# 传输层指纹差异被怀疑是中转风控"block ip"的触发点之一，升级基础镜像改变
# OpenSSL/TLS栈版本；配合 lxmusic.js 的 Chrome 套件顺序伪装一起验证。
FROM node:22-bookworm-slim

# better-sqlite3 编译依赖 + ffmpeg（Bug修复：双音轨MV切换原唱/伴唱需要用它按需
# 提取指定音轨，浏览器的 HTMLMediaElement.audioTracks 在本应用运行的浏览器内核里
# 并未真正实现，js 端永远拿不到第二条音轨，必须由服务端来做）。
#
# 硬件转码修复：只把宿主机的 /dev/dri 设备节点映射进容器还不够，ffmpeg 调用
# h264_vaapi 依赖的是用户态的 VAAPI 驱动库(libva)和具体厂商的硬件驱动实现，
# 这些是软件层面的东西，必须装在镜像里：
#   - libva2/libva-drm2  ：VAAPI 运行时库
#   - va-driver-all      ：元包，自动装好 Intel(iHD/i965)、AMD/Mesa(radeonsi)
#                          等常见核显/独显的 VAAPI 驱动实现，不用去猜宿主机
#                          用的是哪一家硬件
#   - vainfo             ：诊断工具，用于确认容器内能否看到并枚举硬件能力
# 没有这些库的话，即使 /dev/dri 设备本身能访问，h264_vaapi 初始化也会直接
# 失败——不过这属于代码里已经处理的"VAAPI 不可用"情形，会自动回退到
# libx264 软件编码，不会导致转码彻底失败。
RUN apt-get update && apt-get install -y \
      python3 make g++ ffmpeg \
      libva2 libva-drm2 va-driver-all vainfo \
    && rm -rf /var/lib/apt/lists/*

# curl-impersonate（Chrome 补丁版 curl）：完整复刻 Chromium 的 TLS ClientHello
# （GREASE、扩展顺序、套件顺序、ALPN）——Node 的 OpenSSL 做不到的部分由它补齐，
# 用于音源脚本对中转/平台的 HTTPS 请求（lxmusic.js 自动探测，缺失时回落 Node）。
# 仅 x86_64（N100 适用）；下载失败不阻塞构建（运行时自动回落）。
RUN curl -fsSL --retry 3 \
      https://github.com/lwthiker/curl-impersonate/releases/download/v0.6.1/curl-impersonate-v0.6.1.x86_64-linux-gnu.tar.gz \
      | tar xz -C /usr/local/bin \
    && chmod +x /usr/local/bin/curl_chrome* /usr/local/bin/curl-impersonate-* 2>/dev/null || true

WORKDIR /app

COPY server/package.json ./
RUN npm install --omit=dev

COPY server ./server
COPY web ./web
# 服务端版本号（人类可读的发布号）。放在这里而不是 git tag，是为了让"没打
# tag 的 main 构建"也有稳定版本号；真正的构建凭据是下面的 BUILD_SHA/BUILD_TIME。
COPY VERSION ./VERSION

# 麦动曲库 muse.db（约1GB，67万首）：git 放不下（GitHub 单文件限100MB），由 CI
# 在构建前从 GitHub Release(muse-db 标签) 下载 muse.db.gz 解压到 vendor/。
# 服务端未配置 md_muse_url 且 /data/muse.db 不存在时自动使用它（server/muse.js）。
COPY vendor/muse.db /app/vendor/muse.db

ENV DATA_DIR=/data
ENV MV_DIR=/mv
ENV PORT=8080

# ---- 构建版本信息（由 CI 通过 --build-arg 传入，见 docker-publish.yml）----
# 镜像 tag 永远叫 latest，看不出是哪一次构建；commit sha + 构建时间才能和
# GitHub 上的提交对齐，用来回答"服务器上跑的是不是最新版"。
# 这些 ARG/ENV 故意放在最后一层：sha 每次提交都变，放在前面会让 apt/npm 这些
# 重活层的缓存全部失效。
# 未传参时留空，服务端 server/version.js 会自动回落到 /app/VERSION 文件。
ARG APP_VERSION=
ARG BUILD_SHA=
ARG BUILD_TIME=
ARG BUILD_REF=
ARG BUILD_REPO=Mrtangji/junyao-ktv
ENV APP_VERSION=${APP_VERSION} \
    BUILD_SHA=${BUILD_SHA} \
    BUILD_TIME=${BUILD_TIME} \
    BUILD_REF=${BUILD_REF} \
    BUILD_REPO=${BUILD_REPO}

EXPOSE 8080
VOLUME ["/data", "/mv"]

CMD ["node", "server/index.js"]
