(async function () {
    "use strict";

    const checks = [];
    function check(name, pass) { checks.push({ name, pass: !!pass }); }

    class FakeStorage {
        constructor() { this.values = new Map(); }
        getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
        setItem(key, value) { this.values.set(key, String(value)); }
        removeItem(key) { this.values.delete(key); }
    }

    const storage = new FakeStorage();
    let clock = Date.parse("2026-08-02T08:00:00.000Z");
    const diagnostics = SessionDiagnostics.create({
        storage,
        nowFn: () => clock,
        maxSessions: 2,
        maxEvents: 20,
        maxTextLength: 500
    });

    diagnostics.start({
        person: "Rex",
        audioMode: "speaker",
        apiKey: "SHOULD_NOT_EXIST",
        token: "TOKEN_SHOULD_NOT_EXIST",
        syncSecret: "SECRET_SHOULD_NOT_EXIST"
    });
    clock += 100;
    diagnostics.record("connection_attempt", {
        reconnect: false,
        url: "wss://example.test/live?key=KEY_IN_URL&mode=test",
        resumeHandle: "HANDLE_SHOULD_NOT_EXIST",
        message: "provider echoed AIza1234567890abcdefghijklmnopqrst"
    });
    diagnostics.transcript("student", "I like ", { turn: 1 });
    diagnostics.transcript("student", "pencils.", { turn: 1 });
    diagnostics.transcript("ai", "Great sentence!", { turn: 1 });
    clock += 1900;
    diagnostics.finish("user");

    const json = diagnostics.exportJson();
    const payload = JSON.parse(json);
    const first = payload.sessions[0];
    check("stores safe session metadata", first.metadata.person === "Rex" && first.metadata.audioMode === "speaker");
    check("removes secret fields", !json.includes("SHOULD_NOT_EXIST"));
    check("redacts credentials embedded in URLs", json.includes("key=[REDACTED]") && !json.includes("KEY_IN_URL"));
    check("redacts a bare Google API key pattern", !json.includes("AIza1234567890abcdefghijklmnopqrst"));
    check("coalesces transcript chunks from one turn", first.events.some(event => event.type === "transcript" && event.details.text === "I like pencils."));
    check("records duration and end reason", first.durationMs === 2000 && first.endReason === "user");
    check("exports an explicit privacy statement", /No audio, API keys, tokens, secrets/.test(payload.privacy));

    const reloaded = SessionDiagnostics.create({ storage, nowFn: () => clock, maxSessions: 2 });
    check("completed diagnostics survive a reload", reloaded.inspect().savedSessions === 1);

    const longStorage = new FakeStorage();
    const longDiagnostics = SessionDiagnostics.create({
        storage: longStorage,
        nowFn: () => clock,
        maxSessions: 1,
        maxEvents: 80
    });
    longDiagnostics.start({ person: "Rex" });
    for (let index = 0; index < 74; index += 1) {
        longDiagnostics.record("long_session_event", { context: { turn: index } });
    }
    longDiagnostics.finish("test");
    const longExport = longDiagnostics.exportPayload().sessions[0];
    check("exports the full configured event history beyond 50 items", longExport.events.length === 76);
    check("preserves nested turn values after storage reload", longExport.events[60].details.context.turn === 59);

    reloaded.start({ person: "Jessie" });
    reloaded.record("image_status", { keyword: "notebook", status: "slow", base64: "RAW_IMAGE" });
    const activeExport = reloaded.exportPayload();
    check("an active lesson can be exported", activeExport.sessions[0].endedAt === null);
    check("raw image data is excluded", !JSON.stringify(activeExport).includes("RAW_IMAGE"));
    reloaded.finish("test");
    reloaded.start({ person: "Sandy" });
    reloaded.finish("test");
    check("history keeps only the configured number of sessions", reloaded.inspect().savedSessions === 2);
    reloaded.clear();
    check("clear removes saved and active diagnostics", reloaded.inspect().savedSessions === 0 && !reloaded.inspect().active);

    const appSource = await fetch('../app.js?diagnostics-test=' + Date.now()).then(response => response.text());
    const indexSource = await fetch('../index.html?diagnostics-test=' + Date.now()).then(response => response.text());
    check("diagnostics load before app", indexSource.indexOf('src="session-diagnostics.js') < indexSource.indexOf('src="app.js'));
    check("settings provide export and clear controls", /id="exportDiagnosticsBtn"/.test(indexSource) && /id="clearDiagnosticsBtn"/.test(indexSource));
    check("app records transcripts without audio chunks", /sessionDiagnostics\.transcript/.test(appSource) && !/sessionDiagnostics\.(?:record|transcript)\([^\n]*(?:turnChunks|inlineData)/.test(appSource));

    // --- 階段 1：練習結果回報（計畫驅動架構的地基） ---
    check("report_item_result is declared once and shared by both providers",
        /name: "report_item_result"/.test(appSource) &&
        /function geminiToolDeclarations\(\)/.test(appSource) &&
        /functionDeclarations: geminiToolDeclarations\(\)/.test(appSource) &&
        (appSource.match(/name: "report_item_result"/g) || []).length === 1);
    check("gemini declarations are converted from the shared source, not duplicated",
        /function toGeminiSchema/.test(appSource) &&
        (appSource.match(/name: "show_image"/g) || []).length === 1);
    check("the tool dispatcher handles the new report",
        /if \(name === "report_item_result"\)[\s\S]{0,80}recordItemResult/.test(appSource));
    check("outcomes are validated against a fixed list",
        /ITEM_OUTCOMES = \["correct", "incorrect", "no_response"\]/.test(appSource) &&
        /ITEM_OUTCOMES\.indexOf\(String\(a\.outcome\)\) >= 0/.test(appSource));
    check("reports without a target are ignored",
        /if \(!target\) return \{ status: "ignored: missing target" \}/.test(appSource));
    check("每堂課結束會輸出遵從率摘要",
        /function summariseItemResults/.test(appSource) &&
        /item_result_summary/.test(appSource) &&
        /summariseItemResults\(endReason\)/.test(appSource));
    check("practice invitations are counted for the adherence comparison",
        /if \(practiceRequested\) practiceTurnsObserved \+= 1/.test(appSource));
    check("item state resets for each new session",
        /itemResults = \[\];\s*\/\/ 練習結果回報逐堂重算/.test(appSource));
    check("the prompt requires silent reporting after every attempt",
        /PROGRESS REPORTING — mandatory and completely silent/.test(appSource) &&
        /never say the tool's name/.test(appSource));

    const passed = checks.every(item => item.pass);
    const result = document.getElementById('result');
    result.className = passed ? 'pass' : 'fail';
    result.textContent = (passed ? 'PASS' : 'FAIL') + '\n' +
        checks.map(item => `${item.pass ? 'OK' : 'NOT OK'} - ${item.name}`).join('\n');
    document.title = passed ? 'PASS - session diagnostics smoke test' : 'FAIL - session diagnostics smoke test';
})();
