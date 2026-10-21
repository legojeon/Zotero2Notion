import {
  TYPES,
  initialConfig,
  inspectSchema,
  missingSchemaProperties,
} from "./model.js";

const uncertain = () =>
  new Error(
    "Creation could not be confirmed. Check Notion, then open Advanced → Status and recovery → Check incomplete. Nothing will be created again automatically.",
  );
const active = (object) => {
  if (!object?.id || object.archived || object.in_trash)
    throw new Error(
      "The setup page or database is unavailable. Restore it in Notion or choose another database with Refresh and Use.",
    );
  return object;
};
const sameID = (a, b) =>
  String(a).replaceAll("-", "") === String(b).replaceAll("-", "");

// One durable setup per connection. Never replay a creation with an unknown outcome.
export class DatabaseSetup {
  constructor(api, store) {
    Object.assign(this, { api, store });
  }
  async identity() {
    const me = await this.api.me();
    if (!me.id || me.bot?.owner?.type !== "user")
      throw new Error(
        "New requires a personal access token with the Notion API capability. Create one with Get token.",
      );
    return me;
  }
  async record() {
    const me = await this.identity();
    const key = [
      me.bot.workspace_id || "",
      me.id,
      me.bot.owner.user?.id || "",
    ].join(":");
    this.store.state.databaseSetups ||= {};
    const record = (this.store.state.databaseSetups[key] ||= {});
    return { record, me };
  }
  async create(record, stage, fn) {
    const idKey = stage + "ID";
    if (record[idKey]) return;
    if (record.pending) throw uncertain();
    record.pending = stage;
    // Commit intent before sending the non-idempotent request.
    try {
      await this.store.saveState();
    } catch (error) {
      delete record.pending;
      throw error;
    }
    let result;
    try {
      result = await fn();
    } catch (error) {
      // Explicit rejections have no side effect. Timeouts, 5xx and malformed
      // success responses remain pending across restarts until manually checked.
      if ([400, 401, 403, 404, 422, 429].includes(error.status)) {
        delete record.pending;
        await this.store.saveState();
        throw error;
      }
      throw uncertain();
    }
    if (!result?.id) throw uncertain();
    record[idKey] = result.id;
    delete record.pending;
    await this.store.saveState();
  }
  async run() {
    const { record } = await this.record();
    await this.create(record, "page", () => this.api.createWorkspacePage());
    active(await this.api.page(record.pageID));
    const mapping = initialConfig().mapping;
    const properties = missingSchemaProperties(
      Object.entries(TYPES).map(([name, type]) => ({ name, type })),
    );
    properties.Status.select.options = [
      "Not started",
      "Reading",
      "Completed",
    ].map((name) => ({ name }));
    await this.create(record, "database", () =>
      this.api.createDatabase(record.pageID, properties),
    );
    const database = active(await this.api.database(record.databaseID));
    if (database.data_sources?.length !== 1)
      throw new Error(
        "This database has no single data source. Select its data source with Refresh and Use.",
      );
    const id = database.data_sources[0].id;
    const source = active(await this.api.schema(id));
    const check = inspectSchema(source.properties, mapping);
    if (check.missing.length || check.conflicts.length)
      throw new Error(
        "The new database properties have changed. Select it with Refresh and Use to review the mapping.",
      );
    return { id, name: "JournalDB", mapping, check };
  }
  async incomplete() {
    const { record } = await this.record();
    return record.pending || "";
  }
  // Called only by explicit recovery controls after the user checks Notion.
  async recover(url) {
    const { record, me } = await this.record();
    if (!record.pending) return;
    const previous = { ...record };
    if (url) {
      let path = url.trim();
      if (path.startsWith("https://")) {
        const parsed = new URL(path);
        if (!/(^|\.)notion\.(so|site|com)$/.test(parsed.hostname))
          throw new Error("Enter a Notion page or database URL.");
        path = parsed.pathname;
      }
      const matched = path.match(
        /([a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/?$/i,
      )?.[1];
      if (!matched)
        throw new Error(
          "Enter the URL of the page or database created by New.",
        );
      const id = matched
        .replaceAll("-", "")
        .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
      const stage = record.pending;
      const object = active(
        await (stage === "page" ? this.api.page(id) : this.api.database(id)),
      );
      if (stage === "page") {
        const name = (object.properties?.title?.title || [])
          .map((t) => t.plain_text ?? t.text?.content ?? "")
          .join("");
        if (
          object.parent?.type !== "workspace" ||
          name !== "Zotero2Notion" ||
          ![me.id, me.bot.owner.user?.id].some(
            (id) => id && sameID(id, object.created_by?.id),
          )
        )
          throw new Error(
            "Use the private Zotero2Notion page created by this connection.",
          );
      } else if (!sameID(object.parent?.page_id, record.pageID)) {
        throw new Error(
          "Use the database inside the Zotero2Notion setup page.",
        );
      }
      record[stage + "ID"] = object.id;
    }
    delete record.pending;
    try {
      await this.store.saveState();
    } catch (error) {
      for (const key of Object.keys(record)) delete record[key];
      Object.assign(record, previous);
      throw error;
    }
  }
}
