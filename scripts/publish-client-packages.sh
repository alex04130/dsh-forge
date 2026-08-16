#!/usr/bin/env bash
# 发布 @dsh-forge 客户端包：复制到临时目录改写 name、去掉 private 后发布，
# 源码里的 @local 名保持不动（生产 file-copy 布局专用）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for pkg in dsh-dynrestore dsh-plugmgr; do
  echo "[publish] $pkg -> @dsh-forge/$pkg"
  mkdir -p "$TMP/$pkg"
  cp -r "$ROOT/bundle/packages/$pkg/." "$TMP/$pkg/"
  node -e "
    const fs = require('fs')
    const f = '$TMP/$pkg/package.json'
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    j.name = '@dsh-forge/$pkg'
    delete j.private
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n')
  "
  (cd "$TMP/$pkg" && npm publish --access public --cache /tmp/npm-cache)
done

echo '[publish] 完成：@dsh-forge/dsh-dynrestore + @dsh-forge/dsh-plugmgr'
