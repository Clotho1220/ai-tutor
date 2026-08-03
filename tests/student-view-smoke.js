(async function () {
    "use strict";

    const checks = [];
    const timers = new Map();
    let nextTimerId = 1;

    class FakeImage {
        static instances = [];
        constructor() {
            this.onload = null;
            this.onerror = null;
            this._src = "";
            FakeImage.instances.push(this);
        }
        set src(value) { this._src = value; }
        get src() { return this._src; }
        succeed() { if (this.onload) this.onload(); }
        fail() { if (this.onerror) this.onerror(); }
    }

    function check(name, pass) {
        checks.push({ name, pass: !!pass });
    }

    function setTimer(callback) {
        const id = nextTimerId++;
        timers.set(id, callback);
        return id;
    }

    function clearTimer(id) {
        timers.delete(id);
    }

    function runPendingTimers() {
        const pending = Array.from(timers.values());
        timers.clear();
        pending.forEach(callback => callback());
    }

    const controller = StudentView.create({
        document,
        ImageCtor: FakeImage,
        setTimeoutFn: setTimer,
        clearTimeoutFn: clearTimer,
        timeoutMs: 100
    });
    const image = document.getElementById('svImage');
    const word = document.getElementById('svWord');
    const meaning = document.getElementById('svMeaning');
    const say = document.getElementById('svSay');
    const status = document.getElementById('svImageStatus');

    controller.reset();
    const firstStatuses = [];
    controller.showImage('/notebook.png', 'notebook', { onStatus: value => firstStatuses.push(value) });
    const staleNotebook = FakeImage.instances.at(-1);
    controller.showWord('a pencil (noun)', '\u925b\u7b46', 'This is a pencil.');
    staleNotebook.succeed();
    check('new word hides the previous image immediately', image.style.display === 'none' && !image.getAttribute('src'));
    check('late previous image is ignored', word.textContent === 'a pencil (noun)' && firstStatuses.includes('cancelled'));

    controller.showImage('/pencil.png', 'pencil');
    check('article and part-of-speech variants preserve details', meaning.textContent === '\u925b\u7b46' && say.textContent === 'This is a pencil.');
    FakeImage.instances.at(-1).succeed();
    check('current image becomes visible', image.style.display === 'block' && image.getAttribute('src') === '/pencil.png');

    controller.showImage('/notebook-2.png', 'notebook');
    const olderRequest = FakeImage.instances.at(-1);
    controller.showImage('/eraser.png', 'eraser');
    const newestRequest = FakeImage.instances.at(-1);
    olderRequest.succeed();
    check('superseded request cannot replace current content', image.style.display === 'none' && word.textContent === 'eraser');
    newestRequest.succeed();
    check('latest request wins', image.getAttribute('src') === '/eraser.png' && image.style.display === 'block');

    const duplicateStatuses = [];
    controller.showImage('/eraser-old.png', 'eraser', { onStatus: value => duplicateStatuses.push(value) });
    const duplicateOld = FakeImage.instances.at(-1);
    controller.showImage('/eraser-new.png', 'eraser');
    const duplicateNew = FakeImage.instances.at(-1);
    duplicateOld.succeed();
    duplicateNew.succeed();
    check('duplicate same-word request cancels the older request', duplicateStatuses.includes('cancelled') && image.getAttribute('src') === '/eraser-new.png');

    controller.reset();
    controller.showWord('pencil (noun)', '\u925b\u7b46', 'This is a pencil.');
    controller.showImage('/pencil-scene.png', 'a red pencil on a desk');
    const describedPencil = FakeImage.instances.at(-1);
    describedPencil.succeed();
    check('a detailed image prompt stays paired with its core vocabulary word',
        word.textContent === 'pencil (noun)' && meaning.textContent === '\u925b\u7b46' &&
        image.getAttribute('src') === '/pencil-scene.png' && image.style.display === 'block');

    controller.reset();
    const notebookStatuses = [];
    controller.showImage('/notebook-scene.png', 'an open notebook on a desk', { onStatus: value => notebookStatuses.push(value) });
    const describedNotebook = FakeImage.instances.at(-1);
    controller.showWord('notebook (noun)', '\u7b46\u8a18\u672c', 'This is my notebook.');
    describedNotebook.succeed();
    check('vocabulary details arriving after a related image do not cancel it',
        !notebookStatuses.includes('cancelled') && word.textContent === 'notebook (noun)' &&
        image.getAttribute('src') === '/notebook-scene.png');

    controller.showImage('/pen.png', 'pen');
    const penRequest = FakeImage.instances.at(-1);
    controller.showWord('pencil', '\u925b\u7b46', 'This is a pencil.');
    penRequest.succeed();
    check('whole-word matching does not confuse pen with pencil',
        image.style.display === 'none' && word.textContent === 'pencil');

    controller.showImage('/slow.png', 'slow picture');
    const slowRequest = FakeImage.instances.at(-1);
    runPendingTimers();
    check('slow image shows a child-friendly fallback', controller.inspectState().imageState === 'slow' && status.style.display === 'block');
    slowRequest.succeed();
    check('slow image may safely appear later', controller.inspectState().imageState === 'ready' && image.getAttribute('src') === '/slow.png');

    controller.beginTranscriptTurn();
    controller.appendTranscript('Hello ');
    controller.appendTranscript('world');
    check('transcript appends within one turn', controller.transcriptText() === 'Hello world');
    controller.beginTranscriptTurn();
    check('new transcript turn clears old text', controller.transcriptText() === '');

    const appSource = await fetch('../app.js?student-view-test=' + Date.now()).then(response => response.text());
    const indexSource = await fetch('../index.html?student-view-test=' + Date.now()).then(response => response.text());
    check('home provides a return-to-student-view button',
        /id="resumeStudentBtn"/.test(indexSource) && /回到學生畫面/.test(indexSource));
    check('return-to-student-view is available only while the model is ready',
        /const shouldShow = sessionReady && !document\.body\.classList\.contains\('student-mode'\)/.test(appSource));
    check('initial startup does not enter student mode before readiness',
        /模型 setupComplete 後才進學生畫面/.test(appSource) && /markSessionReady\('gemini'/.test(appSource));
    check('student view controller loads before app', indexSource.indexOf('src="student-view.js') < indexSource.indexOf('src="app.js'));
    check('tool responses wait for image readiness', /await showImage\(keyword\)/.test(appSource));
    check('legacy student image globals are removed', !/studentImgSeq|studentImgWord/.test(appSource));

    const passed = checks.every(item => item.pass);
    const result = document.getElementById('result');
    result.className = passed ? 'pass' : 'fail';
    result.textContent = (passed ? 'PASS' : 'FAIL') + '\n' +
        checks.map(item => `${item.pass ? 'OK' : 'NOT OK'} - ${item.name}`).join('\n');
    document.title = passed ? 'PASS - student view smoke test' : 'FAIL - student view smoke test';
})();
