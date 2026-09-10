(function () {
    "use strict";

    const checks = [];
    // 邊跑邊寫進畫面：非同步測試卡住的時候，看得出來是停在哪一條
    function render(title) {
        const box = document.getElementById("results");
        if (!box) return;
        box.textContent = title + "\n" +
            checks.map(c => (c.pass ? "OK - " : "NOT OK - ") + c.name).join("\n");
    }
    function check(name, pass) { checks.push({ name, pass: !!pass }); render("RUNNING"); }

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
            image: "letters/A_apple.webp",
            audio: ["letters/seg/A_name.mp3", "letters/seg/A_sound.mp3", "letters/seg/A_apple.mp3"],
            say: "A ... a ... apple."
        }));
    }

    (async function run() {
        const LP = window.LetterPlayer;
        check("the player module loads", !!LP && typeof LP.create === "function");

        // ---- 每張卡播一次，照順序 ----
        const played = [];
        function FakeAudio(url) {
            played.push(url);
            const handlers = {};
            return {
                addEventListener: (name, fn) => { handlers[name] = fn; },
                removeEventListener: name => { delete handlers[name]; },
                pause: () => {},
                play: () => {
                    setTimeoutFn(() => handlers.ended && handlers.ended(), 1);
                    return Promise.resolve();
                }
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

        // 一張卡＝三段小檔（字母名／音／單字）接起來播
        check("every card plays its three segments, in order",
            result.played === 3 && played.length === 9 &&
            played[0] === "audio/letters/seg/A_name.mp3" &&
            played[1] === "audio/letters/seg/A_sound.mp3" &&
            played[2] === "audio/letters/seg/A_apple.mp3");
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

        // ---- 共用那個「在點擊當下解鎖」的 <audio> ----
        // 手機與桌機 Chrome 只讓使用者手勢直接觸發的播放出聲。播放器必須重複用
        // 同一個已解鎖的元素、只換 src，不能每張卡都 new 一個（2026-09-10 實測完全沒聲音）。
        const shared = (function () {
            const handlers = {};
            return {
                srcs: [], plays: 0, currentTime: 0,
                set src(value) { this.srcs.push(value); },
                get src() { return this.srcs[this.srcs.length - 1] || ""; },
                addEventListener: (name, fn) => { handlers[name] = fn; },
                removeEventListener: name => { delete handlers[name]; },
                pause: () => {},
                play() {
                    this.plays += 1;
                    setTimeoutFn(() => handlers.ended && handlers.ended(), 1);
                    return Promise.resolve();
                }
            };
        })();
        const player5 = LP.create({
            studentView: fakeView(), imageBase: "images/", audioBase: "audio/",
            audioElement: shared, AudioCtor: null, speechSynthesis: null,
            setTimeoutFn, clearTimeoutFn
        });
        const run5 = player5.play(cards(3));
        await runTimers();
        await run5;
        check("every clip reuses the one unlocked audio element",
            shared.plays === 9 && shared.srcs.length === 9 &&
            shared.srcs[0] === "audio/letters/seg/A_name.mp3");

        // ---- 走 WebAudio（跟一般課 AI 語音同一條路）----
        const sources = [];
        const fakeContext = {
            state: "running",
            destination: { id: "dest" },
            decodeAudioData: bytes => Promise.resolve({ bytes }),
            createBufferSource() {
                const source = {
                    connected: null, onended: null, started: false,
                    connect(node) { this.connected = node; },
                    start() { this.started = true; setTimeoutFn(() => this.onended && this.onended(), 1); },
                    stop() {}
                };
                sources.push(source);
                return source;
            }
        };
        const fetched = [];
        const fakeFetch = url => {
            fetched.push(url);
            return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)) });
        };
        const output = { id: "speaker" };
        const player7 = LP.create({
            studentView: fakeView(), imageBase: "images/", audioBase: "audio/",
            audioContext: fakeContext, outputNode: () => output, fetchFn: fakeFetch,
            audioElement: shared, setTimeoutFn, clearTimeoutFn
        });
        const sharedPlaysBefore = shared.plays;
        const preloaded = await player7.preload(cards(3));
        const run7 = player7.play(cards(3));
        await runTimers();
        await run7;
        check("with an AudioContext the clips go through WebAudio, not the <audio> element",
            preloaded === 3 && sources.length === 9 &&
            sources.every(s => s.started && s.connected === output) &&
            shared.plays === sharedPlaysBefore);
        // 三張卡指到同樣的三段小檔，每段只抓一次、之後都用解好的那份
        check("preloading decodes each clip once and playback reuses it",
            fetched.length === 3);

        // ---- 播不出來要講出來，不要默默沒聲音 ----
        const blockedSpeech = [];
        const logs = [];
        const blocked = {
            src: "", currentTime: 0,
            addEventListener: () => {}, removeEventListener: () => {}, pause: () => {},
            play: () => Promise.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" }))
        };
        const player6 = LP.create({
            studentView: fakeView(), imageBase: "images/", audioBase: "audio/",
            audioElement: blocked, AudioCtor: null,
            speechSynthesis: {
                speak: u => { blockedSpeech.push(u.text); setTimeoutFn(() => u.onend && u.onend(), 1); },
                cancel: () => {}
            },
            setTimeoutFn, clearTimeoutFn, onLog: message => logs.push(message)
        });
        const run6 = player6.play(cards(2));
        await runTimers();
        await run6;
        check("blocked audio is reported once and falls back to speech",
            logs.filter(m => m.indexOf("播不出來") >= 0).length === 1 &&
            blockedSpeech.length === 2);

        // ---- 沒有預錄檔就退回瀏覽器語音 ----
        const spoken = [];
        const speech = {
            speak: u => { spoken.push(u.text); setTimeoutFn(() => u.onend && u.onend(), 1); },
            cancel: () => {}
        };
        const player2 = LP.create({
            studentView: fakeView(), imageBase: "images/", audioBase: "audio/",
            AudioCtor: null, speechSynthesis: speech,
            setTimeoutFn, clearTimeoutFn
        });
        const noAudio = cards(2).map(card => Object.assign({}, card, { audio: "" }));
        const run2 = player2.play(noAudio);
        await runTimers();
        await run2;
        check("cards with no recording fall back to browser speech",
            spoken.length === 2 && spoken[0] === "A ... a ... apple.");

        // ---- 老師中途按結束 ----
        const player3 = LP.create({
            studentView: fakeView(), imageBase: "images/", audioBase: "audio/",
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
            /if \(lettersUnitSelected\(\)\) \{ await startLetterPlayerSession\(\); return; \}/.test(appSource));
        check("the player never opens a model connection",
            /startLetterPlayerSession/.test(appSource) &&
            appSource.split("async function startLetterPlayerSession")[1]
                .split("function finishLetterPlayer")[0]
                .indexOf("liveSession.start") < 0);
        check("finishing a day advances the week progress",
            /markLetterDayDone\(key\)/.test(appSource));
        // 解鎖一定要在 await 之前跑：手勢一結束，瀏覽器就不讓我們播了
        check("audio is unlocked inside the click, before any await",
            /primeLetterAudio\(\);\s*\n\s*await loadUnitsData\(\);/.test(appSource) &&
            /audioElement: primeLetterAudio\(\)/.test(appSource));

        // 第一段旁白要在 ▶ 開始那一下裡直接播，不能隔著 await
        check("the first clip is played from inside the start tap", (function () {
            const at = appSource.indexOf("studentView.showStartButton(() => {");
            const body = at >= 0 ? appSource.slice(at, at + 800) : "";
            return body.indexOf("letterPlayer.play(cards)") > 0 &&
                body.slice(0, body.indexOf("letterPlayer.play(cards)")).indexOf("await") < 0;
        })());

        const failed = checks.filter(c => !c.pass);
        document.title = (failed.length ? "FAIL" : "PASS") + " - letter player smoke test";
        render(failed.length ? "FAIL" : "PASS");
    })();
})();
