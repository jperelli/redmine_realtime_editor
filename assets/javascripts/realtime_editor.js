/* Collaborative editing of Redmine textareas over HTTP polling.
 *
 * Every textarea.wiki-edit that maps to a known document key gets a Yjs
 * document bound to it. Local edits become Yjs updates that are POSTed to the
 * plugin controller; the same request returns the updates of the other
 * editors, which are applied to the local document and thus to the textarea.
 * No websocket, no extra server process: the transport is the Redmine app.
 *
 * When the Monaco editor plugin replaces a textarea (it hides it and keeps its
 * value in sync with a Monaco model), the session binds to that model instead.
 */
(function () {
  'use strict';

  var Y = window.RealtimeEditorYjs;
  var config = window.RealtimeEditorConfig;
  if (!Y || !config) return;

  var t = config.i18n;

  // ---------------------------------------------------------------- helpers

  function encodeBase64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  function decodeBase64(s) {
    var bin = atob(s);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function randomId() {
    var bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  // 32 bit FNV-1a: used as the Yjs client id of the seed document so that two
  // browsers seeding the same saved text produce byte-identical updates.
  function hash32(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h || 1;
  }

  // Minimal diff between two strings: common prefix / suffix.
  function diffStrings(a, b) {
    var max = Math.min(a.length, b.length);
    var p = 0;
    while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
    var s = 0;
    while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
    return { index: p, remove: a.length - p - s, insert: b.slice(p, b.length - s) };
  }

  // Moves a caret index through a Y.Text delta (remote change).
  function transformIndex(delta, index) {
    var pos = 0;
    var out = index;
    for (var i = 0; i < delta.length; i++) {
      var op = delta[i];
      if (op.retain != null) {
        pos += op.retain;
      } else if (op.insert != null) {
        if (pos < index) out += op.insert.length;
      } else if (op.delete != null) {
        if (pos < index) out -= Math.min(op.delete, index - pos);
        pos += op.delete;
      }
      if (pos > index) break;
    }
    return out;
  }

  // Index just after the last change of a delta, in the resulting text.
  function deltaEnd(delta) {
    var pos = 0;
    var end = 0;
    for (var i = 0; i < delta.length; i++) {
      var op = delta[i];
      if (op.retain != null) {
        pos += op.retain;
      } else if (op.insert != null) {
        pos += op.insert.length;
        end = pos;
      } else if (op.delete != null) {
        end = pos;
      }
    }
    return end;
  }

  function csrfToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.content : '';
  }

  function isVisible(el) {
    return document.body.contains(el) && el.offsetParent !== null;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // ------------------------------------------------------------ remote carets

  var CARET_COLORS = ['#d7263d', '#3a5fcd', '#e07a10', '#1b998b', '#8e44ad', '#c2185b', '#5d6d00', '#0b7a75'];
  // The name label is shown while the caret moves and fades out afterwards.
  var CARET_LABEL_MS = 4000;

  function colorFor(userId) {
    return CARET_COLORS[Math.abs(userId) % CARET_COLORS.length];
  }

  function translucent(hex) {
    return 'rgba(' + parseInt(hex.slice(1, 3), 16) + ',' + parseInt(hex.slice(3, 5), 16) + ',' +
      parseInt(hex.slice(5, 7), 16) + ',0.28)';
  }

  // Typography the mirror must copy from the textarea so both wrap identically.
  var MIRROR_STYLES = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'lineHeight',
    'letterSpacing', 'wordSpacing', 'textTransform', 'textIndent', 'tabSize', 'direction',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'];

  // A transparent copy of the textarea's text laid over it (pointer-events:
  // none) in which the other editors' carets and selections are drawn. A plain
  // textarea cannot host markup, and replacing it with a code editor would
  // break Redmine's toolbar and preview.
  function CaretOverlay(textarea) {
    var self = this;
    this.textarea = textarea;
    this.layer = el('div', 'realtime-editor-carets');
    this.layer.setAttribute('aria-hidden', 'true');
    var parent = textarea.parentNode;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    textarea.insertAdjacentElement('afterend', this.layer);
    this.onScroll = function () { self.syncScroll(); };
    textarea.addEventListener('scroll', this.onScroll);
    if (window.ResizeObserver) {
      this.observer = new ResizeObserver(function () { self.fit(); });
      this.observer.observe(textarea);
    }
  }

  CaretOverlay.prototype.syncScroll = function () {
    this.layer.scrollTop = this.textarea.scrollTop;
    this.layer.scrollLeft = this.textarea.scrollLeft;
  };

  CaretOverlay.prototype.fit = function () {
    var ta = this.textarea;
    var cs = getComputedStyle(ta);
    var st = this.layer.style;
    for (var i = 0; i < MIRROR_STYLES.length; i++) st[MIRROR_STYLES[i]] = cs[MIRROR_STYLES[i]];
    st.left = (ta.offsetLeft + ta.clientLeft) + 'px';
    st.top = (ta.offsetTop + ta.clientTop) + 'px';
    st.width = ta.clientWidth + 'px';
    st.height = ta.clientHeight + 'px';
    this.syncScroll();
  };

  // carets: [{from, to, head, color, name, quiet}] with from <= to, indexes into text.
  CaretOverlay.prototype.render = function (text, carets) {
    var layer = this.layer;
    layer.textContent = '';
    if (!carets.length || !isVisible(this.textarea)) {
      layer.style.display = 'none';
      return;
    }
    layer.style.display = '';
    this.fit();

    var points = [0, text.length];
    var i;
    for (i = 0; i < carets.length; i++) points.push(carets[i].from, carets[i].to, carets[i].head);
    points = points.map(function (p) { return Math.max(0, Math.min(text.length, p)); })
      .sort(function (a, b) { return a - b; })
      .filter(function (p, idx, arr) { return idx === 0 || p !== arr[idx - 1]; });

    var markers = [];
    for (i = 0; i < points.length; i++) {
      var at = points[i];
      for (var c = 0; c < carets.length; c++) {
        if (carets[c].head === at) markers.push(this.caretMarker(carets[c]));
      }
      if (i === points.length - 1) break;
      var next = points[i + 1];
      var chunk = document.createTextNode(text.slice(at, next));
      var owner = null;
      for (c = 0; c < carets.length && !owner; c++) {
        if (carets[c].from <= at && carets[c].to >= next && carets[c].from !== carets[c].to) owner = carets[c];
      }
      if (owner) {
        var sel = el('span', 'realtime-editor-selection');
        sel.style.backgroundColor = translucent(owner.color);
        sel.appendChild(chunk);
        layer.appendChild(sel);
      } else {
        layer.appendChild(chunk);
      }
    }
    // A trailing newline would otherwise collapse.
    layer.appendChild(document.createTextNode('\u200b'));

    // Labels sit above the caret except on the first line, where they would be clipped.
    for (i = 0; i < markers.length; i++) {
      if (markers[i].offsetTop < markers[i].offsetHeight) markers[i].classList.add('realtime-editor-caret-below');
    }
    this.syncScroll();
  };

  CaretOverlay.prototype.caretMarker = function (caret) {
    var marker = el('span', 'realtime-editor-caret' + (caret.quiet ? ' realtime-editor-caret-quiet' : ''));
    marker.style.borderColor = caret.color;
    var label = el('span', 'realtime-editor-caret-name', caret.name);
    label.style.backgroundColor = caret.color;
    marker.appendChild(label);
    this.layer.appendChild(marker);
    return marker;
  };

  CaretOverlay.prototype.destroy = function () {
    this.textarea.removeEventListener('scroll', this.onScroll);
    if (this.observer) this.observer.disconnect();
    if (this.layer.parentNode) this.layer.parentNode.removeChild(this.layer);
  };

  // ----------------------------------------------------------------- editors
  //
  // The session reads and writes the text through one of these adapters:
  // {kind, root(), getValue(), setValue(v), applyDelta(delta), selection(),
  // bind(handlers), renderCarets(text, carets), disable(), destroy()}.

  function TextareaEditor(textarea, carets) {
    this.kind = 'textarea';
    this.textarea = textarea;
    this.overlay = carets ? new CaretOverlay(textarea) : null;
  }

  TextareaEditor.prototype.root = function () { return this.textarea; };

  TextareaEditor.prototype.getValue = function () { return this.textarea.value; };

  TextareaEditor.prototype.setValue = function (value) {
    if (this.textarea.value === value) return;
    var scroll = this.textarea.scrollTop;
    this.textarea.value = value;
    this.textarea.scrollTop = scroll;
  };

  TextareaEditor.prototype.applyDelta = function (delta, text) {
    var ta = this.textarea;
    var start = ta.selectionStart;
    var end = ta.selectionEnd;
    var scroll = ta.scrollTop;
    var focused = document.activeElement === ta;
    ta.value = text;
    if (focused) ta.setSelectionRange(transformIndex(delta, start), transformIndex(delta, end));
    ta.scrollTop = scroll;
  };

  TextareaEditor.prototype.selection = function () {
    var ta = this.textarea;
    var backward = ta.selectionDirection === 'backward';
    return {
      focused: document.activeElement === ta,
      head: backward ? ta.selectionStart : ta.selectionEnd,
      anchor: backward ? ta.selectionEnd : ta.selectionStart
    };
  };

  TextareaEditor.prototype.bind = function (handlers) {
    var ta = this.textarea;
    this.handlers = handlers;
    this.onInput = function () { handlers.input(null); };
    ta.addEventListener('input', this.onInput);
    ta.addEventListener('change', this.onInput);
    ta.addEventListener('keyup', handlers.select);
    ta.addEventListener('mouseup', handlers.select);
    ta.addEventListener('focus', handlers.select);
    document.addEventListener('selectionchange', handlers.select);
    ta.addEventListener('blur', handlers.blur);
  };

  TextareaEditor.prototype.renderCarets = function (text, carets) {
    if (this.overlay) this.overlay.render(text, carets);
  };

  TextareaEditor.prototype.disable = function () {
    this.textarea.disabled = true;
    this.textarea.classList.add('realtime-editor-posted');
  };

  TextareaEditor.prototype.destroy = function () {
    var ta = this.textarea;
    var h = this.handlers;
    if (h) {
      ta.removeEventListener('input', this.onInput);
      ta.removeEventListener('change', this.onInput);
      ta.removeEventListener('keyup', h.select);
      ta.removeEventListener('mouseup', h.select);
      ta.removeEventListener('focus', h.select);
      document.removeEventListener('selectionchange', h.select);
      ta.removeEventListener('blur', h.blur);
    }
    if (this.overlay) this.overlay.destroy();
  };

  // The redmine_monaco_editor plugin inserts its wrapper right before the
  // textarea, marks the textarea .monaco-replaced and hides it.
  function monacoWrapperOf(textarea) {
    if (!textarea.classList.contains('monaco-replaced')) return null;
    for (var node = textarea.previousElementSibling; node; node = node.previousElementSibling) {
      if (node.classList.contains('monaco-editor-wrapper')) return node;
    }
    return null;
  }

  function monacoEditorOf(textarea) {
    var monaco = window.monaco;
    var wrapper = monacoWrapperOf(textarea);
    if (!wrapper || !monaco || !monaco.editor || !monaco.editor.getEditors) return null;
    var editors = monaco.editor.getEditors();
    for (var i = 0; i < editors.length; i++) {
      var node = editors[i].getContainerDomNode();
      if (node && node.classList.contains('monaco-editor-container') && wrapper.contains(node) &&
          editors[i].getModel()) {
        return editors[i];
      }
    }
    return null;
  }

  var monacoStyleSeq = 0;

  // Undo/redo handlers per Monaco editor instance. Monaco's own undo stack
  // stores text offsets, which remote edits invalidate, so while a session is
  // bound the shortcuts go to the session's Y.UndoManager instead.
  var monacoUndoHooks = new WeakMap();

  function bindMonacoUndoKeys(editor) {
    if (monacoUndoHooks.has(editor)) return;
    monacoUndoHooks.set(editor, null);
    var monaco = window.monaco;
    var run = function (action) {
      return function () {
        var hooks = monacoUndoHooks.get(editor);
        if (hooks) hooks[action](); else editor.trigger('keyboard', action, null);
      };
    };
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyZ, run('undo'));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyZ, run('redo'));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY, run('redo'));
  }

  function MonacoEditor(textarea, editor, carets) {
    this.kind = 'monaco';
    this.textarea = textarea;
    this.editor = editor;
    this.monaco = window.monaco;
    this.applying = false;
    this.disposables = [];
    bindMonacoUndoKeys(editor);
    // Yjs indexes count \n line breaks, like the textarea.
    editor.getModel().setEOL(this.monaco.editor.EndOfLineSequence.LF);
    if (carets) {
      this.decorations = editor.createDecorationsCollection();
      this.prefix = 'realtime-editor-mc-' + (++monacoStyleSeq) + '-';
      this.style = document.createElement('style');
      document.head.appendChild(this.style);
    }
  }

  MonacoEditor.prototype.root = function () {
    return monacoWrapperOf(this.textarea) || this.textarea;
  };

  MonacoEditor.prototype.getValue = function () {
    return this.editor.getModel().getValue();
  };

  MonacoEditor.prototype.rangeAt = function (from, to) {
    var model = this.editor.getModel();
    return this.monaco.Range.fromPositions(model.getPositionAt(from), model.getPositionAt(to));
  };

  MonacoEditor.prototype.edit = function (edits) {
    this.applying = true;
    try {
      this.editor.getModel().applyEdits(edits);
    } finally {
      this.applying = false;
    }
  };

  MonacoEditor.prototype.setValue = function (value) {
    var current = this.getValue();
    if (current === value) return;
    var d = diffStrings(current, value);
    this.edit([{ range: this.rangeAt(d.index, d.index + d.remove), text: d.insert }]);
  };

  // Replays a Y.Text delta as model edits so Monaco keeps its own state
  // (folding, decorations, view) instead of a full setValue.
  MonacoEditor.prototype.applyDelta = function (delta) {
    var editor = this.editor;
    var sel = editor.getSelection();
    var model = editor.getModel();
    var anchor = sel ? model.getOffsetAt(sel.getSelectionStart()) : 0;
    var head = sel ? model.getOffsetAt(sel.getPosition()) : 0;
    var index = 0;
    for (var i = 0; i < delta.length; i++) {
      var op = delta[i];
      if (op.retain != null) {
        index += op.retain;
      } else if (op.insert != null) {
        this.edit([{ range: this.rangeAt(index, index), text: op.insert, forceMoveMarkers: true }]);
        index += op.insert.length;
      } else if (op.delete != null) {
        this.edit([{ range: this.rangeAt(index, index + op.delete), text: '' }]);
      }
    }
    if (sel && editor.hasTextFocus()) {
      var a = model.getPositionAt(transformIndex(delta, anchor));
      var h = model.getPositionAt(transformIndex(delta, head));
      editor.setSelection(new this.monaco.Selection(a.lineNumber, a.column, h.lineNumber, h.column));
    }
  };

  MonacoEditor.prototype.setCaret = function (index) {
    var pos = this.editor.getModel().getPositionAt(index);
    this.editor.setPosition(pos);
    this.editor.revealPositionInCenterIfOutsideViewport(pos);
  };

  MonacoEditor.prototype.bindUndo = function (hooks) {
    monacoUndoHooks.set(this.editor, hooks);
  };

  MonacoEditor.prototype.selection = function () {
    var sel = this.editor.getSelection();
    var model = this.editor.getModel();
    return {
      focused: this.editor.hasTextFocus(),
      head: sel ? model.getOffsetAt(sel.getPosition()) : 0,
      anchor: sel ? model.getOffsetAt(sel.getSelectionStart()) : 0
    };
  };

  MonacoEditor.prototype.bind = function (handlers) {
    var self = this;
    this.disposables.push(this.editor.onDidChangeModelContent(function (e) {
      if (self.applying) return;
      // A setValue (isFlush) has no usable change list: the caller diffs.
      if (e.isFlush) { handlers.input(null); return; }
      var changes = e.changes.slice().sort(function (c1, c2) { return c2.rangeOffset - c1.rangeOffset; });
      handlers.input(changes.map(function (c) {
        return { index: c.rangeOffset, remove: c.rangeLength, insert: c.text };
      }));
    }));
    this.disposables.push(this.editor.onDidChangeCursorSelection(handlers.select));
    this.disposables.push(this.editor.onDidFocusEditorText(handlers.select));
    this.disposables.push(this.editor.onDidBlurEditorText(handlers.blur));
  };

  // Remote carets and selections become Monaco decorations; colours and the
  // name labels (::after content) come from a per-editor stylesheet.
  MonacoEditor.prototype.renderCarets = function (text, carets) {
    if (!this.decorations) return;
    var model = this.editor.getModel();
    var decorations = [];
    var css = '';
    var length = model.getValueLength();
    for (var i = 0; i < carets.length; i++) {
      var c = carets[i];
      var id = this.prefix + i;
      var from = Math.min(c.from, length);
      var to = Math.min(c.to, length);
      var head = model.getPositionAt(Math.min(c.head, length));
      if (from !== to) {
        decorations.push({
          range: this.rangeAt(from, to),
          options: { className: 'realtime-editor-mc-selection ' + id + '-sel' }
        });
        css += '.' + id + '-sel{background-color:' + translucent(c.color) + '}';
      }
      var classes = 'realtime-editor-mc-caret ' + id + '-head';
      if (c.quiet) classes += ' realtime-editor-mc-quiet';
      if (head.lineNumber === 1) classes += ' realtime-editor-mc-caret-below';
      decorations.push({
        range: this.monaco.Range.fromPositions(head, head),
        options: { beforeContentClassName: classes, stickiness: 1 }
      });
      css += '.' + id + '-head{border-color:' + c.color + '}' +
        '.' + id + '-head::after{content:' + JSON.stringify(c.name) + ';background-color:' + c.color + '}';
    }
    this.style.textContent = css;
    this.decorations.set(decorations);
  };

  MonacoEditor.prototype.disable = function () {
    this.textarea.disabled = true;
    this.editor.updateOptions({ readOnly: true });
    this.root().classList.add('realtime-editor-posted');
  };

  MonacoEditor.prototype.destroy = function () {
    for (var i = 0; i < this.disposables.length; i++) this.disposables[i].dispose();
    this.disposables = [];
    if (monacoUndoHooks.get(this.editor)) monacoUndoHooks.set(this.editor, null);
    if (this.decorations) this.decorations.clear();
    if (this.style && this.style.parentNode) this.style.parentNode.removeChild(this.style);
  };

  function editorKindOf(textarea) {
    return monacoEditorOf(textarea) ? 'monaco' : 'textarea';
  }

  function makeEditor(textarea, carets) {
    var monaco = monacoEditorOf(textarea);
    return monaco ? new MonacoEditor(textarea, monaco, carets) : new TextareaEditor(textarea, carets);
  }

  // The element whose visibility decides whether the textarea is being edited.
  function editorRootOf(textarea) {
    return monacoWrapperOf(textarea) || textarea;
  }

  // ------------------------------------------------------------ document keys

  function formOf(textarea) {
    return textarea.form || textarea.closest('form');
  }

  // Returns {key, kind, versionField, presenceOnly} for a textarea we know how
  // to share, or null. presenceOnly: the text stays private, only who is
  // writing is shared (issue notes in private mode).
  function describe(textarea) {
    var form = formOf(textarea);
    var action = form ? form.getAttribute('action') || '' : '';
    var m;
    if (textarea.id === 'issue_description' || textarea.id === 'issue_notes') {
      m = action.match(/\/issues\/(\d+)(?:[/?#]|$)/);
      if (!m) return null;
      var kind = textarea.id === 'issue_description' ? 'issue_description' : 'issue_notes';
      if (config.targets.indexOf(kind) < 0) return null;
      return {
        key: 'issue:' + m[1] + ':' + (kind === 'issue_notes' ? 'notes' : 'description'),
        kind: kind,
        versionField: form.querySelector('input[name="issue[lock_version]"]'),
        presenceOnly: kind === 'issue_notes' && config.notesMode !== 'shared'
      };
    }
    m = textarea.id.match(/^journal_(\d+)_notes$/);
    if (m) {
      if (config.targets.indexOf('journal_notes') < 0) return null;
      return { key: 'journal:' + m[1] + ':notes', kind: 'journal_notes', versionField: null };
    }
    if (textarea.id === 'content_text' && form && form.id === 'wiki_form') {
      if (config.targets.indexOf('wiki') < 0) return null;
      m = action.match(/\/projects\/([^/]+)\/wiki\/([^/?#]+)/);
      if (!m) return null;
      var section = form.querySelector('input[name="section"]');
      var key = 'wiki:' + decodeURIComponent(m[1]) + ':' + decodeURIComponent(m[2]);
      if (section && section.value) key += '/' + section.value;
      return {
        key: key,
        kind: 'wiki',
        versionField: section ? null : form.querySelector('input[name="content[version]"]')
      };
    }
    return null;
  }

  // ------------------------------------------------------------------ session

  var TYPING_MS = 2500;
  var SEND_DEBOUNCE_MS = 150;
  var CURSOR_DEBOUNCE_MS = 300;
  // Keep showing our caret to others this long after the textarea loses focus
  // (toolbar buttons, preview tab) before it disappears.
  var CURSOR_LINGER_MS = 15000;

  // Notes documents are reset when somebody posts the comment; the other
  // editors are then told so and locked out until they reload.
  var RESET_ON_SAVE = ['issue_notes', 'journal_notes'];

  function Session(textarea, info) {
    this.textarea = textarea;
    this.key = info.key;
    this.kind = info.kind;
    this.presenceOnly = !!info.presenceOnly;
    this.versionField = info.versionField;
    this.clientId = randomId();
    this.epoch = null;
    this.since = 0;
    this.savedText = null;
    this.pending = [];
    this.seedUpdate = null;
    this.compactRequested = false;
    this.others = [];
    this.remoteCarets = [];
    this.lastInputAt = 0;
    this.blurredAt = 0;
    this.lastCursorSent = null;
    this.errors = 0;
    this.timer = null;
    this.inflight = null;
    this.stopped = false;
    this.doc = null;
    this.ytext = null;
    this.undoManager = null;

    this.editor = makeEditor(textarea, !this.presenceOnly);
    this.editorKind = this.editor.kind;
    this.buildStatusBar();
    if (!this.presenceOnly) this.markForm();

    var self = this;
    this.editor.bind({
      input: function (changes) {
        self.lastInputAt = Date.now();
        if (changes) self.applyLocalChanges(changes);
        self.pushLocalChanges();
        self.renderCarets();
        self.schedule(SEND_DEBOUNCE_MS);
      },
      select: function () {
        if (self.others.length && self.localCursor() !== self.lastCursorSent) self.schedule(CURSOR_DEBOUNCE_MS);
      },
      blur: function () { self.blurredAt = Date.now(); }
    });
    this.onVisibility = function () { if (document.visibilityState === 'visible') self.schedule(0); };
    document.addEventListener('visibilitychange', this.onVisibility);
    this.onPageHide = function () { self.flush(); self.leave(); };
    window.addEventListener('pagehide', this.onPageHide);
    this.onSubmit = function () { self.syncBeforeSubmit(); };
    var form = formOf(textarea);
    if (form) form.addEventListener('submit', this.onSubmit);

    this.setStatus('connecting');
    this.schedule(0);
  }

  Session.prototype.buildStatusBar = function () {
    var self = this;
    this.bar = el('div', 'realtime-editor-status realtime-editor-connecting');
    this.dot = el('span', 'realtime-editor-dot');
    this.statusText = el('span', 'realtime-editor-state', t.connecting);
    this.peers = el('span', 'realtime-editor-peers');
    this.notice = el('span', 'realtime-editor-notice');
    this.bar.appendChild(this.dot);
    this.bar.appendChild(this.statusText);
    this.bar.appendChild(this.peers);
    this.bar.appendChild(this.notice);
    this.bar.addEventListener('click', function (e) {
      if (e.target.classList.contains('realtime-editor-dismiss')) {
        self.notice.textContent = '';
        e.preventDefault();
      }
    });
    this.textarea.insertAdjacentElement('afterend', this.bar);
  };

  // Tells the server which live documents the form is saving so it can reset
  // the notes draft / record the new version for the other editors.
  Session.prototype.markForm = function () {
    var form = formOf(this.textarea);
    if (!form) return;
    this.marker = document.createElement('input');
    this.marker.type = 'hidden';
    this.marker.name = 'realtime_editor_docs[]';
    this.marker.value = this.key;
    form.appendChild(this.marker);
  };

  Session.prototype.setStatus = function (state) {
    this.bar.className = 'realtime-editor-status realtime-editor-' + state;
    this.statusText.textContent = state === 'live' && this.presenceOnly ? t.private_notes : t[state] || state;
  };

  Session.prototype.showNotice = function (text) {
    this.notice.textContent = '';
    this.notice.appendChild(document.createTextNode(text + ' '));
    var dismiss = el('a', 'realtime-editor-dismiss', '\u2715');
    dismiss.href = '#';
    this.notice.appendChild(dismiss);
  };

  // --- Yjs <-> textarea

  Session.prototype.rebuildDoc = function (savedText, updates, keepLocalText) {
    var self = this;
    var local = this.editor.getValue();
    if (this.doc) this.doc.destroy();
    this.pending = [];
    this.seedUpdate = null;
    // Textareas normalise line endings to \n; Redmine stores what the browser
    // submitted (\r\n), so compare like with like.
    this.savedText = savedText == null ? '' : savedText.replace(/\r\n?/g, '\n');
    this.doc = new Y.Doc();
    this.ytext = this.doc.getText('text');
    this.undoManager = this.editor.bindUndo ? this.buildUndoManager() : null;

    this.doc.on('update', function (update, origin) {
      if (self.isLocalOrigin(origin)) self.pending.push(update);
    });
    this.ytext.observe(function (event, txn) {
      if (txn.origin === 'local') return;
      self.applyRemoteDelta(event.delta);
      if (self.undoManager && txn.origin === self.undoManager) self.editor.setCaret(deltaEnd(event.delta));
    });

    this.applyRemoteUpdates(updates);

    if (updates.length === 0) {
      // Empty log: seed it with the saved text. Deterministic client id and a
      // single insert make concurrent seeds by other browsers identical.
      var seedDoc = new Y.Doc();
      seedDoc.clientID = hash32(this.savedText);
      if (this.savedText.length) seedDoc.getText('text').insert(0, this.savedText);
      this.seedUpdate = Y.encodeStateAsUpdate(seedDoc);
      seedDoc.destroy();
      Y.applyUpdate(this.doc, this.seedUpdate, 'seed');
    }

    var draft = this.ytext.toString();
    if (keepLocalText && local !== this.savedText && draft === this.savedText) {
      // Typed before we connected: keep it.
      this.editor.setValue(local);
      this.pushLocalChanges();
    } else {
      this.editor.setValue(draft);
      if (draft !== this.savedText) this.showNotice(t.draft_loaded);
    }
    if (this.undoManager) this.undoManager.clear();
  };

  // Undo/redo of our own edits only, as CRDT operations: a peer's edits are
  // never reverted and stay where they are, whatever the editor's own stack
  // would have done with its stale offsets.
  Session.prototype.buildUndoManager = function () {
    var manager = new Y.UndoManager(this.ytext, { trackedOrigins: new Set(['local']), captureTimeout: 500 });
    this.editor.bindUndo({
      undo: function () { manager.undo(); },
      redo: function () { manager.redo(); }
    });
    return manager;
  };

  Session.prototype.isLocalOrigin = function (origin) {
    return origin === 'local' || (this.undoManager !== null && origin === this.undoManager);
  };

  Session.prototype.applyRemoteUpdates = function (updates) {
    for (var i = 0; i < updates.length; i++) {
      try {
        Y.applyUpdate(this.doc, decodeBase64(updates[i].data), 'remote');
      } catch (e) {
        // A corrupt update must not take the editor down for everybody.
        if (window.console) console.warn('realtime_editor: skipping bad update', updates[i].seq, e);
      }
    }
  };

  Session.prototype.applyRemoteDelta = function (delta) {
    this.editor.applyDelta(delta, this.ytext.toString());
    this.renderCarets();
  };

  // --- carets

  // Our caret/selection as JSON of Yjs relative positions ({h: head, a: anchor}),
  // or null when it should not be shown to the others.
  Session.prototype.localCursor = function () {
    if (!this.ytext) return null;
    var sel = this.editor.selection();
    if (!sel.focused && Date.now() - this.blurredAt > CURSOR_LINGER_MS) return null;
    var cursor = { h: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(this.ytext, sel.head)) };
    if (sel.anchor !== sel.head) {
      cursor.a = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(this.ytext, sel.anchor));
    }
    return JSON.stringify(cursor);
  };

  Session.prototype.rememberRemoteCarets = function () {
    var carets = [];
    var previous = {};
    var now = Date.now();
    var i;
    for (i = 0; i < this.remoteCarets.length; i++) previous[this.remoteCarets[i].clientId] = this.remoteCarets[i];
    for (i = 0; i < this.others.length; i++) {
      var p = this.others[i];
      if (!p.cursor) continue;
      try {
        var cursor = JSON.parse(p.cursor);
        var old = previous[p.client_id];
        carets.push({
          clientId: p.client_id,
          raw: p.cursor,
          movedAt: old && old.raw === p.cursor ? old.movedAt : now,
          name: p.name,
          color: colorFor(p.user_id),
          head: Y.createRelativePositionFromJSON(cursor.h),
          anchor: cursor.a ? Y.createRelativePositionFromJSON(cursor.a) : null
        });
      } catch (e) {
        // Malformed cursor from another client: just don't draw it.
      }
    }
    this.remoteCarets = carets;
    this.renderCarets();
  };

  // Resolves the remote carets against the current text and draws them.
  Session.prototype.renderCarets = function () {
    var self = this;
    if (!this.doc || this.presenceOnly) return;
    var carets = [];
    var now = Date.now();
    var nextFade = Infinity;
    for (var i = 0; i < this.remoteCarets.length; i++) {
      var c = this.remoteCarets[i];
      var head = Y.createAbsolutePositionFromRelativePosition(c.head, this.doc);
      if (!head || head.type !== this.ytext) continue;
      var anchor = c.anchor ? Y.createAbsolutePositionFromRelativePosition(c.anchor, this.doc) : null;
      var other = anchor && anchor.type === this.ytext ? anchor.index : head.index;
      var fadeAt = c.movedAt + CARET_LABEL_MS;
      if (fadeAt > now) nextFade = Math.min(nextFade, fadeAt);
      carets.push({
        name: c.name,
        color: c.color,
        quiet: fadeAt <= now,
        head: head.index,
        from: Math.min(head.index, other),
        to: Math.max(head.index, other)
      });
    }
    this.editor.renderCarets(this.editor.getValue(), carets);
    clearTimeout(this.caretTimer);
    if (nextFade < Infinity) {
      this.caretTimer = setTimeout(function () { self.renderCarets(); }, nextFade - now + 50);
    }
  };

  // Exact local edits reported by the editor: [{index, remove, insert}] in
  // descending index order, relative to the text before the edit.
  Session.prototype.applyLocalChanges = function (changes) {
    if (!this.doc) return;
    var ytext = this.ytext;
    this.doc.transact(function () {
      for (var i = 0; i < changes.length; i++) {
        var c = changes[i];
        if (c.remove) ytext.delete(c.index, c.remove);
        if (c.insert) ytext.insert(c.index, c.insert);
      }
    }, 'local');
  };

  // Pushes whatever differs between the editor and the shared text as a local
  // edit. Also catches changes made without an input event (toolbar buttons).
  Session.prototype.pushLocalChanges = function () {
    if (!this.doc) return;
    var current = this.ytext.toString();
    var value = this.editor.getValue();
    if (current === value) return;
    var d = diffStrings(current, value);
    var ytext = this.ytext;
    this.doc.transact(function () {
      if (d.remove) ytext.delete(d.index, d.remove);
      if (d.insert) ytext.insert(d.index, d.insert);
    }, 'local');
  };

  // --- transport

  Session.prototype.schedule = function (ms) {
    var self = this;
    if (this.stopped) return;
    if (this.inflight) {
      // A long poll is waiting on the server; interrupt it to send right away.
      if (this.inflight.waiting && ms <= CURSOR_DEBOUNCE_MS) this.inflight.abort();
      return;
    }
    // Only ever bring the next poll forward, so a stream of events cannot
    // postpone it forever.
    var due = Date.now() + ms;
    if (this.timer && this.timerDue <= due) return;
    clearTimeout(this.timer);
    this.timerDue = due;
    this.timer = setTimeout(function () { self.timer = null; self.sync(); }, ms);
  };

  Session.prototype.nextDelay = function () {
    if (this.errors) return Math.min(30000, 2000 * Math.pow(2, this.errors - 1));
    if (document.visibilityState === 'hidden') return config.pollHiddenMs;
    if (this.others.length) return config.pollActiveMs;
    return config.pollIdleMs;
  };

  Session.prototype.sync = function () {
    var self = this;
    if (this.stopped || this.inflight) return;
    this.pushLocalChanges();

    var body = new URLSearchParams();
    body.set('key', this.key);
    body.set('client_id', this.clientId);
    body.set('since', String(this.since));
    body.set('presence', '1');
    body.set('typing', Date.now() - this.lastInputAt < TYPING_MS ? '1' : '0');
    var cursor = this.localCursor();
    if (cursor) body.set('cursor', cursor);
    this.lastCursorSent = cursor;
    if (this.epoch !== null) body.set('epoch', String(this.epoch));

    var sent = this.pending;
    this.pending = [];
    if (sent.length) body.set('update', encodeBase64(Y.mergeUpdates(sent)));
    var seed = this.seedUpdate;
    if (seed) body.set('seed', encodeBase64(seed));
    if (this.compactRequested && this.since > 0) {
      body.set('snapshot', encodeBase64(Y.encodeStateAsUpdate(this.doc)));
      body.set('snapshot_upto', String(this.since));
      this.compactRequested = false;
    }
    var waiting = config.longPoll && this.epoch !== null && document.visibilityState === 'visible' &&
      !sent.length && !seed;
    if (waiting) body.set('wait', '1');

    var controller = new AbortController();
    controller.waiting = waiting;
    this.inflight = controller;

    fetch(config.syncUrl, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': csrfToken(), 'Accept': 'application/json' },
      body: body,
      signal: controller.signal
    }).then(function (res) {
      if (res.status === 403) { self.stop('forbidden'); throw new Error('forbidden'); }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (json) {
      self.inflight = null;
      self.errors = 0;
      if (seed && self.seedUpdate === seed) self.seedUpdate = null;
      self.handle(json);
      self.setStatus('live');
      self.schedule(waiting ? 0 : self.nextDelay());
    }).catch(function (err) {
      self.inflight = null;
      if (self.stopped) return;
      // Put unsent updates back in front of anything typed meanwhile.
      if (sent.length) self.pending = sent.concat(self.pending);
      if (err.name === 'AbortError') { self.schedule(0); return; }
      self.errors++;
      self.setStatus('offline');
      self.schedule(self.nextDelay());
    });
  };

  Session.prototype.handle = function (json) {
    var wasJoined = this.epoch !== null;
    if (wasJoined && json.epoch_changed && json.reset_by && !this.presenceOnly &&
        RESET_ON_SAVE.indexOf(this.kind) >= 0) {
      this.posted(json.reset_by);
      return;
    }
    if (!wasJoined || json.epoch_changed) {
      this.epoch = json.epoch;
      this.since = json.last_seq || 0;
      if (!this.presenceOnly) {
        // After a reset (somebody saved) the local text is stale by definition.
        this.rebuildDoc(json.saved_text, json.updates || [], !wasJoined);
        if (wasJoined) this.showNotice(t.reset);
      }
    } else if (!this.presenceOnly) {
      this.applyRemoteUpdates(json.updates || []);
      if (json.last_seq > this.since) this.since = json.last_seq;
    }
    if (json.compact_suggested && Math.random() < 0.5) this.compactRequested = true;
    this.others = (json.presences || []).filter(function (p) { return p.user_id !== config.userId; });
    this.renderPeers();
    this.rememberRemoteCarets();
    if (!this.presenceOnly) this.bumpVersion(json.synced_from_version, json.synced_version);
  };

  // The text everybody was writing has just been posted as a comment by +name+.
  // Submitting it again would duplicate it, so the field is locked with a
  // banner until the page is reloaded (which also shows the new comment).
  Session.prototype.posted = function (name) {
    this.stop('posted');
    this.editor.disable();
    var banner = el('div', 'realtime-editor-banner');
    banner.setAttribute('role', 'alert');
    banner.appendChild(el('strong', null, t.posted_by.replace('%{name}', name)));
    banner.appendChild(document.createTextNode(' '));
    var reload = el('a', 'realtime-editor-reload', t.reload);
    reload.href = window.location.href;
    reload.addEventListener('click', function (e) {
      e.preventDefault();
      window.location.reload();
    });
    banner.appendChild(reload);
    this.editor.root().insertAdjacentElement('beforebegin', banner);
  };

  // Lets this form save on top of a version another collaborator produced:
  // everyone already has the merged text, so it is not a conflict. Only for a
  // form rendered at the version that save started from; anything older may
  // carry stale values of other fields and must go through Redmine's conflict
  // page.
  Session.prototype.bumpVersion = function (from, to) {
    if (to == null || !this.versionField) return;
    var current = parseInt(this.versionField.value, 10);
    if (from != null && current !== from) return;
    if (current < to) this.versionField.value = String(to);
  };

  Session.prototype.renderPeers = function () {
    this.peers.textContent = '';
    var byUser = {};
    var order = [];
    for (var i = 0; i < this.others.length; i++) {
      var p = this.others[i];
      if (!byUser[p.user_id]) { byUser[p.user_id] = { name: p.name, typing: false }; order.push(p.user_id); }
      if (p.typing) byUser[p.user_id].typing = true;
    }
    if (!order.length) {
      this.peers.appendChild(el('span', 'realtime-editor-alone', t.alone));
      return;
    }
    this.peers.appendChild(el('span', 'realtime-editor-label', t.with_others + ' '));
    for (var j = 0; j < order.length; j++) {
      var u = byUser[order[j]];
      var chip = el('span', 'realtime-editor-peer' + (u.typing ? ' realtime-editor-typing' : ''), u.name);
      if (u.typing) chip.title = t.typing;
      this.peers.appendChild(chip);
    }
  };

  // --- teardown

  // Runs inside the form's submit handler: the save request must carry the
  // version other collaborators just produced and our last keystrokes must
  // reach them. Blocking is the only way to finish before the browser
  // navigates; it is one small POST to the server the form is going to anyway.
  Session.prototype.syncBeforeSubmit = function () {
    this.pushLocalChanges();
    if (this.epoch === null || this.presenceOnly) return;
    if (this.inflight) this.inflight.abort();
    var body = new URLSearchParams();
    body.set('key', this.key);
    body.set('client_id', this.clientId);
    body.set('epoch', String(this.epoch));
    body.set('since', String(this.since));
    if (this.pending.length) body.set('update', encodeBase64(Y.mergeUpdates(this.pending)));
    this.pending = [];
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', config.syncUrl, false);
      xhr.setRequestHeader('X-CSRF-Token', csrfToken());
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
      xhr.send(body.toString());
      if (xhr.status === 200) this.handle(JSON.parse(xhr.responseText));
    } catch (e) {
      // Saving must never be blocked by the collaboration layer.
    }
  };

  // Fire-and-forget delivery of unsent updates when the page or form goes away.
  Session.prototype.flush = function () {
    if (this.epoch === null || !this.pending.length) return;
    var body = new URLSearchParams();
    body.set('key', this.key);
    body.set('client_id', this.clientId);
    body.set('epoch', String(this.epoch));
    body.set('since', String(this.since));
    body.set('update', encodeBase64(Y.mergeUpdates(this.pending)));
    this.pending = [];
    fetch(config.syncUrl, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': csrfToken(), 'Accept': 'application/json' },
      body: body,
      keepalive: true
    }).catch(function () {});
  };

  Session.prototype.leave = function () {
    if (this.epoch === null) return;
    var body = new FormData();
    body.append('key', this.key);
    body.append('client_id', this.clientId);
    body.append('authenticity_token', csrfToken());
    if (navigator.sendBeacon) {
      navigator.sendBeacon(config.leaveUrl, body);
    } else {
      fetch(config.leaveUrl, { method: 'POST', credentials: 'same-origin', body: body, keepalive: true });
    }
  };

  Session.prototype.stop = function (reason) {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.caretTimer);
    if (this.inflight) this.inflight.abort();
    if (reason !== 'forbidden') { this.flush(); this.leave(); }
    this.editor.destroy();
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('pagehide', this.onPageHide);
    var form = formOf(this.textarea);
    if (form) form.removeEventListener('submit', this.onSubmit);
    if (this.bar.parentNode) this.bar.parentNode.removeChild(this.bar);
    if (this.marker && this.marker.parentNode) this.marker.parentNode.removeChild(this.marker);
    if (this.undoManager) this.undoManager.destroy();
    this.undoManager = null;
    if (this.doc) this.doc.destroy();
    this.doc = null;
  };

  // ------------------------------------------------------- issue attributes
  //
  // Every other field of the issue edit form (status, assignee, dates, custom
  // fields...) is shared through one Y.Map per form: field name => {v, u, n}
  // (value, user id, user name), last write wins per field. Values are read
  // from and written into the native controls, so Redmine's own handlers keep
  // working: a remote status change refreshes the form through
  // updateIssueFrom exactly like a local one.

  var FIELD_DEBOUNCE_MS = 150;
  var CHANGED_MS = 8000;
  var REBIND_DEBOUNCE_MS = 50;
  // Text fields have their own documents; notes privacy and attachment
  // removal belong to the person submitting.
  var UNSHARED_FIELDS = ['issue[description]', 'issue[notes]', 'issue[private_notes]', 'issue[lock_version]',
    'issue[deleted_attachment_ids][]'];
  var UNSHARED_TYPES = ['hidden', 'file', 'submit', 'button', 'reset', 'image'];

  function describeForm(form) {
    if (config.targets.indexOf('issue_attributes') < 0 || !form.querySelector('#all_attributes')) return null;
    var m = (form.getAttribute('action') || '').match(/\/issues\/(\d+)(?:[/?#]|$)/);
    if (!m) return null;
    return {
      key: 'issue:' + m[1] + ':attributes',
      versionField: form.querySelector('input[name="issue[lock_version]"]')
    };
  }

  function sharedField(control) {
    var name = control.name;
    if (!name || name.indexOf('issue[') !== 0 || UNSHARED_FIELDS.indexOf(name) >= 0) return false;
    return control.tagName !== 'INPUT' || UNSHARED_TYPES.indexOf(control.type) < 0;
  }

  function isArrayField(controls) {
    var first = controls[0];
    if (first.tagName === 'SELECT') return first.multiple;
    return first.type === 'checkbox' && /\[\]$/.test(first.name);
  }

  // The value the form would submit for the field: a string, or an array for
  // multi-selects and checkbox groups.
  function readField(controls) {
    var first = controls[0];
    if (first.tagName === 'SELECT') {
      if (!first.multiple) return first.value;
      return Array.prototype.map.call(first.selectedOptions, function (o) { return o.value; });
    }
    if (first.type === 'checkbox' || first.type === 'radio') {
      var checked = [];
      for (var i = 0; i < controls.length; i++) if (controls[i].checked) checked.push(controls[i].value);
      if (isArrayField(controls)) return checked;
      return checked.length ? checked[0] : '';
    }
    return first.value;
  }

  // Puts +value+ into the controls; true when anything changed. Choices this
  // form does not offer (an assignee the user may not pick) are left alone.
  function writeField(controls, value) {
    var first = controls[0];
    var list = Array.isArray(value) ? value : [value];
    var changed = false;
    var i;
    if (first.tagName === 'SELECT') {
      if (!first.multiple) {
        if (first.value === value) return false;
        for (i = 0; i < first.options.length; i++) {
          if (first.options[i].value === value) { first.value = value; return true; }
        }
        return false;
      }
      for (i = 0; i < first.options.length; i++) {
        var want = list.indexOf(first.options[i].value) >= 0;
        if (first.options[i].selected !== want) { first.options[i].selected = want; changed = true; }
      }
      return changed;
    }
    if (first.type === 'checkbox' || first.type === 'radio') {
      for (i = 0; i < controls.length; i++) {
        var on = list.indexOf(controls[i].value) >= 0;
        if (controls[i].checked !== on) { controls[i].checked = on; changed = true; }
      }
      return changed;
    }
    if (typeof value !== 'string' || first.value === value) return false;
    first.value = value;
    return true;
  }

  function sameValue(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function FieldsSession(form, info) {
    this.form = form;
    this.key = info.key;
    this.versionField = info.versionField;
    this.clientId = randomId();
    this.epoch = null;
    this.since = 0;
    this.pending = [];
    this.compactRequested = false;
    this.others = [];
    this.errors = 0;
    this.timer = null;
    this.inflight = null;
    this.stopped = false;
    this.doc = null;
    this.map = null;
    this.dirty = {};
    this.touched = {};
    this.changed = {};
    this.applying = false;

    this.markForm();

    var self = this;
    this.onChange = function (e) {
      var control = e.target;
      self.descriptionOpen = descriptionToolbarOpen(self.form);
      if (self.applying || !control || !sharedField(control)) return;
      self.dirty[control.name] = true;
      if (self.changed[control.name]) { delete self.changed[control.name]; self.renderChanged(control.name); }
      self.schedule(FIELD_DEBOUNCE_MS);
    };
    form.addEventListener('change', this.onChange);
    form.addEventListener('input', this.onChange);
    // Redmine replaces the content of #all_attributes when status, tracker or
    // project change.
    this.observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        if (mutations[i].target.id !== 'all_attributes') continue;
        clearTimeout(self.rebindTimer);
        self.rebindTimer = setTimeout(function () { self.rebind(); }, REBIND_DEBOUNCE_MS);
        return;
      }
    });
    this.observer.observe(form, { childList: true, subtree: true });
    this.onVisibility = function () { if (document.visibilityState === 'visible') self.schedule(0); };
    document.addEventListener('visibilitychange', this.onVisibility);
    this.onPageHide = function () { self.flush(); self.leave(); };
    window.addEventListener('pagehide', this.onPageHide);
    this.onSubmit = function () { self.syncBeforeSubmit(); };
    form.addEventListener('submit', this.onSubmit);

    this.schedule(0);
  }

  FieldsSession.prototype.schedule = Session.prototype.schedule;
  FieldsSession.prototype.nextDelay = Session.prototype.nextDelay;
  FieldsSession.prototype.applyRemoteUpdates = Session.prototype.applyRemoteUpdates;
  FieldsSession.prototype.bumpVersion = Session.prototype.bumpVersion;
  FieldsSession.prototype.syncBeforeSubmit = Session.prototype.syncBeforeSubmit;
  FieldsSession.prototype.flush = Session.prototype.flush;
  FieldsSession.prototype.leave = Session.prototype.leave;

  FieldsSession.prototype.markForm = function () {
    this.marker = document.createElement('input');
    this.marker.type = 'hidden';
    this.marker.name = 'realtime_editor_docs[]';
    this.marker.value = this.key;
    this.form.appendChild(this.marker);
  };

  FieldsSession.prototype.controls = function (name) {
    var found = this.form.querySelectorAll('[name="' + name.replace(/"/g, '\\"') + '"]');
    var list = [];
    for (var i = 0; i < found.length; i++) if (sharedField(found[i])) list.push(found[i]);
    return list;
  };

  // --- Yjs <-> form

  FieldsSession.prototype.rebuildDoc = function (updates) {
    var self = this;
    if (this.doc) this.doc.destroy();
    this.pending = [];
    this.doc = new Y.Doc();
    this.map = this.doc.getMap('fields');
    this.doc.on('update', function (update, origin) {
      if (origin === 'local') self.pending.push(update);
    });
    this.map.observe(function (event, txn) {
      if (txn.origin === 'local') return;
      event.keysChanged.forEach(function (name) { self.applyEntry(name, true); });
    });
    this.applyRemoteUpdates(updates);
  };

  FieldsSession.prototype.applyEntry = function (name, highlight) {
    var entry = this.map.get(name);
    var controls = this.controls(name);
    if (!entry || !controls.length) return;
    this.applying = true;
    try {
      if (writeField(controls, entry.v)) {
        if (highlight) this.markChanged(name, entry);
        controls[0].dispatchEvent(new Event('change', { bubbles: true }));
      }
    } finally {
      this.applying = false;
    }
  };

  FieldsSession.prototype.pushLocalChanges = function () {
    if (!this.doc) return;
    var names = Object.keys(this.dirty);
    this.dirty = {};
    var sets = [];
    for (var i = 0; i < names.length; i++) {
      var controls = this.controls(names[i]);
      if (!controls.length) continue;
      var value = readField(controls);
      var current = this.map.get(names[i]);
      if (!current || !sameValue(current.v, value)) sets.push([names[i], value]);
    }
    if (!sets.length) return;
    var self = this;
    this.doc.transact(function () {
      for (var j = 0; j < sets.length; j++) {
        self.map.set(sets[j][0], { v: sets[j][1], u: config.userId, n: config.userName });
        self.touched[sets[j][0]] = true;
      }
    }, 'local');
  };

  // A new epoch (somebody saved) starts from an empty map; the fields this
  // form changed are still what it will submit, so they are announced again.
  FieldsSession.prototype.repushTouched = function () {
    var names = Object.keys(this.touched);
    for (var i = 0; i < names.length; i++) this.dirty[names[i]] = true;
    this.pushLocalChanges();
  };

  // After Redmine re-rendered the form: the new controls carry the values the
  // form was serialized with, which may predate an entry applied meanwhile.
  FieldsSession.prototype.rebind = function () {
    if (this.stopped || !this.map) return;
    var self = this;
    this.map.forEach(function (entry, name) { self.applyEntry(name, false); });
    Object.keys(this.changed).forEach(function (name) { self.renderChanged(name); });
    if (!this.marker.parentNode) this.form.appendChild(this.marker);
    // The re-rendered form hides the description behind its "Edit" link again.
    if (this.descriptionOpen) openDescriptionToolbar(this.form);
  };

  function descriptionToolbarOpen(form) {
    var wrap = form.querySelector('#issue_description_and_toolbar');
    return !!wrap && isVisible(wrap);
  }

  function openDescriptionToolbar(form) {
    var wrap = form.querySelector('#issue_description_and_toolbar');
    if (!wrap || isVisible(wrap)) return;
    wrap.style.display = '';
    var link = wrap.parentNode.querySelector('a.icon-edit, a[onclick*="issue_description_and_toolbar"]');
    if (link) link.style.display = 'none';
  }

  // --- "changed by" highlight

  FieldsSession.prototype.markChanged = function (name, entry) {
    var self = this;
    this.changed[name] = { by: entry.n, userId: entry.u, at: Date.now() };
    this.renderChanged(name);
    setTimeout(function () { self.renderChanged(name); }, CHANGED_MS + 50);
  };

  FieldsSession.prototype.renderChanged = function (name) {
    var controls = this.controls(name);
    var chips = this.form.querySelectorAll('.realtime-editor-changed-by');
    var i;
    for (i = 0; i < chips.length; i++) {
      if (chips[i].getAttribute('data-field') === name) chips[i].parentNode.removeChild(chips[i]);
    }
    var mark = this.changed[name];
    if (mark && Date.now() - mark.at > CHANGED_MS) { delete this.changed[name]; mark = null; }
    for (i = 0; i < controls.length; i++) {
      controls[i].classList.toggle('realtime-editor-changed', !!mark);
      controls[i].style.outlineColor = mark ? colorFor(mark.userId) : '';
    }
    if (!mark || !controls.length) return;
    var chip = el('span', 'realtime-editor-changed-by', t.changed_by.replace('%{name}', mark.by));
    chip.setAttribute('data-field', name);
    chip.style.color = colorFor(mark.userId);
    controls[controls.length - 1].insertAdjacentElement('afterend', chip);
  };

  // --- transport

  FieldsSession.prototype.sync = function () {
    var self = this;
    if (this.stopped || this.inflight) return;
    this.pushLocalChanges();

    var body = new URLSearchParams();
    body.set('key', this.key);
    body.set('client_id', this.clientId);
    body.set('since', String(this.since));
    body.set('presence', '1');
    if (this.epoch !== null) body.set('epoch', String(this.epoch));
    var sent = this.pending;
    this.pending = [];
    if (sent.length) body.set('update', encodeBase64(Y.mergeUpdates(sent)));
    if (this.compactRequested && this.since > 0) {
      body.set('snapshot', encodeBase64(Y.encodeStateAsUpdate(this.doc)));
      body.set('snapshot_upto', String(this.since));
      this.compactRequested = false;
    }
    var waiting = config.longPoll && this.epoch !== null && document.visibilityState === 'visible' && !sent.length;
    if (waiting) body.set('wait', '1');

    var controller = new AbortController();
    controller.waiting = waiting;
    this.inflight = controller;

    fetch(config.syncUrl, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': csrfToken(), 'Accept': 'application/json' },
      body: body,
      signal: controller.signal
    }).then(function (res) {
      if (res.status === 403) { self.stop('forbidden'); throw new Error('forbidden'); }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (json) {
      self.inflight = null;
      self.errors = 0;
      self.handle(json);
      self.schedule(waiting ? 0 : self.nextDelay());
    }).catch(function (err) {
      self.inflight = null;
      if (self.stopped) return;
      if (sent.length) self.pending = sent.concat(self.pending);
      if (err.name === 'AbortError') { self.schedule(0); return; }
      self.errors++;
      self.schedule(self.nextDelay());
    });
  };

  FieldsSession.prototype.handle = function (json) {
    var wasJoined = this.epoch !== null;
    if (!wasJoined || json.epoch_changed) {
      this.epoch = json.epoch;
      this.since = json.last_seq || 0;
      this.rebuildDoc(json.updates || []);
      if (wasJoined) this.repushTouched();
    } else {
      this.applyRemoteUpdates(json.updates || []);
      if (json.last_seq > this.since) this.since = json.last_seq;
    }
    if (json.compact_suggested && Math.random() < 0.5) this.compactRequested = true;
    this.others = (json.presences || []).filter(function (p) { return p.user_id !== config.userId; });
    this.bumpVersion(json.synced_from_version, json.synced_version);
  };

  FieldsSession.prototype.stop = function (reason) {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.rebindTimer);
    if (this.inflight) this.inflight.abort();
    if (reason !== 'forbidden') { this.flush(); this.leave(); }
    this.observer.disconnect();
    this.form.removeEventListener('change', this.onChange);
    this.form.removeEventListener('input', this.onChange);
    this.form.removeEventListener('submit', this.onSubmit);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('pagehide', this.onPageHide);
    var self = this;
    Object.keys(this.changed).forEach(function (name) { delete self.changed[name]; self.renderChanged(name); });
    if (this.marker.parentNode) this.marker.parentNode.removeChild(this.marker);
    if (this.doc) this.doc.destroy();
    this.doc = null;
    this.map = null;
  };

  // ------------------------------------------------------------- bootstrap

  // Sessions exist only while the textarea / form is on screen: Redmine keeps
  // the issue edit form (and the description toolbar) hidden until the user
  // asks for it, and journal forms are injected/removed by ajax.
  var sessions = new Map();
  var formSessions = new Map();
  var HIDDEN_GRACE_MS = 3000;

  function track(registry, elements, describeFn, Ctor, rootOf) {
    var now = Date.now();
    for (var i = 0; i < elements.length; i++) {
      var node = elements[i];
      var visible = isVisible(rootOf ? rootOf(node) : node);
      var session = registry.get(node);
      // The Monaco plugin may take over the textarea after we bound to it.
      if (session && session.editorKind && session.editorKind !== editorKindOf(node)) {
        session.stop();
        registry.delete(node);
        session = null;
      }
      if (visible && !session && !node.disabled) {
        var info = describeFn(node);
        if (info) registry.set(node, new Ctor(node, info));
      } else if (session) {
        // Brief hiding (wiki preview tab) should not end the session.
        if (visible) {
          session.hiddenSince = 0;
        } else if (!session.hiddenSince) {
          session.hiddenSince = now;
        } else if (now - session.hiddenSince > HIDDEN_GRACE_MS) {
          session.stop();
          registry.delete(node);
        }
      }
    }
    registry.forEach(function (session, node) {
      if (!document.body.contains(node)) { session.stop(); registry.delete(node); }
    });
  }

  function scan() {
    track(sessions, document.querySelectorAll('textarea.wiki-edit'), describe, Session, editorRootOf);
    track(formSessions, document.querySelectorAll('form#issue-form'), describeForm, FieldsSession);
  }

  function start() {
    scan();
    setInterval(scan, 700);
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
    document.addEventListener('focusin', function (e) {
      var target = e.target;
      if (!target || !target.matches) return;
      if (target.matches('textarea.wiki-edit') || target.closest('.monaco-editor-wrapper')) scan();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
