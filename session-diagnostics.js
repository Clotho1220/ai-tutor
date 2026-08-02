(function (global) {
    "use strict";

    const DEFAULT_KEY = "ai_tutor_diagnostics_v1";
    const BLOCKED_KEY_RE = /^(?:api[_-]?key|gemini[_-]?api[_-]?key|token|currenttoken|access[_-]?token|secret|syncsecret|authorization|credential|resumehandle|resumptionhandle|audio|pcm|base64|chunks?|turnchunks)$/i;
    const CREDENTIAL_QUERY_RE = /([?&](?:key|access_token|token|secret)=)[^&#\s]+/gi;

    function create(options) {
        const config = options || {};
        const storage = config.storage || global.localStorage;
        const storageKey = config.storageKey || DEFAULT_KEY;
        const now = config.nowFn || (() => Date.now());
        const maxSessions = Math.max(1, Number(config.maxSessions || 3));
        const maxEvents = Math.max(10, Number(config.maxEvents || 600));
        const maxTextLength = Math.max(200, Number(config.maxTextLength || 2000));
        let active = null;

        function safeString(value) {
            return String(value == null ? "" : value)
                .replace(CREDENTIAL_QUERY_RE, "$1[REDACTED]")
                .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[REDACTED_API_KEY]")
                .replace(/(Bearer\s+)[0-9A-Za-z._~-]{12,}/gi, "$1[REDACTED]")
                .slice(0, maxTextLength);
        }

        function sanitize(value, depth) {
            if (depth > 4) return "[TRUNCATED]";
            if (value == null || typeof value === "boolean" || typeof value === "number") return value;
            if (typeof value === "string") return safeString(value);
            if (Array.isArray(value)) return value.slice(0, 50).map(item => sanitize(item, depth + 1));
            if (typeof value !== "object") return safeString(value);

            const out = {};
            Object.keys(value).slice(0, 80).forEach(key => {
                if (BLOCKED_KEY_RE.test(key)) return;
                out[key] = sanitize(value[key], depth + 1);
            });
            return out;
        }

        function loadHistory() {
            try {
                const parsed = JSON.parse(storage.getItem(storageKey) || "[]");
                return Array.isArray(parsed) ? parsed.slice(0, maxSessions).map(item => sanitize(item, 0)) : [];
            } catch (error) {
                return [];
            }
        }

        function saveHistory(history) {
            try {
                storage.setItem(storageKey, JSON.stringify(history.slice(0, maxSessions)));
                return true;
            } catch (error) {
                return false;
            }
        }

        function copy(value) {
            return JSON.parse(JSON.stringify(value));
        }

        function makeId(timestamp) {
            return `session-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
        }

        function start(metadata) {
            if (active) finish("replaced_by_new_session");
            const startedAtMs = now();
            active = {
                schemaVersion: 1,
                id: makeId(startedAtMs),
                startedAt: new Date(startedAtMs).toISOString(),
                endedAt: null,
                durationMs: null,
                endReason: null,
                metadata: sanitize(metadata || {}, 0),
                events: []
            };
            record("session_started", {});
            return active.id;
        }

        function updateMetadata(values) {
            if (!active) return false;
            active.metadata = Object.assign({}, active.metadata, sanitize(values || {}, 0));
            return true;
        }

        function record(type, details) {
            if (!active) return false;
            const event = {
                at: new Date(now()).toISOString(),
                type: safeString(type || "event"),
                details: sanitize(details || {}, 0)
            };
            active.events.push(event);
            if (active.events.length > maxEvents) active.events.splice(0, active.events.length - maxEvents);
            return true;
        }

        function transcript(role, text, context) {
            if (!active || !text) return false;
            const cleanRole = role === "student" ? "student" : "ai";
            const safeText = safeString(text);
            const safeContext = sanitize(context || {}, 0);
            const previous = active.events[active.events.length - 1];
            const sameContext = previous && previous.type === "transcript" &&
                previous.details.role === cleanRole &&
                JSON.stringify(previous.details.context || {}) === JSON.stringify(safeContext);
            if (sameContext) {
                previous.details.text = safeString(previous.details.text + safeText);
                previous.details.updatedAt = new Date(now()).toISOString();
                return true;
            }
            return record("transcript", { role: cleanRole, text: safeText, context: safeContext });
        }

        function finish(reason) {
            if (!active) return null;
            const endedAtMs = now();
            active.endedAt = new Date(endedAtMs).toISOString();
            active.durationMs = Math.max(0, endedAtMs - Date.parse(active.startedAt));
            active.endReason = safeString(reason || "stopped");
            record("session_finished", { reason: active.endReason });
            const completed = copy(active);
            saveHistory([completed].concat(loadHistory()).slice(0, maxSessions));
            active = null;
            return completed;
        }

        function sessionsForExport() {
            const sessions = loadHistory();
            if (active) sessions.unshift(copy(active));
            return sessions.slice(0, maxSessions);
        }

        function exportPayload() {
            return {
                schemaVersion: 1,
                exportedAt: new Date(now()).toISOString(),
                privacy: "Text diagnostics only. No audio, API keys, tokens, secrets, or resumption handles.",
                sessions: sessionsForExport()
            };
        }

        function exportJson() {
            return JSON.stringify(exportPayload(), null, 2);
        }

        function clear() {
            try { storage.removeItem(storageKey); } catch (error) {}
            active = null;
        }

        function inspect() {
            return {
                active: !!active,
                activeId: active ? active.id : null,
                savedSessions: loadHistory().length,
                activeEvents: active ? active.events.length : 0
            };
        }

        return Object.freeze({
            start,
            updateMetadata,
            record,
            transcript,
            finish,
            exportPayload,
            exportJson,
            clear,
            inspect
        });
    }

    global.SessionDiagnostics = Object.freeze({ create });
})(window);
