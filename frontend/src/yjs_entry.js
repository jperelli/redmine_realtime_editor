// Entry point of the bundle exposed as window.RealtimeEditorYjs. Only the Yjs
// API used by assets/javascripts/realtime_editor.js is re-exported.
export {
  Doc,
  applyUpdate,
  encodeStateAsUpdate,
  mergeUpdates,
  // Collaborative undo for editors whose own undo stack cannot follow remote
  // edits (Monaco): only local changes are undone, never the other users'.
  UndoManager,
  // Remote carets travel as relative positions: they stay attached to the
  // right character while the text changes around them.
  createRelativePositionFromTypeIndex,
  createAbsolutePositionFromRelativePosition,
  relativePositionToJSON,
  createRelativePositionFromJSON
} from 'yjs';
