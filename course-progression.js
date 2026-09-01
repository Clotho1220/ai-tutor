(function (global) {
    "use strict";

    function orderedUnits(books) {
        const ordered = [];
        (books || []).forEach(book => {
            (book.units || []).forEach(unit => {
                if (unit && unit.book != null && unit.num != null) ordered.push(unit);
            });
        });
        return ordered;
    }

    function indexOfUnit(ordered, current) {
        return ordered.findIndex(unit =>
            String(unit.book) === String(current && current.book) &&
            Number(unit.num) === Number(current && current.num));
    }

    function nextUnit(books, current) {
        const ordered = orderedUnits(books);
        const index = indexOfUnit(ordered, current);
        return index >= 0 && index + 1 < ordered.length ? ordered[index + 1] : null;
    }

    // 跨單元複習用：取目前單元之前的 N 個單元，最近的排在前面。
    // 課程設計是「這個單元學到的東西，會在接下來兩個單元裡被複習到」。
    //
    // 課本的 Review 單元（Review 1/2/3）不列入來源：它的單字就是前三個單元的單字，
    // 當成來源會讓同一批字被算兩次，每天的複習量跟著翻倍。
    function previousUnits(books, current, count) {
        const ordered = orderedUnits(books);
        const index = indexOfUnit(ordered, current);
        if (index <= 0) return [];
        const wanted = Math.max(0, Number(count) || 0);
        return ordered.slice(0, index)
            .filter(unit => String(unit.type || "unit") !== "review")
            .slice(-wanted).reverse();
    }

    // 週曆錨點：回傳該日期所在週的「週日」日期（週日為一週的開始）。
    // 換單元節奏（2026-09-01 使用者定案）：每週日強制換下一個單元，
    // 不再等五天上完；一週內照五天課程遞進。
    function weekAnchor(dateStr) {
        const parts = String(dateStr || "").split("-").map(Number);
        if (parts.length !== 3 || parts.some(isNaN)) return "";
        const date = new Date(parts[0], parts[1] - 1, parts[2]);
        date.setDate(date.getDate() - date.getDay());
        const pad = n => String(n).padStart(2, "0");
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }

    function shouldAdvance(options) {
        const config = options || {};
        const progress = config.progress;
        if (config.manual !== "auto" || !progress || !progress.date) return false;
        const dayCount = Math.max(1, Number(config.dayCount) || 1);
        return Number(progress.day) >= dayCount && String(progress.date) < String(config.today || "");
    }

    global.CourseProgression = Object.freeze({ nextUnit, previousUnits, shouldAdvance, weekAnchor });
})(window);
