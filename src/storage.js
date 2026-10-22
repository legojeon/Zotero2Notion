import { BUILTIN_TEMPLATES, initialConfig } from "./model.js";
export class Store {
  constructor(root) {
    this.root = root;
    this.config = initialConfig();
    this.state = { version: 1, records: {}, pending: [] };
    this.writes = Promise.resolve();
  }
  path(name) {
    return PathUtils.join(this.root, ...name.split("/"));
  }
  async init(rootURI) {
    await IOUtils.makeDirectory(this.root, { ignoreExisting: true });
    await IOUtils.makeDirectory(this.path("templates"), {
      ignoreExisting: true,
    });
    for (const [file, key] of [
      ["settings.json", "config"],
      ["state.json", "state"],
    ]) {
      if (await IOUtils.exists(this.path(file)))
        this[key] = JSON.parse(await IOUtils.readUTF8(this.path(file)));
    }
    if (this.config.version !== 1 || this.state.version !== 1)
      throw new Error("This settings file version is not supported.");
    // Remember which built-ins have been offered so deleting one is respected.
    const seen = new Set(this.config.bundledTemplates || ["paper-review"]);
    let changed = !this.config.bundledTemplates;
    if (Object.hasOwn(this.config, "oauthService")) {
      delete this.config.oauthService;
      changed = true;
    }
    for (const template of BUILTIN_TEMPLATES) {
      let registered = this.config.templates.find((t) => t.id === template.id);
      if (!registered && !seen.has(template.id)) {
        registered = { ...template };
        this.config.templates.push(registered);
        changed = true;
      }
      if (!seen.has(template.id)) changed = true;
      seen.add(template.id);
      // Never overwrite customized names, paths, or existing Markdown files.
      if (registered?.file === template.file) {
        const file = this.templatePath(registered);
        if (!(await IOUtils.exists(file)))
          await IOUtils.writeUTF8(
            file,
            // Installed addons use jar: URLs; the path reader routes these
            // through HTTP and fails before the preferences pane is registered.
            await Zotero.File.getResourceAsync(
              rootURI + "templates/" + template.file,
            ),
            { tmpPath: file + ".tmp" },
          );
      }
    }
    this.config.bundledTemplates = [...seen];
    if (await this.migrateTemplates(rootURI)) changed = true;
    if (changed) await this.saveConfig();
  }

  async migrateTemplates(rootURI) {
    let changed = false;
    for (const builtin of BUILTIN_TEMPLATES) {
      const template = this.config.templates.find((t) => t.id === builtin.id);
      if (
        template?.file === builtin.file &&
        template.name === `${builtin.name} (English)`
      ) {
        template.name = builtin.name;
        changed = true;
      }
    }
    if (!this.config.notesTemplateRevision) {
      // Upgrade only exact shipped v0.1.11 outlines. Custom templates are opt-in.
      const previousHashes = {
        "paper-review-en.md": "49cd22c9a7b00069bc6863a43025b133cc130e98d859d386c051b19fb23c927f",
        "section-summary-en.md": "d6b84b861a566bfe74b751ba608827710525bf93bc1aa0af65eef3febcf7ebb7",
      };
      for (const builtin of BUILTIN_TEMPLATES) {
        const template = this.config.templates.find((t) => t.id === builtin.id);
        if (template?.file !== builtin.file || !(await IOUtils.exists(this.templatePath(template)))) continue;
        const bytes = new TextEncoder().encode(await this.readTemplate(template));
        const digest = await Zotero.getMainWindow().crypto.subtle.digest("SHA-256", bytes);
        const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
        if (hash === previousHashes[builtin.file]) {
          await this.saveTemplate(template, await Zotero.File.getResourceAsync(rootURI + "templates/" + builtin.file));
        }
      }
      this.config.notesTemplateRevision = 1;
      changed = true;
    }
    const legacy = this.config.templates.find((t) => t.id === "paper-review");
    if (legacy?.name !== "Paper review" || legacy.file !== "paper-review.md")
      return changed;
    if (await IOUtils.exists(this.templatePath(legacy))) {
      // Only retire the exact v0.1.0–0.1.6 default. Preserve all user edits.
      const digest = await Zotero.getMainWindow().crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(await this.readTemplate(legacy)),
      );
      const hash = Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      if (
        hash !==
        "cafe3b56ae9f78ab7ffc03d6024c59880a025908d76f34f3e9e327f3785b89f1"
      )
        return changed;
    }
    const replacement = BUILTIN_TEMPLATES.find(
      (t) => t.id === "paper-review-en",
    );
    if (!this.config.templates.some((t) => t.id === replacement.id)) {
      // A retired template still needs a valid replacement, even if its
      // English counterpart was previously removed from the list.
      const file = this.templatePath(replacement);
      if (!(await IOUtils.exists(file)))
        await IOUtils.writeUTF8(
          file,
          await Zotero.File.getResourceAsync(
            rootURI + "templates/" + replacement.file,
          ),
          { tmpPath: file + ".tmp" },
        );
      this.config.templates.push({ ...replacement });
    }
    this.config.templates = this.config.templates.filter((t) => t !== legacy);
    if (this.config.defaultTemplate === legacy.id)
      this.config.defaultTemplate = replacement.id;
    for (const rule of this.config.rules)
      if (rule.templateID === legacy.id) rule.templateID = replacement.id;
    // Keep the retired Markdown file on disk for recovery, like manual deletion.
    return true;
  }

  write(file, data) {
    const text = JSON.stringify(data, null, 2);
    const op = this.writes.then(() =>
      IOUtils.writeUTF8(this.path(file), text, {
        tmpPath: this.path(file) + ".tmp",
      }),
    );
    this.writes = op.catch(() => {});
    return op;
  }
  saveConfig() {
    return this.write("settings.json", this.config);
  }
  saveState() {
    return this.write("state.json", this.state);
  }
  templatePath(t) {
    if (!/^[a-zA-Z0-9_-]+\.md$/.test(t.file))
      throw new Error("The template file name is not valid.");
    return this.path("templates/" + t.file);
  }
  readTemplate(t) {
    return IOUtils.readUTF8(this.templatePath(t));
  }
  async saveTemplate(t, text) {
    if (typeof text !== "string")
      throw new Error("Template content must be text.");
    const path = this.templatePath(t);
    await IOUtils.writeUTF8(path, text, { tmpPath: path + ".tmp" });
  }
}
const REALM = "zotero2notion/connection";
const isPersonalToken = (value) =>
  value?.mode === "token" &&
  value.rootPages !== false &&
  typeof value.access_token === "string" &&
  !!value.access_token;
export class Credentials {
  async find() {
    return (
      await Services.logins.searchLoginsAsync({
        origin: "https://api.notion.com",
        httpRealm: REALM,
      })
    )[0];
  }
  async read() {
    const login = await this.find();
    const value = login ? JSON.parse(login.password) : null;
    return isPersonalToken(value) ? value : null;
  }
  async clearUnsupported() {
    const login = await this.find();
    if (!login || isPersonalToken(JSON.parse(login.password))) return false;
    Services.logins.removeLogin(login);
    return true;
  }
  async save(value) {
    const C = Components.Constructor(
      "@mozilla.org/login-manager/loginInfo;1",
      Components.interfaces.nsILoginInfo,
      "init",
    );
    const login = new C(
      "https://api.notion.com",
      null,
      REALM,
      "zotero2notion",
      JSON.stringify(value),
    );
    const existing = await this.find();
    if (existing) Services.logins.modifyLogin(existing, login);
    else await Services.logins.addLoginAsync(login);
  }
  async clear() {
    const login = await this.find();
    if (login) Services.logins.removeLogin(login);
  }
}
