function errText(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}
function jsonText(value) {
  return JSON.stringify(value, null, 2)
}
function textOf(collected) {
  if (collected !== null && typeof collected === 'object' && typeof collected.text === 'string') return collected.text
  return ''
}

return {
  apply(ctx) {
    const shell = ctx.get('shell')
    const sandboxPolicy = ctx.get('sandboxPolicy')
    if (shell === undefined) return
    const root = sandboxPolicy !== undefined && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot.length > 0 ? sandboxPolicy.workspaceRoot : ''

    function gitCommand(gitArgs, timeoutMs, stdoutMaxBytes, signal) {
      const prefix = root.length > 0 ? 'git -C ' + JSON.stringify(root) + ' ' : 'git '
      const command = prefix + gitArgs.join(' ')
      const request = {
        command,
        timeoutMs: timeoutMs ?? 10000,
        stdoutMaxBytes: stdoutMaxBytes ?? 262144,
      }
      if (signal !== undefined) request.signal = signal
      const spec = shell.resolve(request)
      return shell.run(spec)
    }
    async function gitText(gitArgs, timeoutMs, stdoutMaxBytes, signal) {
      const result = await gitCommand(gitArgs, timeoutMs, stdoutMaxBytes, signal)
      return { exitCode: result.exitCode, text: textOf(result.stdout), err: textOf(result.stderr) }
    }
    const SAFE_REF = /^[0-9a-zA-Z^~.\-]{1,64}$/
    const SAFE_BRANCH = /^[0-9a-zA-Z._\/\-]{1,128}$/
    function refArg(value) {
      const ref = String(value ?? '').trim()
      if (ref.length === 0) return ''
      if (!SAFE_REF.test(ref)) return ''
      return ref
    }
    function branchArg(value) {
      const branch = String(value ?? '').trim()
      if (branch.length === 0) return ''
      if (!SAFE_BRANCH.test(branch) || branch.indexOf('..') !== -1 || branch === '-') return ''
      return branch
    }

    function registerTool(name, description, parameters, execute, timeoutMs) {
      const tool = harness.defineTool({
        name,
        description,
        parameters,
        output: {
          schema: { type: 'string' },
          render(_args, value) { return [{ type: 'text', text: typeof value === 'string' ? value : String(value) }] },
        },
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        async execute(args, exec) {
          try {
            return await execute(args, exec)
          } catch (error) {
            return jsonText({ ok: false, error: errText(error) })
          }
        },
      })
      const dispose = harness.registerTool(ctx, tool)
      ctx.effect(() => () => { try { dispose() } catch (error) { /* best-effort */ } })
    }

    registerTool('git_status',
      'Show the git working tree status of the session workspace (porcelain v1 with branch header): staged, modified, untracked files. Use before committing or to see what changed since the last commit.',
      {},
      async (args, exec) => {
        const out = await gitText(['status', '--porcelain=v1', '-b'], 10000, 262144, exec !== undefined ? exec.signal : undefined)
        if (out.exitCode !== 0) return jsonText({ ok: false, error: out.err.length > 0 ? out.err : 'git status exited ' + String(out.exitCode) })
        return jsonText({ ok: true, text: out.text })
      })

    registerTool('git_log',
      'Show the recent git commit history of the session workspace, one line per commit (hash, decorations, subject). Pass graph:true for the full branch/merge topology (git log --graph --all). Use to understand recent changes or to find a commit hash to inspect with git_show.',
      {
        count: { type: 'number', description: 'Number of commits (default 30, cap 100).' },
        ref: { type: 'string', description: 'Optional ref or branch to log.' },
        graph: { type: 'boolean', description: 'Show the full branch/merge graph across all refs (git log --all --graph --oneline --decorate).' },
      },
      async (args, exec) => {
        const count = typeof args.count === 'number' && args.count > 0 ? Math.min(Math.floor(args.count), 200) : 30
        const ref = refArg(args.ref)
        const base = args.graph === true ? ['log', '--all', '--graph', '--oneline', '--decorate'] : ['log', '--oneline', '--decorate']
        const out = await gitText([...base, '-n', String(count), ...(ref.length > 0 ? [ref] : [])], 10000, 262144, exec !== undefined ? exec.signal : undefined)
        if (out.exitCode !== 0) return jsonText({ ok: false, error: out.err.length > 0 ? out.err : 'git log exited ' + String(out.exitCode) })
        return jsonText({ ok: true, text: out.text })
      })

    registerTool('git_diff',
      'Show the git diff of the session workspace: unstaged changes by default; pass ref to diff against a commit or branch, refB for a range, or staged:true for staged changes (--cached). Use to review exactly what changed before a commit.',
      {
        ref: { type: 'string', description: 'Optional ref to diff against (default: working tree).' },
        refB: { type: 'string', description: 'Optional second ref for a range diff.' },
        staged: { type: 'boolean', description: 'Show staged changes (git diff --cached) instead of unstaged.' },
      },
      async (args, exec) => {
        const parts = ['diff']
        if (args.staged === true) parts.push('--cached')
        const ref = refArg(args.ref)
        const refB = refArg(args.refB)
        if (ref.length > 0) parts.push(ref)
        if (refB.length > 0) parts.push(refB)
        const out = await gitText(parts, 15000, 524288, exec !== undefined ? exec.signal : undefined)
        if (out.exitCode !== 0) return jsonText({ ok: false, error: out.err.length > 0 ? out.err : 'git diff exited ' + String(out.exitCode) })
        return jsonText({ ok: true, text: out.text })
      })

    registerTool('git_show',
      'Show one git commit in detail: full message, file stat, and the patch (git show). Use to inspect exactly what a specific commit changed, including merge commits.',
      { ref: { type: 'string', required: true, description: 'Commit hash (or short ref) to show.' } },
      async (args, exec) => {
        const ref = refArg(args.ref)
        if (ref.length === 0) return jsonText({ ok: false, error: 'invalid ref; pass a commit hash or branch name' })
        const out = await gitText(['show', '--stat', '--format=fuller', ref], 15000, 524288, exec !== undefined ? exec.signal : undefined)
        if (out.exitCode !== 0) return jsonText({ ok: false, error: out.err.length > 0 ? out.err : 'git show exited ' + String(out.exitCode) })
        return jsonText({ ok: true, text: out.text })
      })

    harness.handle('gitPanelState', async () => {
      try {
        const branch = await gitText(['rev-parse', '--abbrev-ref', 'HEAD'], 8000, 65536)
        const head = await gitText(['rev-parse', 'HEAD'], 8000, 65536)
        const branches = await gitText(['branch', '--format=%(refname:short)'], 8000, 131072)
        const log = await gitText(['log', '--all', '--topo-order', '--format=%H%x00%P%x00%h%x00%an%x00%at%x00%s%x00%D', '-n', '300'], 10000, 262144)
        const status = await gitText(['status', '--porcelain=v1'], 8000, 131072)
        const commits = []
        if (log.exitCode === 0) {
          for (const line of log.text.split('\n')) {
            if (line.length === 0) continue
            const f = line.split('\x00')
            if (f.length < 6) continue
            commits.push({
              hash: f[0],
              parents: f[1].split(' ').filter((p) => p.length > 0),
              shortHash: f[2],
              author: f[3],
              ts: Number(f[4]) || 0,
              subject: f[5],
              refs: f.length > 6 ? f[6] : '',
            })
          }
        }
        const changes = status.exitCode === 0 ? status.text.split('\n').filter((line) => line.length > 0) : []
        return {
          ok: true,
          root,
          branch: branch.exitCode === 0 ? branch.text.trim() : null,
          headHash: head.exitCode === 0 ? head.text.trim() : null,
          branches: branches.exitCode === 0 ? branches.text.split('\n').map((b) => b.trim()).filter((b) => b.length > 0) : [],
          commits,
          dirty: changes.length,
          changes: changes.slice(0, 40),
        }
      } catch (error) {
        return { ok: false, error: errText(error) }
      }
    })

    harness.handle('gitPanelSwitch', async (args) => {
      try {
        const branch = branchArg(args !== null && typeof args === 'object' ? args.branch : undefined)
        if (branch.length === 0) return { ok: false, error: 'invalid branch name' }
        const out = await gitText(['switch', branch], 15000, 131072)
        if (out.exitCode !== 0) return { ok: false, error: out.err.length > 0 ? out.err : 'git switch exited ' + String(out.exitCode) }
        const branchNow = await gitText(['rev-parse', '--abbrev-ref', 'HEAD'], 8000, 65536)
        return { ok: true, switchedTo: branchNow.exitCode === 0 ? branchNow.text.trim() : branch }
      } catch (error) {
        return { ok: false, error: errText(error) }
      }
    })

    harness.handle('gitPanelShow', async (args) => {
      try {
        const ref = refArg(args !== null && typeof args === 'object' ? args.hash : undefined)
        if (ref.length === 0) return { ok: false, error: 'invalid hash' }
        const out = await gitText(['show', '--format=fuller', '--stat', '-p', ref], 15000, 524288)
        if (out.exitCode !== 0) return { ok: false, error: out.err.length > 0 ? out.err : 'git show exited ' + String(out.exitCode) }
        return { ok: true, hash: ref, text: out.text }
      } catch (error) {
        return { ok: false, error: errText(error) }
      }
    })
  },
}