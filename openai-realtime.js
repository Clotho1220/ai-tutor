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
        let outputContext = null;
        let outputSource = null;
        let outputDestination = null;
        let active = false;
        let talking = false;
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
            emit("onEvent", event);
            if (event.type === "session.created" || event.type === "session.updated") {
                emit("onState", { state: "ready", event });
            } else if (event.type === "conversation.item.input_audio_transcription.delta") {
                emit("onTranscript", { role: "student", text: event.delta || "", final: false, event });
            } else if (event.type === "conversation.item.input_audio_transcription.completed") {
                emit("onTranscript", { role: "student", text: event.transcript || "", final: true, event });
            } else if (event.type === "response.output_audio_transcript.delta") {
                emit("onTranscript", { role: "ai", text: event.delta || "", final: false, event });
            } else if (event.type === "response.output_audio_transcript.done") {
                emit("onTranscript", { role: "ai", text: event.transcript || "", final: true, event });
            } else if (event.type === "response.done") {
                emit("onTurnComplete", event);
            } else if (event.type === "error") {
                emit("onError", new Error((event.error && event.error.message) || "OpenAI Realtime error"));
            }
        }

        async function requestClientSecret(settings) {
            const response = await fetchFn(settings.tokenEndpoint, {
                method: "POST",
                body: JSON.stringify({
                    action: "openaiClientSecret",
                    secret: settings.syncSecret || "",
                    data: {
                        model: settings.model || "gpt-realtime",
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

        async function connect(settings) {
            if (active) throw new Error("OpenAI Realtime session 已經啟動");
            if (!settings || !settings.tokenEndpoint) throw new Error("尚未設定短效憑證後端網址");
            if (!PeerConnection) throw new Error("這個瀏覽器不支援 WebRTC");
            handlers = settings;
            emit("onState", { state: "connecting" });

            const clientSecret = await requestClientSecret(settings);
            peer = new PeerConnection();
            channel = peer.createDataChannel("oai-events");
            channel.addEventListener("message", message => {
                try { handleEvent(JSON.parse(message.data)); }
                catch (error) { emit("onError", error); }
            });

            audioElement = new AudioCtor();
            audioElement.autoplay = true;
            audioElement.setAttribute && audioElement.setAttribute("playsinline", "");
            peer.addEventListener("track", event => {
                const remoteStream = event.streams[0];
                if (settings.audioMode === "speaker" && (global.AudioContext || global.webkitAudioContext)) {
                    const AudioContextCtor = global.AudioContext || global.webkitAudioContext;
                    outputContext = new AudioContextCtor();
                    outputSource = outputContext.createMediaStreamSource(remoteStream);
                    outputDestination = outputContext.createMediaStreamDestination();
                    outputSource.connect(outputDestination);
                    audioElement.srcObject = outputDestination.stream;
                    if (outputContext.state === "suspended") outputContext.resume().catch(() => {});
                } else {
                    audioElement.srcObject = remoteStream;
                }
                const playResult = audioElement.play && audioElement.play();
                if (playResult && typeof playResult.catch === "function") playResult.catch(() => {});
            });

            stream = await global.navigator.mediaDevices.getUserMedia({
                audio: settings.audioMode === "speaker"
                    ? { echoCancellation: false, noiseSuppression: true, autoGainControl: true }
                    : { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            });
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
            form.append("session", JSON.stringify({ type: "realtime", model: settings.model || "gpt-realtime" }));
            const sdpResponse = await fetchFn("https://api.openai.com/v1/realtime/calls", {
                method: "POST",
                body: form,
                headers: { Authorization: `Bearer ${clientSecret}` }
            });
            if (!sdpResponse.ok) throw new Error(`OpenAI WebRTC 連線失敗 (${sdpResponse.status})`);
            await peer.setRemoteDescription({ type: "answer", sdp: await sdpResponse.text() });
            await opened;

            send({
                type: "session.update",
                session: {
                    type: "realtime",
                    model: settings.model || "gpt-realtime",
                    instructions: settings.instructions || "",
                    output_modalities: ["audio"],
                    audio: {
                        input: {
                            turn_detection: null,
                            transcription: { model: "gpt-4o-mini-transcribe" }
                        },
                        output: { voice: settings.voice || "marin" }
                    }
                }
            });
            active = true;
            emit("onState", { state: "connected" });
            return inspect();
        }

        function startTalking() {
            if (!active || !track || talking) return false;
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
            send({ type: "input_audio_buffer.commit" });
            send({ type: "response.create" });
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
            active = false;
            talking = false;
            if (track) track.enabled = false;
            if (stream) stream.getTracks().forEach(item => item.stop());
            if (channel) try { channel.close(); } catch (error) {}
            if (peer) try { peer.close(); } catch (error) {}
            if (audioElement) {
                try { audioElement.pause(); } catch (error) {}
                audioElement.srcObject = null;
            }
            if (outputSource) try { outputSource.disconnect(); } catch (error) {}
            if (outputContext) try { outputContext.close(); } catch (error) {}
            peer = null; channel = null; stream = null; track = null; audioElement = null;
            outputContext = null; outputSource = null; outputDestination = null;
            emit("onState", { state: "closed" });
        }

        function inspect() {
            return Object.freeze({ active, talking, channelState: channel ? channel.readyState : "closed" });
        }

        return Object.freeze({ connect, startTalking, stopTalking, sendText, muteOutput, close, inspect });
    }

    global.OpenAIRealtime = Object.freeze({ create });
})(window);
