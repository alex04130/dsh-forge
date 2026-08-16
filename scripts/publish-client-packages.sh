#!/usr/bin/env bash
# 发布 @dsh-forge 客户端包：复制到临时目录改写 name/version、去掉 private、
# 并重写 lib/client.js 里的注册 id（源码 @local 布局保持不动）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
VERSION="${1:-0.1.1}"

for pkg in dsh-dynrestore dsh-plugmgr; do
  echo "[publish] $pkg -> @dsh-forge/$pkg@$VERSION"
  mkdir -p "$TMP/$pkg"
  cp -r "$ROOT/bundle/packages/$pkg/." "$TMP/$pkg/"
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
  (cd "$TMP/$pkg" && npm publish --access public --cache /tmp/npm-cache)
done

echo '[publish] 完成：@dsh-forge/dsh-dynrestore + @dsh-forge/dsh-plugmgr'
