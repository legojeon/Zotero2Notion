import {
  decodePage,
  inspectSchema,
  schemaCheckMessage,
  encodeProperties,
  matchExisting,
  selectTemplate,
  renderTemplate,
} from "./model.js";
export class SyncEngine {
  constructor({ api, store, readTemplate, log = () => {} }) {
    Object.assign(this, { api, store, readTemplate, log });
  }
  async run(item, config, context) {
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
    let page;
    if (record.pageID) {
      page = await this.api.page(record.pageID);
      if (page.in_trash || page.archived)
        throw new Error(
          "The linked page is in the trash. It will not be recreated automatically.",
        );
      if (page.parent?.data_source_id !== id)
        throw new Error(
          "The linked page has moved to another database. Check the destination database.",
        );
    } else {
      context.rows ||= await this.api.rows(id);
      page = matchExisting(item.values, context.rows, config.mapping);
      if (!page && record.creating)
        throw new Error(
          "The previous page creation result is uncertain. Check Notion, then review the incomplete record in Status and recovery.",
        );
    }
    if (page) {
      const existing = decodePage(page, config.mapping);
      const owner = existing["Zotero Key"];
      if (owner && owner !== item.values["Zotero Key"])
        throw new Error(
          "This paper is linked to a different Zotero item. Check the original item.",
        );
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
    record.syncedAt = new Date().toISOString();
    record.url = page.url;
    await this.store.saveState();
    this.log(`Synced · ${item.values["Journal Name"]}`);
    return record;
  }
}
