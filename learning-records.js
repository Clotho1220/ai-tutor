(function (global) {
    "use strict";

    const VERSION = 1;
    const KEY_PREFIX = "practice_log_v1::";
    const VALID_KINDS = new Set(["translated", "corrected", "alternative"]);

    function cleanText(value, maxLength) {
        return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, maxLength || 500);
    }

    function localDate(date) {
        const parts = new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit"
        }).formatToParts(date);
        const values = {};
        parts.forEach(part => { values[part.type] = part.value; });
        return `${values.year}-${values.month}-${values.day}`;
    }

    function hash(value) {
        let h = 2166136261;
        for (let i = 0; i < value.length; i += 1) {
            h ^= value.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return (h >>> 0).toString(36);
    }

    function create(options) {
        options = options || {};
        const storage = options.storage || global.localStorage;
        const now = options.now || (() => new Date());
        const maxPerPerson = Number(options.maxPerPerson || 200);

        function key(person) {
            return KEY_PREFIX + cleanText(person, 80);
        }

        function today() {
            const current = now();
            return localDate(current instanceof Date ? current : new Date(Number(current)));
        }

        function identity(person, date, kind, original, suggestion) {
            const source = [person, date, kind, original.toLowerCase(), suggestion.toLowerCase()].join("|");
            return "practice_" + hash(source);
        }

        function normalize(person, input) {
            if (!input) return null;
            const safePerson = cleanText(person || input.person, 80);
            const original = cleanText(input.original, 500);
            const suggestion = cleanText(input.suggestion, 500);
            const kind = VALID_KINDS.has(input.kind) ? input.kind : "corrected";
            if (!safePerson || !suggestion) return null;
            const current = now();
            const timestamp = current instanceof Date ? current.getTime() : Number(current);
            const date = /^\d{4}-\d{2}-\d{2}$/.test(input.date || "")
                ? input.date : localDate(new Date(Number.isFinite(timestamp) ? timestamp : Date.now()));
            const first = Number(input.firstPracticedAt || input.timestamp || timestamp || Date.now());
            const last = Number(input.lastPracticedAt || input.timestamp || timestamp || first);
            return {
                version: VERSION,
                id: cleanText(input.id, 100) || identity(safePerson, date, kind, original, suggestion),
                person: safePerson,
                date,
                kind,
                original,
                suggestion,
                focus: cleanText(input.focus, 160),
                unit: cleanText(input.unit, 240),
                mode: input.mode === "news" ? "news" : "lesson",
                firstPracticedAt: Number.isFinite(first) ? first : Date.now(),
                lastPracticedAt: Number.isFinite(last) ? last : first,
                count: Math.max(1, Math.floor(Number(input.count || 1)))
            };
        }

        function sortAndLimit(list) {
            return list.sort((a, b) => b.lastPracticedAt - a.lastPracticedAt).slice(0, maxPerPerson);
        }

        function load(person) {
            try {
                const parsed = JSON.parse(storage.getItem(key(person)) || "[]");
                if (!Array.isArray(parsed)) return [];
                return sortAndLimit(parsed.map(item => normalize(person, item)).filter(Boolean));
            } catch (e) {
                return [];
            }
        }

        function save(person, list) {
            const safe = sortAndLimit((list || []).map(item => normalize(person, item)).filter(Boolean));
            try { storage.setItem(key(person), JSON.stringify(safe)); } catch (e) {}
            return safe;
        }

        function combine(person, local, incoming) {
            const map = new Map();
            [...(local || []), ...(incoming || [])].forEach(raw => {
                const item = normalize(person, raw);
                if (!item) return;
                const current = map.get(item.id);
                if (!current) {
                    map.set(item.id, item);
                    return;
                }
                current.count = Math.max(current.count, item.count);
                current.firstPracticedAt = Math.min(current.firstPracticedAt, item.firstPracticedAt);
                current.lastPracticedAt = Math.max(current.lastPracticedAt, item.lastPracticedAt);
                current.original = current.original || item.original;
                current.suggestion = current.suggestion || item.suggestion;
                current.focus = current.focus || item.focus;
                current.unit = current.unit || item.unit;
                if (item.lastPracticedAt >= current.lastPracticedAt) current.mode = item.mode;
            });
            return sortAndLimit(Array.from(map.values()));
        }

        function record(person, input) {
            const item = normalize(person, input);
            if (!item) return null;
            const list = load(person);
            const hit = list.find(existing => existing.id === item.id);
            if (hit) {
                hit.count += 1;
                hit.lastPracticedAt = item.lastPracticedAt;
                hit.focus = hit.focus || item.focus;
                hit.unit = hit.unit || item.unit;
                save(person, list);
                return hit;
            }
            list.push(item);
            save(person, list);
            return item;
        }

        function merge(person, incoming) {
            return save(person, combine(person, load(person), incoming));
        }

        function all(people) {
            return (people || []).flatMap(person => load(person));
        }

        function recent(person, limit, excludeDate) {
            return load(person)
                .filter(item => !excludeDate || item.date !== excludeDate)
                .slice(0, Number(limit || 12));
        }

        function summary(person) {
            const list = load(person);
            const kinds = { translated: 0, corrected: 0, alternative: 0 };
            list.forEach(item => { kinds[item.kind] += 1; });
            return {
                entries: list.length,
                attempts: list.reduce((sum, item) => sum + item.count, 0),
                days: new Set(list.map(item => item.date)).size,
                kinds
            };
        }

        function clear(person) {
            try { storage.removeItem(key(person)); } catch (e) {}
        }

        return { key, today, load, save, record, merge, all, recent, summary, clear };
    }

    global.LearningRecords = { VERSION, KEY_PREFIX, create };
})(window);
