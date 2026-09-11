# Changelog

## v0.2.0 - 2026-09-11

### Features

- Support for the [Monaco Editor plugin](https://github.com/ochipin/redmine_monaco_editor): when it replaces a textarea the session binds to the Monaco model (local edits, remote edits applied as model edits, remote carets and selections as decorations, read-only lock after a shared comment is posted). Users on Monaco and on the plain textarea co-edit the same text.

## v0.1.0 - 2026-09-09

### Features

- Collaborative real-time editing (Yjs CRDT) of issue descriptions, issue notes, edited journal notes and wiki pages
- Transport over plain HTTP polling to the Redmine app itself, optional long polling; no websocket server or infrastructure change
- Every other field of the issue edit form (status, assignee, dates, custom fields...) is shared as well: remote changes are applied to the native controls with a "changed by" mark, and survive Redmine's own form refresh (an open description textarea is reopened after it)
- Remote carets and selections of the other editors drawn over the textarea, one colour per user with a name label
- Presence bar under each shared textarea: who else is editing, who is typing, live/offline state
- Shared drafts survive a page reload for a configurable time and are discarded after everybody leaves
- Saving from a co-edited issue form or wiki page does not trigger Redmine's stale-object conflict for the other editors; changes made outside a collaborative form still do
- New comments private (default, presence only) or shared; when a shared comment is posted the other editors get a banner naming the author and the notes box is locked until they reload
- Plugin settings: fields to share, notes mode, poll periods, long polling hold, draft lifetime, compaction threshold
