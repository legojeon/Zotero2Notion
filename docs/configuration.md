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

Custom Notion properties can be read when the page is created. Text, number, select, multi-select, date, checkbox, and URL values are supported; relation, rollup, and formula values are not currently expanded. Unknown variables remain unchanged. Substitution runs once and preserves LaTeX and values containing other bracketed text.

### Template rules

Without rules, every new page uses the default template. Choose **Default template** in **Templates**; the selection saves automatically. **Edit template** chooses which outline to edit without changing the default. Rules are checked from top to bottom, and the first match wins. Match by a collection (including descendants) or an exact tag name. Collection matching uses a stable key, so renaming a collection does not break its rule. Incomplete or disabled rules do not apply.

## Sync behavior

- All regular bibliographic items in **My Library** are eligible. Group libraries, trash, standalone notes, and attachments are excluded.
- Initial setup queues existing items. Subsequent Zotero additions and changes trigger sync while Zotero is running.
- Changing the database or property mapping rechecks the library. Editing a template does not rewrite existing page bodies.
- A Zotero key is the primary link. Candidate existing pages are checked using DOI, arXiv ID, source URL, and title. A title alone is not enough to merge pages automatically.
- Page outlines are inserted once into new pages, or eligible empty pages marked `Not started`. Existing notes and reading status are preserved.
- Project is derived from the collection name only when an item is in exactly one collection. A manually changed Project value is preserved.
- Items removed from Zotero do not delete Notion pages. Inaccessible or trashed linked Notion pages are not automatically recreated.

## Recovery

Open **Advanced → Status and recovery**:

- **Retry failed** retries queued failures.
- **Recheck library** checks the full library again.
- **Check incomplete** inspects an interrupted database setup.
- **Use Notion URL** associates an already created setup page or database so **New** can continue.
- **Allow retry** is for cases where you have confirmed that an uncertain create request did not succeed.

The plugin pauses uncertain creation requests to avoid making duplicates. Failed item syncs remain on disk and receive up to three scheduled retries. For an invalid PAT, reconnect with a new one and reselect the destination database.
