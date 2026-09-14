// 提示詞組裝器與提示詞帳本的測試：兒童計畫課不能含舊規則；帳本要能回答「這堂用哪份、何時被改」。
(function () {
    "use strict";
    const checks = [];
    function check(name, pass) { checks.push({ name, pass: !!pass }); }

    (async function run() {
        const PB = window.PromptBuilder;
        const PL = window.PromptLedger;
        const policy = "Speak roughly half Chinese, half English.";
        const child = { name: "Rex", level: 3, adult: false, interests: ["dinosaurs"] };

        const plan = PB.build({ mode: "lesson", planDriving: true, student: child, level: 3, unit: "Book 1 Unit 3", languagePolicy: policy, pastSection: " PAST LESSONS — words already learned: cat." });
        check("a child with a plan gets the child-plan mode", plan.mode === "child-plan");
        check("child-plan carries the plan contract", /PLAN MODE \(highest priority\)/.test(plan.text) && /do NOT call show_image during plan items/.test(plan.text));
        check("child-plan forbids chit-chat but requires speaking the item",
            /Do NOT add chit-chat questions after the feedback/.test(plan.text) && /you MUST speak it out loud/.test(plan.text) && /Never add bonus drills/.test(plan.text));
        check("child-plan contains none of the legacy competing rules",
            PB.LEGACY_ONLY_PHRASES.every(phrase => plan.text.indexOf(phrase) < 0));
        check("child-plan has no sentence-family cap or turn contract", !/TURN CONTRACT/.test(plan.text) && !/TWICE in a session/.test(plan.text));
        check("child-plan tells the model to trust the STATE line and echo attemptId", /STATE line/.test(plan.text) && /attemptId/.test(plan.text));
        check("child-plan judging is lenient about -ing endings", /'play in' for 'playing'/.test(plan.text) && /Report incorrect only when/.test(plan.text));
        check("child-plan keeps clarification handling", /CLARIFICATION \/ HELP/.test(plan.text) && /What did you say\?/.test(plan.text));
        check("child-plan keeps the past-lessons section", plan.text.indexOf("PAST LESSONS") >= 0);
        check("child-plan tools are only the report", PB.toolsFor("child-plan").join(",") === "report_item_result");

        const flow = PB.build({ mode: "lesson", planDriving: false, student: child, level: 3, unit: "U", languagePolicy: policy });
        check("without a plan the child gets the legacy flow rules", flow.mode === "child-flow" && /MANDATORY FEEDBACK LOOP/.test(flow.text) && /PRACTICE VARIETY/.test(flow.text) && /TURN CONTRACT/.test(flow.text));
        const adult = PB.build({ mode: "lesson", planDriving: true, student: { name: "Clotho", adult: true, level: 4 }, level: 4, unit: "U", languagePolicy: policy });
        check("adults keep natural follow-up questions", adult.mode === "adult" && /Ask ONE substantive, open-ended question/.test(adult.text) && /follow-up that makes them elaborate/.test(adult.text));
        check("adult mode never gets the child plan contract", !/PLAN MODE/.test(adult.text));
        const news = PB.build({ mode: "news", planDriving: false, student: child, level: 3, languagePolicy: policy, pastSection: "PAST" });
        check("news mode keeps child safety rules and drops past lessons", news.mode === "news" && /NEWS SAFETY/.test(news.text) && news.text.indexOf("PAST") < 0);
        check("news tools include topics and images", PB.toolsFor("news").indexOf("show_topics") >= 0 && PB.toolsFor("news").indexOf("show_image") >= 0);
        check("every build carries a prompt version", plan.promptVersion === PB.PROMPT_VERSION && /^P\d/.test(plan.promptVersion));

        // ---- 帳本 ----
        let clock = 1000;
        const ledger = PL.create({ nowFn: () => clock, maxEntries: 5 });
        ledger.begin({ sessionId: "s1", provider: "openai", mode: "child-plan", promptVersion: plan.promptVersion, appVersion: "v3.50" });
        const a = ledger.capture({ kind: "system", text: plan.text, reason: "session.update on connect", connectionEpoch: 1 });
        clock += 10;
        const b = ledger.capture({ kind: "system", text: plan.text, reason: "reconnect", connectionEpoch: 2 });
        const c = ledger.capture({ kind: "update", text: plan.text + " EXTRA", reason: "family cap", connectionEpoch: 2 });
        check("identical prompts share one hash and are stored once", a.hash === b.hash && !b.firstSeen && ledger.inspect().distinctTexts === 2);
        check("a changed prompt gets a new hash", c.hash !== a.hash && c.firstSeen);
        check("entries keep who/when/why and the epoch", b.reason === "reconnect" && b.connectionEpoch === 2 && b.at === new Date(1010).toISOString());
        check("the export carries texts by hash", ledger.exportPayload().texts[a.hash] === plan.text);
        check("the readable view lists the timeline and the texts once", ledger.render().indexOf("== 時間軸") >= 0 && (ledger.render().match(/--- #/g) || []).length === 2);
        for (let i = 0; i < 10; i++) ledger.capture({ kind: "directive", text: "d" + i });
        check("the ledger is bounded", ledger.list().length === 5);
        check("hashing is stable", PL.hashText("abc") === PL.hashText("abc") && PL.hashText("abc") !== PL.hashText("abd"));

        // ---- 與 app.js 的整合 ----
        const appSource = await fetch('../app.js?prompt-builder-test=' + Date.now()).then(r => r.text());
        const indexSource = await fetch('../index.html?prompt-builder-test=' + Date.now()).then(r => r.text());
        const openaiSource = await fetch('../openai-realtime.js?prompt-builder-test=' + Date.now()).then(r => r.text());
        check("prompt modules load before app",
            indexSource.indexOf('src="prompt-builder.js') < indexSource.indexOf('src="app.js') &&
            indexSource.indexOf('src="prompt-ledger.js') < indexSource.indexOf('src="app.js'));
        check("app builds every system instruction through PromptBuilder", /PromptBuilder\.build\(/.test(appSource) && !/const TURN_CONTRACT\s*=/.test(appSource));
        check("tools are filtered per mode from one shared declaration", /PromptBuilder\.toolsFor\(/.test(appSource) && (appSource.match(/name: "report_item_result"/g) || []).length === 1);
        check("GPT outbound instructions are captured at the transport", /onOutbound/.test(openaiSource) && /promptLedger\.capture\(/.test(appSource));
        check("Gemini setup text is captured at the send site",
            /capturePrompt\("system", setup\.setup\.systemInstruction\.parts\[0\]\.text/.test(appSource) &&
            /capturePrompt\("tools", JSON\.stringify\(setup\.setup\.tools\)/.test(appSource) &&
            /capturePrompt\("tools"[\s\S]{0,200}socket\.send\(JSON\.stringify\(setup\)\)/.test(appSource));
        check("every instruction update goes through one audited path", /function applyInstructionUpdate/.test(appSource) && !/openaiRealtime\.updateInstructions\(instructions \+/.test(appSource));
        check("the GPT family update is disabled in plan mode", /if \(planDriving\(\)\) return;[\s\S]{0,400}openaiPracticeFamilies/.test(appSource) || /!planDriving\(\)[\s\S]{0,200}openaiPracticeFamilies/.test(appSource));
        check("settings expose the prompt ledger", /id="promptLedgerBtn"/.test(indexSource) && /id="promptLedgerBox"/.test(indexSource));
        check("diagnostics export embeds prompt texts by hash",
            (appSource.match(/sessionDiagnostics\.setPrompts\(promptLedger\.exportPayload\(\)\)/g) || []).length >= 2);

        const passed = checks.every(item => item.pass);
        const result = document.getElementById('result');
        result.textContent = (passed ? 'PASS' : 'FAIL') + '\n' + checks.map(item => `${item.pass ? 'OK' : 'NOT OK'} - ${item.name}`).join('\n');
        document.title = (passed ? 'PASS' : 'FAIL') + ' - prompt builder smoke test';
    })().catch(error => {
        document.getElementById('result').textContent = 'FAIL\n' + (error && error.stack || error);
        document.title = 'FAIL - prompt builder smoke test';
    });
})();
