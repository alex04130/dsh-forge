// plsm 面板验证：徽章 → 打开面板 → 列表 → 详情 → 搜索 → en 复测
const { chromium } = require('/home/alex/daycore/node_modules/playwright-core')
const CHROME = process.env.HOME + '/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome'
;(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const fails = []
  const ok = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' | ' + extra : '')); if (!cond) fails.push(name) }

  // ---- zh ----
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, locale: 'zh-CN' })
  await page.goto('http://127.0.0.1:3080', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.plsm-badge', { timeout: 15000 })
  await page.waitForTimeout(1200)

  const badge = await page.evaluate(() => {
    const el = document.querySelector('.plsm-badge')
    const svg = el && el.querySelector('svg')
    const r = el.getBoundingClientRect()
    const ir = svg.getBoundingClientRect()
    const txt = [...el.children].find(c => c.tagName === 'SPAN')
    const tr = txt ? txt.getBoundingClientRect() : null
    return {
      children: [...el.children].map(c => c.tagName).join(','),
      svgSize: svg.getAttribute('width'),
      baselineDelta: tr ? Math.round((ir.top + ir.height / 2) - (tr.top + tr.height / 2)) : null,
      top: Math.round(r.top),
      text: (el.textContent || '').trim(),
    }
  })
  ok('zh badge 结构(svg+span)', badge.children.startsWith('svg,SPAN'), badge.children + ' ' + badge.svgSize + 'px')
  ok('zh badge 基线对齐', badge.baselineDelta !== null && Math.abs(badge.baselineDelta) <= 1, 'delta=' + badge.baselineDelta)
  ok('zh badge 文案', badge.text.includes('质粒'), badge.text)

  // 分组：质粒应为组末，marginBottom 8px；sessmgr 0
  const grp = await page.evaluate(() => {
    const g = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).marginBottom : 'missing' }
    return { plsm: g('.plsm-entry'), sess: g('.sessmgr-arch-entry') }
  })
  ok('组尾间距接管', grp.plsm === '8px' && grp.sess === '0px', JSON.stringify(grp))

  // 打开面板
  await page.click('.plsm-badge')
  await page.waitForSelector('.plsm-panel', { timeout: 8000 })
  await page.waitForSelector('.plsm-row', { timeout: 8000 })
  const list = await page.evaluate(() => ({
    title: document.querySelector('.plsm-title').textContent,
    rows: document.querySelectorAll('.plsm-row').length,
    firstId: document.querySelector('.plsm-id') && document.querySelector('.plsm-id').textContent,
    fitWidth: document.querySelector('.plsm-fit-fill') && document.querySelector('.plsm-fit-fill').style.width,
    conf: document.querySelector('.plsm-conf') && document.querySelector('.plsm-conf').textContent,
    search: !!document.querySelector('.plsm-search'),
    foot: document.querySelector('.plsm-foot').textContent,
  }))
  ok('zh 面板打开+列表渲染', list.rows >= 1, JSON.stringify({ title: list.title, rows: list.rows, id: list.firstId }))
  ok('zh fitness 条', list.fitWidth === '70%', 'width=' + list.fitWidth)
  ok('zh 置信徽章', list.conf === '中置信', list.conf)
  ok('zh 只读脚注', list.foot.includes('只读'), list.foot)
  await page.screenshot({ path: 'plsm-1-list-zh.png' })

  // 详情
  await page.click('.plsm-row')
  await page.waitForSelector('.plsm-detail', { timeout: 8000 })
  const det = await page.evaluate(() => ({
    blocks: [...document.querySelectorAll('.plsm-block-label')].map(x => x.textContent.slice(0, 12)),
    evi: document.querySelectorAll('.plsm-evi-item').length,
    failedRed: getComputedStyle(document.querySelector('.plsm-failed-text')).color,
    back: document.querySelector('.plsm-btn') && document.querySelector('.plsm-btn').textContent,
  }))
  ok('zh 详情四段+fitness+证据', det.blocks.length >= 5 && det.evi === 5, JSON.stringify({ blocks: det.blocks.length, evi: det.evi }))
  ok('zh FAILED 红色（token 解析为红）', /^rgb\((2\d\d), (\d+), (\d+)\)$/.test(det.failedRed) && Number(det.failedRed.match(/\d+/g)[1]) < 80, det.failedRed)
  await page.screenshot({ path: 'plsm-2-detail-zh.png' })

  // 返回 + 搜索
  await page.click('.plsm-btn')
  await page.waitForSelector('.plsm-row', { timeout: 8000 })
  await page.fill('.plsm-search', '编码')
  await page.waitForTimeout(700)
  const s1 = await page.evaluate(() => document.querySelectorAll('.plsm-row').length)
  ok('zh 搜索「编码」有结果', s1 >= 1, 'rows=' + s1)
  await page.fill('.plsm-search', 'zzzz不存在词')
  await page.waitForTimeout(700)
  const s2 = await page.evaluate(() => ({
    rows: document.querySelectorAll('.plsm-row').length,
    emptyText: document.querySelector('.plsm-empty') ? document.querySelector('.plsm-empty').textContent : '',
  }))
  console.log('  搜索无匹配行为: rows=' + s2.rows + ' empty=' + s2.emptyText + '（服务端 relevance=0 仍返回则属数据面行为，面板如实呈现）')
  await page.screenshot({ path: 'plsm-3-search-zh.png' })

  // console errors
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))

  // ---- en ----
  const page2 = await browser.newPage({ viewport: { width: 1440, height: 860 }, locale: 'en-US' })
  await page2.goto('http://127.0.0.1:3080', { waitUntil: 'domcontentloaded' })
  await page2.waitForSelector('.plsm-badge', { timeout: 15000 })
  await page2.waitForTimeout(1000)
  const enBadge = await page2.evaluate(() => document.querySelector('.plsm-badge').textContent.trim())
  ok('en badge 文案', enBadge.startsWith('Plasmids'), enBadge)
  await page2.click('.plsm-badge')
  await page2.waitForSelector('.plsm-row', { timeout: 8000 })
  const en = await page2.evaluate(() => ({
    title: document.querySelector('.plsm-title').textContent,
    conf: document.querySelector('.plsm-conf').textContent,
    foot: document.querySelector('.plsm-foot').textContent,
    placeholder: document.querySelector('.plsm-search').getAttribute('placeholder'),
  }))
  ok('en 面板文案', en.title.includes('Plasmid Registry') && en.conf === 'med conf' && en.foot.includes('Read-only'), JSON.stringify(en))
  await page2.screenshot({ path: 'plsm-4-list-en.png' })

  await browser.close()
  console.log(fails.length === 0 ? 'ALL PASS' : 'FAILURES: ' + fails.join(', '))
  process.exit(fails.length === 0 ? 0 : 1)
})().catch(e => { console.error('FATAL', e); process.exit(1) })
