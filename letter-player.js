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
    //   顯示卡片 → 播旁白（A, a. aa. Apple.）→ 安靜等他唸 → 下一張
    // 不聽他唸得標不標準。畫面上只有一顆「⏸ 暫停」（v3.53，使用者 2026-09-15 要求取代「換你唸」提示）：
    // 暫停立刻停掉聲音；繼續時從這張卡的開頭重播（從半句接回去聽不懂）。

    // 旁白之後留給孩子跟著唸的時間。原本 2.6～5.2 秒；2026-09-13 使用者實聽教材真人音後
    // 要求固定 1.5 秒——那段錄音在字母、音、單字之間本來就留了空，孩子邊聽邊跟得上。
    const DEFAULT_PAUSE = 1500;
    const MAX_PAUSE = 1500;
    const GAP = 400;                 // 換卡之間的空隙，不要一句接一句
    // 換卡後最多等圖多久才開始唸（v3.54）。圖沒到就唸，孩子看到的是上一張的圖（使用者 9/15 回報 banana 配 apple）。
    // 課前已經把整輪的圖下載好，正常一張都不用等；這是網路很慢時的保險，逾時照唸、記進診斷檔。
    const IMAGE_WAIT = 4000;
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

        const state = { running: false, paused: false, resumeGate: null, abortAudio: null,
                        timer: null, release: null, audio: null, source: null, index: 0, total: 0 };

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
            // <audio> 被 pause() 不會觸發 ended，等它的那個 promise 要手動放掉（暫停時會用到）
            if (state.abortAudio) { const abort = state.abortAudio; state.abortAudio = null; abort(); }
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

        // 教材整軌的一段：解一次整軌（快取），source.start(0, offset, duration) 直接播那一段。
        // 不切檔、取樣精準、沒有接縫；使用者聽了哪張不對，改 start/end 兩個數字就好。
        function playClip(clip) {
            const url = config.audioBase + clip.file;
            return new Promise((resolve, reject) => {
                decode(url).then(buffer => {
                    if (!state.running || state.paused) { resolve(0); return; }
                    const start = Math.max(0, Number(clip.start) || 0);
                    const end = Math.min(buffer.duration, Number(clip.end) || buffer.duration);
                    if (end <= start) { reject(new Error("bad clip range")); return; }
                    const source = audioContext.createBufferSource();
                    source.buffer = buffer;
                    source.connect(outputNode ? outputNode() : audioContext.destination);
                    state.source = source;
                    const began = Date.now();
                    source.onended = () => {
                        if (state.source === source) state.source = null;
                        resolve(Date.now() - began);
                    };
                    source.start(0, start, end - start);
                }, reject);
            });
        }

        function clipOf(item) {
            const clip = item && item.clip;
            return clip && clip.file && audioContext && fetchFn ? clip : null;
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
                const clip = clipOf(item);
                const urls = clip ? [config.audioBase + clip.file] : filesOf(item);
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
            for (let i = 0; i < urls.length && state.running && !state.paused; i++) {
                total += await playFile(urls[i]);
                if (i < urls.length - 1 && state.running) { await wait(SEGMENT_GAP); total += SEGMENT_GAP; }
            }
            return total;
        }

        // 三段接起來播，段與段之間留 SEGMENT_GAP；回傳總共播了多久
        async function playBuffers(urls) {
            let total = 0;
            for (let i = 0; i < urls.length && state.running && !state.paused; i++) {
                total += await playBuffer(urls[i]);
                if (i < urls.length - 1 && state.running) { await wait(SEGMENT_GAP); total += SEGMENT_GAP; }
            }
            return total;
        }

        function playBuffer(url) {
            return new Promise((resolve, reject) => {
                decode(url).then(buffer => {
                    if (!state.running || state.paused) { resolve(0); return; }
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
            const clip = clipOf(item);
            if (clip) {
                // 真人錄音優先；壞了就退回三段 TTS
                return playClip(clip).catch(error => {
                    if (!audioWarned) {
                        audioWarned = true;
                        const why = String(error && (error.name || error.message) || "unknown");
                        log("🔇 教材音軌播不出來（" + why + "），改用 TTS 旁白。");
                        record("letter_audio_blocked", { url: clip.file, path: "clip", reason: why });
                    }
                    return speakCard(Object.assign({}, item, { clip: null }));
                });
            }
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
                state.abortAudio = ended;

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

        function show(item) {
            if (!studentView) return;
            studentView.showCard({
                imageUrl: item.image ? config.imageBase + item.image : "",
                word: item.letter,
                meaning: "",
                kind: "letter",
                icon: "🔤"
            });
        }

        // 暫停中就停在這裡，直到按「繼續」或「結束播放」
        function waitWhilePaused() {
            if (!state.paused) return Promise.resolve();
            return new Promise(resolve => { state.resumeGate = resolve; });
        }

        async function play(items) {
            const cards = (items || []).filter(item => item && item.type === "letter_say");
            if (!cards.length) return { played: 0, stopped: false };
            clear();
            state.running = true;
            state.total = cards.length;
            record("letter_player_started", {
                cards: cards.length,
                clips: cards.filter(clipOf).length,
                path: audioContext && fetchFn ? "webaudio" : (shared || AudioCtor ? "element" : "speech"),
                contextState: audioContext ? audioContext.state : ""
            });
            let played = 0;
            for (let i = 0; i < cards.length && state.running;) {
                await waitWhilePaused();
                if (!state.running) break;
                const item = cards[i];
                state.index = i;
                log(`🔤 [${i + 1}/${cards.length}] ${item.letter}　${item.target}`);
                show(item);
                // 圖還沒好就先等：聲音跟畫面一定要是同一張卡。已經好了就不 await（保住點擊當下直接出聲）
                if (studentView && studentView.cardImageIsReady && !studentView.cardImageIsReady()) {
                    const waitStarted = Date.now();
                    const ready = await studentView.whenCardImageReady(IMAGE_WAIT);
                    const waited = Date.now() - waitStarted;
                    if (!state.running) break;
                    if (!ready) {
                        record("letter_image_timeout", { index: i, image: item.image, waitedMs: waited });
                        log(`🐢 第 ${i + 1} 張的圖 ${Math.round(waited / 100) / 10} 秒還沒載好，先唸。`);
                    } else if (waited > 300) {
                        record("letter_image_waited", { index: i, image: item.image, waitedMs: waited });
                    }
                    if (state.paused) continue;
                }
                let spoken = 0;
                try { spoken = await speakCard(item); } catch (e) { spoken = 0; }
                if (!state.running) break;
                if (state.paused) continue;          // 唸到一半被暫停：繼續時整張卡重播
                // 留給孩子跟著唸：至少 DEFAULT_PAUSE，旁白長就跟著長一點
                const pause = Math.min(MAX_PAUSE, Math.max(DEFAULT_PAUSE, spoken + 600));
                await wait(pause);
                if (!state.running) break;
                if (state.paused) continue;          // 跟唸的那段安靜被暫停：也重播這張，孩子才接得上
                played += 1;
                if (i < cards.length - 1) await wait(GAP);
                i += 1;                              // 換卡空隙被暫停就不重播，繼續時直接下一張
            }
            const stopped = !state.running;
            state.running = false;
            state.paused = false;
            record("letter_player_finished", { played, total: cards.length, stopped });
            return { played, stopped };
        }

        function pause() {
            if (!state.running || state.paused) return false;
            state.paused = true;
            clear();                                 // 立刻停聲音、放掉正在等的計時
            record("letter_player_paused", { index: state.index, total: state.total });
            log(`⏸ 暫停在第 ${state.index + 1} 張。`);
            return true;
        }

        function resume() {
            if (!state.running || !state.paused) return false;
            state.paused = false;
            record("letter_player_resumed", { index: state.index, total: state.total });
            log(`▶ 從第 ${state.index + 1} 張繼續。`);
            if (state.resumeGate) { const gate = state.resumeGate; state.resumeGate = null; gate(); }
            return true;
        }

        function stop() {
            if (!state.running) return;
            state.running = false;
            state.paused = false;
            clear();
            // 暫停中按「結束播放」：把停在暫停的那個 await 也放掉，play() 才會收尾
            if (state.resumeGate) { const gate = state.resumeGate; state.resumeGate = null; gate(); }
        }

        function isPlaying() { return state.running; }
        function isPaused() { return state.running && state.paused; }
        function progress() { return { index: state.index, total: state.total }; }

        return Object.freeze({ play, stop, pause, resume, isPlaying, isPaused, progress, preload });
    }

    global.LetterPlayer = Object.freeze({ create });
})(window);
