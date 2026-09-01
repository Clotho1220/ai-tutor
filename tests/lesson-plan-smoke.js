(function () {
    "use strict";

    const checks = [];
    function check(name, pass) { checks.push({ name, pass: !!pass }); }

    (async function run() {
        const LP = window.LessonPlan;
        const CP = window.CourseProgression;

        // ---- 句型拆解 ----
        const qa = LP.splitPattern("What's your name? / I'm [Name].");
        check("splits a question from its answer", qa.ask === "What's your name?" && qa.answers.length === 1);
        const multi = LP.splitPattern("Can you [action]? / Yes, I can. / No, I can't.");
        check("keeps every answer variant", multi.answers.length === 2);
        // 句型內部本來就有斜線，不能被當成分隔符
        const inner = LP.splitPattern("Who's she/he? / She's/He's my [family member].");
        check("slashes inside the question are not separators",
            inner.ask === "Who's she/he?" && inner.answers[0] === "She's/He's my [family member].");
        const plain = LP.splitPattern("Subject + be + adjective.");
        check("a plain statement has no answer form", plain.answers.length === 0 && plain.statements.length === 1);

        // ---- 代換填空 ----
        check("fillSlot swaps the placeholder for the word",
            LP.fillSlot("Can you [action]?", { english: "jump (v.)" }) === "Can you jump?");
        check("fillSlot leaves dotted patterns to the model",
            LP.fillSlot("What's this? / It's a...", { english: "desk" }) === "");

        // ---- 分配規則 ----
        check("12 words spread over 5 days give 2-3 per day",
            LP.spreadAcrossDays(Array.from({ length: 12 }, (_, i) => i), 5)
                .every(bucket => bucket.length >= 2 && bucket.length <= 3));
        check("a single pattern is practised every day",
            [1, 2, 3, 4, 5].every(day => LP.rotatePick([{ english: "only" }], day, 2).length === 1));

        // ---- 測試教材：對齊 units.json 的新欄位（slot / image / scenes） ----
        const unit = {
            book: "Book 1", num: 3, title: "Can you sing?", type: "unit",
            patterns: [{
                english: "Can you [action]? / Yes, I can. / No, I can't.",
                chinese: "詢問能力。", slot: "action"
            }],
            words: [
                { english: "sing (v.)", chinese: "唱歌", slot: "action", image: "b1_u03_sing.webp", askType: "what_is_he_doing" },
                { english: "read (v.)", chinese: "閱讀", slot: "action", image: "b1_u03_read.webp", askType: "what_is_he_doing" },
                { english: "swim (v.)", chinese: "游泳", slot: "action", image: "b1_u03_swim.webp", askType: "what_is_he_doing" },
                { english: "draw (v.)", chinese: "畫畫", slot: "action", image: "b1_u03_draw.webp", askType: "what_is_he_doing" },
                { english: "fly (v.)", chinese: "飛", slot: "action", image: "b1_u03_fly.webp", askType: "what_is_he_doing" }
            ],
            scenes: [{ lines: "Can you swim? — Yes, I can.", image: "b1_u03_scene1.webp" }]
        };
        const reviewUnit = {
            book: "Book 1", num: 2, title: "What's this?", type: "unit",
            patterns: [{ english: "What's this? / It's a/an [object].", chinese: "問物品。", slot: "object" }],
            words: [
                { english: "desk (n.)", chinese: "書桌", slot: "object", image: "b1_u02_desk.webp" },
                { english: "book (n.)", chinese: "書本", slot: "object", image: "b1_u02_book.webp" }
            ]
        };
        const learned = [{ word: "jump", meaning: "跳", unit: "Book 1 Unit 2: What's this?" }];

        const day2 = LP.build({ person: "Rex", day: 2, unit, reviewUnits: [reviewUnit], learnedWords: learned });

        // ---- 新模板的結構 ----
        check("every plan opens and closes explicitly",
            day2.items[0].type === "opening" && day2.items[day2.items.length - 1].type === "closing");
        // ---- 每天全部單字、模式跟著天走（2026-09-01 使用者定案，對齊紙本練習卷） ----
        const dayPlans = [1, 2, 3, 4, 5].map(day =>
            LP.build({ person: "Rex", day, unit, reviewUnits: [reviewUnit], learnedWords: [] }));
        const modeOfDay = ["word_zh2en", "word_read", "word_choice", "word_gap", "word_spell"];
        check("each day drills ALL unit words in that day's mode (never split)",
            dayPlans.every((plan, i) =>
                plan.items.filter(item => item.type === modeOfDay[i] &&
                    item.source.indexOf("Unit 3") >= 0).length === unit.words.length));
        check("cross-unit review words follow the same day mode",
            dayPlans[2].items.some(item => item.type === "word_choice" && item.source === "Book 1 Unit 2") ||
            dayPlans[0].items.some(item => item.type === "word_zh2en" && item.source === "Book 1 Unit 2"));
        check("review words from earlier units are read-the-word items on day 2",
            day2.items.some(item => item.type === "word_read" && item.source === "Book 1 Unit 2"));
        const choiceItem = dayPlans[2].items.find(item => item.type === "word_choice");
        check("choice items show three options on screen",
            choiceItem.options.length === 3 && choiceItem.display.indexOf(choiceItem.target) >= 0 &&
            choiceItem.options.indexOf(choiceItem.target) >= 0);
        const gapItem = dayPlans[3].items.find(item => item.type === "word_gap");
        check("gap items mask letters on screen but keep the full answer for the model",
            gapItem.display.indexOf("_") >= 0 && gapItem.missing.length > 0 &&
            gapItem.letters.split("-").join("") === gapItem.target.replace(/[^a-z0-9]/g, ""));
        check("choice directives forbid reading the options aloud",
            LP.itemDirective(choiceItem, { index: 1, total: 9, attempts: 0 }).indexOf("不要把任何選項唸出來") >= 0);
        const day5 = LP.build({ person: "Rex", day: 5, unit, reviewUnits: [reviewUnit], learnedWords: [] });
        const spellItem = day5.items.find(item => item.type === "word_spell");
        check("day 5 asks the student to spell this unit's words",
            !!spellItem && spellItem.letters.indexOf("-") > 0);
        check("spelling starts from memory and only then shows the word",
            spellItem.ladder.length === 3 &&
            !spellItem.ladder[0].reveal.english && spellItem.ladder[0].reveal.image &&
            spellItem.ladder[1].reveal.english);
        check("spelling directives carry the letter-by-letter answer",
            LP.itemDirective(spellItem, { index: 1, total: 9, attempts: 0 })
                .indexOf(spellItem.letters) >= 0);
        check("extension words learned earlier come back for review during the week",
            [1, 2, 3, 4, 5].some(day =>
                LP.build({ person: "Rex", day, unit, reviewUnits: [reviewUnit], learnedWords: learned })
                    .items.some(item => /^word_/.test(item.type) && item.target === "jump")));

        // ---- 句型代換 ----
        const subs = day2.items.filter(item => item.type === "pattern_substitute");
        check("each pattern gets at least three substitutions", subs.length >= 3);
        check("substitutions fill the slot with learned words",
            subs.every(item => item.target && item.target.indexOf("[") < 0));
        check("substituted sentences use slot-compatible words only",
            subs.every(item => ["sing", "read", "swim", "draw", "fly"]
                .some(word => item.target === "Can you " + word + "?")));

        // 複數句型只收複數形的字
        const pluralPattern = { english: "What are these? / They're...", chinese: "問複數。", slot: "food", plural: true };
        const mixedWords = [
            { english: "cake (n.)", chinese: "蛋糕", slot: "food" },
            { english: "pears", chinese: "梨子", slot: "food", plural: true }
        ];
        const pluralPick = LP.pickSlotWords(pluralPattern,
            { unit: { words: mixedWords }, reviewUnits: [] }, 3);
        check("plural patterns only accept plural words",
            pluralPick.length === 1 && pluralPick[0].english === "pears");

        // ---- 對答題 ----
        const responds = day2.items.filter(item => item.type === "pattern_respond");
        check("respond items ask the question and expect the answer",
            responds.length >= 1 && responds[0].ask === "Can you [action]?" &&
            responds[0].target === "Yes, I can." && responds[0].alternatives[0] === "No, I can't.");
        check("respond items carry the scene picture",
            responds[0].image === "b1_u03_scene1.webp");

        // ---- 提示階梯 ----
        const wordItem = dayPlans[0].items.find(item => item.type === "word_zh2en");
        check("zh2en items start with picture+Chinese and only then reveal English",
            wordItem.ladder.length === 4 &&
            wordItem.ladder[0].reveal.image && wordItem.ladder[0].reveal.chinese &&
            !wordItem.ladder[0].reveal.english && wordItem.ladder[1].reveal.english);
        const readItem = day2.items.find(item => item.type === "word_read");
        check("read items start with the bare English word",
            readItem.ladder[0].reveal.english && !readItem.ladder[0].reveal.image &&
            !readItem.ladder[0].reveal.chinese);
        check("read items add the picture as the first hint",
            readItem.ladder[1].reveal.image);
        check("sentence items allow at most two corrections",
            subs[0].ladder.length === 3 && subs[0].maxAttempts === 3);
        check("max attempts equals ladder length",
            day2.items.every(item => !item.ladder || item.maxAttempts === item.ladder.length));

        // revealFor 依嘗試次數揭露，超出階梯就停在最後一階
        check("revealFor follows the ladder step by step",
            !LP.revealFor(wordItem, 0).english && LP.revealFor(wordItem, 1).english &&
            LP.revealFor(wordItem, 99).english);
        check("revealFor hides the picture when the item has none",
            !LP.revealFor(Object.assign({}, wordItem, { image: "" }), 0).image);

        // ---- 導演指令 ----
        const directive0 = LP.itemDirective(wordItem, { index: 1, total: 10, attempts: 0 });
        const directive2 = LP.itemDirective(wordItem, { index: 1, total: 10, attempts: 2 });
        check("a directive names the position and the target",
            directive0.indexOf("Item 2 of 10") >= 0 && directive0.indexOf(wordItem.display) >= 0);
        check("later attempts get the next ladder instruction",
            directive0 !== directive2 && directive2.indexOf("第 3 次") >= 0);
        check("plan directives tell the model not to call show_image",
            directive0.indexOf("show_image") >= 0);
        const subDirective = LP.itemDirective(subs[0], { index: 3, total: 10, attempts: 0 });
        check("substitution directives name the pattern and the swapped word",
            subDirective.indexOf(subs[0].pattern) >= 0 && subDirective.indexOf(subs[0].slotWord) >= 0);

        // ---- Review 單元 ----
        const reviewUnitData = {
            book: "Book 1", num: 4, title: "Review 1", type: "review",
            patterns: unit.patterns, words: unit.words, scenes: unit.scenes
        };
        const reviewPlan = LP.build({ person: "Rex", day: 1, unit: reviewUnitData,
            reviewUnits: [reviewUnit], learnedWords: [] });
        check("review units never stack cross-unit review on top",
            reviewPlan.reviewUnitLabels.length === 0);
        check("review units follow the day's word mode too",
            reviewPlan.items.some(item => item.type === "word_zh2en") &&
            !reviewPlan.items.some(item => item.type === "word_image"));

        // ---- 執行器 ----
        const runner = LP.createRunner(day2);
        check("a runner starts on the opening item", runner.current().type === "opening");
        runner.recordAttempt("unknown");                       // 開場只有一階
        const firstWord = runner.current();
        check("after the opening comes a practice item", !!firstWord.target);
        // 兜底（unknown）直接前進、不爬階梯——爬梯會把答對的孩子當成不會
        const fbRunner = LP.createRunner(day2);
        fbRunner.recordAttempt("unknown");            // 開場
        const fbItem = fbRunner.current();
        const fbResult = fbRunner.recordAttempt("unknown");
        check("an unreported exchange advances without climbing the ladder",
            fbResult.advanced && fbRunner.current() !== fbItem &&
            fbRunner.snapshot().find(item => item.id === fbItem.id).status === "done");

        const stay = runner.recordAttempt("incorrect");
        check("a wrong attempt climbs the ladder instead of advancing",
            !stay.advanced && runner.current() === firstWord && runner.progress().attempts === 1);
        let guard = 10;
        while (runner.current() === firstWord && guard-- > 0) runner.recordAttempt("incorrect");
        check("running out of ladder steps still advances", runner.current() !== firstWord);
        check("an item still wrong after every step is flagged for review",
            runner.snapshot().find(item => item.id === firstWord.id).status === "needs_review");
        const next = runner.current();
        const advanced = runner.recordAttempt("correct");
        check("a correct answer advances immediately",
            advanced.advanced && runner.current() !== next);

        let total = 0;
        const drain = LP.createRunner(day2);
        while (!drain.isFinished() && total < 500) { drain.recordAttempt("unknown"); total += 1; }
        check("the plan always terminates", drain.isFinished());
        check("every item ends with a recorded status",
            drain.snapshot().every(item => item.status !== "pending"));

        // ---- 跨單元複習來源 ----
        const books = [{ name: "Book 1", units: [
            { book: "Book 1", num: 1, type: "unit" },
            { book: "Book 1", num: 2, type: "unit" },
            { book: "Book 1", num: 3, type: "unit" },
            { book: "Book 1", num: 4, type: "review" },
            { book: "Book 1", num: 5, type: "unit" }
        ] }];
        const prev = CP.previousUnits(books, { book: "Book 1", num: 5 }, 2);
        check("previousUnits skips review units",
            prev.length === 2 && prev[0].num === 3 && prev[1].num === 2);

        // ---- 與 app.js / index.html 的整合（原始碼迴歸檢查） ----
        const appSource = await fetch('../app.js?lesson-plan-test=' + Date.now()).then(r => r.text());
        const indexSource = await fetch('../index.html?lesson-plan-test=' + Date.now()).then(r => r.text());
        check("plan module loads before app",
            indexSource.indexOf('src="lesson-plan.js') < indexSource.indexOf('src="app.js'));
        check("settings offer a pre-class plan preview",
            indexSource.indexOf('id="previewPlanBtn"') >= 0 && /buildTodayLessonPlan/.test(appSource));
        check("plan mode is on by default and opt-out",
            /localStorage\.getItem\(PLAN_MODE_KEY\) !== "off"/.test(appSource));
        check("plan mode replaces the timed stage driver",
            /if \(planDriving\(\)\) sendCurrentPlanItem\(\)/.test(appSource));
        check("a reported result advances the plan",
            /advancePlan\(/.test(appSource) && /report_item_result/.test(appSource));
        check("an unreported exchange still advances the plan",
            /planFallbackAfterTurn/.test(appSource));
        check("retries climb the hint ladder with a fresh directive",
            /queuePlanDirective\(\{\s*body: window\.LessonPlan\.itemDirective\(before/.test(appSource));
        // 2026-08-24 實測修正：指令不能在 AI 講話或學生說話時硬送
        check("directives queue while the AI or the student is speaking",
            /if \(deferPlanDirective \|\| aiTurnActive \|\| isTalking\) \{ pendingPlanDirective = payload; return; \}/.test(appSource) &&
            /flushPendingPlanDirective\(\)/.test(appSource));
        check("exchanges that began before the item was sent never count against it",
            /completedGeneration <= planItemSentGeneration/.test(appSource) &&
            /if \(pendingPlanDirective\) return;/.test(appSource));
        check("plan images are preloaded from the local library",
            /new Image\(\)\.src = "images\/" \+ name/.test(appSource));
        check("the frontend drives the student screen from the ladder",
            /studentView\.showCard\(/.test(appSource) && /revealFor/.test(appSource));
        check("finishing the plan ends the lesson",
            /plan_completed/.test(appSource) && /scheduleLessonCompletion\(\)/.test(appSource));
        check("the closing item tells the ending guard this farewell is real",
            /closingStageActive = !!\(payload\.item && payload\.item\.type === "closing"\)/.test(appSource));
        check("the model is told it may only perform one given item",
            /PLAN MODE \(highest priority\)/.test(appSource));
        check("the model is told the screen is system-controlled",
            /do NOT call show_image during plan items/.test(appSource));
        // 2026-08-25 實測修正
        check("the talk button locks while the AI is speaking",
            /lockTalkButtonWhileAiSpeaks/.test(appSource) && /unlockTalkButton\(\)/.test(appSource));
        check("the model is forbidden from adding bonus drills",
            /Never add bonus drills/.test(appSource));
        check("finishing a word item shows the full card as confirmation",
            /\/\^word_\/\.test\(done\.type\)/.test(appSource));
        const openaiSource = await fetch('../openai-realtime.js?lesson-plan-test=' + Date.now()).then(r => r.text());
        check("directives never open a response while one is in progress (GPT)",
            /if \(cancellationPending \|\| responseInProgress\) responseCreatePending = true;/.test(openaiSource));
        // 2026-08-27 實測修正
        check("the closing flag is raised only when the closing directive is delivered",
            /closingStageActive = !!\(payload\.item && payload\.item\.type === "closing"\)/.test(appSource) &&
            !/^\s*closingStageActive = item\.type === "closing";/m.test(appSource));
        check("repetition loops are detected and cut",
            /detectRepetitionLoop/.test(appSource) &&
            /checkAiRepetitionLoop\(\)/.test(appSource) && /ai_repetition_loop/.test(appSource));
        check("loop recovery re-sends the current item at most a few times",
            /repetitionCutCount <= 3/.test(appSource));
        // 2026-08-28 實測修正
        check("substitute items show the swapped word on screen",
            subs[0].display && subs[0].meaning &&
            subs[0].ladder[0].reveal.english && subs[0].ladder[0].reveal.chinese);
        check("plan mode never suppresses audio at practice boundaries",
            /practiceJustDetected\.detected && !planDriving\(\)/.test(appSource));
        check("the fallback waits when the AI just asked for a retry",
            /else if \(!practiceRequested\) planFallbackAfterTurn/.test(appSource));
        check("the GPT talk button unlocks only after audio really stops",
            /provider === 'openai' && openaiRealtime && openaiRealtime\.isSpeaking\(\)/.test(appSource));
        // 2026-08-29 實測修正
        check("a farewell while the closing item is current counts as official",
            /planRunner\.current\(\)\.type === "closing"/.test(appSource) &&
            /farewellJustDetected = Object\.assign/.test(appSource));
        check("a silent GPT channel is reported within 15 seconds",
            /armOpenaiSilenceWatchdog/.test(appSource) && /openai_silence_detected/.test(appSource));
        check("tool results never open a response while one is in progress (GPT)",
            (openaiSource.match(/if \(cancellationPending \|\| responseInProgress\) responseCreatePending = true;/g) || []).length >= 2);
        // 2026-08-30 實測修正
        check("the Chinese meaning stays out of the directive until revealed",
            LP.itemDirective(readItem, { index: 1, total: 9, attempts: 0 }).indexOf(readItem.meaning) < 0 &&
            LP.itemDirective(readItem, { index: 1, total: 9, attempts: 2 }).indexOf(readItem.meaning) >= 0);
        check("early word steps forbid speaking the hidden parts",
            LP.itemDirective(wordItem, { index: 1, total: 9, attempts: 0 }).indexOf("絕對不要說出") >= 0);
        check("tool results are sent before the next directive (GPT)",
            /deferPlanDirective = true;/.test(appSource) &&
            /openaiRealtime\.sendToolResult\(detail\.callId, result, !pendingPlanDirective\)/.test(appSource));
        check("a director-note leak on GPT is muted and hidden",
            /director_note_leak_detected/.test(appSource) && /openaiLeakMuted = true;/.test(appSource));
        // 2026-08-31 實測修正：佔位符目標（It's a/an [object].）收到填好的句子時要認得
        check("placeholder targets accept filled-in reports",
            appSource.indexOf("reportTargetsOverlap(reported, planItemRawCandidates(lastCompletedPlanItem))") >= 0 &&
            /lastCompletedPlanItem = result\.item \|\| before;/.test(appSource));
        check("stale reports for another item never advance the plan",
            /reportMatchesPlanItem/.test(appSource) && /plan_report_ignored/.test(appSource));
        check("report_item_result kinds match the new item types",
            appSource.indexOf('"word_image", "word_read", "word_spell", "word_zh2en", "word_choice", "word_gap", "pattern_substitute", "pattern_respond"') >= 0);
        check("news mode keeps the original flow",
            /時事討論不使用計畫驅動/.test(appSource));

        const passed = checks.every(item => item.pass);
        const result = document.getElementById('result');
        result.textContent = (passed ? 'PASS' : 'FAIL') + '\n' +
            checks.map(item => `${item.pass ? 'OK' : 'NOT OK'} - ${item.name}`).join('\n');
        document.title = (passed ? 'PASS' : 'FAIL') + ' - lesson plan smoke test';
    })();
})();
