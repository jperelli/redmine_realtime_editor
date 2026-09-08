# Changelog

## v0.1.0 - unreleased

### Features

- Collaborative real-time editing (Yjs CRDT) of issue descriptions, issue notes, edited journal notes and wiki pages
- Transport over plain HTTP polling to the Redmine app itself, optional long polling; no websocket server or infrastructure change
- Remote carets and selections of the other editors drawn over the textarea, one colour per user with a name label
- Presence bar under each shared textarea: who else is editing, who is typing, live/offline state
- Shared drafts survive a page reload for a configurable time and are discarded after everybody leaves
- Saving a co-edited description or wiki page does not trigger Redmine's stale-object conflict for the other editors
- New comments private (default, presence only) or shared; when a shared comment is posted the other editors get a banner naming the author and the notes box is locked until they reload
- Plugin settings: fields to share, notes mode, poll periods, long polling hold, draft lifetime, compaction threshold
