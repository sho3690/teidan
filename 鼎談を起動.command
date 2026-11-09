#!/bin/zsh -l
# 鼎談 TEIDAN（サブスク版）を起動して、ブラウザで開く
cd "$(dirname "$0")" || exit 1
URL="http://127.0.0.1:8796/"
if curl -s -o /dev/null -m 2 -H 'x-teidan: 1' "${URL}api/status"; then
  open "$URL"
  echo "鼎談はすでに起動しています。ブラウザで開きました。このウィンドウは閉じてかまいません。"
  exit 0
fi
(sleep 1.5; open "$URL") &
exec node server.mjs
