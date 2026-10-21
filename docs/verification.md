# Verification

The PAT-only implementation has **65 automated tests**, covering page matching and duplicates, interrupted writes, template substitution, property handling, automatic activation, autosave, database setup recovery, and credential handling.

The 0.1.9 runtime was tested in an isolated **Zotero 10.0.6 on macOS** profile with mocked Notion responses. Checks included PAT entry, database creation with 27 fields, repeated creation without duplicates, disconnect/reconnect, Refresh/Use, sync activation, and settings layout at normal and narrow widths. The installed XPI was also checked in the normal Zotero settings UI.

The maintainer completed live PAT testing before this release preparation. Automated and isolated-profile tests do not substitute for end-to-end tests against every Notion workspace. Windows and Linux UI behavior has not yet been manually verified.

Version 0.1.10 packages that implementation for GitHub distribution, adds the public update URL, and changes documentation/build metadata. It does not change synchronization behavior.

Version 0.1.11 adds checks for actionable property-recovery messages and persistence of a custom default template across a settings reload. The missing-property and property-type-conflict paths produce different guidance.

The 0.1.11 XPI was installed in Zotero on macOS. Selecting a custom Korean template under **Default template** saved it automatically; closing and reopening settings retained the selection and loaded that template in the editor. Choosing another **Edit template** did not change the saved default. The installed XPI matched the release artifact. Missing-property recovery text was verified with automated tests; the live database already had its required properties.
