// ============================================================
// AI English Tutor - app.js (v2)
// 主要變更：
// 1. 生圖改用正規 function calling（toolCall / toolResponse），不再攔截文字標籤
// 2. 啟用 inputAudioTranscription / outputAudioTranscription，
//    使用者與 AI 的逐字稿由伺服器回傳，移除 webkitSpeechRecognition 需求
// 3. 喇叭模式改走 <audio> 媒體播放路徑（MediaStreamDestination），
//    避開 Android 通話模式強制聽筒；echoCancellation 全程開啟，
//    移除原本 0.8 秒半雙工 gate
// 4. 新增插話中斷處理：收到 serverContent.interrupted 時停止所有排程音訊
// ============================================================

// ===== GAS 後端設定 =====
// 貼上你部署的 GAS 網頁應用程式網址（https://script.google.com/macros/s/....../exec）。
// 填了之後：連線改用後端簽發的臨時憑證（不需輸入 API Key），單字自動記錄到試算表。
// 留空則退回舊模式：使用下方欄位手動輸入的 API Key。
const GAS_URL = "";

let currentToken = null; // 本場課程的臨時憑證（有效期內斷線重連沿用同一張）

// API Key 不再寫死於程式碼：改由頁面輸入，記憶在瀏覽器 localStorage（只存在使用者自己的裝置）。
// 這讓程式碼可以安全地公開部署（如 GitHub Pages）。
// 若已設定 GAS_URL，則完全不需要這個欄位。
let GEMINI_API_KEY = "";
const apiKeyInput = document.getElementById('apiKeyInput');
apiKeyInput.value = localStorage.getItem('gemini_api_key') || "";
function readApiKey() {
    GEMINI_API_KEY = apiKeyInput.value.trim();
    if (GEMINI_API_KEY) localStorage.setItem('gemini_api_key', GEMINI_API_KEY);
    return GEMINI_API_KEY;
}

let webSocket = null;
let audioContext = null;
let audioWorkletNode = null;
let micStream = null;

let nextPlayTime = 0;
let activeSources = [];        // 追蹤排程中的音訊來源，供插話中斷時停止
let mediaDest = null;          // 喇叭模式：MediaStreamAudioDestinationNode
let speakerEl = null;          // 喇叭模式：隱藏的 <audio> 元素

let isNewAiTurn = true;
let isNewUserTurn = true;

let isTalking = false;         // Push-to-talk：目前是否正在說話（上傳麥克風）
let stagePendingSince = null;  // 階段時間已到、正在等待自然切換點的時間戳（elapsedTime）
let lastUserSpeechTime = 0;    // 延遲量測：按下「說完了」的時間
let waitingFirstAudio = false; // 延遲量測：是否正在等待 AI 本輪第一塊音訊

let lessonTimer = null;
let elapsedTime = 0;
let currentStageIndex = 0;
let pendingDirectorNote = null; // 已送出但 AI 尚未回應的導演指令；若此時斷線，重連後重送（否則新階段開場會消失）

let userStopped = false;       // 使用者主動按「結束連線」（區別於意外斷線）
let resumeHandle = null;       // Live API session resumption 握把，重連時恢復對話記憶
let reconnectAttempts = 0;     // 意外斷線後的重連次數
let turnChunks = [];           // 當前這句話的音訊暫存（斷線重連後整句重送用）
let needsReplay = false;       // 重連後是否需要重送暫存的語音
let lastReplayTime = 0;        // 上次重送的時間（保險絲：重送後立刻又斷線就放棄，避免迴圈）

const actionBtn = document.getElementById('actionBtn');
const statusBadge = document.getElementById('statusBadge');
const stageIndicator = document.getElementById('stageIndicator');
const sysLogBox = document.getElementById('sysLogBox');
const aiSpeechBox = document.getElementById('aiSpeechBox');
const userSpeechBox = document.getElementById('userSpeechBox');
const generatedImage = document.getElementById('generatedImage');
const imageCaption = document.getElementById('imageCaption');
const voiceSelect = document.getElementById('voiceSelect');
const talkBtn = document.getElementById('talkBtn');
const nextStageBtn = document.getElementById('nextStageBtn');

// 測試用：手動跳到下一階段
nextStageBtn.addEventListener('click', () => sendStageTransition('manual'));

// ---------------- Push-to-talk 按鈕 ----------------
// 按一下開始說話（開始上傳麥克風 + 通知伺服器 activityStart），
// 再按一下結束（通知 activityEnd，AI 隨即回應）。
talkBtn.addEventListener('click', () => {
    if (!isTalking) {
        // 開始說話需要活著的連線（重連中請稍等 1-2 秒）
        if (!webSocket || webSocket.readyState !== WebSocket.OPEN) return;
        stopAllPlayback(); // 使用者要說話了，立刻讓 AI 安靜
        turnChunks = [];   // 開始新的一句，清空暫存
        needsReplay = false;
        webSocket.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
        isTalking = true;
        isNewUserTurn = true;
        talkBtn.classList.add('talking');
        talkBtn.textContent = '🔴 說完了，按一下送出';
    } else {
        isTalking = false;
        talkBtn.classList.remove('talking');
        talkBtn.textContent = '🎙️ 按一下開始說話';
        lastUserSpeechTime = performance.now();
        waitingFirstAudio = true;
        if (webSocket && webSocket.readyState === WebSocket.OPEN) {
            webSocket.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
            // 有掛起的階段：學生剛說完、輪到 AI 回應，此刻附上轉場指令最自然
            if (stagePendingSince !== null) sendStageTransition('graceful');
        } else {
            // 說到一半斷線了：這句話已完整暫存，重連後自動重送
            needsReplay = true;
            logSystem("📦 連線中斷，這句話已暫存，重連後會自動重送。");
        }
    }
});

// 導演筆記前綴：明確告訴模型這不是學生說的話，禁止替學生回答
const DIRECTOR_PREFIX = "[DIRECTOR NOTE - hidden instruction from the lesson system, NOT from the student. " +
    "The student has NOT spoken. Do not reply to this note, do not speak for the student, never mention it. Instruction: ";

// ---------------- 教案系統（Phase 1）----------------
// 課程內容不再寫死：啟動時依序嘗試
//   1. GAS 後端 getLesson（未來的「慢腦」自動排課）
//   2. 同目錄的 lesson.json（手寫教案，目前的主要來源）
//   3. 內建預設課程（保底，等同舊版行為）
// 教案格式見 lesson.json。

const DEFAULT_LESSON = {
    student: { name: "同學", level: 2, interests: [] },
    unit: "一般練習",
    stages: [
        { label: "開場暖身", minutes: 3, goal: "Greet the student warmly and make light small talk with ONE simple question, then wait for their reply." },
        { label: "複習", minutes: 3, goal: "Review previously learned words with the student, one word at a time, waiting for each answer." },
        { label: "主題課程", minutes: 8, goal: "Main lesson: introduce today's topic, teach new vocabulary (call show_image for each visual word), and practice with short interactive questions, one at a time." },
        { label: "總結", minutes: 1, goal: "Wrap up: summarize what was learned today in simple terms, praise the student, and say goodbye." }
    ]
};

let LESSON = null;        // 本堂課的教案（startSession 時載入）
let teachingFlow = [];    // 由教案展開的階段時間表（隱形導演使用）

async function loadLesson() {
    // 0) 老師在畫面上貼的自訂教材，優先於一切
    const custom = readCustomMaterial();
    if (custom) {
        logSystem(`📋 使用自訂教材（單元：${custom.unit}）。`);
        return custom;
    }
    // 1) GAS 慢腦排課（後端尚未實作 getLesson 時會自然落空，往下走）
    if (GAS_URL) {
        const r = await gasPost({ action: "getLesson" });
        if (r && r.stages && r.stages.length) {
            logSystem("📋 已從後端取得今日教案。");
            return r;
        }
    }
    // 2) 手寫教案檔（?t= 避免 GitHub Pages 快取到舊版）
    try {
        const res = await fetch("lesson.json?t=" + Date.now());
        if (res.ok) {
            const j = await res.json();
            // 接受兩種格式：單日教案（stages）或週教案（week，稍後由 resolveLessonForToday 挑出今天）
            if (j && ((j.stages && j.stages.length) || (j.week && j.week.length))) {
                logSystem(`📋 已載入 lesson.json 教案（單元：${j.unit || "未命名"}${j.week ? "，週教案 " + j.week.length + " 天" : ""}）。`);
                return j;
            }
        }
    } catch (e) { /* 沒有 lesson.json 就用預設 */ }
    // 3) 內建預設
    logSystem("📋 找不到教案，使用內建預設課程。");
    return DEFAULT_LESSON;
}

// ---------------- 週教案：決定今天上第幾天 ----------------
// 教案含 week 陣列時：
//   - 下拉選單選了特定天 → 用那一天（測試/補課用）
//   - 選「自動」→ 依日期推進：換了新的一天就前進一天；
//     同一天內重複開課，上的是同一天的課（練習同樣內容不跳課）。
//   進度記在 localStorage，以單元名稱為 key，換單元自動從第 1 天開始。

function resolveLessonForToday(json) {
    if (!json.week || !json.week.length) return json; // 單日教案，直接用

    const days = json.week;
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const progressKey = "week_progress::" + (json.unit || "default");
    let chosen = null;

    const daySelect = document.getElementById('daySelect');
    const manual = daySelect ? daySelect.value : "auto";

    if (manual !== "auto") {
        const n = parseInt(manual, 10);
        chosen = days.find(d => d.day === n) || days[Math.min(n, days.length) - 1];
        logSystem(`📅 手動指定：第 ${chosen.day} 天（${chosen.focus || ""}）`);
    } else {
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem(progressKey)); } catch (e) {}
        let dayNum;
        if (saved && saved.date === today) {
            dayNum = saved.day;               // 今天已上過：重複同一天
        } else if (saved && saved.day) {
            dayNum = Math.min(saved.day + 1, days.length); // 新的一天：前進
        } else {
            dayNum = 1;                        // 這個單元第一次上課
        }
        chosen = days.find(d => d.day === dayNum) || days[0];
        logSystem(`📅 自動排課：第 ${chosen.day} 天 / 共 ${days.length} 天（${chosen.focus || ""}）` +
                  (chosen.day === days.length ? " — 本單元最後一天！" : ""));
    }

    localStorage.setItem(progressKey, JSON.stringify({ date: today, day: chosen.day }));
    return {
        student: json.student,
        unit: `${json.unit || ""} — Day ${chosen.day}${chosen.focus ? "（" + chosen.focus + "）" : ""}`,
        stages: chosen.stages
    };
}

// 教案項目 → 給老師看的文字（含中文意思與例句，老師講解時直接取用）
function itemToText(it) {
    if (typeof it === "string") return it;
    let s = it.english || "";
    if (it.chinese) s += ` (${it.chinese})`;
    if (it.example) s += ` — example: "${it.example}"`;
    return s;
}

// 單一階段 → 導演指令文字
function buildStagePrompt(stage) {
    let p = stage.goal || "";
    if (stage.items && stage.items.length) {
        p += " Target items for this stage (teach/review them ONE at a time): " +
             stage.items.map(itemToText).join("; ") + ".";
    }
    if (stage.activity) p += " Activity: " + stage.activity;
    return p;
}

// 教案 stages（每階段幾分鐘）→ 累計秒數時間表
function buildTeachingFlow(lesson) {
    let t = 0;
    return lesson.stages.map((s, i) => {
        const entry = {
            time: t,
            name: `階段 ${i + 1}：${s.label || s.name || "未命名"} (${s.minutes}分)`,
            prompt: buildStagePrompt(s)
        };
        t += (s.minutes || 1) * 60;
        return entry;
    });
}

// ---------------- 自訂教材（老師從 Excel 貼上課本單元表格） ----------------
// 表格四欄：type / english / chinese / example。
// 只認得 type 欄含 Theme / Sentence Pattern / Word 的列，標題列、表頭、雜訊列自動略過。
const MATERIAL_KEY = "custom_material_v1";

function parseMaterial(raw) {
    let theme = "";
    const patterns = [];
    const words = [];
    (raw || "").split(/\r?\n/).forEach(line => {
        const cells = line.split("\t").map(c => c.trim());
        if (cells.length < 2) return;
        const type = (cells[0] || "").toLowerCase();
        const english = cells[1] || "";
        const chinese = (cells[2] || "").replace(/\*\*/g, "").trim();
        let example = (cells[3] || "").trim();
        if (example === "-" || example === "—") example = "";
        if (!english) return;
        if (type.includes("theme")) {
            theme = english + (chinese ? "（" + chinese + "）" : "");
        } else if (type.includes("sentence") || type.includes("pattern")) {
            patterns.push({ english, chinese, example });
        } else if (type.includes("word")) {
            words.push({ english, chinese, example });
        }
    });
    if (!patterns.length && !words.length) return null;
    return { theme, patterns, words };
}

function describeMaterial(m) {
    const t = m.theme ? "主題「" + (m.theme.length > 24 ? m.theme.slice(0, 24) + "…" : m.theme) + "」、" : "";
    return t + m.patterns.length + " 個句型、" + m.words.length + " 個單字";
}

// 自訂教材 → 完整 lesson 物件（單堂約 16 分鐘，四階段）
function buildLessonFromMaterial(m, student) {
    const themeLine = m.theme || "today's textbook unit";
    return {
        student: student,
        unit: m.theme || "自訂教材",
        stages: [
            { label: "開場暖身", minutes: 2,
              goal: "Greet the student warmly BY NAME, make light small talk with ONE simple question (use their interests if any), then tell them in simple terms what today is about: " + themeLine + "." },
            { label: "句型", minutes: 4,
              goal: "Teach today's target sentence patterns ONE at a time: say it, explain what it means and when to use it, give the example, then have the student repeat. Wait after each.",
              items: m.patterns },
            { label: "單字與練習", minutes: 8,
              goal: "Teach today's words ONE at a time: say it, call show_image for concrete nouns, give the Traditional Chinese meaning, have the student repeat, then call log_vocabulary. After a few words, drill the patterns by swapping these words in.",
              items: m.words,
              activity: "Role-play a natural everyday scene that fits today's theme, using the patterns and words. The student speaks the target lines; if they freeze, feed the line in Chinese first, then let them say it in English. Swap roles once so the student also answers." },
            { label: "總結", minutes: 2,
              goal: "Wrap up in simple terms (Traditional Chinese is fine): remind them of today's main pattern, praise ONE specific thing they did well, and say goodbye warmly." }
        ]
    };
}

// 畫面上設定的學生名字／興趣，覆蓋任何教案來源（lesson.json、自訂教材、內建預設）裡的學生設定
function applyStudentOverride(lesson) {
    if (!lesson.student) lesson.student = {};
    const n = (localStorage.getItem('student_name') || '').trim();
    const i = (localStorage.getItem('student_interests') || '').trim();
    if (n) lesson.student.name = n;
    if (i) lesson.student.interests = i.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    return lesson;
}

// 讀取已儲存的自訂教材，組成今日 lesson（沒有就回 null，讓程式退回 lesson.json）
function readCustomMaterial() {
    try {
        const saved = JSON.parse(localStorage.getItem(MATERIAL_KEY));
        if (saved && saved.material && (saved.material.patterns.length || saved.material.words.length)) {
            const student = {
                name: saved.studentName || "同學",
                level: 1,                       // 預設 70% 中文；畫面上的「程度」選單可即時覆蓋
                interests: saved.interests || []
            };
            return buildLessonFromMaterial(saved.material, student);
        }
    } catch (e) {}
    return null;
}

// 自訂教材面板：套用 / 清除 / 載入時回填狀態
(function initMaterialPanel() {
    const input = document.getElementById('materialInput');
    const nameEl = document.getElementById('studentName');
    const interestsEl = document.getElementById('studentInterests');
    const status = document.getElementById('materialStatus');
    const applyBtn = document.getElementById('applyMaterialBtn');
    const clearBtn = document.getElementById('clearMaterialBtn');
    if (!input || !applyBtn) return;

    try {
        const saved = JSON.parse(localStorage.getItem(MATERIAL_KEY));
        if (saved && saved.material) {
            status.style.color = "#4af626";
            status.textContent = "✅ 目前使用自訂教材：" + describeMaterial(saved.material);
        }
    } catch (e) {}

    // 學生名字／興趣：獨立記憶，適用於「所有」教案來源（不限自訂教材），打字即存
    if (nameEl) {
        nameEl.value = localStorage.getItem('student_name') || "";
        nameEl.addEventListener('input', () => localStorage.setItem('student_name', nameEl.value.trim()));
    }
    if (interestsEl) {
        interestsEl.value = localStorage.getItem('student_interests') || "";
        interestsEl.addEventListener('input', () => localStorage.setItem('student_interests', interestsEl.value.trim()));
    }

    applyBtn.addEventListener('click', () => {
        const m = parseMaterial(input.value);
        if (!m) {
            status.style.color = "#ff6b6b";
            status.textContent = "⚠️ 沒讀到句型或單字。請確認是從 Excel 複製的四欄表格（type/english/chinese/example）。";
            return;
        }
        const payload = {
            material: m,
            studentName: (nameEl && nameEl.value.trim()) || "",
            interests: (interestsEl && interestsEl.value.trim())
                ? interestsEl.value.split(/[,，]/).map(s => s.trim()).filter(Boolean) : []
        };
        localStorage.setItem(MATERIAL_KEY, JSON.stringify(payload));
        status.style.color = "#4af626";
        status.textContent = "✅ 已套用！" + describeMaterial(m) + "。下次按「開始連線」生效。";
    });

    clearBtn.addEventListener('click', () => {
        localStorage.removeItem(MATERIAL_KEY);
        input.value = "";
        status.style.color = "#aaa";
        status.textContent = "已清除自訂教材，將改用內建的 lesson.json。";
    });
})();

// Level 1-5 → 中英文配比指示
function languagePolicy(level) {
    switch (level) {
        case 1: return "Speak about 70% Traditional Chinese (Taiwan usage): explain everything in Chinese, use English ONLY for the target words and sentence patterns, and have the student repeat after you.";
        case 2: return "Speak roughly half Chinese, half English: set up situations and give explanations in Traditional Chinese, but ask questions in simple English and expect short English answers.";
        case 3: return "Speak mostly English (about 70%): introduce new concepts in English first, then confirm once briefly in Traditional Chinese.";
        case 4: return "Speak almost entirely English: use Traditional Chinese only when the student is clearly stuck.";
        case 5: return "Speak English only, unless the student explicitly asks for Chinese.";
        default: return languagePolicy(2);
    }
}

// 介面上的「程度」選單可即時覆蓋教案裡的 level（選 auto 時沿用教案設定，改動於下次連線生效）。
function readLevelOverride(lessonLevel) {
    const sel = document.getElementById('levelSelect');
    if (sel && sel.value !== 'auto') {
        const n = parseInt(sel.value, 10);
        if (n >= 1 && n <= 5) return n;
    }
    return lessonLevel;
}

// 依教案組裝完整 system prompt
function buildSystemInstruction(lesson) {
    const st = lesson.student || {};
    const interests = (st.interests || []).join(", ");
    const level = readLevelOverride(st.level || 2);
    return "You are a friendly English tutor in a LIVE VOICE conversation with ONE student. " +
        `STUDENT PROFILE: ${st.name || "the student"}, a young Mandarin-speaking learner, level ${level} of 5. ` +
        (interests ? `The student's interests are: ${interests} — use them in your examples and small talk. ` : "") +
        `TODAY'S UNIT: ${lesson.unit || "general practice"}. Stay on this unit's topic and target items; do not wander to other material. ` +
        "LANGUAGE POLICY: " + languagePolicy(level) + " " +
        "RESCUE RULE (overrides the ratio): if the student answers an English question in Chinese, says 「蛤？」or「什麼意思？」, or seems lost, immediately explain the last point in Traditional Chinese, then retry with SIMPLER English. " +
        "TEACHING STYLE: " +
        "(a) Say at most TWO short sentences per turn, then stop. Waiting silently is part of teaching. " +
        "(b) Ask at most ONE short question, then STOP and wait for the student's real reply. " +
        "(c) RECAST RULE — after the student replies, model good English based on what they actually said: " +
        "if they replied in CHINESE, praise briefly, then show them how to say it in simple English and have them repeat (e.g. student says 「我很好！」 → say: Good! And you can say: \"I am fine!\" Try it!); " +
        "if they replied in ENGLISH with mistakes, never say 'wrong': acknowledge their meaning, naturally restate the corrected sentence, and invite them to try once more; " +
        "if their English was already CORRECT, praise them — and at most TWICE per lesson, also show ONE alternative way to say the same thing (e.g. Great! You can also say: \"I'm doing great!\"). After you have done this twice in a lesson, just praise and move on. " +
        "STRICT RULES: " +
        "(1) NEVER answer your own questions. NEVER speak for the student or invent their replies. There is only one voice: yours. " +
        "(2) Messages starting with [DIRECTOR NOTE] are hidden stage directions from the lesson system, not from the student. Follow them silently; never read or mention them. " +
        "(3) When you mention a concrete visual noun (like 'apple', 'cat', 'UFO'), call the show_image tool. When you teach a NEW word, also call the log_vocabulary tool with the word, its Traditional Chinese meaning, and a short example sentence. Tool calls are silent actions: never say 'show_image', 'log_vocabulary', '[System]', braces, or any code-like text out loud. " +
        "(4) Keep exactly the same voice, tone, accent, speaking speed and persona for the ENTIRE lesson. Do not change your voice character between stages. " +
        "(5) PACING: the lesson is run by DIRECTOR NOTES, stage by stage. Work ONLY on the current stage's task. NEVER run ahead to future material, NEVER summarize the whole day, and NEVER end the lesson or say goodbye on your own — the lesson ends ONLY when a DIRECTOR NOTE explicitly tells you to wrap up. If you finish the current task early, keep practicing it in new playful ways until the next DIRECTOR NOTE arrives.";
}

function logSystem(msg) {
    sysLogBox.innerHTML += `[${new Date().toLocaleTimeString()}] ${msg}<br>`;
    sysLogBox.scrollTop = sysLogBox.scrollHeight;
}

// ---------------- 連線控制 ----------------

actionBtn.addEventListener('click', async () => {
    if (!GAS_URL && !readApiKey()) { alert("請先在左上角欄位填入 Gemini API Key！"); apiKeyInput.focus(); return; }
    if (!webSocket && !micStream) {
        if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        if (audioContext.state === 'suspended') audioContext.resume();
        startSession();
    } else {
        userStopped = true; // 使用者主動結束，不要自動重連
        stopSession();
    }
});

async function startSession() {
    statusBadge.textContent = '連線中...'; statusBadge.style.background = '#0e639c'; statusBadge.style.color = '#fff';
    actionBtn.textContent = '連線中...'; actionBtn.disabled = true;
    elapsedTime = 0; currentStageIndex = 0; stagePendingSince = null; pendingDirectorNote = null;
    userStopped = false; resumeHandle = null; reconnectAttempts = 0;
    isNewAiTurn = true; isNewUserTurn = true;
    aiSpeechBox.innerHTML = '';
    userSpeechBox.innerHTML = '<span style="color:#888;">等待語音輸入...</span>';
    generatedImage.style.display = 'none';
    imageCaption.textContent = "等待 AI 呼叫 show_image ...";
    logSystem("正在請求麥克風權限...");

    try {
        const mode = document.querySelector('input[name="audioMode"]:checked').value;
        micStream = await acquireMicStream(mode);
        await setupAudioWorklet();

        // 載入今日教案（GAS → lesson.json → 內建預設），週教案先解析出今天上第幾天
        LESSON = applyStudentOverride(resolveLessonForToday(await loadLesson()));
        prefetchLessonImages(LESSON);
        teachingFlow = buildTeachingFlow(LESSON);
        const totalMin = LESSON.stages.reduce((a, s) => a + (s.minutes || 0), 0);
        logSystem(`📋 課程結構：${teachingFlow.map(s => s.name).join(" → ")}（共 ${totalMin} 分鐘）`);

        // 有 GAS 後端：先換取本場課程的臨時憑證
        currentToken = null;
        if (GAS_URL) {
            logSystem("🔑 向後端請求臨時憑證...");
            const result = await gasPost({ action: "getToken" });
            if (result && result.token) {
                currentToken = result.token;
                logSystem("🔑 已取得臨時憑證（30 分鐘有效）。");
            } else {
                logSystem(`<span style="color:#ff8800;">⚠️ 憑證取得失敗：${result && result.error ? result.error : '無回應'}，退回 API Key 模式。</span>`);
                if (!readApiKey()) throw new Error("無憑證也無 API Key，無法連線");
            }
        }

        connectWebSocket(false);
    } catch (err) {
        logSystem(`<span style="color:#ff4444;">❌ 啟動失敗: ${err.message}</span>`);
        stopSession();
    }
}

// 與 GAS 後端溝通（POST body 為純文字 JSON，避免瀏覽器 CORS preflight）
async function gasPost(data) {
    try {
        const res = await fetch(GAS_URL, { method: "POST", body: JSON.stringify(data) });
        return await res.json();
    } catch (err) {
        return { error: err.message };
    }
}

// 單字寫入試算表（fire-and-forget，不阻塞對話）
// ---------------- 學生畫面 ----------------
// 明亮的全螢幕檢視，只顯示孩子需要的：大圖、單字、中文意思、「你說說看」例句。
// 資料來源：AI 的 show_image / log_vocabulary 工具呼叫。
(function initStudentView() {
    const enterBtn = document.getElementById('studentModeBtn');
    const exitBtn = document.getElementById('exitStudentBtn');
    if (enterBtn) enterBtn.addEventListener('click', () => document.body.classList.add('student-mode'));
    if (exitBtn) exitBtn.addEventListener('click', () => document.body.classList.remove('student-mode'));
})();

// 學生畫面顯示單字（log_vocabulary 完整覆蓋；show_image 只先換字）
function studentShowWord(word, meaning, example) {
    const w = document.getElementById('svWord');
    if (!w) return;
    if (word) w.textContent = word;
    const m = document.getElementById('svMeaning');
    if (m) m.textContent = meaning || "";
    const box = document.getElementById('svSayBox'), s = document.getElementById('svSay');
    if (box && s) {
        if (example) { s.textContent = example; box.style.display = 'block'; }
        else box.style.display = 'none';
    }
}

// 學生畫面顯示圖片（與除錯面板共用同一張圖網址，瀏覽器快取只載一次）
function studentShowImage(url) {
    const img = document.getElementById('svImage'), ph = document.getElementById('svImagePlaceholder');
    if (!img) return;
    img.onload = () => { img.style.display = 'block'; if (ph) ph.style.display = 'none'; };
    img.src = url;
}

// 開課時在背景預先繪製本課單字的圖片（同樣的網址進瀏覽器快取，
// AI 課中呼叫 show_image 時圖片幾乎瞬間顯示，解決生圖跟不上教學節奏的問題）
function prefetchLessonImages(lesson) {
    const words = [];
    (lesson.stages || []).forEach(s => (s.items || []).forEach(it => {
        const w = (it.english || "").trim();
        // 只預抓單字（跳過句型：太長、含 ? 或 [noun] 佔位符的不是可畫的名詞）
        if (w && w.length <= 20 && !w.includes('?') && !w.includes('[') && !w.includes('/')) words.push(w);
    }));
    const unique = [...new Set(words)].slice(0, 12); // 上限 12 張，避免流量浪費
    unique.forEach(w => {
        const prompt = "A simple, educational illustration of " + w + ", white background";
        new Image().src = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=400&height=400&nologo=true`;
    });
    if (unique.length) logSystem(`🖼️ 已在背景預先繪製 ${unique.length} 個單字圖片（AI 教到時可即時顯示）。`);
}

function logVocabToSheet(word, meaning, example) {
    if (!GAS_URL) return;
    const stageName = currentStageIndex > 0 && teachingFlow[currentStageIndex - 1] ? teachingFlow[currentStageIndex - 1].name : "";
    gasPost({ action: "logVocab", word, meaning, example, stage: stageName })
        .then(r => { if (r && r.ok) logSystem(`📚 已記錄單字: ${word}`); });
}

// 建立（或重建）WebSocket 連線。isReconnect = true 表示意外斷線後的自動重連，
// 會保留麥克風、AudioWorklet、課程進度，並用 resumeHandle 恢復 AI 的對話記憶。
function connectWebSocket(isReconnect) {
    // 臨時憑證走 v1alpha 端點（access_token 參數）；API Key 走原本的 v1beta 端點
    const url = currentToken
        ? `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${currentToken}`
        : `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
    webSocket = new WebSocket(url);

    webSocket.onopen = () => {
        statusBadge.textContent = '🟢 已連線'; statusBadge.style.background = '#28a745';
        actionBtn.textContent = '結束連線'; actionBtn.disabled = false;
        talkBtn.disabled = false;
        nextStageBtn.disabled = false;
        // 注意：重連次數不在這裡歸零。連線握手成功不代表設定被接受——
        // 若模型無效，伺服器會在 setup 後立刻踢斷，在這歸零會造成無限重連迴圈。
        // 歸零改在收到 setupComplete（伺服器真正接受設定）時。
        sendSetupMessage();
        startLessonTimer();
        if (isReconnect) {
            logSystem(resumeHandle
                ? "🔄 已重新連上，對話記憶已透過 resumption handle 恢復。"
                : "🔄 已重新連上（尚未取得恢復握把，AI 對話記憶重置，課程進度不受影響）。");
        }
    };

    webSocket.onmessage = async (event) => {
        try {
            let textData = event.data;
            if (event.data instanceof Blob) textData = await event.data.text();
            const response = JSON.parse(textData);
            handleServerMessage(response);
        } catch (err) {
            logSystem(`<span style="color:#ff4444;">訊息解析失敗: ${err.message}</span>`);
        }
    };

    webSocket.onclose = (e) => {
        logSystem(`<span style="color:#ff8800;">WebSocket 關閉 (code=${e.code}${e.reason ? ', reason=' + e.reason : ''})</span>`);
        if (e.code === 1011) logSystem("（code 1011 = Gemini 伺服器內部錯誤，服務端偶發問題，靠重連恢復）");
        if (userStopped) { stopSession(); return; }
        // 設定類錯誤（如模型不存在/不支援）：重連也不會好，直接停下並指引使用者，避免無限重連迴圈
        if (e.code === 1008 && /not found|not supported/i.test(e.reason || "")) {
            logSystem("<span style='color:#ff4444;'>❌ 你選的模型已失效（Google 下架或改名了）。請在上方「模型選擇」換一個（建議第一個「原生語音」），再按「開始連線」。</span>");
            alert("這個模型已失效（Google 可能已下架或改名）。\n請在「模型選擇」換一個模型，建議選第一個「原生語音」，然後重新連線。");
            stopSession();
            return;
        }
        // 保險絲：剛重送完就又被斷線，代表重送內容被伺服器拒絕（如 activity 狀態衝突），
        // 作廢這句避免無限迴圈，請使用者重講
        if (needsReplay === false && lastReplayTime && Date.now() - lastReplayTime < 4000) {
            turnChunks = [];
            lastReplayTime = 0;
            logSystem("<span style='color:#ff8800;'>⚠️ 語音重送遭伺服器拒絕，該句作廢。重連後請再說一次。</span>");
            if (isTalking) {
                isTalking = false;
                talkBtn.classList.remove('talking');
                talkBtn.textContent = '🎙️ 按一下開始說話';
            }
        } else if (isTalking || waitingFirstAudio) {
            // 斷線時使用者正在說話或正在等 AI 回應：標記重連後重送這句話。
            // 不重置 isTalking，使用者可以繼續講，音訊會進暫存不會漏字
            needsReplay = true;
        }
        if (reconnectAttempts < 3) {
            reconnectAttempts++;
            statusBadge.textContent = '🔄 重連中...'; statusBadge.style.background = '#b8860b';
            logSystem(`🔄 無預警斷線，自動重連 ${reconnectAttempts}/3 ...`);
            setTimeout(() => connectWebSocket(true), 800);
        } else {
            logSystem("❌ 多次重連失敗，結束連線。");
            stopSession();
        }
    };

    webSocket.onerror = () => {
        logSystem('<span style="color:#ff4444;">WebSocket 發生錯誤</span>');
    };
}

// （原本這裡有「閒置保活」機制：每 8 秒送靜音。已移除——
//   手動 VAD 模式下，活動範圍外送音訊會被伺服器以 1007 invalid argument 拒絕並斷線，
//   反而造成連環斷線迴圈。閒置斷線的風險改由自動重連＋重送機制承擔。）

// ---------------- Setup 訊息（含工具宣告與逐字稿） ----------------

function sendSetupMessage() {
    const selectedModel = document.getElementById('modelSelect').value;
    const generationConfig = {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceSelect.value } } }
    };
    // thinkingConfig 僅原生語音（會思考的）模型需要；half-cascade 模型不接受此欄位
    if (selectedModel.includes("native-audio")) {
        generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }
    const setup = {
        setup: {
            model: selectedModel,
            generationConfig,
            // 伺服器端轉文字：使用者上行音訊 + AI 實際說出的內容
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            // 啟用 session resumption：伺服器會定期發恢復握把，
            // 意外斷線重連時帶上握把即可恢復 AI 的對話記憶
            sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
            // Push-to-talk 模式：關閉自動 VAD，
            // 改由前端發送 activityStart / activityEnd 手動標記說話起訖
            realtimeInputConfig: {
                automaticActivityDetection: { disabled: true }
            },
            // 正規 function calling：生圖改為結構化工具呼叫
            tools: [{
                functionDeclarations: [{
                    name: "show_image",
                    description: "Show the student an educational illustration of a concrete noun. Call this every time you mention or teach a visual, concrete noun (e.g. 'apple', 'UFO', 'elephant'). Call it BEFORE or WHILE you talk about the noun.",
                    parameters: {
                        type: "OBJECT",
                        properties: {
                            keyword: { type: "STRING", description: "A short English noun phrase describing what to draw, e.g. 'red apple' or 'UFO in the sky'." }
                        },
                        required: ["keyword"]
                    }
                }, {
                    name: "log_vocabulary",
                    description: "Silently save a vocabulary word to the student's learning record. Call this every time you TEACH a new word or the student LEARNS/struggles with a word worth reviewing later.",
                    parameters: {
                        type: "OBJECT",
                        properties: {
                            word: { type: "STRING", description: "The English word or phrase taught" },
                            meaning: { type: "STRING", description: "Traditional Chinese meaning, e.g. 雨傘" },
                            example: { type: "STRING", description: "A short example sentence in English" }
                        },
                        required: ["word", "meaning"]
                    }
                }]
            }],
            systemInstruction: {
                parts: [{
                    // system prompt 依本堂教案動態組裝（學生檔案、語言配比、教學風格、既有嚴格規則）
                    text: buildSystemInstruction(LESSON || DEFAULT_LESSON)
                }]
            }
        }
    };
    webSocket.send(JSON.stringify(setup));
    logSystem(`Setup 已送出（模型: ${selectedModel.split('/').pop()}）。`);
}

// ---------------- 伺服器訊息處理 ----------------

function handleServerMessage(response) {
    // 0) 連線生命週期訊息
    if (response.setupComplete) {
        reconnectAttempts = 0; // 伺服器接受設定，連線真正健康，重連次數才歸零
        // 重連完成後，重送斷線時遺失的那句話
        if (needsReplay && turnChunks.length > 0) {
            logSystem(`📤 重送剛才的語音（${turnChunks.length} 個片段，約 ${(turnChunks.length * 0.128).toFixed(1)} 秒）...`);
            lastReplayTime = Date.now();
            webSocket.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
            // 新版 realtimeInput.audio 格式（media_chunks 已被新模型如 Live 3.1 淘汰，一次一塊）
            for (const d of turnChunks) {
                webSocket.send(JSON.stringify({ realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: d } } }));
            }
            if (!isTalking) {
                // 這句話已講完：補上結束訊號，AI 會立即回應
                webSocket.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
                lastUserSpeechTime = performance.now();
                waitingFirstAudio = true;
            }
            // 若 isTalking 仍為 true，代表使用者還在講，後續音訊由 worklet 接力即時上傳
            needsReplay = false;
        }
        // 導演指令送出後、AI 還沒回應就斷線 → 指令已遺失，重連後重送（否則新階段永遠沒有開場）
        if (pendingDirectorNote) {
            logSystem("🎬 重連後重送導演指令（上一階段轉場在斷線中遺失）。");
            webSocket.send(JSON.stringify({
                clientContent: { turns: [{ role: "user", parts: [{ text: pendingDirectorNote }] }], turnComplete: true }
            }));
        }
    }
    if (response.sessionResumptionUpdate) {
        const u = response.sessionResumptionUpdate;
        if (u.resumable && u.newHandle) resumeHandle = u.newHandle;
    }
    if (response.goAway) {
        logSystem(`⚠️ 伺服器預告即將斷線${response.goAway.timeLeft ? '（剩 ' + response.goAway.timeLeft + '）' : ''}，斷線後將自動重連。`);
    }

    // 1) 工具呼叫（生圖）
    if (response.toolCall && response.toolCall.functionCalls) {
        const functionResponses = [];
        for (const fc of response.toolCall.functionCalls) {
            if (fc.name === "show_image") {
                const keyword = (fc.args && fc.args.keyword) ? fc.args.keyword : "picture";
                showImage(keyword);
                functionResponses.push({
                    id: fc.id,
                    name: fc.name,
                    response: { result: { status: "image displayed to student" } }
                });
            } else if (fc.name === "log_vocabulary") {
                const a = fc.args || {};
                studentShowWord(a.word || "", a.meaning || "", a.example || ""); // 學生畫面同步顯示
                logVocabToSheet(a.word || "", a.meaning || "", a.example || "");
                functionResponses.push({
                    id: fc.id,
                    name: fc.name,
                    response: { result: { status: "vocabulary saved" } }
                });
            }
        }
        if (functionResponses.length > 0) {
            webSocket.send(JSON.stringify({ toolResponse: { functionResponses } }));
        }
    }

    const sc = response.serverContent;
    if (!sc) return;

    // 2) 使用者插話：立即停止 AI 音訊播放
    if (sc.interrupted) {
        stopAllPlayback();
        logSystem("🔇 偵測到插話，已中斷 AI 播放。");
    }

    // 3) 使用者語音逐字稿（伺服器端 STT，取代 webkitSpeechRecognition）
    if (sc.inputTranscription && sc.inputTranscription.text) {
        if (isNewUserTurn) {
            userSpeechBox.innerHTML += `<br><b style="color:#4daafc;">[You]</b><br>`;
            isNewUserTurn = false;
        }
        userSpeechBox.innerHTML += sc.inputTranscription.text;
        userSpeechBox.scrollTop = userSpeechBox.scrollHeight;
    }

    // 4) AI 實際說出的逐字稿（除錯面板累積全程；學生畫面字幕只顯示當前這一輪）
    if (sc.outputTranscription && sc.outputTranscription.text) {
        const svT = document.getElementById('svTranscript');
        if (isNewAiTurn) {
            const voiceName = voiceSelect.options[voiceSelect.selectedIndex].text;
            aiSpeechBox.innerHTML += `<br><b style="color:#f39c12;">[${voiceName}]</b><br>`;
            isNewAiTurn = false;
            if (svT) svT.textContent = ""; // 新的一輪：字幕清空重來
        }
        aiSpeechBox.innerHTML += sc.outputTranscription.text;
        aiSpeechBox.scrollTop = aiSpeechBox.scrollHeight;
        if (svT) {
            svT.textContent += sc.outputTranscription.text;
            svT.style.display = 'block';
            svT.scrollTop = svT.scrollHeight;
        }
    }

    // 5) 音訊播放
    if (sc.modelTurn && sc.modelTurn.parts) {
        pendingDirectorNote = null; // AI 已開始回應，導演指令確定送達
        for (const part of sc.modelTurn.parts) {
            if (part.inlineData && part.inlineData.mimeType.includes('audio/pcm')) {
                if (waitingFirstAudio && lastUserSpeechTime) {
                    logSystem(`⏱️ 回應延遲約 ${((performance.now() - lastUserSpeechTime) / 1000).toFixed(1)} 秒`);
                    waitingFirstAudio = false;
                    turnChunks = [];    // AI 已開始回應，這句話確定送達，釋放暫存
                    needsReplay = false;
                }
                playPcmChunk(base64ToArrayBuffer(part.inlineData.data), 24000);
            }
        }
    }

    if (sc.turnComplete) {
        isNewAiTurn = true;
        isNewUserTurn = true;
    }
}

// ---------------- 生圖顯示 ----------------

function showImage(keyword) {
    logSystem(`<span style="color:#f39c12;">🎨 [toolCall] show_image: ${keyword}</span>`);
    generatedImage.style.display = 'block';
    generatedImage.src = "";
    delete generatedImage.dataset.retried;
    imageCaption.textContent = "🎨 正在繪製：" + keyword + " ...";
    const prompt = "A simple, educational illustration of " + keyword + ", white background";
    const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=400&height=400&nologo=true`;
    studentShowWord(keyword, "", null);   // 學生畫面先換上單字（log_vocabulary 稍後會補中文與例句）
    studentShowImage(imageUrl);           // 學生畫面同步顯示圖片
    generatedImage.onload = () => { imageCaption.textContent = "AI 呼叫 show_image：" + keyword; };
    generatedImage.onerror = () => {
        if (!generatedImage.dataset.retried) {
            generatedImage.dataset.retried = "1";
            imageCaption.textContent = "🔁 重試繪製：" + keyword + " ...";
            generatedImage.src = imageUrl + "&seed=" + Date.now(); // 換 seed 重試一次
        } else {
            imageCaption.textContent = "⚠️ 圖片載入失敗：" + keyword;
        }
    };
    generatedImage.src = imageUrl;
}

// ---------------- 隱藏導演（教學流程狀態機） ----------------

function startLessonTimer() {
    if (lessonTimer) clearInterval(lessonTimer);
    lessonTimer = setInterval(() => {
        if (!webSocket || webSocket.readyState !== WebSocket.OPEN) { clearInterval(lessonTimer); return; }
        if (currentStageIndex < teachingFlow.length) {
            const stage = teachingFlow[currentStageIndex];
            // 時間到：先「掛起」，不打斷當下對話
            if (stagePendingSince === null && elapsedTime >= stage.time) {
                stagePendingSince = elapsedTime;
                if (currentStageIndex === 0) {
                    sendStageTransition('opening'); // 開場沒有前文，直接開始
                } else {
                    logSystem(`⌛ ${stage.name} 時間已到，等待自然切換點...`);
                }
            }
            // 逾時保險：掛起超過 90 秒都沒有對話輪替，強制切換
            if (stagePendingSince !== null && elapsedTime - stagePendingSince >= 90 && !isTalking) {
                sendStageTransition('timeout');
            }
        }
        elapsedTime++;
    }, 1000);
}

// 發送階段轉場指令。trigger:
//   opening  = 課程開場（無前文）
//   graceful = 學生剛說完話，AI 回應時順勢收尾並轉場（最自然）
//   timeout  = 掛起逾時，強制轉場
//   manual   = 測試用 Next 按鈕
function sendStageTransition(trigger) {
    if (!webSocket || webSocket.readyState !== WebSocket.OPEN) return;
    if (currentStageIndex >= teachingFlow.length) { logSystem("已是最後一個階段。"); return; }
    const stage = teachingFlow[currentStageIndex];
    stageIndicator.textContent = `⏳ 目前：${stage.name}`;

    let instruction;
    if (trigger === 'opening') {
        instruction = stage.prompt;
    } else if (trigger === 'graceful') {
        instruction = "Time to move to the next stage. First reply briefly to what the student just said, wrap up the current topic in ONE sentence, then CLEARLY announce the shift to the student in simple Traditional Chinese (e.g. 「好～接下來我們要來複習囉！」) so they know a new part of the lesson is starting. Then begin the next stage: " + stage.prompt;
    } else {
        instruction = "Time to move to the next stage. Wrap up the current topic in ONE natural sentence, then CLEARLY announce the shift to the student in simple Traditional Chinese (e.g. 「好～接下來我們要來複習囉！」) so they know a new part of the lesson is starting. Then begin the next stage: " + stage.prompt;
    }

    const label = { opening: '開場', graceful: '自然切換', timeout: '逾時強制', manual: '手動 Next' }[trigger] || trigger;
    logSystem(`🎬 導演指令（${label}）→ ${stage.name}`);
    const noteText = DIRECTOR_PREFIX + instruction + "]";
    webSocket.send(JSON.stringify({
        clientContent: { turns: [{ role: "user", parts: [{ text: noteText }] }], turnComplete: true }
    }));
    pendingDirectorNote = noteText; // AI 開始回應時清除；若回應前斷線，重連後重送
    currentStageIndex++;
    stagePendingSince = null;
}

// ---------------- 麥克風取得（Android 喇叭關鍵） ----------------

// Chrome for Android 無法選擇「輸出」裝置（earpiece / speaker 只會看到 DEFAULT），
// 但輸出路由會跟著「輸入」裝置走：選用標籤含 speakerphone 的麥克風，
// 系統就會把整個音訊 session 切到擴音路徑，聲音改從喇叭出來。
async function acquireMicStream(mode) {
    const baseConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    // 先取得一次權限，否則 enumerateDevices 拿不到裝置標籤
    let stream = await navigator.mediaDevices.getUserMedia({ audio: baseConstraints });

    if (mode === 'speaker') {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const mics = devices.filter(d => d.kind === 'audioinput');
        mics.forEach(d => logSystem(`🎤 偵測到輸入裝置: ${d.label || '(無標籤)'}`));
        const speakerMic = mics.find(d => /speakerphone|speaker|擴音|喇叭/i.test(d.label));

        if (speakerMic) {
            stream.getTracks().forEach(t => t.stop());
            stream = await navigator.mediaDevices.getUserMedia({
                audio: { ...baseConstraints, deviceId: { exact: speakerMic.deviceId } }
            });
            logSystem(`🔊 已切換至擴音麥克風: ${speakerMic.label}`);
        } else {
            // 備援：關閉 AEC，讓系統離開通話模式（聲音會走喇叭）。
            // PTT 模式下沒按按鈕就不上傳麥克風，回音不會被送到伺服器，因此不需額外防護
            stream.getTracks().forEach(t => t.stop());
            stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true }
            });
            logSystem("⚠️ 找不到 speakerphone 麥克風，備援：關閉 AEC 以走喇叭路徑。");
        }
    }
    logSystem("麥克風已啟動。");
    return stream;
}

// ---------------- 麥克風擷取（AudioWorklet） ----------------

async function setupAudioWorklet() {
    if (!audioContext || !micStream) return;
    const source = audioContext.createMediaStreamSource(micStream);
    const workletCode = `
        class AudioProcessor extends AudioWorkletProcessor {
            constructor() { super(); this.bufferSize = 2048; this.buffer = new Int16Array(this.bufferSize); this.bufferIndex = 0; }
            process(inputs) {
                const input = inputs[0];
                if (input && input[0]) {
                    const data = input[0];
                    for (let i = 0; i < data.length; i++) {
                        let s = Math.max(-1, Math.min(1, data[i]));
                        this.buffer[this.bufferIndex++] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                        if (this.bufferIndex >= this.bufferSize) {
                            const sendBuffer = this.buffer.slice();
                            this.port.postMessage(sendBuffer.buffer, [sendBuffer.buffer]);
                            this.bufferIndex = 0;
                        }
                    }
                }
                return true;
            }
        }
        registerProcessor('audio-processor', AudioProcessor);`;
    const blob = new Blob([workletCode], { type: 'application/javascript' });
    await audioContext.audioWorklet.addModule(URL.createObjectURL(blob));
    audioWorkletNode = new AudioWorkletNode(audioContext, 'audio-processor');

    // Push-to-talk 上行：只有 isTalking 為 true（按下說話按鈕）時才處理麥克風。
    // 每個片段同時寫入 turnChunks 暫存，斷線重連後可整句重送；
    // 斷線期間使用者繼續講，音訊照樣進暫存，不會漏字
    audioWorkletNode.port.onmessage = (event) => {
        if (!isTalking) return;
        const b64 = arrayBufferToBase64(event.data);
        turnChunks.push(b64);
        if (webSocket && webSocket.readyState === WebSocket.OPEN) {
            webSocket.send(JSON.stringify({
                // 新版 realtimeInput.audio 格式（新舊模型皆支援；media_chunks 已被 Live 3.1 淘汰）
                realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: b64 } }
            }));
        }
    };
    source.connect(audioWorkletNode);
    // 注意：worklet 不再接到 destination，避免麥克風訊號被本地播放
}

// ---------------- 音訊播放（含喇叭模式路由） ----------------

// 喇叭模式的關鍵：Android 在「通話模式」下會把 WebAudio 輸出導到聽筒，
// 但透過 <audio> 媒體元素播放的聲音通常走喇叭（媒體音量路徑）。
// 因此喇叭模式時，把所有播放接到 MediaStreamDestination，再交給隱藏的 <audio> 播出。
function getOutputNode() {
    const mode = document.querySelector('input[name="audioMode"]:checked').value;
    if (mode === 'speaker') {
        if (!mediaDest) {
            mediaDest = audioContext.createMediaStreamDestination();
            speakerEl = new Audio();
            speakerEl.srcObject = mediaDest.stream;
            speakerEl.setAttribute('playsinline', '');
            speakerEl.autoplay = true;
            // 必須在使用者手勢後呼叫過 play() 一次，這裡在連線流程內，已符合條件
            speakerEl.play().catch(err => logSystem(`⚠️ 喇叭路徑播放失敗: ${err.message}`));
            logSystem("🔊 已切換至媒體播放路徑（喇叭模式）。");
        }
        return mediaDest;
    }
    return audioContext.destination;
}

function playPcmChunk(arrayBuffer, sampleRate) {
    if (!audioContext) return;
    if (audioContext.state === 'suspended') audioContext.resume();
    const int16Array = new Int16Array(arrayBuffer);
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) float32Array[i] = int16Array[i] / 32768.0;
    const audioBuffer = audioContext.createBuffer(1, float32Array.length, sampleRate);
    audioBuffer.getChannelData(0).set(float32Array);

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(getOutputNode());

    if (nextPlayTime < audioContext.currentTime) nextPlayTime = audioContext.currentTime + 0.05;
    source.start(nextPlayTime);
    nextPlayTime += audioBuffer.duration;

    activeSources.push(source);
    source.onended = () => { activeSources = activeSources.filter(s => s !== source); };
}

function stopAllPlayback() {
    activeSources.forEach(s => { try { s.stop(); } catch (e) {} });
    activeSources = [];
    nextPlayTime = 0;
}

// ---------------- 收尾 ----------------

function stopSession() {
    if (!webSocket && !micStream && !audioContext) return; // 已清理過，避免 onclose 重複觸發
    if (lessonTimer) clearInterval(lessonTimer);
    stopAllPlayback();
    if (webSocket && webSocket.readyState === WebSocket.OPEN) webSocket.close();
    if (micStream) micStream.getTracks().forEach(t => t.stop());
    if (audioWorkletNode) audioWorkletNode.disconnect();
    if (speakerEl) { speakerEl.pause(); speakerEl.srcObject = null; }
    if (audioContext) audioContext.close();
    webSocket = null; micStream = null; audioWorkletNode = null; audioContext = null;
    mediaDest = null; speakerEl = null; nextPlayTime = 0;
    statusBadge.textContent = '未連線'; statusBadge.style.background = '#5c4d0c'; statusBadge.style.color = '#ffcc00';
    actionBtn.textContent = '開始連線'; actionBtn.disabled = false;
    isTalking = false;
    stagePendingSince = null;
    talkBtn.disabled = true;
    nextStageBtn.disabled = true;
    talkBtn.classList.remove('talking');
    talkBtn.textContent = '🎙️ 按一下開始說話';
    stageIndicator.textContent = '⏳ 等待連線';
    logSystem("連線已中斷。");
    userSpeechBox.innerHTML = "等待音訊輸入...";
}

// ---------------- 工具函式 ----------------

function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return window.btoa(binary);
}

function base64ToArrayBuffer(base64) {
    const binaryString = atob(base64.replace(/\s/g, ''));
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
    return bytes.buffer;
}
