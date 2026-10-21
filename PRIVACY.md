# Privacy

Zotero2Notion runs inside Zotero and sends requests directly to the Notion API. There is no Zotero2Notion authentication server, analytics service, or telemetry endpoint.

- Your personal access token is stored in Zotero/Mozilla’s login store, not the plugin’s settings file. It is sent to Notion for authentication and is not intentionally logged.
- Mapped metadata is sent to your selected Notion database. This can include titles, authors, abstracts, tags, collection names, citation text, extra fields, Zotero links, and **local attachment paths**. Clear optional mappings you do not want to send.
- PDFs, attachment contents, Zotero notes, and annotations are not uploaded by the plugin.
- Settings, sync records, and Markdown templates are saved in the `zotero2notion` folder inside your Zotero data directory.
- **Disconnect** removes the stored connection and stops syncing. It does not delete your Notion pages or template files. Revoke the PAT in Notion if you want to invalidate it.
- Zotero may contact GitHub to check for and download plugin updates. Opening **Get token** or a linked page uses your browser.

The PAT uses its creator’s workspace permissions. Notion’s own data-handling policies apply to content stored there.
