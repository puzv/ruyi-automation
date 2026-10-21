const path = require('node:path')

// 工作区目录会随启动入口变化；运行数据始终属于仓库根目录。
const projectRoot = path.resolve(__dirname, '../..')
const automationRoot = path.join(projectRoot, 'packages', 'automation')
const webDist = path.join(projectRoot, 'apps', 'web', 'dist')
const jobWrapper = path.join(projectRoot, 'scripts', 'job-wrapper.js')

module.exports = { projectRoot, automationRoot, webDist, jobWrapper }
