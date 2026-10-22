# 新版应用内扫码桌面

任务 7.2 适配 workspace 构建并完成离线验证，新布局镜像尚未实际构建和运行。构建方式见 [README](README.md)，不要使用旧桌面镜像或旧 K8s 模板上线。

新版桌面包含在主镜像中。用户在应用页登录自己的账号，然后进入平台登录流程，在页面里的桌面完成扫码；后端对 WebSocket 入口鉴权，同一时间只允许一个平台登录会话。无需打开独立桌面标签，不再提供 6080 端口。x11vnc 只在容器本机 5900 监听，不能映射或暴露该端口。

容器以 `pwuser` 运行，启动 Xvfb `:99`、openbox、x11vnc，再通过 `npm start` 启动 Fastify 与内嵌 Worker。收到停止信号后先通知整个应用进程组，默认最多等待30秒，让 Node/Worker有机会优雅退出，再清理桌面进程；任一必需服务意外退出也会停止容器。后续 K8s 的终止宽限期应覆盖该等待时间以及额外清理时间。

运行环境使用 `RUYI_LOGIN_DISPLAY=vnc`、`DISPLAY=:99`、`RUYI_UPLOAD_DIR=/data/upload`。用户文件使用持久化目录，不再挂载 `/data/profile`；数据库参数和 `RUYI_STATE_KEY` 后续由 Secret 注入，本步不配置密钥。为了复用已有加密登录态，密钥须与原环境一致，否则需要重新扫码。

`Dockerfile.desktop` 仅保留薄兼容入口：必须显式指定本次已构建的 `APP_IMAGE`，不会默认引用或拉取旧镜像，不额外安装服务，也不新增端口。正常通过 `scripts/build-image.sh` 构建主镜像，无需再构建桌面变体；脚本依据选中的源码清单，在旧布局的 `Dockerfile` 与新布局的 `Dockerfile.workspace` 之间选择，两者保留相同桌面启动、浏览器路径、运行用户和端口。新布局仍由根 `npm start` 启动 API 与内嵌 Worker，没有独立 Worker 容器或新服务端口。

后续验证需覆盖实际 Xvfb/Chromium 启动、鉴权 WebSocket 转发、扫码与状态保存、桌面会话互斥，以及容器停止后的 Worker 清理；离线假命令测试不能替代这些验证。
