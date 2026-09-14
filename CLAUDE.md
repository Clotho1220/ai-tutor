# CLAUDE.md — AI Tutor Studio 工作守則

新對話請依序讀：**本檔 → [`DEVLOG.md`](DEVLOG.md)（§0–4、§8）→ [`HANDOFF.md`](HANDOFF.md) → [`PROJECT-STATUS.md`](PROJECT-STATUS.md) 最新一節**。

與使用者溝通用**繁體中文**。使用者偏好「不用停，除非一定要我確認」：能自己判斷的就做完，
只有版權、公開與否、教學取向這類真正屬於使用者的決定才問。

---

## 進版檢查清單（每次都要做，缺一不可）

1. **版本號**：`app.js` 的 `APP_VERSION` ＋ `index.html` 的 `#appVersion`（兩處一起改）
2. **快取版本**：`index.html` 與 `tests/*.html` 裡所有 `?v=YYYYMMDDx` 一起推進
   （沒推就會出現「程式改好了、測試還是失敗」的假警報）
3. **產生物重跑到底**：改了 `letters.json`／`pearson-cuts.json` → `build-letters.py` → `build-units-from-gogo.py`
4. **測試**：`tests/run-all.html` 標題變 **ALLPASS**（12 組）；改到會出聲／會顯示的東西，要在瀏覽器實際跑一次並量時間
5. **更新文件**（使用者 2026-09-14 要求：每次進版都要更新 md）
   - `PROJECT-STATUS.md`：頂部版本與日期；在最上面新增 `### vX.XX` 一節（症狀、根因、修法、如何驗證）
   - `DEVLOG.md`：§4 進度表、§6 問題全紀錄（新問題寫「症狀 → 根因 → 修法 → 教訓」）、§8 待辦勾選／新增、附錄版本一覽加一列、頂部版本日期
   - `HANDOFF.md`：頂部版本日期、§0 一句話現況、§2 對照表、§4 新陷阱
6. **commit**（訊息結尾加 Co-Authored-By）→ **`git push origin main`**
7. **驗線上**：等 20–40 秒，開 <https://clotho1220.github.io/ai-tutor/index.html?cb=xxx> 確認版本號與關鍵資料
   （曾經 commit 沒 push，線上停在舊版好幾天）

---

## 環境陷阱

- **Python**：`python` 被 Microsoft Store 別名佔掉，一律用 `py -3`
- **ElevenLabs 金鑰**在使用者環境變數（User 範圍），現有 shell 可能讀不到：
  `$env:ELEVENLABS_API_KEY = [Environment]::GetEnvironmentVariable("ELEVENLABS_API_KEY","User")`；絕不要印出來
- **本機伺服器**：`preview_start` name=`ai-tutor`（`.claude/launch.json`，路徑 `D:/AI Develop/AI tutor`）；跨日後常常要重開
- **改檔方式**：複雜修改寫成 scratchpad 的 `.py` 補丁腳本（Write 工具寫檔 → `py -3` 執行），
  每個替換先 `assert old in s`。不要在 bash heredoc 裡寫含 `\n`、regex 的 Python 字串；不要用 index 切片改大檔
- **終端機中文亂碼**：PowerShell 先 `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8`
- **不要跑** `build-units.py`、`tools-add-book1.py`（舊產生器，會把 `units.json` 覆寫回薄資料）
- **不要手改** `units.json`、`letters.json`、`dialogues.json`（都是產生物）

---

## 分析使用者給的診斷檔

1. 先看 `exportedAt`，以及每場 `startedAt`、`metadata.appVersion`、`metadata.model`——確認是**新的那一場**
2. 「delay／沒反應」三步：
   - 學生 `student_talk_ended` → 下一個 AI 動靜隔幾秒
   - `ai_turn_completed.aiTranscriptLength` 是 0 的比例（**模型沒開口，不是網路**）
   - `plan_silent_turn`、`plan_report_nudged`、`plan_off_script_*`、`plan_tap_waiting` 次數
3. 字母課：`letter_player_started.clips`、`letter_audio_blocked`

---

## 設計原則（改東西前記得）

- 程式決定做什麼，模型只負責演；能讓程式判斷的就不給模型判斷
- 該藏的資訊不要放進給模型的指令
- 提示詞用正向敘述，而且**規則之間不能打架**（v3.49 教訓：「不准以問句結尾」讓 GPT 整輪沉默）
- 「卡片有在換」不等於「有在播」、「測試全過」不等於「線上資料正確」——要量、要讀真實產生物
- 發音與聽感只有使用者的耳朵能判，盡早做試聽頁交給他
- 同一個症狀被回報第二次，就回頭重查資料流，不要繼續疊修補
