(function (global) {
    "use strict";

    const FAREWELL_RE = /\b(?:good\s*bye|bye(?:[\s-]*bye)?|see\s+you(?:\s+(?:next\s+time|soon|tomorrow|later))?)\b|再見|掰掰|拜拜|下次見/iu;
    const FRIENDLY_SEE_YOU_RE = /\b(?:good|nice|great|lovely|happy)\s+to\s+see\s+you\b/giu;

    function create() {
        let finalStage = false;
        let turnText = "";
        let detected = false;

        function resetSession() {
            finalStage = false;
            turnText = "";
            detected = false;
        }

        function enterStage(isFinalStage) {
            finalStage = !!isFinalStage;
            turnText = "";
            detected = false;
        }

        function observe(text) {
            if (!text || detected) return { detected: false };
            turnText = (turnText + String(text)).slice(-6000);
            // Keep character positions stable while masking greetings such as
            // "It's good to see you", so a later real farewell is still detectable.
            const farewellCandidate = turnText.replace(FRIENDLY_SEE_YOU_RE, value => " ".repeat(value.length));
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
            return { finalStage, detected };
        }

        return Object.freeze({ resetSession, enterStage, observe, completeTurn, inspect });
    }

    global.LessonEndingGuard = Object.freeze({ create });
})(window);
