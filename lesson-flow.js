// 課程流程控制器（v3.50，AI-STABILITY P0-3 / P1-1 / P1-2 / P1-3）。
//
// 這一層決定「現在做到哪、下一步做什麼」，模型只負責演出來。以前這些邏輯散在 app.js 的
// recordItemResult / advancePlan / planFallbackAfterTurn / recoverSilentPlanTurn / handleOffScriptReport
// 裡，各自用 target 文字與時序推測回報屬於哪一題，也各自重試一次，疊起來就是「越修越多輪」。
//
// 現在：
//   • 每一題、每一次作答、每一次指令都有識別碼（itemId / attemptId / directiveId），
//     連線也有世代（connectionEpoch）。回報要帶 attemptId，程式驗證，不信任模型自報。
//   • 同一個作答只結算一次：重送的工具呼叫、不同呼叫重報同一 attempt、上一題遲到、舊連線遲到、
//     連按點選——全部擋掉，並記進診斷。
//   • 恢復（沉默重送、補問、偏離重送、跳針、重連重送）共用一個有上限的預算；
//     用完就進「可恢復畫面」，不無聲跳過，也不把系統失敗算成孩子答錯。
//   • 回傳的都是「動作清單」，由 app.js 執行（送指令、記事件、換畫面），這裡不碰 DOM 也不碰網路，
//     所以可以用事件重播做零 API 成本測試。
(function (global) {
    "use strict";

    const OUTCOMES = ["correct", "incorrect", "no_response"];
    const PHASES = Object.freeze({
        IDLE: "IDLE", OPENING: "OPENING", PRESENTING: "PRESENTING", WAITING_SPEECH: "WAITING_SPEECH",
        WAITING_TAP: "WAITING_TAP", EVALUATING: "EVALUATING", FEEDBACK: "FEEDBACK",
        RECOVERING: "RECOVERING", CLOSING: "CLOSING", ENDED: "ENDED", BLOCKED: "BLOCKED"
    });
    const DEFAULT_BUDGET = Object.freeze({
        silentPerItem: 1, nudgePerItem: 1, offScriptPerItem: 1, repetitionPerItem: 1,
        reconnectPerItem: 2, helpPerItem: 2, session: 8
    });

    function text(value) { return String(value == null ? "" : value).trim(); }

    // ---- 回報文字與項目的內容核對（保留為「核對」，不再是身分依據） ----
    function normalizeTarget(value) {
        return String(value || "").toLowerCase()
            .replace(/\([^)]*\)/g, " ")
            .replace(/[^a-z0-9']+/g, " ")
            .replace(/\s+/g, " ").trim();
    }

    function targetsOverlap(reported, rawCandidates) {
        const report = normalizeTarget(reported);
        if (!report) return false;
        return rawCandidates.map(normalizeTarget).filter(Boolean).some(candidate =>
            report === candidate || report.indexOf(candidate) >= 0 || candidate.indexOf(report) >= 0);
    }

    // 填字母題模型常回報「e c l」（缺的字母）或完整字，拼字題回報「s-i-n-g」，都算同一項
    function rawCandidates(item) {
        if (!item) return [];
        return [item.target, item.display, item.ask, item.slotWord,
                item.answerDisplay, item.missing, item.letters]
            .concat(item.alternatives || [])
            .map(value => text(value)).filter(Boolean);
    }

    function textMatchesItem(reported, item) {
        const raw = rawCandidates(item);
        if (!raw.length) return null;                         // 開場、結尾：無法核對
        const verifiable = raw.filter(candidate => !/\[[^\]]+\]/.test(candidate));
        if (targetsOverlap(reported, verifiable)) return true;
        if (raw.some(candidate => /\[[^\]]+\]/.test(candidate))) return null;   // 佔位符模板核不了
        return false;
    }

    function create(options) {
        const config = options || {};
        const runner = config.runner;
        const now = config.nowFn || (() => Date.now());
        const isTapItem = config.isTapItem || (() => false);
        const directiveFor = config.directiveFor || (() => "");
        const revealFor = config.revealFor || null;
        const budget = Object.assign({}, DEFAULT_BUDGET, config.budget || {});
        const sessionId = text(config.sessionId) || ("s" + now());
        if (!runner) throw new Error("LessonFlow needs a runner");

        let epoch = Number(config.connectionEpoch) || 0;
        let phase = PHASES.IDLE;
        let directiveSeq = 0;
        let current = null;          // 目前這一題／這一次作答的狀態（見 prepareItem）
        let lastCompleted = null;
        let blocked = false;
        const recovery = { used: 0, byItem: {}, byKind: {} };
        const settledAttempts = new Set();
        const seenToolCalls = new Set();
        const validResults = [];
        const rawReports = [];
        const protocolErrors = [];

        function ev(name, details) { return { type: "event", name, details: details || {} }; }
        function log(message) { return { type: "log", message }; }

        function itemBudget(itemId) {
            if (!recovery.byItem[itemId]) recovery.byItem[itemId] = {};
            return recovery.byItem[itemId];
        }

        // 恢復預算：每題每種最多 N 次，整堂最多 budget.session 次。
        // 整堂用完一律進 BLOCKED（不再自動重送）；每題用完由呼叫端決定：
        // 沉默／跳針／重連沒得退，也 BLOCKED；補問用完改標 unverified 前進、偏離用完跳過。
        function tryRecover(kind, perItemLimit, blockOnItemLimit) {
            if (!current) return false;
            const bucket = itemBudget(current.itemId);
            const usedForKind = bucket[kind] || 0;
            if (recovery.used >= budget.session || (usedForKind >= perItemLimit && blockOnItemLimit)) {
                blocked = true;
                phase = PHASES.BLOCKED;
                return false;
            }
            if (usedForKind >= perItemLimit) return false;
            bucket[kind] = usedForKind + 1;
            recovery.used += 1;
            recovery.byKind[kind] = (recovery.byKind[kind] || 0) + 1;
            return true;
        }

        function blockedActions(kind) {
            return [
                ev("plan_recovery_exhausted", { id: current ? current.itemId : "", kind, used: recovery.used, budget: budget.session }),
                log(`🛑 系統恢復次數已達上限（${kind}），停止自動重送，等家長選擇重試或跳過。`),
                { type: "blocked", reason: kind, item: current ? current.item : null }
            ];
        }

        function visibleFor(item, attempts) {
            if (!revealFor) return null;
            const reveal = revealFor(item, attempts) || {};
            const visible = [];
            if (reveal.image) visible.push("picture");
            if (reveal.english) visible.push("english");
            if (reveal.chinese) visible.push("chinese");
            if (reveal.tap) visible.push("tap-options");
            const hidden = ["english", "chinese"].filter(name => visible.indexOf(name) < 0);
            return { visible, hidden };
        }

        // 最小上下文快照（P1-1）：只放「現在做到哪」，不放尚未揭露的答案或未來題目。
        function stateLine() {
            if (!current) return "";
            const progress = runner.progress();
            const item = current.item;
            const tap = current.tapItem;
            const shown = (item.type === "opening" || item.type === "closing") ? null : visibleFor(item, progress.attempts);
            const parts = [
                `session=${sessionId}`, `epoch=${epoch}`,
                `item=${progress.index + 1}/${progress.total}`, `itemId=${item.id}`, `type=${item.type}`,
                `attemptId=${current.attemptId}`, `attempt=${current.attemptNo}/${Math.max(1, Number(item.maxAttempts) || 1)}`,
                `input=${tap ? "tap" : "speech"}`,
                `answered=${current.studentAnsweredTurn != null ? "yes" : "no"}`
            ];
            if (shown) {
                parts.push(`visible=[${shown.visible.join(",") || "none"}]`);
                if (shown.hidden.length) parts.push(`hidden=[${shown.hidden.join(",")}]`);
            }
            let tail = "";
            if (tap) tail = " (input=tap: ask, then wait; the system judges the tap — do not report.)";
            else if (item.type === "opening") tail = " (the system moves on as soon as the learner replies — no report needed.)";
            else if (item.type === "closing") tail = " (say the closing; no report.)";
            else tail = ` (when you report this answer, pass attemptId="${current.attemptId}".)`;
            return "[STATE " + parts.join(" ") + "]" + tail + " ";
        }

        function directiveBody(prefix) {
            return stateLine() + text(prefix ? prefix + " " : "") + directiveFor(current.item, runner.progress());
        }

        function directiveAction(reason, prefix) {
            return {
                type: "directive",
                directiveId: current.directiveId,
                itemId: current.itemId,
                attemptId: current.attemptId,
                item: current.item,
                attempts: runner.progress().attempts,
                reason,
                body: directiveBody(prefix)
            };
        }

        // 準備目前這一題的下一次作答（新題或同題的下一階）
        function prepareItem(reason) {
            const item = runner.current();
            if (!item) {
                current = null;
                phase = PHASES.ENDED;
                return [ev("plan_completed", { snapshot: runner.snapshot() }), { type: "finished" }];
            }
            const attemptNo = runner.progress().attempts + 1;
            directiveSeq += 1;
            current = {
                item, itemId: item.id, attemptNo,
                attemptId: `${item.id}#a${attemptNo}`,
                directiveId: `d${directiveSeq}`,
                delivered: false, deliveredEpoch: null, sentTurn: null,
                spoke: false, studentAnsweredTurn: null, settled: false,
                tapItem: isTapItem(item), tap: null, tapPicked: [], tapLocked: false,
                helpCount: 0
            };
            phase = item.type === "opening" ? PHASES.OPENING
                : item.type === "closing" ? PHASES.CLOSING : PHASES.PRESENTING;
            const actions = [];
            if (reason === "present") {
                actions.push(ev("plan_item_sent", {
                    id: item.id, type: item.type, target: item.target || "",
                    index: runner.progress().index, total: runner.progress().total,
                    attempt: attemptNo, attemptId: current.attemptId, directiveId: current.directiveId
                }));
            }
            actions.push(directiveAction(reason));
            return actions;
        }

        function start() {
            if (phase !== PHASES.IDLE) return [];
            return prepareItem("present");
        }

        // app.js 真的把指令送出去的那一刻呼叫（排隊中的不算）
        function directiveSent(directiveId, context) {
            if (!current || current.directiveId !== directiveId) return false;
            const ctx = context || {};
            if (ctx.epoch != null && Number(ctx.epoch) > epoch) epoch = Number(ctx.epoch);   // 連線世代以實際送出時為準
            current.delivered = true;
            current.deliveredEpoch = ctx.epoch == null ? epoch : Number(ctx.epoch);
            current.sentTurn = ctx.studentTurn == null ? null : Number(ctx.studentTurn);
            current.spoke = false;
            if (phase === PHASES.RECOVERING || phase === PHASES.BLOCKED) {
                phase = current.item.type === "opening" ? PHASES.OPENING
                    : current.item.type === "closing" ? PHASES.CLOSING : PHASES.PRESENTING;
            }
            return true;
        }

        // 點選題：這一階的選項（由 revealFor 給），app 在畫卡片時設定
        function setTap(tap) {
            if (!current) return;
            current.tap = tap || null;
            current.tapPicked = [];
            current.tapLocked = false;
        }

        // AI 這一輪講了話／出了聲（逐字稿或音訊事件都算）
        function aiSpoke() {
            if (!current || !current.delivered) return;
            current.spoke = true;
            if (phase === PHASES.PRESENTING) phase = current.tapItem ? PHASES.WAITING_TAP : PHASES.WAITING_SPEECH;
        }

        // 學生按了「說完了」
        function studentTurnEnded(turnNo) {
            const actions = [];
            if (!current || !current.delivered) return actions;
            const turn = Number(turnNo);
            if (current.tapItem && !current.tapLocked) {
                actions.push({ type: "tap_waiting", item: current.item, tap: current.tap });
                return actions;
            }
            if (phase === PHASES.OPENING) {
                current.studentAnsweredTurn = turn;
                actions.push(ev("plan_opening_answered", { turn }));
                return actions.concat(settle("done", "opening_answered"));
            }
            if (phase === PHASES.CLOSING || phase === PHASES.ENDED) return actions;
            if (current.settled) return actions;
            current.studentAnsweredTurn = turn;
            phase = PHASES.EVALUATING;
            actions.push({ type: "phase", phase });
            return actions;
        }

        // 結算一次作答（唯一入口）
        function settle(outcome, source) {
            if (!current || current.settled) return [];
            const before = current;
            before.settled = true;
            settledAttempts.add(before.attemptId);
            const result = runner.recordAttempt(outcome);
            const actions = [ev("plan_attempt", {
                id: before.itemId, attemptId: before.attemptId, outcome, source,
                advanced: !!result.advanced, attempts: result.attempts || null
            })];
            if (before.item.type !== "opening" && before.item.type !== "closing") {
                validResults.push({
                    at: new Date(now()).toISOString(), itemId: before.itemId, attemptId: before.attemptId,
                    target: before.item.target || "", type: before.item.type, outcome, source
                });
            }
            if (result.advanced) {
                lastCompleted = result.item || before.item;
                if (result.item && /^word_/.test(result.item.type)) actions.push({ type: "item_done", item: result.item });
                return actions.concat(prepareItem("present"));
            }
            // 同一項升到下一階：新的作答＝新的 attemptId
            actions.push(log(`🔁 同一項升到第 ${result.attempts + 1} 階（共 ${before.item.maxAttempts} 階）。`));
            return actions.concat(prepareItem("ladder"));
        }

        function protocolError(kind, report, message, extra) {
            const entry = Object.assign({ kind, reported: text(report.target), attemptId: report.attemptId || "",
                expected: current ? current.attemptId : "", message }, extra || {});
            protocolErrors.push(entry);
            return ev("plan_report_protocol_error", entry);
        }

        // ---- 模型的回報（P0-3） ----
        function handleReport(input) {
            const report = input || {};
            const target = text(report.target).slice(0, 200);
            const reportedAttempt = text(report.attemptId);
            const actions = [];
            rawReports.push({ at: new Date(now()).toISOString(), target, outcome: text(report.outcome),
                attemptId: reportedAttempt, toolCallId: text(report.toolCallId), epoch: report.epoch });
            actions.push(ev("item_report_raw", { target, outcome: text(report.outcome), attemptId: reportedAttempt,
                toolCallId: text(report.toolCallId) || null, epoch: report.epoch == null ? null : report.epoch }));

            function reject(verdict, message, eventName, extra) {
                actions.push(ev(eventName || "plan_report_ignored", Object.assign({
                    reported: target, attemptId: reportedAttempt, expected: current ? current.attemptId : "", reason: verdict
                }, extra || {})));
                return { verdict, message, actions };
            }

            if (report.toolCallId) {
                const callKey = text(report.toolCallId);
                if (seenToolCalls.has(callKey)) return reject("duplicate_call", "ignored: duplicate tool call");
                seenToolCalls.add(callKey);
            }
            if (report.epoch != null && Number(report.epoch) < epoch) {
                return reject("stale_epoch", "ignored: report from a previous connection");
            }
            if (!current || phase === PHASES.ENDED) return reject("finished", "ignored: lesson finished");
            if (reportedAttempt && settledAttempts.has(reportedAttempt) && reportedAttempt !== current.attemptId) {
                return reject("attempt_settled", `ignored: ${reportedAttempt} was already recorded`);
            }
            if (!current.delivered) {
                // 目前這一題的指令還沒送出：這筆一定是上一題慢半拍的回報
                return reject("late_previous", "ignored: that attempt was already recorded");
            }
            if (current.item.type === "closing") return reject("closing", "ignored: closing stage, nothing to report");
            if (current.item.type === "opening") {
                if (current.settled) return reject("late_previous", "ignored: already moved on");
                if (current.studentAnsweredTurn == null) return reject("no_attempt", "ignored: the learner has not replied yet; wait for them");
                actions.push(ev("plan_opening_reported", {}));
                return { verdict: "accepted", message: "opening recorded", actions: actions.concat(settle("done", "opening_reported")) };
            }
            if (current.tapItem) {
                actions.push(log(`↩️ 這一題由孩子點選作答，不採用模型的回報「${target}」。`));
                return reject("tap_item", "ignored: this item is answered by tapping; the system judges it", "plan_report_ignored", { reason: "tap_item" });
            }
            if (current.settled) return reject("late_previous", "ignored: this attempt was already recorded");

            const outcome = OUTCOMES.indexOf(text(report.outcome)) >= 0 ? text(report.outcome) : null;
            if (!outcome) {
                actions.push(protocolError("invalid_outcome", report, "outcome must be correct, incorrect or no_response"));
                return { verdict: "invalid_outcome", message: `rejected: outcome must be one of ${OUTCOMES.join("|")}; resend with attemptId="${current.attemptId}"`, actions };
            }
            if (!reportedAttempt || reportedAttempt !== current.attemptId) {
                // 識別碼缺或錯：先記協定錯誤，不用文字模糊比對偷偷接受。
                // 文字只拿來分辨「上一題遲到」還是「模型自己跑去教別的」。
                const matchesLast = lastCompleted && targetsOverlap(target, rawCandidates(lastCompleted));
                const matchesCurrent = textMatchesItem(target, current.item);
                actions.push(protocolError(reportedAttempt ? "wrong_attempt_id" : "missing_attempt_id", report,
                    `current attemptId is ${current.attemptId}`, { matchesCurrent, matchesLast: !!matchesLast }));
                if (matchesLast && matchesCurrent !== true) {
                    return { verdict: "late_previous", message: "ignored: that attempt was already recorded", actions };
                }
                if (matchesCurrent === false && current.studentAnsweredTurn != null) {
                    return { verdict: "off_script", message: `ignored: stay on the current item; report with attemptId="${current.attemptId}"`,
                        actions: actions.concat(offScript(target)) };
                }
                return { verdict: reportedAttempt ? "wrong_attempt_id" : "missing_attempt_id",
                    message: `rejected: resend this report with attemptId="${current.attemptId}"`, actions };
            }
            if (current.studentAnsweredTurn == null) {
                return reject("no_attempt", "ignored: the learner has not answered this item yet; ask and wait");
            }
            const contentMatch = textMatchesItem(target, current.item);
            if (contentMatch === false) {
                actions.push(ev("plan_report_target_mismatch", { reported: target, expected: current.item.target || current.itemId, attemptId: current.attemptId }));
            }
            actions.push(ev("item_result", {
                itemId: current.itemId, attemptId: current.attemptId, target, outcome,
                studentSaid: text(report.studentSaid).slice(0, 300), kind: text(report.kind || current.item.type).slice(0, 40),
                issue: text(report.issue).slice(0, 200), attempt: current.attemptNo
            }));
            return { verdict: "accepted", message: "result recorded", actions: actions.concat(settle(outcome, "report")) };
        }

        // 模型自己跑去教別的：第一次重送目前項目拉回來；再發生就跳過這一項（標 system_error，不算孩子錯）
        function offScript(target) {
            const bucket = itemBudget(current.itemId);
            if (!(bucket.offScript || 0) && tryRecover("offScript", budget.offScriptPerItem, false)) {
                phase = PHASES.RECOVERING;
                return [ev("plan_off_script_resent", { id: current.itemId, reported: target }),
                    log(`🧭 模型偏離計畫（回報「${target}」），重送目前項目「${current.item.target || current.item.type}」。`),
                    directiveAction("resend_off_script", "回到目前這一項，不要教別的內容。")];
            }
            if (blocked) return blockedActions("offScript");
            return [ev("plan_off_script_skipped", { id: current.itemId, reported: target }),
                log(`⏭️ 模型仍偏離計畫，跳過「${current.item.target || current.item.type}」（標記 system_error，之後補練）。`)]
                .concat(skipCurrent("system_error"));
        }

        function skipCurrent(reason) {
            if (!current) return [];
            current.settled = true;
            settledAttempts.add(current.attemptId);
            const skipped = runner.skipCurrent(reason || "skipped");
            lastCompleted = skipped || current.item;
            return [ev("plan_item_skipped", { id: current.itemId, reason: reason || "skipped" })].concat(prepareItem("present"));
        }

        // ---- AI 一輪結束（P1-2 / P1-3） ----
        // info: { transcriptChars, hadAudio, toolCalled, respondedToTurn, practiceRequested }
        function aiTurnCompleted(info) {
            const turn = info || {};
            const actions = [];
            if (!current || !current.delivered) return actions;
            const spokeThisTurn = Number(turn.transcriptChars) > 0 || !!turn.hadAudio;
            if (spokeThisTurn) aiSpoke();

            if (phase === PHASES.CLOSING) {
                if (spokeThisTurn) { phase = PHASES.ENDED; actions.push({ type: "closing_spoken" }); }
                return actions;
            }
            if (phase === PHASES.ENDED || phase === PHASES.BLOCKED) return actions;

            // 出題那一輪一個字都沒說（也沒音訊）：題目沒唸出來，重送同一份指令（識別碼不變）
            if (!current.spoke && (phase === PHASES.PRESENTING || phase === PHASES.OPENING || phase === PHASES.RECOVERING)) {
                if (tryRecover("silent", budget.silentPerItem, true)) {
                    phase = PHASES.RECOVERING;
                    actions.push(ev("plan_silent_turn", { id: current.itemId, type: current.item.type, target: current.item.target || "", attemptId: current.attemptId }));
                    actions.push(log(`🔇 AI 這一輪一個字都沒說（項目「${current.item.target || current.item.type}」還沒唸出來），重送一次指令。`));
                    actions.push(directiveAction("resend_silent", "你剛才那一輪一個字都沒說，學員聽到的是一片沉默。現在把目前這一項講出來——"));
                } else {
                    actions.push(...blockedActions("silent"));
                }
                return actions;
            }

            // 學生答了、AI 也回了，但沒有合法回報：先補問一次；再沒有就標 unverified 往下走
            if (phase === PHASES.EVALUATING && !current.settled && !current.tapItem &&
                current.studentAnsweredTurn != null && Number(turn.respondedToTurn) === current.studentAnsweredTurn) {
                if (turn.practiceRequested) return actions;      // AI 剛邀請再試一次，等孩子練
                if (tryRecover("nudge", budget.nudgePerItem, false)) {
                    actions.push(ev("plan_report_nudged", { id: current.itemId, attemptId: current.attemptId }));
                    actions.push(log("📮 模型沒回報這一輪的結果，補問一次（暫不推進）。"));
                    actions.push({
                        type: "directive", directiveId: current.directiveId, itemId: current.itemId, attemptId: current.attemptId,
                        item: current.item, attempts: runner.progress().attempts, reason: "nudge",
                        body: stateLine() + "剛才那一輪你沒有回報結果。目前的項目仍然是" +
                            (current.item.target ? `「${current.item.target}」` : `這一項（${current.item.type}）`) +
                            `，不要跳到別的內容。立刻為學員剛才的嘗試呼叫 report_item_result（attemptId="${current.attemptId}"）——` +
                            "這是安靜的系統動作，不要對學員說任何話。"
                    });
                    return actions;
                }
                if (blocked) return actions.concat(blockedActions("nudge"));
                actions.push(ev("plan_fallback_advance", { id: current.itemId, attemptId: current.attemptId, status: "unverified" }));
                actions.push(log("⏭️ 補問後仍無回報，這一題標記 unverified 往下走（不算對也不算錯）。"));
                return actions.concat(settle("unverified", "fallback_unverified"));
            }
            if (phase === PHASES.PRESENTING && current.spoke) {
                phase = current.tapItem ? PHASES.WAITING_TAP : PHASES.WAITING_SPEECH;
                actions.push({ type: "phase", phase });
            }
            return actions;
        }

        // ---- 點選（P0-3：延遲 callback 要驗證識別碼） ----
        function handleTap(optionId, checkTap) {
            const empty = { done: false, actions: [] };
            if (!current || !current.tapItem || !current.tap || current.tapLocked || current.settled) return empty;
            current.tapPicked = current.tapPicked.concat(optionId);
            const verdict = checkTap(Object.assign({}, current.item, { tap: current.tap }), current.tapPicked);
            if (!verdict.done) return { done: false, picked: current.tapPicked.slice(), actions: [] };
            current.tapLocked = true;
            phase = PHASES.FEEDBACK;
            const labelOf = id => (current.tap.options.find(o => o.id === id) || {}).label;
            const token = { itemId: current.itemId, attemptId: current.attemptId, epoch, correct: !!verdict.correct };
            return {
                done: true, correct: !!verdict.correct, picked: current.tapPicked.slice(), token,
                actions: [ev("plan_tap", {
                    id: current.itemId, attemptId: current.attemptId, type: current.item.type, mode: current.tap.mode,
                    correct: !!verdict.correct, answer: current.tap.answer.map(labelOf).join(""),
                    picked: current.tapPicked.map(labelOf).join("")
                }), log(`👆 點選作答：${verdict.correct ? "✅ 對" : "❌ 錯"}（${current.item.target || current.itemId}）`)]
            };
        }

        function settleTap(token) {
            if (!token || !current || current.settled || token.itemId !== current.itemId ||
                token.attemptId !== current.attemptId) {
                return [ev("plan_tap_stale", { token: token || null, current: current ? current.attemptId : null })];
            }
            return settle(token.correct ? "correct" : "incorrect", "tap");
        }

        // ---- 求助（P1-4）：不是作答，不消耗嘗試，也不算恢復 ----
        function helpRequested(source) {
            if (!current || !current.delivered || current.settled) return [];
            if (current.helpCount >= budget.helpPerItem) return [ev("plan_help_ignored", { id: current.itemId })];
            current.helpCount += 1;
            return [ev("plan_help_requested", { id: current.itemId, attemptId: current.attemptId, source: source || "button" }), {
                type: "directive", directiveId: current.directiveId, itemId: current.itemId, attemptId: current.attemptId,
                item: current.item, attempts: runner.progress().attempts, reason: "help",
                body: stateLine() + "學員按了「我不懂」。用更簡單的話把目前這一題再說一次（可以加一句中文解釋），" +
                    "不要回報結果、不要換題，說完就等他。"
            }];
        }

        // ---- 重連（P1-1）：按目前 phase 決定要不要重送，識別碼不變 ----
        function reconnected(newEpoch) {
            epoch = Number(newEpoch) || epoch + 1;
            const actions = [ev("plan_reconnected", { epoch, phase, itemId: current ? current.itemId : null })];
            if (!current || !current.delivered || current.settled || phase === PHASES.ENDED) return actions;
            let prefix = null;
            if (!current.spoke) prefix = "連線剛才中斷了。";
            else if (phase === PHASES.EVALUATING) prefix = "連線剛才中斷了，學員已經回答過一次但你可能沒聽到，請再問一次這一題。";
            else if (phase === PHASES.BLOCKED) return actions;
            else return actions;      // WAITING_SPEECH / WAITING_TAP：題目已經問過，孩子直接答就好
            if (!tryRecover("reconnect", budget.reconnectPerItem, true)) return actions.concat(blockedActions("reconnect"));
            phase = PHASES.RECOVERING;
            actions.push(directiveAction("resend_reconnect", prefix));
            return actions;
        }

        // ---- 跳針切斷後的重送 ----
        function repetitionCut() {
            if (!current || !current.delivered || current.settled) return [];
            if (!tryRecover("repetition", budget.repetitionPerItem, true)) return blockedActions("repetition");
            phase = PHASES.RECOVERING;
            return [directiveAction("resend_repetition", "你剛才的回應卡住重複了，停下來深呼吸。回到目前的項目，重新進行一次：")];
        }

        // ---- 可恢復畫面的兩個操作 ----
        function manualRetry() {
            if (!current) return [];
            blocked = false;
            budget.session = recovery.used + 2;       // 家長按了重試：再給兩次
            phase = PHASES.RECOVERING;
            return [ev("plan_manual_retry", { id: current.itemId }), directiveAction("resend_manual", "")];
        }

        function manualSkip() {
            if (!current) return [];
            blocked = false;
            budget.session = Math.max(budget.session, recovery.used + 1);
            return [ev("plan_manual_skip", { id: current.itemId })].concat(skipCurrent("system_error"));
        }

        function snapshot() {
            return {
                sessionId, epoch, phase, blocked,
                itemId: current ? current.itemId : null,
                attemptId: current ? current.attemptId : null,
                directiveId: current ? current.directiveId : null,
                delivered: !!(current && current.delivered),
                spoke: !!(current && current.spoke),
                answered: !!(current && current.studentAnsweredTurn != null),
                recovery: { used: recovery.used, budget: budget.session, byKind: Object.assign({}, recovery.byKind) }
            };
        }

        function summary() {
            const byOutcome = validResults.reduce((acc, item) => { acc[item.outcome] = (acc[item.outcome] || 0) + 1; return acc; }, {});
            return {
                validResults: validResults.slice(),
                validCount: validResults.length,
                rawReportCount: rawReports.length,
                protocolErrors: protocolErrors.length,
                byOutcome,
                recovery: { used: recovery.used, budget: budget.session, byKind: Object.assign({}, recovery.byKind) },
                unverified: validResults.filter(item => item.outcome === "unverified").length
            };
        }

        return Object.freeze({
            start, directiveSent, setTap, aiSpoke, studentTurnEnded, handleReport, aiTurnCompleted,
            handleTap, settleTap, helpRequested, reconnected, repetitionCut, manualRetry, manualSkip, skipCurrent,
            snapshot, summary,
            phase: () => phase, current: () => (current ? current.item : null), ids: () => (current ? {
                sessionId, epoch, itemId: current.itemId, attemptId: current.attemptId, directiveId: current.directiveId
            } : { sessionId, epoch }),
            isFinished: () => phase === PHASES.ENDED || runner.isFinished(),
            isBlocked: () => blocked,
            isTapItem: () => !!(current && current.tapItem),
            tapState: () => (current ? { picked: current.tapPicked.slice(), locked: current.tapLocked, tap: current.tap } : null)
        });
    }

    global.LessonFlow = Object.freeze({ create, PHASES, normalizeTarget, targetsOverlap, rawCandidates, textMatchesItem });
})(window);
