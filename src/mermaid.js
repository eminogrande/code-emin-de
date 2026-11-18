// Client hook: upgrade ```mermaid fenced blocks to diagrams. No raw HTML/script execution:
// mermaid runs with securityLevel "strict"; source <pre> is kept as view-source toggle.
(function () {
  var load = null;

  function ensure() {
    if (globalThis.mermaid) return Promise.resolve(globalThis.mermaid);
    if (!load) {
      load = new Promise(function (res, rej) {
        var s = document.createElement('script');
        s.src = '/mermaid-vendor.js';
        s.onload = function () {
          if (!globalThis.mermaid) return rej(new Error('mermaid missing'));
          globalThis.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base' });
          res(globalThis.mermaid);
        };
        s.onerror = function () { rej(new Error('mermaid load failed')); };
        document.head.appendChild(s);
      });
    }
    return load;
  }

  var seq = 0;

  function block(pre) {
    if (pre.dataset.mmdState) return;
    pre.dataset.mmdState = 'pending';
    var wrap = pre.closest('.mmd') || pre.parentElement;
    var out = wrap && wrap.querySelector('.mmd-out');
    var src = pre.dataset.src != null ? pre.dataset.src : pre.textContent;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mmd-toggle';
    btn.textContent = 'source';
    btn.setAttribute('aria-expanded', 'false');
    if (wrap) wrap.insertBefore(btn, pre);
    var shown = false;
    function showSource(on) {
      shown = on;
      pre.hidden = !on;
      btn.textContent = on ? 'diagram' : 'source';
      btn.setAttribute('aria-expanded', String(on));
    }
    btn.addEventListener('click', function () { showSource(!shown); });

    ensure()
      .then(function (m) {
        return m.render('mmd-' + ++seq, src);
      })
      .then(function (r) {
        if (!out) return;
        out.innerHTML = r.svg; // mermaid output only (sanitized, no scripts)
        out.hidden = false;
        pre.hidden = true;
        pre.dataset.mmdState = 'done';
        if (r.bindFunctions) r.bindFunctions(out);
      })
      .catch(function (err) {
        pre.dataset.mmdState = 'error';
        pre.hidden = false;
        if (wrap) wrap.classList.add('mmd-err');
        var e = document.createElement('p');
        e.className = 'mmd-msg';
        e.textContent = 'Diagram error: ' + ((err && err.message) || String(err));
        if (out) out.after(e);
      });
  }

  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    var list = root.matches && root.matches('pre.mermaid') ? [root] : [];
    root.querySelectorAll('pre.mermaid').forEach(function (p) { list.push(p); });
    list.forEach(block);
  }

  document.addEventListener('md:rendered', function (ev) { scan(ev.detail && ev.detail.root); });
  if (document.readyState !== 'loading') scan(document);
  else document.addEventListener('DOMContentLoaded', function () { scan(document); });
})();
