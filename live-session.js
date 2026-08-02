(function (global) {
    "use strict";

    function create(options) {
        const config = options || {};
        const setTimer = config.setTimeoutFn || global.setTimeout.bind(global);
        const clearTimer = config.clearTimeoutFn || global.clearTimeout.bind(global);
        const maxReconnects = Number.isInteger(config.maxReconnects) ? config.maxReconnects : 3;

        let active = false;
        let sessionGeneration = 0;
        let socketGeneration = 0;
        let currentSocket = null;
        let reconnectHandle = null;
        let reconnectAttempts = 0;

        function cancelReconnect() {
            if (reconnectHandle != null) clearTimer(reconnectHandle);
            reconnectHandle = null;
        }

        function start() {
            cancelReconnect();
            active = true;
            sessionGeneration += 1;
            socketGeneration = 0;
            currentSocket = null;
            reconnectAttempts = 0;
            return sessionGeneration;
        }

        function adopt(socket) {
            if (!active || !socket) return null;
            if (currentSocket) return null;
            cancelReconnect();
            currentSocket = socket;
            socketGeneration += 1;
            return Object.freeze({ sessionGeneration, socketGeneration });
        }

        function isCurrent(socket, token) {
            return !!(
                active && socket && token && currentSocket === socket &&
                token.sessionGeneration === sessionGeneration &&
                token.socketGeneration === socketGeneration
            );
        }

        function release(socket, token) {
            if (!isCurrent(socket, token)) return false;
            currentSocket = null;
            return true;
        }

        function markHealthy(socket, token) {
            if (!isCurrent(socket, token)) return false;
            reconnectAttempts = 0;
            return true;
        }

        function scheduleReconnect(callback, delayMs) {
            if (!active || currentSocket) return null;
            if (reconnectHandle != null) return reconnectAttempts;
            if (reconnectAttempts >= maxReconnects) return null;
            reconnectAttempts += 1;
            const attempt = reconnectAttempts;
            const expectedSession = sessionGeneration;
            reconnectHandle = setTimer(function () {
                reconnectHandle = null;
                if (!active || currentSocket || expectedSession !== sessionGeneration) return;
                callback({ attempt, sessionGeneration: expectedSession });
            }, delayMs);
            return attempt;
        }

        function stop() {
            const socket = currentSocket;
            active = false;
            sessionGeneration += 1;
            currentSocket = null;
            reconnectAttempts = 0;
            cancelReconnect();
            return socket;
        }

        function inspectState() {
            return {
                active,
                sessionGeneration,
                socketGeneration,
                reconnectAttempts,
                reconnectScheduled: reconnectHandle != null,
                hasSocket: currentSocket != null
            };
        }

        return Object.freeze({
            start,
            adopt,
            isCurrent,
            release,
            markHealthy,
            scheduleReconnect,
            cancelReconnect,
            stop,
            isActive: () => active,
            currentSocket: () => currentSocket,
            inspectState
        });
    }

    global.LiveSession = Object.freeze({ create });
})(window);
