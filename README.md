# Ruyi Automation

用于如翼平台的人群文件整理、上传、人群创建、分析和结果下载。

## 目录结构

```text
项目目录/
├── config.js                  # 统一运行配置
├── config.example.js          # 配置项示例
├── lib/                       # 公共路径、文件和浏览器工具
├── upload/                    # 运行数据和任务清单
│   ├── raw/                   # 待整理原始文件
│   ├── idfa/                  # IDFA 待上传文件
│   ├── oaid/                  # OAID 待上传文件
│   └── result/                # 下载结果
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
npm run install-browser
```

`npm run install-browser` 会根据当前 macOS 的 CPU 架构，从 GitHub Release 下载与
Playwright `1.62.1` 匹配的 Chromium，并解压到项目内的 `.playwright-browsers/`。
Apple Silicon 使用 `darwin-arm64`，Intel Mac 使用 `darwin-x64`。浏览器包不放入
Git 仓库，也不要分发包含登录状态的 `ruyi-profile`。

维护者在每台 Mac 上分别生成对应架构的 Release 资源（M 系列输出 `arm64`，Intel
输出 `x64`）：

```bash
test "$(node -p 'process.platform')" = darwin
ARCH=$(node -p 'process.arch')
rm -rf .playwright-browsers
PLAYWRIGHT_BROWSERS_PATH="$PWD/.playwright-browsers" npx playwright install chromium
tar -czf "chromium-1.62.1-darwin-${ARCH}.tar.gz" -C .playwright-browsers .
shasum -a 256 "chromium-1.62.1-darwin-${ARCH}.tar.gz"
```

将两个压缩包通过文件传输工具汇总后，登录 GitHub 并创建 Release：

```bash
gh auth login
gh release create playwright-browsers-v1.62.1 \
  chromium-1.62.1-darwin-arm64.tar.gz \
  chromium-1.62.1-darwin-x64.tar.gz \
  --title "Playwright Chromium 1.62.1"
```

如果该 Release 已存在，改用 `gh release upload playwright-browsers-v1.62.1
<文件名> --clobber`。发布两个附件后，安装脚本会自动按架构选择。

任务清单 JSON 应放在 `upload/` 目录中，且内容必须是字符串数组。
