# 如翼平台镜像配置

任务 7.2 适配新旧源码布局的构建配置，并使用离线假命令验证；此适配尚未执行真实镜像构建、推送或运行。应用使用 Fastify 生产服务及已构建的 Vue 前端，入口为 5173。扫码桌面已经整合到应用页面，无独立 6080 入口。

**`k8s/` 仍是旧模板，未适配新版，不能直接应用或照旧步骤上线。** Secret、PVC、Service、资源和更新策略将在后续任务单独准备。目前已知本机 Docker 和旧镜像为 linux/amd64，K8s 节点架构尚未直接核验。

## 本步安全预览

在部署仓库运行；无需提交或创建标签。需要包含当前应用的未提交修改时使用显式工作区模式：

```bash
bash scripts/build-image.sh .. --worktree ruyi-upload:worktree --dry-run
```

预览仅读取 Git 元数据和非敏感文件属性，显示源码模式、基准提交、布局、选择的 Dockerfile、架构及文件数量；不会复制源码内容或调用 Docker。工作区版本包括已跟踪的未提交修改和未忽略的新源码文件，不代表完全对应显示的提交。被 Git 忽略的源码不会包含；构建前应确认需要的新源码未被忽略。

## 源码布局与缓存

构建脚本根据本次选中的源码清单识别布局。固定旧 Git ref 时，即使当前工作区已迁移到新布局，也继续选择旧构建配置；缺少必需 manifest 或入口会在调用 Docker 前失败。

| 布局 | 构建配置 | 依赖与前端构建 |
| --- | --- | --- |
| 旧 `server/`、`web/`、`lib/` | `Dockerfile` | 根锁文件与 `web/package-lock.json` 分别安装，执行根 `npm run build:web` |
| 新 `apps/`、`packages/` | `Dockerfile.workspace` | 先复制根 manifest、唯一根锁文件及五包 manifest，统一执行一次根 `npm ci --include=dev`，再复制源码并执行根 `npm run build:web` |

新布局仅允许 `apps/web`、`apps/server`、`apps/worker`、`packages/automation`、`packages/shared` 这五包的 manifest 和源码，以及根目录 `db/`、`scripts/` 的 JavaScript。前端允许 `src/` 下源码和静态资源、`index.html`、`vite.config.js`；API/Worker 仅允许 `src/` 下 JavaScript，自动化仅允许根 JavaScript 与 `lib/`，共享包仅允许根 JavaScript 与 `runtime/`。旧布局文件不会混入新布局上下文，额外 workspace 包与包内独立锁文件均不复制。

新布局固定入口为 `apps/server/src/main.js`、`apps/worker/src/main.js`、`apps/web/src/main.js`。包名分别为 `@ruyi/web`、`@ruyi/server`、`@ruyi/worker`、`@ruyi/automation`、`@ruyi/shared`。根 `npm start`、`npm run worker`、`npm run build:web` 保持不变；镜像继续通过根 `npm start` 运行 API 和内嵌 Worker，单副本、桌面同源转发方式不变。

## 后续构建命令（本步不执行）

负责人确认进入实际构建步骤后，仍在部署仓库运行：

```bash
bash scripts/build-image.sh .. --worktree ruyi-upload:worktree
```

固定已提交版本可把 `--worktree` 替换成 `HEAD`、提交或标签。默认仅本地构建；只有显式添加 `--push` 才会执行推送。镜像名称可以使用公司仓库前缀，但不要把认证信息放入参数。架构默认为 `linux/amd64`；可显式指定 `--platform linux/amd64` 或 `--platform linux/arm64`，实际采用前仍须核实节点、基础镜像和 Playwright 支持情况。

脚本先屏蔽敏感路径名并按严格源码白名单筛选，再读取内容生成独立临时上下文；不使用整仓库复制或打包。所有层级的环境文件、登录态、用户数据、浏览器 Profile、依赖、已有构建结果、日志、缓存、临时文件和符号链接被排除，另生成 `.dockerignore`。必需文件为符号链接也会使准备失败；读取工作区内容前会再次检查父目录链。构建成功、失败和接收到停止信号后均清理自己创建的目录。构建标签记录基准提交和 `worktree`/`commit` 来源模式，工作区内容不提供可复现承诺。

镜像沿用 Playwright 1.62.1 noble，浏览器路径为基础镜像的 `/ms-playwright`，不下载额外浏览器。构建执行 `npm run build:web`；运行用户为 `pwuser`，运行 `npm start`。Xvfb、openbox、仅监听本机 5900 的 x11vnc 与应用共同启动，无 websockify/noVNC 服务端；网页 noVNC 客户端照常构建。只声明 5173，不使用 Profile 挂载，也不在启动时执行迁移。

此前实际构建曾停滞在 Ubuntu Azure 软件源下载。两个布局的 Dockerfile 均沿用已验证的 Ubuntu 官方 HTTPS 软件源配置，保留原有发行版、组件和签名密钥；下载超时为30秒，最多重试2次。索引更新使用 `APT::Update::Error-Mode=any`，任何索引下载失败都会中止构建，不继续安装或使用旧索引。此设置保持证书与签名校验；真实网络和镜像构建由负责人后续重试确认。

## 离线检查

```bash
node test/container-preparation.test.js
bash -n scripts/build-image.sh scripts/start-desktop.sh
node --check scripts/build-context.js
```

测试只建立人工 Git 仓库并运行假 Docker、假桌面和假应用命令，不启动真实 Docker、Chromium或数据库，不读取真实环境、登录态或用户数据。人工 Git ref 通过 plumbing 创建对象，不执行 `git commit`。覆盖新旧布局的 ref/工作区、每个必需 manifest 与入口缺失、路径过滤、符号链接、敏感文件读取卫兵、失败清理、信号处理及桌面服务监督。桌面测试在 macOS 使用现有 python3 模拟 Linux `setsid`，不安装依赖。

真实基础镜像包安装、前端镜像内构建、非 root 的 PVC 写权限、浏览器扫码链路和实际容器停止行为，均留待下一步验证。
