# Verification

The implementation has **106 automated tests**, covering page matching and duplicates, interrupted writes, template substitution, property handling, automatic activation, autosave, database setup recovery, and credential handling.

The 0.1.9 runtime was tested in an isolated **Zotero 10.0.6 on macOS** profile with mocked Notion responses. Checks included PAT entry, database creation with 27 fields, repeated creation without duplicates, disconnect/reconnect, Refresh/Use, sync activation, and settings layout at normal and narrow widths. The installed XPI was also checked in the normal Zotero settings UI.

The maintainer completed live PAT testing before this release preparation. Automated and isolated-profile tests do not substitute for end-to-end tests against every Notion workspace. Windows and Linux UI behavior has not yet been manually verified.

Version 0.1.10 packages that implementation for GitHub distribution, adds the public update URL, and changes documentation/build metadata. It does not change synchronization behavior.

Version 0.1.11 adds checks for actionable property-recovery messages and persistence of a custom default template across a settings reload. The missing-property and property-type-conflict paths produce different guidance.

The 0.1.11 XPI was installed in Zotero on macOS. Selecting a custom Korean template under **Default template** saved it automatically; closing and reopening settings retained the selection and loaded that template in the editor. Choosing another **Edit template** did not change the saved default. The installed XPI matched the release artifact. Missing-property recovery text was verified with automated tests; the live database already had its required properties.

Version 0.1.12 adds placeholder validation, multiple/empty notes, changed-note isolation, conflict and timeout recovery, template migration/opt-out persistence, HTML conversion, images, LaTeX, and page-sync integration checks. All 93 automated tests pass.

An isolated Zotero 10.0.6 profile on macOS verified real child-note extraction, image-only notes, embedded attachment bytes, native multipart construction, the DOM converter, image-change routing to the paper, and exactly two fresh-install templates. The isolated profile used mocked Notion responses and no personal library or credentials.

A separate private, synthetic Notion test page verified placement in the middle of an outline, two child notes, actual image upload and attachment, inline/block equations, repeat sync without duplicates, independent image-containing note replacement, preservation of other notes and personal text, conflict detection/recovery, and later note addition. Testing exposed and fixed escaped marker readback, the image block upload patch format, and changing signed image URLs. Image-containing replacements use a uniquely bounded range after a fresh content comparison; they cannot guarantee atomic protection against simultaneous Notion edits. The private test page was removed after verification.

The 0.1.12 XPI was installed in the normal Zotero profile. The plugin manager shows 0.1.12; settings expose the new placeholder instructions; the bundled Paper review outline contains `[zotero_notes]`; and the custom Korean template and default selection remain unchanged. Installed XPI bytes match the release artifact.

Version 0.1.13 adds tests for explicit-send restoration, preservation of page identity/content/status, permission and response failures, ownership/destination checks, same-batch duplicate prevention, per-item queue isolation, library rechecks, scheduled retries, in-flight requests, destination changes, and restarted queues. All 106 automated tests pass. The restore payload follows the [Notion trash/restore API](https://developers.notion.com/reference/trash-page).

The 0.1.13 XPI was installed in Zotero 10.0.6 on macOS and the app was restarted. Automatic retries left an existing trashed paper unchanged; the item context-menu **Send to Notion** action restored that exact page with the same URL, outline, and reading status. Its separate note import paused with the expected missing-placeholder guidance because its older outline lacks the custom template’s middle insertion marker. Existing settings and all custom template files remained byte-for-byte unchanged.
