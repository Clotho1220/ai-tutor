(function (global) {
    "use strict";

    function create(options) {
        const config = options || {};
        const fetchFn = config.fetchFn || global.fetch.bind(global);
        const PeerConnection = config.RTCPeerConnectionCtor || global.RTCPeerConnection;
        const AudioCtor = config.AudioCtor || global.Audio;
        let peer = null;
        let channel = null;
        let stream = null;
        let track = null;
        let audioElement = null;
        let active = false;
        let talking = false;
        let responseInProgress = false;
        let outputAudioPlaying = false;
        let cancellationPending = false;
        let responseCreatePending = false;
        let sessionReadyResolve = null;
        let sessionReadyReject = null;
        let connectionGeneration = 0;
        let handlers = {};

        function emit(name, detail) {
            if (typeof handlers[name] === "function") handlers[name](detail);
        }

        function send(event) {
            if (!channel || channel.readyState !== "open") return false;
            channel.send(JSON.stringify(event));
            return true;
        }

        function handleEvent(event) {
            if (!active) return;
            emit("onEvent", event);
            if (event.type === "response.created") {
                responseInProgress = true;
            } else if (event.type === "output_audio_buffer.started") {
                outputAudioPlaying = true;
            } else if (event.type === "output_audio_buffer.stopped" || event.type === "output_audio_buffer.cleared") {
                outputAudioPlaying = false;
            } else if (event.type === "session.created") {
                emit("onState", { state: "session-created", event });
            } else if (event.type === "session.updated") {
                emit("onState", { state: "ready", event });
                if (sessionReadyResolve) {
                    const resolve = sessionReadyResolve;
                    sessionReadyResolve = null;
                    sessionReadyReject = null;
                    resolve(event);
                }
            } else if (event.type === "conversation.item.input_audio_transcription.delta") {
                emit("onTranscript", { role: "student", text: event.delta || "", final: false, event });
            } else if (event.type === "conversation.item.input_audio_transcription.completed") {
                emit("onTranscript", { role: "student", text: event.transcript || "", final: true, event });
            } else if (event.type === "response.output_audio_transcript.delta") {
                emit("onTranscript", { role: "ai", text: event.delta || "", final: false, event });
            } else if (event.type === "response.output_audio_transcript.done") {
                emit("onTranscript", { role: "ai", text: event.transcript || "", final: true, event });
            } else if (event.type === "response.done") {
                responseInProgress = false;
                cancellationPending = false;
                if (responseCreatePending && !talking) {
                    responseCreatePending = false;
                    send({ type: "response.create" });
                }
                emit("onTurnComplete", event);
            } else if (event.type === "error") {
                const error = new Error((event.error && event.error.message) || "OpenAI Realtime error");
                if (sessionReadyReject) {
                    const reject = sessionReadyReject;
                    sessionReadyResolve = null;
                    sessionReadyReject = null;
                    reject(error);
                }
                emit("onError", error);
            }
        }

        async function requestClientSecret(settings) {
            const response = await fetchFn(settings.tokenEndpoint, {
                method: "POST",
                body: JSON.stringify({
                    action: "openaiClientSecret",
                    secret: settings.syncSecret || "",
                    data: {
                        model: settings.model || "gpt-realtime-2.1-mini",
                        voice: settings.voice || "marin",
                        learnerId: settings.learnerId || "family-learner"
                    }
                })
            });
            const payload = await response.json();
            if (!response.ok || !payload.ok) throw new Error(payload.error || "無法取得 OpenAI 短效憑證");
            const value = payload.data && (payload.data.value || (payload.data.client_secret && payload.data.client_secret.value));
            if (!value) throw new Error("後端沒有回傳 OpenAI 短效憑證");
            return value;
        }

        async function waitForIceGatheringComplete(pc) {
            if (pc.iceGatheringState === "complete") return;
            await new Promise(resolve => {
                const listener = () => {
                    if (pc.iceGatheringState !== "complete") return;
                    pc.removeEventListener("icegatheringstatechange", listener);
                    resolve();
                };
                pc.addEventListener("icegatheringstatechange", listener);
            });
        }

        async function acquireMicrophone(audioMode) {
            const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
            let micStream = await global.navigator.mediaDevices.getUserMedia({ audio: base });
            if (audioMode !== "speaker") return micStream;

            const devices = await global.navigator.mediaDevices.enumerateDevices();
            const microphones = devices.filter(device => device.kind === "audioinput");
            const speakerphone = microphones.find(device => /speakerphone|speaker|擴音|喇叭/i.test(device.label || ""));
            micStream.getTracks().forEach(item => item.stop());
            if (speakerphone) {
                emit("onAudioRoute", { route: "speakerphone-microphone", label: speakerphone.label });
                return global.navigator.mediaDevices.getUserMedia({
                    audio: Object.assign({}, base, { deviceId: { exact: speakerphone.deviceId } })
                });
            }
            emit("onAudioRoute", { route: "speaker-fallback-no-aec", microphones: microphones.map(item => item.label || "(no label)") });
            return global.navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true }
            });
        }

        async function connect(settings) {
            if (active) throw new Error("OpenAI Realtime session 已經啟動");
            if (!settings || !settings.tokenEndpoint) throw new Error("尚未設定短效憑證後端網址");
            if (!PeerConnection) throw new Error("這個瀏覽器不支援 WebRTC");
            handlers = settings;
            const outputSpeed = Math.min(1.5, Math.max(0.25, Number(settings.speed) || 1));
            const generation = ++connectionGeneration;
            emit("onState", { state: "connecting" });

            const clientSecret = await requestClientSecret(settings);
            peer = new PeerConnection();
            channel = peer.createDataChannel("oai-events");
            channel.addEventListener("message", message => {
                if (generation !== connectionGeneration) return;
                try { handleEvent(JSON.parse(message.data)); }
                catch (error) { emit("onError", error); }
            });

            audioElement = new AudioCtor();
            audioElement.autoplay = true;
            audioElement.setAttribute && audioElement.setAttribute("playsinline", "");
            peer.addEventListener("track", event => {
                if (generation !== connectionGeneration) return;
                const remoteStream = event.streams[0];
                audioElement.srcObject = remoteStream;
                const playResult = audioElement.play && audioElement.play();
                if (playResult && typeof playResult.then === "function") {
                    playResult.then(() => emit("onAudioRoute", { route: "webrtc-direct-playing", audioMode: settings.audioMode }))
                        .catch(error => emit("onError", new Error("GPT 音訊播放失敗：" + error.message)));
                }
            });

            stream = await acquireMicrophone(settings.audioMode);
            track = stream.getAudioTracks()[0];
            if (!track) throw new Error("找不到麥克風音軌");
            track.enabled = false; // Push-to-talk：連線後先保持靜音
            peer.addTrack(track, stream);

            const opened = new Promise((resolve, reject) => {
                channel.addEventListener("open", resolve, { once: true });
                channel.addEventListener("error", () => reject(new Error("OpenAI 資料通道開啟失敗")), { once: true });
            });
            const offer = await peer.createOffer();
            await peer.setLocalDescription(offer);
            await waitForIceGatheringComplete(peer);

            const form = new FormData();
            form.append("sdp", peer.localDescription.sdp);
            form.append("session", JSON.stringify({ type: "realtime", model: settings.model || "gpt-realtime-2.1-mini" }));
            const sdpResponse = await fetchFn("https://api.openai.com/v1/realtime/calls", {
                method: "POST",
                body: form,
                headers: { Authorization: `Bearer ${clientSecret}` }
            });
            if (!sdpResponse.ok) throw new Error(`OpenAI WebRTC 連線失敗 (${sdpResponse.status})`);
            await peer.setRemoteDescription({ type: "answer", sdp: await sdpResponse.text() });
            await opened;

            if (generation !== connectionGeneration) throw new Error("OpenAI 連線已取消");
            active = true;
            const sessionReady = new Promise((resolve, reject) => {
                sessionReadyResolve = resolve;
                sessionReadyReject = reject;
            });
            send({
                type: "session.update",
                session: {
                    type: "realtime",
                    model: settings.model || "gpt-realtime-2.1-mini",
                    instructions: settings.instructions || "",
                    output_modalities: ["audio"],
                    audio: {
                        input: {
                            turn_detection: null,
                            transcription: { model: "gpt-4o-mini-transcribe" }
                        },
                        output: { voice: settings.voice || "marin", speed: outputSpeed }
                    }
                }
            });
            emit("onState", { state: "connected" });
            let readyTimer = null;
            try {
                await Promise.race([
                    sessionReady,
                    new Promise((resolve, reject) => {
                        readyTimer = global.setTimeout(() => reject(new Error("OpenAI 模型確認逾時")), 15000);
                    })
                ]);
            } finally {
                if (readyTimer) global.clearTimeout(readyTimer);
                sessionReadyResolve = null;
                sessionReadyReject = null;
            }
            return inspect();
        }

        function startTalking() {
            if (!active || !track || talking) return false;
            // Push-to-talk 沒有 VAD 幫忙插話；必須由前端主動取消生成並清掉 WebRTC 播放緩衝。
            cancellationPending = responseInProgress;
            responseCreatePending = false;
            if (cancellationPending) send({ type: "response.cancel" });
            if (responseInProgress || outputAudioPlaying) send({ type: "output_audio_buffer.clear" });
            outputAudioPlaying = false;
            muteOutput(true);
            send({ type: "input_audio_buffer.clear" });
            track.enabled = true;
            talking = true;
            emit("onState", { state: "talking" });
            return true;
        }

        function stopTalking() {
            if (!active || !track || !talking) return false;
            track.enabled = false;
            talking = false;
            muteOutput(false);
            send({ type: "input_audio_buffer.commit" });
            if (cancellationPending || responseInProgress) {
                // Wait for response.done from the cancelled turn. Sending response.create
                // before that acknowledgement causes "active response in progress".
                responseCreatePending = true;
            } else {
                send({ type: "response.create" });
            }
            emit("onState", { state: "waiting" });
            return true;
        }

        function sendText(text, requestResponse) {
            if (!text) return false;
            const sent = send({
                type: "conversation.item.create",
                item: { type: "message", role: "user", content: [{ type: "input_text", text: String(text) }] }
            });
            if (sent && requestResponse !== false) send({ type: "response.create" });
            return sent;
        }

        function muteOutput(value) {
            if (audioElement) audioElement.muted = !!value;
        }

        function close() {
            if (sessionReadyReject) {
                const reject = sessionReadyReject;
                sessionReadyResolve = null;
                sessionReadyReject = null;
                reject(new Error("OpenAI 連線已關閉"));
            }
            if (active) {
                if (responseInProgress) send({ type: "response.cancel" });
                if (responseInProgress || outputAudioPlaying) send({ type: "output_audio_buffer.clear" });
            }
            connectionGeneration += 1;
            active = false;
            talking = false;
            responseInProgress = false;
            outputAudioPlaying = false;
            cancellationPending = false;
            responseCreatePending = false;
            if (track) track.enabled = false;
            if (stream) stream.getTracks().forEach(item => item.stop());
            if (channel) try { channel.close(); } catch (error) {}
            if (peer) try { peer.close(); } catch (error) {}
            if (audioElement) {
                try { audioElement.pause(); } catch (error) {}
                audioElement.srcObject = null;
            }
            peer = null; channel = null; stream = null; track = null; audioElement = null;
            emit("onState", { state: "closed" });
        }

        function inspect() {
            return Object.freeze({
                active,
                talking,
                responseInProgress,
                outputAudioPlaying,
                cancellationPending,
                responseCreatePending,
                channelState: channel ? channel.readyState : "closed"
            });
        }

        return Object.freeze({ connect, startTalking, stopTalking, sendText, muteOutput, close, inspect });
    }

    global.OpenAIRealtime = Object.freeze({ create });
})(window);
