/* Collaborative editing of Redmine textareas over HTTP polling.
 *
 * Every textarea.wiki-edit that maps to a known document key gets a Yjs
 * document bound to it. Local edits become Yjs updates that are POSTed to the
 * plugin controller; the same request returns the updates of the other
 * editors, which are applied to the local document and thus to the textarea.
 * No websocket, no extra server process: the transport is the Redmine app.
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

  // ------------------------------------------------------------ document keys

  function formOf(textarea) {
    return textarea.form || textarea.closest('form');
  }

  // Returns {key, versionField} for a textarea we know how to share, or null.
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
        versionField: form.querySelector('input[name="issue[lock_version]"]')
      };
    }
    m = textarea.id.match(/^journal_(\d+)_notes$/);
    if (m) {
      if (config.targets.indexOf('journal_notes') < 0) return null;
      return { key: 'journal:' + m[1] + ':notes', versionField: null };
    }
    if (textarea.id === 'content_text' && form && form.id === 'wiki_form') {
      if (config.targets.indexOf('wiki') < 0) return null;
      m = action.match(/\/projects\/([^/]+)\/wiki\/([^/?#]+)/);
      if (!m) return null;
      var section = form.querySelector('input[name="section"]');
      var key = 'wiki:' + decodeURIComponent(m[1]) + ':' + decodeURIComponent(m[2]);
      if (section && section.value) key += '/' + section.value;
      return { key: key, versionField: section ? null : form.querySelector('input[name="content[version]"]') };
    }
    return null;
  }

  // ------------------------------------------------------------------ session

  var TYPING_MS = 2500;
  var SEND_DEBOUNCE_MS = 150;

  function Session(textarea, info) {
    this.textarea = textarea;
    this.key = info.key;
    this.versionField = info.versionField;
    this.clientId = randomId();
    this.epoch = null;
    this.since = 0;
    this.savedText = null;
    this.pending = [];
    this.seedUpdate = null;
    this.compactRequested = false;
    this.others = [];
    this.lastInputAt = 0;
    this.errors = 0;
    this.timer = null;
    this.inflight = null;
    this.stopped = false;
    this.doc = null;
    this.ytext = null;

    this.buildStatusBar();
    this.markForm();

    var self = this;
    this.onInput = function () { self.lastInputAt = Date.now(); self.pushLocalChanges(); self.schedule(SEND_DEBOUNCE_MS); };
    textarea.addEventListener('input', this.onInput);
    textarea.addEventListener('change', this.onInput);
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
    this.statusText.textContent = t[state] || state;
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
    var local = this.textarea.value;
    if (this.doc) this.doc.destroy();
    this.pending = [];
    this.seedUpdate = null;
    // Textareas normalise line endings to \n; Redmine stores what the browser
    // submitted (\r\n), so compare like with like.
    this.savedText = savedText == null ? '' : savedText.replace(/\r\n?/g, '\n');
    this.doc = new Y.Doc();
    this.ytext = this.doc.getText('text');

    this.doc.on('update', function (update, origin) {
      if (origin === 'local') self.pending.push(update);
    });
    this.ytext.observe(function (event, txn) {
      if (txn.origin === 'local') return;
      self.applyRemoteDelta(event.delta);
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
      this.setTextareaValue(local);
      this.pushLocalChanges();
    } else {
      this.setTextareaValue(draft);
      if (draft !== this.savedText) this.showNotice(t.draft_loaded);
    }
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
    var ta = this.textarea;
    var start = ta.selectionStart;
    var end = ta.selectionEnd;
    var scroll = ta.scrollTop;
    var focused = document.activeElement === ta;
    ta.value = this.ytext.toString();
    if (focused) {
      ta.setSelectionRange(transformIndex(delta, start), transformIndex(delta, end));
    }
    ta.scrollTop = scroll;
  };

  Session.prototype.setTextareaValue = function (value) {
    if (this.textarea.value === value) return;
    var scroll = this.textarea.scrollTop;
    this.textarea.value = value;
    this.textarea.scrollTop = scroll;
  };

  // Pushes whatever differs between the textarea and the shared text as a local
  // edit. Also catches changes made without an input event (toolbar buttons).
  Session.prototype.pushLocalChanges = function () {
    if (!this.doc) return;
    var current = this.ytext.toString();
    var value = this.textarea.value;
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
      if (this.inflight.waiting && ms <= SEND_DEBOUNCE_MS) this.inflight.abort();
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(function () { self.sync(); }, ms);
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
    if (!wasJoined || json.epoch_changed) {
      this.epoch = json.epoch;
      this.since = json.last_seq || 0;
      // After a reset (somebody saved) the local text is stale by definition.
      this.rebuildDoc(json.saved_text, json.updates || [], !wasJoined);
      if (wasJoined) this.showNotice(t.reset);
    } else {
      this.applyRemoteUpdates(json.updates || []);
      if (json.last_seq > this.since) this.since = json.last_seq;
    }
    if (json.compact_suggested && Math.random() < 0.5) this.compactRequested = true;
    this.others = (json.presences || []).filter(function (p) { return p.user_id !== config.userId; });
    this.renderPeers();
    this.bumpVersion(json.synced_from_version, json.synced_version);
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
    if (this.epoch === null) return;
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
    if (this.inflight) this.inflight.abort();
    if (reason !== 'forbidden') { this.flush(); this.leave(); }
    this.textarea.removeEventListener('input', this.onInput);
    this.textarea.removeEventListener('change', this.onInput);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('pagehide', this.onPageHide);
    var form = formOf(this.textarea);
    if (form) form.removeEventListener('submit', this.onSubmit);
    if (this.bar.parentNode) this.bar.parentNode.removeChild(this.bar);
    if (this.marker && this.marker.parentNode) this.marker.parentNode.removeChild(this.marker);
    if (this.doc) this.doc.destroy();
    this.doc = null;
  };

  // ------------------------------------------------------------- bootstrap

  // Sessions exist only while the textarea is on screen: Redmine keeps the
  // issue edit form (and the description toolbar) hidden until the user asks
  // for it, and journal forms are injected/removed by ajax.
  var sessions = new Map();
  var HIDDEN_GRACE_MS = 3000;

  function scan() {
    var areas = document.querySelectorAll('textarea.wiki-edit');
    var now = Date.now();
    for (var i = 0; i < areas.length; i++) {
      var ta = areas[i];
      var visible = isVisible(ta);
      var session = sessions.get(ta);
      if (visible && !session) {
        var info = describe(ta);
        if (info) sessions.set(ta, new Session(ta, info));
      } else if (session) {
        // Brief hiding (wiki preview tab) should not end the session.
        if (visible) {
          session.hiddenSince = 0;
        } else if (!session.hiddenSince) {
          session.hiddenSince = now;
        } else if (now - session.hiddenSince > HIDDEN_GRACE_MS) {
          session.stop();
          sessions.delete(ta);
        }
      }
    }
    sessions.forEach(function (session, ta) {
      if (!document.body.contains(ta)) { session.stop(); sessions.delete(ta); }
    });
  }

  function start() {
    scan();
    setInterval(scan, 700);
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
    document.addEventListener('focusin', function (e) {
      if (e.target && e.target.matches && e.target.matches('textarea.wiki-edit')) scan();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
