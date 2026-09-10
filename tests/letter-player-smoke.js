(function () {
    "use strict";

    const checks = [];
    function check(name, pass) { checks.push({ name, pass: !!pass }); }

    // 假的計時器：不真的等 2.6 秒，直接把時間快轉掉
    const timers = new Map();
    let nextTimerId = 1;
    function setTimeoutFn(fn, ms) {
        const id = nextTimerId++;
        timers.set(id, { fn, ms });
        return id;
    }
    function clearTimeoutFn(id) { timers.delete(id); }
    // 讓出幾輪 microtask，播放器的 await 才有機會往下走、排出下一個計時器。
    // 用 microtask 而不是真的 setTimeout：整份測試才不會真的等上好幾秒。
    async function settle() {
        for (let i = 0; i < 8; i++) await Promise.resolve();
    }

    async function runTimers(limit) {
        let quiet = 0;
        for (let i = 0; i < (limit || 600); i++) {
            await settle();
            if (!timers.size) { if (++quiet > 4) return; continue; }
            quiet = 0;
            const [id, entry] = timers.entries().next().value;
            timers.delete(id);
            entry.fn();
        }
    }

    function fakeView() {
        const view = { cards: [], cue: [] };
        view.showCard = card => view.cards.push(card);
        view.showSpeakCue = on => view.cue.push(!!on);
        return view;
    }

    function cards(n) {
        return Array.from({ length: n }, (_, i) => ({
            type: "letter_say",
            letter: "Aa", target: "apple" + i,
            image: "letters/A_apple.webp", audio: "letters/A_apple.mp3",
            say: "A, a. aa. Apple."
        }));
    }

    (async function run() {
        const LP = window.LetterPlayer;
        check("the player module loads", !!LP && typeof LP.create === "function");

        // ---- 有預錄的 mp3 就播 mp3 ----
        const played = [];
        function FakeAudio(url) {
            played.push(url);
            const handlers = {};
            return {
                addEventListener: (name, fn) => { handlers[name] = fn; },
                pause: () => {},
                play: () => { setTimeoutFn(() => handlers.ended && handlers.ended(), 1); return Promise.resolve(); }
            };
        }

        const view = fakeView();
        const events = [];
        const player = LP.create({
            studentView: view, imageBase: "images/", audioBase: "audio/",
            AudioCtor: FakeAudio, speechSynthesis: null,
            setTimeoutFn, clearTimeoutFn,
            onEvent: (type, detail) => events.push({ type, detail })
        });
        const finished = player.play(cards(3));
        await runTimers();
        const result = await finished;

        check("every card is played once, in order",
            result.played === 3 && played.length === 3 &&
            played[0] === "audio/letters/A_apple.mp3");
        check("the card image comes from the local library",
            view.cards.length >= 3 &&
            view.cards[0].imageUrl === "images/letters/A_apple.webp" &&
            view.cards[0].kind === "letter");
        // 使用者定案：不用按鈕、不判對錯，但要留說話的時間
        check("each card ends with a silent turn for the child",
            view.cue.filter(on => on).length === 3);
        check("the cue is cleared when the sequence ends",
            view.cue[view.cue.length - 1] === false);
        check("the run is recorded for the diagnostics file",
            events.some(e => e.type === "letter_player_started") &&
            events.some(e => e.type === "letter_player_finished" && e.detail.played === 3));

        // ---- 沒有預錄檔就退回瀏覽器語音 ----
        const spoken = [];
        const speech = { speak: u => { spoken.push(u.text); setTimeoutFn(() => u.onend && u.onend(), 1); }, cancel: () => {} };
        const view2 = fakeView();
        const player2 = LP.create({
            studentView: view2, imageBase: "images/", audioBase: "audio/",
            AudioCtor: null, speechSynthesis: speech,
            setTimeoutFn, clearTimeoutFn
        });
        const noAudio = cards(2).map(card => Object.assign({}, card, { audio: "" }));
        const run2 = player2.play(noAudio);
        await runTimers();
        await run2;
        check("cards with no recording fall back to browser speech",
            spoken.length === 2 && spoken[0] === "A, a. aa. Apple.");

        // ---- 老師中途按結束 ----
        const view3 = fakeView();
        const player3 = LP.create({
            studentView: view3, imageBase: "images/", audioBase: "audio/",
            AudioCtor: FakeAudio, speechSynthesis: null,
            setTimeoutFn, clearTimeoutFn
        });
        const run3 = player3.play(cards(6));
        await runTimers(4);
        player3.stop();
        await runTimers();
        const result3 = await run3;
        check("stopping mid-way ends the run instead of racing on",
            result3.stopped && result3.played < 6 && !player3.isPlaying());

        // ---- 不是字母卡的項目一律不碰 ----
        const view4 = fakeView();
        const player4 = LP.create({
            studentView: view4, AudioCtor: FakeAudio, speechSynthesis: null,
            imageBase: "images/", audioBase: "audio/", setTimeoutFn, clearTimeoutFn
        });
        const result4 = await player4.play([{ type: "word_read", target: "apple" }]);
        check("only letter cards are played", result4.played === 0 && !view4.cards.length);

        // ---- 字母單元不連線（app.js 的路由） ----
        const appSource = await fetch("../app.js?letter-player-test=" + Date.now()).then(r => r.text());
        check("a letters unit starts the player instead of a live session",
            /if \(lettersUnitSelected\(\)\) \{ await startLetterPlayerSession\(\); return; \}/.test(appSource) &&
            /lettersUnitSelected/.test(appSource));
        check("the player never opens a model connection",
            /startLetterPlayerSession/.test(appSource) &&
            appSource.split("async function startLetterPlayerSession")[1]
                .split("function finishLetterPlayer")[0]
                .indexOf("liveSession.start") < 0);
        check("finishing a day advances the week progress",
            /markLetterDayDone\(key\)/.test(appSource));

        const box = document.getElementById("results");
        const failed = checks.filter(c => !c.pass);
        document.title = (failed.length ? "FAIL" : "PASS") + " - letter player smoke test";
        box.textContent = (failed.length ? "FAIL" : "PASS") + "\n" +
            checks.map(c => (c.pass ? "OK - " : "NOT OK - ") + c.name).join("\n");
    })();
})();
