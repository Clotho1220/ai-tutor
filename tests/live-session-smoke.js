(async function () {
    "use strict";

    const checks = [];
    const timers = new Map();
    let nextTimerId = 1;

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

    function runTimers() {
        const pending = Array.from(timers.values());
        timers.clear();
        pending.forEach(callback => callback());
    }

    const session = LiveSession.create({
        setTimeoutFn: setTimer,
        clearTimeoutFn: clearTimer,
        maxReconnects: 3
    });

    session.start();
    const socketA = { name: 'A' };
    const tokenA = session.adopt(socketA);
    check('first socket is current', session.isCurrent(socketA, tokenA));
    const duplicateSocket = { name: 'duplicate' };
    check('second simultaneous socket is rejected', session.adopt(duplicateSocket) === null && session.currentSocket() === socketA);
    check('current socket can be released once', session.release(socketA, tokenA));

    let reconnectRuns = 0;
    const attemptOne = session.scheduleReconnect(() => { reconnectRuns += 1; }, 800);
    const attemptTwo = session.scheduleReconnect(() => { reconnectRuns += 1; }, 800);
    check('only one reconnect timer remains', attemptOne === 1 && attemptTwo === 1 && timers.size === 1);
    runTimers();
    check('latest reconnect timer runs once', reconnectRuns === 1);

    const socketB = { name: 'B' };
    const tokenB = session.adopt(socketB);
    check('new socket replaces old socket generation', session.isCurrent(socketB, tokenB) && !session.isCurrent(socketA, tokenA));
    check('late close from old socket is ignored', session.release(socketA, tokenA) === false && session.currentSocket() === socketB);
    check('healthy current socket resets reconnect count', session.markHealthy(socketB, tokenB) && session.inspectState().reconnectAttempts === 0);

    session.release(socketB, tokenB);
    session.scheduleReconnect(() => { reconnectRuns += 1; }, 800);
    const stoppedSocket = session.stop();
    runTimers();
    check('stop cancels pending reconnect', stoppedSocket === null && reconnectRuns === 1 && timers.size === 0);
    check('stopped session rejects stale events', !session.isCurrent(socketB, tokenB) && !session.isActive());

    session.start();
    const socketC = { name: 'C' };
    const tokenC = session.adopt(socketC);
    const returnedSocket = session.stop();
    check('stop returns current socket for caller cleanup', returnedSocket === socketC && !session.isCurrent(socketC, tokenC));

    session.start();
    let cappedRuns = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        session.scheduleReconnect(() => { cappedRuns += 1; }, 800);
        runTimers();
    }
    const cappedAttempt = session.scheduleReconnect(() => { cappedRuns += 1; }, 800);
    check('reconnect attempts stop at configured limit', cappedRuns === 3 && cappedAttempt === null && timers.size === 0);
    session.stop();

    const appSource = await fetch('../app.js?live-session-test=' + Date.now()).then(response => response.text());
    const indexSource = await fetch('../index.html?live-session-test=' + Date.now()).then(response => response.text());
    const socketOpenBlock = appSource.slice(appSource.indexOf('socket.onopen ='), appSource.indexOf('socket.onmessage ='));
    check('lifecycle controller loads before app', indexSource.indexOf('src="live-session.js') < indexSource.indexOf('src="app.js'));
    check('socket handlers reject stale generations', /liveSession\.isCurrent\(socket, socketToken\)/.test(appSource));
    check('disconnect clears queued playback', /release\(socket, socketToken\)[\s\S]{0,300}stopAllPlayback\(\)/.test(appSource));
    check('talk button shows reconnect state', /talkBtn\.textContent = '\uD83D\uDD04 \u6B63\u5728\u91CD\u9023\.\.\.'/u.test(appSource));
    check('Gemini socket opening alone does not start the lesson timer', !/startLessonTimer\(\)/.test(socketOpenBlock));
    check('Gemini setupComplete marks the model ready',
        /if \(response\.setupComplete\)[\s\S]{0,500}markSessionReady\('gemini'/.test(appSource));

    const passed = checks.every(item => item.pass);
    const result = document.getElementById('result');
    result.className = passed ? 'pass' : 'fail';
    result.textContent = (passed ? 'PASS' : 'FAIL') + '\n' +
        checks.map(item => `${item.pass ? 'OK' : 'NOT OK'} - ${item.name}`).join('\n');
    document.title = passed ? 'PASS - live session smoke test' : 'FAIL - live session smoke test';
})();
