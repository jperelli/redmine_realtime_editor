---
name: redmine-realtime-browser-testing
description: Run two-user local Redmine realtime editing tests with optional Monaco, capture transient carets, and restore settings.
---

# Local setup
- Start the repository's Docker Compose services with `docker compose up -d`.
- To test Monaco, use a local ignored Compose override mounting the companion plugin at `/usr/src/redmine/plugins/redmine_monaco_editor`; recreate the service after adding or removing the override.
- Do not equate Puma's listening log with application readiness. Navigate to the login page and verify it renders; initial concurrent requests may race development initialization. Container recreation may invalidate sessions, requiring fresh login.
- Use isolated browser contexts for two authorized project members. An administrator is needed for plugin settings.

# UI paths and assertions
- Issue edit: `/issues/<id>/edit`, then Description → Edit in both sessions. Wait for Live and peer presence before collaborative actions. Initial attribute synchronization can close the description; if this occurs, record the caveat, reopen it, and verify readiness before retrying.
- Monaco preference: `/my/account`, checkbox `input[type=checkbox][name="monaco_settings[enabled]"]`. The account form can contain multiple Save buttons; use the first Save in `#my_account_form`. Reload and verify the preference persisted.
- Notes mode: `/settings/plugin/redmine_realtime_editor`, `#settings_notes_mode`, Apply. Reload both editors after switching. Private mode must not transfer comment text; shared mode must lock the peer after posting and provide a reload link.
- Verify bidirectional unique text and exact equality, not merely that both editors are present. For Monaco use its visible editor and keyboard; its associated hidden textarea can be read for equality.
- Caret name labels fade to a quiet state. After moving the peer caret, capture promptly when `.realtime-editor-caret:not(.realtime-editor-caret-quiet)` appears; existing text in the overlay alone does not prove a visible name. Monaco uses `.realtime-editor-mc-caret` and `.realtime-editor-mc-selection`.
- Capture paired screenshots and inspect pixels. Preserve initial failure evidence separately from retries.
- Restore notes mode and user editor preferences. Remove the optional override only when the requested final state or no-Monaco regression calls for it. Do not commit local environment changes.

# Devin Secrets Needed
- No secret names are standardized by this repository. Obtain authorized local administrator and second project-member credentials from the task/environment; do not embed passwords in this skill.
