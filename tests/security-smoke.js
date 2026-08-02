(async function () {
    "use strict";
    const fixture = document.getElementById('fixture');
    const result = document.getElementById('result');
    const payload = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>Hello';
    const checks = [];

    function check(name, pass) {
        checks.push({ name, pass: !!pass });
    }

    window.__xss = 0;
    SafeDOM.text(fixture, payload);
    check('text() keeps untrusted markup inert', fixture.textContent === payload && fixture.children.length === 0);
    check('no injected JavaScript executed', window.__xss === 0);

    SafeDOM.clear(fixture);
    const card = SafeDOM.element('div', { className: 'topic', text: payload });
    fixture.appendChild(card);
    check('element() renders topic as text', card.textContent === payload && card.children.length === 0);

    const plain = SafeDOM.legacyMarkupToText('<span style="color:red">warning</span><br><img src=x onerror=1>tail');
    check('legacy log markup is stripped', plain === 'warning\ntail');

    const appSource = await fetch('../app.js?security-test=' + Date.now()).then(r => r.text());
    const indexSource = await fetch('../index.html?security-test=' + Date.now()).then(r => r.text());
    check('app.js contains no innerHTML writes', !/\.innerHTML\s*[+]?=/.test(appSource));
    check('index has restrictive script CSP', /script-src 'self' blob:/.test(indexSource));
    check('index loads safe DOM helpers before app', indexSource.indexOf('src="dom-utils.js') < indexSource.indexOf('src="app.js'));

    const passed = checks.every(c => c.pass);
    result.className = passed ? 'pass' : 'fail';
    result.textContent = (passed ? 'PASS' : 'FAIL') + '\n' +
        checks.map(c => `${c.pass ? 'OK' : 'NOT OK'} - ${c.name}`).join('\n');
    document.title = passed ? 'PASS - security smoke test' : 'FAIL - security smoke test';
})();
