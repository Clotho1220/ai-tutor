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
// 版本號的唯一來源。index.html 的 #appVersion 只是部署標記，兩處必須一起更新
// （更新檢查會比對兩者）。
const APP_VERSION = "3.15";

let currentToken = null; // 本場課程的臨時憑證（有效期內斷線重連沿用同一張）

// 手機返回手勢／重新整理保護：上課中先確認，避免整堂課意外消失。
let lessonExitGuardArmed = false;
function armLessonExitGuard() {
    if (lessonExitGuardArmed) return;
    history.pushState({ aiTutorLesson: true }, "", location.href);
    lessonExitGuardArmed = true;
}
function disarmLessonExitGuard() {
    if (!lessonExitGuardArmed) return;
    lessonExitGuardArmed = false;
    history.back();
}
window.addEventListener('popstate', () => {
    if (!lessonExitGuardArmed) return;
    if (confirm("課堂還在進行中，確定要離開網頁嗎？")) {
        lessonExitGuardArmed = false;
        userStopped = true;
        stopSession("browser_back");
        setTimeout(() => history.back(), 0);
    } else {
        history.pushState({ aiTutorLesson: true }, "", location.href);
    }
});
window.addEventListener('beforeunload', event => {
    if (!lessonExitGuardArmed) return;
    event.preventDefault();
    event.returnValue = "";
});

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

if (!window.SafeDOM) throw new Error("dom-utils.js 未載入");
const { clear: clearNode, text: setText, appendText, element: makeElement, legacyMarkupToText } = window.SafeDOM;
if (!window.StudentView) throw new Error("student-view.js 未載入");
const studentView = window.StudentView.create({ timeoutMs: 5000 });
if (!window.LiveSession) throw new Error("live-session.js 未載入");
if (!window.CourseProgression) throw new Error("course-progression.js 未載入");
const liveSession = window.LiveSession.create({ maxReconnects: 3 });
if (!window.StageTransitionGate) throw new Error("stage-transition.js 未載入");
const stageTransitionGate = window.StageTransitionGate.create({ requiredRounds: 2 });
if (!window.PracticeObserver) throw new Error("practice-observer.js 未載入");
if (!window.SessionDiagnostics) throw new Error("session-diagnostics.js 未載入");
if (!window.LessonEndingGuard) throw new Error("lesson-ending.js 未載入");
const sessionDiagnostics = window.SessionDiagnostics.create({
    storage: localStorage,
    maxSessions: 3,
    maxEvents: 600,
    maxTextLength: 2000
});
const lessonEndingGuard = window.LessonEndingGuard.create();
const practiceTurnBoundary = window.PracticeObserver.createTurnBoundary();

// PWA 安裝所需。放在外部腳本中，讓 CSP 可以禁止 inline JavaScript。
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
const appVersionEl = document.getElementById('appVersion');
if (appVersionEl) appVersionEl.textContent = `AI Tutor Studio v${APP_VERSION}`;

// 自動更新檢查。
// 手機（尤其已加到主畫面的 PWA）常把 index.html 留在 HTTP 快取裡，
// 導致推了新版卻仍在跑舊程式——這個專案已為此誤判過很多次。
// 做法：向伺服器要一份不走快取的 index.html，比對其中的版本號；
// 不同就重新載入。上課中一律不動，避免打斷課程。
(function initUpdateChecker() {
    const CHECK_INTERVAL_MS = 10 * 60 * 1000;
    let reloading = false;

    function lessonInProgress() {
        return openaiSessionActive || (webSocket && webSocket.readyState !== WebSocket.CLOSED);
    }

    async function checkForUpdate() {
        if (reloading || lessonInProgress() || document.hidden) return;
        try {
            const html = await fetch('index.html?versioncheck=' + Date.now(), { cache: 'no-store' })
                .then(response => (response.ok ? response.text() : ""));
            const match = html.match(/id="appVersion"[^>]*>\s*AI Tutor Studio v([0-9.]+)/);
            if (!match || match[1] === APP_VERSION) return;
            // 防迴圈：萬一 index.html 與 app.js 的版本標記沒同步更新，
            // 每個版本只重載一次，不會陷入不斷重整。
            if (sessionStorage.getItem('update_reloaded_for') === match[1]) return;
            sessionStorage.setItem('update_reloaded_for', match[1]);
            reloading = true;
            logSystem(`⬆️ 偵測到新版本 v${match[1]}，重新載入中…`);
            // 加上參數，確保連 index.html 本身也重新向伺服器取得
            location.replace(location.pathname + '?v=' + match[1] + location.hash);
        } catch (e) { /* 離線或暫時取不到就下次再說 */ }
    }

    window.addEventListener('load', () => setTimeout(checkForUpdate, 3000));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });
    setInterval(checkForUpdate, CHECK_INTERVAL_MS);
})();

let webSocket = null;
let connectionWatchdog = null;
let audioContext = null;       // 麥克風擷取用：固定 16kHz（Gemini 上行音訊規格）
let playbackContext = null;    // AI 語音播放用：固定 24kHz（Gemini 下行音訊規格）
                               // 兩者分開，避免把 24kHz 語音硬塞進 16kHz 環境逐塊重新取樣（音質失真、音色不穩）
let audioWorkletNode = null;
let micStream = null;

let nextPlayTime = 0;
let activeSources = [];        // 追蹤排程中的音訊來源，供插話中斷時停止
let mediaDest = null;          // 喇叭模式：MediaStreamAudioDestinationNode
let speakerEl = null;          // 喇叭模式：隱藏的 <audio> 元素

let isNewAiTurn = true;
let isNewUserTurn = true;
let directorLeak = false;      // 本輪 AI 是否開始唸出（或自行捏造）導演筆記 → 立即消音並隱藏字幕
let aiTurnActive = false;      // AI 這一輪是否還在說（尚未收到 turnComplete）
let dropStaleAudio = false;    // 學生插話後，丟棄伺服器仍在送的「上一輪」殘留語音
const DIRECTOR_LEAK_RE = /\[?\s*DIRECTOR\s*NOTE/i;

let isTalking = false;         // Push-to-talk：目前是否正在說話（上傳麥克風）
let stagePendingSince = null;  // 階段時間已到、正在等待自然切換點的時間戳（elapsedTime）
let lastUserSpeechTime = 0;    // 延遲量測：按下「說完了」的時間
let waitingFirstAudio = false; // 延遲量測：是否正在等待 AI 本輪第一塊音訊
let studentTurnGeneration = 0; // 每次學生按「說完了」遞增；避免把被插斷的舊 AI turnComplete 算到新回合
let pendingStudentResponseGeneration = null;
let activeAiResponseStudentGeneration = null;
let aiTurnTrackingStarted = false;
let currentUserTurnTranscript = "";
let activeAiTurnUserTranscript = "";
let currentAiTurnTranscript = "";

let lessonTimer = null;
let elapsedTime = 0;
let currentStageIndex = 0;
let pendingDirectorNote = null; // 已送出但 AI 尚未回應的導演指令；若此時斷線，重連後重送（否則新階段開場會消失）
let suppressAudioAfterFarewell = false; // 結語已出現後，丟棄模型仍生成的問題或多餘內容
let suppressAudioAfterPractice = false; // 「Try it／試試看」後必須交棒給學生，後續內容一律不播
let lessonFinishTimer = null;   // 等最後一句已排程音訊播完再真正結束連線
let sessionReady = false;       // 模型已接受完整設定；初次 ready 後才進學生畫面
let closingStageActive = false; // 最後結語階段已送出；此後的道別一律視為正式下課
let lessonCompletionPending = false; // 已排程下課；忽略任何遲到的模型事件

let userStopped = false;       // 使用者主動按「結束連線」（區別於意外斷線）
let resumeHandle = null;       // Live API session resumption 握把，重連時恢復對話記憶
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
const providerSelect = document.getElementById('providerSelect');
const engineSelect = document.getElementById('engineSelect');
const openaiVoiceSelect = document.getElementById('openaiVoiceSelect');
const openaiSpeedSelect = document.getElementById('openaiSpeedSelect');
const openaiModelSelect = document.getElementById('openaiModelSelect');
const talkBtn = document.getElementById('talkBtn');
const nextStageBtn = document.getElementById('nextStageBtn');
const resumeStudentBtn = document.getElementById('resumeStudentBtn');
const openaiRealtime = window.OpenAIRealtime ? window.OpenAIRealtime.create() : null;
let openaiSessionActive = false;
let openaiAiTranscriptStarted = false;

function refreshStudentReturnButton() {
    if (!resumeStudentBtn) return;
    const shouldShow = sessionReady && !document.body.classList.contains('student-mode');
    resumeStudentBtn.classList.toggle('visible', shouldShow);
}

function markSessionReady(provider, options) {
    const wasReady = sessionReady;
    sessionReady = true;
    if (provider === 'openai') openaiSessionActive = true;
    statusBadge.textContent = provider === 'openai' ? '🟢 GPT 已連線' : '🟢 已連線';
    statusBadge.style.background = '#28a745';
    statusBadge.style.color = '#fff';
    actionBtn.textContent = '結束連線';
    actionBtn.disabled = false;
    talkBtn.disabled = false;
    if (!isTalking) talkBtn.textContent = '🎙️ 按一下開始說話';
    nextStageBtn.disabled = false;
    if (!wasReady && !(options && options.reconnect)) {
        document.body.classList.remove('settings-mode');
        document.body.classList.add('student-mode');
        armLessonExitGuard();
        startLessonTimer();
    }
    refreshStudentReturnButton();
}

function selectedProvider() {
    return providerSelect && providerSelect.value === 'openai' ? 'openai' : 'gemini';
}

function selectedOpenAIModel() {
    return openaiModelSelect && openaiModelSelect.value === 'gpt-realtime'
        ? 'gpt-realtime'
        : 'gpt-realtime-2.1-mini';
}

(function initProviderPicker() {
    if (!providerSelect || !engineSelect) return;
    providerSelect.value = localStorage.getItem('ai_provider') === 'openai' ? 'openai' : 'gemini';
    if (openaiVoiceSelect) openaiVoiceSelect.value = localStorage.getItem('openai_voice') || 'marin';
    if (openaiModelSelect) {
        openaiModelSelect.value = localStorage.getItem('openai_model') === 'gpt-realtime'
            ? 'gpt-realtime'
            : 'gpt-realtime-2.1-mini';
    }
    engineSelect.value = providerSelect.value === 'gemini'
        ? 'gemini'
        : (openaiModelSelect.value === 'gpt-realtime' ? 'gpt-quality' : 'gpt-mini');
    engineSelect.addEventListener('change', () => {
        const useGemini = engineSelect.value === 'gemini';
        providerSelect.value = useGemini ? 'gemini' : 'openai';
        if (!useGemini) {
            openaiModelSelect.value = engineSelect.value === 'gpt-quality'
                ? 'gpt-realtime'
                : 'gpt-realtime-2.1-mini';
        }
        localStorage.setItem('ai_provider', providerSelect.value);
        localStorage.setItem('openai_model', selectedOpenAIModel());
    });
    if (openaiVoiceSelect) openaiVoiceSelect.addEventListener('change', () => localStorage.setItem('openai_voice', openaiVoiceSelect.value));
})();

// 測試用：手動跳到下一階段
nextStageBtn.addEventListener('click', () => sendStageTransition('manual'));

// ---------------- Push-to-talk 按鈕 ----------------
// 按一下開始說話（開始上傳麥克風 + 通知伺服器 activityStart），
// 再按一下結束（通知 activityEnd，AI 隨即回應）。
talkBtn.addEventListener('click', () => {
    if (openaiSessionActive) {
        if (!isTalking) {
            const responseWasActive = !!(openaiRealtime && openaiRealtime.inspect().responseInProgress);
            if (!openaiRealtime || !openaiRealtime.startTalking()) return;
            stopAllPlayback();
            sessionDiagnostics.record("openai_student_interrupt", {
                responseWasActive
            });
            currentUserTurnTranscript = "";
            isTalking = true;
            talkBtn.classList.add('talking');
            talkBtn.textContent = '🔴 說完了，按一下送出';
        } else {
            openaiRealtime.stopTalking();
            isTalking = false;
            studentTurnGeneration += 1;
            pendingStudentResponseGeneration = studentTurnGeneration;
            activeAiResponseStudentGeneration = null;
            stageTransitionGate.noteStudentTurn();
            sessionDiagnostics.record("student_talk_ended", {
                provider: "openai",
                turn: studentTurnGeneration
            });
            talkBtn.classList.remove('talking');
            talkBtn.textContent = '🎙️ 按一下開始說話';
        }
        return;
    }
    if (!isTalking) {
        // 開始說話需要活著的連線（重連中請稍等 1-2 秒）
        if (!webSocket || webSocket.readyState !== WebSocket.OPEN) return;
        sessionDiagnostics.record("student_talk_started", {
            turn: studentTurnGeneration + 1,
            interruptedAi: aiTurnActive
        });
        stopAllPlayback(); // 使用者要說話了，立刻讓 AI 安靜
        // 伺服器不知道我們讓它閉嘴了，仍會把這一輪剩下的語音送完。
        // 那些殘留音訊若照播，聽起來就像 AI 還停在上一個單字 → 一律丟棄，直到本輪結束。
        if (aiTurnActive) dropStaleAudio = true;
        turnChunks = [];   // 開始新的一句，清空暫存
        needsReplay = false;
        currentUserTurnTranscript = "";
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
        studentTurnGeneration += 1;
        pendingStudentResponseGeneration = studentTurnGeneration;
        activeAiResponseStudentGeneration = null;
        sessionDiagnostics.record("student_talk_ended", {
            turn: studentTurnGeneration,
            bufferedAudioChunks: turnChunks.length
        });
        stageTransitionGate.noteStudentTurn();
        if (webSocket && webSocket.readyState === WebSocket.OPEN) {
            webSocket.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
        } else {
            // 說到一半斷線了：這句話已完整暫存，重連後自動重送
            needsReplay = true;
            logSystem("📦 連線中斷，這句話已暫存，重連後會自動重送。");
        }
    }
});

// ---------------- 人員（每位學生各自記住設定與學習歷程） ----------------
// 記住的東西：中英文比例程度、AI 聲音、正在上的單元、興趣、學過的單字、上到第幾天。
const PROFILES_KEY = "profiles_v1";
const PERSON_DEFAULTS = {
    Rex:    { level: 3, voice: "Aoede", gptSpeed: 0.9, unit: null, interests: [] },              // 70% 英文
    Jessie: { level: 2, voice: "Aoede", gptSpeed: 0.9, unit: null, interests: [] },              // 中英各半
    Sandy:  { level: 2, voice: "Aoede", gptSpeed: 0.9, unit: null, interests: [] },              // 中英各半
    Clotho: { level: 5, voice: "Aoede", gptSpeed: 1.0, unit: null, interests: [], adult: true }  // 成人模式：全英文
};

function loadProfiles() {
    let p = null;
    try { p = JSON.parse(localStorage.getItem(PROFILES_KEY)); } catch (e) {}
    if (!p || !p.people) p = { current: "Rex", people: {} };
    // 補上缺少的人員與欄位（日後新增人員或欄位也能自動相容）
    Object.keys(PERSON_DEFAULTS).forEach(name => {
        p.people[name] = Object.assign({}, PERSON_DEFAULTS[name], p.people[name] || {});
    });
    if (!p.people[p.current]) p.current = "Rex";
    return p;
}

function saveProfiles(p) {
    try { localStorage.setItem(PROFILES_KEY, JSON.stringify(p)); } catch (e) {}
}

function currentPersonName() { return loadProfiles().current; }
function currentPerson() { const p = loadProfiles(); return p.people[p.current]; }
const learningRecords = window.LearningRecords.create({ storage: localStorage, maxPerPerson: 200 });

function updateCurrentPerson(patch) {
    const p = loadProfiles();
    Object.assign(p.people[p.current], patch, { updatedAt: Date.now() });
    saveProfiles(p);
    if (typeof scheduleSync === 'function') scheduleSync();
}

// 每位人員各自的儲存空間（學習紀錄、週進度）
function vocabKey() { return "vocab_log_v1::" + currentPersonName(); }
function weekProgressKey(unitName) { return "week_progress::" + currentPersonName() + "::" + (unitName || "default"); }

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
    // 0) 時事討論模式：跳過課本、教材與學習進度
    if (currentMode() === 'news') {
        const p = currentPerson();
        logSystem(selectedProvider() === 'openai'
            ? "📰 時事討論模式：後端會取得近期新聞標題交給 GPT。"
            : "📰 時事討論模式：AI 會用 Google 搜尋找近一週的新聞。");
        return buildNewsLesson({ name: currentPersonName(), level: p.level, interests: p.interests || [], adult: !!p.adult });
    }
    // 0) 老師在畫面上貼的自訂教材，優先於一切
    const custom = readCustomMaterial();
    if (custom) {
        logSystem(`📋 使用自訂教材（單元：${custom.unit}）。`);
        return custom;
    }
    // 0.5) 從課本單元庫挑的單元（自動展開成 5 天）
    const picked = await readSelectedUnit();
    if (picked) {
        logSystem(`📖 使用課本單元：${picked.unit}（自動展開 5 天）。`);
        return picked;
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
    const today = learningRecords.today(); // 台灣日期 YYYY-MM-DD
    const progressKey = weekProgressKey(json.unit);   // 每位人員的進度各自獨立
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
    if (typeof scheduleSync === 'function') scheduleSync();   // 上課進度也要跨手機接得上
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
        // 同時認得英文標籤（Theme / Sentence Pattern / Word）與中文標籤（主題情境 / 目標句型 / 目標單字）
        if (type.includes("theme") || type.includes("主題")) {
            theme = english + (chinese ? "（" + chinese + "）" : "");
        } else if (type.includes("sentence") || type.includes("pattern") || type.includes("句型")) {
            patterns.push({ english, chinese, example });
        } else if (type.includes("word") || type.includes("單字")) {
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
              goal: "Teach today's words ONE at a time: say it, call show_image for concrete nouns, give the Traditional Chinese meaning, have the student repeat, then call log_vocabulary. After a few words, drill the patterns by swapping these words in. " +
                    "Before the stage ends, get the student to say something of their OWN with today's pattern — their real answer or opinion, not a repeat. Then judge it and let them hear the correct full sentence: " +
                    "Chinese answer → give them the English and have them say it; mistakes → restate correctly and have them try again; correct → say so and why, then ask for one more.",
              items: m.words,
              activity: "Role-play a natural everyday scene that fits today's theme, using the patterns and words. The student speaks the target lines; if they freeze, feed the line in Chinese first, then let them say it in English. Swap roles once so the student also answers." },
            { label: "總結", minutes: 2,
              goal: "Wrap up in simple terms (Traditional Chinese is fine): remind them of today's main pattern, praise ONE specific thing they did well, and say goodbye warmly." }
        ]
    };
}

// ---------------- 課本單元庫（units.json → 自動展開成 5 天課表） ----------------
// units.json 由 build-units.py 從 Lesson data.xlsx 產生（Gogo English 各冊）。
// 老師只要在畫面上挑「哪一冊、哪一單元」，程式就把句型與單字分散到 5 天，
// 並自動安排間隔重複的複習（第 N 天回收第 1~N-1 天教過的內容）。
const UNIT_KEY = "selected_unit_v1";
let UNITS_DATA = null;

async function loadUnitsData() {
    if (UNITS_DATA) return UNITS_DATA;
    try {
        const res = await fetch("units.json?t=" + Date.now());
        if (res.ok) UNITS_DATA = await res.json();
    } catch (e) {}
    return UNITS_DATA;
}

function findUnit(bookName, num) {
    if (!UNITS_DATA || !UNITS_DATA.books) return null;
    const b = UNITS_DATA.books.find(x => x.name === bookName);
    return b ? b.units.find(u => u.num === num) : null;
}

// 第 N 天的複習內容：昨天教的全收，更早的每天各挑一個（手動版間隔重複）
function reviewItemsFor(dayIdx, dayItems) {
    if (dayIdx < 1) return [];
    const items = [...dayItems[dayIdx - 1]];
    for (let k = 0; k < dayIdx - 1; k++) {
        if (dayItems[k].length) items.push(dayItems[k][0]);
    }
    return items.slice(0, 5);
}

// 單元 → 5 天週教案（沿用 lesson.json 的 week 格式，交給既有的排課機制處理）
// 課程長度依「當天實際教多少項目」決定，而不是固定 15 分鐘。
// 起因：Book 1 每個單元只有 1 句型 + 4 單字，第 1 天僅 2 個項目卻排 11 分鐘主課，
// 模型沒有素材可教，只能把同一句反覆操練（診斷檔中同一句出現 4 次）。
// 一個項目（單字或句型）對 6-8 歲大約是「示範→跟讀→自己造句→回饋」2.5 分鐘。
const MINUTES_PER_ITEM = 2.5;
const REVIEW_MINUTES_PER_ITEM = 1.5;   // 複習比新教學快，項目已經見過
const MAIN_STAGE_MIN = 4;      // 再少也要夠鋪陳與收尾
const MAIN_STAGE_MAX = 9;      // 專注力上限
const REVIEW_MIN = 2;
const REVIEW_MAX = 4;
const MAX_LESSON_MINUTES = 15; // 一堂課的總長上限（6-8 歲的專注力）

function minutesForItems(count, floor, ceiling, perItem) {
    if (!count) return floor;
    return Math.max(floor, Math.min(ceiling, Math.round(count * (perItem || MINUTES_PER_ITEM))));
}

// 依內容算出來的時間可能超過孩子的專注力上限，
// 從最長的階段開始逐分鐘收斂，直到總長符合上限。
function capLessonMinutes(stages, limit) {
    const total = () => stages.reduce((sum, s) => sum + s.minutes, 0);
    let guard = 60;
    while (total() > (limit || MAX_LESSON_MINUTES) && guard-- > 0) {
        const longest = stages.reduce((a, b) => (b.minutes > a.minutes ? b : a));
        if (longest.minutes <= 2) break;      // 每個階段至少留 2 分鐘
        longest.minutes -= 1;
    }
    return stages;
}

function buildWeeklyLessonFromUnit(unit, student) {
    const TEACH_DAYS = 4;                       // 前 4 天教新東西，第 5 天總複習
    const P = unit.patterns || [], W = unit.words || [];
    const chunk = (arr, n) => {
        const per = Math.ceil(arr.length / n) || 1;
        return Array.from({ length: n }, (_, i) => arr.slice(i * per, (i + 1) * per));
    };
    const dayPatterns = chunk(P, TEACH_DAYS);
    const dayWords = chunk(W, TEACH_DAYS);
    const dayItems = Array.from({ length: TEACH_DAYS }, (_, i) => [...dayPatterns[i], ...dayWords[i]]);
    const themeLine = unit.theme || unit.title;
    const week = [];

    for (let i = 0; i < TEACH_DAYS; i++) {
        const items = dayItems[i];
        const hasNew = items.length > 0;
        const focus = hasNew
            ? items.map(it => it.english).join("、").slice(0, 60)
            : "延伸練習本單元句型";
        const stages = [];

        stages.push({
            label: "開場暖身", minutes: 2,
            goal: (i === 0
                ? `Greet the student warmly BY NAME, make light small talk with ONE simple question (use their interests), then tell them what this week is about: ${themeLine}. `
                : `Greet the student BY NAME, ONE short small-talk question, then remind them briefly what we learned last time and introduce today's focus. `) +
                `Today's focus: ${focus}.`
        });

        let reviewItems = [];
        if (i > 0) {
            reviewItems = reviewItemsFor(i, dayItems);
            stages.push({
                label: "複習", minutes: minutesForItems(reviewItems.length, REVIEW_MIN, REVIEW_MAX, REVIEW_MINUTES_PER_ITEM),
                goal: "Review these items from previous days ONE at a time: prompt the student to use each one in a sentence, wait for their answer, gently fix mistakes by restating.",
                items: reviewItems
            });
        }

        stages.push({
            label: "主題課程",
            // 沒有新項目的日子改成延伸練習本單元句型，時間依句型數量估算
            minutes: minutesForItems(hasNew ? items.length : P.length, MAIN_STAGE_MIN, MAIN_STAGE_MAX),
            goal: (hasNew
                ? "Teach today's items ONE at a time: say it, call show_image for concrete nouns, give the Traditional Chinese meaning, have the student repeat, then call log_vocabulary. Then drill the pattern by swapping in different words. Then run the activity."
                : "No new items today. Deepen what the student already learned this week: drill the unit's patterns in fresh, playful situations, and push for slightly longer answers. Then run the activity.") +
                " Before this stage ends, leave time for the student to say something of their OWN using today's pattern — their real answer, choice or opinion, not a repeat after you. " +
                "Judge what they produce and make sure they hear the correct full sentence: answered in Chinese → give them the English and have them say it; mistakes → restate it correctly and have them try again; correct → tell them it was right and why, then ask for one more.",
            items: hasNew ? items : P,
            activity: `Role-play a natural everyday scene that fits this unit's topic (${themeLine}), using today's patterns and words. The student speaks the target lines; if they freeze, feed the line in Chinese first, then let them say it in English. Swap roles once so the student also has to answer.`
        });

        stages.push({
            label: "總結", minutes: 2,
            goal: "Wrap up in simple terms (Traditional Chinese is fine): remind them of today's main pattern, praise ONE specific thing they did well, and say goodbye warmly."
        });

        week.push({ day: i + 1, focus, stages: capLessonMinutes(stages) });
    }

    // 第 5 天：總複習 + 綜合角色扮演
    const allWordsSample = W.slice(0, 6);
    week.push({
        day: 5, focus: "總複習：本單元所有句型與單字",
        stages: capLessonMinutes([
            { label: "開場暖身", minutes: 2,
              goal: `Greet the student BY NAME warmly, and tell them today is the FINAL DAY of this unit: a big game using everything we learned this week about ${themeLine}.` },
            { label: "快問快答複習", minutes: minutesForItems([...P, ...allWordsSample].length, 3, 6),
              goal: "Rapid review quiz, ONE at a time, keep the pace light and fun: prompt the student to produce each pattern or word, wait, gently fix by restating.",
              items: [...P, ...allWordsSample] },
            { label: "綜合角色扮演", minutes: minutesForItems(P.length, 4, 6),
              goal: "Run one big final activity that uses EVERYTHING from this week. Keep it playful and let the student do most of the talking.",
              items: P,
              activity: `A big role-play built on this unit's topic (${themeLine}). The student must naturally use ALL the patterns learned this week. Then SWAP ROLES for one short round so the student asks the questions. Make it fun.` },
            { label: "本週總結", minutes: 2,
              goal: "Celebrate finishing the whole unit! In Traditional Chinese, remind them of the patterns learned this week, praise TWO specific improvements you noticed, and say a warm goodbye." }
        ])
    });

    return { student, unit: `${unit.book} Unit ${unit.num}: ${unit.title}`, week };
}

// ---------------- 時事討論模式 ----------------
// 與課本完全脫鉤：不看單元、不看學過的字、不接續進度，
// 由 AI 用 Google 搜尋找出近一週的新聞，挑適合孩子的來聊。
const MODE_KEY = "lesson_mode";               // 'lesson'（課程）或 'news'（時事）
function currentMode() { return localStorage.getItem(MODE_KEY) === 'news' ? 'news' : 'lesson'; }

function buildNewsLesson(student) {
    const adult = !!student.adult;
    return {
        student,
        mode: "news",
        unit: "📰 時事討論（近一週新聞）",
        stages: adult ? [
            { label: "開場", minutes: 2,
              goal: "Greet them by name and open with ONE natural question about how their day or week has been. Then say you'll pick out some of this week's news to talk through together." },
            { label: "挑選議題", minutes: 3,
              goal: "Use the google_search tool to find real news published in the LAST 7 DAYS, searching both Taiwanese and international sources. Choose FIVE substantive stories worth an adult's attention, mixing domestic and international, and varying the fields (current affairs, business, technology, science, culture, sport). " +
                    "Call show_topics with five short headlines, read them out numbered, and ask which one they want to get into. WAIT for their choice. Then summarise that story accurately in at most FOUR sentences, call show_image for its central subject, and immediately ask for their first reaction — do not keep reporting." },
            { label: "單字與句型", minutes: 2,
              goal: "Pull the language out of the story before discussing it: pick exactly TWO high-value words or collocations and ONE sentence pattern useful for expressing a view on this kind of topic (e.g. 'What concerns me about X is...', 'It could go either way, but...'). " +
                    "Give each briefly with a natural example, call log_vocabulary for both words and show_image for any concrete subject. Do not over-explain — a line each is enough." },
            { label: "討論", minutes: 5,
              goal: "Now a real discussion, and they should do most of the talking. Ask for their view on the story, push for reasons, offer a counterpoint to keep it alive, and encourage them to work in today's pattern and words. " +
                    "Keep your own turns SHORT — a reaction, the feedback loop, one question. " +
                    "After each substantial turn, give a short assessment before moving on: what was accurate, the natural phrasing for the one error most worth fixing, and where useful a more idiomatic alternative — then follow up with a question that makes them elaborate." },
            { label: "總結", minutes: 2,
              goal: "Close the session: recap the discussion in a sentence or two, restate the useful expressions that came up, note ONE specific thing about their English that worked well and ONE concrete thing to work on, then say goodbye." }
        ] : [
            { label: "開場暖身", minutes: 2,
              goal: "Greet the student warmly BY NAME and ask ONE light question about their day. Then tell them that today is different: instead of the textbook, you two are going to chat about something that really happened in the world this week." },
            { label: "挑選議題", minutes: 3,
              goal: "Use the google_search tool to find real news published in the LAST 7 DAYS — search both Taiwan (國內) and international sources. Choose FIVE stories that are genuinely fun and safe for a young child, mixing local and international ones. " +
                    "Call show_topics with five very short titles so the child can SEE them, then read them out as '一、二、三...' and ask which one they want to hear about. WAIT for the child to choose — do not pick for them. " +
                    "Once they choose, tell that story in at most FOUR short sentences and call show_image for the main thing in it (the animal, the place, the object). Then immediately ask the child ONE simple question about it — do not keep narrating." },
            { label: "單字與句型", minutes: 3,
              goal: "This is an ENGLISH lesson built on the story, so now pull the language out of it. Choose exactly TWO useful words and ONE simple sentence pattern that come naturally from this story. " +
                    "Teach the two words one at a time (show_image for each concrete noun, log_vocabulary for both), then teach the pattern and have the student say it once with help. Keep the story as the context throughout." },
            { label: "說出你的想法", minutes: 4,
              goal: "Now the most important part: get the student to say their OWN opinion about the story in English — what they think of it, whether they like it, what they would do. Encourage them to use today's pattern and words, but any attempt counts. " +
                    "Wait for a real answer. Then judge what they said and make sure they hear the correct full sentence: if they answered in Chinese, give them the English sentence and have them say it themselves; " +
                    "if their English had mistakes, restate it correctly and have them try again; if it was correct, tell them so and say briefly what was good, then ask for one more sentence. Aim for at least three sentences that they built themselves." },
            { label: "總結", minutes: 2,
              goal: "Wrap up in simple terms (Traditional Chinese is fine): retell today's story in one sentence, remind them of the new words, praise ONE specific thing they did well, and say goodbye warmly." }
        ]
    };
}

// 讀取目前人員選定的課本單元（沒選就回 null）
async function readSelectedUnit() {
    const p = currentPerson();
    const sel = p.unit;
    if (!sel || !sel.book || !sel.num) return null;
    await loadUnitsData();
    const unit = findUnit(sel.book, sel.num);
    if (!unit) return null;
    const student = { name: currentPersonName(), level: p.level, interests: p.interests || [] };
    let weeklyLesson = buildWeeklyLessonFromUnit(unit, student);
    const daySelect = document.getElementById('daySelect');
    const manual = daySelect ? daySelect.value : "auto";
    let progress = null;
    try { progress = JSON.parse(localStorage.getItem(weekProgressKey(weeklyLesson.unit))); } catch (e) {}

    if (window.CourseProgression.shouldAdvance({
        progress,
        today: learningRecords.today(),
        manual,
        dayCount: weeklyLesson.week.length
    })) {
        const next = window.CourseProgression.nextUnit(UNITS_DATA.books, sel);
        if (next) {
            updateCurrentPerson({ unit: { book: next.book, num: next.num } });
            weeklyLesson = buildWeeklyLessonFromUnit(next, student);
            logSystem(`🎓 ${sel.book} Unit ${sel.num} 已完成，自動進入 ${next.book} Unit ${next.num} 的第 1 天。`);
            if (window.refreshUnitPickerForPerson) window.refreshUnitPickerForPerson();
        } else {
            logSystem(`🏆 ${sel.book} Unit ${sel.num} 已是目前教材的最後一個單元。`);
        }
    }
    return weeklyLesson;
}

// 課本單元選單：冊別 → 單元 → 套用
(function initUnitPicker() {
    const bookSel = document.getElementById('bookSelect');
    const unitSel = document.getElementById('unitSelect');
    const applyBtn = document.getElementById('applyUnitBtn');
    const clearBtn = document.getElementById('clearUnitBtn');
    const preview = document.getElementById('unitPreview');
    const status = document.getElementById('unitStatus');
    if (!bookSel || !unitSel) return;

    function fillUnits() {
        const b = UNITS_DATA.books.find(x => x.name === bookSel.value);
        clearNode(unitSel);
        (b ? b.units : []).forEach(u => {
            unitSel.appendChild(makeElement('option', { value: u.num, text: `Unit ${u.num}: ${u.title}` }));
        });
        showPreview();
    }

    function showPreview() {
        const u = findUnit(bookSel.value, parseInt(unitSel.value, 10));
        clearNode(preview);
        if (!u) return;
        if (u.desc) {
            preview.appendChild(document.createTextNode(u.desc));
            preview.appendChild(document.createElement('br'));
        }
        preview.appendChild(makeElement('span', {
            text: `${u.patterns.length} 個句型、${u.words.length} 個單字`, color: '#4daafc'
        }));
        appendText(preview, ' → 自動展開成 5 天（第 5 天總複習）');
    }

    // 切換人員時，把單元選單同步成該人員正在上的單元
    window.refreshUnitPickerForPerson = function () {
        if (!UNITS_DATA || !UNITS_DATA.books) return;
        const saved = currentPerson().unit;
        if (saved && saved.book) bookSel.value = saved.book;
        fillUnits();
        if (saved && saved.num) { unitSel.value = saved.num; showPreview(); }
        const u = saved ? findUnit(saved.book, saved.num) : null;
        status.style.color = u ? "#4af626" : "#aaa";
        status.textContent = u
            ? `✅ ${currentPersonName()} 目前使用：${saved.book} Unit ${saved.num} ${u.title}`
            : `${currentPersonName()} 尚未選定單元（將使用內建的 lesson.json）。`;
    };

    loadUnitsData().then(() => {
        if (!UNITS_DATA || !UNITS_DATA.books) { status.textContent = "⚠️ 找不到 units.json"; return; }
        clearNode(bookSel);
        UNITS_DATA.books.forEach(b => bookSel.appendChild(makeElement('option', { value: b.name, text: b.name })));
        window.refreshUnitPickerForPerson();
        if (window.refreshPersonSummary) window.refreshPersonSummary();
    });

    bookSel.addEventListener('change', fillUnits);
    unitSel.addEventListener('change', showPreview);

    applyBtn.addEventListener('click', () => {
        const num = parseInt(unitSel.value, 10);
        const u = findUnit(bookSel.value, num);
        if (!u) return;
        updateCurrentPerson({ unit: { book: bookSel.value, num } });   // 單元記在人員身上
        localStorage.removeItem(MATERIAL_KEY);   // 與「貼上教材」互斥，避免兩個來源打架
        const mStatus = document.getElementById('materialStatus');
        if (mStatus) mStatus.textContent = "";
        status.style.color = "#4af626";
        status.textContent = `✅ ${currentPersonName()} 已套用：${bookSel.value} Unit ${num} ${u.title}。下次按「開始連線」生效。`;
        if (window.refreshPersonSummary) window.refreshPersonSummary();
    });

    clearBtn.addEventListener('click', () => {
        updateCurrentPerson({ unit: null });
        status.style.color = "#aaa";
        status.textContent = `已清除 ${currentPersonName()} 的單元，將改用內建的 lesson.json。`;
        if (window.refreshPersonSummary) window.refreshPersonSummary();
    });
})();

// 畫面上設定的學生名字／興趣，覆蓋任何教案來源（lesson.json、自訂教材、內建預設）裡的學生設定
function applyStudentOverride(lesson) {
    if (!lesson.student) lesson.student = {};
    const p = currentPerson();
    lesson.student.name = currentPersonName();          // 學生名字＝目前選定的人員
    lesson.student.interests = p.interests || [];
    lesson.student.adult = !!p.adult;                   // 成人模式：換掉整套教學風格
    return lesson;
}

// 讀取已儲存的自訂教材，組成今日 lesson（沒有就回 null，讓程式退回 lesson.json）
function readCustomMaterial() {
    try {
        const saved = JSON.parse(localStorage.getItem(MATERIAL_KEY));
        if (saved && saved.material && (saved.material.patterns.length || saved.material.words.length)) {
            const p = currentPerson();
            const student = { name: currentPersonName(), level: p.level, interests: p.interests || [] };
            return buildLessonFromMaterial(saved.material, student);
        }
    } catch (e) {}
    return null;
}

// 自訂教材面板：套用 / 清除 / 載入時回填狀態
(function initMaterialPanel() {
    const input = document.getElementById('materialInput');
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

    // 興趣：記在目前人員身上，打字即存
    if (interestsEl) {
        window.refreshInterestsForPerson = () => {
            interestsEl.value = (currentPerson().interests || []).join(", ");
        };
        window.refreshInterestsForPerson();
        interestsEl.addEventListener('input', () => {
            updateCurrentPerson({
                interests: interestsEl.value.split(/[,，]/).map(s => s.trim()).filter(Boolean)
            });
        });
    }

    applyBtn.addEventListener('click', () => {
        const m = parseMaterial(input.value);
        if (!m) {
            status.style.color = "#ff6b6b";
            status.textContent = "⚠️ 沒讀到句型或單字。請確認是從 Excel 複製的四欄表格（type/english/chinese/example）。";
            return;
        }
        localStorage.setItem(MATERIAL_KEY, JSON.stringify({ material: m }));
        updateCurrentPerson({ unit: null });   // 與「課本單元」互斥
        if (window.refreshUnitPickerForPerson) window.refreshUnitPickerForPerson();
        status.style.color = "#4af626";
        status.textContent = "✅ 已套用！" + describeMaterial(m) + "。下次按「開始連線」生效。";
        if (window.refreshPersonSummary) window.refreshPersonSummary();
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

// 程度改為記在「人員」身上（設定畫面的選單即時寫回該人員）
function readLevelOverride(lessonLevel) {
    const lv = currentPerson().level;
    return (lv >= 1 && lv <= 5) ? lv : lessonLevel;
}

// 回合契約：兩個模型共用的最高優先規則。
// 過去只掛在 GPT 前面，Gemini 拿不到「示範後立刻停」「同一句型不得連續操練」這些硬規則，
// 兩邊行為因此對不齊。放進 buildSystemInstruction 之後，任何模型都一定拿得到同一份。
const TURN_CONTRACT =
    "TURN CONTRACT (highest priority): Give ONE short teacher turn, ask at most ONE question, then WAIT. " +
    "If you translate, correct, model a sentence, or ask the learner to repeat, STOP immediately after that invitation. " +
    "Never ask the learner to practise one sentence family more than TWICE in a session; changing only the subject or name is still the SAME family. After one successful attempt, choose a different target, situation, or open response. " +
    "Never combine practice instructions with the next lesson topic. Obey DIRECTOR NOTE messages silently; never quote or discuss them. " +
    "Use the available display and vocabulary tools silently when appropriate. ";

// 依教案組裝完整 system prompt
function buildSystemInstruction(lesson) {
    const st = lesson.student || {};
    const interests = (st.interests || []).join(", ");
    const level = readLevelOverride(st.level || 2);
    const adult = !!st.adult;
    const learner = adult ? "adult learner" : "child";
    return TURN_CONTRACT + (adult
            ? "You are a skilled, personable English conversation tutor in a LIVE VOICE session with ONE adult learner. Treat them as an intelligent peer who simply wants to get better at English. "
            : "You are a friendly English tutor in a LIVE VOICE conversation with ONE student. ") +
        (adult
            ? `STUDENT PROFILE: ${st.name || "the learner"}, an adult Mandarin speaker practising conversational English, level ${level} of 5. `
            : `STUDENT PROFILE: ${st.name || "the student"}, a young Mandarin-speaking learner, level ${level} of 5. `) +
        (interests ? `Their interests are: ${interests} — use them in your examples and small talk. ` : "") +
        (lesson.mode === "news"
            ? "TODAY'S LESSON IS A NEWS CHAT, not a textbook unit. Your job is to find something that really happened in the world in the LAST 7 DAYS using the google_search tool, and talk about it together. " +
              "LANGUAGE FIRST — you are an English tutor using news as material, NOT a news anchor: never narrate more than three or four short sentences in a row. After that, STOP and make the " + learner + " talk — ask what they think, then run the feedback loop on whatever they say. The story exists so THEY can practise speaking, not so you can report it. " +
              "Search in both Chinese (台灣新聞) and English (world news) so you can offer local and international stories. Only use stories you actually found in search results — never invent news, and never present something old as if it were new. " +
              (adult
                ? "Pick five genuinely substantive stories an informed adult would find worth discussing — current affairs, business, technology, science, culture, sport. Sensitive subjects are fine; treat them factually and even-handedly, and do not push your own political opinions. "
                : "NEWS SAFETY — non-negotiable: this is a 6-8 year old child. Choose ONLY stories that are safe and delightful for a young child: animals, nature, space, science, inventions, sports, food, festivals, or kids doing something remarkable. " +
                  "NEVER pick, describe, or even mention stories involving war, death, violence, crime, accidents, disasters, serious illness, or political conflict. If a search result is unsuitable, silently discard it and look for another. " +
                  "If the child brings up something frightening they heard elsewhere, say kindly and briefly that it is a topic for grown-ups, then guide them back to today's story. ")
            : `TODAY'S UNIT: ${lesson.unit || "general practice"}. Stay on this unit's topic and target items; do not wander to other material. `) +
        "LANGUAGE POLICY: " + languagePolicy(level) + " " +
        (adult
            ? "RESCUE RULE (overrides the ratio): if they are clearly stuck on a word or structure, give the Chinese equivalent once, then continue in English. "
            : "RESCUE RULE (overrides the ratio): if the student answers an English question in Chinese, says 「蛤？」or「什麼意思？」, or seems lost, immediately explain the last point in Traditional Chinese, then retry with SIMPLER English. ") +
        "TEACHING STYLE: " +
        (adult
            ? "(a) Speak naturally at a normal adult pace — two to four sentences per turn is fine — then stop and let them talk. Aim for a real conversation in which THEY do most of the talking. " +
              "(b) Ask ONE substantive, open-ended question at a time, then wait. Follow up on what they actually said rather than moving down a checklist. " +
              "(c) CORRECTION: do not interrupt mid-thought. When they finish, if there was a meaningful error, briefly give the natural way to say it and, when useful, one line on why — then carry on with the conversation. " +
              "Let trivial slips go; prioritise fluency. When their English is already good, occasionally offer a more idiomatic or precise alternative (a better verb, a natural collocation) so they keep levelling up. " +
              "Skip childish praise — no 'good job!' after every sentence. Respond to the CONTENT of what they said like a real conversation partner, and keep the register adult. " +
              "(d) PRODUCTION PRACTICE — this is the core of the session, not an optional extra: keep pushing them to express their OWN opinions and reasoning in English, at length, in their own words. " +
              "After each substantial turn, give a short concrete assessment before moving on: say what worked, give the natural phrasing for the one error most worth fixing, and where useful offer a more idiomatic alternative. Then ask a follow-up that makes them elaborate. "
            : "(a) Say at most TWO short sentences per turn, then stop. Waiting silently is part of teaching. " +
              "(b) Ask at most ONE short question, then STOP and wait for the student's real reply. " +
              "(c) RECAST RULE — after the student replies, model good English based on what they actually said: " +
              "if they replied in CHINESE, praise briefly, then show them how to say it in simple English and have them repeat (e.g. student says 「我很好！」 → say: Good! And you can say: \"I am fine!\" Try it!); " +
              "if they replied in ENGLISH with mistakes, never say 'wrong': acknowledge their meaning, naturally restate the corrected sentence, and invite them to try once more; " +
              "if their English was already CORRECT, praise them — and at most TWICE per lesson, also show ONE alternative way to say the same thing (e.g. Great! You can also say: \"I'm doing great!\"). After you have done this twice in a lesson, just praise and move on. " +
              "REPEAT ATTEMPT RULE: when the student's message is their attempt to repeat the sentence you just modelled, evaluate ONLY that attempt. If it is understandable, acknowledge it briefly and do NOT offer another alternative or start another repetition chain. If there is a major error, correct it once, slowly, then wait. " +
              "(d) PRODUCTION PRACTICE — the most important part of every lesson: do not let the student only repeat after you. Several times per lesson, get them to build their OWN sentence — ask what they think, what they like, which one they would choose, what they would do. " +
              "Then judge what they actually produced and always let them hear the correct full sentence: if they answered in Chinese, say the English sentence for them slowly and have them say it themselves; " +
              "if their English had a mistake, give the corrected sentence naturally (never say 'wrong') and have them try once more; if it was correct, tell them clearly that it was right, say in a few words what made it good, then invite one more sentence. " +
              "A young learner should finish every lesson having spoken several sentences that they built themselves. ") +
        "STRICT RULES: " +
        "(1) NEVER answer your own questions. NEVER speak for the student or invent their replies. There is only one voice: yours. " +
        "(2) Messages starting with [DIRECTOR NOTE] are hidden stage directions from the lesson system, not from the student. Follow them SILENTLY. " +
        "Absolutely never read a director note aloud, never repeat or paraphrase one, never mention that one exists, and NEVER write or invent a director note of your own — that format belongs to the lesson system only, never to you. " +
        `Everything you say out loud must be natural speech addressed directly to the ${learner}. If you ever find yourself about to say the words 'director note', stop and just talk to the student instead. ` +
        "(3) When you mention a concrete visual noun (like 'apple', 'cat', 'UFO'), call the show_image tool. When you teach a NEW word, also call the log_vocabulary tool with the word, its Traditional Chinese meaning, and a short example sentence. Tool calls are silent actions: never say tool names, '[System]', braces, or any code-like text out loud. " +
        "(4) VOICE CONSISTENCY — very important: keep exactly the same voice, tone, accent, speaking speed and persona for the ENTIRE lesson. Do not change your voice character between stages or between sentences. " +
        "(5) PACING: the lesson is run by DIRECTOR NOTES, stage by stage. Work ONLY on the current stage's task. NEVER run ahead to future material, NEVER summarize the whole day, and NEVER end the lesson or say goodbye on your own — the lesson ends ONLY when a DIRECTOR NOTE explicitly tells you to wrap up. If you finish the current task early, keep practising it in fresh ways until the next DIRECTOR NOTE arrives. " +
        "PRACTICE VARIETY — mandatory: use one target sentence for ONE imitation and, only if needed, ONE correction retry. As soon as it is understandable, consider it mastered for this session and move to a genuinely different sentence, word, question, situation, or activity. Do not ask for the same sentence again, and do not create a long drill by merely changing I/you/he/she/a name while keeping the same adjective. Rotate through all of TODAY'S listed items and use personal questions, choices, pictures, or a short role-play. A sentence-pattern family may be practised at most TWICE in the whole session — after the second time it is finished for today, whatever happens. " +
        "(6) CLARIFICATION OVERRIDE — this rule has priority over every feedback or translation rule below. If the learner says 「你在說什麼？」, 「你說什麼？」, 「什麼意思？」, 「我聽不懂」, 「蛤？」, asks you to repeat, or otherwise shows they did not understand YOUR previous words, treat it as a request for help — NOT as an answer to translate or correct. Never teach them to say 'What did you say?' in this situation. Instead, immediately repeat or rephrase YOUR last message in much simpler English; for Mandarin learners, add one short Traditional Chinese explanation when useful. Keep it to one or two short sentences, then STOP and let them respond. Do not continue the lesson topic in the same turn. " +
        "(6b) PROGRESS REPORTING — mandatory and completely silent: every time the " + learner + " attempts a target word or sentence, call report_item_result right after you have judged it and given your feedback. " +
        "One call per attempt, including the retry after a correction (attempt 2). Report what you actually heard them say, and whether it was correct, incorrect, or not attempted. " +
        "This is how the lesson system knows what they have mastered, so never skip it — but never say the tool's name, never announce that you are recording anything, and never let it interrupt the conversation. " +
        "(7) MANDATORY FEEDBACK LOOP — except for the clarification requests covered by rule 6, after EVERY turn the " + learner + " takes, do all three steps, briefly: " +
        "first, react to WHAT they said in one short sentence; " +
        "second, language feedback — if they spoke CHINESE, give the English way to say it and have them say it themselves; if their English had a mistake, naturally restate the corrected sentence and have them try once more; if it was correct, confirm it clearly and optionally offer one more natural way to phrase it; " +
        "third, hand the turn back with ONE question. " +
        "CRITICAL: the moment you invite them to say or repeat a sentence (e.g. 'You can say: ... Try it!'), your turn ENDS THERE — stop speaking and wait silently for their attempt. Do NOT continue with the topic, do NOT ask a different question, do NOT answer for them. Step three only happens AFTER they have tried. " +
        "NEVER skip step two, and never launch into another block of narration without completing this loop first." +
        (lesson.mode === "news" ? "" : pastLearningSection());   // 時事模式不接續學習進度
}

// 過去幾天學過的字 → 寫進 system prompt，讓 AI 跨天記得孩子的學習歷程
function pastLearningSection() {
    const past = recentVocabForPrompt();
    const today = learningRecords.today();
    const practice = learningRecords.recent(currentPersonName(), 10, today);
    if (!past.length && !practice.length) return "";
    const sections = [];
    if (past.length) {
        const words = past.map(v => v.word + (v.meaning ? " (" + v.meaning + ")" : "")).join("; ");
        sections.push("words already learned: " + words);
    }
    if (practice.length) {
        const phrases = practice.map(item => `\"${item.suggestion}\"${item.focus ? " [focus: " + item.focus + "]" : ""}`).join("; ");
        sections.push("English sentences previously modelled for this student: " + phrases);
    }
    return " PAST LESSONS — " + sections.join(". ") + ". " +
        "You genuinely remember teaching these. Reuse one naturally when it fits, especially a sentence the student previously needed help with, but do not recite this history or mention that you were given a list.";
}

// ---------------- 跨手機同步（Google 試算表後端，見 sync.gs / SETUP-SYNC.md） ----------------
// 網址與通關密語存在本機（不寫進程式碼，因為倉庫是公開的）。
// 合併原則：單字取聯集（次數取大、首次取早），設定類以較新的更新時間為準。
const SYNC_URL_KEY = "sync_url";
const SYNC_SECRET_KEY = "sync_secret";
let syncTimer = null;

function syncConfigured() {
    return !!(localStorage.getItem(SYNC_URL_KEY) || "").trim();
}

function syncStatus(msg, color) {
    const el = document.getElementById('syncStatus');
    if (el) { el.textContent = msg; el.style.color = color || "#aaa"; }
}

async function syncCall(action, data) {
    const url = (localStorage.getItem(SYNC_URL_KEY) || "").trim();
    if (!url) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    // 不自訂 header，讓它維持「簡單請求」，避開 Apps Script 的 CORS 預檢問題
    try {
        const res = await fetch(url, {
            method: "POST",
            body: JSON.stringify({ action, secret: localStorage.getItem(SYNC_SECRET_KEY) || "", data }),
            signal: controller.signal
        });
        const j = await res.json();
        if (!j.ok) throw new Error(j.error || "同步失敗");
        return j.data;
    } catch (error) {
        if (error && error.name === 'AbortError') throw new Error(`${action} 等待後端超過 15 秒`);
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

// 本機所有人員的資料 → 上傳用的格式
function collectLocalState() {
    const p = loadProfiles();
    const vocab = [];
    const practice = [];
    const profiles = {};
    Object.keys(p.people).forEach(name => {
        const person = p.people[name];
        profiles[name] = {
            level: person.level, voice: person.voice, unit: person.unit,
            interests: person.interests || [],
            progress: readAllProgressFor(name),
            updatedAt: person.updatedAt || 0
        };
        let list = [];
        try { list = JSON.parse(localStorage.getItem("vocab_log_v1::" + name)) || []; } catch (e) {}
        list.forEach(v => vocab.push(Object.assign({ person: name }, v)));
        learningRecords.load(name).forEach(item => practice.push(item));
    });
    return { schemaVersion: 2, vocab, practice, profiles };
}

// 某位人員所有單元的「上到第幾天」進度
function readAllProgressFor(name) {
    const prefix = "week_progress::" + name + "::";
    const out = {};
    Object.keys(localStorage).forEach(k => {
        if (k.indexOf(prefix) === 0) {
            try { out[k.slice(prefix.length)] = JSON.parse(localStorage.getItem(k)); } catch (e) {}
        }
    });
    return out;
}

// 伺服器回傳的合併結果 → 寫回本機
function applyRemoteState(remote) {
    if (!remote) return;
    // 單字：依人員分組覆蓋（伺服器已完成聯集合併）
    const byPerson = {};
    (remote.vocab || []).forEach(v => {
        if (!v.person) return;
        (byPerson[v.person] = byPerson[v.person] || []).push({
            word: v.word, meaning: v.meaning, example: v.example,
            firstDate: v.firstDate, lastDate: v.lastDate, count: v.count, unit: v.unit
        });
    });
    Object.keys(byPerson).forEach(name => {
        localStorage.setItem("vocab_log_v1::" + name, JSON.stringify(byPerson[name]));
    });

    // 句子練習：以穩定 id 取聯集，次數取大，舊版後端沒回 practice 時保留本機資料
    const practiceByPerson = {};
    (remote.practice || []).forEach(item => {
        if (!item || !item.person) return;
        (practiceByPerson[item.person] = practiceByPerson[item.person] || []).push(item);
    });
    Object.keys(practiceByPerson).forEach(name => learningRecords.merge(name, practiceByPerson[name]));

    // 設定與進度
    const p = loadProfiles();
    Object.keys(remote.profiles || {}).forEach(name => {
        const r = remote.profiles[name];
        if (!p.people[name] || !r) return;
        const localAt = Number(p.people[name].updatedAt || 0);
        if (Number(r.updatedAt || 0) >= localAt) {
            p.people[name].level = r.level != null ? r.level : p.people[name].level;
            p.people[name].voice = r.voice || p.people[name].voice;
            p.people[name].unit = r.unit !== undefined ? r.unit : p.people[name].unit;
            p.people[name].interests = r.interests || p.people[name].interests;
            p.people[name].updatedAt = r.updatedAt || 0;
        }
        Object.keys(r.progress || {}).forEach(unitName => {
            const k = "week_progress::" + name + "::" + unitName;
            const incoming = r.progress[unitName];
            let cur = null;
            try { cur = JSON.parse(localStorage.getItem(k)); } catch (e) {}
            // 進度取「日期較新」的那一份，避免另一支手機把進度倒退
            if (!cur || (incoming && String(incoming.date) >= String(cur.date))) {
                localStorage.setItem(k, JSON.stringify(incoming));
            }
        });
    });
    saveProfiles(p);
}

async function syncNow(silent) {
    if (!syncConfigured()) return;
    try {
        if (!silent) syncStatus("同步中…", "#f39c12");
        const merged = await syncCall("push", collectLocalState());
        applyRemoteState(merged);
        renderVocabPanel();
        if (window.refreshUnitPickerForPerson) window.refreshUnitPickerForPerson();
        if (window.refreshInterestsForPerson) window.refreshInterestsForPerson();
        if (window.refreshPersonSummary) window.refreshPersonSummary();
        const stamp = new Date().toLocaleTimeString();
        syncStatus(`✅ 已同步（${stamp}）`, "#4af626");
        logSystem(`☁️ 學習紀錄已與試算表同步。`);
    } catch (e) {
        syncStatus("⚠️ 同步失敗：" + e.message, "#ff6b6b");
        logSystem(`<span style="color:#ff8800;">☁️ 同步失敗：${e.message}</span>`);
    }
}

// 資料有變動就排程上傳（合併多次變動，避免每記一個字就打一次）
function scheduleSync() {
    if (!syncConfigured()) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncNow(true), 3000);
}

(function initSyncPanel() {
    const urlEl = document.getElementById('syncUrl');
    const secretEl = document.getElementById('syncSecret');
    const btn = document.getElementById('syncNowBtn');
    if (!urlEl) return;
    urlEl.value = localStorage.getItem(SYNC_URL_KEY) || "";
    secretEl.value = localStorage.getItem(SYNC_SECRET_KEY) || "";
    urlEl.addEventListener('input', () => localStorage.setItem(SYNC_URL_KEY, urlEl.value.trim()));
    secretEl.addEventListener('input', () => localStorage.setItem(SYNC_SECRET_KEY, secretEl.value.trim()));
    btn.addEventListener('click', () => syncNow(false));

    if (syncConfigured()) {
        syncStatus("開啟中，正在取回最新紀錄…", "#f39c12");
        syncNow(true);          // 一進 App 就先對齊一次
    } else {
        syncStatus("尚未設定，紀錄只存在這支手機。", "#888");
    }
})();

// ---------------- 首頁：選人員、進出設定 ----------------
const LEVEL_LABEL = { 1: "70% 中文", 2: "中英各半", 3: "70% 英文", 4: "幾乎全英", 5: "全英文" };

(function initHomeScreen() {
    const levelSel = document.getElementById('levelSelect');
    const summary = document.getElementById('personSummary');
    const settingsBtn = document.getElementById('settingsBtn');
    const closeBtn = document.getElementById('closeSettingsBtn');
    const personBtns = [...document.querySelectorAll('.person-btn')];
    const modeBtns = [...document.querySelectorAll('.mode-btn')];

    function selectMode(mode) {
        localStorage.setItem(MODE_KEY, mode === 'news' ? 'news' : 'lesson');
        modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === currentMode()));
        if (window.refreshPersonSummary) window.refreshPersonSummary();
    }
    modeBtns.forEach(b => b.addEventListener('click', () => selectMode(b.dataset.mode)));
    selectMode(currentMode());

    // 首頁上那一行摘要：這個人正在上什麼、程度、聲音、學過幾個字
    window.refreshPersonSummary = function () {
        if (!summary) return;
        const name = currentPersonName(), p = currentPerson();
        let unitText = "尚未選定單元";
        try { if (localStorage.getItem(MATERIAL_KEY)) unitText = "自訂教材"; } catch (e) {}
        if (p.unit && p.unit.book) {
            const u = UNITS_DATA ? findUnit(p.unit.book, p.unit.num) : null;
            unitText = `${p.unit.book} Unit ${p.unit.num}${u ? "：" + u.title : ""}`;
        }
        if (currentMode() === 'news') unitText = "時事討論（AI 找近一週新聞，給 5 個議題選）";
        const learned = loadVocabLog().length;
        const practised = learningRecords.load(name).length;
        clearNode(summary);
        summary.appendChild(makeElement('b', { text: name, color: '#4daafc' }));
        if (p.adult) summary.appendChild(makeElement('span', { text: ' 🧑 成人模式', color: '#b07cc6' }));
        appendText(summary, `　📖 ${unitText}`);
        summary.appendChild(document.createElement('br'));
        appendText(summary, `🈶 ${LEVEL_LABEL[p.level] || p.level}　🔊 ${p.voice}　📚 已學 ${learned} 個字、練過 ${practised} 句`);
    };

    // 切換人員：所有設定與紀錄都跟著換
    function selectPerson(name) {
        const p = loadProfiles();
        if (!p.people[name]) return;
        p.current = name;
        saveProfiles(p);
        syncControlsToPerson();
        personBtns.forEach(b => b.classList.toggle('active', b.dataset.person === name));
        if (window.refreshUnitPickerForPerson) window.refreshUnitPickerForPerson();
        if (window.refreshInterestsForPerson) window.refreshInterestsForPerson();
        renderVocabPanel();
        window.refreshPersonSummary();
    }

    // 把設定畫面的選單值對齊目前人員
    function syncControlsToPerson() {
        const p = currentPerson();
        if (levelSel) levelSel.value = String(p.level);
        if (voiceSelect) voiceSelect.value = p.voice;
        if (openaiSpeedSelect) openaiSpeedSelect.value = String(p.gptSpeed || (p.adult ? 1 : 0.9));
    }

    personBtns.forEach(b => b.addEventListener('click', () => selectPerson(b.dataset.person)));
    if (levelSel) levelSel.addEventListener('change', () => {
        updateCurrentPerson({ level: parseInt(levelSel.value, 10) });
        window.refreshPersonSummary();
    });
    if (voiceSelect) voiceSelect.addEventListener('change', () => {
        updateCurrentPerson({ voice: voiceSelect.value });
        window.refreshPersonSummary();
    });
    if (openaiSpeedSelect) openaiSpeedSelect.addEventListener('change', () => {
        updateCurrentPerson({ gptSpeed: parseFloat(openaiSpeedSelect.value) || 1 });
    });
    if (settingsBtn) settingsBtn.addEventListener('click', () => document.body.classList.add('settings-mode'));
    if (closeBtn) closeBtn.addEventListener('click', () => document.body.classList.remove('settings-mode'));

    // 開場：把畫面對齊上次使用的人員
    selectPerson(currentPersonName());
})();

function refreshDiagnosticsStatus(message, color) {
    const status = document.getElementById('diagnosticsStatus');
    if (!status) return;
    const state = sessionDiagnostics.inspect();
    if (message) {
        status.textContent = message;
        status.style.color = color || "#aaa";
        return;
    }
    status.textContent = state.active
        ? `正在記錄本堂課（${state.activeEvents} 個事件）；另有 ${state.savedSessions} 堂已完成紀錄。`
        : `目前保存 ${state.savedSessions} 堂診斷紀錄。`;
    status.style.color = state.active ? "#f39c12" : "#aaa";
}

(function initDiagnosticsPanel() {
    const exportBtn = document.getElementById('exportDiagnosticsBtn');
    const clearBtn = document.getElementById('clearDiagnosticsBtn');
    if (!exportBtn || !clearBtn) return;

    exportBtn.addEventListener('click', () => {
        sessionDiagnostics.record("diagnostics_exported", {});
        const blob = new Blob([sessionDiagnostics.exportJson()], { type: 'application/json;charset=utf-8' });
        const link = document.createElement('a');
        const downloadUrl = URL.createObjectURL(blob);
        link.href = downloadUrl;
        link.download = `ai-tutor-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        // 部分手機瀏覽器會延後接管下載；太早撤銷 Blob URL 會顯示成功卻沒有檔案。
        setTimeout(() => URL.revokeObjectURL(downloadUrl), 30000);
        refreshDiagnosticsStatus("診斷檔已匯出，可以直接提供給 Codex 分析。", "#4af626");
    });

    clearBtn.addEventListener('click', () => {
        if (!confirm("確定清除最近的課堂診斷嗎？學習紀錄不會受影響。")) return;
        sessionDiagnostics.clear();
        refreshDiagnosticsStatus("課堂診斷已清除；學習紀錄仍保留。", "#f39c12");
    });

    refreshDiagnosticsStatus();
})();

function logSystem(msg) {
    sessionDiagnostics.record("system_log", { message: legacyMarkupToText(msg) });
    const row = makeElement('div', {
        text: `[${new Date().toLocaleTimeString()}] ${legacyMarkupToText(msg)}`
    });
    if (/color\s*:\s*#ff/i.test(String(msg))) row.style.color = '#ff8800';
    sysLogBox.appendChild(row);
    sysLogBox.scrollTop = sysLogBox.scrollHeight;
}

// ---------------- 連線控制 ----------------

actionBtn.addEventListener('click', async () => {
    if (selectedProvider() === 'openai') {
        if (!syncConfigured()) { alert("GPT 測試需要先在設定中填入 Apps Script 同步網址。"); return; }
        if (!openaiSessionActive) await startOpenAISession();
        else { userStopped = true; stopSession("user"); }
        return;
    }
    if (!syncConfigured() && !readApiKey()) { alert("請先設定 Apps Script 同步網址，或在設定中填入 Gemini API Key！"); apiKeyInput.focus(); return; }
    if (!webSocket && !micStream) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!audioContext) audioContext = new AC({ sampleRate: 16000 });        // 上行：麥克風
        if (!playbackContext) playbackContext = new AC({ sampleRate: 24000 });  // 下行：AI 語音
        if (audioContext.state === 'suspended') audioContext.resume();
        if (playbackContext.state === 'suspended') playbackContext.resume();
        startSession();
    } else {
        userStopped = true; // 使用者主動結束，不要自動重連
        stopSession("user");
    }
});

function newsDisplayTitle(item) {
    const raw = String((item && item.title) || "").trim();
    return raw.replace(/\s+-\s+[^-]{1,50}$/, "").slice(0, 48) || "近期新聞";
}

function selectVisibleNewsTopics(topics) {
    const local = topics.filter(item => item && item.region === '台灣');
    const world = topics.filter(item => item && item.region === '國際');
    const selected = [];
    while (selected.length < 5 && (local.length || world.length)) {
        if (local.length) selected.push(local.shift());
        if (selected.length < 5 && world.length) selected.push(world.shift());
    }
    topics.forEach(item => {
        if (selected.length < 5 && item && !selected.includes(item)) selected.push(item);
    });
    return selected.slice(0, 5);
}

async function fetchAndShowNewsTopics() {
    const news = await syncCall('newsTopics', {});
    const topics = news && Array.isArray(news.topics) ? news.topics : [];
    if (!topics.length) throw new Error("目前無法取得近期新聞，請稍後重試或先切回一般課程");
    const visible = selectVisibleNewsTopics(topics);
    studentView.showTopics(visible.map(newsDisplayTitle));
    sessionDiagnostics.record("news_topics_displayed", {
        count: visible.length,
        regions: visible.map(item => item.region)
    });
    logSystem(`📰 已在學生畫面顯示 ${visible.length} 則新聞選項。`);
    return news;
}

async function startOpenAISession() {
    if (!openaiRealtime) { alert("GPT Realtime 模組沒有載入，請重新整理頁面後再試。"); return; }
    const tokenEndpoint = (localStorage.getItem(SYNC_URL_KEY) || "").trim();
    const selectedAudioMode = document.querySelector('input[name="audioMode"]:checked').value;
    const selectedPerson = currentPerson();
    sessionDiagnostics.start({
        appVersion: `v${APP_VERSION}`,
        provider: "openai",
        person: currentPersonName(),
        learnerType: selectedPerson.adult ? "adult" : "child",
        level: selectedPerson.level,
        mode: currentMode(),
        model: selectedOpenAIModel(),
        voice: openaiVoiceSelect ? openaiVoiceSelect.value : "marin",
        audioMode: selectedAudioMode,
        userAgent: navigator.userAgent
    });
    studentView.reset();
    sessionReady = false;
    closingStageActive = false;
    lessonCompletionPending = false;
    document.body.classList.remove('student-mode');
    refreshStudentReturnButton();
    statusBadge.textContent = 'GPT 連線中...';
    statusBadge.style.background = '#0e639c';
    statusBadge.style.color = '#fff';
    actionBtn.textContent = 'GPT 連線中...';
    actionBtn.disabled = true;
    talkBtn.disabled = true;
    clearNode(aiSpeechBox);
    if (userSpeechBox) setText(userSpeechBox, '等待語音輸入...');
    userStopped = false;
    isTalking = false;
    studentTurnGeneration = 0;
    pendingStudentResponseGeneration = null;
    activeAiResponseStudentGeneration = null;
    aiTurnTrackingStarted = false;
    currentUserTurnTranscript = "";
    activeAiTurnUserTranscript = "";
    currentAiTurnTranscript = "";
    stageTransitionGate.consume();
    lessonEndingGuard.resetSession();
    practiceTurnBoundary.reset();
    openaiAiTranscriptStarted = false;
    openaiSessionActive = false;

    try {
        LESSON = applyStudentOverride(resolveLessonForToday(await loadLesson()));
        prefetchLessonImages(LESSON);
        teachingFlow = buildTeachingFlow(LESSON);
        const totalMin = LESSON.stages.reduce((sum, stage) => sum + (stage.minutes || 0), 0);
        sessionDiagnostics.updateMetadata({
            unit: LESSON.unit || "一般練習",
            plannedMinutes: totalMin,
            plannedStages: teachingFlow.map(stage => stage.name)
        });
        currentStageIndex = 0;
        elapsedTime = 0;
        let newsContext = "";
        if (currentMode() === 'news') {
            const news = await fetchAndShowNewsTopics();
            const topics = news && Array.isArray(news.topics) ? news.topics : [];
            newsContext = " CURRENT NEWS HEADLINES fetched at " + news.fetchedAt + ": " +
                topics.map((item, index) => `${index + 1}. [${item.region}] ${item.title}`).join(" | ") +
                ". These headlines are your only current-news source. Never claim you searched the web. " +
                "Offer a few concise choices, then ask the learner to choose. NEVER choose a headline for the learner. " +
                "Only continue with a story after the learner clearly says its number or title; if their choice is unclear or empty, ask them to choose again and WAIT. ";
            logSystem(`📰 GPT 已取得 ${topics.length} 則近期新聞標題。`);
        }
        // 回合契約已包含在 buildSystemInstruction 內（兩個模型共用），不需在此重複。
        const instructions = buildSystemInstruction(LESSON || DEFAULT_LESSON) + newsContext;
        const openaiPracticeFamilies = {};
        await openaiRealtime.connect({
            tokenEndpoint,
            syncSecret: localStorage.getItem(SYNC_SECRET_KEY) || "",
            learnerId: currentPersonName(),
            model: selectedOpenAIModel(),
            voice: openaiVoiceSelect ? openaiVoiceSelect.value : "marin",
            speed: Number(currentPerson().gptSpeed || (currentPerson().adult ? 1 : 0.9)),
            audioMode: selectedAudioMode,
            instructions,
            tools: tutorToolDeclarations(),
            onState(detail) {
                sessionDiagnostics.record("openai_state", { state: detail.state });
            },
            onOutputAudioStopped() {
                handleClosingAudioStopped();   // 結語播完才真正下課
            },
            onAudioRoute(detail) {
                sessionDiagnostics.record("openai_audio_route", detail);
                if (detail.route === 'speakerphone-microphone') logSystem(`🔊 GPT 已選擇擴音麥克風：${detail.label}`);
                if (detail.route === 'speaker-fallback-no-aec') logSystem("🔊 找不到獨立擴音麥克風，GPT 改用直接播放備援。");
            },
            onTranscript(detail) {
                if (detail.role === 'student') {
                    currentUserTurnTranscript = detail.final ? detail.text : currentUserTurnTranscript + detail.text;
                    if (userSpeechBox) setText(userSpeechBox, detail.final ? detail.text : currentUserTurnTranscript);
                    return;
                }
                // 有些 Realtime 回合只送 final、沒有 delta。只有真的拿到新文字才清掉上一輪，
                // final-only 時要把完整文字補上，避免字幕框突然變空白。
                if (!detail.text) {
                    if (detail.final) openaiAiTranscriptStarted = false;
                    return;
                }
                if (detail.final) {
                    beginTrackedAiTurn();
                    aiTurnActive = true;
                    if (!openaiAiTranscriptStarted) {
                        studentView.beginTranscriptTurn();
                        studentView.appendTranscript(detail.text);
                    }
                    currentAiTurnTranscript = detail.text;
                    if (!openaiAiTranscriptStarted) {
                        lessonEndingGuard.observe(detail.text);
                        practiceTurnBoundary.observe(detail.text);
                    }
                    openaiAiTranscriptStarted = false;
                    return;
                }
                if (!openaiAiTranscriptStarted) {
                    beginTrackedAiTurn();
                    aiTurnActive = true;
                    studentView.beginTranscriptTurn();
                    openaiAiTranscriptStarted = true;
                }
                studentView.appendTranscript(detail.text);
                currentAiTurnTranscript += detail.text;
                lessonEndingGuard.observe(detail.text);
                practiceTurnBoundary.observe(detail.text);
            },
            onToolCall(detail) {
                handleOpenAIToolCall(detail).catch(error => {
                    sessionDiagnostics.record("openai_tool_failed", { name: detail.name, message: error.message });
                    openaiRealtime.sendToolResult(detail.callId, { status: "error", message: error.message }, true);
                });
            },
            onTurnComplete() {
                openaiAiTranscriptStarted = false;
                const feedback = completeTrackedAiTurn("openai");
                if (feedback && feedback.suggestion) {
                    const family = window.PracticeObserver.sentenceFamily(feedback.suggestion);
                    if (family) openaiPracticeFamilies[family] = (openaiPracticeFamilies[family] || 0) + 1;
                    const repeatedFamilies = Object.keys(openaiPracticeFamilies)
                        .filter(key => openaiPracticeFamilies[key] >= 2)
                        .slice(-5);
                    if (repeatedFamilies.length) {
                        openaiRealtime.updateInstructions(instructions +
                            " SESSION VARIETY STATE: These sentence families are already mastered or over-practised: " +
                            repeatedFamilies.join("; ") +
                            ". Do not request another repetition or pronoun/name substitution from these families. Move to a different listed item, situation, question, or role-play now.");
                        sessionDiagnostics.record("openai_practice_family_limited", { families: repeatedFamilies });
                    }
                }
            },
            onError(error) {
                sessionDiagnostics.record("openai_error", { message: error.message });
                logSystem(`<span style="color:#ff4444;">GPT 錯誤：${error.message}</span>`);
            }
        });
        markSessionReady('openai');
    } catch (err) {
        sessionDiagnostics.record("startup_failed", { provider: "openai", message: err.message });
        logSystem(`<span style="color:#ff4444;">GPT 啟動失敗：${err.message}</span>`);
        alert("GPT 連線失敗：" + err.message + "\n\n你可以先切回 Gemini 繼續使用。");
        stopSession("openai_startup_error");
    }
}

async function startSession() {
    const selectedAudioMode = document.querySelector('input[name="audioMode"]:checked').value;
    const selectedPerson = currentPerson();
    sessionDiagnostics.start({
        appVersion: `v${APP_VERSION}`,
        person: currentPersonName(),
        learnerType: selectedPerson.adult ? "adult" : "child",
        level: selectedPerson.level,
        mode: currentMode(),
        model: document.getElementById('modelSelect').value,
        voice: voiceSelect.value,
        audioMode: selectedAudioMode,
        userAgent: navigator.userAgent
    });
    refreshDiagnosticsStatus();
    studentView.reset();                         // 清掉上一場殘留的議題／圖片／字幕
    sessionReady = false;
    closingStageActive = false;
    lessonCompletionPending = false;
    document.body.classList.remove('student-mode'); // 模型 setupComplete 後才進學生畫面
    refreshStudentReturnButton();
    statusBadge.textContent = '連線中...'; statusBadge.style.background = '#0e639c'; statusBadge.style.color = '#fff';
    actionBtn.textContent = '連線中...'; actionBtn.disabled = true;
    elapsedTime = 0; currentStageIndex = 0; stagePendingSince = null; pendingDirectorNote = null;
    suppressAudioAfterFarewell = false;
    suppressAudioAfterPractice = false;
    if (lessonFinishTimer) clearTimeout(lessonFinishTimer);
    lessonFinishTimer = null;
    lessonEndingGuard.resetSession();
    practiceTurnBoundary.reset();
    stageTransitionGate.consume();
    practiceFamilyCounts = {};          // 重複上限逐堂重算
    awaitingClosingAudio = false;       // 上一堂若在等結語播完，開新課時清掉
    itemResults = [];                   // 練習結果回報逐堂重算
    practiceTurnsObserved = 0;
    studentTurnGeneration = 0; pendingStudentResponseGeneration = null;
    activeAiResponseStudentGeneration = null; aiTurnTrackingStarted = false;
    currentUserTurnTranscript = ""; activeAiTurnUserTranscript = ""; currentAiTurnTranscript = "";
    aiTurnActive = false; dropStaleAudio = false;
    userStopped = false; resumeHandle = null; liveSession.start();
    isNewAiTurn = true; isNewUserTurn = true;
    clearNode(aiSpeechBox);
    if (userSpeechBox) setText(userSpeechBox, '等待語音輸入...');
    generatedImage.style.display = 'none';
    imageCaption.textContent = "等待 AI 呼叫 show_image ...";
    logSystem("正在請求麥克風權限...");

    try {
        statusBadge.textContent = '準備麥克風...';
        actionBtn.textContent = '準備麥克風...';
        micStream = await acquireMicStream(selectedAudioMode);
        await setupAudioWorklet();

        // 載入今日教案（GAS → lesson.json → 內建預設），週教案先解析出今天上第幾天
        statusBadge.textContent = '載入課程...';
        actionBtn.textContent = '載入課程...';
        LESSON = applyStudentOverride(resolveLessonForToday(await loadLesson()));
        prefetchLessonImages(LESSON);
        teachingFlow = buildTeachingFlow(LESSON);
        if (currentMode() === 'news' && syncConfigured()) {
            statusBadge.textContent = '載入新聞...';
            actionBtn.textContent = '載入新聞...';
            try {
                await fetchAndShowNewsTopics();
            } catch (newsError) {
                logSystem(`<span style="color:#ff8800;">⚠️ 新聞選項載入失敗，Gemini 將改用搜尋工具：${newsError.message}</span>`);
            }
        }
        const totalMin = LESSON.stages.reduce((a, s) => a + (s.minutes || 0), 0);
        sessionDiagnostics.updateMetadata({
            unit: LESSON.unit || "一般練習",
            plannedMinutes: totalMin,
            plannedStages: teachingFlow.map(stage => stage.name)
        });
        sessionDiagnostics.record("lesson_loaded", {
            unit: LESSON.unit || "一般練習",
            stages: teachingFlow.map(stage => ({ name: stage.name, startsAtSecond: stage.time }))
        });
        logSystem(`📋 課程結構：${teachingFlow.map(s => s.name).join(" → ")}（共 ${totalMin} 分鐘）`);

        // 優先由 Apps Script 換取本場課程的 Gemini 短效憑證。
        currentToken = null;
        if (syncConfigured()) {
            statusBadge.textContent = '安全驗證...';
            actionBtn.textContent = '安全驗證...';
            logSystem("🔑 向後端請求臨時憑證...");
            try {
                const result = await syncCall('geminiLiveToken', {});
                currentToken = result && (result.name || result.token);
            } catch (tokenError) {
                logSystem(`<span style="color:#ff8800;">⚠️ Gemini 短效憑證取得失敗：${tokenError.message}</span>`);
            }
            if (currentToken) {
                logSystem("🔑 已取得臨時憑證（30 分鐘有效）。");
                localStorage.removeItem('gemini_api_key');
                GEMINI_API_KEY = "";
                if (apiKeyInput) apiKeyInput.value = "";
            } else {
                if (!readApiKey()) throw new Error("無憑證也無 API Key，無法連線");
            }
        }

        statusBadge.textContent = '連接 Gemini...';
        actionBtn.textContent = '連接 Gemini...';
        connectWebSocket(false);
    } catch (err) {
        sessionDiagnostics.record("startup_failed", { message: err.message });
        logSystem(`<span style="color:#ff4444;">❌ 啟動失敗: ${err.message}</span>`);
        alert("Gemini 連線失敗：" + err.message + "\n\n請確認 Apps Script 已部署最新 sync.gs，且指令碼屬性中有 GEMINI_API_KEY。");
        stopSession("startup_error");
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
    const enterStudentView = () => {
        if (!sessionReady) return;
        document.body.classList.remove('settings-mode');
        document.body.classList.add('student-mode');
        refreshStudentReturnButton();
    };
    if (enterBtn) enterBtn.addEventListener('click', enterStudentView);
    if (resumeStudentBtn) resumeStudentBtn.addEventListener('click', enterStudentView);
    if (exitBtn) exitBtn.addEventListener('click', () => {
        document.body.classList.remove('student-mode');
        refreshStudentReturnButton();
    });
})();

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

// ---------------- 學習紀錄（跨天記憶的基礎） ----------------
// AI 每教一個新字就會呼叫 log_vocabulary，這裡把它存進瀏覽器（localStorage）。
// 下次上課時再把「學過哪些字」寫進 system prompt，AI 就真的記得孩子的學習歷程。
const VOCAB_KEY = "vocab_log_v1";

function loadVocabLog() {
    try {
        const a = JSON.parse(localStorage.getItem(vocabKey()));
        return Array.isArray(a) ? a : [];
    } catch (e) { return []; }
}

function saveVocabLog(list) {
    try { localStorage.setItem(vocabKey(), JSON.stringify(list)); } catch (e) {}
}

// 記錄一個單字：同一個字重複學會累加次數並更新日期，不重複佔位
function recordVocab(word, meaning, example) {
    word = (word || "").trim();
    if (!word) return;
    const list = loadVocabLog();
    const today = learningRecords.today();
    const unit = (LESSON && LESSON.unit) ? LESSON.unit : "";
    const key = word.toLowerCase();
    const hit = list.find(v => (v.word || "").toLowerCase() === key);
    if (hit) {
        hit.count = (hit.count || 1) + 1;
        hit.lastDate = today;
        if (meaning && !hit.meaning) hit.meaning = meaning;
        if (example && !hit.example) hit.example = example;
    } else {
        list.push({ word, meaning: meaning || "", example: example || "",
                    firstDate: today, lastDate: today, count: 1, unit });
    }
    saveVocabLog(list);
    renderVocabPanel();
    scheduleSync();          // 有設定同步的話，稍後一併上傳
    logSystem(`📚 已記錄單字：${word}${meaning ? "（" + meaning + "）" : ""}`);
}

// 記錄 AI 針對學生實際回答提供的英文示範。只存文字，不保存聲音檔。
function recordPracticeFeedback(original, suggestion, kind, focus) {
    const item = learningRecords.record(currentPersonName(), {
        original,
        suggestion,
        kind,
        focus,
        unit: (LESSON && LESSON.unit) ? LESSON.unit : "",
        mode: currentMode()
    });
    if (!item) return;
    renderVocabPanel();
    if (window.refreshPersonSummary) window.refreshPersonSummary();
    scheduleSync();
    logSystem(`✍️ 已記錄句子練習：${item.suggestion}`);
}

// 供 system prompt 使用：最近學過的字（上限 40 個，避免指令過長）
function recentVocabForPrompt() {
    const today = learningRecords.today();
    const list = loadVocabLog()
        .filter(v => v.lastDate !== today)          // 今天剛教的不算「以前學過」
        .sort((a, b) => (b.lastDate || "").localeCompare(a.lastDate || ""))
        .slice(0, 40);
    return list;
}

function renderVocabPanel() {
    renderPracticePanel();
    const sum = document.getElementById('vocabSummary');
    const box = document.getElementById('vocabList');
    if (!sum || !box) return;
    const list = loadVocabLog();
    if (!list.length) {
        sum.textContent = "還沒有紀錄。上課時 AI 教到新單字就會自動記在這裡。";
        clearNode(box);
        return;
    }
    const days = new Set(list.map(v => v.firstDate)).size;
    sum.textContent = `${currentPersonName()}：共 ${list.length} 個單字，橫跨 ${days} 天上課。`;
    // 依「第一次學到的日期」分組，新的在上面
    const byDate = {};
    list.forEach(v => { (byDate[v.firstDate] = byDate[v.firstDate] || []).push(v); });
    clearNode(box);
    Object.keys(byDate).sort().reverse().forEach(date => {
        const group = makeElement('div');
        group.style.marginBottom = '8px';
        group.appendChild(makeElement('span', { text: `📅 ${date}`, color: '#4af626' }));
        group.appendChild(document.createElement('br'));
        byDate[date].forEach(v => {
            const chip = makeElement('span');
            Object.assign(chip.style, {
                display: 'inline-block', background: '#333', borderRadius: '12px',
                padding: '2px 10px', margin: '2px 4px 2px 0'
            });
            chip.appendChild(makeElement('b', { text: v.word, color: '#4daafc' }));
            if (v.meaning) chip.appendChild(makeElement('span', { text: ` ${v.meaning}`, color: '#aaa' }));
            if (v.count > 1) chip.appendChild(makeElement('span', { text: ` ×${v.count}`, color: '#f39c12' }));
            group.appendChild(chip);
        });
        box.appendChild(group);
    });
}

function renderPracticePanel() {
    const sum = document.getElementById('practiceSummary');
    const box = document.getElementById('practiceList');
    if (!sum || !box) return;
    const list = learningRecords.load(currentPersonName());
    const stats = learningRecords.summary(currentPersonName());
    if (!list.length) {
        sum.textContent = "還沒有句子練習。AI 提供中文轉英文、文法修正或替代表達後，會自動記在這裡。";
        clearNode(box);
        return;
    }
    sum.textContent = `${currentPersonName()}：${stats.entries} 句、共練習 ${stats.attempts} 次（中文轉英文 ${stats.kinds.translated}、文法修正 ${stats.kinds.corrected}、替代表達 ${stats.kinds.alternative}）。`;
    const kindLabel = { translated: "中→英", corrected: "修正", alternative: "替代表達" };
    clearNode(box);
    list.slice(0, 30).forEach(item => {
        const row = makeElement('div');
        Object.assign(row.style, {
            background: '#303030', borderRadius: '7px', padding: '7px 9px', marginBottom: '6px'
        });
        row.appendChild(makeElement('span', { text: `${item.date} · ${kindLabel[item.kind] || item.kind}`, color: '#f39c12' }));
        if (item.count > 1) row.appendChild(makeElement('span', { text: ` ×${item.count}`, color: '#aaa' }));
        row.appendChild(document.createElement('br'));
        if (item.original) {
            row.appendChild(makeElement('span', { text: `學生：${item.original}`, color: '#aaa' }));
            row.appendChild(document.createElement('br'));
        }
        row.appendChild(makeElement('b', { text: `英文：${item.suggestion}`, color: '#4daafc' }));
        if (item.focus) {
            row.appendChild(document.createElement('br'));
            row.appendChild(makeElement('span', { text: `重點：${item.focus}`, color: '#9b59b6' }));
        }
        box.appendChild(row);
    });
}

// 匯出 / 還原 / 清除
(function initVocabPanel() {
    const exportBtn = document.getElementById('exportVocabBtn');
    const importBtn = document.getElementById('importVocabBtn');
    const importFile = document.getElementById('importVocabFile');
    const clearBtn = document.getElementById('clearVocabBtn');
    if (!exportBtn) return;

    exportBtn.addEventListener('click', () => {
        const data = JSON.stringify({
            schemaVersion: 2,
            person: currentPersonName(),
            exportedAt: new Date().toISOString(),
            vocab: loadVocabLog(),
            practice: learningRecords.load(currentPersonName())
        }, null, 2);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
        a.download = `ai-tutor-${currentPersonName()}-學習紀錄-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
    });

    importBtn.addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', () => {
        const f = importFile.files && importFile.files[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const backup = JSON.parse(reader.result);
                // 舊備份只有單字陣列；新版備份同時包含 vocab / practice
                const incoming = Array.isArray(backup) ? backup : backup.vocab;
                if (!Array.isArray(incoming)) throw new Error("格式不符");
                // 與現有紀錄合併，同一個字取次數較多、日期較新的
                const merged = loadVocabLog();
                incoming.forEach(v => {
                    const hit = merged.find(m => (m.word || "").toLowerCase() === (v.word || "").toLowerCase());
                    if (hit) {
                        hit.count = Math.max(hit.count || 1, v.count || 1);
                        if ((v.firstDate || "") < (hit.firstDate || "9999")) hit.firstDate = v.firstDate;
                        if ((v.lastDate || "") > (hit.lastDate || "")) hit.lastDate = v.lastDate;
                        hit.meaning = hit.meaning || v.meaning || "";
                        hit.example = hit.example || v.example || "";
                    } else merged.push(v);
                });
                saveVocabLog(merged);
                if (!Array.isArray(backup) && Array.isArray(backup.practice)) {
                    learningRecords.merge(currentPersonName(), backup.practice);
                }
                renderVocabPanel();
                scheduleSync();
                alert(`還原完成，目前共 ${merged.length} 個單字、${learningRecords.load(currentPersonName()).length} 句練習。`);
            } catch (e) { alert("還原失敗：檔案格式不正確。"); }
            importFile.value = "";
        };
        reader.readAsText(f);
    });

    clearBtn.addEventListener('click', () => {
        if (!confirm(`確定要清除 ${currentPersonName()} 的全部學習紀錄嗎？建議先「匯出備份」。此動作無法復原。`)) return;
        localStorage.removeItem(vocabKey());
        learningRecords.clear(currentPersonName());
        renderVocabPanel();
    });

    renderVocabPanel();
})();

function logVocabToSheet(word, meaning, example) {
    if (!GAS_URL) return;
    const stageName = currentStageIndex > 0 && teachingFlow[currentStageIndex - 1] ? teachingFlow[currentStageIndex - 1].name : "";
    gasPost({ action: "logVocab", word, meaning, example, stage: stageName })
        .then(r => { if (r && r.ok) logSystem(`📚 已記錄單字: ${word}`); });
}

// 建立（或重建）WebSocket 連線。isReconnect = true 表示意外斷線後的自動重連，
// 會保留麥克風、AudioWorklet、課程進度，並用 resumeHandle 恢復 AI 的對話記憶。
function connectWebSocket(isReconnect) {
    if (!liveSession.isActive() || userStopped) return;
    sessionDiagnostics.record("connection_attempt", {
        reconnect: !!isReconnect,
        hasTemporaryCredential: !!currentToken,
        hasResumptionHandle: !!resumeHandle
    });
    // Gemini 短效憑證必須走 v1beta constrained 端點；API Key 走原本的 v1beta 端點。
    const url = currentToken
        ? `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(currentToken)}`
        : `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
    const socket = new WebSocket(url);
    const socketToken = liveSession.adopt(socket);
    if (!socketToken) {
        try { socket.close(); } catch (e) {}
        return;
    }
    webSocket = socket;
    stopAllPlayback(); // 新連線不得接續播放上一條連線已排程的聲音
    if (connectionWatchdog) clearTimeout(connectionWatchdog);
    connectionWatchdog = setTimeout(() => {
        if (!liveSession.isCurrent(socket, socketToken) || socket.readyState === WebSocket.OPEN) return;
        sessionDiagnostics.record("connection_timeout", { reconnect: !!isReconnect });
        alert("Gemini WebSocket 連線超過 15 秒沒有回應，已停止連線。\n\n請稍後再試；若重複發生，請匯出課堂診斷給我。");
        stopSession("connection_timeout");
    }, 15000);

    socket.onopen = () => {
        if (!liveSession.isCurrent(socket, socketToken)) return;
        if (connectionWatchdog) clearTimeout(connectionWatchdog);
        connectionWatchdog = null;
        sessionDiagnostics.record("connection_opened", { reconnect: !!isReconnect });
        statusBadge.textContent = isReconnect ? '🔄 確認模型中...' : 'Gemini 確認模型中...';
        statusBadge.style.background = '#0e639c';
        actionBtn.textContent = isReconnect ? '重連確認中...' : 'Gemini 確認中...';
        actionBtn.disabled = true;
        talkBtn.disabled = true;
        nextStageBtn.disabled = true;
        // 注意：重連次數不在這裡歸零。連線握手成功不代表設定被接受——
        // 若模型無效，伺服器會在 setup 後立刻踢斷，在這歸零會造成無限重連迴圈。
        // 歸零改在收到 setupComplete（伺服器真正接受設定）時。
        sendSetupMessage(socket, socketToken);
        if (isReconnect) {
            logSystem(resumeHandle
                ? "🔄 已重新連上，對話記憶已透過 resumption handle 恢復。"
                : "🔄 已重新連上（尚未取得恢復握把，AI 對話記憶重置，課程進度不受影響）。");
        }
    };

    socket.onmessage = async (event) => {
        if (!liveSession.isCurrent(socket, socketToken)) return;
        try {
            let textData = event.data;
            if (event.data instanceof Blob) textData = await event.data.text();
            if (!liveSession.isCurrent(socket, socketToken)) return;
            const response = JSON.parse(textData);
            handleServerMessage(response, socket, socketToken);
        } catch (err) {
            if (liveSession.isCurrent(socket, socketToken)) {
                sessionDiagnostics.record("server_message_parse_failed", { message: err.message });
                logSystem(`<span style="color:#ff4444;">訊息解析失敗: ${err.message}</span>`);
            }
        }
    };

    socket.onclose = (e) => {
        // 舊 socket 的 close 可能在新 socket 建立後才抵達；絕不能清掉新連線或再排一條重連。
        if (!liveSession.release(socket, socketToken)) return;
        if (webSocket === socket) webSocket = null;
        stopAllPlayback();
        nextStageBtn.disabled = true;
        if (!isTalking) {
            talkBtn.disabled = true;
            talkBtn.textContent = '🔄 正在重連...';
        }
        sessionDiagnostics.record("connection_closed", {
            code: e.code,
            reason: e.reason || "",
            userStopped: !!userStopped,
            wasTalking: !!isTalking,
            waitingForAi: !!waitingFirstAudio
        });
        logSystem(`<span style="color:#ff8800;">WebSocket 關閉 (code=${e.code}${e.reason ? ', reason=' + e.reason : ''})</span>`);
        if (userStopped) { stopSession("user"); return; }
        // 額度／計費類：重連一萬次也沒用，直接停下並說清楚該去哪處理
        if (/spending cap|quota|billing|exceeded|RESOURCE_EXHAUSTED/i.test(e.reason || "")) {
            logSystem("<span style='color:#ff4444;'>❌ Google AI 專案已達本月支出上限（或額度用盡），Gemini 拒絕連線。" +
                      "請到 AI Studio（https://ai.studio/spend）調整上限，或等下個月額度重置。這不是程式問題，重連無法解決。</span>");
            alert("連線被 Google 拒絕：你的 AI Studio 專案已達本月支出上限（或額度用盡）。\n\n" +
                  "請到 https://ai.studio/spend 查看與調整，或等待下個月重置。\n\n（這不是程式的問題，重連也無法解決。）");
            stopSession("quota_or_billing");
            return;
        }
        if (e.code === 1011) logSystem("（code 1011 = Gemini 伺服器端錯誤，通常是偶發問題，靠重連恢復）");
        // 設定類錯誤（如模型不存在/不支援）：重連也不會好，直接停下並指引使用者，避免無限重連迴圈
        if (e.code === 1008 && /not found|not supported/i.test(e.reason || "")) {
            logSystem("<span style='color:#ff4444;'>❌ 你選的模型已失效（Google 下架或改名了）。請在上方「模型選擇」換一個（建議第一個「原生語音」），再按「開始連線」。</span>");
            alert("這個模型已失效（Google 可能已下架或改名）。\n請在「模型選擇」換一個模型，建議選第一個「原生語音」，然後重新連線。");
            stopSession("model_unavailable");
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
        const reconnectAttempt = liveSession.scheduleReconnect(() => connectWebSocket(true), 800);
        if (reconnectAttempt != null) {
            sessionDiagnostics.record("reconnect_scheduled", { attempt: reconnectAttempt, delayMs: 800 });
            statusBadge.textContent = '🔄 重連中...'; statusBadge.style.background = '#b8860b';
            logSystem(`🔄 無預警斷線，自動重連 ${reconnectAttempt}/3 ...`);
        } else {
            logSystem("❌ 多次重連失敗，結束連線。");
            stopSession("reconnect_exhausted");
        }
    };

    socket.onerror = () => {
        if (!liveSession.isCurrent(socket, socketToken)) return;
        sessionDiagnostics.record("connection_error", {});
        logSystem('<span style="color:#ff4444;">WebSocket 發生錯誤</span>');
    };
}

// （原本這裡有「閒置保活」機制：每 8 秒送靜音。已移除——
//   手動 VAD 模式下，活動範圍外送音訊會被伺服器以 1007 invalid argument 拒絕並斷線，
//   反而造成連環斷線迴圈。閒置斷線的風險改由自動重連＋重送機制承擔。）

// ---------------- Setup 訊息（含工具宣告與逐字稿） ----------------

function tutorToolDeclarations() {
    return [{
        type: "function",
        name: "show_image",
        description: "Show the learner an educational illustration of a concrete noun. Call this every time you mention or teach a visual, concrete noun (e.g. 'apple', 'UFO', 'elephant'), BEFORE or WHILE you talk about it. When teaching vocabulary, include the exact vocabulary word in the keyword and keep the description short.",
        parameters: {
            type: "object",
            properties: { keyword: { type: "string", description: "A short English noun phrase describing what to draw, e.g. 'red apple' or 'UFO in the sky'." } },
            required: ["keyword"]
        }
    }, {
        type: "function",
        name: "log_vocabulary",
        description: "Silently save a vocabulary word to the learner's record. Call this every time you TEACH a new word, or the learner struggles with a word worth reviewing later.",
        parameters: {
            type: "object",
            properties: {
                word: { type: "string", description: "The English word or phrase taught." },
                meaning: { type: "string", description: "Traditional Chinese meaning, e.g. 雨傘" },
                example: { type: "string", description: "A short example sentence in English." }
            },
            required: ["word", "meaning"]
        }
    }, {
        type: "function",
        name: "show_topics",
        description: "Display a short numbered list of choices on the learner's screen so they can SEE them and pick one. Use this in the news chat when offering today's story options — a young child cannot remember five options by ear.",
        parameters: {
            type: "object",
            properties: {
                topics: { type: "array", items: { type: "string" }, description: "Exactly 5 very short titles (max ~12 characters each), in the language the learner understands best." }
            },
            required: ["topics"]
        }
    }, {
        type: "function",
        name: "report_item_result",
        description: "Silently report the outcome of ONE practice attempt by the learner. " +
            "Call it immediately after you have judged their attempt and given your feedback, once per attempt including retries. " +
            "This is how the lesson system knows what the learner has actually mastered. Never say its name and never mention reporting out loud.",
        parameters: {
            type: "object",
            properties: {
                target: { type: "string", description: "The English word or sentence the learner was asked to produce." },
                outcome: {
                    type: "string",
                    enum: ["correct", "incorrect", "no_response"],
                    description: "correct = understandable and accurate enough; incorrect = wrong or incomplete; no_response = they did not attempt it."
                },
                studentSaid: { type: "string", description: "What the learner actually said, as you heard it. Empty if they said nothing." },
                attempt: { type: "integer", description: "1 for the first try, 2 for the retry after your correction." },
                kind: {
                    type: "string",
                    enum: ["review_word", "review_pattern", "new_word", "extension_word", "pattern_drill", "free"],
                    description: "Which kind of practice item this was."
                },
                issue: { type: "string", description: "Optional short note on what was off, e.g. missing verb, wrong word order, sounded unsure." }
            },
            required: ["target", "outcome"]
        }
    }];
}

// Gemini 的函式宣告格式與 OpenAI 幾乎相同，只差型別要大寫。
// 兩邊各寫一份會分歧（提示詞就吃過這個虧），因此統一由上面那份轉換產生。
function toGeminiSchema(schema) {
    if (!schema || typeof schema !== "object") return schema;
    const out = {};
    Object.keys(schema).forEach(key => {
        const value = schema[key];
        if (key === "type" && typeof value === "string") out.type = value.toUpperCase();
        else if (key === "properties") {
            out.properties = {};
            Object.keys(value).forEach(prop => { out.properties[prop] = toGeminiSchema(value[prop]); });
        } else if (key === "items") out.items = toGeminiSchema(value);
        else out[key] = value;
    });
    return out;
}

function geminiToolDeclarations() {
    return tutorToolDeclarations().map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: toGeminiSchema(tool.parameters)
    }));
}

async function executeTutorTool(name, args) {
    const a = args || {};
    if (name === "show_image") {
        const keyword = a.keyword || "picture";
        const imageStatus = await showImage(keyword);
        return { status: imageStatus === 'ready' ? "image displayed to student" : `image ${imageStatus}; student sees a safe placeholder` };
    }
    if (name === "show_topics") {
        const list = Array.isArray(a.topics) ? a.topics.slice(0, 5) : [];
        studentView.showTopics(list);
        logSystem(`📰 [toolCall] show_topics：${list.join(" / ")}`);
        return { status: "topics displayed to student" };
    }
    if (name === "log_vocabulary") {
        studentView.showWord(a.word || "", a.meaning || "", a.example || "");
        recordVocab(a.word || "", a.meaning || "", a.example || "");
        logVocabToSheet(a.word || "", a.meaning || "", a.example || "");
        return { status: "vocabulary saved" };
    }
    if (name === "report_item_result") {
        return recordItemResult(a);
    }
    return { status: "unsupported tool" };
}

async function handleOpenAIToolCall(detail) {
    let args = {};
    try { args = JSON.parse(detail.arguments || "{}"); }
    catch (error) { throw new Error(`工具參數格式錯誤：${detail.name}`); }
    sessionDiagnostics.record("openai_tool_call", { name: detail.name });
    const result = await executeTutorTool(detail.name, args);
    openaiRealtime.sendToolResult(detail.callId, result, true);
}

function sendSetupMessage(socket, socketToken) {
    if (!liveSession.isCurrent(socket, socketToken) || socket.readyState !== WebSocket.OPEN) return;
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
            // 上下文壓縮（滑動視窗）：純語音 session 預設 15 分鐘上限，
            // 而一堂課約 15-16 分鐘，剛好撞線被強制中斷。啟用後可無限延長，
            // 大幅減少重連次數（每次重連都可能讓音色重新飄一次）
            contextWindowCompression: { slidingWindow: {} },
            // Push-to-talk 模式：關閉自動 VAD，
            // 改由前端發送 activityStart / activityEnd 手動標記說話起訖
            realtimeInputConfig: {
                automaticActivityDetection: { disabled: true }
            },
            // 工具：時事模式才開 Google 搜尋（一般課程不需要，也避免它跑去搜尋離題）。
            // 函式宣告與 GPT 共用同一份來源，避免兩邊分歧。
            tools: (LESSON && LESSON.mode === 'news' ? [{ googleSearch: {} }] : [])
                .concat([{ functionDeclarations: geminiToolDeclarations() }]),
            systemInstruction: {
                parts: [{
                    // system prompt 依本堂教案動態組裝（學生檔案、語言配比、教學風格、既有嚴格規則）
                    text: buildSystemInstruction(LESSON || DEFAULT_LESSON)
                }]
            }
        }
    };
    socket.send(JSON.stringify(setup));
    logSystem(`Setup 已送出（模型: ${selectedModel.split('/').pop()}）。`);
}

// ---------------- 伺服器訊息處理 ----------------

// 圖片工具回應會等到「圖片完成」或「等待逾時」才送回模型。
// 這會讓 AI 在教下一個單字前留出真正的看圖時間，而不是一收到網址就繼續講。
async function respondToToolCalls(functionCalls, sourceSocket, socketToken) {
    const functionResponses = await Promise.all(functionCalls.map(async fc => {
        const result = await executeTutorTool(fc.name, fc.args || {});
        return {
            id: fc.id,
            name: fc.name,
            response: { result }
        };
    }));

    if (functionResponses.length > 0 && liveSession.isCurrent(sourceSocket, socketToken) && sourceSocket.readyState === WebSocket.OPEN) {
        sourceSocket.send(JSON.stringify({ toolResponse: { functionResponses } }));
    } else if (functionResponses.length > 0) {
        logSystem("⚠️ 工具已完成，但連線已中斷；恢復連線後由 AI 重新確認畫面內容。");
    }
}

function beginTrackedAiTurn() {
    if (aiTurnTrackingStarted) return;
    aiTurnTrackingStarted = true;
    currentAiTurnTranscript = "";
    activeAiResponseStudentGeneration = pendingStudentResponseGeneration;
    activeAiTurnUserTranscript = activeAiResponseStudentGeneration !== null ? currentUserTurnTranscript : "";
}

function completeTrackedAiTurn(provider) {
    const completesCurrentStudentTurn = activeAiResponseStudentGeneration !== null &&
        activeAiResponseStudentGeneration === pendingStudentResponseGeneration;
    const completedUserTranscript = activeAiTurnUserTranscript;
    const completedAiTranscript = currentAiTurnTranscript;
    const practiceBoundaryDetected = practiceTurnBoundary.completeTurn();
    const practiceRequested = practiceBoundaryDetected || window.PracticeObserver.asksForPractice(completedAiTranscript);
    if (practiceRequested) practiceTurnsObserved += 1;   // 階段 1：用來比對模型的回報遵從率
    const endingAction = lessonEndingGuard.completeTurn({
        finalStage: closingStageActive,
        finishFinalTurn: closingStageActive
    });
    sessionDiagnostics.record("ai_turn_completed", {
        provider,
        responseToTurn: activeAiResponseStudentGeneration,
        userTranscriptLength: completedUserTranscript.length,
        aiTranscriptLength: completedAiTranscript.length,
        practiceRequested
    });
    isNewAiTurn = true;
    isNewUserTurn = true;
    aiTurnActive = false;
    dropStaleAudio = false;
    aiTurnTrackingStarted = false;
    activeAiResponseStudentGeneration = null;
    activeAiTurnUserTranscript = "";
    currentAiTurnTranscript = "";
    suppressAudioAfterFarewell = false;
    suppressAudioAfterPractice = false;
    let observedFeedback = null;
    if (completesCurrentStudentTurn) {
        pendingStudentResponseGeneration = null;
        observedFeedback = window.PracticeObserver.analyze({
            userText: completedUserTranscript,
            aiText: completedAiTranscript
        });
        if (observedFeedback) {
            recordPracticeFeedback(observedFeedback.original, observedFeedback.suggestion,
                observedFeedback.kind, observedFeedback.focus);
            enforcePracticeCap(observedFeedback);   // 兩個模型共用的重複上限
        }
    }
    if (endingAction === "continue" && completesCurrentStudentTurn && stagePendingSince !== null &&
        stageTransitionGate.completeAiTurn({ practiceRequested })) {
        sendStageTransition('after-feedback');
    }
    if (endingAction === "finish") scheduleLessonCompletion();
    else if (endingAction === "recover") sendEarlyFarewellRecovery();
    return observedFeedback;
}

// ---------------- 今日課程計畫（計畫驅動架構的階段 2） ----------------
// 課前就把今天要做的每一件事算清楚。目前只用於預覽與診斷，
// 尚未接手上課流程（階段 3 才會改由計畫推進）。
async function buildTodayLessonPlan() {
    const person = currentPerson();
    const selection = person.unit;
    if (!selection || !selection.book) return null;
    await loadUnitsData();
    const unit = findUnit(selection.book, selection.num);
    if (!unit || !UNITS_DATA) return null;

    let day = 1;
    try {
        const progress = JSON.parse(localStorage.getItem(weekProgressKey(
            `${unit.book} Unit ${unit.num}: ${unit.title}`)));
        if (progress && progress.day) day = Number(progress.day) || 1;
    } catch (e) {}
    const daySelect = document.getElementById('daySelect');
    if (daySelect && daySelect.value !== 'auto') day = Number(daySelect.value) || day;

    return window.LessonPlan.build({
        person: currentPersonName(),
        day,
        unit,
        reviewUnits: window.CourseProgression.previousUnits(UNITS_DATA.books, unit, 2),
        learnedWords: loadVocabLog()
    });
}

(function initLessonPlanPreview() {
    const button = document.getElementById('previewPlanBtn');
    const box = document.getElementById('planPreview');
    if (!button || !box) return;
    button.addEventListener('click', async () => {
        setText(box, "計算中…");
        try {
            const plan = await buildTodayLessonPlan();
            if (!plan) { setText(box, "這位學員還沒選定課本單元，無法產生計畫。"); return; }
            const header = `${plan.person}｜${plan.unitLabel}｜第 ${plan.day} 天\n` +
                (plan.reviewUnitLabels.length ? `複習來源：${plan.reviewUnitLabels.join("、")}\n` : "沒有可複習的舊單元\n") +
                `共 ${plan.items.length} 個項目（其中 ${plan.practiceItemCount} 項要實際練習）\n` +
                "──────────\n";
            setText(box, header + window.LessonPlan.describe(plan));
        } catch (error) {
            setText(box, "產生計畫失敗：" + error.message);
        }
    });
})();

// ---------------- 練習結果回報（計畫驅動架構的地基） ----------------
// 階段 1：只收集與觀察，先不改變上課流程。
// 目的是回答兩個問題：模型願不願意每次都回報？回報的內容準不準？
// 之後（階段 3）計畫才會改由這些回報來推進，同一題最多兩次也會變成結構保證。
const ITEM_OUTCOMES = ["correct", "incorrect", "no_response"];
let itemResults = [];              // 本堂課收到的所有回報
let practiceTurnsObserved = 0;     // 前端獨立偵測到的「有邀請學生練習」的回合數

function recordItemResult(args) {
    const a = args || {};
    const target = String(a.target || "").trim().slice(0, 200);
    if (!target) return { status: "ignored: missing target" };
    const outcome = ITEM_OUTCOMES.indexOf(String(a.outcome)) >= 0 ? String(a.outcome) : "incorrect";
    const attemptRaw = Number(a.attempt);
    const entry = {
        at: new Date().toISOString(),
        target,
        outcome,
        studentSaid: String(a.studentSaid || "").trim().slice(0, 300),
        attempt: Number.isFinite(attemptRaw) && attemptRaw >= 1 ? Math.min(9, Math.round(attemptRaw)) : 1,
        kind: String(a.kind || "free").slice(0, 40),
        issue: String(a.issue || "").trim().slice(0, 200),
        stage: teachingFlow[Math.max(0, currentStageIndex - 1)]
            ? teachingFlow[Math.max(0, currentStageIndex - 1)].name : "",
        unit: (LESSON && LESSON.unit) || "",
        mode: currentMode()
    };
    itemResults.push(entry);
    sessionDiagnostics.record("item_result", entry);
    const mark = { correct: "✅", incorrect: "✏️", no_response: "🤐" }[outcome];
    logSystem(`${mark} 練習回報（第 ${entry.attempt} 次）：${target}${entry.issue ? " — " + entry.issue : ""}`);
    return { status: "result recorded" };
}

// 課程結束時比對「模型回報了幾次」與「前端偵測到幾次練習邀請」，
// 這個比值就是階段 1 要驗證的遵從率。
function summariseItemResults(reason) {
    const byOutcome = itemResults.reduce((acc, item) => {
        acc[item.outcome] = (acc[item.outcome] || 0) + 1;
        return acc;
    }, {});
    const retried = itemResults.filter(item => item.attempt >= 2).length;
    const overCap = itemResults.filter(item => item.attempt > 2).length;
    const summary = {
        reason,
        reported: itemResults.length,
        practiceTurnsObserved,
        adherence: practiceTurnsObserved
            ? Math.round((itemResults.length / practiceTurnsObserved) * 100) / 100 : null,
        byOutcome,
        retried,
        overCap,
        distinctTargets: new Set(itemResults.map(item => item.target.toLowerCase())).size
    };
    sessionDiagnostics.record("item_result_summary", summary);
    if (itemResults.length || practiceTurnsObserved) {
        logSystem(`📊 本堂練習回報 ${summary.reported} 筆／偵測到 ${practiceTurnsObserved} 次練習邀請` +
            (summary.adherence !== null ? `（遵從率 ${Math.round(summary.adherence * 100)}%）` : ""));
    }
    return summary;
}

// 同一個句型最多練幾次。超過就換題。
const PRACTICE_CAP = 2;
let practiceFamilyCounts = {};

// 診斷檔顯示：舊機制只在 GPT 端以 updateInstructions 附加一段「請換題」，
// 模型觸發了 8 次仍照樣重複同一句。改為在達到上限時送出導演指令——
// 本專案中模型對導演指令的遵從度明顯高於指令附加；同時兩個模型都適用。
function enforcePracticeCap(feedback) {
    if (!feedback || !feedback.suggestion) return;
    const family = window.PracticeObserver.sentenceFamily(feedback.suggestion);
    if (!family) return;
    const count = (practiceFamilyCounts[family] || 0) + 1;
    practiceFamilyCounts[family] = count;
    if (count < PRACTICE_CAP) return;

    const useOpenAI = openaiSessionActive && openaiRealtime;
    if (!useOpenAI && (!webSocket || webSocket.readyState !== WebSocket.OPEN || userStopped)) return;
    if (closingStageActive || lessonCompletionPending) return;

    const activeStage = teachingFlow[Math.max(0, currentStageIndex - 1)];
    // 刻意不複述那個句子，避免又把它推回模型的注意力焦點
    const noteText = DIRECTOR_PREFIX +
        "That target is now complete — the student has practised it enough for today. " +
        "Move on to a DIFFERENT target from the current stage: another word, another pattern, or a fresh situation, question or role-play. " +
        "Treat close variations (same sentence with a different name, pronoun or single word swapped) as the same target and skip them too. " +
        "Continue naturally in one short teacher turn, ask at most ONE question, then WAIT. Current stage: " +
        (activeStage ? activeStage.prompt : "Continue the current lesson activity.") + "]";

    sessionDiagnostics.record("practice_cap_reached", { family, count, cap: PRACTICE_CAP });
    logSystem(`🔁 同一句型已練 ${count} 次，已要求換題。`);
    pendingDirectorNote = noteText;
    if (useOpenAI) openaiRealtime.sendText(noteText, true);
    else webSocket.send(JSON.stringify({
        clientContent: { turns: [{ role: "user", parts: [{ text: noteText }] }], turnComplete: true }
    }));
}

function sendEarlyFarewellRecovery() {
    if (closingStageActive || lessonCompletionPending) {
        scheduleLessonCompletion();
        return;
    }
    const useOpenAI = openaiSessionActive && openaiRealtime;
    if (!useOpenAI && (!webSocket || webSocket.readyState !== WebSocket.OPEN || userStopped)) return;
    const activeStage = teachingFlow[Math.max(0, currentStageIndex - 1)];
    const stagePrompt = activeStage ? activeStage.prompt : "Continue the current lesson activity.";
    // 全部使用正向敘述。舊版用否定句列出不准講的台詞，等於把那句話直接餵給模型，
    // 反而常被照著講出來——否定式提示的典型反效果。
    // 這裡刻意不重述那句禁語，回歸測試也會掃描整份原始碼確保它不再出現。
    const noteText = DIRECTOR_PREFIX +
        "The lesson is still in progress and there is more to do in the current stage. " +
        "Continue in a fresh teacher turn, as if the conversation had simply flowed onward. " +
        "Open with a short forward-looking bridge such as 「接下來我們換一個小挑戰」, then introduce a DIFFERENT example or activity from the current stage, ask at most ONE short question, and WAIT. " +
        "Stay inside the current activity and keep the tone upbeat; the closing will be signalled separately when the time comes. Current stage: " + stagePrompt + "]";
    sessionDiagnostics.record("early_farewell_recovery_sent", {
        stageIndex: Math.max(0, currentStageIndex - 1),
        stage: activeStage ? activeStage.name : "unknown"
    });
    pendingDirectorNote = noteText;
    if (useOpenAI) openaiRealtime.sendText(noteText, true);
    else webSocket.send(JSON.stringify({
        clientContent: { turns: [{ role: "user", parts: [{ text: noteText }] }], turnComplete: true }
    }));
}

// 等結語真的唸完再斷線。
// 診斷檔顯示：GPT 端 ai_turn_completed 只代表「模型產生完畢」，語音仍在播；
// 舊版因為算不出 WebRTC 的剩餘音訊而落到 350ms 的下限，結語幾乎整段被切掉。
const MAX_CLOSING_WAIT_MS = 25000;   // 安全上限，避免播放結束事件沒來就永遠不下課
let awaitingClosingAudio = false;

function finishLessonAfterClosing(reason) {
    awaitingClosingAudio = false;
    if (lessonFinishTimer) clearTimeout(lessonFinishTimer);
    lessonFinishTimer = null;
    sessionDiagnostics.record("lesson_completion_finished", { reason });
    stopSession("lesson_completed");
}

function scheduleLessonCompletion() {
    if (lessonFinishTimer || awaitingClosingAudio || userStopped) return;
    lessonCompletionPending = true;
    talkBtn.disabled = true;
    nextStageBtn.disabled = true;
    stageIndicator.textContent = "✅ 本堂課完成";

    // GPT：播放狀態只有伺服器知道，等 output_audio_buffer.stopped 才是真的播完
    if (openaiSessionActive && openaiRealtime &&
        typeof openaiRealtime.isSpeaking === 'function' && openaiRealtime.isSpeaking()) {
        awaitingClosingAudio = true;
        sessionDiagnostics.record("lesson_completion_waiting_audio", { maxWaitMs: MAX_CLOSING_WAIT_MS });
        lessonFinishTimer = setTimeout(() => finishLessonAfterClosing("timeout"), MAX_CLOSING_WAIT_MS);
        return;
    }

    // Gemini：音訊由前端排程，剩餘時間算得出來
    const queuedAudioMs = playbackContext
        ? Math.max(0, Math.ceil((nextPlayTime - playbackContext.currentTime) * 1000))
        : 0;
    const delayMs = Math.min(15000, Math.max(1200, queuedAudioMs + 600));
    sessionDiagnostics.record("lesson_completion_scheduled", { delayMs, queuedAudioMs });
    lessonFinishTimer = setTimeout(() => {
        lessonFinishTimer = null;
        stopSession("lesson_completed");
    }, delayMs);
}

// GPT 回報語音播放結束：若正在等結語播完，此刻才真正下課
function handleClosingAudioStopped() {
    if (!awaitingClosingAudio) return;
    finishLessonAfterClosing("audio-stopped");
}

function handleServerMessage(response, socket, socketToken) {
    if (!liveSession.isCurrent(socket, socketToken)) return;
    if (lessonCompletionPending) return;
    // 0) 連線生命週期訊息
    if (response.setupComplete) {
        sessionDiagnostics.record("setup_completed", {
            reconnectAttempts: liveSession.inspectState().reconnectAttempts
        });
        liveSession.markHealthy(socket, socketToken); // 伺服器接受設定，連線真正健康，重連次數才歸零
        markSessionReady('gemini', { reconnect: sessionReady });
        // 重連完成後，重送斷線時遺失的那句話
        if (needsReplay && turnChunks.length > 0) {
            logSystem(`📤 重送剛才的語音（${turnChunks.length} 個片段，約 ${(turnChunks.length * 0.128).toFixed(1)} 秒）...`);
            lastReplayTime = Date.now();
            socket.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
            // 新版 realtimeInput.audio 格式（media_chunks 已被新模型如 Live 3.1 淘汰，一次一塊）
            for (const d of turnChunks) {
                socket.send(JSON.stringify({ realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: d } } }));
            }
            if (!isTalking) {
                // 這句話已講完：補上結束訊號，AI 會立即回應
                socket.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
                lastUserSpeechTime = performance.now();
                waitingFirstAudio = true;
            }
            // 若 isTalking 仍為 true，代表使用者還在講，後續音訊由 worklet 接力即時上傳
            needsReplay = false;
        }
        // 導演指令送出後、AI 還沒回應就斷線 → 指令已遺失，重連後重送（否則新階段永遠沒有開場）
        if (pendingDirectorNote) {
            logSystem("🎬 重連後重送導演指令（上一階段轉場在斷線中遺失）。");
            socket.send(JSON.stringify({
                clientContent: { turns: [{ role: "user", parts: [{ text: pendingDirectorNote }] }], turnComplete: true }
            }));
        }
    }
    if (response.sessionResumptionUpdate) {
        const u = response.sessionResumptionUpdate;
        sessionDiagnostics.record("resumption_updated", {
            resumable: !!u.resumable,
            receivedNewHandle: !!u.newHandle
        });
        if (u.resumable && u.newHandle) resumeHandle = u.newHandle;
    }
    if (response.goAway) {
        sessionDiagnostics.record("server_go_away", { timeLeft: response.goAway.timeLeft || "" });
        logSystem(`⚠️ 伺服器預告即將斷線${response.goAway.timeLeft ? '（剩 ' + response.goAway.timeLeft + '）' : ''}，斷線後將自動重連。`);
    }

    // 1) 工具呼叫：獨立處理，避免圖片等待阻塞同一批字幕或音訊訊息。
    if (response.toolCall && response.toolCall.functionCalls) {
        sessionDiagnostics.record("tool_calls_received", {
            names: response.toolCall.functionCalls.map(call => call.name || "unknown")
        });
        respondToToolCalls(response.toolCall.functionCalls, socket, socketToken).catch(error => {
            sessionDiagnostics.record("tool_processing_failed", { message: error.message });
            logSystem(`⚠️ 工具處理失敗：${error.message}`);
        });
    }

    const sc = response.serverContent;
    if (!sc) return;

    // 2) 使用者插話：立即停止 AI 音訊播放
    if (sc.interrupted) {
        sessionDiagnostics.record("ai_interrupted", { studentWasTalking: !!isTalking });
        stopAllPlayback();
        logSystem("🔇 偵測到插話，已中斷 AI 播放。");
    }

    // 3) 使用者語音逐字稿（伺服器端 STT，取代 webkitSpeechRecognition）
    if (sc.inputTranscription && sc.inputTranscription.text) {
        sessionDiagnostics.transcript("student", sc.inputTranscription.text, {
            turn: studentTurnGeneration
        });
        currentUserTurnTranscript += sc.inputTranscription.text;
        if (activeAiResponseStudentGeneration !== null &&
            activeAiResponseStudentGeneration === pendingStudentResponseGeneration) {
            activeAiTurnUserTranscript = currentUserTurnTranscript;
        }
        if (userSpeechBox) {
            if (isNewUserTurn) {
                userSpeechBox.appendChild(document.createElement('br'));
                userSpeechBox.appendChild(makeElement('b', { text: '[You]', color: '#4daafc' }));
                userSpeechBox.appendChild(document.createElement('br'));
                isNewUserTurn = false;
            }
            appendText(userSpeechBox, sc.inputTranscription.text);
            userSpeechBox.scrollTop = userSpeechBox.scrollHeight;
        }
    }

    let farewellJustDetected = null;
    let practiceJustDetected = null;

    // 4) AI 實際說出的逐字稿（除錯面板累積全程；學生畫面字幕只顯示當前這一輪）
    if (sc.outputTranscription && sc.outputTranscription.text && !dropStaleAudio) {
        if (isNewAiTurn) {
            beginTrackedAiTurn();
            const voiceName = voiceSelect.options[voiceSelect.selectedIndex].text;
            aiSpeechBox.appendChild(document.createElement('br'));
            aiSpeechBox.appendChild(makeElement('b', { text: `[${voiceName}]`, color: '#f39c12' }));
            aiSpeechBox.appendChild(document.createElement('br'));
            isNewAiTurn = false;
            directorLeak = false;
            studentView.beginTranscriptTurn(); // 新的一輪：字幕清空重來
        }
        sessionDiagnostics.transcript("ai", sc.outputTranscription.text, {
            responseToTurn: activeAiResponseStudentGeneration
        });
        currentAiTurnTranscript += sc.outputTranscription.text;
        appendText(aiSpeechBox, sc.outputTranscription.text);   // 除錯面板保留全文，方便你追問題
        aiSpeechBox.scrollTop = aiSpeechBox.scrollHeight;

        // 防護：模型有時會唸出導演筆記，甚至自己捏造一段。
        // 一偵測到就立刻停止播放（孩子不會聽到後半段）並把字幕裁掉（孩子看不到）。
        const transcriptBefore = studentView.transcriptText();
        const transcriptCandidate = transcriptBefore + sc.outputTranscription.text;
        farewellJustDetected = lessonEndingGuard.observe(sc.outputTranscription.text);
        practiceJustDetected = practiceTurnBoundary.observe(sc.outputTranscription.text);
        if (practiceJustDetected.detected) {
            sessionDiagnostics.record("practice_turn_boundary_detected", {
                phrase: practiceJustDetected.phrase,
                responseToTurn: activeAiResponseStudentGeneration
            });
            logSystem("🛑 偵測到複誦邀請；已把說話權交給學生，後續問題不再播放。");
        }
        if (farewellJustDetected.detected) {
            sessionDiagnostics.record("farewell_detected", {
                phrase: farewellJustDetected.phrase,
                finalStage: farewellJustDetected.finalStage,
                stageIndex: Math.max(0, currentStageIndex - 1)
            });
            logSystem(farewellJustDetected.finalStage
                ? "✅ 偵測到正式下課結語；結語後的額外問題將不再播放。"
                : "⚠️ AI 提早說了再見；已阻止後續內容，將拉回目前階段。");
            if (!farewellJustDetected.finalStage) stopAllPlayback();
        }
        if (!directorLeak && DIRECTOR_LEAK_RE.test(transcriptCandidate)) {
            directorLeak = true;
            sessionDiagnostics.record("director_note_leak_detected", {});
            stopAllPlayback();
            const cut = transcriptCandidate.search(DIRECTOR_LEAK_RE);
            if (cut >= 0) studentView.truncateTranscript(Math.min(cut, transcriptBefore.length));
            logSystem("<span style='color:#ff8800;'>⚠️ AI 開始唸出導演筆記，已中斷播放並隱藏字幕。</span>");
        }
        const boundaryAlreadyClosed = suppressAudioAfterFarewell || suppressAudioAfterPractice;
        if (!directorLeak && !boundaryAlreadyClosed) {
            studentView.appendTranscript(sc.outputTranscription.text);
            if (farewellJustDetected.detected) {
                studentView.truncateTranscript(farewellJustDetected.farewellEnd);
            }
            if (practiceJustDetected.detected) {
                studentView.truncateTranscript(practiceJustDetected.invitationEnd);
            }
        }
    }

    // 5) 音訊播放
    if (sc.modelTurn && sc.modelTurn.parts) {
        pendingDirectorNote = null; // AI 已開始回應，導演指令確定送達
        aiTurnActive = true;
        if (!dropStaleAudio && !suppressAudioAfterFarewell && !suppressAudioAfterPractice) {
            beginTrackedAiTurn();
            for (const part of sc.modelTurn.parts) {
                if (part.inlineData && part.inlineData.mimeType.includes('audio/pcm')) {
                    if (waitingFirstAudio && lastUserSpeechTime) {
                        const latencyMs = Math.round(performance.now() - lastUserSpeechTime);
                        sessionDiagnostics.record("first_audio_latency", {
                            milliseconds: latencyMs,
                            turn: studentTurnGeneration
                        });
                        logSystem(`⏱️ 回應延遲約 ${(latencyMs / 1000).toFixed(1)} 秒`);
                        waitingFirstAudio = false;
                        turnChunks = [];    // AI 已開始回應，這句話確定送達，釋放暫存
                        needsReplay = false;
                    }
                    playPcmChunk(base64ToArrayBuffer(part.inlineData.data), 24000);
                }
            }
        }
    }
    // 同一個伺服器事件裡的音訊通常包含剛辨識到的結語，允許它播完；
    // 從下一個事件起才丟棄模型接著生成的問題。
    if (farewellJustDetected && farewellJustDetected.detected) suppressAudioAfterFarewell = true;
    if (practiceJustDetected && practiceJustDetected.detected) suppressAudioAfterPractice = true;

    if (sc.turnComplete) {
        completeTrackedAiTurn("gemini");
    }
}

// ---------------- 生圖顯示 ----------------

function showImage(keyword) {
    logSystem(`<span style="color:#f39c12;">🎨 [toolCall] show_image: ${keyword}</span>`);
    generatedImage.style.display = 'none';
    generatedImage.removeAttribute('src');
    imageCaption.textContent = "🎨 正在繪製：" + keyword + " ...";
    const prompt = "A simple, educational illustration of " + keyword + ", white background";
    const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=400&height=400&nologo=true`;
    return new Promise(resolve => {
        let settled = false;
        const finish = status => {
            if (settled) return;
            settled = true;
            resolve(status);
        };

        studentView.showImage(imageUrl, keyword, {
            onStatus(status, detail) {
                sessionDiagnostics.record("image_status", {
                    keyword,
                    status,
                    requestId: detail && detail.requestId,
                    contentVersion: detail && detail.contentVersion
                });
                if (status === 'loading') {
                    imageCaption.textContent = "🎨 正在繪製：" + keyword + " ...";
                } else if (status === 'retrying') {
                    imageCaption.textContent = "🔁 重試繪製：" + keyword + " ...";
                } else if (status === 'ready') {
                    generatedImage.src = detail.url;
                    generatedImage.style.display = 'block';
                    imageCaption.textContent = "AI 呼叫 show_image：" + keyword;
                    finish('ready');
                } else if (status === 'slow') {
                    imageCaption.textContent = "⏳ 圖片仍在準備：" + keyword;
                    finish('slow');
                } else if (status === 'error') {
                    imageCaption.textContent = "⚠️ 圖片載入失敗：" + keyword;
                    finish('error');
                } else if (status === 'cancelled') {
                    finish('cancelled');
                }
            }
        });
    });
}

// ---------------- 隱藏導演（教學流程狀態機） ----------------

function startLessonTimer() {
    if (lessonTimer) clearInterval(lessonTimer);
    lessonTimer = setInterval(() => {
        const connectionReady = openaiSessionActive || (webSocket && webSocket.readyState === WebSocket.OPEN);
        if (!connectionReady) { clearInterval(lessonTimer); return; }
        if (currentStageIndex < teachingFlow.length) {
            const stage = teachingFlow[currentStageIndex];
            // 時間到：先「掛起」，不打斷當下對話
            if (stagePendingSince === null && elapsedTime >= stage.time) {
                stagePendingSince = elapsedTime;
                sessionDiagnostics.record("stage_ready_to_transition", {
                    stage: stage.name,
                    elapsedSeconds: elapsedTime,
                    stageIndex: currentStageIndex
                });
                if (currentStageIndex === 0) {
                    sendStageTransition('opening'); // 開場沒有前文，直接開始
                } else {
                    stageTransitionGate.request();
                    logSystem(`⌛ ${stage.name} 時間已到；先完成回饋與一次學生練習，再獨立切換。`);
                }
            }
            // 逾時保險：掛起超過 90 秒都沒有對話輪替，強制切換
            if (stagePendingSince !== null && elapsedTime - stagePendingSince >= 90 && !isTalking && !aiTurnActive) {
                sendStageTransition('timeout');
            }
        }
        elapsedTime++;
    }, 1000);
}

// 發送階段轉場指令。trigger:
//   opening  = 課程開場（無前文）
//   after-feedback = 已完成至少兩個學生↔AI回合，以全新的老師回合轉場
//   timeout  = 掛起逾時，強制轉場
//   manual   = 測試用 Next 按鈕
function sendStageTransition(trigger) {
    const useOpenAI = openaiSessionActive && openaiRealtime;
    if (!useOpenAI && (!webSocket || webSocket.readyState !== WebSocket.OPEN)) return;
    if (currentStageIndex >= teachingFlow.length) { logSystem("已是最後一個階段。"); return; }
    const stage = teachingFlow[currentStageIndex];
    const isFinalStage = currentStageIndex === teachingFlow.length - 1;
    closingStageActive = isFinalStage;
    lessonEndingGuard.enterStage(isFinalStage);
    stageIndicator.textContent = `⏳ 目前：${stage.name}`;

    let instruction;
    if (isFinalStage) {
        instruction = "FINAL CLOSING STAGE. Give a concise closing now. Do not ask the student another question, " +
            "do not restart review, and do not continue with another activity. Briefly recap what was learned, " +
            "praise one specific thing the student did well, then end with the exact words 「今天很棒，我們下次見！Goodbye!」. " +
            "After Goodbye, say nothing else. Stage goal: " + stage.prompt;
    } else if (trigger === 'opening') {
        instruction = stage.prompt;
    } else {
        instruction = "Start a NEW, separate teacher turn for the stage change. The student's previous answer has already been fully handled in an earlier turn. " +
            "Do not reply to or revisit the student's previous answer, do not give another correction, and do not ask them to repeat it again. " +
            "CLEARLY announce the shift in simple Traditional Chinese (e.g. 「好～接下來我們要來複習囉！」), then begin the next stage with at most ONE short question and WAIT: " + stage.prompt;
    }

    const label = { opening: '開場', 'after-feedback': '完成練習後切換', timeout: '逾時強制', manual: '手動 Next' }[trigger] || trigger;
    sessionDiagnostics.record("stage_transition_sent", {
        trigger,
        label,
        stage: stage.name,
        stageIndex: currentStageIndex,
        elapsedSeconds: elapsedTime
    });
    logSystem(`🎬 導演指令（${label}）→ ${stage.name}`);
    const noteText = DIRECTOR_PREFIX + instruction + "]";
    if (useOpenAI) {
        openaiRealtime.sendText(noteText, true);
    } else {
        webSocket.send(JSON.stringify({
            clientContent: { turns: [{ role: "user", parts: [{ text: noteText }] }], turnComplete: true }
        }));
    }
    pendingDirectorNote = noteText; // AI 開始回應時清除；若回應前斷線，重連後重送
    currentStageIndex++;
    stagePendingSince = null;
    stageTransitionGate.consume();
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
            mediaDest = playbackContext.createMediaStreamDestination();
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
    return playbackContext.destination;
}

function playPcmChunk(arrayBuffer, sampleRate) {
    if (!playbackContext) return;
    if (playbackContext.state === 'suspended') playbackContext.resume();
    const int16Array = new Int16Array(arrayBuffer);
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) float32Array[i] = int16Array[i] / 32768.0;
    const audioBuffer = playbackContext.createBuffer(1, float32Array.length, sampleRate);
    audioBuffer.getChannelData(0).set(float32Array);

    const source = playbackContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(getOutputNode());

    if (nextPlayTime < playbackContext.currentTime) nextPlayTime = playbackContext.currentTime + 0.05;
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

function stopSession(reason) {
    const endReason = reason || "stopped";
    disarmLessonExitGuard();
    if (connectionWatchdog) clearTimeout(connectionWatchdog);
    connectionWatchdog = null;
    sessionDiagnostics.record("session_stopping", {
        reason: endReason,
        elapsedSeconds: elapsedTime,
        stageIndex: currentStageIndex
    });
    summariseItemResults(endReason);   // 階段 1：把回報遵從率寫進診斷
    const socketToClose = liveSession.stop(); // 先讓所有遲到事件失效，再關閉實體 socket
    webSocket = null;
    if (openaiRealtime) openaiRealtime.close();
    openaiSessionActive = false;
    sessionReady = false;
    closingStageActive = false;
    lessonCompletionPending = false;
    document.body.classList.remove('student-mode'); // 下課回到老師畫面
    refreshStudentReturnButton();
    if (lessonTimer) clearInterval(lessonTimer);
    if (lessonFinishTimer) clearTimeout(lessonFinishTimer);
    lessonFinishTimer = null;
    stopAllPlayback();
    if (socketToClose && (socketToClose.readyState === WebSocket.OPEN || socketToClose.readyState === WebSocket.CONNECTING)) {
        socketToClose.close();
    }
    if (micStream) micStream.getTracks().forEach(t => t.stop());
    if (audioWorkletNode) audioWorkletNode.disconnect();
    if (speakerEl) { speakerEl.pause(); speakerEl.srcObject = null; }
    if (audioContext) audioContext.close();
    if (playbackContext) playbackContext.close();
    micStream = null; audioWorkletNode = null; audioContext = null;
    playbackContext = null; mediaDest = null; speakerEl = null; nextPlayTime = 0;
    statusBadge.textContent = '未連線'; statusBadge.style.background = '#5c4d0c'; statusBadge.style.color = '#ffcc00';
    actionBtn.textContent = '開始連線'; actionBtn.disabled = false;
    isTalking = false;
    stagePendingSince = null;
    stageTransitionGate.consume();
    pendingStudentResponseGeneration = null;
    activeAiResponseStudentGeneration = null;
    aiTurnTrackingStarted = false;
    currentUserTurnTranscript = "";
    activeAiTurnUserTranscript = "";
    currentAiTurnTranscript = "";
    suppressAudioAfterFarewell = false;
    suppressAudioAfterPractice = false;
    lessonEndingGuard.resetSession();
    practiceTurnBoundary.reset();
    talkBtn.disabled = true;
    nextStageBtn.disabled = true;
    talkBtn.classList.remove('talking');
    talkBtn.textContent = '🎙️ 按一下開始說話';
    stageIndicator.textContent = '⏳ 等待連線';
    logSystem("連線已中斷。");
    if (userSpeechBox) setText(userSpeechBox, "等待音訊輸入...");
    sessionDiagnostics.finish(endReason);
    refreshDiagnosticsStatus();
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
