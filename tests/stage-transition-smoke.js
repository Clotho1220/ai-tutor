(async function () {
    "use strict";

    const checks = [];
    function check(name, pass) { checks.push({ name, pass: !!pass }); }

    const gate = StageTransitionGate.create({ requiredRounds: 2 });
    gate.request();
    check("request opens a pending transition", gate.inspect().pending);
    check("director-only AI turn does not count", gate.completeAiTurn() === false && gate.inspect().completedRounds === 0);

    gate.noteStudentTurn();
    check("first feedback round never transitions", gate.completeAiTurn({ practiceRequested: true }) === false);
    check("first round remains pending for the student's attempt", gate.inspect().pending && gate.inspect().completedRounds === 1);

    gate.noteStudentTurn();
    check("another repeat invitation keeps waiting", gate.completeAiTurn({ practiceRequested: true }) === false);
    gate.noteStudentTurn();
    check("transition becomes ready only after a non-repeat response", gate.completeAiTurn({ practiceRequested: false }) === true);
    check("duplicate turnComplete cannot advance twice", gate.completeAiTurn({ practiceRequested: false }) === false);
    check("consume resets all pending state", gate.consume() && !gate.inspect().pending && gate.inspect().studentTurns === 0);

    const appSource = await fetch('../app.js?stage-transition-test=' + Date.now()).then(response => response.text());
    const indexSource = await fetch('../index.html?stage-transition-test=' + Date.now()).then(response => response.text());
    const talkHandler = appSource.slice(appSource.indexOf("talkBtn.addEventListener"), appSource.indexOf("// ---------------- 人員"));
    check("transition gate loads before app", indexSource.indexOf('src="stage-transition.js') < indexSource.indexOf('src="app.js'));
    check("activityEnd no longer sends a director transition", !/sendStageTransition\(['\"]graceful['\"]\)/.test(talkHandler));
    check("student completion is recorded separately", /stageTransitionGate\.noteStudentTurn\(\)/.test(talkHandler));
    check("AI turnComplete controls the transition", /completeAiTurn\(\{ practiceRequested \}\)/.test(appSource));
    check("new stage starts without replying to the previous answer", /Do not reply to or revisit the student's previous answer/.test(appSource));
    check("timeout waits until both people are idle", /!isTalking && !aiTurnActive/.test(appSource));

    const passed = checks.every(item => item.pass);
    const result = document.getElementById('result');
    result.className = passed ? 'pass' : 'fail';
    result.textContent = (passed ? 'PASS' : 'FAIL') + '\n' +
        checks.map(item => `${item.pass ? 'OK' : 'NOT OK'} - ${item.name}`).join('\n');
    document.title = passed ? 'PASS - stage transition smoke test' : 'FAIL - stage transition smoke test';
})();
