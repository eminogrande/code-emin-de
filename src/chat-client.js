// Chat rendering helpers: copy buttons + Mermaid diagram upgrade. Plain script, no bundler.
// Mermaid stays out of the initial page weight and only loads when a diagram appears.
(function () {
  var vendor = null;

  function loadMermaid() {
    if (globalThis.mermaid) return Promise.resolve(globalThis.mermaid);
    if (vendor) return vendor;
    vendor = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "/mermaid-vendor.js";
      s.async = true;
      s.onload = function () {
        if (!globalThis.mermaid) return reject(new Error("mermaid unavailable"));
        // strict: no raw HTML labels, no click handlers, output sanitized by mermaid
        globalThis.mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          htmlLabels: false,
          theme: "base",
          fontFamily: "inherit",
        });
        resolve(globalThis.mermaid);
      };
      s.onerror = function () { vendor = null; reject(new Error("mermaid failed to load")); };
      document.head.appendChild(s);
    });
    return vendor;
  }

  var seq = 0;

  function upgradeDiv(div) {
    var pre = div.querySelector("pre.mermaid");
    var out = div.querySelector(".mmd-out");
    var btn = div.querySelector(".mmd-toggle");
    if (!pre || !out || div.dataset.mmdState) return;
    div.dataset.mmdState = "loading";
    var source = pre.textContent;

    function showSource(on) {
      pre.hidden = !on;
      out.hidden = !on ? false : true;
      if (btn) {
        btn.textContent = on ? "diagram" : "source";
        btn.setAttribute("aria-expanded", String(on));
      }
      div.dataset.mmdView = on ? "source" : "diagram";
    }
    if (btn) {
      btn.addEventListener("click", function () {
        showSource(div.dataset.mmdView !== "source");
      });
    }

    loadMermaid()
      .then(function (m) { return m.render("mmd-" + ++seq, source); })
      .then(function (res) {
        out.innerHTML = res.svg; // mermaid strict output
        if (res.bindFunctions) res.bindFunctions(out);
        div.dataset.mmdState = "ok";
        showSource(false);
      })
      .catch(function (err) {
        div.dataset.mmdState = "error";
        div.classList.add("mmd-err");
        showSource(true);
        var msg = document.createElement("p");
        msg.className = "mmd-msg";
        msg.textContent = "Diagram error: " + ((err && err.message) || String(err));
        out.textContent = "";
        out.hidden = true;
        div.appendChild(msg);
      });
  }

  function scanCopy(root) {
    root.querySelectorAll("div.cb > button.copy:not([data-bound])").forEach(function (btn) {
      btn.dataset.bound = "1";
      btn.addEventListener("click", function () {
        var code = btn.parentElement.querySelector("code");
        var text = code ? code.textContent : "";
        var done = function () {
          var old = btn.textContent;
          btn.textContent = "Copied";
          setTimeout(function () { btn.textContent = old; }, 1200);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, function () {});
        } else {
          var ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand("copy"); done(); } catch (e) {}
          ta.remove();
        }
      });
    });
  }

  window.chatRender = function (root) {
    if (!root) return;
    scanCopy(root);
    root.querySelectorAll("div.mmd:not([data-mmd-state])").forEach(upgradeDiv);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { window.chatRender(document); });
  } else {
    window.chatRender(document);
  }
})();
