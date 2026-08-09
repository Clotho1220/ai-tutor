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
        const imperatives = LP.splitPattern("Touch your [body part]! / Close (Open) your [body part]!");
        check("two imperatives become two separate targets",
            imperatives.answers.length === 0 && imperatives.statements.length === 2);

        // ---- 分配規則 ----
        check("12 words spread over 5 days give 2-3 per day",
            LP.spreadAcrossDays(Array.from({ length: 12 }, (_, i) => i), 5)
                .every(bucket => bucket.length >= 2 && bucket.length <= 3));
        check("a single pattern is practised every day",
            [1, 2, 3, 4, 5].every(day => LP.rotatePick([{ english: "only" }], day, 2).length === 1));
        check("three patterns are all covered across the week",
            new Set([1, 2, 3, 4, 5].flatMap(day =>
                LP.rotatePick(["a", "b", "c"], day, 2))).size === 3);

        // ---- 完整計畫 ----
        const unit = {
            book: "Book 1", num: 5, title: "Who's she?", theme: "family",
            patterns: [{ english: "Who's she/he? / She's/He's my [family member].", chinese: "詢問某位女性或男性是誰。" }],
            words: [{ english: "mother (n.)", chinese: "母親" }, { english: "father (n.)", chinese: "父親" },
                    { english: "brother (n.)", chinese: "兄弟" }, { english: "sister (n.)", chinese: "姊妹" }]
        };
        const reviewUnit = {
            book: "Book 1", num: 3, title: "Can you sing?",
            patterns: [{ english: "Can you [action]? / Yes, I can.", chinese: "詢問能力。" }],
            words: [{ english: "sing (v.)", chinese: "唱歌" }, { english: "read (v.)", chinese: "閱讀" }]
        };
        const learned = [{ word: "swim", meaning: "游泳", unit: "Book 1 Unit 3: Can you sing?" }];

        const day2 = LP.build({ person: "Rex", day: 2, unit, reviewUnits: [reviewUnit], learnedWords: learned });
        check("every plan opens and closes explicitly",
            day2.items[0].type === "opening" && day2.items[day2.items.length - 1].type === "closing");
        check("review items ask in Chinese and expect English",
            day2.items.some(item => item.type === "review_word" && item.promptZh && item.target));
        check("extension words carry seeds and an avoid list",
            day2.items.some(item => item.type === "extension_word" &&
                Array.isArray(item.seeds) && item.avoid.indexOf("swim") >= 0));
        // 複習內容會平均攤到五天，所以要看整週有沒有出現，而不是某一天
        check("extension words learned in an earlier unit come back for review during the week",
            [1, 2, 3, 4, 5].some(day =>
                LP.build({ person: "Rex", day, unit, reviewUnits: [reviewUnit], learnedWords: learned })
                    .items.some(item => item.type === "review_word" && item.target === "swim")));
        check("each of an earlier unit's words is scheduled exactly once across the week",
            [1, 2, 3, 4, 5].reduce((total, day) => total +
                LP.build({ person: "Rex", day, unit, reviewUnits: [reviewUnit], learnedWords: learned })
                    .items.filter(item => item.type === "review_word").length, 0) === 3);
        check("answer drills keep one target sentence and list the rest as alternatives",
            LP.build({ person: "R", day: 1, unit: {
                book: "B", num: 1, title: "t", patterns: [{ english: "Can you swim? / Yes, I can. / No, I can't.", chinese: "詢問" }], words: []
            }, reviewUnits: [], learnedWords: [] }).items
                .some(item => item.type === "pattern_answer" && item.target === "Yes, I can." &&
                    item.alternatives.join() === "No, I can't."));
        check("every practice item caps attempts at two",
            day2.items.filter(item => item.target).every(item => item.maxAttempts === 2));
        check("items start pending", day2.items.every(item => item.status === "pending"));
        check("ids are unique", new Set(day2.items.map(item => item.id)).size === day2.items.length);

        // ---- 每天的單字練習方式 ----
        const drillOf = day => (LP.build({ person: "R", day, unit, reviewUnits: [], learnedWords: [] })
            .items.find(item => item.type === "new_word" || item.type === "unit_review_word") || {}).drill;
        check("days 1-3 practise pronunciation", [1, 2, 3].every(day => drillOf(day) === "pronounce"));
        check("days 4-5 switch to recall and spelling", [4, 5].every(day => drillOf(day) === "recall_and_spell"));
        check("day 5 reviews the whole unit instead of teaching new words",
            LP.build({ person: "R", day: 5, unit, reviewUnits: [], learnedWords: [] })
                .counts.unit_review_word === unit.words.length);

        // ---- 真實資料：所有單元都要能產生乾淨的計畫 ----
        const units = await fetch('../units.json?lesson-plan-test=' + Date.now()).then(r => r.json());
        let brokenTargets = 0, daysMissingPattern = 0;
        units.books.forEach(book => book.units.forEach(bookUnit => {
            for (let day = 1; day <= 5; day++) {
                const plan = LP.build({ person: "R", day, unit: bookUnit, reviewUnits: [], learnedWords: [] });
                plan.items.forEach(item => { if (item.target && /\s\/\s/.test(item.target)) brokenTargets += 1; });
                const hasPattern = plan.items.some(item =>
                    item.type === "pattern_ask" || item.type === "pattern_answer");
                if ((bookUnit.patterns || []).length && !hasPattern) daysMissingPattern += 1;
            }
        }));
        check("no practice target still contains the pattern separator", brokenTargets === 0);
        check("every day of every unit includes pattern practice", daysMissingPattern === 0);

        check("previousUnits returns the two units before the current one",
            CP.previousUnits(units.books, { book: "Book 1", num: 5 }, 2)
                .map(u => u.num).join(",") === "3,2");
        check("the very first unit has nothing to review",
            CP.previousUnits(units.books, { book: "Book 1", num: 1 }, 2).length === 0);

        // ---- 執行器：同一題最多兩次是結構保證 ----
        const runnerPlan = LP.build({ person: "R", day: 2, unit, reviewUnits: [reviewUnit], learnedWords: [] });
        let runner = LP.createRunner(runnerPlan);
        check("a runner starts on the opening item", runner.current().type === "opening");

        runner.recordAttempt("correct");
        const firstPractice = runner.current().id;
        const miss1 = runner.recordAttempt("incorrect");
        check("a wrong first attempt stays on the same item",
            !miss1.advanced && miss1.attempts === 1 && runner.current().id === firstPractice);
        const miss2 = runner.recordAttempt("incorrect");
        check("the second attempt always moves on, whatever the outcome",
            miss2.advanced && miss2.item.attemptsUsed === 2 && runner.current().id !== firstPractice);
        check("an item still wrong after two tries is flagged for review",
            miss2.item.status === "needs_review");

        runner = LP.createRunner(runnerPlan);
        runner.recordAttempt("correct");
        check("a correct answer advances immediately",
            runner.recordAttempt("correct").advanced === true);

        // 模型沒回報時的兜底，一樣受兩次上限約束
        runner = LP.createRunner(runnerPlan);
        runner.recordAttempt("correct");
        runner.recordAttempt("unknown");
        const fallback = runner.recordAttempt("unknown");
        check("unreported turns still advance within the two-attempt cap",
            fallback.advanced && fallback.item.status === "done");

        // 全部答錯也必須跑得完，且沒有任何項目超過兩次
        runner = LP.createRunner(runnerPlan);
        let guard = 0;
        while (!runner.isFinished() && guard < 500) { runner.recordAttempt("incorrect"); guard += 1; }
        const finalSnapshot = runner.snapshot();
        check("the plan always terminates", runner.isFinished() && guard < 500);
        check("no item is ever practised more than twice",
            finalSnapshot.every(item => (item.attemptsUsed || 0) <= 2));
        check("every item ends with a recorded status",
            finalSnapshot.every(item => item.status && item.status !== "pending"));

        const directive = LP.itemDirective(runnerPlan.items[1], { index: 1, total: runnerPlan.items.length });
        check("a directive names the position and the target",
            /Item 2 of/.test(directive) && directive.indexOf(runnerPlan.items[1].target) >= 0);

        const appSource = await fetch('../app.js?lesson-plan-test=' + Date.now()).then(r => r.text());
        const indexSource = await fetch('../index.html?lesson-plan-test=' + Date.now()).then(r => r.text());
        check("plan module loads before app",
            indexSource.indexOf('src="lesson-plan.js') < indexSource.indexOf('src="app.js'));
        check("settings offer a pre-class plan preview",
            /id="previewPlanBtn"/.test(indexSource) && /buildTodayLessonPlan/.test(appSource));
        // ---- 計畫驅動上課（階段 3） ----
        check("plan mode is opt-in and off by default",
            /id="planModeToggle"/.test(indexSource) &&
            /localStorage\.getItem\(PLAN_MODE_KEY\) === "on"/.test(appSource));
        check("plan mode replaces the timed stage driver",
            /if \(planDriving\(\)\) sendCurrentPlanItem\(\);\s*\/\/[^\n]*\n\s*else startLessonTimer\(\)/.test(appSource));
        check("a reported result advances the plan",
            /planItemReported = true;\s*\n\s*advancePlan\(outcome, "report"\)/.test(appSource));
        check("an unreported exchange still advances the plan",
            /planFallbackAfterTurn\(completesCurrentStudentTurn\)/.test(appSource) &&
            /advancePlan\("unknown", "turn-fallback"\)/.test(appSource));
        check("finishing the plan ends the lesson",
            /planRunner\.isFinished\(\)[\s\S]{0,220}scheduleLessonCompletion\(\)/.test(appSource));
        check("the closing item tells the ending guard this farewell is real",
            /closingStageActive = item\.type === "closing"/.test(appSource));
        check("the model is told it may only perform one given item",
            /PLAN MODE \(highest priority\)/.test(appSource) &&
            /never decide on your own that the lesson is over/.test(appSource));
        check("news mode keeps the original flow",
            /if \(currentMode\(\) !== 'lesson'\)[\s\S]{0,140}return null/.test(appSource));

        report();
    })().catch(error => {
        // 沒有這層保護時，任何例外都只會讓畫面停在 RUNNING，看起來像測試沒跑完
        check("test run completed without throwing: " + error.message, false);
        report();
    });

    function report() {
        const passed = checks.length > 0 && checks.every(item => item.pass);
        const result = document.getElementById('result');
        result.className = passed ? 'pass' : 'fail';
        result.textContent = (passed ? 'PASS' : 'FAIL') + '\n' +
            checks.map(item => `${item.pass ? 'OK' : 'NOT OK'} - ${item.name}`).join('\n');
        document.title = passed ? 'PASS - lesson plan smoke test' : 'FAIL - lesson plan smoke test';
    }
})();
