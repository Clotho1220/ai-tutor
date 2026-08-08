(function (global) {
    "use strict";

    const HAN_RE = /[\u3400-\u9fff]/;
    const DIRECTOR_RE = /\[?\s*DIRECTOR\s*NOTE/i;
    const CUE_RE = /(you can(?: also)? say|try saying|say this|say:|repeat after me|say after me|a better way to say(?: it)? is|the natural (?:way|phrasing) is|it's better to say|你可以(?:這樣)?說|英文(?:可以)?說|更自然(?:的說法)?是|正確(?:的說法)?是|跟(?:著)?我(?:說|念))/i;
    const ALTERNATIVE_RE = /(you can also say|another way|more natural|more idiomatic|也可以說|另一種|更自然)/i;
    const PRACTICE_INVITE_RE = /(please\s+repeat|repeat\s+(?:after me|it|this)|try\s+(?:it|saying)|your\s+turn|can\s+you\s+say|say\s+it|跟我說|說說看|試著說|再說一次|念一次|要不要試試|換你說)/i;
    const STRONG_REPEAT_RE = /(please\s+repeat|repeat\s+(?:after\s+me|it|this)|try\s+(?:it|saying)|your\s+turn|say\s+it\s+again|跟我說|說說看|再說一次|念一次|試試看(?:這句)?|要不要試試|換你說)/i;
    // 只放「通常出現在示範句之後」的交棒語。像 "repeat after me"、"try saying"
    // 也可能出現在示範句之前，若在串流中提早截斷，反而會讓孩子聽不到目標句。
    const STREAM_REPEAT_RE = /(try\s+it|say\s+it\s+again|再\s*說\s*一次|念\s*一次|試試\s*看(?:\s*這\s*句)?|要\s*不要\s*試試|換\s*你\s*說)/i;

    function clean(value) {
        return String(value == null ? "" : value)
            .replace(/[“”]/g, '"')
            // Gemini 的中文逐字稿偶爾會在中文字之間插入空白（例如「試試 看」）。
            .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, "$1")
            .replace(/\s+/g, " ")
            .trim();
    }

    function englishWordCount(value) {
        const words = String(value || "").match(/[A-Za-z]+(?:['’][A-Za-z]+)?/g);
        return words ? words.length : 0;
    }

    function validSentence(value) {
        return englishWordCount(value) >= 2 && String(value || "").length <= 240;
    }

    function tidySentence(value) {
        let sentence = clean(value)
            .replace(/^[\s"':,;-]+/, "")
            .replace(/[\s"']+$/, "")
            .trim();
        if (!sentence) return "";
        // 去除邀請複誦的尾巴，但保留示範句本身的標點。
        sentence = sentence.replace(/\s*(?:please\s+repeat|try\s+it|your\s+turn|換你說|要不要試試.*|請跟我說.*)$/i, "").trim();
        return validSentence(sentence) ? sentence : "";
    }

    function quotedSentenceAfter(text, startIndex) {
        const quoteRe = /"([^"\r\n]{2,240})"/g;
        quoteRe.lastIndex = Math.max(0, startIndex || 0);
        let match;
        while ((match = quoteRe.exec(text))) {
            const candidate = tidySentence(match[1]);
            if (candidate) return candidate;
        }
        return "";
    }

    function sentenceAfterCue(text, cueMatch) {
        // 提示語之後可能只隔一個空白（"You can say I am happy."）、也可能帶冒號或逗號。
        // 舊版只吃掉標點、沒吃掉前導空白，導致無引號的示範句一律抓不到。
        const tail = text.slice(cueMatch.index + cueMatch[0].length).replace(/^[\s:：,，.、-]+/, "");
        const quoted = quotedSentenceAfter(tail, 0);
        if (quoted) return quoted;
        const match = tail.match(/^([A-Za-z][A-Za-z0-9'’\- ,]+[.!?])/);
        return match ? tidySentence(match[1]) : "";
    }

    function sentenceBeforeRepeat(text) {
        const repeat = text.search(STRONG_REPEAT_RE);
        if (repeat < 0) return "";
        const prefix = text.slice(0, repeat).trim();
        const quoted = quotedSentenceAfter(prefix, 0);
        if (quoted) return quoted;
        const sentences = prefix.match(/[A-Za-z][^.!?\r\n]{1,220}[.!?]/g) || [];
        for (let i = sentences.length - 1; i >= 0; i -= 1) {
            const candidate = tidySentence(sentences[i]);
            if (candidate) return candidate;
        }
        return "";
    }

    function asksForPractice(aiText) {
        return PRACTICE_INVITE_RE.test(clean(aiText));
    }

    // 句型家族比對前先把縮寫還原。
    // 少了這一步，"I'm happy" 與 "I am happy" 會被當成兩個不同家族，
    // 重複練習的計數永遠到不了門檻，變異限制器等於失效。
    function expandContractions(value) {
        return String(value == null ? "" : value)
            .replace(/[’]/g, "'")
            .replace(/\bi'm\b/gi, "i am")
            .replace(/\b(he|she|it|that|what|who|there|here)'s\b/gi, "$1 is")
            .replace(/\b(you|we|they)'re\b/gi, "$1 are")
            .replace(/\b(i|you|he|she|it|we|they)'ve\b/gi, "$1 have")
            .replace(/\b(i|you|he|she|it|we|they)'ll\b/gi, "$1 will")
            .replace(/\b(i|you|he|she|it|we|they)'d\b/gi, "$1 would")
            .replace(/\bcan't\b/gi, "cannot")
            .replace(/\b(do|does|did|is|are|was|were|has|have|had|would|could|should|wo)n't\b/gi, "$1 not");
    }

    function sentenceFamily(value) {
        let sentence = expandContractions(clean(value)).toLowerCase()
            .replace(/[.!?]+$/g, "")
            .replace(/\b(?:i|you|he|she|it|we|they|[a-z]+)\s+(?:am|is|are)\b/, "<subject> be")
            .replace(/\b(?:my|your|his|her|our|their)\s+[a-z]+\b/, "<possessive noun>")
            .replace(/\s+/g, " ")
            .trim();
        return sentence.slice(0, 160);
    }

    function createTurnBoundary() {
        let text = "";
        let detected = false;

        function observe(chunk) {
            if (!chunk || detected) return { detected: false };
            // 保留原始逐字稿的字元位置，讓學生字幕能精準裁在邀請語結尾；
            // 中文模式本身允許 Gemini 在每個字之間插入空白。
            text = (text + String(chunk)).replace(/[“”]/g, '"').slice(-6000);
            const match = STREAM_REPEAT_RE.exec(text);
            if (!match) return { detected: false };
            detected = true;
            return {
                detected: true,
                invitationEnd: match.index + match[0].length,
                phrase: match[0]
            };
        }

        function completeTurn() {
            const wasDetected = detected;
            text = "";
            detected = false;
            return wasDetected;
        }

        function reset() {
            text = "";
            detected = false;
        }

        return Object.freeze({ observe, completeTurn, reset });
    }

    function analyze(input) {
        const userText = clean(input && input.userText);
        const aiText = clean(input && input.aiText);
        if (!userText || !aiText || DIRECTOR_RE.test(aiText)) return null;

        const cue = CUE_RE.exec(aiText);
        let suggestion = cue ? sentenceAfterCue(aiText, cue) : "";
        // 若已有教學提示但其後不是完整句子（例如只有 "pencil"），
        // 不要再把整段「You can say ...」誤當成示範句。
        if (!suggestion && !cue) suggestion = sentenceBeforeRepeat(aiText);
        if (!suggestion) return null;

        return {
            original: userText.slice(0, 500),
            suggestion,
            kind: HAN_RE.test(userText) ? "translated" : (ALTERNATIVE_RE.test(aiText) ? "alternative" : "corrected"),
            focus: ""
        };
    }

    global.PracticeObserver = { analyze, asksForPractice, sentenceFamily, createTurnBoundary };
})(window);
