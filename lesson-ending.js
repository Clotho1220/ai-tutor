(function (global) {
    "use strict";

    const FAREWELL_RE = /\b(?:good\s*bye|bye(?:[\s-]*bye)?|see\s+you(?:\s+(?:next\s+time|soon|tomorrow|later))?)\b|再見|掰掰|拜拜|下次見/iu;
    const FRIENDLY_SEE_YOU_RE = /\b(?:good|nice|great|lovely|happy)\s+to\s+see\s+you\b/giu;
    // 引號裡的內容通常是「正在教的目標句／單字」，不是真的要下課。
    // 中英文引號都要涵蓋：「goodbye」、"Goodbye."、“Goodbye”
    const QUOTED_RE = /"[^"\r\n]{0,120}"|“[^”\r\n]{0,120}”|「[^」\r\n]{0,120}」|『[^』\r\n]{0,120}』/g;

    function create() {
        let finalStage = false;
        let turnText = "";
        let detected = false;
        let lessonTeachesFarewell = false;

        function resetSession() {
            finalStage = false;
            turnText = "";
            detected = false;
            lessonTeachesFarewell = false;
        }

        // 今天的教材本身若在教 goodbye／再見（例如 Book 1 Unit 1），
        // 這個詞在課堂中會不斷合理出現，就不能再拿它判斷「AI 想下課」。
        // 這種情況下只在最後的結語階段才承認道別。
        function setLessonTargets(targets) {
            lessonTeachesFarewell = (targets || []).some(target =>
                FAREWELL_RE.test(String(target == null ? "" : target)));
            return lessonTeachesFarewell;
        }

        function teachesFarewell() { return lessonTeachesFarewell; }

        function enterStage(isFinalStage) {
            finalStage = !!isFinalStage;
            turnText = "";
            detected = false;
        }

        function observe(text) {
            if (!text || detected) return { detected: false };
            turnText = (turnText + String(text)).slice(-6000);
            // 教材本身在教道別詞時，課中一律不判定；只有最後的結語階段才承認。
            if (lessonTeachesFarewell && !finalStage) return { detected: false };
            // 遮罩時保持字元位置不變，後面才能精準裁切學生字幕。
            // 先遮掉問候語（It's good to see you），再遮掉引號內的教學目標。
            const farewellCandidate = turnText
                .replace(FRIENDLY_SEE_YOU_RE, value => " ".repeat(value.length))
                .replace(QUOTED_RE, value => " ".repeat(value.length));
            const match = FAREWELL_RE.exec(farewellCandidate);
            if (!match) return { detected: false };
            detected = true;
            return {
                detected: true,
                finalStage,
                farewellEnd: match.index + match[0].length,
                phrase: match[0]
            };
        }

        function completeTurn(options) {
            const config = options || {};
            const isFinalStage = finalStage || !!config.finalStage;
            if (!detected) {
                turnText = "";
                return config.finishFinalTurn && isFinalStage ? "finish" : "continue";
            }
            const action = isFinalStage ? "finish" : "recover";
            turnText = "";
            detected = false;
            return action;
        }

        function inspect() {
            return { finalStage, detected, lessonTeachesFarewell };
        }

        return Object.freeze({
            resetSession, enterStage, setLessonTargets, teachesFarewell, observe, completeTurn, inspect
        });
    }

    global.LessonEndingGuard = Object.freeze({ create });
})(window);
