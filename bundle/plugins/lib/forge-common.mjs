// forge-common：dsh-forge host 插件公共助手（errText / jsonText / DSH_HOME / atomicWriteJson）。
// 抽取自 12 个插件的逐字重复（插件生态扫描实测：errText×15、jsonText×12、DSH_HOME×7、原子写×3）。
// 行为零变化：函数体与各插件本地版本逐字一致；DSH_HOME 为模块加载期常量（等价原插件顶行 const）。
import { join, dirname, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { mkdir, writeFile, rename } from 'node:fs/promises'

export function errText(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}

export function jsonText(value) {
  return JSON.stringify(value, null, 2)
}

// DSH_HOME 约定：process.env.DSH_HOME || ~/.dsh（与 dsh 启动器同一指向）
export const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

// auto-plugins.json 的 hostFile/clientFile 一律**相对 DSH_HOME** 解释。
//
// 2026-10-02 实机定因：清单里的相对路径此前被 `readFile(entry.hostFile)` 原样交给
// 进程 CWD，而桌面版 host 进程的 CWD 是 **profile 目录**（实测
// `%USERPROFILE%\.dsh\profiles\desktop`），那里没有 dynplugins/ →
// 四个动态件全部 ENOENT → `dynamicCordisRunner.inventory()` 恒为空 →
// forge-ui 面板与 featui 功能开关页在 Windows 上从未挂载过（WSL 之所以正常，
// 是因为那边的清单钉死了 /home/alex 绝对路径）。
//
// 绝对路径原样放行，与旧部署清单保持兼容。
export function resolveDynPath(path) {
  if (typeof path !== 'string' || path.length === 0) return path
  return isAbsolute(path) ? path : join(DSH_HOME, path)
}

// 原子写 JSON：tmp-pid + rename（调用方负责进程内串行化，如 writeQueue）
export async function atomicWriteJson(file, data) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await rename(tmp, file)
}
