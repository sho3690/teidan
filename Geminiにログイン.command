#!/bin/zsh -l
# 鼎談専用の Gemini にGoogleアカウントでログインする（普段の Gemini の設定とは別の場所）
cd "$(dirname "$0")" || exit 1
node -e "import('./server.mjs').then((m) => m.ensureGeminiHome())" || exit 1
WORK=$(mktemp -d)
cd "$WORK" || exit 1
echo "ブラウザが開いたら、Googleアカウントでログインしてください。"
echo "ログインできたら、この画面で /quit と入れて閉じます。"
echo
env -u GEMINI_API_KEY -u GOOGLE_API_KEY -u GOOGLE_GENAI_USE_VERTEXAI GEMINI_CLI_HOME="$HOME/.teidan/gemini-home" gemini
cd / && rm -rf "$WORK"
