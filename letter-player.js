(function (global) {
    "use strict";

    // 字母單元的播放器：卡片 + 旁白，照順序播下去，像看影片一樣。
    //
    // 2026-09-10 使用者定案。起因是實測那一堂：即時模型每張卡都自己加話
    // （"Okay, let's look here"、"Next up, we have another one for Aa"、
    // "Can you repeat that?"），還會慢半拍講到已經過掉的卡。
    // 字母單元本來就沒有要判對錯，把模型整個拿掉最乾淨——
    // 沒有連線、沒有延遲、每次唸的一模一樣，也不會多說一個字。
    //
    // 一張卡的流程：
    //   顯示卡片 → 播旁白（A, a. aa. Apple.）→ 亮出「換你唸」→ 安靜等他唸 → 下一張
    // 全程不需要孩子按任何按鈕，也不聽他唸得標不標準。

    const DEFAULT_PAUSE = 2600;      // 旁白之後最少留這麼久給孩子跟著唸
    const MAX_PAUSE = 5200;
    const GAP = 400;                 // 換卡之間的空隙，不要一句接一句
    const SEGMENT_GAP = 700;         // 字母名／音／單字三段之間的停頓（原本寫在 TTS 裡的 <break>）

    function create(options) {
        const config = options || {};
        const studentView = config.studentView;
        const doc = config.document || global.document;
        const setTimer = config.setTimeoutFn || global.setTimeout.bind(global);
        const clearTimer = config.clearTimeoutFn || global.clearTimeout.bind(global);
        const log = typeof config.onLog === 'function' ? config.onLog : function () {};
        const record = typeof config.onEvent === 'function' ? config.onEvent : function () {};
        const AudioCtor = config.AudioCtor || global.Audio;
        // 手機（與桌機 Chrome 的自動播放政策）只允許「使用者那一下」直接觸發的播放。
        // 播放器是在好幾個 await 之後才建立第一個 Audio 的，那時已經不算使用者手勢了，
        // 結果整堂課一點聲音都沒有（2026-09-10 實測）。
        // 解法是共用同一個已經在點擊當下解鎖過的 <audio>，之後只換 src。
        const shared = config.audioElement || null;
        // 2026-09-10 第三輪還是沒聲音，但同一台裝置一般課的 AI 語音有聲音——
        // 那條路是 WebAudio（playbackContext → getOutputNode，含喇叭／聽筒的路由）。
        // <audio> 元素在那台裝置上顯然出不了聲，所以旁白改走同一條 WebAudio 路，
        // 由呼叫端把 AudioContext 與輸出節點傳進來；沒有的話才退回 <audio>。
        const audioContext = config.audioContext || null;
        const outputNode = typeof config.outputNode === 'function' ? config.outputNode : null;
        const fetchFn = config.fetchFn || (global.fetch ? global.fetch.bind(global) : null);
        const decoded = new Map();      // url → AudioBuffer，一堂課的 12 段預先解好
        const speech = config.speechSynthesis !== undefined
            ? config.speechSynthesis : global.speechSynthesis;

        const state = { running: false, timer: null, release: null, audio: null, source: null, index: 0, total: 0 };

        function clear() {
            if (state.timer != null) clearTimer(state.timer);
            state.timer = null;
            // 停下來的時候要把還在等的那個 await 放掉，否則 play() 永遠不會回來
            // （老師按「結束播放」時整個流程就卡在那裡，最後一張卡也記不成完成）
            if (state.release) { const release = state.release; state.release = null; release(); }
            if (state.audio) {
                try { state.audio.pause(); } catch (e) {}
                state.audio = null;
            }
            if (state.source) {
                try { state.source.stop(); } catch (e) {}
                state.source = null;
            }
            if (speech && speech.cancel) { try { speech.cancel(); } catch (e) {} }
        }

        function wait(ms) {
            return new Promise(resolve => {
                state.release = resolve;
                state.timer = setTimer(() => { state.release = null; resolve(); }, ms);
            });
        }

        async function decode(url) {
            if (decoded.has(url)) return decoded.get(url);
            const response = await fetchFn(url);
            if (!response || !response.ok) throw new Error("fetch " + (response && response.status));
            const bytes = await response.arrayBuffer();
            const buffer = await audioContext.decodeAudioData(bytes);
            decoded.set(url, buffer);
            return buffer;
        }

        // item.audio 可以是一個檔，或三段小檔（字母名／音／單字）的清單
        function filesOf(item) {
            const audio = item && item.audio;
            if (!audio) return [];
            return (Array.isArray(audio) ? audio : [audio]).filter(Boolean).map(f => config.audioBase + f);
        }

        // 課前先把今天的旁白全部解好，播的時候零等待（順便驗證檔案抓得到）
        async function preload(items) {
            if (!audioContext || !fetchFn) return 0;
            let ok = 0;
            for (const item of items || []) {
                const urls = filesOf(item);
                if (!urls.length) continue;
                try {
                    for (const url of urls) await decode(url);
                    ok += 1;
                } catch (e) {}
            }
            return ok;
        }

        // <audio> 元素備援也要三段接起來，不能只播第一段（只唸字母名）
        async function playFiles(urls) {
            let total = 0;
            for (let i = 0; i < urls.length && state.running; i++) {
                total += await playFile(urls[i]);
                if (i < urls.length - 1 && state.running) { await wait(SEGMENT_GAP); total += SEGMENT_GAP; }
            }
            return total;
        }

        // 三段接起來播，段與段之間留 SEGMENT_GAP；回傳總共播了多久
        async function playBuffers(urls) {
            let total = 0;
            for (let i = 0; i < urls.length && state.running; i++) {
                total += await playBuffer(urls[i]);
                if (i < urls.length - 1 && state.running) { await wait(SEGMENT_GAP); total += SEGMENT_GAP; }
            }
            return total;
        }

        function playBuffer(url) {
            return new Promise((resolve, reject) => {
                decode(url).then(buffer => {
                    if (!state.running) { resolve(0); return; }
                    const source = audioContext.createBufferSource();
                    source.buffer = buffer;
                    source.connect(outputNode ? outputNode() : audioContext.destination);
                    state.source = source;
                    const started = Date.now();
                    source.onended = () => {
                        if (state.source === source) state.source = null;
                        resolve(Date.now() - started);
                    };
                    source.start();
                }, reject);
            });
        }

        // 有預錄的 mp3 就用，沒有就退回瀏覽器內建語音。
        // 回傳這段聲音大概播了多久，用來決定要留多長的安靜給孩子。
        let audioWarned = false;
        function speakCard(item) {
            const urls = filesOf(item);
            const url = urls[0] || "";
            if (url && audioContext && fetchFn) {
                return playBuffers(urls).catch(error => {
                    if (!audioWarned) {
                        audioWarned = true;
                        const why = String(error && (error.name || error.message) || "unknown");
                        log("🔇 WebAudio 播不出旁白（" + why + "），改用 <audio> 元素。");
                        record("letter_audio_blocked", { url, path: "webaudio", reason: why });
                    }
                    return (shared || AudioCtor)
                        ? playFiles(urls).catch(() => speakText(item.say))
                        : speakText(item.say);
                });
            }
            if (url && (shared || AudioCtor)) {
                return playFiles(urls).catch(error => {
                    // 一堂課只講一次，但一定要講——不然「完全沒聲音」只能用猜的
                    if (!audioWarned) {
                        audioWarned = true;
                        log(`🔇 預錄旁白播不出來（${error && error.name ? error.name : "error"}），改用瀏覽器內建語音。`);
                        record("letter_audio_blocked", {
                            url, reason: error && (error.name || error.message) || "unknown"
                        });
                    }
                    return speakText(item.say);
                });
            }
            return speakText(item.say);
        }

        function playFile(url) {
            return new Promise((resolve, reject) => {
                const audio = shared || new AudioCtor(url);
                state.audio = audio;
                const started = Date.now();
                let settled = false;

                function cleanup() {
                    audio.removeEventListener('ended', ended);
                    audio.removeEventListener('error', failed);
                }
                function ended() {
                    if (settled) return;
                    settled = true; cleanup(); resolve(Date.now() - started);
                }
                function failed(error) {
                    if (settled) return;
                    settled = true; cleanup();
                    reject(error instanceof Error ? error : new Error('audio failed'));
                }

                audio.addEventListener('ended', ended);
                audio.addEventListener('error', failed);
                // 共用的那個元素是點擊當下解鎖的，之後只換 src
                if (shared) { shared.src = url; try { shared.currentTime = 0; } catch (e) {} }
                const attempt = audio.play();
                if (attempt && typeof attempt.catch === 'function') attempt.catch(failed);
            });
        }

        function speakText(text) {
            if (!speech || !global.SpeechSynthesisUtterance || !text) return Promise.resolve(0);
            return new Promise(resolve => {
                const started = Date.now();
                const utterance = new global.SpeechSynthesisUtterance(text);
                utterance.lang = 'en-US';
                utterance.rate = 0.85;
                utterance.onend = () => resolve(Date.now() - started);
                utterance.onerror = () => resolve(Date.now() - started);
                speech.speak(utterance);
            });
        }

        function show(item, speaking) {
            if (!studentView) return;
            studentView.showCard({
                imageUrl: item.image ? config.imageBase + item.image : "",
                word: item.letter,
                meaning: "",
                kind: "letter",
                icon: "🔤"
            });
            if (studentView.showSpeakCue) studentView.showSpeakCue(!speaking);
        }

        async function play(items) {
            const cards = (items || []).filter(item => item && item.type === "letter_say");
            if (!cards.length) return { played: 0, stopped: false };
            clear();
            state.running = true;
            state.total = cards.length;
            record("letter_player_started", {
                cards: cards.length,
                path: audioContext && fetchFn ? "webaudio" : (shared || AudioCtor ? "element" : "speech"),
                contextState: audioContext ? audioContext.state : ""
            });
            let played = 0;
            for (let i = 0; i < cards.length && state.running; i++) {
                const item = cards[i];
                state.index = i;
                log(`🔤 [${i + 1}/${cards.length}] ${item.letter}　${item.target}`);
                show(item, true);
                let spoken = 0;
                try { spoken = await speakCard(item); } catch (e) { spoken = 0; }
                if (!state.running) break;
                // 留給孩子跟著唸：至少 DEFAULT_PAUSE，旁白長就跟著長一點
                show(item, false);
                const pause = Math.min(MAX_PAUSE, Math.max(DEFAULT_PAUSE, spoken + 600));
                await wait(pause);
                if (!state.running) break;
                played += 1;
                if (i < cards.length - 1) await wait(GAP);
            }
            const stopped = !state.running;
            state.running = false;
            if (studentView && studentView.showSpeakCue) studentView.showSpeakCue(false);
            record("letter_player_finished", { played, total: cards.length, stopped });
            return { played, stopped };
        }

        function stop() {
            if (!state.running) return;
            state.running = false;
            clear();
            if (studentView && studentView.showSpeakCue) studentView.showSpeakCue(false);
        }

        function isPlaying() { return state.running; }
        function progress() { return { index: state.index, total: state.total }; }

        return Object.freeze({ play, stop, isPlaying, progress, preload });
    }

    global.LetterPlayer = Object.freeze({ create });
})(window);
