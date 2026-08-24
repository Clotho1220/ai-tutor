(function (global) {
    "use strict";

    // 課前把「今天到底要做哪幾件事」全部算清楚，做成一份明確的項目清單。
    //
    // 這是計畫驅動架構的核心：決定「下一步做什麼」的責任從模型移回程式，
    // 模型只負責把每一個項目演出來。本模組是純函式，不碰 DOM、不呼叫網路。
    //
    // v3.19 起改成「辨識驅動」的教學模板。起因是實際上課發現孩子聽得懂 swim，
    // 但看到 swim 這個字認不出來——舊模板全程用講解與跟讀，從來沒逼她讀字。
    // 現在每一項都是「先讓她產出，答不出來才逐層給提示」：
    //
    //   word_image          看圖說英文       圖 → 加中文 → 加英文 → 跟讀 → 糾正
    //   word_read           看英文字說意思   字 → 加圖 → 加中文 → 跟讀
    //   pattern_substitute  中翻英代換       每個句型至少三種變化
    //   pattern_respond     聽問題答句子     Can you fly? → No, I can't.
    //
    // 提示階梯直接用「第幾次嘗試」表示，所以執行器不用多一個計數器，
    // 前端也可以依 attempts 自動揭露，不需要模型呼叫額外的工具。

    const REVIEW_UNIT_COUNT = 2;      // 跨單元複習取前兩個單元
    const WEEK_DAYS = 5;
    const SUBSTITUTIONS_PER_PATTERN = 3;   // 使用者要求：每個句型至少練三種
    const RESPOND_PER_DAY = 2;             // 每天的「聽問題答句子」項目數

    function text(value) {
        return String(value == null ? "" : value).trim();
    }

    // 「apple (n.)」→「apple」；比對是否重複時用
    function bareWord(value) {
        return text(value).replace(/\([^)]*\)/g, "").trim().toLowerCase();
    }

    // 把一組項目平均分到 n 天。12 個單字分 5 天 → 每天 2~3 個。
    function spreadAcrossDays(list, days) {
        const items = (list || []).filter(Boolean);
        const buckets = Array.from({ length: days }, () => []);
        items.forEach((item, index) => { buckets[index % days].push(item); });
        return buckets;
    }

    // 連續切塊：教新內容時同一批相關的字要待在一起
    function chunkInOrder(list, parts) {
        const items = (list || []).filter(Boolean);
        const per = Math.ceil(items.length / parts) || 1;
        return Array.from({ length: parts }, (_, i) => items.slice(i * per, (i + 1) * per));
    }

    // 句型輪轉挑選。句型是單元的核心，不能像單字那樣切塊之後某幾天完全沒練到：
    // 只有 1 個句型就每天都練；多個句型則輪流，確保五天內每個都被練過。
    function rotatePick(list, day, count) {
        const items = (list || []).filter(Boolean);
        if (!items.length) return [];
        const take = Math.min(count, items.length);
        return Array.from({ length: take }, (_, i) => items[(day - 1 + i) % items.length]);
    }

    // 句型字串拆成「問句」與「答句」。
    //   "What's your name? / I'm [Name]."           → 問 + 1 個答
    //   "Can you [action]? / Yes, I can. / No, I can't." → 問 + 2 個答
    //   "Subject + be + adjective."                 → 只有一個陳述句，沒有問答形式
    function splitPattern(english) {
        // 只以「空白 + 斜線 + 空白」分隔。句型內部本來就會出現斜線
        // （she/he、his/her、He/She's），用裸斜線切會把問句本身切碎。
        const parts = text(english).split(/\s+\/\s+/).map(part => part.trim()).filter(Boolean);
        const first = parts[0] || text(english);
        if (parts.length < 2) return { ask: first, answers: [], statements: [first] };
        // 問答型：第一段是問句，其餘是答句
        if (/[?？]$/.test(first)) return { ask: first, answers: parts.slice(1), statements: [] };
        // 非問答型（例如兩個祈使句）：每一段各自是一個獨立的練習目標
        return { ask: first, answers: [], statements: parts };
    }

    // 把單字填進句型的空格。`Can you [action]?` + jump → `Can you jump?`
    // 第 2 冊的句型用「...」而不是 [空格]，那種就回空字串，交給模型自己組。
    function fillSlot(patternPart, word) {
        const sentence = text(patternPart);
        const value = bareWord(word && word.english);
        if (!sentence || !value) return "";
        if (/\[[^\]]+\]/.test(sentence)) {
            return sentence.replace(/\[[^\]]+\]/g, value);
        }
        return "";
    }

    // ---------------- 提示階梯 ----------------
    // 每一階就是「第幾次嘗試」。答得出來就直接過，答不出來才往下一階。
    // reveal 告訴前端這一階該讓學生看到什麼。

    // 圖庫替每個字標了「這張圖適合問哪種問題」，直接拿來當提問方式
    const ASK_BY_TYPE = {
        what_is_this: "What's this?",
        who_is_this: "Who's he? 或 Who's she?（看圖上是男生還是女生）",
        what_is_he_doing: "What's he doing? 或 What's she doing?",
        how_is_he: "How does he feel? 或直接問 Is he happy?（圖是用對比呈現特徵的）",
        where_is_it: "Where is it?",
        where_is_this: "Where is this?",
        read_it: "圖上有字（時間、數字、星期），問 What does it say?"
    };

    function askQuestionFor(word) {
        return ASK_BY_TYPE[text(word.askType)] || ASK_BY_TYPE.what_is_this;
    }

    // 看圖說英文：圖 → 加中文 → 加英文 → 跟讀 → 糾正一次
    function imageLadder(word) {
        return [
            { reveal: { image: true },
              instruction: "只給圖，用英文問「" + askQuestionFor(word) +
                  "」，然後停下來等學員用英文回答。" },
            { reveal: { image: true, chinese: true },
              instruction: "學員答不出來。把中文意思顯示出來並唸出中文，" +
                  "問他這個東西的英文怎麼說，然後等他回答。" },
            { reveal: { image: true, chinese: true, english: true },
              instruction: "還是答不出來。把英文單字顯示出來，請他自己試著把這個字唸出來，" +
                  "然後等他唸。這一階的重點是讀字，先不要幫他唸。" },
            { reveal: { image: true, chinese: true, english: true },
              instruction: "他讀不出這個字。清楚慢慢地唸一次給他聽，請他跟著唸一次，然後等他唸。" },
            { reveal: { image: true, chinese: true, english: true },
              instruction: "他唸得不夠標準。明確指出是哪個音不對，再示範一次，" +
                  "請他最後再唸一次。這是最後一次糾正，唸完就往下走。" }
        ];
    }

    // 看英文字說意思：字 → 加圖 → 加中文 → 跟讀
    // 這是為了「看得懂聽不懂、看不出意思」設計的反向練習，直接練認字。
    function readLadder() {
        return [
            { reveal: { english: true },
              instruction: "只顯示這個英文單字，不給圖也不給中文。" +
                  "請學員把這個字唸出來，並說出它的中文意思，然後等他回答。" },
            { reveal: { english: true, image: true },
              instruction: "他認不出來。把圖顯示出來當提示，再問他一次這個字怎麼唸、是什麼意思。" },
            { reveal: { english: true, image: true, chinese: true },
              instruction: "還是不行。把中文也顯示出來，請他把英文再唸一次，然後等他唸。" },
            { reveal: { english: true, image: true, chinese: true },
              instruction: "清楚唸一次給他聽，請他跟著唸一次。這是最後一階，唸完就往下走。" }
        ];
    }

    // 拼字：憑記憶拼 → 看著字拼 → AI 示範跟拼
    // 語音轉文字會把逐字母拼讀轉爛（HANDOFF 已知陷阱），所以對錯只能靠
    // 原生音訊模型自己聽，前端不做驗證——與發音判斷同一個信任模式。
    function spellLadder() {
        return [
            { reveal: { image: true, chinese: true },
              instruction: "先請學員說出這個東西的英文，說對後請他憑記憶一個字母一個字母拼出來，" +
                  "然後停下來等他拼。畫面上沒有英文字，這一階練的是記憶。" },
            { reveal: { image: true, chinese: true, english: true },
              instruction: "拼不出來。把英文字顯示出來，請他看著字把字母一個一個唸出來，然後等他唸。" },
            { reveal: { image: true, chinese: true, english: true },
              instruction: "還是不行。你一個字母一個字母慢慢示範拼一次，請他跟著拼一次。" +
                  "這是最後一階，拼完就往下走。" }
        ];
    }

    // 句型代換與對答：原本 + 糾正兩次（使用者要求最多糾正 2 次）
    function sentenceLadder(kind) {
        // 對答題有情境圖就全程顯示——答案是看圖決定的
        const reveal = kind === "respond" ? { image: true } : {};
        const first = kind === "respond"
            ? "扮演提問的人，用英文把這個問題問出來，請學員用英文回答，然後等他回答。"
            : "用中文把整句說出來，請學員試著用英文說出來，然後等他說。";
        return [
            { reveal, instruction: first },
            { reveal,
              instruction: "說得不對。明確指出是哪裡不對（用錯的字、少了什麼、順序不對），" +
                  "示範一次正確的句子，請他再說一次，然後等他說。" },
            { reveal,
              instruction: "還是不對。慢慢地再示範一次完整句子，請他跟著說一次。" +
                  "這是第二次糾正，也是最後一次，說完就往下走。" }
        ];
    }

    function makeItem(item) {
        const ladder = item.ladder || [];
        return Object.assign({
            status: "pending",
            maxAttempts: Math.max(1, ladder.length)
        }, item);
    }

    // ---------------- 各類項目 ----------------

    function imageWordItems(words, idPrefix, sourceLabel) {
        return (words || []).map((word, index) => makeItem({
            id: `${idPrefix}-${index + 1}`,
            type: "word_image",
            target: bareWord(word.english),
            display: text(word.english),
            meaning: text(word.chinese),
            example: text(word.example),
            image: text(word.image),
            askType: text(word.askType),
            source: sourceLabel || "",
            ladder: imageLadder(word)
        }));
    }

    function readWordItems(words, idPrefix, sourceLabel) {
        return (words || []).map((word, index) => makeItem({
            id: `${idPrefix}-${index + 1}`,
            type: "word_read",
            target: bareWord(word.english),
            display: text(word.english),
            meaning: text(word.chinese),
            example: text(word.example),
            image: text(word.image),
            source: sourceLabel || "",
            ladder: readLadder()
        }));
    }

    function spellWordItems(words, idPrefix, sourceLabel) {
        return (words || []).map((word, index) => makeItem({
            id: `${idPrefix}-${index + 1}`,
            type: "word_spell",
            target: bareWord(word.english),
            display: text(word.english),
            meaning: text(word.chinese),
            // 給模型的逐字母參考：t-a-b-l-e（判斷與示範都用得到）
            letters: bareWord(word.english).replace(/[^a-z0-9]/g, "").split("").join("-"),
            image: text(word.image),
            source: sourceLabel || "",
            ladder: spellLadder()
        }));
    }

    // 句型代換：拿學過的字去換句型裡的空格。
    // 使用者的例子：當週句型 Can you sing?，之前學過 jump → 練 Can you jump?
    //
    // 程式只決定「用哪個字、練幾次」，句子與中文提示交給模型組。
    // 原因是中文的量詞跟著名詞變（一張書桌／一顆蘋果），程式自動組會出錯。
    function substituteItems(pattern, words, idPrefix) {
        const parts = splitPattern(pattern.english);
        return (words || []).map((word, index) => makeItem({
            id: `${idPrefix}-${index + 1}`,
            type: "pattern_substitute",
            pattern: text(pattern.english),
            patternNote: text(pattern.chinese),
            slotWord: text(word.english),
            slotMeaning: text(word.chinese),
            // 句型有 [空格] 時程式填得出來，第 2 冊的「...」型就留給模型
            target: fillSlot(parts.ask, word) || fillSlot(parts.statements[0], word),
            ladder: sentenceLadder("substitute")
        }));
    }

    // 聽問題答句子。情境圖的設計原則是「看圖就能決定答案」，
    // 所以有圖的時候答案唯一，判斷得出對錯。
    function respondItems(pattern, scene, idPrefix) {
        const parts = splitPattern(pattern.english);
        if (!parts.answers.length) return [];
        return [makeItem({
            id: idPrefix,
            type: "pattern_respond",
            pattern: text(pattern.english),
            ask: parts.ask,
            target: parts.answers[0],
            alternatives: parts.answers.slice(1),
            image: scene ? text(scene.image) : "",
            sceneLines: scene ? text(scene.lines) : "",
            ladder: sentenceLadder("respond")
        })];
    }

    // ---------------- 組裝今天的計畫 ----------------

    function build(context) {
        const config = context || {};
        const day = Math.min(WEEK_DAYS, Math.max(1, Number(config.day) || 1));
        const unit = config.unit || {};
        const unitWords = unit.words || [];
        const unitPatterns = unit.patterns || [];
        const unitScenes = unit.scenes || [];
        const unitLabel = `${text(unit.book)} Unit ${unit.num}: ${text(unit.title)}`.trim();
        const isReviewUnit = text(unit.type) === "review";
        const isFinalDay = day === WEEK_DAYS;

        const items = [];

        // ---- 開場 ----
        items.push(makeItem({
            id: "opening",
            type: "opening",
            maxAttempts: 1,
            ladder: [{ reveal: {},
                instruction: "先說明目前上到哪個單元、第幾天、之前學過什麼，" +
                    "再用一句話說今天要做什麼，最後問學員準備好了嗎，然後停下來等回答。" +
                    "聽到回應後也不要自己開始教任何單字或句型——下一個指令會告訴你第一個項目是什麼。" }]
        }));

        // ---- 跨單元複習：前兩個單元的字，用「看英文字」的方式複習 ----
        // 那些字上個月已經看圖學過了，現在要練的是認字。
        // Review 單元本身就是前三個單元的彙整，不再疊這一層。
        const reviewUnits = isReviewUnit
            ? []
            : (config.reviewUnits || []).slice(0, REVIEW_UNIT_COUNT);
        const learned = config.learnedWords || [];

        reviewUnits.forEach((reviewUnit, unitIndex) => {
            if (!reviewUnit) return;
            const label = `${text(reviewUnit.book)} Unit ${reviewUnit.num}`;

            // 教材裡的字 + 上那個單元時延伸教到的字，一起排進複習
            const extras = learned
                .filter(record => text(record.unit).indexOf(label) === 0)
                .filter(record => !(reviewUnit.words || [])
                    .some(word => bareWord(word.english) === bareWord(record.word)))
                .map(record => ({ english: record.word, chinese: record.meaning,
                                  example: record.example, image: "" }));
            const pool = (reviewUnit.words || []).concat(extras);
            const todays = spreadAcrossDays(pool, WEEK_DAYS)[day - 1];
            items.push(...readWordItems(todays, `rv${unitIndex + 1}`, label));
        });

        // ---- 本單元的字 ----
        // 整週的遞進：第 1~3 天看圖會說 → 第 4 天看字會唸 → 第 5 天會拼
        // （拼字是使用者 2026-08-24 實測後要求加入的）。
        // Review 單元每天都是複習，字數是正課的三倍，五天平均攤開、只認字。
        if (isReviewUnit) {
            const words = spreadAcrossDays(unitWords, WEEK_DAYS)[day - 1] || [];
            items.push(...readWordItems(words, "uw", unitLabel));
        } else if (day === 4) {
            items.push(...readWordItems(unitWords, "uw", unitLabel));
        } else if (isFinalDay) {
            items.push(...spellWordItems(unitWords, "uw", unitLabel));
        } else {
            const todays = spreadAcrossDays(unitWords, WEEK_DAYS)[day - 1] || [];
            items.push(...imageWordItems(todays, "uw", unitLabel));
        }

        // ---- 句型代換：每個句型至少三種 ----
        // 代換字取自「已經學過的、槽位相符的字」，這是使用者要的重組練習。
        const substitutable = unitPatterns.filter(pattern => text(pattern.slot));
        const todaysPatterns = isFinalDay
            ? substitutable
            : rotatePick(substitutable, day, 1);

        todaysPatterns.forEach((pattern, patternIndex) => {
            const picked = pickSlotWords(pattern, config, isFinalDay ? 2 : SUBSTITUTIONS_PER_PATTERN);
            items.push(...substituteItems(pattern, picked, `sb${patternIndex + 1}`));
        });

        // ---- 聽問題答句子 ----
        const respondPatterns = rotatePick(unitPatterns, day, RESPOND_PER_DAY);
        respondPatterns.forEach((pattern, patternIndex) => {
            const scene = unitScenes[patternIndex % Math.max(1, unitScenes.length)];
            items.push(...respondItems(pattern, unitScenes.length ? scene : null,
                `rp${patternIndex + 1}`));
        });

        // ---- 結尾 ----
        items.push(makeItem({
            id: "closing",
            type: "closing",
            maxAttempts: 1,
            ladder: [{ reveal: {},
                instruction: "用簡單的話回顧今天練了什麼、稱讚一件具體做得好的事，然後道別。" }]
        }));

        const counts = items.reduce((acc, item) => {
            acc[item.type] = (acc[item.type] || 0) + 1;
            return acc;
        }, {});

        return {
            version: 2,
            person: text(config.person),
            day,
            unitLabel,
            reviewUnitLabels: reviewUnits.filter(Boolean)
                .map(reviewUnit => `${text(reviewUnit.book)} Unit ${reviewUnit.num}`),
            items,
            counts,
            practiceItemCount: items.filter(item => item.target).length
        };
    }

    // 挑代換字：優先用最近學過的（印象還在、能接上），不足才往前找。
    // 一定會包含本單元自己的字，因為課本就是拿那些字在練這個句型。
    function pickSlotWords(pattern, config, count) {
        const slot = text(pattern.slot);
        const unit = config.unit || {};
        const plural = !!(pattern.plural);
        const seen = new Set();
        const fits = word => {
            const key = bareWord(word.english);
            if (!key || seen.has(key)) return false;
            if (text(word.slot) !== slot) return false;
            // 複數句型（What are these?）只收複數形的字，反之亦然，
            // 否則會組出 They're cake 這種錯句
            if (!!word.plural !== plural) return false;
            seen.add(key);
            return true;
        };
        // 本單元的字排前面，接著是離現在最近的複習單元
        const pools = [unit.words || []].concat(
            (config.reviewUnits || []).map(reviewUnit => (reviewUnit && reviewUnit.words) || []));
        const picked = [];
        pools.forEach(pool => {
            (pool || []).forEach(word => {
                if (picked.length < count && fits(word)) picked.push(word);
            });
        });
        return picked;
    }

    // 給課前預覽用的純文字摘要
    function describe(plan) {
        if (!plan || !plan.items) return "";
        const label = {
            opening: "開場", closing: "結尾",
            word_image: "看圖說英文", word_read: "看字說意思", word_spell: "拼單字",
            pattern_substitute: "句型代換", pattern_respond: "聽問題答句"
        };
        return plan.items.map((item, index) => {
            const name = label[item.type] || item.type;
            let detail = "";
            if (item.type === "word_image" || item.type === "word_read" || item.type === "word_spell") {
                detail = `${item.display}（${item.meaning}）` +
                    (item.image ? "" : "　⚠️ 沒有圖");
            } else if (item.type === "pattern_substitute") {
                detail = `${item.pattern} ← ${item.slotWord}` +
                    (item.target ? `　→「${item.target}」` : "　（句子由模型組）");
            } else if (item.type === "pattern_respond") {
                const alts = (item.alternatives || []).length
                    ? "／或 " + item.alternatives.join("／") : "";
                detail = `${item.ask} → ${item.target}${alts}`;
            }
            return `${index + 1}. [${name}] ${detail}`.trim();
        }).join("\n");
    }

    // ---------------- 執行器：依計畫逐項推進 ----------------
    // 提示階梯的每一階就是一次嘗試，所以「最多練幾次」與「提示到第幾層」
    // 是同一個計數器。走完最後一階就一定往下一項走，不會卡住。
    function createRunner(plan) {
        const items = ((plan && plan.items) || []).map(item => Object.assign({}, item));
        let cursor = 0;
        let attempts = 0;

        function current() {
            return cursor < items.length ? items[cursor] : null;
        }

        function isFinished() {
            return cursor >= items.length;
        }

        function advance(status) {
            const item = items[cursor];
            if (item) {
                item.status = status;
                item.attemptsUsed = attempts;
            }
            cursor += 1;
            attempts = 0;
            return item;
        }

        // outcome：correct / incorrect / no_response / unknown
        // unknown 用於「模型沒回報，但前端確定發生過一次師生問答」的兜底情境。
        function recordAttempt(outcome) {
            const item = current();
            if (!item) return { advanced: false, finished: true };
            if (outcome === "unknown") {
                // 兜底一律直接前進，不碰提示階梯。實測（2026-08-24 診斷檔）模型的
                // 回報遵從率很低，若把沒回報的問答當「答不出來」去爬梯，
                // 階梯指示都是「他不會，給提示再問一次」——孩子明明答對了
                // 還被重複問同一個字，整堂課變成鬼打牆。
                return { advanced: true, item: advance("done"), next: current(), finished: isFinished() };
            }
            attempts += 1;
            const limit = Math.max(1, Number(item.maxAttempts) || 1);
            if (outcome === "correct") {
                return { advanced: true, item: advance("correct"), next: current(), finished: isFinished() };
            }
            if (attempts >= limit) {
                // 提示階梯走完仍不理想：標記起來供日後複習，但一定要往前走
                const status = outcome === "no_response" ? "no_response"
                    : (outcome === "unknown" ? "done" : "needs_review");
                return { advanced: true, item: advance(status), next: current(), finished: isFinished() };
            }
            return { advanced: false, item, attempts, retry: true, finished: false };
        }

        function skipCurrent(reason) {
            if (isFinished()) return null;
            const item = advance(reason || "skipped");
            return item;
        }

        function progress() {
            return { index: Math.min(cursor, items.length), total: items.length, attempts };
        }

        function snapshot() {
            return items.map(item => ({
                id: item.id, type: item.type, target: item.target || "",
                status: item.status, attemptsUsed: item.attemptsUsed || 0
            }));
        }

        return Object.freeze({ current, isFinished, recordAttempt, skipCurrent, progress, snapshot });
    }

    // 目前這一階要讓學生看到什麼。前端依這個決定圖片、英文、中文的顯示。
    function revealFor(item, attempts) {
        const ladder = (item && item.ladder) || [];
        const step = ladder[Math.min(Math.max(0, Number(attempts) || 0), ladder.length - 1)];
        const reveal = (step && step.reveal) || {};
        return {
            image: !!reveal.image && !!text(item && item.image),
            english: !!reveal.english,
            chinese: !!reveal.chinese,
            word: text(item && item.display) || text(item && item.target),
            meaning: text(item && item.meaning),
            picture: text(item && item.image)
        };
    }

    // 把一個項目的「這一階」轉成給模型的具體指示（導演指令的內容）
    function itemDirective(item, progressInfo) {
        if (!item) return "";
        const attempts = (progressInfo && Number(progressInfo.attempts)) || 0;
        const ladder = item.ladder || [];
        const step = ladder[Math.min(attempts, Math.max(0, ladder.length - 1))] || {};
        const position = progressInfo
            ? `Item ${progressInfo.index + 1} of ${progressInfo.total}` +
              (attempts ? `（同一項第 ${attempts + 1} 次）` : "") + "。 "
            : "";

        const bits = [position, text(step.instruction)];
        if (item.type === "word_spell") {
            bits.push(` 目標單字：「${item.display || item.target}」`,
                item.meaning ? `，中文是「${item.meaning}」` : "",
                `。正確拼法是「${item.letters}」，判斷與示範都以此為準。`);
            bits.push(" 圖片與文字由前端控制顯示，你不用呼叫 show_image。");
        } else if (item.type === "word_image" || item.type === "word_read") {
            bits.push(` 目標單字：「${item.display || item.target}」`,
                item.meaning ? `，中文是「${item.meaning}」` : "", "。");
            if (item.example) bits.push(` 例句：${item.example}。`);
            bits.push(" 圖片與文字由前端控制顯示，你不用呼叫 show_image。");
        } else if (item.type === "pattern_substitute") {
            bits.push(` 句型：「${item.pattern}」。這一次要代換進去的字是「${item.slotWord}」` +
                (item.slotMeaning ? `（${item.slotMeaning}）` : "") + "。");
            bits.push(item.target
                ? ` 學員要說出來的目標句是「${item.target}」，你要說的中文提示就是這句的意思。`
                : " 請你自己把這個字套進句型組成完整的句子，再把那句的中文說給學員聽。");
        } else if (item.type === "pattern_respond") {
            bits.push(` 你要問的問題：「${item.ask}」。學員應該回答「${item.target}」`);
            bits.push((item.alternatives || []).length
                ? `，「${item.alternatives.join("」或「")}」也可以接受。` : "。");
            if (item.sceneLines) {
                bits.push(` 畫面上會顯示這個情境的圖（${item.sceneLines}），` +
                    "答案看圖就能決定，所以請依圖上的情況判斷他答得對不對。");
            }
        }
        return bits.join("");
    }

    global.LessonPlan = Object.freeze({
        build, describe, splitPattern, spreadAcrossDays, chunkInOrder, rotatePick,
        fillSlot, pickSlotWords, createRunner, itemDirective, revealFor
    });
})(window);
