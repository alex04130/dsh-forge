# 迁移：`projects.json` v2（带 team）→ v3（纯 project）

**这是一次破坏性变更。** 存储层不再有 team 这个概念：项目自己带着成员、看板与归档快照。
工具层的措辞仍然是 team / 团队（`forge_team_*` 的名字与描述**没有变**），只是它底下操作的是项目。

- 权威实现：`bundle/plugins/lib/projects.mjs`
- 真值文件：`~/.dsh/projects.json`
- 相关记录：`docs/ADAPTATION-0.2.0-rc.2.md` §6.13、§6.14

---

## 1. 一句话

> 旧文件里 `project.teams[]` 这一层被拍平进项目本身；**多条 team 取并集**。
> 迁移**不需要你动手** —— forge 第一次写 `projects.json` 就会写成 v3。
> 但 `teamId` 这个标识符**消失了**，任何还拿着旧 `teamId` 的地方都要改成 `projectId`。

---

## 2. 形状对照

### 旧（v2）

```json
{
  "version": 2,
  "projects": [{
    "id": "p-dsh-forge",
    "name": "dsh-forge",
    "cwds": ["/home/alex/.dsh/dsh-forge"],
    "memory": "project-memory/p-dsh-forge/README.md",
    "wake": { "windowMs": 60000, "perTarget": 3, "projectTotal": 8 },
    "crossTeam": { "windowMs": 60000, "perTarget": 3, "projectTotal": 8 },
    "distillSessionId": "session-xxxx",
    "teams": [{
      "teamId": "team-abc",
      "name": "dsh-forge",
      "projectId": "p-dsh-forge",
      "members": [{ "sessionId": "session-a", "memberId": "me", "role": "队长" }],
      "tasks": [{ "id": "t1", "title": "适配 rc.2", "status": "in_progress", "assignee": "me", "description": "", "output": "" }],
      "stale": [{ "sessionId": "session-old", "note": "" }]
    }],
    "archivedTeams": [{ "teamId": "team-old", "name": "上一轮", "members": [], "tasks": [] }]
  }]
}
```

### 新（v3）

```json
{
  "version": 3,
  "projects": [{
    "id": "p-dsh-forge",
    "name": "dsh-forge",
    "cwds": ["/home/alex/.dsh/dsh-forge"],
    "memory": "project-memory/p-dsh-forge/README.md",
    "wake": { "windowMs": 60000, "perTarget": 3, "projectTotal": 8 },
    "crossTeam": { "windowMs": 60000, "perTarget": 3, "projectTotal": 8 },
    "distillSessionId": "session-xxxx",
    "members": [{ "sessionId": "session-a", "memberId": "me", "role": "队长" }],
    "tasks": [{ "id": "t1", "title": "适配 rc.2", "status": "in_progress", "assignee": "me", "description": "", "output": "" }],
    "stale": [{ "sessionId": "session-old", "note": "" }],
    "archived": [{ "at": "", "name": "上一轮", "members": [], "tasks": [], "stale": [] }]
  }]
}
```

**变化清单**

| 旧 | 新 |
|---|---|
| `project.teams[].members` | `project.members` |
| `project.teams[].tasks` | `project.tasks` |
| `project.teams[].stale` | `project.stale` |
| `project.teams[].ownedSessions` | `project.ownedSessions` |
| `project.teams[].teamId` | **删除** —— 标识符就是 `project.id` |
| `project.teams[].name` | **删除** —— 名字就是 `project.name` |
| `project.archivedTeams[]` | `project.archived[]`（多一个 `at` 字段） |
| `project.teams[]`（多条） | **并集**成一套 members / tasks / stale |
| `captain` / `goal`（若 team 上有） | 提升到 `project.captain` / `project.goal` |
| `version: 2` | `version: 3` |

---

## 3. 拍平规则（逐字）

`normalizeProject()` 的判定顺序：

1. **成员**：项目自己已有 `members` 就用它；否则把每条 team 的 members **按 `sessionId` 去重并集**。
2. **看板**：项目自己已有 `tasks` 就用它；否则按 `id` 去重并集。
3. **stale**：同上，按 `sessionId` 去重并集。
4. **ownedSessions**：所有来源取并集。
5. **archived**：项目自己已有 `archived` 就用它；否则把 `archivedTeams[]` 逐条搬成归档快照。
6. `teams` 字段**不再出现在输出里** —— 无论输入是 v2 还是 v3。

> 注意第 1–5 条的"项目自己已有就用它"：如果你已经手工把 `members` 放到项目上，
> 同时又留着旧 `teams[]`，**项目上的那份赢**，旧 team 会被忽略。

---

## 4. 自动迁移

不用做任何事。`saveProjects()` 永远写 `normalize()` 之后的结果，而 normalize 只产出 v3。

所以：**只要 forge 因为任何一次写操作调用过 `saveProjects()`，文件就已经是 v3 了。**
（`forge_team_create` / `forge_team_add_members` / `forge_team_create_task` /
`forge_team_update_task` / `forge_memory_put` / `forge_team_delete` 等都会触发。）

**先备份**（建议，但只是保险）：

```bash
cp ~/.dsh/projects.json ~/.dsh/projects.json.v2-backup
```

---

## 5. 手工迁移（不想等 forge 自己写的时候）

把每条 team 的 `members` / `tasks` / `stale` 并到项目上，删掉 `teams` 与 `archivedTeams`，
`version` 改 3。用 node 一行搞定：

```bash
node -e '
const fs=require("fs"),os=require("os"),p=os.homedir()+"/.dsh/projects.json";
const cfg=JSON.parse(fs.readFileSync(p,"utf8"));
const uniq=(a,k)=>{const s=new Set(),o=[];for(const x of a){const v=k(x);if(v&&s.has(v))continue;if(v)s.add(v);o.push(x)}return o};
cfg.version=3;
cfg.projects=(cfg.projects||[]).map(pr=>{
  const ts=Array.isArray(pr.teams)?pr.teams:[];
  const members=pr.members&&pr.members.length?pr.members:uniq(ts.flatMap(t=>t.members||[]),m=>m&&m.sessionId);
  const tasks  =pr.tasks  &&pr.tasks.length  ?pr.tasks  :uniq(ts.flatMap(t=>t.tasks||[]),t=>t&&t.id);
  const stale  =pr.stale  &&pr.stale.length  ?pr.stale  :uniq(ts.flatMap(t=>t.stale||[]),s=>s&&s.sessionId);
  const owned=[...new Set(ts.flatMap(t=>t.ownedSessions||[]).concat(pr.ownedSessions||[]))];
  const archived=pr.archived&&pr.archived.length?pr.archived:(pr.archivedTeams||[]).map(t=>({at:"",name:t.name||"",members:t.members||[],tasks:t.tasks||[],stale:t.stale||[]}));
  const {teams,archivedTeams,...rest}=pr;
  return {...rest,members,tasks,stale,...(owned.length?{ownedSessions:owned}:{}),archived};
});
fs.writeFileSync(p,JSON.stringify(cfg,null,2)+"\n");
console.log("migrated",cfg.projects.length,"projects");
'
```

---

## 6. 迁移之后什么会坏（必须一起改的地方）

`teamId` 不再是独立标识符，**任何还拿着旧 `teamId` 的调用都会找不到东西**：

| 场景 | 现在要传什么 |
|---|---|
| `forge_team_add_members` / `forge_team_create_task` / `forge_team_update_task` / `forge_team_delete` 的 `teamId` 参数 | **projectId**（如 `p-dsh-forge`） |
| 团队模板、白板、通话记录里存的 teamId | projectId |
| 你自己脚本里硬编码的 `team-xxxx` | projectId |

**不会坏的**：`forge_team_create` / `forge_team_status` / `forge_team_wait` /
`forge_team_send_message` —— 它们靠"调用方会话属于哪个项目"自己找，不看传进来的 id。
`forge_mailbridge_*` 同理，它认的是项目归属。

---

## 7. 回滚

**v3 不能被旧代码读。** 回滚只有一条路：把备份贴回去，并且**同时**把 forge 退回改动前的版本。

```bash
cp ~/.dsh/projects.json.v2-backup ~/.dsh/projects.json
```

如果已经跑过 v3 又写了新内容，那份内容里没有 `teams[]`，
贴回 v2 备份会丢掉那段新内容 —— 先把它抄出来。

---

## 8. 为什么这么改

- 一个项目本来就只有一个协作单元；`teams[]` 这一层从来没有出现过"一个项目多条活跃队"的真实用法，
  却让每一次读写都要多一层解引用。
- 成员、看板、成员归属（`teamOfSession`）、彩灯（`lampOfTeam`）、会话互唤的预算闸——
  全部本来就以**项目**为单位在判断（`~/.dsh/projects.json` 预算闸）。
- 拍平之后 `teamId === projectId`，10 个消费者不需要同时改。
