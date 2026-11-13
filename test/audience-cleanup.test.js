const assert = require('node:assert/strict')
const { chromePath } = require('@ruyi/shared/config')
const { chromium } = require('playwright')
const { deleteAudience } = require('../packages/automation/lib/audience-cleanup')

const NAME = 'pzw_oaid_73bd0476_1'
const HTML = `<!doctype html><meta charset="utf-8"><input placeholder="搜索人群名称/ID">
<table><thead><tr><th><input type="checkbox" value="all"></th></tr></thead><tbody></tbody></table>
<div class="ndmp-batch-operation-bar__btn" hidden>删除</div><section class="dialog"></section>
<script>
const input = document.querySelector('input');
input.onkeydown = async e => {
  if(e.key !== 'Enter') return;
  const result = await (await fetch('/api/audience/list',{method:'POST',body:JSON.stringify({page:1,pageSize:10,searchKey:input.value})})).json();
  document.querySelector('tbody').innerHTML = result.data.listing.items.map(r => '<tr><td class="name"><span class="txt">'+r.name+'</span></td><td><label class="spaui-checkbox"><input type="checkbox" value="'+r.id+'" '+(r.checked?'checked':'')+' style="position:absolute;opacity:0">选择</label></td></tr>').join('');
  document.querySelectorAll('tbody input').forEach(c => c.onchange = () => { document.querySelector('.ndmp-batch-operation-bar__btn').hidden = !document.querySelector('tbody input:checked'); document.querySelector('thead input').checked = !!document.querySelector('tbody input:checked'); });
};
document.querySelector('.ndmp-batch-operation-bar__btn').onclick = () => {
 const name = document.querySelector('tbody input:checked').closest('tr').querySelector('.txt').textContent;
 document.querySelector('.dialog').innerHTML = '<div class="spaui-dialog del-audience"><p class="del-audience__desc">确认删除人群 “'+name+'” ？删除后将不可恢复</p><button>删除</button></div>';
 document.querySelector('button').onclick = async () => { await fetch('/api/audience/delete',{method:'POST',body:JSON.stringify({audienceIds:[...document.querySelectorAll('tbody input:checked')].map(c=>Number(c.value))})}); };
};
</script>`

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: chromePath })
  try {
    async function run({ rows = [{ name: NAME, id: 45875460 }], total, deleteOk = true, beforeDelete, expectedFailure = false,
      malicious = false, dialogMismatch = false, checkboxMismatch = false } = {}) {
      const context = await browser.newContext()
      let deleted = false, requests = 0
      await context.route('**/*', async route => {
        const url = new URL(route.request().url())
        if (url.pathname === '/api/audience/list') {
          const current = deleted ? rows.filter((row) => row.name !== NAME) : rows
          return route.fulfill({ json: { success: true, code: 0, data: { listing: {
            total: deleted ? current.length : total ?? current.length, items: current,
          } } } })
        }
        if (url.pathname === '/api/audience/delete') {
          requests += 1
          assert.deepEqual(route.request().postDataJSON(), { audienceIds: [45875460] })
          deleted = deleteOk
          return route.fulfill({ json: { success: deleteOk, code: deleteOk ? 0 : 9 } })
        }
        let html = HTML
        if (malicious) html = html.replace('.map(c=>Number(c.value))', '.map(c=>Number(c.value)).concat(999)')
        if (dialogMismatch) html = html.replace('？删除后将不可恢复', '？确认内容已变化')
        if (checkboxMismatch) html = html.replace("'+r.id+'", "'+(r.id+1)+'")
        return route.fulfill({ contentType: 'text/html', body: html })
      })
      try {
        if (expectedFailure) await assert.rejects(deleteAudience(context, NAME, { beforeDelete }), { code: 'AUDIENCE_CLEANUP_FAILED' })
        else {
          const result = await deleteAudience(context, NAME, { beforeDelete })
          const exists = rows.some((row) => row.name === NAME)
          assert.deepEqual(result, { deleted: exists, absent: !exists })
        }
        assert.equal(context.pages().length, 0, '独立清理页面始终关闭')
        return requests
      } finally { await context.close() }
    }
    let calls = 0
    assert.equal(await run({ beforeDelete: async () => { calls += 1 } }), 1)
    assert.equal(calls, 2, '两次删除按钮前均检查数据库租约')
    assert.equal(await run({ rows: [] }), 0)
    assert.equal(await run({ rows: [{ name: NAME + '_other', id: 45875461 }] }), 0, '完整结果仅有模糊项时确认目标不存在')
    assert.equal(await run({ rows: [{ name: NAME + '0', id: 45875461 }, { name: NAME, id: 45875460 }] }), 1,
      '搜索含前缀项时仅删除精确项，复查允许前缀项保留')
    assert.equal(await run({ rows: [{ name: NAME, id: 45875460 }, { name: NAME, id: 45875461 }], expectedFailure: true }), 0)
    assert.equal(await run({ total: 2, expectedFailure: true }), 0, '分页结果不能证明唯一时拒绝')
    assert.equal(await run({ rows: [{ name: NAME, id: 45875460, checked: true }], expectedFailure: true }), 0)
    assert.equal(await run({ beforeDelete: async () => { throw Error('停止或租约失效') }, expectedFailure: true }), 0)
    let finalCheck = 0
    assert.equal(await run({ beforeDelete: async () => { if (++finalCheck === 2) throw Error('停止') }, expectedFailure: true }), 0)
    assert.equal(await run({ deleteOk: false, expectedFailure: true }), 1)
    assert.equal(await run({ malicious: true, expectedFailure: true }), 0, '额外人群编号请求发送前被拦截')
    assert.equal(await run({ dialogMismatch: true, expectedFailure: true }), 0)
    assert.equal(await run({ checkboxMismatch: true, expectedFailure: true }), 0)
    console.log('人群精确删除、搜索确认、单选隔离、租约检查及失败闭合测试通过')
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
