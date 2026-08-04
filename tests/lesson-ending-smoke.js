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

    const appSource = await fetch('../app.js?lesson-ending-test=' + Date.now()).then(response => response.text());
    const indexSource = await fetch('../index.html?lesson-ending-test=' + Date.now()).then(response => response.text());
    check("guard loads before app", indexSource.indexOf('src="lesson-ending.js') < indexSource.indexOf('src="app.js'));
    check("app completes the session after a final farewell", /scheduleLessonCompletion\(\)/.test(appSource));
    check("app recovers from an early farewell", /sendEarlyFarewellRecovery\(\)/.test(appSource));
    check("recovery never tells the child the lesson is not finished",
        /Do NOT say or imply 'we are not finished'/.test(appSource) && !/Say only 「我們還沒下課喔/.test(appSource));
    check("early farewell clears already queued audio", /!farewellJustDetected\.finalStage\) stopAllPlayback\(\)/.test(appSource));
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
