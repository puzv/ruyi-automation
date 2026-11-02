const fs = require('node:fs');
const path = require('node:path');
const { projectRoot } = require('@ruyi/shared/paths');
const { filesZipStream } = require('@ruyi/shared/runtime/job-results');

async function registerSkillRoutes(app) {
  app.get('/api/skill/ruyi-audience.zip', async (_request, reply) => {
    // 固定清单避免把仓库中无关文件或意外加入的敏感文件打包。
    const names = ['SKILL.md', 'references/workflow.md', 'references/examples.md'];
    let files;
    try {
      files = names.map((name) => {
        const target = path.join(projectRoot, 'skills/ruyi-audience', name);
        const stat = fs.lstatSync(target);
        if (!stat.isFile()) throw new Error('Skill 文件不可用');
        return { name: `ruyi-audience/${name}`, path: target, size: stat.size };
      });
    } catch {
      return reply.code(503).send({ ok: false, message: 'Skill 文件不可用，请联系管理员' });
    }
    return reply.header('Content-Type', 'application/zip')
      .header('Content-Disposition', 'attachment; filename="ruyi-audience.zip"')
      .header('Cache-Control', 'no-store').send(filesZipStream(files));
  });
}
module.exports = { registerSkillRoutes };
