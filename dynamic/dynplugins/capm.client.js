// capmgr 客户端半部 v1.0：能力管理三合一（壳原生）。
// 插件 tab = plins MarketPanel 移植（plinst/* RPC 不变）；技能 tab = sklui SkillPanel 移植（skillui/* RPC 不变）；
// MCP tab = v1 只读清单（capmgr/mcp.list）。chrome/徽章/i18n 上交壳；各自 modal 壳弃用。
return {
  inject: ['forgeShell', 'timer'],
  apply(ctx) {
    const shell = ctx.forgeShell
    const h = React.createElement
    const { useZh, isZhNow } = shell.helpers

    // 徽章图标：图标套件定稿电插销 glyph（能力=插入取电）
    function PlugGlyph() {
      return h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', style: { flex: 'none' } },
        h('path', { d: 'M9 3 v4.5 M15 3 v4.5' }),
        h('path', { d: 'M7 7.5 h10 v4.5 a5 5 0 0 1 -10 0 Z' }),
        h('circle', { cx: 12, cy: 19.4, r: 1.7, fill: 'var(--dsw-alias-accent, #4f7cff)', stroke: 'none' }))
    }


    // ---------- locale 检测（快照字段 active；服务缺席静默回退英文） ----------
    function marketCopy(zh) {
      return zh ? {
        browseFailed: '浏览失败',
        installFailed: '安装失败',
        uninstalled: '已卸载',
        uninstallFailed: '卸载失败',
        missingInjection: '找不到该插件的注入记录（动态清单 / preset 形态请手动清理）',
        own: '自有',
        installed: '已安装',
        ownTitle: '这是我们自己的仓库，开发时本地克隆，无需从市场安装',
        localRepo: '本地仓库',
        uninstalling: '卸载中…',
        uninstall: '卸载',
        installing: '安装中…',
        install: '安装',
        title: '插件市场',
        subtitle: 'GitHub topic dsh-plugin · 安装社区插件到本地 DSH',
        close: '关闭',
        warning: '安装即把第三方代码下载到本机并在 DSH 进程内以你的权限执行（与 dsh plugin add 同样无沙箱隔离）。只安装你审查过来源的仓库。',
        searchPlaceholder: '搜索插件仓库…（默认展示 dsh-plugin 热门）',
        search: '搜索',
        installedCount: (n) => n + ' 个 · 注入器安装，卸载后重启彻底移除',
        loading: '加载中…',
        noMatch: '没有匹配的仓库。',
        badgeTitle: '插件市场（浏览并安装社区插件）',
        badge: '市场',
      } : {
        browseFailed: 'Browse failed',
        installFailed: 'Install failed',
        uninstalled: 'Uninstalled',
        uninstallFailed: 'Uninstall failed',
        missingInjection: 'No injector record found for this plugin (dynamic manifest / preset installs must be cleaned up manually)',
        own: 'Own',
        installed: 'Installed',
        ownTitle: 'This is our own repository; it is cloned locally during development, no need to install it from the market',
        localRepo: 'Local repo',
        uninstalling: 'Uninstalling…',
        uninstall: 'Uninstall',
        installing: 'Installing…',
        install: 'Install',
        title: 'Plugin Market',
        subtitle: 'GitHub topic dsh-plugin · install community plugins into your local DSH',
        close: 'Close',
        warning: 'Installing downloads third-party code to this machine and runs it inside the DSH process with your permissions (no sandbox isolation, same as dsh plugin add). Only install repositories whose source you have reviewed.',
        searchPlaceholder: 'Search plugin repos… (popular dsh-plugin repos shown by default)',
        search: 'Search',
        installedCount: (n) => n + ' · installed via the injector; uninstall + restart removes it entirely',
        loading: 'Loading…',
        noMatch: 'No matching repositories.',
        badgeTitle: 'Plugin market (browse and install community plugins)',
        badge: 'Market',
      }
    }

    styles.insert([
      '[class$="_footerActions"] { flex-direction: column; align-items: stretch; }',
      '[class*="collapsed"] [class$="_footerActions"] { align-items: center; }',
      '.plinst-root { display: flex; align-items: center; flex: 0 1 auto; min-width: 0; position: relative; order: -3; }',
      '.plinst-badge { box-sizing: border-box; width: 100%; height: 49px; display: flex; align-items: center; gap: 8px; padding: 0 8px 0 6px; border: none; border-radius: 12px; cursor: pointer; font-size: 14px; font-family: inherit; color: var(--dsw-alias-label-primary, inherit); background: transparent; }',
      '.plinst-badge:hover { background: var(--dsw-alias-bg-hover, rgba(128,128,128,.08)); }',
      '.plinst-overlay { position: fixed; inset: 0; z-index: 1000; display: flex; justify-content: center; align-items: center; }',
      '.plinst-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.42); backdrop-filter: blur(2px); }',
      '.plinst-panel { position: relative; z-index: 1; width: 840px; max-width: calc(100vw - 48px); height: min(760px, 100vh - 48px); display: flex; flex-direction: column; overflow: hidden; border-radius: 20px; border: 1px solid var(--dsw-alias-border-strong, rgba(128,128,128,.25)); background: var(--dsw-alias-bg-layer-2, #ffffff); color: var(--dsw-alias-label-primary, inherit); box-shadow: 0 18px 48px rgba(0,0,0,.28); font-family: inherit; }',
      '.plinst-header { display: flex; align-items: flex-start; justify-content: space-between; padding: 20px 24px 14px; border-bottom: 1px solid rgba(128,128,128,.14); flex: none; }',
      '.plinst-title { font-size: 17px; font-weight: 650; line-height: 24px; }',
      '.plinst-subtitle { margin-top: 2px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #6b7280); }',
      '.plinst-close { width: 30px; height: 30px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border: none; border-radius: 10px; cursor: pointer; background: transparent; color: var(--dsw-alias-label-secondary, inherit); }',
      '.plinst-close:hover { background: var(--dsw-alias-bg-hover, rgba(128,128,128,.1)); }',
      '.plinst-error { margin: 10px 24px 0; padding: 8px 12px; border-radius: 10px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary, #dc2626); background: rgba(220,38,38,.08); flex: none; }',
      '.plinst-warn { margin: 12px 24px 0; padding: 8px 12px; border-radius: 10px; font-size: 12px; line-height: 18px; color: #92400e; background: rgba(245,158,11,.12); flex: none; }',
      '.plinst-note { margin: 10px 24px 0; padding: 8px 12px; border-radius: 10px; font-size: 12px; line-height: 18px; color: #166534; background: rgba(22,163,74,.09); flex: none; }',
      '.plinst-body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 24px 24px; display: flex; flex-direction: column; }',
      '.plinst-toolbar { display: flex; align-items: center; gap: 8px; flex: none; margin-bottom: 6px; }',
      '.plinst-search { box-sizing: border-box; flex: 1; min-width: 0; border: 1px solid rgba(128,128,128,.3); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, transparent); color: inherit; font-size: 13px; font-family: inherit; padding: 8px 12px; }',
      '.plinst-search:focus { outline: 2px solid var(--dsw-alias-accent, #4f7cff); outline-offset: 0; border-color: transparent; }',
      '.plinst-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #6b7280); padding: 4px 0 8px; }',
      '.plinst-card { border: 1px solid rgba(128,128,128,.16); border-radius: 14px; padding: 12px 14px; margin-bottom: 10px; display: flex; flex-direction: column; gap: 7px; background: var(--dsw-alias-bg-layer-1, transparent); transition: border-color .12s ease, box-shadow .12s ease; }',
      '.plinst-card:hover { border-color: rgba(128,128,128,.34); box-shadow: 0 3px 12px rgba(0,0,0,.06); }',
      '.plinst-card-head { display: flex; align-items: center; gap: 8px; }',
      '.plinst-repo { flex: 1; min-width: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.plinst-stars { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #6b7280); flex: none; }',
      '.plinst-desc { font-size: 12.5px; line-height: 18px; color: var(--dsw-alias-label-secondary, inherit); }',
      '.plinst-topics { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }',
      '.plinst-topic { display: inline-flex; height: 18px; padding: 0 7px; align-items: center; border-radius: 6px; font-size: 11px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #6b7280); background: rgba(128,128,128,.12); }',
      '.plinst-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }',
      '.plinst-btn { border: 1px solid rgba(128,128,128,.28); background: transparent; color: var(--dsw-alias-label-secondary, inherit); border-radius: 8px; height: 28px; padding: 0 14px; cursor: pointer; font-size: 12px; font-family: inherit; }',
      '.plinst-btn:hover { background: var(--dsw-alias-bg-hover, rgba(128,128,128,.08)); }',
      '.plinst-btn:disabled { opacity: .45; cursor: default; }',
      '.plinst-btn-primary { color: #ffffff; background: var(--dsw-alias-accent, #4f7cff); border-color: transparent; }',
      '.plinst-btn-primary:hover { filter: brightness(1.06); }',
      '.plinst-btn-danger { color: #dc2626; border-color: rgba(220,38,38,.35); }',
      '.plinst-btn-danger:hover { background: rgba(220,38,38,.07); }',
      '.plinst-section { display: flex; align-items: center; gap: 8px; margin: 12px 0 8px; font-size: 12px; font-weight: 650; color: var(--dsw-alias-label-tertiary, #6b7280); text-transform: uppercase; letter-spacing: .04em; }',
      '.plinst-section-count { font-size: 11px; font-weight: 500; color: var(--dsw-alias-label-tertiary, #9ca3af); text-transform: none; letter-spacing: 0; }',
      '.plinst-installed { border: 1px solid rgba(22,163,74,.28); background: rgba(22,163,74,.05); border-radius: 14px; padding: 6px 12px 12px; margin-bottom: 14px; }',
      '.plinst-row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 9px; font-size: 12.5px; }',
      '.plinst-row:hover { background: var(--dsw-alias-bg-hover, rgba(128,128,128,.06)); }',
      '.plinst-row-name { flex: 1; min-width: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.plinst-empty { padding: 26px 0; text-align: center; font-size: 13px; color: var(--dsw-alias-label-tertiary, #6b7280); }',
    ].join('\n'))

    const StarIcon = () => React.createElement('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true' },
      React.createElement('path', { d: 'M8 1.5l1.9 4.1 4.6.5-3.4 3.1.9 4.5L8 11.7l-4 2 .9-4.5-3.4-3.1 4.6-.5L8 1.5z' }))


    // ---------- locale 检测（快照字段 active；服务缺席静默回退英文） ----------
    function skillCopy(zh) {
      return zh ? {
        loadFailed: '读取技能列表失败',
        opFailed: '操作失败',
        enabled: '已启用',
        disabled: '已禁用',
        previewContent: '预览内容',
        collapse: '收起',
        preview: '预览',
        disable: '禁用',
        enable: '启用',
        confirmDelete: (name) => '删除技能 ' + name + '？此操作不可恢复。',
        modelInvokable: '模型可调',
        userInvokable: '/ 命令可调',
        injectOnTitle: '已默认注入系统提示（每轮常驻）；点击切换为渐进式披露（模型需要时用 skill 工具加载）',
        injectOffTitle: '渐进式披露（模型需要时加载）；点击切换为默认注入（全文常驻系统提示）',
        injectOn: '默认注入 ✓',
        injectOff: '默认注入',
        providerTitle: (p) => '由 ' + p + ' 提供，停用需停用对应插件/preset',
        othersSection: '其他可见技能',
        othersCount: (n) => n + ' 个 · 只读',
        othersHint: '这些技能由宿主插件（runtime）或 preset（filesystem）提供，生命周期归提供方；要停用请停用对应插件或 preset。',
        addTitle: '添加技能',
        nameLabel: '名称（小写 + 连字符）',
        namePlaceholder: '例如：file-edit-protocol（小写 + 连字符）',
        descLabel: '一句话描述',
        descPlaceholder: '一句话说明这个技能做什么、什么时候用',
        whenLabel: '使用时机（可选）',
        whenPlaceholder: '例如：用户要求先读后写时使用',
        contentLabel: 'Markdown 指令正文',
        contentPlaceholder: '# 技能标题\n\n写明这个技能的规则、步骤与注意事项（支持 Markdown）',
        modelInvocableLabel: '模型可调用',
        userInvocableLabel: '用户 / 命令可调用',
        alwaysInjectLabel: '默认注入系统提示（常驻全文，适合纪律类规则）',
        cancel: '取消',
        panelTitle: '技能管理',
        loading: '加载中…',
        close: '关闭',
        emptyTitle: '还没有持久化技能',
        emptyHint: '创建一个技能，让模型在需要时自动加载它的指令',
        addCta: '＋ 添加技能',
        footerCount: (n) => n + ' 个技能 · 保存在宿主持久层',
        badgeTitle: '管理技能（添加 / 启用 / 禁用 / 删除）',
        badge: '技能',
      } : {
        loadFailed: 'Failed to load the skill list',
        opFailed: 'Operation failed',
        enabled: 'Enabled',
        disabled: 'Disabled',
        previewContent: 'Preview content',
        collapse: 'Collapse',
        preview: 'Preview',
        disable: 'Disable',
        enable: 'Enable',
        confirmDelete: (name) => 'Delete skill ' + name + '? This cannot be undone.',
        modelInvokable: 'Model-invocable',
        userInvokable: '/ command',
        injectOnTitle: 'Injected into the system prompt by default (every turn); click to switch to progressive disclosure (the model loads it with the skill tool when needed)',
        injectOffTitle: 'Progressive disclosure (loaded when the model needs it); click to switch to default injection (full text always in the system prompt)',
        injectOn: 'Always inject ✓',
        injectOff: 'Always inject',
        providerTitle: (p) => 'Provided by ' + p + '; to disable it, disable the corresponding plugin/preset',
        othersSection: 'Other visible skills',
        othersCount: (n) => n + ' · read-only',
        othersHint: 'These skills are provided by host plugins (runtime) or presets (filesystem); their lifecycle belongs to the provider. To disable one, disable the corresponding plugin or preset.',
        addTitle: 'Add skill',
        nameLabel: 'Name (lowercase + hyphens)',
        namePlaceholder: 'e.g. file-edit-protocol (lowercase + hyphens)',
        descLabel: 'One-line description',
        descPlaceholder: 'One line on what this skill does and when to use it',
        whenLabel: 'When to use (optional)',
        whenPlaceholder: 'e.g. use when the user requires read-before-write',
        contentLabel: 'Markdown instruction body',
        contentPlaceholder: '# Skill title\n\nWrite the rules, steps, and notes for this skill (Markdown supported)',
        modelInvocableLabel: 'Model-invocable',
        userInvocableLabel: 'User / command invocable',
        alwaysInjectLabel: 'Always inject into the system prompt (full text every turn; good for discipline rules)',
        cancel: 'Cancel',
        panelTitle: 'Skill Manager',
        loading: 'Loading…',
        close: 'Close',
        emptyTitle: 'No persistent skills yet',
        emptyHint: 'Create a skill and the model will load its instructions automatically when needed',
        addCta: '+ Add skill',
        footerCount: (n) => n + ' skills · persisted in the host store',
        badgeTitle: 'Manage skills (add / enable / disable / delete)',
        badge: 'Skills',
      }
    }

    styles.insert([
      '[class$="_footerActions"] { flex-direction: column; align-items: stretch; }',
      '[class*="collapsed"] [class$="_footerActions"] { align-items: center; }',
      '.skillui-root { display: flex; align-items: center; flex: 0 1 auto; min-width: 0; position: relative; order: -2; }',
      '.skillui-badge { box-sizing: border-box; width: 100%; height: 49px; display: flex; align-items: center; gap: 8px; padding: 0 8px 0 6px; border: none; border-radius: 12px; cursor: pointer; font-size: 14px; font-family: inherit; color: var(--dsw-alias-label-primary, inherit); background: transparent; }',
      '.skillui-badge:hover { background: var(--dsw-alias-bg-hover, rgba(128,128,128,.08)); }',
      '.skillui-overlay { position: fixed; inset: 0; z-index: 1000; display: flex; justify-content: center; align-items: center; }',
      '.skillui-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.42); backdrop-filter: blur(2px); }',
      '.skillui-panel { position: relative; z-index: 1; width: 820px; max-width: calc(100vw - 48px); height: min(760px, 100vh - 48px); display: flex; flex-direction: column; overflow: hidden; border-radius: 20px; border: 1px solid var(--dsw-alias-border-strong, rgba(128,128,128,.25)); background: var(--dsw-alias-bg-layer-2, #ffffff); color: var(--dsw-alias-label-primary, inherit); box-shadow: 0 18px 48px rgba(0,0,0,.28); font-family: inherit; }',
      '.skillui-header { display: flex; align-items: flex-start; justify-content: space-between; padding: 20px 24px 14px; border-bottom: 1px solid rgba(128,128,128,.14); flex: none; }',
      '.skillui-title { font-size: 17px; font-weight: 650; line-height: 24px; }',
      '.skillui-subtitle { margin-top: 2px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #6b7280); word-break: break-all; }',
      '.skillui-close { width: 30px; height: 30px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border: none; border-radius: 10px; cursor: pointer; background: transparent; color: var(--dsw-alias-label-secondary, inherit); }',
      '.skillui-close:hover { background: var(--dsw-alias-bg-hover, rgba(128,128,128,.1)); }',
      '.skillui-error { margin: 10px 24px 0; padding: 8px 12px; border-radius: 10px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary, #dc2626); background: rgba(220,38,38,.08); flex: none; }',
      '.skillui-body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 24px 24px; display: flex; flex-direction: column; gap: 10px; }',
      '.skillui-empty { padding: 34px 0; text-align: center; font-size: 13px; color: var(--dsw-alias-label-tertiary, #6b7280); }',
      '.skillui-card { border: 1px solid rgba(128,128,128,.16); border-radius: 14px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; background: var(--dsw-alias-bg-layer-1, transparent); transition: border-color .12s ease, box-shadow .12s ease; }',
      '.skillui-card:hover { border-color: rgba(128,128,128,.34); box-shadow: 0 3px 12px rgba(0,0,0,.06); }',
      '.skillui-card-head { display: flex; align-items: center; gap: 8px; }',
      '.skillui-name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.skillui-pill { display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 9px; border-radius: 999px; font-size: 11px; line-height: 20px; flex: none; }',
      '.skillui-pill-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }',
      '.skillui-pill-on { color: #16a34a; background: rgba(22,163,74,.12); }',
      '.skillui-pill-off { color: #9ca3af; background: rgba(128,128,128,.14); }',
      '.skillui-desc { font-size: 12.5px; line-height: 18px; color: var(--dsw-alias-label-secondary, inherit); }',
      '.skillui-tags { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }',
      '.skillui-tag { display: inline-flex; height: 18px; padding: 0 7px; align-items: center; border-radius: 6px; font-size: 11px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #6b7280); background: rgba(128,128,128,.12); }',
      '.skillui-tag-btn { cursor: pointer; border: none; font-family: inherit; }',
      '.skillui-tag-btn:hover { filter: brightness(1.08); }',
      '.skillui-tag-inject { color: #7c3aed; background: rgba(124,58,237,.12); }',
      '.skillui-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }',
      '.skillui-btn { border: 1px solid rgba(128,128,128,.28); background: transparent; color: var(--dsw-alias-label-secondary, inherit); border-radius: 8px; height: 26px; padding: 0 12px; cursor: pointer; font-size: 12px; font-family: inherit; }',
      '.skillui-btn:hover { background: var(--dsw-alias-bg-hover, rgba(128,128,128,.08)); }',
      '.skillui-btn:disabled { opacity: .45; cursor: default; }',
      '.skillui-btn-danger { color: #dc2626; border-color: rgba(220,38,38,.35); }',
      '.skillui-btn-danger:hover { background: rgba(220,38,38,.07); }',
      '.skillui-btn-primary { color: #ffffff; background: #3b82f6; border-color: transparent; font-weight: 600; }',
      '.skillui-btn-primary:hover { background: #2563eb; filter: none; }',
      '.skill-expand-btn { width: 28px; height: 28px; padding: 0; border-radius: 50%; border: 1px solid rgba(128,128,128,.28); background: transparent; color: #6b7280; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; flex: none; transition: background-color .15s ease, border-color .15s ease, color .15s ease; }',
      '.skill-expand-btn svg { width: 14px; height: 14px; transition: transform .18s ease; }',
      '.skill-expand-btn:hover { background: rgba(0,0,0,.05); border-color: rgba(128,128,128,.5); color: #374151; }',
      '.skill-expand-btn:disabled { opacity: .45; cursor: default; }',
      '.skill-expand-btn-expanded { background: rgba(59,130,246,.08); border-color: rgba(59,130,246,.35); color: #3b82f6; }',
      '.skill-expand-btn-expanded:hover { background: rgba(59,130,246,.14); color: #3b82f6; }',
      '.skill-expand-btn-expanded svg { transform: rotate(90deg); }',
      '.skillui-card-head-click { cursor: pointer; }',
      '.skillui-section { display: flex; align-items: center; gap: 8px; margin: 14px 0 8px; font-size: 12px; font-weight: 650; color: var(--dsw-alias-label-tertiary, #6b7280); text-transform: uppercase; letter-spacing: .04em; }',
      '.skillui-section-count { font-size: 11px; font-weight: 500; color: var(--dsw-alias-label-tertiary, #9ca3af); text-transform: none; letter-spacing: 0; }',
      '.skillui-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #6b7280); margin-bottom: 6px; }',
      '.skillui-ro-row { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; padding: 7px 10px; border-radius: 9px; }',
      '.skillui-ro-row:hover { background: var(--dsw-alias-bg-hover, rgba(128,128,128,.06)); }',
      '.skillui-ro-name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; font-weight: 600; flex: none; }',
      '.skillui-ro-desc { flex-basis: 100%; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #6b7280); margin-top: -2px; }',
      '      .skillui-content { margin: 2px 0 0; padding: 12px 14px; border-radius: 10px; background: rgba(128,128,128,.07); border: 1px solid rgba(128,128,128,.12); font-size: 12.5px; line-height: 1.55; word-break: break-word; max-height: 260px; overflow-y: auto; }',
      '.skillui-form { border: 1px dashed rgba(128,128,128,.4); border-radius: 14px; padding: 14px; display: flex; flex-direction: column; gap: 10px; }',
      '.skillui-field { display: flex; flex-direction: column; gap: 4px; }',
      '.skillui-label { font-size: 11.5px; font-weight: 600; color: var(--dsw-alias-label-tertiary, #6b7280); }',
      '.skillui-input { box-sizing: border-box; width: 100%; border: 1px solid rgba(128,128,128,.3); border-radius: 9px; background: var(--dsw-alias-bg-layer-1, transparent); color: inherit; font-size: 13px; font-family: inherit; padding: 7px 10px; }',
      '.skillui-input:focus { outline: 2px solid var(--dsw-alias-accent, #4f7cff); outline-offset: 0; border-color: transparent; }',
      '.skillui-textarea { min-height: 110px; resize: vertical; line-height: 1.5; }',
      '.skillui-checks { display: flex; gap: 18px; align-items: center; }',
      '.skillui-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--dsw-alias-label-secondary, inherit); cursor: pointer; }',
      '.skillui-footer { display: flex; align-items: center; justify-content: space-between; flex: none; padding: 12px 24px; border-top: 1px solid rgba(128,128,128,.14); }',
      '.skillui-md-p { margin: 0 0 6px; }',
      '.skillui-md-p:last-child { margin-bottom: 0; }',
      '.skillui-md-h { margin: 10px 0 4px; line-height: 1.4; }',
      '.skillui-md-h1 { font-size: 15.5px; }',
      '.skillui-md-h2 { font-size: 14.5px; }',
      '.skillui-md-h3 { font-size: 13.5px; }',
      '.skillui-md-h4, .skillui-md-h5, .skillui-md-h6 { font-size: 12.5px; }',
      '.skillui-md-list { margin: 2px 0 6px; padding-left: 20px; }',
      '.skillui-md-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: rgba(128,128,128,.14); padding: 1px 5px; border-radius: 5px; font-size: 11.5px; }',
      '.skillui-md-pre { margin: 4px 0 8px; padding: 10px 12px; background: rgba(128,128,128,.08); border: 1px solid rgba(128,128,128,.14); border-radius: 8px; overflow-x: auto; }',
      '.skillui-md-pre code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; line-height: 1.5; white-space: pre; }',
      '.skillui-md-link { color: var(--dsw-alias-accent, #4f7cff); text-decoration: none; }',
      '.skillui-md-link:hover { text-decoration: underline; }',
      '.skillui-md-quote { margin: 2px 0 6px; padding: 2px 0 2px 10px; border-left: 3px solid rgba(128,128,128,.35); color: var(--dsw-alias-label-tertiary, #6b7280); }',
      '.skillui-md-hr { border: none; border-top: 1px solid rgba(128,128,128,.18); margin: 8px 0; }',
      '.skillui-modal { position: fixed; inset: 0; z-index: 1100; display: flex; justify-content: center; align-items: center; }',
      '.skillui-modal-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.42); backdrop-filter: blur(2px); }',
      '.skillui-modal-panel { position: relative; z-index: 1; width: 600px; max-width: calc(100vw - 48px); max-height: calc(100vh - 48px); overflow-y: auto; display: flex; flex-direction: column; gap: 14px; padding: 20px 24px; border-radius: 16px; border: 1px solid var(--dsw-alias-border-strong, rgba(128,128,128,.25)); background: var(--dsw-alias-bg-layer-2, #ffffff); color: var(--dsw-alias-label-primary, inherit); box-shadow: 0 18px 48px rgba(0,0,0,.28); font-family: inherit; }',
      '.skillui-modal-title { font-size: 15px; font-weight: 650; line-height: 22px; }',
      '.skillui-modal-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }',
    ].join('\n'))

    const Icon = (kind, extraStyle) => {
      const paths = {
        spark: 'M12 2l1.9 5.7L19.6 9.6l-5.7 1.9L12 17.2l-1.9-5.7L4.4 9.6l5.7-1.9L12 2zM19 14l.95 2.85L22.8 17.8l-2.85.95L19 21.6l-.95-2.85-2.85-.95 2.85-.95L19 14zM5 15l.7 2.1 2.1.7-2.1.7L5 20.6l-.7-2.1-2.1-.7 2.1-.7L5 15z',
        close: 'M6.3 5.3L12 11l5.7-5.7 1.3 1.3L13.3 12l5.7 5.7-1.3 1.3L12 13.3l-5.7 5.7-1.3-1.3L10.7 12 5 6.6l1.3-1.3z',
        trash: 'M9 3h6l1 2h4v2H4V5h4l1-2zM6 9h12l-.8 11.1c-.05.9-.8 1.9-1.7 1.9H8.5c-.9 0-1.65-1-1.7-1.9L6 9zm4 2v7h2v-7h-2zm4 0v7h2v-7h-2z',
        plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5z',
        chevron: 'M8.5 11.9l4.6-4.6 1.3 1.3-4.6 4.6 4.6 4.6-1.3 1.3-5.9-5.9z',
        chevronUp: 'M12.1 15.5l-4.6-4.6-1.3 1.3 4.6 4.6-4.6 4.6 1.3 1.3 5.9-5.9z',
        chevronDown: 'M12.1 8.5l-4.6 4.6-1.3-1.3 4.6-4.6-4.6-4.6 1.3-1.3 5.9 5.9z',
      }
      return React.createElement('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true', style: extraStyle },
        React.createElement('path', { d: paths[kind] ?? paths.spark }))
    }


    // ── mini markdown renderer (no external deps; safe createElement-only) ──
    function inlineSpans(text) {
      const out = []
      const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)\s]+\))/g
      let last = 0
      let m
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) out.push(text.slice(last, m.index))
        if (m[1] !== undefined) out.push(React.createElement('code', { className: 'skillui-md-code' }, m[1].slice(1, -1)))
        else if (m[2] !== undefined) out.push(React.createElement('strong', null, inlineSpans(m[2].slice(2, -2))))
        else if (m[3] !== undefined) out.push(React.createElement('em', null, inlineSpans(m[3].slice(1, -1))))
        else {
          const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(m[4])
          if (link !== null) out.push(React.createElement('a', { className: 'skillui-md-link', href: link[2], target: '_blank', rel: 'noreferrer' }, inlineSpans(link[1])))
          else out.push(m[4])
        }
        last = re.lastIndex
      }
      if (last < text.length) out.push(text.slice(last))
      return out
    }

    function mdToNodes(md) {
      if (typeof md !== 'string' || md.trim() === '') return null
      const lines = md.replace(/\r\n?/g, '\n').split('\n')
      const out = []
      let i = 0
      let para = []
      let list = null
      let code = null
      const flushPara = () => { if (para.length > 0) { out.push(React.createElement('p', { className: 'skillui-md-p', key: out.length }, inlineSpans(para.join(' ')))); para = [] } }
      const flushList = () => { if (list !== null) { out.push(React.createElement(list.ordered ? 'ol' : 'ul', { className: 'skillui-md-list', key: out.length }, list.items.map((it, j) => React.createElement('li', { key: j }, inlineSpans(it))))); list = null } }
      const flushCode = () => { if (code !== null) { out.push(React.createElement('pre', { className: 'skillui-md-pre', key: out.length }, React.createElement('code', null, code.buf.join('\n')))); code = null } }
      while (i < lines.length) {
        const line = lines[i]
        if (code !== null) {
          if (/^```/.test(line.trim())) { flushCode(); i += 1; continue }
          code.buf.push(line); i += 1; continue
        }
        if (/^```/.test(line.trim())) { flushPara(); flushList(); code = { buf: [] }; i += 1; continue }
        const h = /^(#{1,6})\s+(.*)$/.exec(line)
        if (h !== null) { flushPara(); flushList(); out.push(React.createElement('h' + h[1].length, { className: 'skillui-md-h skillui-md-h' + h[1].length, key: out.length }, inlineSpans(h[2]))); i += 1; continue }
        if (/^\s*(?:---|\*\*\*)\s*$/.test(line)) { flushPara(); flushList(); out.push(React.createElement('hr', { className: 'skillui-md-hr', key: out.length })); i += 1; continue }
        const ul = /^\s*[-*+]\s+(.*)$/.exec(line)
        const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line)
        if (ul !== null || ol !== null) { flushPara(); if (list === null || list.ordered !== (ol !== null)) { flushList(); list = { ordered: ol !== null, items: [] } } list.items.push((ul ?? ol)[1]); i += 1; continue }
        if (/^\s*>\s?/.test(line)) { flushPara(); flushList(); out.push(React.createElement('blockquote', { className: 'skillui-md-quote', key: out.length }, inlineSpans(line.replace(/^\s*>\s?/, '')))); i += 1; continue }
        if (line.trim() === '') { flushPara(); flushList(); i += 1; continue }
        para.push(line.trim()); i += 1
      }
      flushPara(); flushList(); flushCode()
      return out
    }


    function capv2Copy(zh) {
      return zh ? {
        capsTitle: '运行能力', dynbootGroup: '自动加载插件（dynboot）', injectorGroup: '注入器包（injector）',
        running: '运行中', hotStopped: '已热停（重启后恢复）', disabled: '已禁用',
        enable: '启用', disable: '禁用', hotStop: '热停',
        restartHint: '已写入配置，重启 DSH 后生效', enableRestart: '启用将在重启后生效',
        hotStoppedNote: '已热停（仅当前进程；重启后按配置恢复）',
        configBtn: '配置', plasmidCfg: '质粒注入', save: '保存', saved: '已保存，重启 DSH 后生效',
        loadFailed: '加载失败', saveFailed: '保存失败',
        featswTitle: '功能开关（featsw）',
        featswBody: '核心系统尚在 backlog（dsh-forge §7，FR-1..12）。落地后此区提供 surface/gate 双层开关与 profile 切换——开关做在调用面上，不做在插件生命周期上。',
        defModel: '默认模型', setDefault: '设为默认', defaultSaved: '默认模型已更新（新会话生效；现有会话用输入框旁的选择器切换）',
        providersTitle: 'Provider 列表', login: '登录', relogin: '重新登录', loggedIn: '有订阅登录 flow', noFlow: '无订阅登录',
        authWaiting: '等待授权…', authOpenHint: '在浏览器打开链接并输入验证码完成授权：', authDone: '登录完成', authCancelled: '已取消', authFailed: '登录失败',
        cancel: '取消', refresh: '刷新', modelsUnit: '个模型', chooseProvider: '选择 provider', chooseModel: '选择模型',
      } : {
        capsTitle: 'Runtime capabilities', dynbootGroup: 'Auto-loaded plugins (dynboot)', injectorGroup: 'Injector packages',
        running: 'running', hotStopped: 'hot-stopped (returns after restart)', disabled: 'disabled',
        enable: 'Enable', disable: 'Disable', hotStop: 'Hot stop',
        restartHint: 'Written; takes effect after a DSH restart', enableRestart: 'Enabling requires a restart',
        hotStoppedNote: 'Hot-stopped (this process only; restored from config on restart)',
        configBtn: 'Configure', plasmidCfg: 'Plasmid injection', save: 'Save', saved: 'Saved; takes effect after a DSH restart',
        loadFailed: 'Load failed', saveFailed: 'Save failed',
        featswTitle: 'Feature switches (featsw)',
        featswBody: 'The core system is still in the backlog (dsh-forge §7, FR-1..12). Once landed this area offers surface/gate switches and profiles — switches live on the call surface, not the plugin lifecycle.',
        defModel: 'Default model', setDefault: 'Set as default', defaultSaved: 'Default model updated (new sessions; switch live sessions via the composer picker)',
        providersTitle: 'Providers', login: 'Sign in', relogin: 'Sign in again', loggedIn: 'subscription flow available', noFlow: 'no subscription flow',
        authWaiting: 'Waiting for authorization…', authOpenHint: 'Open the link in a browser and enter the code:', authDone: 'Signed in', authCancelled: 'Cancelled', authFailed: 'Sign-in failed',
        cancel: 'Cancel', refresh: 'Refresh', modelsUnit: 'models', chooseProvider: 'Choose a provider', chooseModel: 'Choose a model',
      }
    }

    // ── 运行能力区：dynboot/injector 启停 + 质粒抽屉 + featsw 占位 ──
    function CapsSection() {
      const zh = useZh()
      const t = capv2Copy(zh)
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [note, setNote] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [drawerOpen, setDrawerOpen] = React.useState(false)
      const load = () => {
        host.call('capmgr/caps.list').then((r) => {
          if (r !== null && typeof r === 'object' && r.ok === true) setData(r)
          else setErr(r !== null && typeof r === 'object' && typeof r.error === 'string' ? r.error : t.loadFailed)
        }).catch((f) => setErr(String(f && f.message ? f.message : f)))
      }
      React.useEffect(() => { load() }, [])
      const act = (method, args, busyKey) => {
        setBusy(busyKey); setErr(null); setNote(null)
        host.call(method, args).then((r) => {
          setBusy('')
          if (r !== null && typeof r === 'object' && r.ok === true) {
            setNote(method.endsWith('hotStop') ? t.hotStoppedNote : t.restartHint)
            load()
          } else setErr(r !== null && typeof r === 'object' && typeof r.error === 'string' ? r.error : t.saveFailed)
        }).catch((f) => { setBusy(''); setErr(String(f && f.message ? f.message : f)) })
      }
      const rows = (list, kind) => (Array.isArray(list) ? list : []).map((r) => {
        const key = kind + ':' + r.id
        const stateText = r.disabled === true ? t.disabled : (r.running === true ? t.running : (kind === 'dynboot' ? t.hotStopped : t.disabled))
        return React.createElement('div', { key, className: 'capv2-row' },
          React.createElement('span', { className: 'plsm-dot ' + (r.disabled === true ? 'plsm-dot-rejected' : (r.running === true ? 'plsm-dot-active' : 'plsm-dot-rejected')) }),
          React.createElement('span', { className: 'capv2-name', title: r.purpose || r.dir || '' }, r.name || r.id),
          React.createElement('span', { className: 'capv2-state' }, stateText),
          kind === 'dynboot' && r.running === true && r.disabled !== true && data !== null && data.hotStopAvailable === true
            ? React.createElement('button', { type: 'button', className: 'capv2-btn', disabled: busy === key, onClick: () => act('capmgr/caps.hotStop', { id: r.id }, key) }, t.hotStop) : null,
          r.disabled === true
            ? React.createElement('button', { type: 'button', className: 'capv2-btn', title: t.enableRestart, disabled: busy === key, onClick: () => act('capmgr/caps.setDisabled', { kind, id: r.id, disabled: false }, key) }, t.enable)
            : React.createElement('button', { type: 'button', className: 'capv2-btn', title: t.restartHint, disabled: busy === key, onClick: () => act('capmgr/caps.setDisabled', { kind, id: r.id, disabled: true }, key) }, t.disable))
      })
      return React.createElement('div', { className: 'capv2-caps' },
        React.createElement('div', { className: 'plinst-section' }, t.capsTitle),
        err !== null ? React.createElement('div', { className: 'plinst-error' }, err) : null,
        note !== null ? React.createElement('div', { className: 'plinst-note' }, note) : null,
        data === null ? React.createElement('div', { className: 'capv2-dim' }, '…') : React.createElement(React.Fragment, null,
          React.createElement('div', { className: 'capv2-group' }, t.dynbootGroup),
          rows(data.dynboot, 'dynboot'),
          React.createElement('div', { className: 'capv2-group' }, t.injectorGroup),
          rows(data.injector, 'injector'),
          React.createElement('div', { className: 'capv2-row capv2-cfgcard' },
            React.createElement('span', { className: 'capv2-name' }, t.plasmidCfg),
            React.createElement('button', { type: 'button', className: 'capv2-btn', onClick: () => setDrawerOpen(!drawerOpen) }, t.configBtn + (drawerOpen ? ' ▸' : ' ▸'))),
          drawerOpen === true ? React.createElement(PlasmidDrawer, { zh, t }) : null,
          React.createElement('div', { className: 'capv2-featsw' },
            React.createElement('div', { className: 'capv2-group' }, t.featswTitle),
            React.createElement('div', { className: 'capv2-dim' }, t.featswBody))))
    }

    function PlasmidDrawer(props) {
      const zh = props.zh
      const t = props.t
      const [values, setValues] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [note, setNote] = React.useState(null)
      const [saving, setSaving] = React.useState(false)
      React.useEffect(() => {
        host.call('capmgr/plasmid.config.get').then((r) => {
          if (r !== null && typeof r === 'object' && r.ok === true) setValues(r.values)
          else setErr(r !== null && typeof r === 'object' && typeof r.error === 'string' ? r.error : t.loadFailed)
        }).catch((f) => setErr(String(f && f.message ? f.message : f)))
      }, [])
      if (values === null) return React.createElement('div', { className: 'capv2-dim' }, err !== null ? err : '…')
      const setV = (k, v) => setValues(Object.assign({}, values, { [k]: v }))
      const boolRow = (k, label) => React.createElement('label', { key: k, className: 'capv2-field' },
        React.createElement('input', { type: 'checkbox', checked: values[k] === true, onChange: (e) => setV(k, e.target.checked) }),
        React.createElement('span', null, label))
      const save = () => {
        setSaving(true); setErr(null); setNote(null)
        host.call('capmgr/plasmid.config.set', { values }).then((r) => {
          setSaving('')
          if (r !== null && typeof r === 'object' && r.ok === true) setNote(t.saved)
          else setErr(r !== null && typeof r === 'object' && typeof r.error === 'string' ? r.error : t.saveFailed)
        }).catch((f) => { setSaving(false); setErr(String(f && f.message ? f.message : f)) })
      }
      return React.createElement('div', { className: 'capv2-drawer' },
        boolRow('inject.enabled', zh ? '注入通道（任务开始差量注入总闸）' : 'Injection channel (master switch)'),
        React.createElement('label', { className: 'capv2-field' },
          React.createElement('span', null, zh ? '每次注入条数 k（0-10）' : 'topK (0-10)'),
          React.createElement('input', { type: 'number', min: 0, max: 10, value: values['inject.topK'], onChange: (e) => setV('inject.topK', parseInt(e.target.value, 10)) })),
        React.createElement('label', { className: 'capv2-field' },
          React.createElement('span', null, zh ? '相关度阈值（0-1）' : 'minRelevance (0-1)'),
          React.createElement('input', { type: 'number', min: 0, max: 1, step: 0.05, value: values['inject.minRelevance'], onChange: (e) => setV('inject.minRelevance', parseFloat(e.target.value)) })),
        React.createElement('label', { className: 'capv2-field' },
          React.createElement('span', null, zh ? '匹配器' : 'Matcher'),
          React.createElement('select', { value: values['inject.matcher'], onChange: (e) => setV('inject.matcher', e.target.value) },
            ['lexical', 'llm', 'vector'].map((m) => React.createElement('option', { key: m, value: m }, m)))),
        boolRow('nudge.enabled', zh ? '报错轻推' : 'Error nudge'),
        React.createElement('label', { className: 'capv2-field' },
          React.createElement('span', null, zh ? '每任务每质粒提醒上限（1-5）' : 'Nudge cap per task/plasmid (1-5)'),
          React.createElement('input', { type: 'number', min: 1, max: 5, value: values['nudge.perTaskPerPlasmid'], onChange: (e) => setV('nudge.perTaskPerPlasmid', parseInt(e.target.value, 10)) })),
        boolRow('broadcast.enabled', zh ? '半径广播' : 'Broadcast'),
        boolRow('broadcast.globalByDefault', zh ? 'global 广播默认开（L3 慎用）' : 'global broadcast by default'),
        err !== null ? React.createElement('div', { className: 'plinst-error' }, err) : null,
        note !== null ? React.createElement('div', { className: 'plinst-note' }, note) : null,
        React.createElement('button', { type: 'button', className: 'capv2-btn capv2-primary', disabled: saving === true, onClick: save }, t.save))
    }

    // ── 模型 tab：provider 清单 + 订阅登录 + 默认模型 ──
    function ModelsTab() {
      const zh = useZh()
      const t = capv2Copy(zh)
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [note, setNote] = React.useState(null)
      const [selProvider, setSelProvider] = React.useState('')
      const [catalog, setCatalog] = React.useState(null)
      const [selModel, setSelModel] = React.useState('')
      const [authKey, setAuthKey] = React.useState('')
      const [authState, setAuthState] = React.useState(null)
      const load = () => {
        host.call('capmgr/model.state').then((r) => {
          if (r !== null && typeof r === 'object' && r.ok === true) setData(r)
          else setErr(r !== null && typeof r === 'object' && typeof r.error === 'string' ? r.error : t.loadFailed)
        }).catch((f) => setErr(String(f && f.message ? f.message : f)))
      }
      React.useEffect(() => { load() }, [])
      // 登录轮询：timer 服务可用时 1.5s 一跳，直到 done
      React.useEffect(() => {
        if (authKey === '') return
        const tick = () => {
          host.call('capmgr/auth.status', { key: authKey }).then((r) => {
            if (r !== null && typeof r === 'object' && r.ok === true) {
              setAuthState(r)
              if (r.phase === 'done') { setAuthKey(''); load() }
            }
          }).catch(() => {})
        }
        tick()
        let setIv = undefined
        try { setIv = ctx.setInterval } catch (e) { /* guard：未暴露即抛 */ }
        if (typeof setIv === 'function') {
          const stop = setIv(tick, 1500)
          return () => { try { stop() } catch (e) {} }
        }
        return undefined
      }, [authKey])
      const pickProvider = (pid) => {
        setSelProvider(pid); setSelModel(''); setCatalog(null)
        host.call('capmgr/model.catalog', { provider: pid }).then((r) => {
          if (r !== null && typeof r === 'object' && r.ok === true) setCatalog(r.models)
        }).catch(() => {})
      }
      const saveDefault = () => {
        setErr(null); setNote(null)
        host.call('capmgr/model.setDefault', { provider: selProvider, model: selModel }).then((r) => {
          if (r !== null && typeof r === 'object' && r.ok === true) { setNote(t.defaultSaved); load() }
          else setErr(r !== null && typeof r === 'object' && typeof r.error === 'string' ? r.error : t.saveFailed)
        }).catch((f) => setErr(String(f && f.message ? f.message : f)))
      }
      const beginAuth = (key) => {
        setAuthKey(key); setAuthState(null); setErr(null)
        host.call('capmgr/auth.begin', { key }).then((r) => {
          if (r === null || typeof r !== 'object' || r.ok !== true) {
            setErr(r !== null && typeof r === 'object' && typeof r.error === 'string' ? r.error : t.authFailed)
            setAuthKey('')
          }
        }).catch((f) => { setErr(String(f && f.message ? f.message : f)); setAuthKey('') })
      }
      if (data === null) return React.createElement('div', { className: 'capmgr-mcp' }, React.createElement('div', { className: 'capv2-dim' }, err !== null ? err : '…'))
      const providers = Array.isArray(data.providers) ? data.providers : []
      const def = data.def !== null && typeof data.def === 'object' ? data.def : null
      return React.createElement('div', { className: 'capmgr-mcp' },
        React.createElement('div', { className: 'plinst-section' }, t.defModel),
        React.createElement('div', { className: 'capv2-row' },
          React.createElement('span', { className: 'capv2-name' }, def !== null ? def.provider + ' / ' + def.model : '—'),
          React.createElement('select', { className: 'capv2-sel', value: selProvider, onChange: (e) => pickProvider(e.target.value) },
            React.createElement('option', { value: '' }, t.chooseProvider),
            providers.map((p) => React.createElement('option', { key: p.id, value: p.id }, p.name + ' (' + p.id + ')'))),
          selProvider !== '' && Array.isArray(catalog) ? React.createElement('select', { className: 'capv2-sel', value: selModel, onChange: (e) => setSelModel(e.target.value) },
            React.createElement('option', { value: '' }, t.chooseModel),
            catalog.map((m) => React.createElement('option', { key: m.id, value: m.id }, m.name + ' (' + m.id + ')'))) : null,
          selProvider !== '' && selModel !== '' ? React.createElement('button', { type: 'button', className: 'capv2-btn capv2-primary', onClick: saveDefault }, t.setDefault) : null),
        err !== null ? React.createElement('div', { className: 'plinst-error' }, err) : null,
        note !== null ? React.createElement('div', { className: 'plinst-note' }, note) : null,
        React.createElement('div', { className: 'plinst-section' }, t.providersTitle),
        providers.map((p) => React.createElement('div', { key: p.id, className: 'capv2-row capv2-provider' },
          React.createElement('span', { className: 'capv2-name' }, p.name + ' (' + p.id + ')'),
          React.createElement('span', { className: 'capv2-dim' }, p.baseURL !== '' ? p.baseURL : (p.apiKeyEnv !== '' ? 'env: ' + p.apiKeyEnv : '')),
          React.createElement('span', { className: 'capv2-dim' }, String(p.modelsCount) + ' ' + t.modelsUnit),
          p.authKey !== ''
            ? React.createElement('button', { type: 'button', className: 'capv2-btn', disabled: p.inFlight === true, onClick: () => beginAuth(p.authKey) }, t.login)
            : React.createElement('span', { className: 'capv2-dim' }, t.noFlow))),
        authKey !== '' || authState !== null ? React.createElement('div', { className: 'capv2-authpanel' },
          authState !== null && authState.phase === 'url'
            ? React.createElement(React.Fragment, null,
                React.createElement('div', null, t.authOpenHint),
                React.createElement('div', { className: 'capv2-authurl' }, authState.url),
                authState.code !== '' ? React.createElement('div', { className: 'capv2-authcode' }, authState.code) : null,
                React.createElement('div', { className: 'capv2-dim' }, t.authWaiting))
            : React.createElement('div', { className: 'capv2-dim' }, t.authWaiting),
          React.createElement('button', { type: 'button', className: 'capv2-btn', onClick: () => { host.call('capmgr/auth.cancel', { key: authKey }).catch(() => {}); setAuthKey(''); setAuthState(null) } }, t.cancel)) : null)
    }

    function PluginsTab() {
      const zh = useZh()
      const t = marketCopy(zh)
      const [repos, setRepos] = React.useState(null)
      const [installed, setInstalled] = React.useState(null)
      const [query, setQuery] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [installing, setInstalling] = React.useState('')
      const [uninstalling, setUninstalling] = React.useState('')
      const [error, setError] = React.useState(null)
      const [note, setNote] = React.useState(null)

      const browse = (q) => {
        host.call('plinst/browse', { query: q }).then((answered) => {
          if (answered !== null && typeof answered === 'object' && answered.ok === true) setRepos(answered)
          else setError(answered !== null && typeof answered === 'object' && typeof answered.error === 'string' ? answered.error : t.browseFailed)
        }).catch((failure) => setError(String(failure && failure.message ? failure.message : failure)))
      }
      const refreshInstalled = () => {
        host.call('plinst/installed').then((answered) => {
          if (answered !== null && typeof answered === 'object' && answered.ok === true) setInstalled(answered)
        }).catch(() => {})
      }

      React.useEffect(() => { browse(''); refreshInstalled() }, [])

      const submitSearch = () => {
        setError(null)
        browse(query)
      }
      const install = (repo) => {
        setInstalling(repo)
        setError(null)
        setNote(null)
        host.call('plinst/install', { repo }).then((answered) => {
          setInstalling('')
          if (answered !== null && typeof answered === 'object' && answered.ok === true) {
            setNote((answered.kind === 'package' ? '[' + answered.kind + '] ' : '[' + answered.kind + '] ') + String(answered.note ?? ''))
            refreshInstalled()
          } else {
            setError(answered !== null && typeof answered === 'object' && typeof answered.error === 'string' ? answered.error : t.installFailed)
          }
        }).catch((failure) => {
          setInstalling('')
          setError(String(failure && failure.message ? failure.message : failure))
        })
      }
      const instEntry = (repoName) => {
        if (installed === null || !Array.isArray(installed.registry)) return undefined
        return installed.registry.find((e) => e !== null && typeof e === 'object' && typeof e.dir === 'string' && e.dir.split('/').pop() === repoName)
      }
      const uninstall = (entry, label) => {
        setUninstalling(label)
        setError(null)
        setNote(null)
        host.call('plinst/uninstall', { name: String(entry.name ?? ''), dir: String(entry.dir ?? '') }).then((answered) => {
          setUninstalling('')
          if (answered !== null && typeof answered === 'object' && answered.ok === true) {
            setNote(String(answered.note ?? t.uninstalled))
            refreshInstalled()
            browse(query)
          } else {
            setError(answered !== null && typeof answered === 'object' && typeof answered.error === 'string' ? answered.error : t.uninstallFailed)
          }
        }).catch((failure) => {
          setUninstalling('')
          setError(String(failure && failure.message ? failure.message : failure))
        })
      }
      const uninstallByRepo = (repo) => {
        const entry = instEntry(repo.split('/')[1])
        if (entry === undefined) { setError(t.missingInjection); return }
        uninstall(entry, repo)
      }

      const repoRows = repos !== null && repos.ok === true && Array.isArray(repos.repos) ? repos.repos : []
      // Repos under these owners are OURS (developed in this workspace): the
      // market marks them as locally present instead of offering an install.
      const OWN_OWNERS = ['alex04130']
      const instNames = new Set()
      if (installed !== null && Array.isArray(installed.registry)) {
        for (const r of installed.registry) {
          if (r !== null && typeof r === 'object' && typeof r.dir === 'string') {
            const seg = r.dir.split('/')
            instNames.add(seg[seg.length - 1])
          }
        }
      }
      if (installed !== null && Array.isArray(installed.dirs)) {
        for (const d of installed.dirs) {
          if (typeof d === 'string' && d.length > 0) instNames.add(d)
        }
      }
      const cards = repoRows.map((r) => {
        if (r === null || typeof r !== 'object') return null
        const repoName = String(r.name ?? '')
        const isOwn = OWN_OWNERS.includes(String(r.owner ?? ''))
        const isInstalled = isOwn === true || instNames.has(repoName)
        return React.createElement('div', { key: r.repo, className: 'plinst-card' },
          React.createElement('div', { className: 'plinst-card-head' },
            React.createElement('span', { className: 'plinst-repo', title: r.repo }, r.repo),
            isOwn === true ? React.createElement('span', { className: 'plinst-topic', style: { color: '#7c3aed', background: 'rgba(124,58,237,.1)', flex: 'none' } }, t.own) : null,
            React.createElement('span', { className: 'plinst-stars' }, React.createElement(StarIcon, null), String(r.stars))),
          typeof r.description === 'string' && r.description.length > 0 ? React.createElement('div', { className: 'plinst-desc' }, r.description) : null,
          Array.isArray(r.topics) && r.topics.length > 0 ? React.createElement('div', { className: 'plinst-topics' }, r.topics.map((tp) => React.createElement('span', { key: tp, className: 'plinst-topic' }, String(tp)))) : null,
          React.createElement('div', { className: 'plinst-actions' },
            isInstalled === true ? React.createElement('span', { className: 'plinst-topic', style: { color: '#16a34a', background: 'rgba(22,163,74,.1)' } }, t.installed) : null,
            isOwn === true
              ? React.createElement('button', {
                  type: 'button',
                  className: 'plinst-btn',
                  disabled: true,
                  title: t.ownTitle,
                }, t.localRepo)
              : (isInstalled === true
                  ? React.createElement('button', {
                      type: 'button',
                      className: 'plinst-btn plinst-btn-danger',
                      disabled: installing !== '' || uninstalling !== '',
                      onClick: () => uninstallByRepo(r.repo),
                    }, uninstalling === r.repo ? t.uninstalling : t.uninstall)
                  : React.createElement('button', {
                      type: 'button',
                      className: 'plinst-btn plinst-btn-primary',
                      disabled: installing !== '',
                      onClick: () => install(r.repo),
                    }, installing === r.repo ? t.installing : t.install))))
      }).filter((node) => node !== null)

      const installedRows = installed === null || !Array.isArray(installed.registry) || installed.registry.length === 0 ? null : installed.registry.map((r) => {
        if (r === null || typeof r !== 'object') return null
        const descText = typeof r.description === 'string' && r.description.trim() !== '' ? r.description.trim() : String(r.dir ?? '')
        return React.createElement('div', { key: String(r.name ?? r.dir ?? '') , className: 'plinst-row' },
          React.createElement('span', { className: 'plinst-row-name', title: r.dir, style: { flex: 'none' } }, String(r.name)),
          React.createElement('span', { className: 'plinst-row-desc', title: String(r.dir ?? ''), style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #9ca3af)', flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, descText),
          React.createElement('button', {
            type: 'button',
            className: 'plinst-btn plinst-btn-danger',
            style: { height: 24, padding: '0 10px', flex: 'none' },
            disabled: installing !== '' || uninstalling !== '',
            onClick: () => uninstall(r, String(r.dir)),
          }, uninstalling === String(r.dir) ? t.uninstalling : t.uninstall))
      }).filter((node) => node !== null)

      return React.createElement('div', { className: 'plinst-tab' },
          React.createElement(CapsSection, null),
          React.createElement('div', { className: 'plinst-warn' }, t.warning),
          error !== null ? React.createElement('div', { className: 'plinst-error' }, error) : null,
          note !== null ? React.createElement('div', { className: 'plinst-note' }, note) : null,
          React.createElement('div', { className: 'plinst-body' },
            React.createElement('div', { className: 'plinst-toolbar' },
              React.createElement('input', {
                className: 'plinst-search',
                type: 'search',
                placeholder: t.searchPlaceholder,
                value: query,
                onChange: (e) => setQuery(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') submitSearch() },
              }),
              React.createElement('button', { type: 'button', className: 'plinst-btn', onClick: submitSearch }, t.search)),
            installedRows !== null ? React.createElement('div', { className: 'plinst-installed' },
              React.createElement('div', { className: 'plinst-section' }, t.installed, React.createElement('span', { className: 'plinst-section-count' }, t.installedCount(installed.registry.length))),
              installedRows) : null,
            repos === null ? React.createElement('div', { className: 'plinst-empty' }, t.loading)
              : (repoRows.length === 0 ? React.createElement('div', { className: 'plinst-empty' }, t.noMatch) : cards)))
    }

    function SkillsTab() {
      const zh = useZh()
      const t = skillCopy(zh)
      const [state, setState] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [showForm, setShowForm] = React.useState(false)
      const [expanded, setExpanded] = React.useState(null)
      const [form, setForm] = React.useState({ name: '', description: '', whenToUse: '', content: '', modelInvocable: true, userInvocable: true, alwaysInject: false })

      const refresh = () => {
        host.call('skillui/state').then((answered) => {
          if (answered !== null && typeof answered === 'object' && answered.ok === true) setState(answered)
          else setError(answered !== null && typeof answered === 'object' && typeof answered.error === 'string' ? answered.error : t.loadFailed)
        }).catch((failure) => {
          setError(String(failure && failure.message ? failure.message : failure))
        })
      }

      React.useEffect(() => { refresh() }, [])

      const act = (method, args) => {
        setBusy(true)
        setError(null)
        host.call(method, args).then((answered) => {
          setBusy(false)
          if (answered !== null && typeof answered === 'object' && answered.ok === true) {
            if (method === 'skillui/add') { setShowForm(false); setForm({ name: '', description: '', whenToUse: '', content: '', modelInvocable: true, userInvocable: true, alwaysInject: false }) }
            refresh()
          } else {
            setError(answered !== null && typeof answered === 'object' && typeof answered.error === 'string' ? answered.error : t.opFailed)
          }
        }).catch((failure) => {
          setBusy(false)
          setError(String(failure && failure.message ? failure.message : failure))
        })
      }

      const skills = state !== null && state.ok === true && Array.isArray(state.skills) ? state.skills : []
      const others = state !== null && state.ok === true && Array.isArray(state.others) ? state.others : []
      const setField = (key, value) => setForm((f) => Object.assign({}, f, { [key]: value }))
      const formValid = form.name.trim().length > 0 && form.description.trim().length > 0 && form.content.trim().length > 0

      const cards = skills.map((s) => {
        if (s === null || typeof s !== 'object') return null
        const isOpen = expanded === s.name
        return React.createElement('div', { key: s.name, className: 'skillui-card' },
          React.createElement('div', { className: 'skillui-card-head skillui-card-head-click', onClick: () => { if (busy !== true) setExpanded(isOpen ? null : s.name) } },
            React.createElement('span', { className: 'skillui-name', title: s.name }, s.name),
            React.createElement('span', { className: 'skillui-pill ' + (s.enabled === true ? 'skillui-pill-on' : 'skillui-pill-off') },
              React.createElement('span', { className: 'skillui-pill-dot' }),
              s.enabled === true ? t.enabled : t.disabled),
            React.createElement('button', { type: 'button', className: 'skill-expand-btn' + (isOpen === true ? ' skill-expand-btn-expanded' : ''), disabled: busy === true, onClick: (e) => { e.stopPropagation(); setExpanded(isOpen ? null : s.name) }, 'aria-label': t.previewContent, 'aria-expanded': isOpen === true, title: isOpen ? t.collapse : t.preview }, Icon('chevronDown', {})),
            React.createElement('button', { type: 'button', className: 'skillui-btn', disabled: busy === true, onClick: (e) => { e.stopPropagation(); act(s.enabled === true ? 'skillui/disable' : 'skillui/enable', { name: s.name }) } }, s.enabled === true ? t.disable : t.enable),
            React.createElement('button', { type: 'button', className: 'skillui-btn skillui-btn-danger', disabled: busy === true, onClick: (e) => { e.stopPropagation(); if (window.confirm(t.confirmDelete(s.name)) === true) act('skillui/remove', { name: s.name }) } }, Icon('trash'))),
          typeof s.description === 'string' && s.description.length > 0 ? React.createElement('div', { className: 'skillui-desc' }, mdToNodes(s.description)) : null,
          React.createElement('div', { className: 'skillui-tags' },
            s.modelInvocable === true ? React.createElement('span', { className: 'skillui-tag' }, t.modelInvokable) : null,
            s.userInvocable === true ? React.createElement('span', { className: 'skillui-tag' }, t.userInvokable) : null,
            typeof s.whenToUse === 'string' && s.whenToUse.length > 0 ? React.createElement('span', { className: 'skillui-tag', title: s.whenToUse }, 'whenToUse') : null,
            React.createElement('button', {
              type: 'button',
              className: 'skillui-tag skillui-tag-btn' + (s.alwaysInject === true ? ' skillui-tag-inject' : ''),
              disabled: busy === true,
              title: s.alwaysInject === true ? t.injectOnTitle : t.injectOffTitle,
              onClick: () => act('skillui/setInject', { name: s.name, alwaysInject: s.alwaysInject !== true }),
            }, s.alwaysInject === true ? t.injectOn : t.injectOff)),
          isOpen === true ? React.createElement('div', { className: 'skillui-content' }, mdToNodes(typeof s.content === 'string' ? s.content : '')) : null)
      }).filter((node) => node !== null)

      const othersRows = others.map((s) => {
        if (s === null || typeof s !== 'object') return null
        return React.createElement('div', { key: 'other:' + s.name, className: 'skillui-ro-row' },
          React.createElement('span', { className: 'skillui-ro-name', title: s.name }, s.name),
          React.createElement('span', { className: 'skillui-tag', title: t.providerTitle(String(s.provider ?? 'unknown')) }, String(s.provider ?? 'unknown')),
          s.model === true ? React.createElement('span', { className: 'skillui-tag' }, t.modelInvokable) : null,
          s.user === true ? React.createElement('span', { className: 'skillui-tag' }, t.userInvokable) : null,
          typeof s.description === 'string' && s.description.length > 0 ? React.createElement('div', { className: 'skillui-ro-desc' }, mdToNodes(s.description)) : null)
      }).filter((node) => node !== null)

      const othersSection = others.length === 0 ? null : React.createElement('div', null,
        React.createElement('div', { className: 'skillui-section' }, t.othersSection, React.createElement('span', { className: 'skillui-section-count' }, t.othersCount(others.length))),
        React.createElement('div', { className: 'skillui-hint' }, t.othersHint),
        othersRows)

      const formNode = showForm === false ? null : React.createElement('div', { className: 'skillui-modal' },
        React.createElement('div', { className: 'skillui-modal-backdrop', onClick: () => setShowForm(false) }),
        React.createElement('div', { className: 'skillui-modal-panel', role: 'dialog', 'aria-modal': 'true' },
          React.createElement('div', { className: 'skillui-modal-title' }, t.addTitle),
          React.createElement('div', { className: 'skillui-field' },
            React.createElement('span', { className: 'skillui-label' }, t.nameLabel),
            React.createElement('input', { className: 'skillui-input', value: form.name, placeholder: t.namePlaceholder, onChange: (e) => setField('name', e.target.value) })),
          React.createElement('div', { className: 'skillui-field' },
            React.createElement('span', { className: 'skillui-label' }, t.descLabel),
            React.createElement('input', { className: 'skillui-input', value: form.description, placeholder: t.descPlaceholder, onChange: (e) => setField('description', e.target.value) })),
          React.createElement('div', { className: 'skillui-field' },
            React.createElement('span', { className: 'skillui-label' }, t.whenLabel),
            React.createElement('input', { className: 'skillui-input', value: form.whenToUse, placeholder: t.whenPlaceholder, onChange: (e) => setField('whenToUse', e.target.value) })),
          React.createElement('div', { className: 'skillui-field' },
            React.createElement('span', { className: 'skillui-label' }, t.contentLabel),
            React.createElement('textarea', { className: 'skillui-input skillui-textarea', value: form.content, placeholder: t.contentPlaceholder, onChange: (e) => setField('content', e.target.value) })),
          React.createElement('div', { className: 'skillui-checks' },
            React.createElement('label', { className: 'skillui-check' },
              React.createElement('input', { type: 'checkbox', checked: form.modelInvocable === true, onChange: (e) => setField('modelInvocable', e.target.checked) }),
              t.modelInvocableLabel),
            React.createElement('label', { className: 'skillui-check' },
              React.createElement('input', { type: 'checkbox', checked: form.userInvocable === true, onChange: (e) => setField('userInvocable', e.target.checked) }),
              t.userInvocableLabel),
            React.createElement('label', { className: 'skillui-check' },
              React.createElement('input', { type: 'checkbox', checked: form.alwaysInject === true, onChange: (e) => setField('alwaysInject', e.target.checked) }),
              t.alwaysInjectLabel)),
          React.createElement('div', { className: 'skillui-modal-foot' },
            React.createElement('button', { type: 'button', className: 'skillui-btn', onClick: () => setShowForm(false) }, t.cancel),
            React.createElement('button', { type: 'button', className: 'skillui-btn skillui-btn-primary', disabled: busy === true || formValid === false, onClick: () => act('skillui/add', { name: form.name.trim(), description: form.description.trim(), whenToUse: form.whenToUse.trim(), content: form.content, modelInvocable: form.modelInvocable, userInvocable: form.userInvocable, alwaysInject: form.alwaysInject }) }, t.addTitle))))

      return React.createElement('div', { className: 'skillui-tab' },
          error !== null ? React.createElement('div', { className: 'skillui-error' }, error) : null,
          React.createElement('div', { className: 'skillui-body' },
            state === null ? React.createElement('div', { className: 'skillui-empty' }, t.loading)
              : (skills.length === 0 ? React.createElement('div', { className: 'skillui-empty' },
                  React.createElement('div', { style: { fontSize: 42, lineHeight: 1, opacity: 0.35 } }, '\u2728'),
                  React.createElement('div', { style: { marginTop: 12, fontSize: 13.5, fontWeight: 550 } }, t.emptyTitle),
                  React.createElement('div', { style: { marginTop: 4, fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #6b7280)' } }, t.emptyHint),
                  React.createElement('button', { type: 'button', className: 'skillui-btn skillui-btn-primary', style: { marginTop: 16, height: 32, padding: '0 18px' }, onClick: () => { setShowForm(true); setError(null) } }, t.addCta)) : cards),
            othersSection),
          React.createElement('div', { className: 'skillui-footer' },
            React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #6b7280)' } }, t.footerCount(skills.length)),
            React.createElement('button', { type: 'button', className: 'skillui-btn skillui-btn-primary', onClick: () => { setShowForm(true); setError(null) } }, t.addTitle)),
          formNode)
    }

    // ── MCP tab（v1 只读） ──
    function McpTab() {
      const zh = useZh()
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const load = () => {
        host.call('capmgr/mcp.list').then((res) => {
          if (res !== null && typeof res === 'object' && res.ok === true) { setData(res); setError(null) }
          else setError(res !== null && typeof res === 'object' && typeof res.error === 'string' ? res.error : 'load failed')
        }).catch((e) => setError(String(e && e.message !== undefined ? e.message : e)))
      }
      React.useEffect(() => { load() }, [])
      const servers = data !== null && Array.isArray(data.servers) ? data.servers : []
      return h('div', { className: 'capmgr-mcp' },
        h('div', { className: 'capmgr-mcp-toolbar' },
          h('span', { className: 'capmgr-mcp-hint' }, zh ? 'MCP server 挂载清单（loader 实时）' : 'Mounted MCP servers (live loader view)'),
          h('button', { type: 'button', className: 'plinst-btn', onClick: load }, zh ? '刷新' : 'Refresh')),
        error !== null ? h('div', { className: 'plinst-error' }, error) : null,
        data === null ? h('div', { className: 'plinst-empty' }, zh ? '加载中…' : 'Loading…')
          : servers.length === 0
            ? h('div', { className: 'plinst-empty' }, zh ? '没有挂载的 MCP server' : 'No MCP servers mounted')
            : servers.map((s) => h('div', { key: s.id, className: 'capmgr-mcp-row' },
                h('span', { className: 'plsm-dot ' + (s.disabled === true ? 'plsm-dot-rejected' : 'plsm-dot-active') }),
                h('span', { className: 'capmgr-mcp-name' }, s.serverName || s.id),
                h('span', { className: 'capmgr-mcp-meta' }, s.transport),
                h('span', { className: 'capmgr-mcp-cmd', title: s.command }, s.command),
                h('span', { className: 'capmgr-mcp-state' }, s.disabled === true ? (zh ? '已禁用' : 'disabled') : (zh ? '运行中' : 'running')))),
        h('div', { className: 'capmgr-mcp-foot' }, zh ? 'v1 为只读清单；浏览源/一键安装/表单配置（loader.create 热挂，实证可行）在后续版本。' : 'v1 is read-only; browse/install/form-config (hot loader.create, proven) lands in a later version.'))
    }

    // ── tab 容器 ──
    function CapmgrPanel() {
      const zh = useZh()
      const [tab, setTab] = React.useState('plugins')
      const tabs = [['plugins', zh ? '插件管理' : 'Plugins'], ['skills', zh ? '技能' : 'Skills'], ['mcp', 'MCP'], ['models', zh ? '模型' : 'Models']]
      return h('div', { className: 'capmgr-content' },
        h('div', { className: 'capmgr-tabs', role: 'tablist' }, tabs.map(([id, label]) =>
          h('button', { key: id, type: 'button', role: 'tab', 'aria-selected': tab === id, className: 'capmgr-tab' + (tab === id ? ' capmgr-tab-on' : ''), onClick: () => setTab(id) }, label))),
        h('div', { className: 'capmgr-body' },
          tab === 'plugins' ? h(PluginsTab, null) : tab === 'skills' ? h(SkillsTab, null) : tab === 'models' ? h(ModelsTab, null) : h(McpTab, null)))
    }

    styles.insert(`
.capmgr-content { display: flex; flex-direction: column; min-height: 0; flex: 1; }
.capmgr-tabs { display: flex; gap: 4px; padding: 10px 24px 0; border-bottom: 1px solid rgba(128,128,128,.14); flex: none; }
.capmgr-tab { border: 0; background: transparent; color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 13px; font-family: inherit; padding: 6px 12px 8px; cursor: pointer; border-bottom: 2px solid transparent; }
.capmgr-tab:hover { color: var(--dsw-alias-label-secondary, inherit); }
.capmgr-tab-on { color: var(--dsw-alias-label-primary, inherit); font-weight: 600; border-bottom-color: var(--dsw-alias-accent, #4f7cff); }
.capmgr-body { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }
.plinst-tab, .skillui-tab { display: flex; flex-direction: column; min-height: 0; flex: 1; }
.capmgr-mcp { display: flex; flex-direction: column; gap: 8px; padding: 14px 24px; }
.capmgr-mcp-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.capmgr-mcp-hint { font-size: 12px; color: var(--dsw-alias-label-tertiary, #6b7280); }
.capmgr-mcp-row { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 8px 10px; border-radius: 8px; }
.capmgr-mcp-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.1)); }
.capmgr-mcp-name { font-weight: 650; }
.capmgr-mcp-meta { color: var(--dsw-alias-label-tertiary, #6b7280); }
.capmgr-mcp-cmd { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--dsw-alias-label-tertiary, #6b7280); }
.capmgr-mcp-state { flex: none; font-size: 11px; }
.capmgr-mcp-foot { font-size: 11px; color: var(--dsw-alias-label-tertiary, #9aa0aa); padding-top: 6px; }
.plsm-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.plsm-dot-active { background: var(--dsw-alias-state-success-primary, #16a34a); }
.plsm-dot-rejected { background: var(--dsw-alias-border-l2, #d4d4da); }
.capv2-caps { padding: 14px 24px 0; display: flex; flex-direction: column; gap: 6px; }
.capv2-row { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 6px 10px; border-radius: 8px; }
.capv2-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.1)); }
.capv2-name { font-weight: 650; }
.capv2-state { color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 11px; }
.capv2-group { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-tertiary, #6b7280); padding-top: 8px; }
.capv2-btn { border: 1px solid rgba(128,128,128,.3); background: transparent; color: inherit; border-radius: 7px; padding: 3px 10px; font-size: 11px; cursor: pointer; font-family: inherit; }
.capv2-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
.capv2-btn:disabled { opacity: .5; cursor: default; }
.capv2-primary { border-color: var(--dsw-alias-accent, #4f7cff); color: var(--dsw-alias-accent, #4f7cff); }
.capv2-dim { color: var(--dsw-alias-label-tertiary, #9aa0aa); font-size: 11px; }
.capv2-cfgcard { border: 1px dashed rgba(128,128,128,.25); }
.capv2-drawer { display: flex; flex-direction: column; gap: 8px; border: 1px solid rgba(128,128,128,.18); border-radius: 10px; padding: 10px 12px; margin: 2px 0 6px; }
.capv2-field { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.capv2-field input[type=number] { width: 72px; }
.capv2-field select, .capv2-sel { font: inherit; font-size: 12px; }
.capv2-featsw { border: 1px dashed rgba(128,128,128,.25); border-radius: 10px; padding: 10px 12px; margin-top: 6px; }
.capv2-provider { border-bottom: 1px solid rgba(128,128,128,.08); }
.capv2-authpanel { border: 1px solid rgba(128,128,128,.25); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
.capv2-authurl { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; word-break: break-all; color: var(--dsw-alias-accent, #4f7cff); }
.capv2-authcode { font-size: 18px; font-weight: 700; letter-spacing: 2px; }
`)

    // ── 注册进壳 ──
    let handle = undefined
    ctx.effect(() => {
      handle = shell.registerFeature({
        id: 'capmgr',
        order: 40,
        badge: { icon: PlugGlyph, label: () => (isZhNow() ? '能力' : 'Capabilities') },
        title: () => (isZhNow() ? '能力管理' : 'Capability Manager'),
        panel: CapmgrPanel,
        foot: () => (isZhNow() ? '插件市场源：GitHub topic dsh-plugin · MCP 安装/配置在后续版本' : 'Plugin source: GitHub topic dsh-plugin · MCP install/config in a later version'),
      })
      return () => { const hd = handle; handle = undefined; if (hd !== undefined) hd.dispose() }
    })
  },
}
