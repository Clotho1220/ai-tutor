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
    check("pronoun and name substitutions share one sentence family",
        PracticeObserver.sentenceFamily("I am happy!") === PracticeObserver.sentenceFamily("Sandy is happy."));

    const boundary = PracticeObserver.createTurnBoundary();
    check("ordinary follow-up does not stop the turn", !boundary.observe("Great answer. Who is this?").detected);
    check("detects an English practice boundary across chunks",
        !boundary.observe("You can say: I am happy. Try ").detected && boundary.observe("it! Who is this?").detected);
    check("reports that the completed turn contained a practice boundary", boundary.completeTurn());
    check("detects spaced Chinese transcription from Gemini", boundary.observe("你可以說：我很好。試試 看！下一題").detected);
    boundary.reset();

    const appSource = await fetch('../app.js?practice-observer-test=' + Date.now()).then(response => response.text());
    const indexSource = await fetch('../index.html?practice-observer-test=' + Date.now()).then(response => response.text());
    check("observer loads before app", indexSource.indexOf('src="practice-observer.js') < indexSource.indexOf('src="app.js'));
    check("Live setup no longer declares log_practice", !/name:\s*"log_practice"/.test(appSource));
    // 上限由「三個連續回合」收緊為「整堂課至多兩次」，並改由前端硬性執行。
    check("lesson prompt caps one sentence family at two practices",
        /PRACTICE VARIETY — mandatory/.test(appSource) &&
        /at most TWICE in the whole session/.test(appSource) &&
        /more than TWICE in a session/.test(appSource));
    check("client enforces the practice cap with a director note",
        /const PRACTICE_CAP = 2/.test(appSource) &&
        /function enforcePracticeCap/.test(appSource) &&
        /enforcePracticeCap[\s\S]{0,900}DIRECTOR_PREFIX/.test(appSource));
    check("practice cap applies to both providers and resets each session",
        /enforcePracticeCap\(observedFeedback\)/.test(appSource) &&
        /practiceFamilyCounts = \{\}/.test(appSource));
    check("GPT treats pronoun-only substitutions as the same family",
        /changing only the subject or name is still the SAME family/.test(appSource));
    check("GPT receives a live instruction update after a repeated family",
        /openaiPracticeFamilies/.test(appSource) && /updateInstructions\(instructions/.test(appSource));
    check("turnComplete records observed feedback", /PracticeObserver\.analyze\(\{[\s\S]{0,180}userText:[\s\S]{0,180}aiText:/.test(appSource));
    check("clarification requests override Chinese-to-English feedback",
        /CLARIFICATION OVERRIDE/.test(appSource) &&
        /你在說什麼/.test(appSource) &&
        /Never teach them to say 'What did you say\?'/.test(appSource));
    check("student transcript ignores chunks after a closed practice boundary",
        /boundaryAlreadyClosed\s*=\s*suppressAudioAfterFarewell\s*\|\|\s*suppressAudioAfterPractice/.test(appSource));

    // --- 迴歸：縮寫必須和完整型視為同一個句型家族 ---
    // 否則重複練習永遠計不到門檻，變異限制器等於沒作用。
    const family = window.PracticeObserver.sentenceFamily;
    const baseFamily = family("I am happy.");
    check("contractions collapse into the same sentence family",
        ["I'm happy.", "He's happy.", "She's happy.", "They're happy.", "We're happy.", "It's happy."]
            .every(sentence => family(sentence) === baseFamily));
    check("curly apostrophes collapse too", family("I’m happy.") === baseFamily);
    check("different patterns stay in different families", family("I like apples.") !== baseFamily);

    // --- 迴歸：常見的示範句講法都要抓得到 ---
    // 抓不到就既不計入重複、也不會寫進 practice 學習紀錄。
    const suggestionOf = aiText =>
        (window.PracticeObserver.analyze({ userText: "我很開心", aiText }) || {}).suggestion || "";
    check("extracts a modelled sentence without quotation marks",
        suggestionOf('Good! You can say I am happy. Try it!') === "I am happy.");
    check("extracts a modelled sentence after a bare Say:",
        suggestionOf('Say: I am happy. Try it!') === "I am happy.");
    check("extracts a modelled sentence after repeat after me",
        suggestionOf('Repeat after me: I am happy.') === "I am happy.");
    check("still extracts a quoted modelled sentence",
        suggestionOf('Good! You can say: "I am happy." Try it!') === "I am happy.");
    check("still extracts from a Chinese cue",
        suggestionOf('很好！你可以說：I am happy. 說說看！') === "I am happy.");

    // --- 迴歸：兩個模型必須共用同一份回合契約 ---
    check("turn contract is shared by both models",
        /const TURN_CONTRACT\s*=/.test(appSource) &&
        /return TURN_CONTRACT \+/.test(appSource) &&
        !/GPT REALTIME TURN CONTRACT/.test(appSource));

    // --- 迴歸：早退復原指令不得再出現否定式禁語 ---
    // 舊版把「不要說我們還沒下課」直接寫進提示，模型反而照著講。
    check("early farewell recovery avoids naming the forbidden phrase",
        /The lesson is still in progress/.test(appSource) &&
        !/Do NOT say or imply 'we are not finished'/.test(appSource));

    const passed = checks.every(item => item.pass);
    const result = document.getElementById('result');
    result.className = passed ? 'pass' : 'fail';
    result.textContent = (passed ? 'PASS' : 'FAIL') + '\n' +
        checks.map(item => `${item.pass ? 'OK' : 'NOT OK'} - ${item.name}`).join('\n');
    document.title = passed ? 'PASS - practice observer smoke test' : 'FAIL - practice observer smoke test';
})();
