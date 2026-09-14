// 課程流程控制器的事件重播測試（零 API 成本）。
// 用真實的 lesson-plan 產生器組一份計畫，再把課堂事件一筆一筆餵進去，
// 驗證：識別碼去重、遲到／舊連線回報、點選連按、沉默／漏回報的恢復預算、求助、重連。
(function () {
    "use strict";

    const checks = [];
    function check(name, pass) { checks.push({ name, pass: !!pass }); }

    (async function run() {
        const LP = window.LessonPlan;
        const LF = window.LessonFlow;

        const unit = {
            book: "Book 1", num: 3, title: "Can you sing?", type: "unit",
            patterns: [{
                english: "Can you [action]? / Yes, I can. / No, I can't.",
                chinese: "詢問能力。", slot: "action", zh: "你會【】嗎？", answerZh: "會，我會。／不會，我不會。"
            }],
            words: [
                { english: "sing (v.)", chinese: "唱歌", slot: "action", image: "b1_u03_sing.webp", askType: "what_is_he_doing" },
                { english: "read (v.)", chinese: "閱讀", slot: "action", image: "b1_u03_read.webp", askType: "what_is_he_doing" },
                { english: "swim (v.)", chinese: "游泳", slot: "action", image: "b1_u03_swim.webp", askType: "what_is_he_doing" }
            ],
            scenes: [{ lines: "Can you swim? — Yes, I can.", image: "b1_u03_scene1.webp" }]
        };
        // 同一個字出現在複習單元與本單元：字串比對會混淆，識別碼不會
        const reviewUnit = {
            book: "Book 1", num: 2, title: "Review", type: "unit",
            patterns: [], words: [{ english: "sing (v.)", chinese: "唱歌", slot: "action", image: "x.webp" }]
        };

        function makeFlow(day, budget) {
            const plan = LP.build({ person: "Rex", day, unit, reviewUnits: [reviewUnit], learnedWords: [] });
            const runner = LP.createRunner(plan);
            const flow = LF.create({
                runner, plan, sessionId: "test-session", connectionEpoch: 1,
                isTapItem: LP.isTapItem, directiveFor: LP.itemDirective, revealFor: LP.revealFor,
                budget: budget || {}
            });
            return { plan, runner, flow };
        }
        const directivesOf = actions => actions.filter(a => a.type === "directive");
        const eventsOf = (actions, name) => actions.filter(a => a.type === "event" && a.name === name);
        let studentTurn = 0;

        // 把一份指令「送出」（模擬 app 真的送了）
        function deliver(flow, actions) {
            const d = directivesOf(actions)[0];
            if (d) flow.directiveSent(d.directiveId, { epoch: flow.ids().epoch, studentTurn });
            return d;
        }
        // 開場：AI 講話 → 學生回話 → 系統推進
        function passOpening(flow) {
            const first = flow.start();
            check("the flow starts with the opening directive", first.some(a => a.type === "directive" && a.item.type === "opening"));
            const d = deliver(flow, first);
            check("directives carry a STATE line with ids", /\[STATE session=test-session epoch=1 item=1\/\d+ itemId=opening/.test(d.body));
            flow.aiTurnCompleted({ transcriptChars: 40, hadAudio: true, respondedToTurn: null });
            studentTurn += 1;
            const after = flow.studentTurnEnded(studentTurn);
            check("the opening completes on the learner's reply without a model report",
                eventsOf(after, "plan_opening_answered").length === 1 && directivesOf(after).length === 1 &&
                directivesOf(after)[0].item.type !== "opening");
            // 開場之後模型還是回報了一筆（沒有 attemptId）：必須被當成上一項的遲到回報
            const late = flow.handleReport({ target: "Are you ready?", outcome: "correct", toolCallId: "c-open" });
            check("a late opening report is ignored quietly", late.verdict === "late_previous");
            flow.aiTurnCompleted({ transcriptChars: 10, hadAudio: true, respondedToTurn: studentTurn });
            return deliver(flow, after);
        }

        // ---------- 1. 正常口說：答對；答錯→提示；到達上限 ----------
        {
            const { flow } = makeFlow(1);
            let d = passOpening(flow);
            const item = flow.current();
            check("day 1 first item is a spoken word item", item.type === "word_zh2en" && !flow.isTapItem());
            check("the STATE line names the attemptId the model must echo",
                d.body.indexOf(`attemptId="${flow.ids().attemptId}"`) >= 0 && d.body.indexOf("input=speech") >= 0);
            check("hidden answers stay out of the STATE line", d.body.indexOf("hidden=[english]") >= 0);
            flow.aiTurnCompleted({ transcriptChars: 30, hadAudio: true, respondedToTurn: null });
            check("after presenting, the flow waits for speech", flow.phase() === "WAITING_SPEECH");
            // 學生還沒講話就回報：不採用
            const early = flow.handleReport({ target: item.target, outcome: "correct", attemptId: flow.ids().attemptId, toolCallId: "c1" });
            check("a report before the learner answered is rejected", early.verdict === "no_attempt");
            studentTurn += 1; flow.studentTurnEnded(studentTurn);
            const ok = flow.handleReport({ target: item.target, outcome: "correct", attemptId: flow.ids().attemptId, toolCallId: "c2", studentSaid: item.target });
            check("a valid report with the right attemptId is accepted and advances", ok.verdict === "accepted" &&
                directivesOf(ok.actions).length === 1 && flow.current() !== item);
            check("accepted results are recorded as valid", flow.summary().validCount === 1 && flow.summary().byOutcome.correct === 1);
            // 第二題：答錯兩次爬階梯，第三次到上限仍前進
            d = deliver(flow, ok.actions);
            const second = flow.current();
            const max = second.maxAttempts;
            let climbs = 0;
            for (let i = 0; i < max; i++) {
                flow.aiTurnCompleted({ transcriptChars: 20, hadAudio: true, respondedToTurn: null });
                studentTurn += 1; flow.studentTurnEnded(studentTurn);
                const res = flow.handleReport({ target: second.target, outcome: "incorrect", attemptId: flow.ids().attemptId, toolCallId: "w" + i });
                if (flow.current() === second) climbs += 1;
                d = deliver(flow, res.actions);
            }
            check("wrong answers climb the ladder with fresh attempt ids, then move on at the limit",
                climbs === max - 1 && flow.current() !== second);
            check("each ladder step used a distinct attemptId",
                new Set(flow.summary().validResults.filter(r => r.itemId === second.id).map(r => r.attemptId)).size === max);
        }

        // ---------- 2. 重送／重報／遲到 ----------
        {
            const { flow } = makeFlow(1);
            passOpening(flow);
            const item = flow.current();
            flow.aiTurnCompleted({ transcriptChars: 30, hadAudio: true, respondedToTurn: null });
            studentTurn += 1; flow.studentTurnEnded(studentTurn);
            const a = flow.handleReport({ target: item.target, outcome: "correct", attemptId: flow.ids().attemptId, toolCallId: "dup" });
            const nextItem = flow.current();
            const b = flow.handleReport({ target: item.target, outcome: "correct", attemptId: a.actions.find(x => x.name === "plan_attempt").details.attemptId, toolCallId: "dup" });
            const c = flow.handleReport({ target: item.target, outcome: "incorrect", attemptId: item.id + "#a1", toolCallId: "other-call" });
            check("the same tool call replayed is ignored", b.verdict === "duplicate_call");
            check("a different tool call for an already settled attempt is ignored", c.verdict === "attempt_settled");
            check("neither duplicate moved the plan", flow.current() === nextItem && flow.summary().validCount === 1);
            // 舊連線的遲到事件
            const stale = flow.handleReport({ target: nextItem.target, outcome: "correct", attemptId: flow.ids().attemptId, toolCallId: "old", epoch: 0 });
            check("a report from a previous connection epoch is ignored", stale.verdict === "stale_epoch");
        }

        // ---------- 3. 同一個字在兩個項目裡：靠識別碼，不靠字串 ----------
        {
            const { flow, plan } = makeFlow(1);
            const singItems = plan.items.filter(i => i.target === "sing");
            check("the fixture really has the same target in two items", singItems.length === 2);
            passOpening(flow);
            // 走到第一個 sing
            let guard = 20;
            while (flow.current() && flow.current().target !== "sing" && guard-- > 0) {
                flow.aiTurnCompleted({ transcriptChars: 5, hadAudio: true, respondedToTurn: null });
                studentTurn += 1; flow.studentTurnEnded(studentTurn);
                deliver(flow, flow.handleReport({ target: flow.current().target, outcome: "correct", attemptId: flow.ids().attemptId, toolCallId: "g" + guard }).actions);
            }
            const firstSing = flow.current();
            flow.aiTurnCompleted({ transcriptChars: 5, hadAudio: true, respondedToTurn: null });
            studentTurn += 1; flow.studentTurnEnded(studentTurn);
            // 模型帶了「另一個 sing 項目」的 attemptId（錯的）→ 協定錯誤，不結算
            const otherId = singItems.find(i => i.id !== firstSing.id).id + "#a1";
            const wrong = flow.handleReport({ target: "sing", outcome: "correct", attemptId: otherId, toolCallId: "s1" });
            check("a matching target with the wrong attemptId is a protocol error, not a settlement",
                wrong.verdict === "wrong_attempt_id" && flow.current() === firstSing &&
                eventsOf(wrong.actions, "plan_report_protocol_error").length === 1);
            const right = flow.handleReport({ target: "sing", outcome: "correct", attemptId: flow.ids().attemptId, toolCallId: "s2" });
            check("the same content with the right attemptId settles once", right.verdict === "accepted" && flow.current() !== firstSing);
        }

        // ---------- 4. 點選：連按、延遲 callback 過期、點選題收到模型回報 ----------
        {
            const { flow } = makeFlow(2);
            passOpening(flow);
            let guard = 20;
            while (flow.current() && !flow.isTapItem() && guard-- > 0) {
                flow.aiTurnCompleted({ transcriptChars: 5, hadAudio: true, respondedToTurn: null });
                studentTurn += 1; flow.studentTurnEnded(studentTurn);
                deliver(flow, flow.handleReport({ target: flow.current().target, outcome: "correct", attemptId: flow.ids().attemptId, toolCallId: "t" + guard }).actions);
            }
            const tapItem = flow.current();
            check("day 2 reaches a tap item", !!tapItem && flow.isTapItem());
            const reveal = LP.revealFor(tapItem, 0);
            flow.setTap(reveal.tap);
            flow.aiTurnCompleted({ transcriptChars: 12, hadAudio: true, respondedToTurn: null });
            check("tap items wait for a tap, not speech", flow.phase() === "WAITING_TAP");
            studentTurn += 1;
            const spoke = flow.studentTurnEnded(studentTurn);
            check("speech on a tap item only nudges the screen", spoke.some(a => a.type === "tap_waiting") && flow.phase() === "WAITING_TAP");
            const modelReport = flow.handleReport({ target: tapItem.target, outcome: "incorrect", attemptId: flow.ids().attemptId, toolCallId: "m1" });
            check("a model report on a tap item is ignored and never counts as wrong",
                modelReport.verdict === "tap_item" && flow.summary().validResults.every(r => r.itemId !== tapItem.id));
            const correctId = reveal.tap.answer[0];
            const first = flow.handleTap(correctId, LP.checkTap);
            const second = flow.handleTap(correctId, LP.checkTap);
            check("a double tap only judges once", first.done && !second.done && second.actions.length === 0);
            // 延遲 900ms 的 callback：先讓一個「舊 token」過期
            const fakeOld = { itemId: tapItem.id, attemptId: tapItem.id + "#a9", epoch: 1, correct: true };
            const staleSettle = flow.settleTap(fakeOld);
            check("a stale tap token does not settle", eventsOf(staleSettle, "plan_tap_stale").length === 1 && flow.current() === tapItem);
            const settled = flow.settleTap(first.token);
            check("the real tap token settles exactly once and advances", flow.current() !== tapItem && directivesOf(settled).length === 1);
            check("settling the same token again is a no-op", eventsOf(flow.settleTap(first.token), "plan_tap_stale").length === 1);
        }

        // ---------- 5/6. 沉默、只有工具的回合、空逐字稿但有音訊、漏回報 ----------
        {
            const { flow } = makeFlow(1, { session: 3 });
            passOpening(flow);
            const item = flow.current();
            // 空逐字稿但有音訊：不是沉默
            const audioOnly = flow.aiTurnCompleted({ transcriptChars: 0, hadAudio: true, respondedToTurn: null });
            check("an empty transcript with audio is not treated as a silent turn", eventsOf(audioOnly, "plan_silent_turn").length === 0);
            // 真正空白：重送一次，識別碼不變
            const { flow: f2 } = makeFlow(1, { session: 3 });
            passOpening(f2);
            const ids = f2.ids();
            const silent = f2.aiTurnCompleted({ transcriptChars: 0, hadAudio: false, respondedToTurn: null });
            check("a truly silent presenting turn re-sends the same directive once",
                eventsOf(silent, "plan_silent_turn").length === 1 && directivesOf(silent)[0].reason === "resend_silent" &&
                directivesOf(silent)[0].attemptId === ids.attemptId && directivesOf(silent)[0].directiveId === ids.directiveId);
            deliver(f2, silent);
            const again = f2.aiTurnCompleted({ transcriptChars: 0, hadAudio: false, respondedToTurn: null });
            check("a second silent turn on the same item stops re-sending and blocks",
                eventsOf(again, "plan_recovery_exhausted").length === 1 && again.some(a => a.type === "blocked") && f2.isBlocked());
            const retry = f2.manualRetry();
            check("manual retry re-sends and unblocks", directivesOf(retry).length === 1 && !f2.isBlocked());
            // 漏回報：學生答了、AI 回了、沒回報 → 補問一次 → 再沒有 → unverified 前進，不算錯
            const { flow: f3 } = makeFlow(1);
            passOpening(f3);
            const w = f3.current();
            f3.aiTurnCompleted({ transcriptChars: 30, hadAudio: true, respondedToTurn: null });
            studentTurn += 1; f3.studentTurnEnded(studentTurn);
            const nudge = f3.aiTurnCompleted({ transcriptChars: 20, hadAudio: true, respondedToTurn: studentTurn });
            check("a missing report is nudged once", eventsOf(nudge, "plan_report_nudged").length === 1 && directivesOf(nudge)[0].reason === "nudge");
            deliver(f3, nudge);
            // 只有工具、沒說話的回合：模型回報了，但 outcome 不合法
            const bad = f3.handleReport({ target: w.target, outcome: "maybe", attemptId: f3.ids().attemptId, toolCallId: "bad" });
            check("an invalid outcome is a protocol error, not an incorrect answer",
                bad.verdict === "invalid_outcome" && f3.current() === w && !f3.summary().byOutcome.incorrect);
            const fallback = f3.aiTurnCompleted({ transcriptChars: 0, hadAudio: false, toolCalled: true, respondedToTurn: studentTurn });
            check("after the nudge fails the item moves on as unverified, never as wrong",
                eventsOf(fallback, "plan_fallback_advance").length === 1 && f3.current() !== w &&
                f3.summary().unverified === 1 && !f3.summary().byOutcome.incorrect);
            check("the runner records the unverified status", f3.summary().validResults[0].outcome === "unverified");
        }

        // ---------- 7. 求助：不是作答、不消耗嘗試 ----------
        {
            const { flow } = makeFlow(1);
            passOpening(flow);
            const item = flow.current();
            flow.aiTurnCompleted({ transcriptChars: 30, hadAudio: true, respondedToTurn: null });
            const help = flow.helpRequested("button");
            check("help sends a clarification directive on the same attempt",
                directivesOf(help)[0].reason === "help" && directivesOf(help)[0].attemptId === flow.ids().attemptId);
            deliver(flow, help);
            flow.aiTurnCompleted({ transcriptChars: 25, hadAudio: true, respondedToTurn: null });
            check("help does not change the item or count as an attempt", flow.current() === item && flow.summary().validCount === 0);
            const help2 = flow.helpRequested("button");
            const help3 = flow.helpRequested("button");
            check("help is capped per item", directivesOf(help2).length === 1 && directivesOf(help3).length === 0);
        }

        // ---------- 8. 斷線：等點選時、作答後、舊 epoch ----------
        {
            const { flow } = makeFlow(1);
            passOpening(flow);
            const item = flow.current();
            const before = flow.ids();
            // 指令送了、AI 還沒講就斷線 → 重連重送同一份
            const r1 = flow.reconnected(2);
            check("reconnecting before the AI spoke re-sends the same directive ids",
                directivesOf(r1)[0].reason === "resend_reconnect" && directivesOf(r1)[0].attemptId === before.attemptId && flow.ids().epoch === 2);
            deliver(flow, r1);
            flow.aiTurnCompleted({ transcriptChars: 30, hadAudio: true, respondedToTurn: null });
            // 題目已問、等孩子說：重連不重送（避免重問）
            const r2 = flow.reconnected(3);
            check("reconnecting while waiting for speech does not re-ask", directivesOf(r2).length === 0);
            studentTurn += 1; flow.studentTurnEnded(studentTurn);
            // 作答後斷線：重送並說明學員已答過，attemptId 不變、不算錯
            const r3 = flow.reconnected(4);
            check("reconnecting after an answer re-asks the same attempt without recording an error",
                directivesOf(r3).length === 1 && /學員已經回答過一次/.test(directivesOf(r3)[0].body) &&
                directivesOf(r3)[0].attemptId === before.attemptId && flow.summary().validCount === 0);
            // 舊 epoch 的回報遲到
            const old = flow.handleReport({ target: item.target, outcome: "correct", attemptId: flow.ids().attemptId, toolCallId: "e", epoch: 2 });
            check("a report tagged with an old epoch is ignored after reconnect", old.verdict === "stale_epoch");
        }

        // ---------- 9/10. 亂序事件不雙重推進；恢復總量有上限 ----------
        {
            const { flow, plan } = makeFlow(1, { session: 4 });
            passOpening(flow);
            let recoveries = 0;
            let guard = 40;
            while (!flow.isFinished() && !flow.isBlocked() && guard-- > 0) {
                const acts = flow.aiTurnCompleted({ transcriptChars: 0, hadAudio: false, respondedToTurn: null });
                recoveries += eventsOf(acts, "plan_silent_turn").length;
                if (flow.isBlocked()) break;
                deliver(flow, acts);
                // 每題第二次沉默會 block；用手動跳過往下走，模擬家長操作
                const acts2 = flow.aiTurnCompleted({ transcriptChars: 0, hadAudio: false, respondedToTurn: null });
                if (flow.isBlocked()) { deliver(flow, flow.manualSkip()); }
            }
            check("system recoveries never exceed the session budget", flow.summary().recovery.used <= flow.summary().recovery.budget);
            check("system failures never become learner errors",
                !flow.summary().byOutcome.incorrect && !flow.summary().byOutcome.no_response);
            check("skipped items are marked system_error, not wrong",
                flow.snapshot().phase !== "ENDED" || plan.items.length > 0);
        }

        // ---------- 結尾：要真的講了才算 ----------
        {
            const { flow } = makeFlow(1);
            passOpening(flow);
            let guard = 40;
            while (flow.current() && flow.current().type !== "closing" && guard-- > 0) {
                if (flow.isTapItem()) { flow.setTap(LP.revealFor(flow.current(), 0).tap); }
                flow.aiTurnCompleted({ transcriptChars: 5, hadAudio: true, respondedToTurn: null });
                if (flow.isTapItem()) {
                    const t = flow.handleTap(flow.tapState().tap.answer[0], LP.checkTap);
                    deliver(flow, flow.settleTap(t.token));
                } else {
                    studentTurn += 1; flow.studentTurnEnded(studentTurn);
                    deliver(flow, flow.handleReport({ target: flow.current().target, outcome: "correct", attemptId: flow.ids().attemptId, toolCallId: "z" + guard }).actions);
                }
            }
            check("the plan reaches the closing item", flow.current() && flow.current().type === "closing" && flow.phase() === "CLOSING");
            const empty = flow.aiTurnCompleted({ transcriptChars: 0, hadAudio: false, respondedToTurn: null });
            check("an empty closing turn does not end the lesson", !empty.some(a => a.type === "closing_spoken") && flow.phase() !== "ENDED");
            const spoken = flow.aiTurnCompleted({ transcriptChars: 40, hadAudio: true, respondedToTurn: null });
            check("a spoken closing ends the flow", spoken.some(a => a.type === "closing_spoken") && flow.phase() === "ENDED");
            const lateReport = flow.handleReport({ target: "bye", outcome: "correct", attemptId: "x", toolCallId: "late" });
            check("reports after the end are ignored", lateReport.verdict === "finished");
        }

        // ---------- 與 app.js 的整合（原始碼迴歸） ----------
        const appSource = await fetch('../app.js?lesson-flow-test=' + Date.now()).then(r => r.text());
        const indexSource = await fetch('../index.html?lesson-flow-test=' + Date.now()).then(r => r.text());
        check("flow module loads before app", indexSource.indexOf('src="lesson-flow.js') < indexSource.indexOf('src="app.js'));
        check("app creates the flow from the plan runner", /LessonFlow\.create\(\{/.test(appSource) && /planFlow = /.test(appSource));
        check("every flow action goes through one executor", /function applyFlowActions/.test(appSource) &&
            (appSource.match(/applyFlowActions\(/g) || []).length >= 6);
        check("reports are validated by the flow, not by string matching in app.js",
            /planFlow\.handleReport\(/.test(appSource) && !/function reportMatchesPlanItem/.test(appSource) && !/function handleOffScriptReport/.test(appSource));
        check("the delayed tap settlement verifies its token", /planFlow\.settleTap\(/.test(appSource));
        check("the student turn feeds the flow on both providers", (appSource.match(/planFlow\.studentTurnEnded\(/g) || []).length >= 1);
        check("reconnects hand the new epoch to the flow", /planFlow\.reconnected\(connectionEpoch\)/.test(appSource));
        check("the AI turn feeds audio evidence, not just transcript length", /hadAudio: /.test(appSource) && /aiAudioSinceDirective/.test(appSource));
        check("directives are held while GPT audio is still playing", /openaiRealtime\.isSpeaking\(\)/.test(appSource) && /function queuePlanDirective/.test(appSource));
        // 跳針偵測要有反向參照，否則任何長一點的逐字稿都會被判成跳針
        const loopSrc = (appSource.match(/function detectRepetitionLoop[\s\S]*?\n\}/) || [""])[0];
        const detectLoop = new Function("return (" + loopSrc + ")")();
        check("repetition detection ignores normal speech but catches a real loop",
            !detectLoop("Great job! This is a table. Can you say table? Now let's look at the next picture together, what is it?") &&
            detectLoop("Can you say apple? ".repeat(6)));
        check("the report schema requires attemptId", /required: \["target", "outcome", "attemptId"\]/.test(appSource));
        check("the recover screen offers retry and skip", /id="svRecover"/.test(indexSource) && /planFlow\.manualRetry\(\)/.test(appSource) && /planFlow\.manualSkip\(\)/.test(appSource));

        const passed = checks.every(item => item.pass);
        const result = document.getElementById('result');
        result.textContent = (passed ? 'PASS' : 'FAIL') + '\n' +
            checks.map(item => `${item.pass ? 'OK' : 'NOT OK'} - ${item.name}`).join('\n');
        document.title = (passed ? 'PASS' : 'FAIL') + ' - lesson flow smoke test';
    })().catch(error => {
        document.getElementById('result').textContent = 'FAIL\n' + (error && error.stack || error);
        document.title = 'FAIL - lesson flow smoke test';
    });
})();
