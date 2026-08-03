# GPT Realtime 測試模組設定

GPT 模組預設使用較省費的 `gpt-realtime-2.1-mini` 與 WebRTC，並保留 `gpt-realtime` 品質模式。Gemini 現有入口保留，可在設定中切換；正式 API Key 只留在安全的短效憑證後端。

## 1. 建立 OpenAI API Key

在 OpenAI API 平台建立一把專用 Key，並替專案設定合理的每月支出上限。不要把 Key 貼進 `app.js`、`index.html`、GitHub 或手機瀏覽器。

## 2. 把 Key 放進 Apps Script 指令碼屬性

1. 開啟目前用來跨手機同步的 Google Apps Script 專案。
2. 將最新版 `sync.gs` 貼上並儲存。
3. 左側選「專案設定」。
4. 在「指令碼屬性」新增：
   - 屬性：`OPENAI_API_KEY`
   - 值：你的 OpenAI API Key
5. 不要改成放在試算表儲存格，也不要寫死在程式碼。

## 3. 重新部署 Apps Script

建立新的網頁應用程式版本，執行身分維持「我」，存取權維持目前手機同步使用的設定。完成後保留 `/exec` 網址。

## 4. 安全設計

手機只會取得單次 Realtime session 使用的短效憑證。正式 OpenAI API Key 留在 Apps Script；後端也會用雜湊後的學員識別值建立 `OpenAI-Safety-Identifier`。

下一階段會把這個模組接到設定頁的「Gemini／GPT（測試）」選項，再共用既有教材、學生資料、圖片工具與診斷紀錄。
