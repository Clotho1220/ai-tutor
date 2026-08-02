(function (global) {
    "use strict";

    const HAN_RE = /[\u3400-\u9fff]/;
    const DIRECTOR_RE = /\[?\s*DIRECTOR\s*NOTE/i;
    const CUE_RE = /(you can(?: also)? say|try saying|say this|say:|a better way to say(?: it)? is|the natural (?:way|phrasing) is|it's better to say|你可以(?:這樣)?說|英文(?:可以)?說|更自然(?:的說法)?是|正確(?:的說法)?是)/i;
    const ALTERNATIVE_RE = /(you can also say|another way|more natural|more idiomatic|也可以說|另一種|更自然)/i;
    const PRACTICE_INVITE_RE = /(please\s+repeat|repeat\s+(?:after me|it|this)|try\s+(?:it|saying)|your\s+turn|can\s+you\s+say|say\s+it|跟我說|說說看|試著說|再說一次|念一次|要不要試試|換你說)/i;
    const STRONG_REPEAT_RE = /(please\s+repeat|repeat\s+after\s+me|try\s+it|say\s+it\s+again|跟我說|再說一次|念一次|試試看這句|要不要試試)/i;

    function clean(value) {
        return String(value == null ? "" : value).replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
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
        const tail = text.slice(cueMatch.index + cueMatch[0].length).replace(/^\s*[:：,，-]\s*/, "");
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

    global.PracticeObserver = { analyze, asksForPractice };
})(window);
