// Composer image attachments: paste, file picker, thumbnails, per-image remove.
// Plain script (CSP: script-src 'self'); exposes window.chatImages. Server re-validates everything.
(function () {
  'use strict';
  var MAX_IMAGES = 3;
  var MAX_BYTES = 4 * 1024 * 1024;
  var MAX_EVENT_B64 = 6 * 1024 * 1024;
  var MAX_DIM = 4096;
  var TYPES = { 'image/png': true, 'image/jpeg': true, 'image/webp': true, 'image/gif': true };

  var deck = null;
  var input = null;
  var statusEl = null;
  var pending = []; // {file, url, name}
  var sending = false;

  function boot() {
    deck = document.getElementById('pending-images');
    input = document.getElementById('attach-input');
    statusEl = document.getElementById('attach-status');
    if (!deck || !input) return;
    if (deck.dataset.wired) return;
    deck.dataset.wired = '1';
    input.addEventListener('change', function () {
      addFiles(input.files);
      input.value = '';
    });
    document.addEventListener('paste', onPaste);
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && pending.length && !sending) clear();
    });
  }

  function note(msg, bad) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('bad', !!bad);
  }

  function editableFocused() {
    var a = document.activeElement;
    return !!a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT');
  }

  function onPaste(ev) {
    var cd = ev.clipboardData;
    if (!cd || !cd.items) return;
    var files = [];
    for (var i = 0; i < cd.items.length; i++) {
      var it = cd.items[i];
      if (it.kind !== 'file') continue;
      var f = it.getAsFile();
      if (f) files.push(f); // keep wrong types so they get a visible rejection
    }
    if (!files.length) return; // plain text paste untouched
    ev.preventDefault();
    addFiles(files);
    // Text that arrived alongside the image still lands in a focused composer.
    var txt = cd.getData ? cd.getData('text/plain') : '';
    if (txt && editableFocused()) insertText(txt);
  }

  function insertText(txt) {
    var a = document.activeElement;
    var start = a.selectionStart != null ? a.selectionStart : a.value.length;
    var end = a.selectionEnd != null ? a.selectionEnd : start;
    a.value = a.value.slice(0, start) + txt + a.value.slice(end);
    try { a.selectionStart = a.selectionEnd = start + txt.length; } catch {}
    a.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function addFiles(list) {
    var arr = Array.prototype.slice.call(list || []);
    var msgs = [];
    for (var i = 0; i < arr.length; i++) {
      var f = arr[i];
      var name = f.name || ('pasted-' + Date.now() + guessExt(f.type));
      if (!TYPES[f.type]) { msgs.push('Rejected ' + name + ': unsupported type (png/jpeg/webp/gif only)'); continue; }
      if (f.size > MAX_BYTES) { msgs.push('Rejected ' + name + ': too large (' + mb(f.size) + 'MB, max 4MB)'); continue; }
      if (pending.length >= MAX_IMAGES) { msgs.push('Rejected ' + name + ': max ' + MAX_IMAGES + ' images'); break; }
      pending.push({ file: f, url: URL.createObjectURL(f), name: name });
    }
    render(msgs);
  }

  function guessExt(t) {
    return t === 'image/png' ? '.png' : t === 'image/jpeg' ? '.jpg' : t === 'image/webp' ? '.webp' : t === 'image/gif' ? '.gif' : '';
  }
  function mb(n) { return (n / 1048576).toFixed(1); }

  function render(msgs) {
    if (!deck) return;
    deck.textContent = '';
    deck.hidden = pending.length === 0;
    pending.forEach(function (p, idx) {
      var fig = document.createElement('figure');
      var img = document.createElement('img');
      img.src = p.url;
      img.alt = p.name;
      var cap = document.createElement('figcaption');
      cap.textContent = p.name;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rm';
      btn.textContent = '\u00d7';
      btn.setAttribute('aria-label', 'Remove ' + p.name);
      btn.onclick = function () { remove(idx); };
      fig.appendChild(img);
      fig.appendChild(cap);
      fig.appendChild(btn);
      deck.appendChild(fig);
    });
    if (msgs && msgs.length) note(msgs.join(' \u00b7 '), true);
    else if (pending.length) note(pending.length + ' image' + (pending.length > 1 ? 's' : '') + ' attached');
    else note('');
  }

  function remove(idx) {
    var p = pending[idx];
    if (!p) return;
    URL.revokeObjectURL(p.url);
    pending.splice(idx, 1);
    render();
  }

  function clear() {
    pending.forEach(function (p) { URL.revokeObjectURL(p.url); });
    pending = [];
    if (statusEl) statusEl.textContent = '';
    render();
  }

  // Snapshot for one send; deck survives until clear() on success.
  function take() {
    return pending.map(function (p) { return { name: p.name, mimeType: p.file.type, file: p.file }; });
  }

  // Decode real bytes in the browser: rejects corrupt files, applies EXIF rotation,
  // and re-encodes to standard PNG (JPEG fallback) so provider MIME always matches magic bytes.
  function loadBitmap(file, name) {
    return Promise.resolve(createImageBitmap(file)).then(function (b) { return b; }, function () {
      throw new Error('invalid or unsupported image format: ' + name);
    });
  }

  function toCanvas(bmp, name) {
    var w = bmp.width || bmp.naturalWidth;
    var h = bmp.height || bmp.naturalHeight;
    if (!(w > 0 && h > 0)) throw new Error('invalid or unsupported image format: ' + name);
    var scale = Math.min(1, MAX_DIM / Math.max(w, h));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(h * scale));
    var ctx = c.getContext('2d');
    if (!ctx) throw new Error('could not decode image');
    ctx.imageSmoothingQuality = 'high';
    // Flatten transparency onto white so JPEG fallback never turns black.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    return c;
  }

  function encode(canvas, mime, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error('image encode failed')); }, mime, quality);
    });
  }

  function canNormalize() {
    return typeof createImageBitmap === 'function' &&
      typeof document.createElement('canvas').toBlob === 'function';
  }

  function normalize(e) {
    // No decoder (old/jsdom): forward raw bytes, server still sniffs strictly.
    if (!canNormalize()) return Promise.resolve({ blob: e.file, mimeType: e.mimeType });
    return loadBitmap(e.file, e.name).then(function (bmp) {
      var canvas = toCanvas(bmp, e.name);
      return encode(canvas, 'image/png').then(function (blob) {
        if (blob.size <= MAX_BYTES) return { blob: blob, mimeType: 'image/png' };
        return encode(canvas, 'image/jpeg', 0.92).then(function (jpg) {
          if (jpg.size <= MAX_BYTES) return { blob: jpg, mimeType: 'image/jpeg' };
          throw new Error(e.name + ': ' + mb(blob.size) + 'MB after conversion, reduce the screenshot');
        });
      });
    });
  }

  function toDataUrl(blob, name) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        var url = String(fr.result || '');
        if (url.length > MAX_EVENT_B64) reject(new Error(name + ' too large when encoded'));
        else resolve(url);
      };
      fr.onerror = function () { reject(new Error('could not read ' + name)); };
      fr.readAsDataURL(blob);
    });
  }

  function toDataUrls(entries) {
    sending = true;
    return Promise.all(entries.map(function (e) {
      return normalize(e).then(function (r) {
        return toDataUrl(r.blob, e.name).then(function (dataUrl) {
          return { dataUrl: dataUrl, name: e.name, mimeType: r.mimeType };
        });
      });
    })).then(function (out) { sending = false; return out; }, function (err) { sending = false; throw err; });
  }

  /** Thumbnails for a replayed history entry (ids only, lazily fetched by the browser). */
  function renderHistory(container, ids) {
    if (!container || !ids || !ids.length) return;
    var box = document.createElement('div');
    box.className = 'himages';
    ids.forEach(function (id) {
      var a = document.createElement('a');
      a.href = '/api/image/' + id;
      a.target = '_blank';
      a.rel = 'noopener';
      var img = document.createElement('img');
      img.src = '/api/image/' + id;
      img.alt = 'attachment ' + id.slice(0, 8);
      img.loading = 'lazy';
      a.appendChild(img);
      box.appendChild(a);
    });
    container.appendChild(box);
  }

  window.chatImages = {
    take: take,
    toDataUrls: toDataUrls,
    clear: clear,
    renderHistory: renderHistory,
    count: function () { return pending.length; },
    note: note,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
