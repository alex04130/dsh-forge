#!/usr/bin/env node
// 工具索引生成器：从静态插件 + 动态插件内嵌代码提取全部 registerTool 调用，
// 生成 docs/tools-registry.md（单一事实源 = 代码本身，索引机器生成，不手写不漂移）。
// 运行：node ~/.dsh/scripts/gen-tools-registry.mjs
// 建议归宿：dsh-forge/scripts/gen-tools-registry.mjs（relay 落库后本副本退役）
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { homedir } from 'node:os'
const HOME = process.env.DSH_HOME || homedir() + '/.dsh'
const PLUGINS = join(HOME, 'profiles/web/plugins')
const DYN = join(HOME, 'auto-plugins.json')
const OUT = join(HOME, 'docs/tools-registry.md')

// 域映射（分域合并的索引面：工具属于哪个域，合并前用插件名，合并后自然归位）
const DOMAIN = {
  mailbridge: '协作域', teamhub: '协作域', sessionmgmt: '协作域',
  archive: '知识域', verify: '知识域', plasmid: '知识域', skillmanager: '知识域',
  injector: '运行时域', dynboot: '运行时域',
  llmrouter: '路由域', modelroute: '路由域', modsub: '路由域',
  modeswitch: '路由域', auth: '路由域',
}

function domainOf(plugin, name) {
  for (const [k, v] of Object.entries(DOMAIN)) if (plugin.includes(k) || name.startsWith(k.split('/')[0])) return v
  return '其他'
}

const tools = []
// ① 静态插件：registerTool(ctx, 'name', 'desc', {...}, handler)
for (const f of (await readdir(PLUGINS)).filter((n) => n.endsWith('.mjs'))) {
  const src = await readFile(join(PLUGINS, f), 'utf8')
  for (const m of src.matchAll(/registerTool\(ctx,\s*'([\w-]+)',\s*\n?\s*'((?:[^'\\]|\\.)*)'/g)) {
    tools.push({ name: m[1], desc: m[2], plugin: f.replace('.mjs', ''), where: '静态' })
  }
}
// ② 动态插件内嵌代码：harness.registerTool('name', ...) / registerTool('name', ...) / 本地包装
{
  const dyn = JSON.parse(await readFile(DYN, 'utf8'))
  for (const p of dyn.plugins || []) {
    const label = (p.name || p.idPrefix || '?').slice(0, 18)
    for (const half of ['hostCode', 'clientCode']) {
      const code = p[half]
      if (typeof code !== 'string') continue
      for (const m of code.matchAll(/(?:harness\.)?registerTool\(\s*['"]([\w-]+)['"]\s*,\s*['"]((?:[^'\\]|\\.)*)['"]/g)) {
        tools.push({ name: m[1], desc: m[2], plugin: label, where: '动态' })
      }
      // 对象字面量形态：registerTool(ctx, { name: 'xxx', description: '...' }) / harness.registerTool(ctx, tool) 且 tool 带 name 字段
      for (const m of code.matchAll(/(?:harness\.)?registerTool\(\s*ctx,\s*(?:tool|[\w$]+)\)/g)) {
        // 回溯找同段代码里的 name: 'xxx' 与 description: '...' 字段（取最近一对）
        const idx = m.index
        const window = code.slice(Math.max(0, idx - 6000), idx)
        const names = [...window.matchAll(/name:\s*['"]([\w-]+)['"]/g)]
        if (names.length > 0) {
          const nm = names[names.length - 1]
          const after = window.slice(nm.index + nm[0].length)
          const ds = after.match(/description:\s*['"]((?:[^'\\]|\\.)*)['"]/)
          tools.push({ name: nm[1], desc: ds ? ds[1] : '', plugin: label, where: '动态' })
        }
      }
    }
  }
}
// 去重（同名以静态为准）
const seen = new Map()
for (const t of tools) if (!seen.has(t.name)) seen.set(t.name, t)
const all = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))

const byDomain = {}
for (const t of all) (byDomain[domainOf(t.plugin, t.name)] ||= []).push(t)

let md = `# 工具索引（机器生成，勿手改）\n\n`
md += `> 生成器：\`~/.dsh/scripts/gen-tools-registry.mjs\`（单一事实源=代码内 registerTool 调用；改工具改代码，索引重新生成即可）\n`
md += `> 生成时间：${new Date().toISOString().slice(0, 16).replace('T', ' ')} ｜ 总数：${all.length} ｜ 静态 ${all.filter((t) => t.where === '静态').length} + 动态 ${all.filter((t) => t.where === '动态').length}\n\n`
for (const [dom, list] of Object.entries(byDomain).sort()) {
  md += `## ${dom}（${list.length}）\n\n| 工具 | 插件 | 形态 | 描述（首句） |\n|---|---|---|---|\n`
  for (const t of list) md += `| \`${t.name}\` | ${t.plugin} | ${t.where} | ${t.desc.split(/[。；;.\n]/)[0].slice(0, 60)} |\n`
  md += '\n'
}
await writeFile(OUT, md)
console.log(`[gen] ${all.length} 个工具 → ${OUT}`)
console.log(`[gen] 域分布: ${Object.entries(byDomain).map(([d, l]) => d + '=' + l.length).join(' ')}`)
