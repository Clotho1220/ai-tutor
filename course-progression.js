(function (global) {
    "use strict";

    function nextUnit(books, current) {
        const ordered = [];
        (books || []).forEach(book => {
            (book.units || []).forEach(unit => {
                if (unit && unit.book != null && unit.num != null) ordered.push(unit);
            });
        });
        const index = ordered.findIndex(unit =>
            String(unit.book) === String(current && current.book) &&
            Number(unit.num) === Number(current && current.num));
        return index >= 0 && index + 1 < ordered.length ? ordered[index + 1] : null;
    }

    function shouldAdvance(options) {
        const config = options || {};
        const progress = config.progress;
        if (config.manual !== "auto" || !progress || !progress.date) return false;
        const dayCount = Math.max(1, Number(config.dayCount) || 1);
        return Number(progress.day) >= dayCount && String(progress.date) < String(config.today || "");
    }

    global.CourseProgression = Object.freeze({ nextUnit, shouldAdvance });
})(window);
