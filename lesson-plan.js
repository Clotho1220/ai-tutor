(function (global) {
    "use strict";

    // 課前把「今天到底要做哪幾件事」全部算清楚，做成一份明確的項目清單。
    //
    // 這是計畫驅動架構的核心：決定「下一步做什麼」的責任從模型移回程式，
    // 模型只負責把每一個項目演出來（示範→提問→聽答→判斷→糾正→再練一次）。
    // 本模組是純函式，不碰 DOM、不呼叫網路，方便測試與課前預覽。

    const DEFAULT_MAX_ATTEMPTS = 2;   // 同一個項目最多練兩次（第二次不論對錯都往下走）
    const REVIEW_UNIT_COUNT = 2;      // 複習前兩個單元
    const TEACH_DAYS = 4;             // 前 4 天教新內容，第 5 天總複習
    const WEEK_DAYS = 5;

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

    function makeItem(item) {
        return Object.assign({ maxAttempts: DEFAULT_MAX_ATTEMPTS, status: "pending" }, item);
    }

    // 單字複習項目：AI 說中文，學員用英文回答
    function reviewWordItems(words, sourceLabel, idPrefix) {
        return (words || []).map((word, index) => makeItem({
            id: `${idPrefix}-${index + 1}`,
            type: "review_word",
            promptZh: text(word.chinese) || text(word.english),
            target: text(word.english),
            source: sourceLabel,
            instruction: "說出這個字的中文，請學員用英文回答。答錯就示範正確唸法，再讓他說一次。"
        }));
    }

    // 句型複習項目：AI 說中文，學員用英文說出來
    function reviewPatternItems(patterns, sourceLabel, idPrefix) {
        return (patterns || []).map((pattern, index) => makeItem({
            id: `${idPrefix}-${index + 1}`,
            type: "review_pattern",
            promptZh: text(pattern.chinese) || text(pattern.english),
            target: splitPattern(pattern.english).ask,
            source: sourceLabel,
            instruction: "用中文說出這個意思，請學員用英文說出整句。有錯就明確指出哪裡不對、示範正確句子，再讓他說一次。"
        }));
    }

    // 今天要教的新單字。第 1~3 天帶著唸，第 4~5 天讓學員自己唸出來再拼字。
    function newWordItems(words, day, idPrefix, type) {
        const drill = day <= 3 ? "pronounce" : "recall_and_spell";
        return (words || []).map((word, index) => makeItem({
            id: `${idPrefix}-${index + 1}`,
            type: type || "new_word",
            target: text(word.english),
            meaning: text(word.chinese),
            example: text(word.example),
            drill,
            instruction: drill === "pronounce"
                ? "先示範唸法並讓學員跟著唸，帶完今天所有新單字後再回頭抽問一次（例如問這個字是什麼意思、或這個中文的英文怎麼唸）。"
                : "讓學員自己用英文唸出這個字，唸完後再請他把這個字拼出來。忘記就示範一次，再讓他練習一次。"
        }));
    }

    // 句型練習：先問「這句英文怎麼說」，再問「別人這樣問你，你要怎麼回答」
    function patternDrillItems(patterns, idPrefix) {
        const items = [];
        (patterns || []).forEach((pattern, index) => {
            const parts = splitPattern(pattern.english);
            const meaning = text(pattern.chinese) || text(pattern.english);
            // 非問答型（例如兩個祈使句）：每一段各自練一次，不要把整串當成一個目標
            if (!parts.answers.length && parts.statements.length > 1) {
                parts.statements.forEach((statement, subIndex) => {
                    items.push(makeItem({
                        id: `${idPrefix}-${index + 1}s${subIndex + 1}`,
                        type: "pattern_ask",
                        promptZh: meaning,
                        target: statement,
                        instruction: "問學員這個意思的英文怎麼說，請他試著說說看。說錯就指出問題、示範正確句子，再讓他說一次。"
                    }));
                });
                return;
            }
            items.push(makeItem({
                id: `${idPrefix}-${index + 1}a`,
                type: "pattern_ask",
                promptZh: meaning,
                target: parts.ask,
                instruction: "問學員這個意思的英文怎麼說，請他試著說說看。說錯就指出問題、示範正確句子，再讓他說一次。"
            }));
            if (parts.answers.length) {
                // target 保持單一句子，其餘放 alternatives。
                // 階段 3 要拿 target 去比對學生說了什麼，串成一長串會沒辦法比對。
                items.push(makeItem({
                    id: `${idPrefix}-${index + 1}b`,
                    type: "pattern_answer",
                    promptZh: `別人問你「${meaning}」的時候，你要怎麼回答？`,
                    target: parts.answers[0],
                    alternatives: parts.answers.slice(1),
                    instruction: "扮演提問的人，用英文問學員這個問題，請他用英文回答。" +
                        (parts.answers.length > 1 ? "肯定與否定的答法都可以接受。" : "") +
                        "答錯就示範正確答句，再讓他練習一次。"
                }));
            }
        });
        return items;
    }

    function build(context) {
        const config = context || {};
        const day = Math.min(WEEK_DAYS, Math.max(1, Number(config.day) || 1));
        const unit = config.unit || {};
        const unitWords = unit.words || [];
        const unitPatterns = unit.patterns || [];
        const unitLabel = `${text(unit.book)} Unit ${unit.num}: ${text(unit.title)}`.trim();
        const learned = config.learnedWords || [];
        const isFinalDay = day === WEEK_DAYS;

        const items = [];

        // ---- 開場：報告進度與今天的目標，然後確認學員準備好了 ----
        items.push(makeItem({
            id: "opening",
            type: "opening",
            maxAttempts: 1,
            instruction: "先說明目前上到哪個單元、第幾天、之前學過什麼，再用一句話說今天要做什麼，" +
                "最後問學員準備好了嗎，然後停下來等回答。"
        }));

        // ---- 複習：前兩個單元的單字與句型，分五天平均攤開 ----
        const reviewUnits = (config.reviewUnits || []).slice(0, REVIEW_UNIT_COUNT);
        reviewUnits.forEach((reviewUnit, unitIndex) => {
            if (!reviewUnit) return;
            const label = `${text(reviewUnit.book)} Unit ${reviewUnit.num}`;
            const tag = `rv${unitIndex + 1}`;

            // 教材裡的單字 + 上那個單元時延伸教到的字，一起排進複習
            const extras = learned
                .filter(record => text(record.unit).indexOf(label) === 0)
                .filter(record => !(reviewUnit.words || [])
                    .some(word => bareWord(word.english) === bareWord(record.word)))
                .map(record => ({ english: record.word, chinese: record.meaning, example: record.example }));
            const pool = (reviewUnit.words || []).concat(extras);
            const todaysWords = spreadAcrossDays(pool, WEEK_DAYS)[day - 1];
            items.push(...reviewWordItems(todaysWords, label, `${tag}-w`));

            // 句型輪流複習，確保每天都碰得到一個
            const patterns = reviewUnit.patterns || [];
            if (patterns.length) {
                const picked = [patterns[(day - 1) % patterns.length]];
                items.push(...reviewPatternItems(picked, label, `${tag}-p`));
            }
        });

        // ---- 今天的新內容 ----
        if (isFinalDay) {
            // 第 5 天：整個單元總複習，單字改成自己唸並拼字
            items.push(...newWordItems(unitWords, day, "rev-all", "unit_review_word"));
            items.push(...patternDrillItems(unitPatterns, "pt"));
        } else {
            const todaysNewWords = chunkInOrder(unitWords, TEACH_DAYS)[day - 1] || [];
            items.push(...newWordItems(todaysNewWords, day, "nw"));
            items.push(...patternDrillItems(rotatePick(unitPatterns, day, 2), "pt"));
        }

        // ---- 延伸單字：每天一個，同類但沒學過的 ----
        // 需要詞彙知識才選得出來，因此保留給模型決定，程式只負責給種子與排除清單。
        const seeds = (isFinalDay ? unitWords : (chunkInOrder(unitWords, TEACH_DAYS)[day - 1] || []))
            .map(word => text(word.english)).filter(Boolean);
        items.push(makeItem({
            id: "ext-1",
            type: "extension_word",
            seeds,
            avoid: learned.map(record => text(record.word)).filter(Boolean),
            instruction: "從今天單字的同類別中挑一個新的字來延伸教學，只教一個。" +
                "不可以選學員已經學過的字（避開清單已提供）。教完後記得記錄這個單字。"
        }));

        // ---- 結尾 ----
        items.push(makeItem({
            id: "closing",
            type: "closing",
            maxAttempts: 1,
            instruction: "用簡單的話回顧今天練了什麼、稱讚一件具體做得好的事，然後道別。"
        }));

        const counts = items.reduce((acc, item) => {
            acc[item.type] = (acc[item.type] || 0) + 1;
            return acc;
        }, {});

        return {
            version: 1,
            person: text(config.person),
            day,
            unitLabel,
            reviewUnitLabels: reviewUnits.filter(Boolean)
                .map(reviewUnit => `${text(reviewUnit.book)} Unit ${reviewUnit.num}`),
            items,
            counts,
            practiceItemCount: items.filter(item => item.target || item.type === "extension_word").length
        };
    }

    // 給課前預覽用的純文字摘要
    function describe(plan) {
        if (!plan || !plan.items) return "";
        const label = {
            opening: "開場", review_word: "複習單字", review_pattern: "複習句型",
            new_word: "新單字", unit_review_word: "單元複習單字", extension_word: "延伸單字",
            pattern_ask: "句型（問）", pattern_answer: "句型（答）", closing: "結尾"
        };
        return plan.items.map((item, index) => {
            const name = label[item.type] || item.type;
            const alts = (item.alternatives || []).length ? "／或 " + item.alternatives.join("／") : "";
            const detail = item.target ? `${item.target}${alts}${item.promptZh ? "（" + item.promptZh + "）" : ""}`
                : (item.type === "extension_word" ? `依 ${(item.seeds || []).join("、") || "今日單字"} 延伸一個新字` : "");
            return `${index + 1}. [${name}] ${detail}`.trim();
        }).join("\n");
    }

    // ---------------- 執行器：依計畫逐項推進 ----------------
    // 「同一題最多兩次」在這裡是結構保證，而不是提示詞的請求：
    // 第二次嘗試結束後，不論對錯都一定往下一項走。
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
            attempts += 1;
            const limit = Math.max(1, Number(item.maxAttempts) || 1);
            const success = outcome === "correct";
            if (success) {
                return { advanced: true, item: advance("correct"), next: current(), finished: isFinished() };
            }
            if (attempts >= limit) {
                // 練了上限次數仍不理想：標記起來供日後複習，但一定要往前走
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

    // 把一個項目轉成給模型的具體指示（導演指令的內容）
    function itemDirective(item, progressInfo) {
        if (!item) return "";
        const position = progressInfo
            ? `Item ${progressInfo.index + 1} of ${progressInfo.total}. ` : "";
        const target = item.target ? ` 目標句／單字：「${item.target}」。` : "";
        const alternatives = (item.alternatives || []).length
            ? ` 也可以接受：${item.alternatives.join("、")}。` : "";
        const prompt = item.promptZh ? ` 要給學員的中文提示：「${item.promptZh}」。` : "";
        const meaning = item.meaning ? ` 中文意思：${item.meaning}。` : "";
        const example = item.example ? ` 例句：${item.example}。` : "";
        const seeds = (item.seeds || []).length ? ` 今天的單字：${item.seeds.join("、")}。` : "";
        const avoid = (item.avoid || []).length
            ? ` 已經學過、不可以再選的字：${item.avoid.slice(0, 60).join("、")}。` : "";
        return position + item.instruction + target + alternatives + prompt + meaning + example + seeds + avoid;
    }

    global.LessonPlan = Object.freeze({
        build, describe, splitPattern, spreadAcrossDays, chunkInOrder, rotatePick,
        createRunner, itemDirective
    });
})(window);
