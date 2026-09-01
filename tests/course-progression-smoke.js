(async function () {
    "use strict";
    const checks = [];
    function check(name, pass) { checks.push({ name, pass: !!pass }); }

    const books = [
        { name: "Book 2", units: [
            { book: "Book 2", num: 1 }, { book: "Book 2", num: 2 }
        ] },
        { name: "Book 3", units: [
            { book: "Book 3", num: 1 }
        ] }
    ];
    check("moves to the next unit in the same book",
        CourseProgression.nextUnit(books, { book: "Book 2", num: 1 }).num === 2);
    const crossBook = CourseProgression.nextUnit(books, { book: "Book 2", num: 2 });
    check("moves from the end of one book to the first unit of the next",
        crossBook && crossBook.book === "Book 3" && crossBook.num === 1);
    check("does not wrap after the final available unit",
        CourseProgression.nextUnit(books, { book: "Book 3", num: 1 }) === null);
    check("advances completed day 5 on a later date",
        CourseProgression.shouldAdvance({ progress: { day: 5, date: "2026-08-01" }, today: "2026-08-02", manual: "auto", dayCount: 5 }));
    check("same-day repeat stays on day 5",
        !CourseProgression.shouldAdvance({ progress: { day: 5, date: "2026-08-02" }, today: "2026-08-02", manual: "auto", dayCount: 5 }));
    check("manual scheduling never changes units",
        !CourseProgression.shouldAdvance({ progress: { day: 5, date: "2026-08-01" }, today: "2026-08-02", manual: "5", dayCount: 5 }));
    check("unfinished units stay selected",
        !CourseProgression.shouldAdvance({ progress: { day: 4, date: "2026-08-01" }, today: "2026-08-02", manual: "auto", dayCount: 5 }));

    const appSource = await fetch('../app.js?course-progression-test=' + Date.now()).then(response => response.text());
    const indexSource = await fetch('../index.html?course-progression-test=' + Date.now()).then(response => response.text());
    check("progression module loads before app",
        indexSource.indexOf('src="course-progression.js') < indexSource.indexOf('src="app.js'));
    check("selected unit is updated for cross-device sync",
        /updateCurrentPerson\(\{ unit: \{ book: next\.book, num: next\.num \}, unitWeek: currentWeek \}\)/.test(appSource));

    // --- 週曆制（2026-09-01 使用者定案）：每週日換單元 ---
    check("weekAnchor returns the Sunday of the week",
        CourseProgression.weekAnchor("2026-09-01") === "2026-08-30" &&
        CourseProgression.weekAnchor("2026-08-30") === "2026-08-30" &&
        CourseProgression.weekAnchor("2026-09-06") === "2026-09-06");
    check("a new week switches to the next unit in auto mode",
        /p\.unitWeek < currentWeek/.test(appSource) &&
        /🗓️ 新的一週/.test(appSource));
    check("last week's day progress never carries over",
        /saved\.week && saved\.week !== currentWeek\) saved = null/.test(appSource));
    check("the week anchor syncs across phones",
        /unitWeek: person\.unitWeek \|\| ""/.test(appSource) &&
        /if \(r\.unitWeek\) p\.people\[name\]\.unitWeek = r\.unitWeek;/.test(appSource));

    // --- 迴歸：課程長度依內容多寡決定，且不超過孩子的專注力上限 ---
    // 起因：Book 1 第 1 天只有 2 個項目卻固定排 11 分鐘主課，
    // 模型沒有素材可教，只能反覆操練同一句。
    const appSourceForLength = await fetch('../app.js?course-length-test=' + Date.now()).then(r => r.text());
    check("lesson length scales with the number of items",
        /const MINUTES_PER_ITEM/.test(appSourceForLength) &&
        /function minutesForItems/.test(appSourceForLength) &&
        !/minutes: i === 0 \? 11 : 8/.test(appSourceForLength));
    check("a total lesson cap keeps sessions within the attention limit",
        /const MAX_LESSON_MINUTES = 15/.test(appSourceForLength) &&
        /function capLessonMinutes/.test(appSourceForLength) &&
        /stages: capLessonMinutes\(stages\)/.test(appSourceForLength));
    check("review minutes use a faster per-item rate than new teaching",
        /const REVIEW_MINUTES_PER_ITEM = 1\.5/.test(appSourceForLength));

    const passed = checks.every(item => item.pass);
    const result = document.getElementById('result');
    result.textContent = (passed ? 'PASS' : 'FAIL') + '\n' +
        checks.map(item => `${item.pass ? 'OK' : 'NOT OK'} - ${item.name}`).join('\n');
    document.title = passed ? 'PASS - course progression smoke test' : 'FAIL - course progression smoke test';
})();
