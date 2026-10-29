const assert = require('node:assert/strict');
require('@ruyi/shared/playwright-env');
const { chromium } = require('playwright');
const { chromePath } = require('@ruyi/shared/config');
const { selectTask, markDownloadTarget } = require('@ruyi/automation/download');

(async () => {
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  try {
    const page = await browser.newPage();
    let downloads = 0;
    let clicks = [];
    let requests = [];
    await page.exposeFunction('recordSelection', (name) => { clicks.push(name); });
    await page.exposeFunction('recordDownload', () => { downloads += 1; });
    await page.route('https://selection.test/**', async (route) => {
      if (route.request().method() === 'POST') {
        const payload = route.request().postDataJSON();
        const keyword = payload.filtering[0].values[0];
        requests.push({ keyword, page: payload.page });
        const names = payload.page === 1 ? [`${keyword}9`, `${keyword}8`] : keyword.endsWith('_missing') ? [] : [keyword];
        return route.fulfill({ json: { success: true, data: { listing: { items: names.map((name) => ({ name })) } } } });
      }
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"></head><body>
        <button id="search">搜索</button><input placeholder="请输入关键词或ID" style="display:none">
        <aside id="list"></aside><ul class="pagination"></ul>
        <section><h2 id="detail">其他任务</h2><button onclick="recordDownload()">下载数据</button></section>
        <script>
          const input = document.querySelector('input');
          document.querySelector('#search').onclick = () => { input.style.display = ''; document.querySelector('#search').style.display = 'none'; };
          async function search(pageNumber) {
            const keyword = input.value;
            const response = await fetch('/api/insight/list', {method:'POST',body:JSON.stringify({page:pageNumber,filtering:[{field:'keyword',values:[keyword]}]})});
            const result = await response.json();
            // 模拟接口先返回、页面稍后更新；名称中包含与目标完全相同的高亮片段。
            setTimeout(() => {
              const list = document.querySelector('#list'); list.innerHTML = '';
              for (const item of result.data.listing.items) {
                const card = document.createElement('div'); card.className = 'listItem--new';
                const title = document.createElement('div'); title.className = 'title--new';
                const highlight = document.createElement('span'); highlight.textContent = keyword;
                title.append(highlight, item.name.slice(keyword.length)); card.append(title); list.append(card);
                card.onclick = () => { recordSelection(item.name); setTimeout(() => { document.querySelector('#detail').textContent = item.name; }, 350); };
              }
              document.querySelector('.pagination').innerHTML = pageNumber === 1
                ? '<li><a><i class="arrow-right">下一页</i></a></li>'
                : '<li class="disabled"><a><i class="arrow-right">下一页</i></a></li>';
              document.querySelector('.pagination a').onclick = () => search(pageNumber + 1);
            }, 80);
          }
          input.oninput = () => { if(input.value) search(1); };
        </script></body></html>` });
    });
    await page.goto('https://selection.test/');
    for (const name of ['puzw_pn_5109fdf2_3', 'puzw_pn_5109fdf2_4', 'puzw_pn_5109fdf2_4']) {
      clicks = []; requests = [];
      assert.equal(await selectTask(page, name), name);
      assert.deepEqual(clicks, [name], '只能点击完整名称匹配的卡片，不能点击高亮片段所在的相似任务');
      assert.deepEqual(requests.map((entry) => entry.page), [1, 2]);
      assert.equal((await markDownloadTarget(page, [name])).ok, true, '返回前必须等目标详情显示');
    }
    clicks = [];
    await assert.rejects(selectTask(page, 'task_missing'), /列表中找不到/);
    assert.deepEqual(clicks, [], '无精确匹配时不得点击其他任务');
    assert.equal(downloads, 0, '选择任务不得触发下载');
    console.log('下载任务选择测试通过：搜索高亮、分页、重复搜索、异步详情及缺失任务');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
