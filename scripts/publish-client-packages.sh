#!/usr/bin/env bash
# 发布 @dsh-forge 客户端包：复制到临时目录改写 name/version、去掉 private、
# 并重写 lib/client.js 里的注册 id（源码 @local 布局保持不动）。
# 目录名与发布名的映射：dynrestore 目录沿用既有 npm 名 @dsh-forge/dsh-dynrestore。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
VERSION="${1:-0.2.0-preview.1}"

# "目录名:发布名"
for pair in dynrestore:dsh-dynrestore dsh-plugmgr:dsh-plugmgr dsh-forge-ui:dsh-forge-ui dsh-mailbridge-card:dsh-mailbridge-card; do
  dir="${pair%%:*}"
  pkg="${pair##*:}"
  echo "[publish] $dir -> @dsh-forge/$pkg@$VERSION"
  mkdir -p "$TMP/$pkg"
  cp -r "$ROOT/bundle/packages/$dir/." "$TMP/$pkg/"
  # 注册 id：client.js 里 __ModuleLoader__.load({ id: '@local/...' }) 必须换成
  # npm 包名，否则浏览器页面报 "loaded without registering"（sync #51）。
  sed -i "s#@local/$pkg#@dsh-forge/$pkg#g" "$TMP/$pkg/lib/client.js"
  # 展示层分类：npm profile 里我们自己的 @dsh-forge/* 条目归「本地」而非「注入」。
  if [ "$pkg" = "dsh-plugmgr" ]; then
    sed -i "s#moduleName.startsWith('@local/')#moduleName.startsWith('@local/') || moduleName.startsWith('@dsh-forge/')#g" "$TMP/$pkg/lib/client.js"
  fi
  node -e "
    const fs = require('fs')
    const f = '$TMP/$pkg/package.json'
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    j.name = '@dsh-forge/$pkg'
    j.version = '$VERSION'
    delete j.private
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n')
  "
  # --tag next：npm 11 起 prerelease 不指定 dist-tag 会拒绝发布（避免污染 latest）。
  (cd "$TMP/$pkg" && npm publish --access public --tag next --cache /tmp/npm-cache)
  # 发布后核对：registry 上的 name/version 必须与刚发的一致（防 dir/name 分叉静默错发）。
  seen="$(npm view "@dsh-forge/$pkg" name version --cache /tmp/npm-cache)"
  echo "$seen"
  echo "$seen" | grep -q "@dsh-forge/$pkg" && echo "$seen" | grep -q "$VERSION" || {
    echo "[publish] FAIL: @dsh-forge/$pkg 的 registry 回读与预期不符" >&2
    exit 1
  }
done

echo '[publish] 完成：@dsh-forge/dsh-dynrestore + @dsh-forge/dsh-plugmgr + @dsh-forge/dsh-forge-ui + @dsh-forge/dsh-mailbridge-card'
