// description: 言行一致检查器 v0：verify_claim 显式验货工具（git commit / 文件存在 / 文本条目），证据原文可复核。
import { defineTool } from '@deepseek-ai/dsh-tools'
import { execFile } from 'node:child_process'
import { stat, readFile } from 'node:fs/promises'
import { resolve, isAbsolute } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function errText(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}
function jsonText(value) {
  return JSON.stringify(value, null, 2)
}

function assertInside(base, target) {
  const baseResolved = resolve(base)
  const targetResolved = isAbsolute(target) ? resolve(target) : resolve(base, target)
  if (targetResolved === baseResolved) return targetResolved
  const prefix = baseResolved === '/' ? '/' : baseResolved + '/'
  if (!targetResolved.startsWith(prefix)) {
    throw new Error(`path escapes the working directory: ${target}`)
  }
  return targetResolved
}

// ── 纯验证逻辑（可被探针/其他模型直接复用）──────────────────────────────
export async function runVerification({ type, target, path, cwd }) {
  if (type === 'git-commit') {
    const sha = String(target ?? '').trim()
    if (!/^[0-9a-fA-F]{7,40}$/.test(sha)) return { ok: false, verified: false, error: `not a plausible commit sha: ${sha}` }
    try {
      const typeOf = await execFileAsync('git', ['-C', cwd, 'cat-file', '-t', sha], { timeout: 15000, maxBuffer: 1024 * 1024, encoding: 'utf8' })
      if (typeOf.stdout.trim() !== 'commit') return { ok: false, verified: false, note: `git object exists but is not a commit: ${typeOf.stdout.trim()}` }
      const out = await execFileAsync('git', ['-C', cwd, 'show', '-s', '--format=%h %s%n%an <%ae> %ad', sha], {
        timeout: 15000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8',
      })
      return { ok: true, verified: true, type: 'git-commit', target: sha, cwd, evidence: out.stdout.trim() }
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 128) {
        return { ok: false, verified: false, type: 'git-commit', target: sha, cwd, evidence: String(error).split('\n').slice(0, 3).join('\n') }
      }
      throw error
    }
  }

  if (type === 'file') {
    try {
      const resolved = assertInside(cwd, target)
      const st = await stat(resolved)
      return {
        ok: true, verified: true, type: 'file', target, cwd,
        evidence: `path=${resolve(resolved)}\nsize=${st.size}\nmtime=${st.mtime.toISOString()}\n${st.isDirectory() ? 'type=directory' : 'type=file'}`,
      }
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
        return { ok: false, verified: false, type: 'file', target, cwd, note: 'ENOENT: file does not exist' }
      }
      throw error
    }
  }

  if (type === 'text-in-file') {
    if (typeof path !== 'string' || path.length === 0) return { ok: false, error: 'path is required for text-in-file' }
    try {
      const resolved = assertInside(cwd, path)
      const content = await readFile(resolved, 'utf8')
      const lines = content.split('\n')
      const hits = []
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].includes(target)) hits.push(`${i + 1}: ${lines[i].slice(0, 160)}`)
      }
      if (hits.length === 0) return { ok: false, verified: false, type: 'text-in-file', target, path: resolved, note: 'no line contains the target' }
      return { ok: true, verified: true, type: 'text-in-file', target, path: resolved, hitCount: hits.length, evidence: hits.slice(0, 10).join('\n') }
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
        return { ok: false, verified: false, type: 'text-in-file', target, path, note: 'ENOENT: file does not exist' }
      }
      throw error
    }
  }

  return { ok: false, error: `unknown type: ${type}` }
}

export default {
  inject: ['tools'],
  apply(ctx) {
    const tools = ctx.tools

    function registerTool(name, description, parameters, execute) {
      const tool = defineTool({
        name,
        description,
        parameters,
        output: {
          schema: { type: 'string' },
          render(_args, value) { return [{ type: 'text', text: typeof value === 'string' ? value : String(value) }] },
        },
        async execute(args, exec) {
          try { return await execute(args, exec) } catch (error) { return jsonText({ ok: false, error: errText(error) }) }
        },
      })
      const dispose = tools.register(tool)
      ctx.effect(() => () => { try { dispose() } catch (error) { /* best-effort */ } })
    }

    function callerCwd(exec) {
      try {
        const header = exec !== undefined && exec.agent !== undefined && exec.agent.session !== undefined ? exec.agent.session.header : undefined
        return typeof header?.cwd === 'string' && header.cwd.length > 0 ? header.cwd : undefined
      } catch (error) {
        return undefined
      }
    }

    registerTool('verify_claim',
      '言行一致检查器：显式验货。当汇报声称"已提交 <sha>"、"已修复 <文件>"、"已登记 <条目>"时，模型主动调用本工具验证声称的对象是否真实存在。返回 evidence（原始证据文本）供其他模型独立复核，不是黑箱 true/false。不写任何东西，只读。',
      {
        type: {
          type: 'string',
          required: true,
          enum: ['git-commit', 'file', 'text-in-file'],
          description: "验证类型：git-commit=校验 git 提交 sha 存在；file=校验文件存在；text-in-file=校验文件里含指定条目（如 'U-A1'）。",
        },
        target: {
          type: 'string',
          required: true,
          description: '声称的对象：git-commit 时是完整提交 sha；file 时是相对路径；text-in-file 时是想命中的关键字/ID。',
        },
        path: {
          type: 'string',
          description: '仅 text-in-file 必填：要 grep 的绝对路径或相对路径。',
        },
        cwd: {
          type: 'string',
          description: '可选：验证基准目录（git 仓库根 / 相对路径基准）。默认取当前会话的工作目录。',
        },
      },
      async (args, exec) => {
        const cwd = typeof args.cwd === 'string' && args.cwd.trim().length > 0 ? args.cwd.trim() : callerCwd(exec)
        if (cwd === undefined) return jsonText({ ok: false, error: 'cannot resolve working directory (no exec cwd and no cwd argument)' })
        const out = await runVerification({ type: String(args.type ?? ''), target: String(args.target ?? ''), path: typeof args.path === 'string' ? args.path : undefined, cwd })
        return jsonText(out)
      })
  },
}