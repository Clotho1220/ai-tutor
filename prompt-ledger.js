// 提示詞帳本（v3.50，AI-STABILITY P0-1）：記下這堂課「實際送給模型」的每一份指令。
//
// 快照一律由真正的發送路徑呼叫 capture()（GPT 的資料通道 send、Gemini 的 socket.send 之前那一刻），
// 不是事後重新呼叫組裝函式冒充。同一份大文字只存一次（以雜湊識別），每個事件只引用 id／hash。
// 只收指令與必要欄位：不記 API Key、憑證、認證 header、錄音。
(function (global) {
    "use strict";

    // FNV-1a 32-bit：同步、夠快、夠用來去重與比對（不是密碼用途）
    function hashText(value) {
        const s = String(value == null ? "" : value);
        let h = 0x811c9dc5;
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
        }
        return ("0000000" + h.toString(16)).slice(-8);
    }

    function create(options) {
        const config = options || {};
        const now = config.nowFn || (() => Date.now());
        const maxEntries = Math.max(5, Number(config.maxEntries || 400));
        const maxTextChars = Math.max(500, Number(config.maxTextChars || 24000));
        let session = null;
        let entries = [];
        let texts = {};      // hash → 全文（去重）
        let counter = 0;

        function begin(meta) {
            session = Object.assign({ startedAt: new Date(now()).toISOString() }, meta || {});
            entries = [];
            texts = {};
            counter = 0;
            return session;
        }

        // kind: system | tools | directive | update | tool_result | other
        function capture(input) {
            const data = input || {};
            const full = String(data.text == null ? "" : data.text);
            const hash = hashText(full);
            const firstSeen = !Object.prototype.hasOwnProperty.call(texts, hash);
            if (firstSeen) texts[hash] = full.length > maxTextChars ? full.slice(0, maxTextChars) + "…[truncated]" : full;
            counter += 1;
            const entry = {
                id: "p" + counter,
                at: new Date(now()).toISOString(),
                kind: String(data.kind || "other"),
                hash,
                chars: full.length,
                firstSeen,
                reason: String(data.reason || ""),
                provider: String(data.provider || (session && session.provider) || ""),
                connectionEpoch: data.connectionEpoch == null ? null : Number(data.connectionEpoch),
                itemId: data.itemId == null ? null : String(data.itemId),
                directiveId: data.directiveId == null ? null : String(data.directiveId),
                promptVersion: String(data.promptVersion || (session && session.promptVersion) || ""),
                meta: data.meta || null
            };
            entries.push(entry);
            if (entries.length > maxEntries) entries.splice(0, entries.length - maxEntries);
            return entry;
        }

        function textOf(hash) { return texts[hash] || ""; }
        function list() { return entries.slice(); }

        function exportPayload() {
            return {
                session: session ? Object.assign({}, session) : null,
                entries: entries.slice(),
                texts: Object.assign({}, texts)
            };
        }

        // 家長／開發者面板用的可讀版本：先列時間軸，再附每份文字
        function render() {
            if (!session) return "（尚未連線，沒有指令紀錄）";
            const lines = [];
            lines.push(`session ${session.sessionId || "?"} · ${session.provider || "?"} · mode ${session.mode || "?"} · prompt ${session.promptVersion || "?"} · app ${session.appVersion || "?"}`);
            lines.push("");
            lines.push("== 時間軸（誰、何時、為什麼） ==");
            entries.forEach(entry => {
                lines.push(`${entry.at.slice(11, 19)} ${entry.id} [${entry.kind}] #${entry.hash} ${entry.chars} 字` +
                    (entry.connectionEpoch != null ? ` epoch ${entry.connectionEpoch}` : "") +
                    (entry.itemId ? ` item ${entry.itemId}` : "") +
                    (entry.directiveId ? ` ${entry.directiveId}` : "") +
                    (entry.reason ? ` — ${entry.reason}` : "") +
                    (entry.firstSeen ? "" : "（同一份，見上）"));
            });
            lines.push("");
            lines.push("== 內容（每份只列一次） ==");
            Object.keys(texts).forEach(hash => {
                const first = entries.find(entry => entry.hash === hash);
                lines.push(`--- #${hash} [${first ? first.kind : "?"}] ---`);
                lines.push(texts[hash]);
                lines.push("");
            });
            return lines.join("\n");
        }

        function inspect() {
            return { active: !!session, entries: entries.length, distinctTexts: Object.keys(texts).length };
        }

        return Object.freeze({ begin, capture, textOf, list, exportPayload, render, inspect, hashText });
    }

    global.PromptLedger = Object.freeze({ create, hashText });
})(window);
