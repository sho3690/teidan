# 鼎談 TEIDAN

Claude・ChatGPT・Gemini の3つのAIが話し合って、ひとつの結論を出すWebアプリです。

**使う：** https://sho3690.github.io/teidan/

## 話し合いの流れ

1. **それぞれの考え**：3つのAIが、同じ問いにそれぞれ答えます（同時に）。
2. **意見交換**（1〜3回）：互いの意見を読み、同意する点・反対する点・考えを変えた点を述べます。
3. **まとめ**：まとめ役のAIが「結論」「合意した点」「意見が分かれた点」「それぞれの最終的な立場」を整理します。

結果は「テキストで保存」で Markdown ファイルとして保存できます。

## 必要なもの

各社の **APIキー**（2つ以上）。ChatGPT Plus などの月額プランとは別の、従量課金です。

| AI | キーの発行場所 |
| --- | --- |
| Claude | https://console.anthropic.com/settings/keys |
| ChatGPT | https://platform.openai.com/api-keys |
| Gemini | https://aistudio.google.com/apikey |

各社の管理画面で、月の上限額を決めておくと安心です。

## キーの扱い

- キーはブラウザから各社のAPIへ直接送られるだけです。このリポジトリやGitHub、その他のサーバーには送られません。
- 「この端末に保存する」を選ぶと、合言葉（8文字以上）で暗号化（PBKDF2 + AES-GCM）してブラウザに保存します。
- 保存しない場合、ページを閉じるとキーは消えます。
- ページ内で読み込めるのは自分のファイルと3社のAPIだけに制限しています（Content Security Policy）。

## 仕組み

ビルド不要の静的サイトです（`index.html` / `style.css` / `app.js`）。GitHub Pages で公開しています。

モデルは、キーを入れた時に各社の一覧を取得し、上位のモデルを自動で選びます。設定画面で変更できます。
