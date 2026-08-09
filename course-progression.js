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
    function previousUnits(books, current, count) {
        const ordered = orderedUnits(books);
        const index = indexOfUnit(ordered, current);
        if (index <= 0) return [];
        const wanted = Math.max(0, Number(count) || 0);
        return ordered.slice(Math.max(0, index - wanted), index).reverse();
    }

    function shouldAdvance(options) {
        const config = options || {};
        const progress = config.progress;
        if (config.manual !== "auto" || !progress || !progress.date) return false;
        const dayCount = Math.max(1, Number(config.dayCount) || 1);
        return Number(progress.day) >= dayCount && String(progress.date) < String(config.today || "");
    }

    global.CourseProgression = Object.freeze({ nextUnit, previousUnits, shouldAdvance });
})(window);
