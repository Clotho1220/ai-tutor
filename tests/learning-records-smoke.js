(async function () {
    "use strict";

    const checks = [];
    function check(name, pass) { checks.push({ name, pass: !!pass }); }

    function memoryStorage() {
        const data = new Map();
        return {
            getItem: key => data.has(key) ? data.get(key) : null,
            setItem: (key, value) => data.set(key, String(value)),
            removeItem: key => data.delete(key)
        };
    }

    let clock = new Date("2026-08-02T02:00:00Z");
    const records = LearningRecords.create({ storage: memoryStorage(), now: () => clock, maxPerPerson: 3 });
    check("uses the Taiwan calendar date", records.today() === "2026-08-02");
    const first = records.record("Rex", {
        original: "我很好！", suggestion: "I am fine!", kind: "translated",
        focus: "be verb", unit: "Book 2 Unit 1", mode: "lesson"
    });
    check("records a translated sentence", first && first.date === "2026-08-02" && first.count === 1);
    check("stores the lesson context", first.unit === "Book 2 Unit 1" && first.focus === "be verb");

    clock = new Date("2026-08-02T03:00:00Z");
    const repeated = records.record("Rex", {
        original: "我很好！", suggestion: "I am fine!", kind: "translated",
        focus: "be verb", unit: "Book 2 Unit 1"
    });
    check("same feedback on the same day increments instead of duplicating", records.load("Rex").length === 1 && repeated.count === 2);

    records.record("Jessie", { original: "He go home.", suggestion: "He goes home.", kind: "corrected" });
    check("keeps each learner isolated", records.load("Jessie").length === 1 && records.load("Rex").length === 1);

    const remote = Object.assign({}, first, { count: 5, focus: "", lastPracticedAt: first.lastPracticedAt + 5000 });
    records.merge("Rex", [remote, {
        person: "Rex", date: "2026-08-01", original: "I am happy.", suggestion: "I feel great.",
        kind: "alternative", count: 1, firstPracticedAt: 1, lastPracticedAt: 2
    }]);
    const merged = records.load("Rex");
    check("cross-device merge keeps the union", merged.length === 2);
    check("cross-device merge uses the larger attempt count", merged.find(item => item.id === first.id).count === 5);
    check("cross-device merge preserves useful local detail", merged.find(item => item.id === first.id).focus === "be verb");

    records.record("Rex", { original: "one", suggestion: "One.", kind: "corrected" });
    records.record("Rex", { original: "two", suggestion: "Two.", kind: "corrected" });
    check("local history is bounded", records.load("Rex").length === 3);
    check("summary counts record types and attempts", records.summary("Jessie").kinds.corrected === 1 && records.summary("Jessie").attempts === 1);

    const appSource = await fetch('../app.js?learning-records-test=' + Date.now()).then(response => response.text());
    const indexSource = await fetch('../index.html?learning-records-test=' + Date.now()).then(response => response.text());
    const syncSource = await fetch('../sync.gs?learning-records-test=' + Date.now()).then(response => response.text());
    check("learning records load before app", indexSource.indexOf('src="learning-records.js') < indexSource.indexOf('src="app.js'));
    check("Gemini has a sentence feedback tool", /name:\s*"log_practice"/.test(appSource));
    check("sync payload includes practice records", /return \{ schemaVersion: 2, vocab, practice, profiles \}/.test(appSource));
    check("Apps Script merges practice records", /mergePractice_\(incoming\.practice \|\| \[\]\)/.test(syncSource));

    const passed = checks.every(item => item.pass);
    const result = document.getElementById('result');
    result.className = passed ? 'pass' : 'fail';
    result.textContent = (passed ? 'PASS' : 'FAIL') + '\n' +
        checks.map(item => `${item.pass ? 'OK' : 'NOT OK'} - ${item.name}`).join('\n');
    document.title = passed ? 'PASS - learning records smoke test' : 'FAIL - learning records smoke test';
})();
