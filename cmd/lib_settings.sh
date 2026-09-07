#!/bin/bash
# 共用函数：目前只保留「应用数据 / MV 曲库固定路径」相关的小工具函数。
#
# 端口已取消自定义功能，固定使用 8080（写死在 docker-compose.yml 里，见
# app/docker/docker-compose.yml），生命周期脚本不需要再处理端口。
#
# 管理员密码也已不再经由安装/升级/配置向导收集：改成用户首次打开「曲库
# 管理」(/admin) 页面时自己设置，由容器内的 Node 服务保存在 /data 下的
# SQLite 数据库里（见 server/db.js 的 settings 表），生命周期脚本完全不
# 参与密码的设置或存储。
#
# 应用数据 / MV 曲库路径同样取消了自定义功能：统一固定使用应用默认共享
# 目录下的 data、mv 两个子目录，直接写死在 docker-compose.yml 中，不再
# 需要生命周期脚本用 sed 改写。这里只保留一个函数用于取得该固定路径，
# 供安装脚本预创建目录、卸载脚本按需清空 MV 曲库。

# 应用数据 / MV 曲库统一固定的持久化存储根路径。
default_app_share_root() {
    echo "/vol1/@appshare/${TRIM_APPNAME}"
}

# 固定的 MV 曲库路径，卸载向导选择清空曲库时使用。
default_mv_path() {
    echo "$(default_app_share_root)/mv"
}

# 固定的应用数据路径（数据库、封面等）。
default_data_path() {
    echo "$(default_app_share_root)/data"
}
