(async function () {
    "use strict";

    const checks = [];
    function check(name, pass) { checks.push({ name, pass: !!pass }); }

    const guard = LessonEndingGuard.create();
    guard.enterStage(false);
    check("ordinary teaching text continues", !guard.observe("Good job! Try it once.").detected);
    check("friendly greeting is not mistaken for goodbye", !guard.observe("It's good to see you.").detected);
    check("early goodbye is detected", guard.observe("Goodbye!").detected);
    check("early goodbye requests recovery", guard.completeTurn() === "recover");

    guard.enterStage(true);
    check("plain see you remains a valid farewell", guard.observe("See you!").detected);
    guard.enterStage(true);
    check("split farewell is detected across transcript chunks",
        !guard.observe("See ").detected && guard.observe("you next time!").detected);
    check("final-stage farewell finishes the lesson", guard.completeTurn() === "finish");

    guard.enterStage(true);
    check("Traditional Chinese farewell is supported", guard.observe("今天很棒，我們下次見！").detected);
    guard.enterStage(true);
    check("final closing turn finishes even when the model omits a recognized farewell",
        guard.completeTurn({ finalStage: true, finishFinalTurn: true }) === "finish");
    guard.resetSession();
    check("session reset clears closing state", !guard.inspect().finalStage && !guard.inspect().detected);

    // --- 迴歸：教材本身在教 goodbye 時不可誤判成下課 ---
    // 實際課堂（Book 1 Unit 1 Day 2，目標字就是 goodbye）曾因此在 80 秒內
    // 連續觸發 6 次早退復原，課程完全卡死。
    const farewellTargets = ['Nice to meet you.', 'goodbye (int.)', 'hello (int.)'];
    const teachingLines = [
        '好喔! 那如果你要跟新朋友說再見呢? 試試說 "Goodbye." 換你說!',
        '一下, 你要離開玩具店了, 你會怎麼跟店員說再見呢? 試試看!'
    ];
    check("a lesson that teaches goodbye suppresses mid-lesson farewell detection",
        teachingLines.every(line => {
            const guard = window.LessonEndingGuard.create();
            guard.setLessonTargets(farewellTargets);
            guard.enterStage(false);
            return guard.observe(line).detected === false;
        }));
    check("setLessonTargets reports whether the lesson teaches a farewell word",
        window.LessonEndingGuard.create().setLessonTargets(farewellTargets) === true &&
        window.LessonEndingGuard.create().setLessonTargets(['apple', 'banana']) === false);
    check("the closing stage still recognises a real farewell even in such a lesson", (() => {
        const guard = window.LessonEndingGuard.create();
        guard.setLessonTargets(farewellTargets);
        guard.enterStage(true);
        return guard.observe('今天很棒，我們下次見！Goodbye!').detected === true;
    })());
    check("a quoted demonstration is never treated as a farewell", (() => {
        const guard = window.LessonEndingGuard.create();
        guard.setLessonTargets(['apple']);
        guard.enterStage(false);
        return guard.observe('你可以說 "Goodbye." 試試看!').detected === false;
    })());
    check("an unquoted early farewell is still caught", (() => {
        const guard = window.LessonEndingGuard.create();
        guard.setLessonTargets(['apple']);
        guard.enterStage(false);
        return guard.observe('好，今天就上到這裡，我們下次見！').detected === true;
    })());
    check("a new session clears the taught-farewell flag", (() => {
        const guard = window.LessonEndingGuard.create();
        guard.setLessonTargets(farewellTargets);
        guard.resetSession();
        return guard.inspect().lessonTeachesFarewell === false;
    })());

    const appSource = await fetch('../app.js?lesson-ending-test=' + Date.now()).then(response => response.text());
    const indexSource = await fetch('../index.html?lesson-ending-test=' + Date.now()).then(response => response.text());
    check("guard loads before app", indexSource.indexOf('src="lesson-ending.js') < indexSource.indexOf('src="app.js'));
    check("app completes the session after a final farewell", /scheduleLessonCompletion\(\)/.test(appSource));
    check("app recovers from an early farewell", /sendEarlyFarewellRecovery\(\)/.test(appSource));
    // 復原指令必須全部使用正向敘述。舊版寫成「不要說『我們還沒下課』」，
    // 等於把禁語直接餵給模型，反而常被照著講出來。
    check("recovery is phrased positively and never names the forbidden line",
        /The lesson is still in progress/.test(appSource) &&
        /the closing will be signalled separately/.test(appSource) &&
        !/we are not finished/.test(appSource) &&
        !/我們還沒下課/.test(appSource));
    check("early farewell clears already queued audio", /!farewellJustDetected\.finalStage\) stopAllPlayback\(\)/.test(appSource));
    check("repeated recoveries stop instead of looping forever",
        /MAX_FAREWELL_RECOVERIES = 2/.test(appSource) &&
        /farewellRecoveryCount > MAX_FAREWELL_RECOVERIES/.test(appSource) &&
        /early_farewell_recovery_suppressed/.test(appSource));
    check("the lesson's own vocabulary is handed to the ending guard",
        /function applyLessonTargetsToEndingGuard/.test(appSource) &&
        /lessonEndingGuard\.setLessonTargets\(targets\)/.test(appSource) &&
        (appSource.match(/applyLessonTargetsToEndingGuard\(\);/g) || []).length === 2);
    check("the recovery counter resets each session", /farewellRecoveryCount = 0;/.test(appSource));

    // --- 迴歸：結語必須播完才斷線 ---
    // 診斷檔顯示 GPT 端只等 350ms 就關閉連線，但 ai_turn_completed 只代表
    // 「模型產生完畢」，語音仍在播，結語幾乎整段被切掉。
    const realtimeSource = await fetch('../openai-realtime.js?lesson-ending-test=' + Date.now()).then(r => r.text());
    check("realtime module reports when output audio really finished",
        /emit\("onOutputAudioStopped"/.test(realtimeSource) &&
        /function isSpeaking\(\)/.test(realtimeSource) &&
        /isSpeaking,/.test(realtimeSource));
    check("completion waits for the closing audio instead of a fixed short delay",
        /awaitingClosingAudio = true/.test(appSource) &&
        /openaiRealtime\.isSpeaking\(\)/.test(appSource) &&
        !/Math\.max\(350, queuedAudioMs \+ 250\)/.test(appSource));
    check("a safety timeout still ends the lesson if the stop event never arrives",
        /MAX_CLOSING_WAIT_MS = 25000/.test(appSource) &&
        /finishLessonAfterClosing\("timeout"\)/.test(appSource));
    check("the wait flag resets when a new session starts",
        /awaitingClosingAudio = false/.test(appSource));
    check("final stage cannot trigger early-farewell recovery",
        /if \(closingStageActive \|\| lessonCompletionPending\)[\s\S]{0,100}scheduleLessonCompletion\(\)/.test(appSource));
    check("final stage has an explicit no-more-questions closing instruction",
        /FINAL CLOSING STAGE[\s\S]{0,300}Do not ask the student another question/.test(appSource));
    check("late model events are ignored once completion is pending",
        /if \(lessonCompletionPending\) return;/.test(appSource));

    const passed = checks.every(item => item.pass);
    const result = document.getElementById('result');
    result.className = passed ? 'pass' : 'fail';
    result.textContent = (passed ? 'PASS' : 'FAIL') + '\n' +
        checks.map(item => `${item.pass ? 'OK' : 'NOT OK'} - ${item.name}`).join('\n');
    document.title = passed ? 'PASS - lesson ending smoke test' : 'FAIL - lesson ending smoke test';
})();
