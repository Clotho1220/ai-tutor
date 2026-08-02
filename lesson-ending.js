(function (global) {
    "use strict";

    const FAREWELL_RE = /\b(?:good\s*bye|bye(?:[\s-]*bye)?|see\s+you(?:\s+(?:next\s+time|soon|tomorrow))?)\b|再見|掰掰|拜拜|下次見/iu;

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
            const match = FAREWELL_RE.exec(turnText);
            if (!match) return { detected: false };
            detected = true;
            return {
                detected: true,
                finalStage,
                farewellEnd: match.index + match[0].length,
                phrase: match[0]
            };
        }

        function completeTurn() {
            if (!detected) {
                turnText = "";
                return "continue";
            }
            const action = finalStage ? "finish" : "recover";
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
