(async function () {
    "use strict";
    const checks = [];
    function check(name, pass) { checks.push({ name, pass: !!pass }); }

    check("OpenAI Realtime factory is available", typeof OpenAIRealtime.create === "function");
    const source = await fetch('../openai-realtime.js?test=' + Date.now()).then(response => response.text());
    const app = await fetch('../app.js?test=' + Date.now()).then(response => response.text());
    const backend = await fetch('../sync.gs?test=' + Date.now()).then(response => response.text());
    const index = await fetch('../index.html?test=' + Date.now()).then(response => response.text());
    check("uses GPT Realtime 2.1 mini by default", /gpt-realtime-2\.1-mini/.test(source));
    check("uses WebRTC calls endpoint", /https:\/\/api\.openai\.com\/v1\/realtime\/calls/.test(source));
    check("speaker mode selects speakerphone microphone when available", /speakerphone\|speaker\|擴音\|喇叭/.test(source));
    check("audio always falls back to direct WebRTC playback", /audioElement\.srcObject\s*=\s*remoteStream/.test(source));
    check("uses the current realtime transcription model", /gpt-4o-mini-transcribe/.test(source));
    check("settings expose per-person GPT speed", /id="openaiSpeedSelect"/.test(index) && /gptSpeed/.test(app));
    check("Realtime session sends output speed", /output:\s*\{\s*voice:[^}]*speed:\s*outputSpeed/.test(source));
    check("push-to-talk cancels an active GPT response", /type:\s*["']response\.cancel["']/.test(source));
    check("push-to-talk clears buffered WebRTC audio", /type:\s*["']output_audio_buffer\.clear["']/.test(source));
    check("closed sessions reject queued stale events", /connectionGeneration/.test(source) && /if\s*\(!active\)\s*return/.test(source));
    check("browser requests only a short-lived client secret", /openaiClientSecret/.test(source) && !/OPENAI_API_KEY/.test(source));
    check("backend reads API key from Script Properties", /getScriptProperties\(\)\.getProperty\('OPENAI_API_KEY'\)/.test(backend));
    check("backend restricts models and voices", /allowedModels/.test(backend) && /allowedVoices/.test(backend));
    check("backend allows mini and quality models", /'gpt-realtime-2\.1-mini', 'gpt-realtime'/.test(backend));
    check("backend supplies current news headlines", /newsTopics_/.test(backend) && /news\.google\.com\/rss/.test(backend));
    check("OpenAI module loads before app", index.indexOf('src="openai-realtime.js') < index.indexOf('src="app.js'));
    check("settings combine all engines in one picker", /id="engineSelect"/.test(index) && /gpt-mini/.test(index) && /gpt-quality/.test(index));
    check("CSP permits OpenAI WebRTC setup", /connect-src[^\"]*https:\/\/api\.openai\.com/.test(index));

    const passed = checks.every(item => item.pass);
    const result = document.getElementById('result');
    result.className = passed ? 'pass' : 'fail';
    result.textContent = (passed ? 'PASS' : 'FAIL') + '\n' + checks.map(item => `${item.pass ? 'OK' : 'NOT OK'} - ${item.name}`).join('\n');
    document.title = passed ? 'PASS - OpenAI Realtime smoke test' : 'FAIL - OpenAI Realtime smoke test';
})();
