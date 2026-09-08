// Entry point of the bundle exposed as window.RealtimeEditorYjs. Only the Yjs
// API used by assets/javascripts/realtime_editor.js is re-exported.
export { Doc, applyUpdate, encodeStateAsUpdate, mergeUpdates } from 'yjs';
