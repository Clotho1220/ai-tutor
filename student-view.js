(function (global) {
    "use strict";

    function create(options) {
        const config = options || {};
        const doc = config.document || global.document;
        const ImageCtor = config.ImageCtor || global.Image;
        const setTimer = config.setTimeoutFn || global.setTimeout.bind(global);
        const clearTimer = config.clearTimeoutFn || global.clearTimeout.bind(global);
        const timeoutMs = config.timeoutMs || 8000;

        const elements = {
            topics: doc.getElementById('svTopics'),
            welcome: doc.getElementById('svWelcomeImage'),
            image: doc.getElementById('svImage'),
            placeholder: doc.getElementById('svImagePlaceholder'),
            imageStatus: doc.getElementById('svImageStatus'),
            word: doc.getElementById('svWord'),
            meaning: doc.getElementById('svMeaning'),
            sayBox: doc.getElementById('svSayBox'),
            say: doc.getElementById('svSay'),
            transcript: doc.getElementById('svTranscript')
        };

        const state = {
            contentVersion: 0,
            imageRequest: 0,
            wordKey: "",
            imageWordKey: "",
            imageState: "idle",
            timeoutHandle: null,
            imageCallbacks: null
        };

        function normalize(value) {
            return String(value || "")
                .toLowerCase()
                .replace(/\([^)]*\)/g, "")
                .replace(/[.!?,;:'\"“”‘’]/g, "")
                .replace(/^(a|an|the)\s+/, "")
                .replace(/\s+/g, " ")
                .trim();
        }

        const SUBJECT_FILLER_WORDS = new Set([
            "a", "an", "the", "on", "in", "at", "of", "with", "and", "or", "for", "to",
            "near", "beside", "inside", "outside", "simple", "educational", "illustration",
            "picture", "cartoon", "white", "background"
        ]);

        function subjectTokens(value) {
            return normalize(value).split(" ").filter(token => token && !SUBJECT_FILLER_WORDS.has(token));
        }

        // 圖片提示通常比課本單字更長，例如「a red pencil on a desk」與
        // 「pencil (noun)」。只要較短一方的核心詞完整出現在另一方，就視為
        // 同一個教學內容；使用單字邊界可避免 pen 誤配 pencil。
        function sameSubject(left, right) {
            const leftKey = normalize(left);
            const rightKey = normalize(right);
            if (!leftKey || !rightKey) return false;
            if (leftKey === rightKey) return true;
            const leftTokens = subjectTokens(leftKey);
            const rightTokens = subjectTokens(rightKey);
            if (!leftTokens.length || !rightTokens.length) return false;
            const shorter = leftTokens.length <= rightTokens.length ? leftTokens : rightTokens;
            const longer = new Set(leftTokens.length <= rightTokens.length ? rightTokens : leftTokens);
            return shorter.every(token => longer.has(token));
        }

        function notify(callbacks, status, detail) {
            if (callbacks && typeof callbacks.onStatus === 'function') {
                callbacks.onStatus(status, detail || {});
            }
        }

        function cancelTimeout() {
            if (state.timeoutHandle != null) clearTimer(state.timeoutHandle);
            state.timeoutHandle = null;
        }

        function hideActualImage() {
            if (!elements.image) return;
            elements.image.style.display = 'none';
            elements.image.removeAttribute('src');
            elements.image.removeAttribute('aria-busy');
        }

        function showPlaceholder(icon, message, busy) {
            hideActualImage();
            if (elements.welcome) elements.welcome.style.display = 'none';
            if (elements.placeholder) {
                elements.placeholder.textContent = icon || '✨';
                elements.placeholder.style.display = 'block';
            }
            if (elements.imageStatus) {
                elements.imageStatus.textContent = message || "";
                elements.imageStatus.style.display = message ? 'block' : 'none';
            }
            if (elements.image && busy) elements.image.setAttribute('aria-busy', 'true');
        }

        function cancelPendingImage(reason) {
            if (state.imageCallbacks) {
                notify(state.imageCallbacks, 'cancelled', {
                    requestId: state.imageRequest,
                    contentVersion: state.contentVersion,
                    reason: reason || 'newer content replaced this image'
                });
                state.imageCallbacks = null;
            }
        }

        function invalidateImage(icon, message) {
            cancelPendingImage('newer content replaced this image');
            state.imageRequest += 1;
            state.imageWordKey = "";
            state.imageState = "idle";
            cancelTimeout();
            showPlaceholder(icon || '✨', message || "", false);
        }

        function setWordText(word, meaning, example, preserveDetails) {
            if (elements.word && word) elements.word.textContent = word;
            if (!preserveDetails) {
                if (elements.meaning) elements.meaning.textContent = meaning || "";
                if (elements.sayBox && elements.say) {
                    if (example) {
                        elements.say.textContent = example;
                        elements.sayBox.style.display = 'block';
                    } else {
                        elements.say.textContent = "";
                        elements.sayBox.style.display = 'none';
                    }
                }
            } else {
                if (meaning && elements.meaning) elements.meaning.textContent = meaning;
                if (example && elements.sayBox && elements.say) {
                    elements.say.textContent = example;
                    elements.sayBox.style.display = 'block';
                }
            }
        }

        function hideTopics() {
            if (elements.topics) elements.topics.style.display = 'none';
        }

        function showTopics(topics) {
            if (!elements.topics || !Array.isArray(topics) || !topics.length) return;
            elements.topics.replaceChildren();
            topics.slice(0, 5).forEach((topic, index) => {
                const card = doc.createElement('div');
                card.className = 'topic';
                const number = doc.createElement('span');
                number.className = 'num';
                number.textContent = String(index + 1);
                const label = doc.createElement('span');
                label.textContent = String(topic);
                card.append(number, label);
                elements.topics.appendChild(card);
            });
            elements.topics.style.display = 'flex';
            state.contentVersion += 1;
            state.wordKey = "";
            invalidateImage('📰', "");
            setWordText("想聊哪一個？", "", "", false);
        }

        function showWord(word, meaning, example) {
            const key = normalize(word);
            if (word) hideTopics();
            if (key && state.wordKey && sameSubject(key, state.wordKey)) {
                // log_vocabulary 與 show_image 的字串不必完全相同；保留同題材的載入中圖片。
                setWordText(word, meaning, example, true);
                return state.contentVersion;
            }
            if (key && key !== state.wordKey) {
                state.contentVersion += 1;
                state.wordKey = key;
                invalidateImage('✨', "");
                setWordText(word, meaning, example, false);
                return state.contentVersion;
            }

            // show_image and log_vocabulary can arrive in either order. When they
            // refer to the same word, only fill in details; never clear its image.
            setWordText(word, meaning, example, true);
            return state.contentVersion;
        }

        function retryUrl(url) {
            const separator = String(url).includes('?') ? '&' : '?';
            return `${url}${separator}seed=${Date.now()}`;
        }

        function showImage(url, keyword, callbacks) {
            const key = normalize(keyword);
            hideTopics();

            const matchesCurrentWord = key && state.wordKey && sameSubject(key, state.wordKey);
            if (key && key !== state.wordKey && !matchesCurrentWord) {
                state.contentVersion += 1;
                state.wordKey = key;
                invalidateImage('✨', "");
                setWordText(keyword, "", "", false);
            } else if (keyword && elements.word && !matchesCurrentWord) {
                elements.word.textContent = keyword;
            }

            cancelPendingImage('a newer image request replaced this image');
            cancelTimeout();
            const requestId = ++state.imageRequest;
            const contentVersion = state.contentVersion;
            state.imageWordKey = key;
            state.imageState = "loading";
            state.imageCallbacks = callbacks || null;
            showPlaceholder('🎨', '圖片準備中…', true);
            notify(callbacks, 'loading', { requestId, contentVersion, keyword, url });

            function isCurrent() {
                return requestId === state.imageRequest &&
                    contentVersion === state.contentVersion &&
                    sameSubject(key, state.wordKey) && key === state.imageWordKey;
            }

            function load(candidateUrl, attempt) {
                const loader = new ImageCtor();
                loader.onload = function () {
                    if (!isCurrent()) return;
                    cancelTimeout();
                    state.imageState = "ready";
                    if (elements.image) {
                        elements.image.src = candidateUrl;
                        elements.image.alt = keyword ? `教學圖片：${keyword}` : '教學圖片';
                        elements.image.style.display = 'block';
                        elements.image.removeAttribute('aria-busy');
                    }
                    if (elements.placeholder) elements.placeholder.style.display = 'none';
                    if (elements.imageStatus) elements.imageStatus.style.display = 'none';
                    notify(callbacks, 'ready', { requestId, contentVersion, keyword, url: candidateUrl });
                    state.imageCallbacks = null;
                };
                loader.onerror = function () {
                    if (!isCurrent()) return;
                    if (attempt === 0) {
                        const nextUrl = retryUrl(url);
                        state.imageState = "retrying";
                        showPlaceholder('🎨', '圖片重新準備中…', true);
                        notify(callbacks, 'retrying', { requestId, contentVersion, keyword, url: nextUrl });
                        load(nextUrl, 1);
                        return;
                    }
                    cancelTimeout();
                    state.imageState = "error";
                    showPlaceholder('🖼️', '圖片暫時無法顯示，先練習單字吧！', false);
                    notify(callbacks, 'error', { requestId, contentVersion, keyword, url: candidateUrl });
                    state.imageCallbacks = null;
                };
                loader.src = candidateUrl;
            }

            state.timeoutHandle = setTimer(function () {
                if (!isCurrent() || (state.imageState !== 'loading' && state.imageState !== 'retrying')) return;
                state.imageState = "slow";
                showPlaceholder('🖼️', '圖片還在準備，先練習單字吧！', true);
                notify(callbacks, 'slow', { requestId, contentVersion, keyword, url });
            }, timeoutMs);

            load(url, 0);
            return { requestId, contentVersion };
        }

        function beginTranscriptTurn() {
            if (!elements.transcript) return;
            elements.transcript.textContent = "";
            elements.transcript.style.display = 'block';
        }

        function appendTranscript(value) {
            if (!elements.transcript) return "";
            elements.transcript.textContent += String(value || "");
            elements.transcript.style.display = 'block';
            elements.transcript.scrollTop = elements.transcript.scrollHeight;
            return elements.transcript.textContent;
        }

        function transcriptText() {
            return elements.transcript ? elements.transcript.textContent : "";
        }

        function truncateTranscript(index) {
            if (!elements.transcript || index < 0) return;
            elements.transcript.textContent = elements.transcript.textContent.slice(0, index).trimEnd();
        }

        function reset() {
            state.contentVersion += 1;
            state.wordKey = "";
            invalidateImage('🎈', "");
            if (elements.topics) {
                elements.topics.replaceChildren();
                elements.topics.style.display = 'none';
            }
            if (elements.word) elements.word.textContent = "";
            setWordText("", "", "", false);
            if (elements.placeholder) elements.placeholder.style.display = 'none';
            if (elements.welcome) elements.welcome.style.display = 'block';
            beginTranscriptTurn();
        }

        function inspectState() {
            return {
                contentVersion: state.contentVersion,
                imageRequest: state.imageRequest,
                wordKey: state.wordKey,
                imageWordKey: state.imageWordKey,
                imageState: state.imageState
            };
        }

        return Object.freeze({
            showTopics,
            hideTopics,
            showWord,
            showImage,
            beginTranscriptTurn,
            appendTranscript,
            transcriptText,
            truncateTranscript,
            reset,
            inspectState
        });
    }

    global.StudentView = Object.freeze({ create });
})(window);
