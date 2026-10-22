import {
  decodePage,
  inspectSchema,
  schemaCheckMessage,
  encodeProperties,
  matchExisting,
  selectTemplate,
  renderTemplate,
} from "./model.js";
import { NotesSync, notesPlacement } from "./notes.js";

function checkLinkedPage(page, source, key, mapping) {
  if (page.parent?.data_source_id !== source)
    throw new Error(
      "The linked page has moved to another database. Check the destination database.",
    );
  const existing = decodePage(page, mapping);
  if (existing["Zotero Key"] && existing["Zotero Key"] !== key)
    throw new Error(
      "This paper is linked to a different Zotero item. Check the original item.",
    );
  return existing;
}

export class SyncEngine {
  constructor({ api, store, readTemplate, readNotes = async () => [], renderNote, log = () => {} }) {
    Object.assign(this, { api, store, readTemplate, log });
    this.notes = new NotesSync({ api, store, readNotes, renderNote });
  }
  async run(item, config, context, { restoreTrashed = false } = {}) {
    const id = config.dataSourceID;
    if (!id) throw new Error("Choose a destination Notion database first.");
    const key = `${id}:${item.values["Zotero Key"]}`;
    const record = this.store.state.records[key] || {};
    const schema =
      context.schema ||
      (context.schema = (await this.api.schema(id)).properties);
    const check = inspectSchema(schema, config.mapping);
    if (check.conflicts.length || check.missing.length)
      throw new Error(schemaCheckMessage(check));
    // Validate template before creating anything; scope/rule errors never leave a new row.
    const template = selectTemplate(config, item);
    const md = await this.readTemplate(template);
    if (!md.trim()) throw new Error("The selected template is empty.");
    const placement = notesPlacement(md);
    let page;
    if (record.pageID) {
      page = await this.api.page(record.pageID);
    } else {
      context.rows ||= await this.api.rows(id);
      page = matchExisting(item.values, context.rows, config.mapping);
      if (!page && record.creating)
        throw new Error(
          "The previous page creation result is uncertain. Check Notion, then review the incomplete record in Status and recovery.",
        );
    }
    if (page) {
      let existing = checkLinkedPage(page, id, item.values["Zotero Key"], config.mapping);
      if (page.in_trash || page.archived) {
        if (!restoreTrashed)
          throw new Error(
            "The linked page is in the trash. Right-click this item in Zotero and choose Send to Notion to restore it.",
          );
        const restored = await this.api.restore(page.id);
        if (restored?.id !== page.id || restored.in_trash !== false || restored.archived)
          throw new Error(
            "Notion could not confirm the page was restored. Check the page and its parent in Notion, then use Send to Notion again.",
          );
        existing = checkLinkedPage(restored, id, item.values["Zotero Key"], config.mapping);
        page = restored;
        this.log(`Restored · ${item.values["Journal Name"]}`);
      }
      const properties = encodeProperties(item.values, schema, config.mapping, {
        existing,
        managedProject: record.managedProject,
      });
      // Persist binding before any update. A later body failure must not create another page.
      Object.assign(record, { pageID: page.id, creating: false });
      this.store.state.records[key] = record;
      await this.store.saveState();
      if (Object.keys(properties).length)
        page = await this.api.update(page.id, properties);
      if (properties[config.mapping.Project])
        record.managedProject = item.values.Project;
      if (context.rows) {
        const index = context.rows.findIndex((p) => p.id === page.id);
        if (index >= 0) context.rows[index] = page;
        else context.rows.push(page);
      }
    } else {
      const properties = encodeProperties(
        { ...item.values, Status: "Not started" },
        schema,
        config.mapping,
        { isNew: true },
      );
      record.creating = true;
      this.store.state.records[key] = record;
      await this.store.saveState();
      try {
        page = await this.api.create(id, properties);
      } catch (error) {
        context.rows = undefined;
        throw error;
      }
      if (!page?.id)
        throw new Error(
          "Could not confirm Notion page creation. Stopped to prevent duplicates.",
        );
      Object.assign(record, {
        pageID: page.id,
        creating: false,
        managedProject: item.values.Project || "",
        createdByPlugin: true,
      });
      await this.store.saveState();
      context.rows?.push(page);
    }
    if (!record.bodyDone) {
      const current = await this.api.markdown(page.id);
      const values = decodePage(page, config.mapping);
      if (
        current.truncated ||
        current.unknown_block_ids?.length ||
        current.markdown?.trim() ||
        (values.Status
          ? values.Status !== "Not started"
          : !record.createdByPlugin)
      ) {
        record.bodyDone = true; // Existing user content always wins, including unknown blocks.
      } else {
        await this.api.appendMarkdown(
          page.id,
          renderTemplate(md, { ...item.values, ...values }),
        );
        record.bodyDone = true;
        record.templateID = template.id;
      }
    }
    await this.notes.sync(item, record, placement);
    record.syncedAt = new Date().toISOString();
    record.url = page.url;
    await this.store.saveState();
    this.log(`Synced · ${item.values["Journal Name"]}`);
    return record;
  }
}
