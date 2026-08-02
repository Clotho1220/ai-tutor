(function (global) {
    "use strict";

    function create(options) {
        options = options || {};
        const requiredRounds = Math.max(1, Number(options.requiredRounds || 2));
        let pending = false;
        let studentTurns = 0;
        let completedRounds = 0;

        function request() {
            if (!pending) {
                pending = true;
                studentTurns = 0;
                completedRounds = 0;
            }
            return inspect();
        }

        function noteStudentTurn() {
            if (pending) studentTurns += 1;
            return inspect();
        }

        // 只有完整的「學生說完 → AI 回完」才算一回合。
        // 如果 AI 又邀請學生複誦，無論已經過幾回合都繼續等待。
        function completeAiTurn(details) {
            if (!pending || completedRounds >= studentTurns) return false;
            completedRounds += 1;
            const practiceRequested = !!(details && details.practiceRequested);
            return completedRounds >= requiredRounds && !practiceRequested;
        }

        function consume() {
            const wasPending = pending;
            pending = false;
            studentTurns = 0;
            completedRounds = 0;
            return wasPending;
        }

        function inspect() {
            return { pending, studentTurns, completedRounds, requiredRounds };
        }

        return { request, noteStudentTurn, completeAiTurn, consume, inspect };
    }

    global.StageTransitionGate = { create };
})(window);
