(async function () {
    "use strict";

    const checks = [];
    function check(name, pass) { checks.push({ name, pass: !!pass }); }

    const screenshotCase = PracticeObserver.analyze({
        userText: "我以前玩過室內攀岩",
        aiText: '原來你玩過室內攀岩！你可以說 "I have tried indoor rock climbing before." 要不要試試看這句話？'
    });
    check("extracts quoted Chinese-to-English feedback", screenshotCase && screenshotCase.suggestion === "I have tried indoor rock climbing before." && screenshotCase.kind === "translated");

    const unquotedCase = PracticeObserver.analyze({
        userText: "我以前玩過室內攀岩",
        aiText: "I've tried indoor rock climbing before. Please repeat."
    });
    check("extracts an unquoted sentence before repeat", unquotedCase && unquotedCase.suggestion === "I've tried indoor rock climbing before.");

    const correctionCase = PracticeObserver.analyze({
        userText: "He go home.",
        aiText: 'I understand! The natural way is: "He goes home." Try it.'
    });
    check("classifies English correction", correctionCase && correctionCase.kind === "corrected" && correctionCase.suggestion === "He goes home.");

    const alternativeCase = PracticeObserver.analyze({
        userText: "I am fine.",
        aiText: 'Correct! You can also say: "I\'m doing great!"'
    });
    check("classifies an alternative expression", alternativeCase && alternativeCase.kind === "alternative");

    check("ignores an ordinary quoted news headline", PracticeObserver.analyze({
        userText: "我覺得很好", aiText: 'The headline says "New AI rules arrive today." What do you think?'
    }) === null);
    check("ignores a bare vocabulary word", PracticeObserver.analyze({
        userText: "鉛筆", aiText: 'You can say "pencil". Try it.'
    }) === null);
    check("ignores leaked director instructions", PracticeObserver.analyze({
        userText: "好", aiText: '[DIRECTOR NOTE] You can say "Let us begin."'
    }) === null);
    check("detects Chinese and English repeat invitations", PracticeObserver.asksForPractice("要不要試試看這句話？") && PracticeObserver.asksForPractice("Please repeat."));

    const appSource = await fetch('../app.js?practice-observer-test=' + Date.now()).then(response => response.text());
    const indexSource = await fetch('../index.html?practice-observer-test=' + Date.now()).then(response => response.text());
    check("observer loads before app", indexSource.indexOf('src="practice-observer.js') < indexSource.indexOf('src="app.js'));
    check("Live setup no longer declares log_practice", !/name:\s*"log_practice"/.test(appSource));
    check("turnComplete records observed feedback", /PracticeObserver\.analyze\(\{[\s\S]{0,180}userText:[\s\S]{0,180}aiText:/.test(appSource));

    const passed = checks.every(item => item.pass);
    const result = document.getElementById('result');
    result.className = passed ? 'pass' : 'fail';
    result.textContent = (passed ? 'PASS' : 'FAIL') + '\n' +
        checks.map(item => `${item.pass ? 'OK' : 'NOT OK'} - ${item.name}`).join('\n');
    document.title = passed ? 'PASS - practice observer smoke test' : 'FAIL - practice observer smoke test';
})();
