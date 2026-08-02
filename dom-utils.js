(function (global) {
    "use strict";

    function clear(node) {
        if (node) node.replaceChildren();
        return node;
    }

    function text(node, value) {
        if (node) node.textContent = value == null ? "" : String(value);
        return node;
    }

    function appendText(node, value) {
        if (node) node.appendChild(document.createTextNode(value == null ? "" : String(value)));
        return node;
    }

    function element(tag, options) {
        const node = document.createElement(tag);
        const o = options || {};
        if (o.className) node.className = o.className;
        if (o.text != null) node.textContent = String(o.text);
        if (o.value != null) node.value = String(o.value);
        if (o.color) node.style.color = o.color;
        return node;
    }

    // Legacy log calls contain a few fixed <span>/<br> markers. Logs are always
    // downgraded to plain text before rendering; external messages never become HTML.
    function legacyMarkupToText(value) {
        return String(value == null ? "" : value)
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<[^>]*>/g, "");
    }

    global.SafeDOM = Object.freeze({ clear, text, appendText, element, legacyMarkupToText });
})(window);
