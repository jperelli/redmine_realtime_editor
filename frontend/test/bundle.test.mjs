// Loads the committed bundle the way a browser does (a global) and checks the
// behaviour realtime_editor.js relies on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

const source = readFileSync(new URL('../../assets/javascripts/realtime_editor_yjs.js', import.meta.url), 'utf8');
const sandbox = { crypto: webcrypto, TextEncoder, TextDecoder, console };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const Y = sandbox.RealtimeEditorYjs;

test('exposes exactly the API the client uses', () => {
  const api = ['Doc', 'applyUpdate', 'encodeStateAsUpdate', 'mergeUpdates',
    'createRelativePositionFromTypeIndex', 'createAbsolutePositionFromRelativePosition',
    'relativePositionToJSON', 'createRelativePositionFromJSON'];
  for (const name of api) {
    assert.equal(typeof Y[name], 'function', name);
  }
});

test('two documents converge when updates are exchanged in any order', () => {
  const a = new Y.Doc();
  const b = new Y.Doc();
  const fromA = [];
  const fromB = [];
  a.on('update', (u) => fromA.push(u));
  b.on('update', (u) => fromB.push(u));

  a.getText('text').insert(0, 'Hello world');
  Y.applyUpdate(b, Y.mergeUpdates(fromA));
  fromA.length = 0;

  a.getText('text').insert(11, ' from A');
  b.getText('text').insert(0, 'B says: ');

  Y.applyUpdate(b, Y.mergeUpdates(fromA));
  Y.applyUpdate(a, Y.mergeUpdates(fromB));

  assert.equal(a.getText('text').toString(), 'B says: Hello world from A');
  assert.equal(b.getText('text').toString(), a.getText('text').toString());
});

test('seeding with a deterministic client id is idempotent', () => {
  // Two browsers joining an empty document both seed it with the saved text;
  // identical seeds must not duplicate the text when both are applied.
  const seed = (text) => {
    const d = new Y.Doc();
    d.clientID = 12345;
    d.getText('text').insert(0, text);
    return Y.encodeStateAsUpdate(d);
  };
  const doc = new Y.Doc();
  Y.applyUpdate(doc, seed('saved text'));
  Y.applyUpdate(doc, seed('saved text'));
  assert.equal(doc.getText('text').toString(), 'saved text');
});

test('a caret sent as a relative position follows its character across edits', () => {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.getText('text').insert(0, 'hello world');
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

  // B's caret is right before "world"; it travels as JSON through the server.
  const rel = Y.createRelativePositionFromTypeIndex(b.getText('text'), 6);
  const wire = JSON.stringify(Y.relativePositionToJSON(rel));
  assert.ok(wire.length < 200, `cursor JSON is small (${wire.length} bytes)`);

  // Meanwhile A inserted text before the caret.
  a.getText('text').insert(0, 'oh, ');
  const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(JSON.parse(wire)), a);
  assert.equal(abs.index, 10);
  assert.equal(a.getText('text').toString().slice(abs.index), 'world');
});

test('a snapshot replaces the log it was built from', () => {
  const src = new Y.Doc();
  src.getText('text').insert(0, 'one');
  src.getText('text').insert(3, ' two');
  const snapshot = Y.encodeStateAsUpdate(src);

  const late = new Y.Doc();
  Y.applyUpdate(late, snapshot);
  assert.equal(late.getText('text').toString(), 'one two');
});
