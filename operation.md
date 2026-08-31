# 如翼人群上传、洞察与下载操作指南

本文档说明脚本运行环境、目录准备、标准命令、清单状态和故障处理。脚本通过 Playwright 控制本机 Chrome 访问如翼和数据平台页面；页面结构变化时可能需要调整选择器。

## 一、运行环境

- macOS。Chrome 路径固定为 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`。
- Node.js 20 或更高版本（Playwright 1.62.1 要求 `node >=20`）。
- npm、Google Chrome，以及如翼（`ruyi.qq.com`）和数据平台（`datanexus.qq.com`）账号权限。
- 可访问上述站点的网络、企业网络/VPN/代理和必要的验证码、二次认证。

安装依赖：

```bash
node --version       # v20 或更高
npm --version
npm ci               # 按 package-lock.json 安装依赖
```

脚本使用项目目录的 `ruyi-profile/` 作为持久化 Chrome 用户目录，包含 Cookie、缓存和站点状态，属于敏感数据。不要公开提交、复制给无权限人员或在多台机器并行使用。

## 二、目录准备

脚本按顺序使用第一个存在的目录：`/download/upload`、`/下载/upload`、`~/Downloads/upload`。建议只保留一个，通常使用 `~/Downloads/upload`：

```bash
mkdir -p ~/Downloads/upload/{raw,idfa,oaid,result}
```

```text
upload/
├── raw/                       原始 ID 文件
├── idfa/                      IDFA 待上传文件；成功后移入 idfa/done/
├── oaid/                      OAID 待上传文件；成功后移入 oaid/done/
├── createGroupToDoList.json   待创建人群包
├── analysetodolist.json       待创建洞察任务
├── done.json                  待下载洞察结果
└── result/                    下载后的文件
```

原始文件名必须包含 `idfa` 或 `oaid`（不区分大小写），否则 `move.js` 跳过。`uploadAll.js` 会先规范文件名：删除 `occupation` 和下划线，并将 `idfa`/`oaid` 移到文件名最前面（例如 `occupation_app_oaid_md5.txt` 变为 `oaidappmd5.txt`）；规范后不能为空，也不能与现有文件重名。脚本不校验文件内容，内容格式、MD5、大小和行数必须由执行人员按平台要求提前确认。

### JSON 清单

清单必须是 UTF-8 编码的 JSON 字符串数组，元素建议为不带扩展名的文件名：

```json
[
  "campaign_a_idfa",
  "campaign_b_oaid"
]
```

不要写对象、数字或注释；运行期间不要同时编辑清单或移动相关文件。脚本会在成功确认后写回清单，并以清单长度减少作为批处理继续的条件。

## 三、标准流程

### 1. 整理并上传

把文件放入 `raw/` 后执行：

```bash
node uploadAll.js
```

流程是：规范文件名（删除 `occupation`/下划线并前置 ID 类型）-> 生成 `createGroupToDoList.json`（仅收录 idfa/oaid，去扩展名）-> `move.js` 按类型移动 -> `upload.js` 每批最多 5 个上传 -> 成功提交后移入对应 `done/`。批处理会循环直到 `idfa/`、`oaid/` 没有待上传文件。登录页、验证码或权限弹窗出现时，在打开的 Chrome 中完成操作并按终端提示回车。

### 2. 创建人群包

```bash
node createAllGroup.js
```

脚本从创建清单取一项，根据名称中的 `idfa`/`oaid` 打开对应页面，勾选已上传文件，使用文件名填写人群名称和描述并提交。成功后追加（去扩展名）到 `analysetodolist.json`，再从 `createGroupToDoList.json` 删除；失败时保留待办项以便重试。

### 3. 创建洞察任务

```bash
node analyseAll.js
```

每轮在 `https://ruyi.qq.com/insight/create` 选择人群包、填入文件名作为任务名，并固定设置：基本信息=全部、工作状态=预测职业类型、地域属性=全部、消费属性=消费水平、设备信息=全部、资产状况=全部。确认跳转到 `/audience-profile/result` 或 `/insight/insight` 后，才将项目从 `analysetodolist.json` 移到 `done.json`。提交成功仅代表任务创建，结果生成可能仍需等待。

### 4. 下载结果

```bash
node downloadAll.js
```

脚本从 `done.json` 取任务，在 `https://ruyi.qq.com/audience-profile/result/` 逐页查找，必要时使用页面搜索，再点击“下载数据”。有效下载保存到 `result/`；同名文件自动追加 ` (1)`、` (2)`。只有捕获到有效下载且不是 `success:false` 的接口 JSON 才会从 `done.json` 删除，失败项会保留以便重试。

## 四、浏览器和并发注意事项

- 运行前完全退出其他使用 `ruyi-profile` 的 Chrome；一次只运行一个批处理。
- 浏览器以可视模式运行，不要关闭自动打开的窗口或跳到不相关页面。
- 登录失效、验证码和二次认证需要人工完成。
- 页面超时通常与网络、登录态或站点改版有关；先检查 Chrome 当前 URL 和提示，再重试，不要直接删除清单项。
- 上传每批最多 5 个文件，平台还可能限制大小、行数、频率和每日额度。
- 文件包含用户标识数据，执行、日志和结果目录都应按组织的数据安全规范保护。

## 五、检查、重试和恢复

```bash
ROOT="$HOME/Downloads/upload"
cat "$ROOT/createGroupToDoList.json"
cat "$ROOT/analysetodolist.json"
cat "$ROOT/done.json"
find "$ROOT" -maxdepth 3 -type f -print
ls -lh "$ROOT/result"
```

- 创建清单未减少：人群创建未确认成功，修复登录/页面后重跑 `createAllGroup.js`。
- 分析清单未减少：洞察未提交成功；确认网页没有重复任务后重跑 `analyseAll.js`。
- `done.json` 未减少：下载未成功；检查结果状态、权限和网络后重跑 `downloadAll.js`。
- 类型目录仍有文件：仅成功上传才会移动，通常可直接重跑；若 `done/` 已有同名文件，先核对是否重复上传，脚本不会覆盖。

修改前建议备份清单：

```bash
cp "$ROOT/createGroupToDoList.json" "$ROOT/createGroupToDoList.json.bak"
cp "$ROOT/analysetodolist.json" "$ROOT/analysetodolist.json.bak"
cp "$ROOT/done.json" "$ROOT/done.json.bak"
```

不要为了跳过失败任务直接删除清单项；确需人工跳过时应备份并记录原因。

## 六、语法检查和日志

```bash
for f in move.js upload.js uploadAll.js createGroup.js createAllGroup.js analyse.js analyseAll.js download.js downloadAll.js; do
  node --check "$f" || exit 1
done
```

日志只输出到终端；需要留痕时可使用 `node downloadAll.js 2>&1 | tee download-$(date +%Y%m%d-%H%M%S).log`。日志可能包含文件名，不要公开上传。
