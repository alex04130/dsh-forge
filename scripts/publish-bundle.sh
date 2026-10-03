#!/usr/bin/env bash
# 发布 @dsh-forge/bundle 本体：复制到临时目录，做两处 npm 化改写后 publish。
# 仓库内的源文件保持不动：
#   - package.json 的 link:./packages/* 依赖  →  ^VERSION 的 registry 依赖
#     （npm 不会把 link: 协议变成可解析依赖，原样进 manifest 会让安装方炸）
#   - cordis.patch.yml 里的 @local/* 行名     →  @dsh-forge/*
#     （npm 装的 profile 里没有 @local scope；这正是当年 cordis.npm.yml 存在的理由。
#       ./plugins/*.mjs 相对行在 bundle 包内自解析，不用动；@deepseek-ai/* 官方行不动）
#
# 发布顺序（硬约束）：先 scripts/publish-client-packages.sh 发四个客户端包，再跑本脚本。
# bundle 的 dependencies 与 patch 行名都指向它们的 registry 版本，顺序反了
# consumers 端解析会失败（且不一定在 dry-run 暴露）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
TMPW="$(cygpath -m "$TMP")"  # Windows 路径给 node/npm 用（MSYS /tmp 与 C:\tmp 不是一回事）
trap 'rm -rf "$TMP"' EXIT
VERSION="${1:-0.2.0-preview.1}"

cp -r "$ROOT/bundle/." "$TMP/bundle/"

# 1) 依赖：link: → ^VERSION（名字 @local/* → @dsh-forge/* 一并对齐发布名）
node -e "
  const fs = require('fs')
  const f = '$TMPW/bundle/package.json'
  const j = JSON.parse(fs.readFileSync(f, 'utf8'))
  const MAP = {
    '@local/dsh-forge-ui': '@dsh-forge/dsh-forge-ui',
    '@local/dsh-mailbridge-card': '@dsh-forge/dsh-mailbridge-card',
    '@local/dsh-dynrestore': '@dsh-forge/dsh-dynrestore',
  }
  for (const [k, v] of Object.entries(MAP)) {
    if (j.dependencies && j.dependencies[k]) {
      j.dependencies[v] = '^$VERSION'
      delete j.dependencies[k]
    }
  }
  j.version = '$VERSION'
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n')
"

# 2) patch 行名：@local/* → @dsh-forge/*
sed -i "s#@local/dsh-forge-ui#@dsh-forge/dsh-forge-ui#g; s#@local/dsh-mailbridge-card#@dsh-forge/dsh-mailbridge-card#g; s#@local/dsh-dynrestore#@dsh-forge/dsh-dynrestore#g" "$TMP/bundle/cordis.patch.yml"

# 3) 发布前核对：patch 里不得残留 @local/，依赖里不得残留 link:
if grep -q '@local/' "$TMP/bundle/cordis.patch.yml"; then
  echo '[publish-bundle] FAIL: cordis.patch.yml 仍残留 @local/ 行' >&2
  grep '@local/' "$TMP/bundle/cordis.patch.yml" >&2
  exit 1
fi
if grep -q 'link:' "$TMP/bundle/package.json"; then
  echo '[publish-bundle] FAIL: package.json 仍残留 link: 依赖' >&2
  exit 1
fi
echo "[publish-bundle] 改写核对通过：@local/ 行 0 残留，link: 依赖 0 残留"

# 4) patch 三行指向的包必须在 registry 上已存在（依赖刚发的四个客户端包，顺序不能反）。
#    任一取不到即 FAIL —— 挡住「包发出去了但名字对不上」这类 dry-run 看不出的失败。
for row in dsh-dynrestore dsh-mailbridge-card dsh-forge-ui; do
  ok=""
  for _ in 1 2 3 4 5 6; do
    seen="$(npm view "@dsh-forge/$row@$VERSION" version --cache /tmp/npm-cache 2>/dev/null)" || seen=""
    if [ -n "$seen" ]; then ok=1; break; fi
    sleep 15
  done
  [ -n "$ok" ] || {
    echo "[publish-bundle] FAIL: patch 行指向的 @dsh-forge/$row@$VERSION 在 registry 取不到（客户端包先发了吗？）" >&2
    exit 1
  }
  echo "[publish-bundle] registry 核对：@dsh-forge/$row@$VERSION -> $seen"
done

# --tag next：npm 11 起 prerelease 不指定 dist-tag 会拒绝发布（避免污染 latest）。
(cd "$TMP/bundle" && npm publish --access public --tag next --cache /tmp/npm-cache)

echo "[publish-bundle] 完成：@dsh-forge/bundle@$VERSION"
echo "[publish-bundle] 发布后请回归：npm run check + docs/PLATFORM-VERIFY.md 清单"
