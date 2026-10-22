# User guide

[Back to README](../README.md)

## Database setup

**New** creates a private top-level `Zotero2Notion` page and an inline `JournalDB` with 27 properties. `Status` starts with `Not started`, `Reading`, and `Completed`. Project, Tags, and Collections have no preset personal options.

Repeated **New** uses the completed database for the same connection. To use another database, select it with **Refresh → Use**. To start with example pages and views, [duplicate the public template](https://sleepy-hamster-e60.notion.site/Zsotero2Notion-Journal-DB-400cf80747f2804b99e3db09641b7368).

**Property mapping** connects Zotero fields to your Notion property names. `Journal Name` is the paper title, despite the default column name. `Journal Name` and `Zotero Key` are required; other mappings may be cleared to omit them. The plugin checks types before writing and does not automatically delete or change existing property types.

### Default properties

| Property | Type |
|---|---|
| Journal Name | Title |
| Paper URL | URL |
| DOI | Text |
| Status | Select |
| Project | Select |
| Tags | Multi-select |
| Abstract | Text |
| Authors | Text |
| Editors | Text |
| Publication | Text |
| Year | Number |
| Zotero URI | URL |
| Citation Key | Text |
| Collections | Multi-select |
| Date | Text |
| Date Added | Date |
| Date Modified | Date |
| Extra | Text |
| File Path | Text |
| Full Citation | Text |
| In-Text Citation | Text |
| Item Type | Select |
| Place | Text |
| Proceedings Title | Text |
| Series Title | Text |
| Short Title | Text |
| Zotero Key | Text |

`Status` may also use Notion’s status property type. Available metadata depends on the Zotero item; empty source values generally preserve existing values. Tags and Collections also reflect removals. An existing DOI is preserved.

## Templates

Templates are `.md` files under `zotero2notion/templates/` in the Zotero data directory. **Open folder** locates them. Editing in Zotero settings saves after a short pause; changes to selections save immediately. **Saved**, **Saving…**, and **Not saved** show the state. Failed saves keep the editor content and offer **Retry**.

The included **Paper review** and **Section summary** templates are English. Custom templates may use any language. Updates preserve edited templates. Deleting a template removes it from the list while retaining the Markdown file for recovery.

### Variables

Use a Notion property name in brackets, such as `[Abstract]`, `[Full Citation]`, or `[Project]`. Lowercase aliases replace spaces with underscores: `[full_citation]`.

| Shortcut | Value |
|---|---|
| `[title]` | Paper title |
| `[authors]` | All authors, separated by semicolons |
| `[authors_short]` | First author, with “et al.” when applicable |
| `[year]` | Publication year |
| `[paper_link]` | Markdown link to the source |
| `[zotero_link]` | Markdown link to the Zotero item |
| `[zotero_notes]` | Child-note section; use once on its own line |

Custom Notion properties can be read when the page is created. Text, number, select, multi-select, date, checkbox, and URL values are supported; relation, rollup, and formula values are not currently expanded. Unknown variables remain unchanged. Substitution runs once and preserves LaTeX and values containing other bracketed text.

### Zotero notes

Add `[zotero_notes]` **once on its own line** where you want child notes. The two bundled examples include it at the end. There is no extra database property to configure. A paper may have several child notes; each becomes a titled toggle inside **Zotero Notes**. Empty notes are skipped, and no notes means no empty section. Standalone notes and direct PDF annotations are excluded.

The note section is managed separately from the outline. Later Zotero edits update the corresponding imported note, and new child notes join the same group. The rest of your Notion page stays unchanged. Keep personal writing outside the imported note toggles. Deleting or emptying a Zotero note preserves its previously imported content. Removing the placeholder stops subsequent note sync without deleting anything in Notion.

When enabling notes on an existing page, a placeholder at the end of the template appends notes; one at the beginning prepends them. For a custom middle position, add `[zotero_notes]` on its own line in the existing Notion page too. If an initially empty slot can no longer be located after you edit the page, the plugin asks you to add this marker again rather than guessing. Template edits do not relocate an already-created note group.

**Supported content:** text, common emphasis, headings, links, nested lists, quotes, code, simple tables, and inline/block LaTeX. Annotations and citations already included in a note keep their text and available source links. Preview uses links for embedded images and does not upload files. Highlight colors, layout details, and every Zotero editor feature are not guaranteed to carry over.

Embedded PNG, JPEG, GIF, and WebP images are uploaded to Notion (up to 20 MiB each); they must be downloaded in Zotero first. Public image URLs are retained. Merged table cells and images/code/lists inside table cells are rejected with an actionable message rather than silently losing content. Move those blocks outside the table or simplify it before retrying.

Before replacing a changed note, the plugin compares it with its last imported version. If you edited it in Notion, the update pauses. Review the page, then use **Advanced → Check incomplete → Keep current notes** to accept the current Notion content as the baseline. A subsequent Zotero edit can replace that accepted version. Missing or renamed source links/groups must be restored first. Interrupted writes also require review to avoid duplicate notes. Avoid editing the same imported note in both apps during a sync; Notion provides no atomic conditional write for image-containing note ranges.

Upgrades add the placeholder only to untouched built-in outlines. Your customized outlines, names, and default selection are preserved. Add the placeholder to a custom template to opt in; removing it is remembered across restarts.

### Template rules

Without rules, every new page uses the default template. Choose **Default template** in **Templates**; the selection saves automatically. **Edit template** chooses which outline to edit without changing the default. Rules are checked from top to bottom, and the first match wins. Match by a collection (including descendants) or an exact tag name. Collection matching uses a stable key, so renaming a collection does not break its rule. Incomplete or disabled rules do not apply.

## Sync behavior

- All regular bibliographic items in **My Library** are eligible. Group libraries, trash, standalone notes, and attachments are excluded.
- Initial setup queues existing items. Subsequent Zotero additions and changes trigger sync while Zotero is running.
- Changing the database or property mapping rechecks the library. Editing a template does not rewrite existing page bodies.
- A Zotero key is the primary link. Candidate existing pages are checked using DOI, arXiv ID, source URL, and title. A title alone is not enough to merge pages automatically.
- Page outlines are inserted once into new pages, or eligible empty pages marked `Not started`. Personal page content and reading status are preserved; opted-in child notes update separately.
- Project is derived from the collection name only when an item is in exactly one collection. A manually changed Project value is preserved.
- Items removed from Zotero do not delete Notion pages. Inaccessible or trashed linked Notion pages are not automatically recreated.
- To restore a linked Notion page from the trash, right-click its paper in Zotero and choose **Send to Notion**. The original page is restored and synced, preserving its URL, personal notes, and reading status. **Retry failed**, **Recheck library**, and automatic sync do not restore trashed pages. If restoration fails or Zotero closes before the attempt, use **Send to Notion** again; a missing or inaccessible page is never replaced automatically.

## Recovery

Open **Advanced → Status and recovery**:

- **Retry failed** retries queued failures.
- **Recheck library** checks the full library again.
- **Check incomplete** inspects interrupted setup, unconfirmed page/note writes, and note conflicts.
- **Keep current notes** accepts reviewed Notion notes as the baseline without overwriting them.
- **Use Notion URL** associates an already created setup page or database so **New** can continue.
- **Allow retry** is for cases where you have confirmed that an uncertain create request did not succeed.

The plugin pauses uncertain creation requests to avoid making duplicates. Failed item syncs remain on disk and receive up to three scheduled retries. For an invalid PAT, reconnect with a new one and reselect the destination database.
