import { Autosave } from "./autosave.js";
import { Store, Credentials } from "./storage.js";
import { NotionClient } from "./notion.js";
import { SyncEngine } from "./sync.js";
import { DatabaseSetup } from "./setup.js";
import {
  TYPES,
  inspectSchema,
  schemaCheckMessage,
  missingSchemaProperties,
  renderTemplate,
  selectTemplate,
  decodePage,
} from "./model.js";
import { extractItem, extractNotes, renderZoteroNote, inScope, allCollections } from "./zotero.js";
import { notesPlacement, wrapNote, wrapNotes } from "./notes.js";
const app = {
  running: false,
  stopped: false,
  logs: [],
  listeners: new Set(),
  busy: false,
  timer: null,
  retry: null,
  attempts: 0,
  async start({ id, rootURI }) {
    this.id = id;
    this.rootURI = rootURI;
    this.stopped = false;
    this.restoreRequests = new Set();
    this.store = new Store(
      PathUtils.join(Zotero.DataDirectory.dir, "zotero2notion"),
    );
    await this.store.init(rootURI);
    this.store.config.libraryID = Zotero.Libraries.userLibraryID;
    delete this.store.config.collections;
    delete this.store.config.paperTypes;
    this.credentials = new Credentials();
    const removedConnection = await this.credentials.clearUnsupported();
    if (!(await this.credentials.read()) && this.store.config.autoSync) {
      this.store.config.autoSync = false;
      await this.store.saveConfig();
    }
    if (removedConnection)
      this.log("Connect with a personal access token to resume syncing.");
    this.timers = ChromeUtils.importESModule(
      "resource://gre/modules/Timer.sys.mjs",
    );
    this.autosave = new Autosave({
      timers: this.timers,
      isBusy: () => this.running || this.busy,
      onChange: () => this.emit(),
      persist: async (key, value) => {
        if (key.startsWith("template:")) {
          await this.saveTemplate(key.slice(9), value.name, value.markdown);
        } else {
          // Merge only the edited group with the latest config, never a stale UI snapshot.
          await this.saveSettings({
            ...structuredClone(this.store.config),
            ...value,
          });
        }
      },
    });
    const win = Zotero.getMainWindow();
    const fetch = (...args) => Zotero.getMainWindow().fetch(...args);
    this.api = new NotionClient({
      token: async () => {
        const c = await this.credentials.read();
        if (!c) throw new Error("Connect to Notion first.");
        return c.access_token;
      },
      fetch,
      sleep: (ms) => new Promise((resolve) => win.setTimeout(resolve, ms)),
    });
    this.engine = new SyncEngine({
      api: this.api,
      store: this.store,
      readTemplate: (t) => this.store.readTemplate(t),
      readNotes: extractNotes,
      renderNote: (note) => renderZoteroNote(note, this.api),
      log: (m) => this.log(m),
    });
    this.pane = await Zotero.PreferencePanes.register({
      pluginID: id,
      label: "Zotero2Notion",
      src: "content/preferences.xhtml",
      scripts: ["content/preferences.js"],
      stylesheets: ["content/preferences.css"],
    });
    this.observer = Zotero.Notifier.registerObserver(
      { notify: (...args) => this.notify(...args) },
      ["item", "collection-item", "collection", "item-tag"],
      "zotero2notion",
    );
    this.menuIDs = [];
    for (const [suffix, target, label, command] of [
      [
        "sync",
        "main/library/item",
        "z2n-send",
        (ctx) => this.sendItems(ctx.items.map((i) => i.id)),
      ],
      [
        "settings",
        "main/menubar/tools",
        "z2n-settings",
        () => this.openSettings(),
      ],
    ]) {
      const menuID = "z2n-" + suffix;
      Zotero.MenuManager.registerMenu({
        menuID,
        pluginID: id,
        target,
        menus: [
          {
            menuType: "menuitem",
            l10nID: label,
            onCommand: (e, c) =>
              Promise.resolve()
                .then(() => command(c))
                .catch((e) => this.log(e.message, true)),
          },
        ],
      });
      this.menuIDs.push(menuID);
    }
    for (const w of Zotero.getMainWindows()) this.addWindow(w);
    this.dirty = new Set();
    if (this.store.config.autoSync && this.store.state.pending.length)
      this.schedule();
    this.requestSyncActivation();
    this.log("Ready");
  },
  addWindow(w) {
    w.MozXULElement.insertFTLIfNeeded("zotero2notion.ftl");
  },
  removeWindow(w) {
    w.document.querySelector('[href="zotero2notion.ftl"]')?.remove();
  },
  async stop() {
    this.stopped = true;
    this.restoreRequests?.clear();
    this.timers?.clearTimeout(this.activationTimer);
    const w = Zotero.getMainWindow();
    w?.clearTimeout(this.timer);
    w?.clearTimeout(this.retry);
    if (this.observer) Zotero.Notifier.unregisterObserver(this.observer);
    // Zotero unregisters menus and panes on plugin shutdown.
    for (const w of Zotero.getMainWindows()) this.removeWindow(w);
    try {
      await this.autosave?.close();
    } catch (error) {
      this.log("Settings not saved: " + error.message, true);
    }
    this.listeners.clear();
    await this.store.writes;
  },
  openSettings() {
    return Zotero.Utilities.Internal.openPreferences(this.pane);
  },
  log(message, error = false) {
    this.logs.unshift({
      time: new Date().toLocaleTimeString(),
      message,
      error,
    });
    this.logs = this.logs.slice(0, 100);
    Zotero.debug("[Zotero2Notion] " + message);
    this.emit();
  },
  emit() {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        this.listeners.delete(fn);
      }
    }
  },
  async notify(event, type, ids) {
    if (
      this.stopped ||
      !this.store.config.autoSync ||
      !["add", "modify", "remove"].includes(event)
    )
      return;
    try {
      if (type === "collection") {
        await this.queueScope();
        return;
      }
      let itemIDs =
        type === "item"
          ? ids
          : ids.map((id) =>
              Number(String(id).split("-")[type === "collection-item" ? 1 : 0]),
            );
      const items = await Zotero.Items.getAsync(itemIDs);
      itemIDs = [];
      for (let item of items.filter(Boolean)) {
        // An embedded image belongs to a note, which belongs to the paper.
        while (item.parentID) item = await Zotero.Items.getAsync(item.parentID);
        itemIDs.push(item.id);
      }
      await this.enqueue(itemIDs);
    } catch (e) {
      this.log(e.message, true);
    }
  },
  requestSyncActivation(forceScan = false, delay = 500) {
    if (this.stopped) return;
    this.forceScan = this.forceScan || forceScan;
    this.timers.clearTimeout(this.activationTimer);
    this.activationTimer = this.timers.setTimeout(async () => {
      if (this.running || this.busy) {
        this.requestSyncActivation();
        return;
      }
      try {
        await this.activateSync();
        this.activationAttempts = 0;
      } catch (error) {
        this.log(error.message, true);
        this.activationAttempts = (this.activationAttempts || 0) + 1;
        if (this.activationAttempts <= 3)
          this.requestSyncActivation(
            false,
            [5000, 15000, 45000][this.activationAttempts - 1],
          );
      }
    }, delay);
  },
  async activateSync() {
    const ready = await this.exclusive(async () => {
      const config = this.store.config;
      if (!config.dataSourceID || !(await this.credentials.read()))
        return false;
      const schema = (await this.api.schema(config.dataSourceID)).properties;
      const check = inspectSchema(schema, config.mapping);
      const ready = !check.missing.length && !check.conflicts.length;
      const previous = config.autoSync;
      if (previous !== ready) {
        config.autoSync = ready;
        try {
          await this.store.saveConfig();
        } catch (error) {
          config.autoSync = previous;
          throw error;
        }
      }
      if (!ready) {
        Zotero.getMainWindow().clearTimeout(this.timer);
        Zotero.getMainWindow().clearTimeout(this.retry);
        this.emit();
        return false;
      }
      const source = config.dataSourceID;
      if (this.forceScan || !this.store.state.initializedSources?.[source]) {
        // Hold the configuration lock until the scan and its durable queue commit.
        // Item notifications wait for this lock, so changes during the scan are retained.
        const items = await Zotero.Items.getAll(
          Number(config.libraryID),
          true,
          false,
        );
        if (this.stopped) return false;
        const ids = items.filter((i) => inScope(i, config)).map((i) => i.id);
        const state = this.store.state;
        const previousPending = state.pending;
        const previousSources = state.initializedSources;
        state.pending = [...new Set([...state.pending, ...ids])];
        state.initializedSources = { ...previousSources, [source]: true };
        try {
          await this.store.saveState();
        } catch (error) {
          state.pending = previousPending;
          state.initializedSources = previousSources;
          throw error;
        }
        this.forceScan = false;
        this.log("Initial library sync queued");
      }
      this.emit();
      return true;
    });
    if (ready && !this.stopped && this.store.state.pending.length)
      this.schedule();
  },
  schedule() {
    const w = Zotero.getMainWindow();
    w.clearTimeout(this.timer);
    this.timer = w.setTimeout(() => this.drain(), 1200);
  },
  async sendItems(ids) {
    await this.autosave.flush();
    return this.enqueue(ids, true, this.store.config.dataSourceID, { restoreTrashed: true });
  },
  async enqueue(ids, manual = false, source = this.store.config.dataSourceID, { restoreTrashed = false } = {}) {
    // Item changes may arrive while an automatic settings save is in progress.
    while (this.busy && !this.stopped)
      await new Promise((resolve) => this.timers.setTimeout(resolve, 25));
    if (this.stopped || (!manual && !this.store.config.autoSync)) return;
    const items = await Zotero.Items.getAsync(ids);
    if (source !== this.store.config.dataSourceID || this.stopped) return;
    const valid = items
      .filter((i) => i && inScope(i, this.store.config))
      .map((i) => i.id);
    // Only an explicit Send to Notion grants one restore attempt per selected item.
    // Keep it in memory and scoped to the destination, never in the retry queue.
    if (restoreTrashed)
      for (const id of valid) this.restoreRequests.add(`${source}:${id}`);
    if (this.currentID && valid.includes(this.currentID))
      this.dirty.add(this.currentID);
    this.store.state.pending = [
      ...new Set([...this.store.state.pending, ...valid]),
    ];
    await this.store.saveState();
    if (manual && !valid.length)
      this.log("Select a bibliographic item in My Library.", true);
    this.attempts = 0;
    this.schedule();
  },
  async queueScope() {
    const source = this.store.config.dataSourceID;
    const items = await Zotero.Items.getAll(
      Number(this.store.config.libraryID),
      true,
      false,
    );
    await this.enqueue(
      items.map((i) => i.id),
      true,
      source,
    );
  },
  async drain() {
    if (this.running || this.stopped) return;
    if (this.busy) {
      this.schedule();
      return;
    }
    this.running = true;
    const context = {};
    let failed = [];
    const config = structuredClone(this.store.config);
    try {
      while (this.store.state.pending.length && !this.stopped) {
        const id = this.store.state.pending[0];
        this.currentID = id;
        const restoreTrashed = this.restoreRequests?.delete(`${config.dataSourceID}:${id}`) || false;
        try {
          const item = await Zotero.Items.getAsync(id);
          if (item && inScope(item, config)) {
            this.log(`Syncing · ${item.getDisplayTitle()}`);
            await this.engine.run(
              await extractItem(item, config.citationStyle),
              config,
              context,
              { restoreTrashed },
            );
          }
        } catch (e) {
          failed.push(id);
          this.log(e.message, true);
        }
        this.store.state.pending = this.store.state.pending.filter(
          (x) => x !== id,
        );
        if (this.dirty.delete(id)) this.store.state.pending.push(id);
        this.currentID = null;
        await this.store.saveState();
      }
    } finally {
      this.store.state.pending = [
        ...new Set([...this.store.state.pending, ...failed]),
      ];
      await this.store.saveState();
      this.running = false;
      if (failed.length && ++this.attempts <= 3 && !this.stopped) {
        this.retry = Zotero.getMainWindow().setTimeout(
          () => this.drain(),
          [5000, 15000, 45000][this.attempts - 1],
        );
      }
      this.log(
        failed.length
          ? `${failed.length} items failed. Check Status and recovery.`
          : "Sync complete",
        !!failed.length,
      );
    }
  },
  async exclusive(fn) {
    if (this.running || this.busy)
      throw new Error(
        "Wait for the current sync to finish before changing settings.",
      );
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  },
  async connectToken(token) {
    return this.exclusive(async () => {
      token = token.trim();
      if (!token) throw new Error("Enter your Notion personal access token.");
      const check = new NotionClient({
        token: async () => token,
        fetch: (...a) => Zotero.getMainWindow().fetch(...a),
      });
      const me = await check.me();
      if (!me.id || me.bot?.owner?.type !== "user")
        throw new Error(
          "Use a personal access token with the Notion API capability. Create one with Get token.",
        );
      const old = await this.credentials.read();
      await this.credentials.save({
        access_token: token,
        mode: "token",
        rootPages: true,
        workspace_name: me.bot?.workspace_name || me.name || "Notion",
      });
      if (old?.access_token !== token) {
        this.store.config.dataSourceID = "";
        this.store.config.databaseName = "";
        this.store.config.autoSync = false;
        this.store.state.pending = [];
        this.restoreRequests?.clear();
        await this.store.saveConfig();
        await this.store.saveState();
      }
      this.requestSyncActivation();
      this.log("Connected to Notion");
    });
  },
  async disconnect() {
    return this.exclusive(async () => {
      await this.credentials.clear();
      this.store.config.autoSync = false;
      this.store.state.pending = [];
      this.restoreRequests?.clear();
      await this.store.saveState();
      await this.store.saveConfig();
      this.timers.clearTimeout(this.activationTimer);
      this.log("Disconnected from Notion");
    });
  },
  async sources() {
    return (await this.api.sources()).map((s) => ({
      id: s.id,
      name:
        s.title?.map((t) => t.plain_text ?? t.text?.content ?? "").join("") ||
        "Untitled database",
    }));
  },
  async chooseSource(id, name) {
    return this.exclusive(async () => {
      const data = await this.api.schema(id);
      const config = this.store.config;
      config.dataSourceID = id;
      config.databaseName = name;
      config.autoSync = false;
      this.store.state.pending = [];
      this.restoreRequests?.clear();
      const title = Object.entries(data.properties).find(
        ([, p]) => p.type === "title",
      )?.[0];
      if (title) config.mapping["Journal Name"] = title;
      await this.store.saveConfig();
      await this.store.saveState();
      this.requestSyncActivation(true);
      return inspectSchema(data.properties, config.mapping);
    });
  },
  async newDatabase() {
    return this.exclusive(async () => {
      const destination = await new DatabaseSetup(this.api, this.store).run();
      const previous = this.store.config;
      const changed =
        previous.dataSourceID !== destination.id ||
        JSON.stringify(previous.mapping) !==
          JSON.stringify(destination.mapping);
      this.store.config = {
        ...previous,
        dataSourceID: destination.id,
        databaseName: destination.name,
        mapping: destination.mapping,
        autoSync: changed ? false : previous.autoSync,
      };
      try {
        await this.store.saveConfig();
      } catch (error) {
        this.store.config = previous;
        throw error;
      }
      // Preserve queued item IDs; the initial scan merges them for the new destination.
      if (changed) this.restoreRequests?.clear();
      this.requestSyncActivation(changed);
      this.log("JournalDB connected. Automatic sync will start shortly.");
      return destination;
    });
  },
  async incompleteDatabase() {
    const c = await this.credentials.read();
    if (!c || c.rootPages === false) return "";
    return this.exclusive(() =>
      new DatabaseSetup(this.api, this.store).incomplete(),
    );
  },
  async recoverDatabase(url) {
    return this.exclusive(() =>
      new DatabaseSetup(this.api, this.store).recover(url),
    );
  },
  async schemaCheck() {
    if (!this.store.config.dataSourceID)
      throw new Error("Choose a database first.");
    const d = await this.api.schema(this.store.config.dataSourceID);
    this.requestSyncActivation();
    return inspectSchema(d.properties, this.store.config.mapping);
  },
  schemaMessage: schemaCheckMessage,
  async addMissing() {
    return this.exclusive(async () => {
      const c = await this.schemaCheck();
      if (c.conflicts.length) throw new Error(c.conflicts.join("\n"));
      if (c.missing.length)
        await this.api.addProperties(
          this.store.config.dataSourceID,
          missingSchemaProperties(c.missing),
        );
      return this.schemaCheck();
    });
  },
  async settings() {
    const credentials = await this.credentials.read();
    return {
      config: structuredClone(this.store.config),
      connected: !!credentials,
      canCreateDatabase: !!credentials && credentials.rootPages !== false,
      connection: credentials?.workspace_name || "",
      collections: allCollections().filter(
        (c) => c.libraryID === Zotero.Libraries.userLibraryID,
      ),
      fields: Object.keys(TYPES),
      logs: this.logs,
    };
  },
  async saveSettings(config) {
    return this.exclusive(async () => {
      if (!config.templates.some((t) => t.id === config.defaultTemplate))
        throw new Error("Choose a default template.");
      for (const r of config.rules) {
        if (
          r.enabled !== false &&
          (!r.value || !config.templates.some((t) => t.id === r.templateID))
        )
          throw new Error(
            "Select both a condition and a template for each rule.",
          );
      }
      if (!Zotero.Styles.get(config.citationStyle))
        throw new Error(
          "Enter the ID of a citation style installed in Zotero.",
        );
      const previous = this.store.config;
      const mappingChanged =
        JSON.stringify(previous.mapping) !== JSON.stringify(config.mapping);
      // Persist mapping edits locally, then check readiness. Missing fields can
      // subsequently be added from the UI without an autosave validation deadlock.
      if (mappingChanged) config.autoSync = false;
      this.store.config = config;
      try {
        await this.store.saveConfig();
      } catch (error) {
        this.store.config = previous;
        throw error;
      }
      if (!config.autoSync && previous.autoSync) {
        const w = Zotero.getMainWindow();
        w?.clearTimeout(this.timer);
        w?.clearTimeout(this.retry);
      }
      if (mappingChanged) this.requestSyncActivation(true);
      this.log("Settings saved");
    });
  },
  async saveTemplate(id, name, markdown) {
    return this.exclusive(async () => {
      name = name.trim() || "Untitled";
      const t = this.store.config.templates.find((t) => t.id === id);
      if (!t) throw new Error("Template not found.");
      await this.store.saveTemplate(t, markdown);
      const previousName = t.name;
      t.name = name;
      try {
        await this.store.saveConfig();
      } catch (error) {
        t.name = previousName;
        throw error;
      }
    });
  },
  async createTemplate(name, markdown) {
    return this.exclusive(async () => {
      const id = "template-" + Zotero.getMainWindow().crypto.randomUUID();
      const t = { id, name: name.trim() || "New template", file: id + ".md" };
      await this.store.saveTemplate(t, markdown);
      this.store.config.templates.push(t);
      await this.store.saveConfig();
      return id;
    });
  },
  async deleteTemplate(id) {
    return this.exclusive(async () => {
      const c = this.store.config;
      if (c.defaultTemplate === id || c.rules.some((r) => r.templateID === id))
        throw new Error(
          "This template is used as the default or by a rule. Change those assignments first.",
        );
      c.templates = c.templates.filter((t) => t.id !== id);
      await this.store.saveConfig(); /* Keep Markdown on disk for recovery. */
    });
  },
  async templateText(id) {
    const t = this.store.config.templates.find((t) => t.id === id);
    if (!t) throw new Error("Template not found.");
    return this.store.readTemplate(t);
  },
  async preview(markdown) {
    const placement = notesPlacement(markdown);
    const render = (values, notes = "") => placement
      ? renderTemplate(placement.before, values) + notes + "\n" + renderTemplate(placement.after, values)
      : renderTemplate(markdown, values);
    const item = Zotero.getActiveZoteroPane()
      ?.getSelectedItems()
      .find((i) => i.isRegularItem());
    if (!item) {
      return render({
        "Journal Name": "Paper title",
        Authors: "First Author; Second Author",
        Year: 2026,
        "Paper URL": "https://example.org/paper",
      }, "<details>\n<summary>Zotero Notes</summary>\n\t<details>\n\t<summary>Example note</summary>\n\t\tNotes attached to this paper appear here.\n\t</details>\n</details>");
    }
    const values = (await extractItem(item, this.store.config.citationStyle)).values;
    if (placement) {
      const notes = await extractNotes(item);
      const content = [];
      for (const note of notes) content.push(wrapNote(note, (await renderZoteroNote(note, this.api, true)).markdown));
      return render(values, content.length ? wrapNotes({ values }, content) : "");
    }
    return render(values);
  },
  async unresolved() {
    return Object.entries(this.store.state.records)
      .filter(([, r]) => (r.creating && !r.pageID) || r.notes?.pending || r.notes?.conflict)
      .map(([key]) => key);
  },
  isNotesRecovery(key) {
    const notes = this.store.state.records[key]?.notes;
    return !!(notes?.pending || notes?.conflict);
  },
  async resolveUncertain(key) {
    return this.exclusive(async () => {
      const prefix = this.store.config.dataSourceID + ":";
      if (!key.startsWith(prefix))
        throw new Error("Select the database for this record first.");
      if (this.isNotesRecovery(key)) {
        const [library, itemKey] = key.slice(prefix.length).split(":");
        const item = Zotero.Items.getByLibraryAndKey(Number(library), itemKey);
        if (!item) throw new Error("The Zotero item is no longer available.");
        await this.engine.notes.acceptCurrent(await extractItem(item, this.store.config.citationStyle), this.store.state.records[key]);
        return;
      }
      const rows = await this.api.rows(this.store.config.dataSourceID);
      const sourceKey = key.slice(prefix.length);
      const page = rows.find(
        (p) =>
          decodePage(p, this.store.config.mapping)["Zotero Key"] === sourceKey,
      );
      if (page)
        this.store.state.records[key] = { pageID: page.id, creating: false };
      else delete this.store.state.records[key];
      await this.store.saveState();
    });
  },
};
Zotero.Zotero2Notion = app;
