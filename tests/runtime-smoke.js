// Development only. Inject into a temporary build in the isolated profile; never bundle.
(async () => {
  const output = { version: "0.1.3", checks: [], errors: [] };
  try {
    if (
      !["/tmp/z2n-test-data", "/private/tmp/z2n-test-data"].includes(
        Zotero.DataDirectory.dir,
      )
    )
      throw Error("Runtime tests require the isolated test data directory");
    const app = Zotero.Zotero2Notion,
      main = Zotero.getMainWindow();
    const sleep = (ms) => new Promise((r) => main.setTimeout(r, ms));
    const until = async (fn, label) => {
      for (let i = 0; i < 120; i++) {
        if (await fn()) return;
        await sleep(100);
      }
      throw Error("Timed out: " + label);
    };
    const check = (ok, name) => {
      if (!ok) throw Error(name);
      output.checks.push(name);
    };
    const stage = (text) => IOUtils.writeUTF8("/tmp/z2n-stage.txt", text);
    app.timers.clearTimeout(app.activationTimer);
    main.clearTimeout(app.timer);
    main.clearTimeout(app.retry);
    app.store.config.autoSync = false;
    app.store.config.dataSourceID = "";
    app.store.config.databaseName = "";
    app.store.config.rules = [];
    app.store.config.defaultTemplate = "paper-review-en";
    app.store.config.citationStyle = "http://www.zotero.org/styles/apa";
    app.store.state = { version: 1, records: {}, pending: [] };
    await app.credentials.clear();
    app.api.fetch = async () => {
      throw Error("External network is disabled in this test");
    };
    await app.store.saveConfig();
    await app.store.saveState();
    const originalTemplate = await app.templateText("paper-review-en");
    const openPrefs = async () => {
      for (const w of Services.wm.getEnumerator(null))
        if (w.location?.href?.includes("/preferences/preferences.xhtml"))
          w.close();
      await sleep(650);
      app.openSettings();
      let pref;
      await until(() => {
        pref = [...Services.wm.getEnumerator(null)].find((w) =>
          w.document.getElementById("z2n-root"),
        );
        return (
          pref?.document.getElementById("z2n-template")?.options.length &&
          pref.document.getElementById("z2n-markdown").value
        );
      }, "preferences initialized");
      return pref;
    };
    await stage("opening preferences");
    let pref = await openPrefs();
    const el = (id) => pref.document.getElementById("z2n-" + id);
    const input = (id, value, event = "input") => {
      const e = el(id);
      e.value = value;
      e.dispatchEvent(new pref.Event(event, { bubbles: true }));
    };
    check(
      ![...pref.document.querySelectorAll("#z2n-root button")].some(
        (b) => b.textContent.trim() === "Save",
      ),
      "No Save buttons",
    );
    check(
      !el("sync-heading") && !el("auto") && !el("library") && !el("scope"),
      "No sync scope or auto-toggle controls",
    );
    check(
      !el("rule-options").open && !el("advanced").open,
      "Rules and recovery collapsed by default",
    );
    const md =
      "# [title]\n[authors]\n$`\\alpha`$\n$$\n\\beta+\\gamma\n$$\n```js\nconst value = 1;\n```\n";
    input("markdown", md);
    el("markdown").setSelectionRange(7, 7);
    await until(() => app.autosave.status().state === "saved", "debounce save");
    check(
      (await app.templateText("paper-review-en")) === md,
      "Markdown, LaTeX and fences saved exactly",
    );
    check(
      el("markdown").selectionStart === 7,
      "Autosave preserves editor caret",
    );
    input("markdown", md + "\nClosing immediately");
    pref.close();
    await until(
      () => app.autosave.status().state === "saved",
      "save after window close",
    );
    check(
      (await app.templateText("paper-review-en")).endsWith("Closing immediately"),
      "Closing settings retains pending input",
    );
    pref = await openPrefs();
    app.busy = true;
    input("markdown", md + "\nQueued while syncing");
    pref.close();
    pref = await openPrefs();
    check(
      el("markdown").value.endsWith("Queued while syncing"),
      "Reopened editor restores queued draft",
    );
    check(
      app.autosave.status().state === "pending",
      "Busy sync defers settings writes",
    );
    app.busy = false;
    await until(() => app.autosave.status().state === "saved", "deferred save");
    check(
      (await app.templateText("paper-review-en")).endsWith("Queued while syncing"),
      "Deferred settings eventually save",
    );
    input("citation", "invalid-style");
    await until(
      () => app.autosave.status().state === "error",
      "validation error",
    );
    check(
      !el("autosave-retry").hidden &&
        app.store.config.citationStyle.endsWith("/apa"),
      "Invalid settings show error and keep last valid value",
    );
    input("citation", "http://www.zotero.org/styles/apa");
    await until(
      () => app.autosave.status().state === "saved",
      "corrected setting",
    );
    el("rule-options").open = true;
    el("rule-add").click();
    await until(
      () =>
        app.autosave.status().state === "saved" &&
        app.store.config.rules.length === 1,
      "draft rule",
    );
    check(
      app.store.config.rules[0].enabled === false,
      "Incomplete rule autosaves inactive",
    );
    input("rule-kind-0", "tag", "change");
    input("rule-value-0", "runtime-tag");
    await until(() => app.autosave.status().state === "saved", "tag rule");
    check(
      app.store.config.rules[0].enabled &&
        app.store.config.rules[0].value === "runtime-tag",
      "Completed tag rule autosaves active",
    );
    input("markdown", md);
    await app.autosave.flush();
    el("preview").click();
    await until(() => !el("preview-text").hidden, "preview");
    check(
      el("preview-text").textContent.includes("\\alpha"),
      "Preview preserves LaTeX",
    );
    await stage("automatic initial sync");
    const stamp = Date.now();
    const makeItem = async (title, type = "journalArticle") => {
      const item = new Zotero.Item(type);
      item.libraryID = Zotero.Libraries.userLibraryID;
      item.setField("title", title + " " + stamp);
      item.setField("date", "2026");
      item.setCreators([
        { firstName: "Test", lastName: "Author", creatorType: "author" },
      ]);
      await item.saveTx();
      return item;
    };
    const first = await makeItem("Initial journal"),
      second = await makeItem("Initial book", "book");
    const properties = {};
    for (const [key, name] of Object.entries(app.store.config.mapping)) {
      if (!name) continue;
      const type =
        key === "Journal Name"
          ? "title"
          : ["Paper URL", "Zotero URI"].includes(key)
            ? "url"
            : key === "Year"
              ? "number"
              : ["Date Added", "Date Modified"].includes(key)
                ? "date"
                : ["Tags", "Collections"].includes(key)
                  ? "multi_select"
                  : ["Status", "Project", "Item Type"].includes(key)
                    ? "select"
                    : "rich_text";
      properties[name] = { type, [type]: {} };
    }
    const authors = properties[app.store.config.mapping.Authors];
    delete properties[app.store.config.mapping.Authors];
    const pages = [],
      bodies = new Map();
    let updates = 0,
      scans = 0;
    app.api.schema = async () => ({ properties });
    app.api.addProperties = async () => {
      properties[app.store.config.mapping.Authors] = authors;
    };
    app.api.rows = async () => structuredClone(pages);
    app.api.create = async (id, props) => {
      const page = {
        id: "mock-page-" + pages.length,
        parent: { data_source_id: id },
        url: "https://example.org/mock",
        properties: {},
      };
      for (const [k, v] of Object.entries(props))
        page.properties[k] = { type: Object.keys(v)[0], ...v };
      pages.push(page);
      return structuredClone(page);
    };
    app.api.page = async (id) =>
      structuredClone(pages.find((p) => p.id === id));
    app.api.update = async (id, props) => {
      updates++;
      const p = pages.find((p) => p.id === id);
      for (const [k, v] of Object.entries(props))
        p.properties[k] = { type: Object.keys(v)[0], ...v };
      return structuredClone(p);
    };
    app.api.markdown = async (id) => ({ markdown: bodies.get(id) || "" });
    app.api.appendMarkdown = async (id, text) =>
      bodies.set(id, (bodies.get(id) || "") + text);
    await app.credentials.save({
      access_token: "runtime-test-only",
      mode: "token",
      workspace_name: "Runtime test",
    });
    const getAll = Zotero.Items.getAll;
    Zotero.Items.getAll = async () => {
      scans++;
      return [first, second];
    };
    await app.chooseSource("mock-runtime-db", "Runtime test");
    await sleep(800);
    check(
      !app.store.config.autoSync && pages.length === 0,
      "Missing database properties prevent automatic writes",
    );
    await app.addMissing();
    await until(
      () =>
        pages.length === 2 &&
        !app.running &&
        app.store.state.pending.length === 0,
      "initial sync",
    );
    check(
      scans === 1 && app.store.config.autoSync,
      "Ready database automatically syncs existing library once",
    );
    check(bodies.size === 2, "Initial pages receive template");
    await app.activateSync();
    check(
      scans === 1 && app.store.state.pending.length === 0,
      "Readiness recheck does not repeat initial scan",
    );
    Zotero.Items.getAll = getAll;
    const third = await makeItem("Automatically added paper");
    await until(
      () => pages.length === 3 && !app.running,
      "new item automatic sync",
    );
    check(pages.length === 3, "New Zotero item syncs without a button");
    const originalBodies = JSON.stringify([...bodies]);
    first.setField("abstractNote", "Automatically updated abstract");
    await first.saveTx();
    await until(
      () => updates > 0 && !app.running,
      "changed item automatic sync",
    );
    check(
      pages.some(
        (p) =>
          p.properties[app.store.config.mapping.Abstract]?.rich_text?.[0]?.text
            .content === "Automatically updated abstract",
      ),
      "Changed metadata syncs automatically",
    );
    check(
      JSON.stringify([...bodies]) === originalBodies,
      "Metadata updates preserve existing page bodies",
    );
    output.mockPages = pages.length;
    output.initialScans = scans;
    app.timers.clearTimeout(app.activationTimer);
    main.clearTimeout(app.timer);
    main.clearTimeout(app.retry);
    app.store.config.autoSync = false;
    app.store.config.dataSourceID = "";
    app.store.config.rules = [];
    await app.credentials.clear();
    await app.store.saveConfig();
    await app.store.saveState();
    check(!(await app.credentials.read()), "Test credentials removed");
    await app.saveTemplate("paper-review-en", "Paper review", originalTemplate);
    pref = await openPrefs();
    const screenshot = async (name, target) => {
      target.scrollIntoView({ behavior: "instant", block: "start" });
      await sleep(150);
      const canvas = pref.document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "canvas",
      );
      canvas.width = pref.innerWidth;
      canvas.height = pref.innerHeight;
      const bitmap =
        await pref.browsingContext.currentWindowGlobal.drawSnapshot(
          new pref.DOMRect(0, 0, pref.innerWidth, pref.innerHeight),
          1,
          "rgb(255,255,255)",
        );
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      bitmap.close();
      const bytes = Uint8Array.from(
        pref.atob(canvas.toDataURL("image/png").split(",")[1]),
        (c) => c.charCodeAt(0),
      );
      await IOUtils.write("/tmp/" + name + ".png", bytes);
    };
    await screenshot(
      "z2n-013-top",
      el("root").closest(".pane-container") || el("root"),
    );
    await screenshot("z2n-013-template", el("template-heading"));
    output.layout = [...pref.document.querySelectorAll("#z2n-root button")]
      .filter((b) => b.getBoundingClientRect().width)
      .map((b) => {
        const r = b.getBoundingClientRect(),
          style = pref.getComputedStyle(b);
        return {
          label: b.textContent.trim(),
          width: r.width,
          height: r.height,
          fontSize: style.fontSize,
        };
      });
    output.logs = app.logs.slice(0, 12);
    await stage("complete");
  } catch (error) {
    output.errors.push(String(error) + "\n" + error.stack);
  }
  await IOUtils.writeUTF8(
    "/tmp/z2n-runtime-result.json",
    JSON.stringify(output, null, 2),
  );
})();
