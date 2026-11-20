// Composer attachments: paste & drag-and-drop for images AND files (no Attach button).
// Plain script (CSP: script-src 'self'); exposes window.chatImages. Server re-validates images.
(function () {
  'use strict';
  var MAX_IMAGES = 3;
  var MAX_FILES = 5;
  var MAX_BYTES = 4 * 1024 * 1024;
  var MAX_FILE_BYTES = 1 * 1024 * 1024;
  var MAX_EVENT_B64 = 6 * 1024 * 1024;
  var MAX_DIM = 4096;
  var IMAGE_TYPES = { 'image/png': true, 'image/jpeg': true, 'image/webp': true, 'image/gif': true };
  var IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)$/i;
  var TEXT_EXT_RE = /\.(txt|md|markdown|json|jsonl|csv|tsv|ya?ml|toml|xml|html?|css|scss|less|m?[jt]sx?|py|sh|bash|zsh|go|rs|c|h|cc|cpp|hpp|java|kt|swift|rb|php|sql|graphql|proto|dockerfile|env|ini|conf|cfg|log|diff|patch|svg)$/i;

  var deck = null;
  var statusEl = null;
  var pending = []; // {kind: 'image'|'file', file, url, name, mimeType}
  var sending = false;
  var dragDepth = 0;

  function boot() {
    deck = document.getElementById('pending-images');
    statusEl = document.getElementById('attach-status');
    if (!deck) return;
    if (deck.dataset.wired) return;
    deck.dataset.wired = '1';
    document.addEventListener('paste', onPaste);
    document.addEventListener('dragenter', onDragEnter);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('drop', onDrop);
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && pending.length && !sending) clear();
    });
  }

  function hasDraggedFiles(dt) {
    if (!dt) return false;
    if (dt.types) {
      for (var i = 0; i < dt.types.length; i++) {
        if (dt.types[i] === 'Files') return true;
      }
    }
    return Boolean(dt.files && dt.files.length);
  }

  function setDropActive(active) {
    var f = document.getElementById('f');
    if (f) f.classList.toggle('drop-active', !!active);
  }

  function onDragEnter(ev) {
    if (!hasDraggedFiles(ev.dataTransfer)) return;
    ev.preventDefault();
    dragDepth++;
    setDropActive(true);
  }

  function onDragOver(ev) {
    if (!hasDraggedFiles(ev.dataTransfer)) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
    setDropActive(true);
  }

  function onDragLeave(ev) {
    if (!hasDraggedFiles(ev.dataTransfer)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDropActive(false);
  }

  function onDrop(ev) {
    var dt = ev.dataTransfer;
    if (!dt) return;
    var files = [];
    if (dt.files && dt.files.length) {
      for (var i = 0; i < dt.files.length; i++) files.push(dt.files[i]);
    } else if (dt.items && dt.items.length) {
      for (var j = 0; j < dt.items.length; j++) {
        if (dt.items[j].kind === 'file') {
          var f = dt.items[j].getAsFile();
          if (f) files.push(f);
        }
      }
    }
    if (!files.length) return;
    ev.preventDefault();
    dragDepth = 0;
    setDropActive(false);
    addFiles(files);
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
    if (!cd) return;
    var files = [];
    if (cd.items && cd.items.length) {
      for (var i = 0; i < cd.items.length; i++) {
        var it = cd.items[i];
        if (it.kind !== 'file') continue;
        var f = it.getAsFile();
        if (f) files.push(f);
      }
    } else if (cd.files && cd.files.length) {
      for (var j = 0; j < cd.files.length; j++) files.push(cd.files[j]);
    }
    if (!files.length) return; // plain text paste untouched
    ev.preventDefault();
    addFiles(files);
    // Text that arrived alongside the attachment still lands in a focused composer.
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

  function inferImageMime(f, name) {
    if (f && IMAGE_TYPES[f.type]) return f.type;
    var m = String(name || '').toLowerCase().match(IMAGE_EXT_RE);
    if (!m) return '';
    var ext = m[1];
    return ext === 'png' ? 'image/png' : (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : '';
  }

  function isTextLikeFile(f, name) {
    var t = String((f && f.type) || '').toLowerCase();
    if (t.indexOf('text/') === 0) return true;
    if (t === 'application/json' || t === 'application/ld+json' || t === 'application/xml' ||
        t === 'application/javascript' || t === 'application/x-javascript' || t === 'application/typescript' ||
        t === 'application/x-yaml' || t === 'application/yaml' || t === 'application/toml' ||
        t === 'application/x-sh' || t === 'application/sql' || t === 'application/graphql') {
      return true;
    }
    if (!t || t === 'application/octet-stream') {
      return TEXT_EXT_RE.test(String(name || ''));
    }
    return TEXT_EXT_RE.test(String(name || ''));
  }

  function countKind(kind) {
    var n = 0;
    for (var i = 0; i < pending.length; i++) if (pending[i].kind === kind) n++;
    return n;
  }

  function addFiles(list) {
    var arr = Array.prototype.slice.call(list || []);
    var msgs = [];
    for (var i = 0; i < arr.length; i++) {
      var f = arr[i];
      if (!f) continue;
      var name = f.name || ('pasted-' + Date.now() + guessExt(f.type));
      var imgMime = inferImageMime(f, name);
      if (imgMime) {
        if (f.size > MAX_BYTES) { msgs.push('Rejected ' + name + ': too large (' + mb(f.size) + 'MB, max 4MB)'); continue; }
        if (countKind('image') >= MAX_IMAGES) { msgs.push('Rejected ' + name + ': max ' + MAX_IMAGES + ' images'); continue; }
        pending.push({ kind: 'image', file: f, url: URL.createObjectURL(f), name: name, mimeType: imgMime });
        continue;
      }
      if (isTextLikeFile(f, name)) {
        if (f.size > MAX_FILE_BYTES) { msgs.push('Rejected ' + name + ': file too large (' + mb(f.size) + 'MB, max 1MB)'); continue; }
        if (countKind('file') >= MAX_FILES) { msgs.push('Rejected ' + name + ': max ' + MAX_FILES + ' files'); continue; }
        pending.push({ kind: 'file', file: f, url: '', name: name, mimeType: f.type || 'text/plain' });
        continue;
      }
      msgs.push('Rejected ' + name + ': unsupported type (png/jpeg/webp/gif or text/code files only)');
    }
    render(msgs);
  }

  function guessExt(t) {
    return t === 'image/png' ? '.png' : t === 'image/jpeg' ? '.jpg' : t === 'image/webp' ? '.webp' : t === 'image/gif' ? '.gif' : '';
  }
  function mb(n) { return (n / 1048576).toFixed(1); }
  function kb(n) { return n < 1024 ? (n + 'B') : ((n / 1024).toFixed(1) + 'KB'); }

  function statusSummary() {
    var imgs = countKind('image');
    var files = countKind('file');
    var parts = [];
    if (imgs) parts.push(imgs + ' image' + (imgs > 1 ? 's' : ''));
    if (files) parts.push(files + ' file' + (files > 1 ? 's' : ''));
    return parts.length ? parts.join(' + ') + ' attached' : '';
  }

  function render(msgs) {
    if (!deck) return;
    deck.textContent = '';
    deck.hidden = pending.length === 0;
    pending.forEach(function (p, idx) {
      var fig = document.createElement('figure');
      if (p.kind === 'image') {
        var img = document.createElement('img');
        img.src = p.url;
        img.alt = p.name;
        fig.appendChild(img);
      } else {
        fig.className = 'file-chip';
        var badge = document.createElement('div');
        badge.className = 'file-badge';
        badge.textContent = 'FILE \u00b7 ' + kb(p.file.size || 0);
        fig.appendChild(badge);
      }
      var cap = document.createElement('figcaption');
      cap.textContent = p.name;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rm';
      btn.textContent = '\u00d7';
      btn.setAttribute('aria-label', 'Remove ' + p.name);
      btn.onclick = function () { remove(idx); };
      fig.appendChild(cap);
      fig.appendChild(btn);
      deck.appendChild(fig);
    });
    if (msgs && msgs.length) note(msgs.join(' \u00b7 '), true);
    else if (pending.length) note(statusSummary());
    else note('');
  }

  function remove(idx) {
    var p = pending[idx];
    if (!p) return;
    if (p.url) URL.revokeObjectURL(p.url);
    pending.splice(idx, 1);
    render();
  }

  function clear() {
    pending.forEach(function (p) { if (p.url) URL.revokeObjectURL(p.url); });
    pending = [];
    if (statusEl) statusEl.textContent = '';
    render();
  }

  // Snapshot for one send; deck survives until clear() on success.
  function take() {
    return pending.map(function (p) {
      return { kind: p.kind, name: p.name, mimeType: p.mimeType || p.file.type, file: p.file };
    });
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

  function readTextFile(file, name) {
    if (file && typeof file.text === 'function') {
      return file.text().then(function (t) { return { name: name, text: String(t || '') }; });
    }
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve({ name: name, text: String(fr.result || '') }); };
      fr.onerror = function () { reject(new Error('could not read ' + name)); };
      fr.readAsText(file);
    });
  }

  function toDataUrls(entries) {
    sending = true;
    var imgs = (entries || []).filter(function (e) { return !e.kind || e.kind === 'image'; });
    return Promise.all(imgs.map(function (e) {
      return normalize(e).then(function (r) {
        return toDataUrl(r.blob, e.name).then(function (dataUrl) {
          return { dataUrl: dataUrl, name: e.name, mimeType: r.mimeType };
        });
      });
    })).then(function (out) { sending = false; return out; }, function (err) { sending = false; throw err; });
  }

  function toTextBlocks(entries) {
    var files = (entries || []).filter(function (e) { return e.kind === 'file'; });
    if (!files.length) return Promise.resolve([]);
    return Promise.all(files.map(function (e) {
      return readTextFile(e.file, e.name);
    }));
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
    toTextBlocks: toTextBlocks,
    clear: clear,
    renderHistory: renderHistory,
    count: function () { return pending.length; },
    note: note,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
