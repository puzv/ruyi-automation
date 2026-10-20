# Ruyi Automation

用于如翼平台的人群文件整理、上传、人群创建、分析和结果下载。

## 目录结构

```text
项目目录/
├── config.js                  # 统一运行配置
├── config.example.js          # 配置项示例
├── lib/                       # 公共路径、文件和浏览器工具
├── upload/                    # 数据根目录；直接运行脚本仍使用以下旧单机目录
│   ├── raw/                   # 待整理原始文件
│   ├── idfa/                  # IDFA 待上传文件
│   ├── oaid/                  # OAID 待上传文件
│   ├── pn/                    # PN 手机号 MD5 待上传文件
│   ├── result/                # 下载结果
│   └── users/<用户名>/        # 登录用户的独立工作区，包含同样的五个目录及 JSON 清单
├── ruyi-profile/              # 本机登录状态和浏览器配置
├── move.js
├── uploadAll.js
├── createAllGroup.js
├── analyseAll.js
└── downloadAll.js
```

## 使用顺序

```bash
node move.js
node uploadAll.js
node createAllGroup.js
node analyseAll.js
node downloadAll.js
```

首次运行需要在浏览器中依次完成数据平台（DataNexus）和如翼平台登录。网页控制台的“需要登录”按钮会一次打开一个站点；完成登录并关闭当前登录窗口后，服务会复查登录状态，再打开下一个站点。不要将包含登录状态的 `ruyi-profile` 发送给其他人；分发时可创建一个空目录，让对方首次运行时自行登录。

## 网页工作台

首次使用时，在项目根目录和 `web/` 目录各执行一次 `npm install` 安装依赖。

生产方式：在项目根目录执行 `npm run build:web`，完成后执行 `npm start`，打开 http://127.0.0.1:5173。可通过 `RUYI_SERVER_PORT` 和 `RUYI_SERVER_HOST` 环境变量修改端口和监听地址。

开发方式：在项目根目录打开两个终端，分别运行 `npm run dev:server` 和 `npm run dev:web`，打开 http://localhost:5173（Vite 开发服务器只监听 localhost，用 127.0.0.1 可能打不开）。修改前端代码会热更新；修改 `server/` 后需重启 `dev:server`。

## 用户工作区与平台名称

网页登录后，文件、状态和任务记录按当前账号隔离，工作区由服务端计算为 `<数据根目录>/users/<用户名>/`。导入保留原始文件名，保存在 `raw/<导入标识>/<文件序号>/<原始文件名>`；多次导入同名文件也不会覆盖。上传任务会在整理文件或启动浏览器前检查全部待上传文件，遇到重复原始文件名时停止，请先处理重复文件后重试。同一用户运行任务期间不能继续导入，当前浏览器 Profile 仍全局只允许一个任务运行。

新任务的平台名称格式为 `<用户名>_<idfa|oaid|pn>_<8位任务短串>_<序号>`，最多 30 个 Unicode 字符，名称空间不足时会提前报错。工作区的 `file-manifest.json` 保存平台名称、原始文件名和完整上传任务 ID；重试沿用已有映射。下载结果恢复原始主文件名并保留实际下载格式的扩展名，已有同名结果会报错，待下载清单保留。不要手工删除映射清单。未设置 `RUYI_USER`、`RUYI_JOB_ID` 直接运行脚本时，继续使用旧单机命名方式。

## 旧工作区归入 pzw

旧数据已指定归属 `pzw`。迁移工具默认预检，不会创建或复制文件；默认源为 `config.uploadRoot`，目标为该目录下的 `users/pzw/`：

```bash
node scripts/migrate-user-workspace.js
node scripts/migrate-user-workspace.js --apply
```

自定义数据根目录可通过 `RUYI_UPLOAD_DIR` 或 `--source /path/to/data` 指定。请在停止导入和任务后先运行预检，再执行 `--apply`。工具只复制 `raw/`、`idfa/`、`oaid/`、`pn/`、`result/`、历史 `conclusion/`、三个任务 JSON 清单（兼容旧创建清单大小写）和确切名称的配套说明文件 `总结报告生成流程.md`，保留文件名、原始字节和空目录；说明文件不解析内容，其他 Markdown 文件和未知目录仍会报错。迁移不会给历史文件重新分配平台名称。隐藏项、登录态及浏览器 Profile 不参与迁移，`users/` 和迁移临时目录也不参与源目录扫描。其他未知根目录条目、符号链接、坏清单、路径风险或已存在的目标都会阻止迁移。

复制在同级临时目录完成，逐文件进行 SHA-256 字节校验后再发布目标，输出文件数、总字节数和校验数。原目录保留；重复执行不会合并或覆盖已有目标。失败时保留临时目录供检查，不会自动删除数据；若目标尚未创建，排除失败原因后可重新执行。迁移工具不读取 `.env`，也不连接数据库。

无需数据库或真实浏览器的阶段 3 测试为 `npm run test:phase3`，已接入 `npm test`；数据库测试仍仅由 `npm run test:all` 串行运行。

## 配置覆盖

默认使用项目目录下的 `upload` 和 `ruyi-profile`。如需覆盖，可设置环境变量：

```bash
RUYI_UPLOAD_DIR="/path/to/upload" \\
RUYI_PROFILE_DIR="/path/to/profile" \\
RUYI_CHROME_PATH="/path/to/chrome" \\
RUYI_HEADLESS=1 \\
RUYI_AUDIENCE_LIMIT=480 \\
node createAllGroup.js
```

所有浏览器流程默认以后台（无头）模式运行。需要查看浏览器窗口或完成登录、验证码、二次认证时，请设置 `RUYI_HEADLESS=0`（也接受 `false`/`no`/`off`）切换为可视调试模式；完成登录后可取消该变量恢复后台运行。

业务 URL 也可通过 `RUYI_URL_*` 环境变量覆盖，具体名称见 `config.js`。

## 分发

分发项目源码、`package.json`、`package-lock.json`、`lib/` 和必要的 `upload` 子目录即可。接收方在项目目录执行：

```bash
npm install
```

安装依赖后，需要自行准备与当前 Mac 架构匹配的 Playwright Chromium，并解压到项目内的
`.playwright-browsers/` 目录。M 系列 Mac 使用 `darwin-arm64`，Intel Mac 使用
`darwin-x64`。例如浏览器压缩包解压后应保留类似以下结构：

```text
.playwright-browsers/
└── chromium-1234/
    └── chrome-mac-arm64/       # M 系列；Intel 使用 chrome-mac-x64
```

确认浏览器目录已经放好后即可运行项目；不再需要执行额外的浏览器安装命令。浏览器包
不要提交到 Git 仓库，也不要分发包含登录状态的 `ruyi-profile`。

### 通过 Gitee Release 分发浏览器

Gitee 单个附件限制 100 MB。维护者可将 `1/` 中的两个浏览器 ZIP 按默认 90 MiB 切片：

```bash
npm run browser:split
```

命令会在 `browser-release/` 生成两种 Mac 架构的分片和 `browser-manifest.json`。将该目录内
的所有文件上传到同一个 Gitee Release；不要上传原始的大 ZIP。默认每个架构生成两个分片，
安装器以清单为准，不依赖固定分片数量。

当前浏览器分片已发布到 `puzvv/ruyi-automation` 的 `playwright-browsers-v1.1.6` Release。
用户安装依赖后直接运行：

```bash
npm run browser:install
```

安装器默认使用以下附件下载基址：

```text
https://gitee.com/puzvv/ruyi-automation/releases/download/playwright-browsers-v1.1.6
```

以后发布新标签时，可以通过环境变量临时覆盖地址：

```bash
GITEE_BROWSER_RELEASE_URL=https://gitee.com/puzvv/ruyi-automation/releases/download/新标签 \
  npm run browser:install
```

安装器会检测真实 macOS 硬件架构，而不是只看 Node.js 进程架构，因此即使 Apple Silicon
通过 Rosetta 运行 Intel 版 Node，也会下载 `arm64` 浏览器。安装器逐片下载并校验每片 SHA-256，
按顺序拼接后再次校验完整 ZIP，最后解压到 `.playwright-browsers/`。已有完整浏览器不会重复
安装；检测到之前误装的另一架构浏览器时，会在新包校验完成后自动替换。只有目录不完整且
无法判断原架构时才需要增加 `--force`。如果系统无法读取架构，可显式指定：

```bash
npm run browser:install -- --arch arm64
```

任务清单 JSON 应放在当前工作区根目录中，且内容必须是字符串数组；旧单机模式的工作区仍为 `upload/`。
