FROM node:20-bookworm-slim

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

WORKDIR /app

COPY server/package.json ./
RUN npm install --omit=dev

COPY server ./server
COPY web ./web

# 麦动曲库 muse.db（约1GB，67万首）：git 放不下（GitHub 单文件限100MB），由 CI
# 在构建前从 GitHub Release(muse-db 标签) 下载 muse.db.gz 解压到 vendor/。
# 服务端未配置 md_muse_url 且 /data/muse.db 不存在时自动使用它（server/muse.js）。
COPY vendor/muse.db /app/vendor/muse.db

ENV DATA_DIR=/data
ENV MV_DIR=/mv
ENV PORT=8080

EXPOSE 8080
VOLUME ["/data", "/mv"]

CMD ["node", "server/index.js"]
