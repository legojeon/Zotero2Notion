// Run only through the temporary addon in the isolated Zotero test profile.
(async () => {
  const out = { version: "0.1.9", checks: [], errors: [], liveNotion: false };
  let restore;
  try {
    if (
      !["/tmp/z2n-test-data", "/private/tmp/z2n-test-data"].includes(
        Zotero.DataDirectory.dir,
      )
    )
      throw Error("Isolated profile required");
    const app = Zotero.Zotero2Notion,
      win = Zotero.getMainWindow();
    const sleep = (ms) => new Promise((r) => win.setTimeout(r, ms));
    if (app.store.config.dataSourceID)
      throw Error("Test profile must have no destination database");
    app.timers.clearTimeout(app.activationTimer);
    const original = {
      config: structuredClone(app.store.config),
      state: structuredClone(app.store.state),
      credential: await app.credentials.read(),
      fetch: win.fetch,
      activate: app.requestSyncActivation,
      schedule: app.schedule,
    };
    restore = async () => {
      app.requestSyncActivation = original.activate;
      app.schedule = original.schedule;
      app.timers.clearTimeout(app.activationTimer);
      win.clearTimeout(app.timer);
      win.clearTimeout(app.retry);
      app.store.config = original.config;
      app.store.state = original.state;
      await app.store.saveConfig();
      await app.store.saveState();
      if (original.credential) await app.credentials.save(original.credential);
      else await app.credentials.clear();
      win.fetch = original.fetch;
    };
    app.requestSyncActivation = function (force) {
      this.forceScan ||= force;
    };
    app.schedule = () => {};
    const mode = "pat";
    let writes, page, database, schema;
    const PAGE = "11111111-1111-4111-8111-111111111111";
    const DB = "22222222-2222-4222-8222-222222222222";
    const SOURCE = "33333333-3333-4333-8333-333333333333";
    const response = (data, status = 200) =>
      new win.Response(JSON.stringify(data), { status });
    win.fetch = async (url, options) => {
      if (!url.startsWith("https://api.notion.com/v1/"))
        throw Error("Unexpected network request");
      const path = url.replace("https://api.notion.com/v1", "");
      const body = options.body && JSON.parse(options.body);
      if (path === "/search")
        return response({
          results: database
            ? [{ id: SOURCE, title: [{ plain_text: "JournalDB" }] }]
            : [],
          has_more: false,
        });
      if (path === "/users/me")
        return response({
          id: mode + "-bot",
          name: "Isolated test",
          bot: {
            workspace_name: "Isolated test",
            workspace_id: "test-workspace",
            owner: { type: "user", user: { id: "test-owner" } },
          },
        });
      if (options.method === "POST" && path === "/pages") {
        if (!body.parent.workspace) throw Error("Expected workspace parent");
        writes.push(path);
        page = { id: PAGE, ...body };
        return response(page);
      }
      if (options.method === "POST" && path === "/databases") {
        if (body.parent.page_id !== PAGE || !body.is_inline)
          throw Error("Incorrect child database");
        writes.push(path);
        database = {
          id: DB,
          data_sources: [{ id: SOURCE, name: "JournalDB" }],
        };
        schema = {
          id: SOURCE,
          properties: Object.fromEntries(
            Object.entries(body.initial_data_source.properties).map(
              ([name, value]) => [
                name,
                { type: Object.keys(value)[0], ...value },
              ],
            ),
          ),
        };
        return response(database);
      }
      if (path === "/pages/" + PAGE) return response(page);
      if (path === "/databases/" + DB) return response(database);
      if (path === "/data_sources/" + SOURCE) return response(schema);
      throw Error("Unexpected endpoint " + path);
    };
    const open = async () => {
      for (const pref of Services.wm.getEnumerator(null))
        if (pref.location?.href?.includes("/preferences/preferences.xhtml"))
          pref.close();
      await sleep(200);
      app.openSettings();
      for (let i = 0; i < 100; i++) {
        await sleep(100);
        const pref = [...Services.wm.getEnumerator(null)].find((p) =>
          p.document.getElementById("z2n-root"),
        );
        if (pref?.document.getElementById("z2n-markdown")?.value) return pref;
      }
      throw Error("Preferences failed to load");
    };
    const click = async (pref, id) => {
      const button = pref.document.getElementById("z2n-" + id);
      if (button.disabled) throw Error(id + " unexpectedly disabled");
      button.click();
      for (let i = 0; i < 100; i++) {
        await sleep(50);
        if (!pref.document.getElementById("z2n-token-connect").disabled) {
          const message = pref.document.getElementById("z2n-message");
          if (message.classList.contains("error"))
            throw Error(message.textContent);
          return;
        }
      }
      throw Error("Action timed out: " + id);
    };
    {
      writes = [];
      app.forceScan = false;
      app.store.config = structuredClone(original.config);
      app.store.state = { version: 1, records: {}, pending: [] };
      await app.credentials.clear();
      let pref = await open();
      if (
        pref.document.getElementById("z2n-oauth-details") ||
        pref.document.getElementById("z2n-service") ||
        pref.document.getElementById("z2n-login")
      )
        throw Error("Removed authentication controls remain");
      if (app.oauth || app.protocol || "oauthService" in app.store.config)
        throw Error("Retired authentication setup remains");
      if (
        pref.document.getElementById("z2n-token").getBoundingClientRect()
          .height !== 30
      )
        throw Error("PAT input must be visible immediately");
      out.checks.push(
        "Only the PAT connection form is present and immediately visible",
      );
      {
        if (!pref.document.getElementById("z2n-db-new").disabled)
          throw Error("Disconnected New must be disabled");
        pref.document.getElementById("z2n-token").value = "test-pat";
        await click(pref, "token-connect");
        if (
          !pref.document.getElementById("z2n-token-controls").hidden ||
          pref.document.getElementById("z2n-token").value
        )
          throw Error("Connected PAT form should be cleared and hidden");
        out.checks.push(
          "PAT connects through the settings token input and clears the token field",
        );
      }
      await click(pref, "db-new");
      if (
        app.store.config.dataSourceID !== SOURCE ||
        pref.document.getElementById("z2n-db").value !== SOURCE
      )
        throw Error("Created database not selected");
      if (
        Object.keys(schema.properties).length !== 27 ||
        !schema.properties["Zotero Key"]
      )
        throw Error("Schema incomplete");
      if (
        pref.document.getElementById("z2n-schema").textContent !==
        "All properties are ready."
      )
        throw Error("Schema check UI failed");
      if (!app.forceScan) throw Error("Initial sync not requested");
      await app.activateSync();
      if (
        !app.store.config.autoSync ||
        !app.store.state.initializedSources[SOURCE]
      )
        throw Error("Auto sync did not activate");
      out.checks.push(
        mode +
          ": New creates the root page and 27-field JournalDB, selects it, and queues automatic sync",
      );
      await click(pref, "db-new");
      if (writes.length !== 2) throw Error("Repeated New duplicated content");
      out.checks.push(mode + ": repeated New reuses the completed setup");
      await click(pref, "disconnect");
      if (
        pref.document.getElementById("z2n-token-controls").hidden ||
        (await app.credentials.read())
      )
        throw Error(
          "Disconnect must reveal the PAT form and remove credentials",
        );
      pref.document.getElementById("z2n-token").value = "test-pat";
      await click(pref, "token-connect");
      await click(pref, "db-refresh");
      await click(pref, "db-save");
      await app.activateSync();
      if (
        app.store.config.dataSourceID !== SOURCE ||
        !app.store.config.autoSync ||
        writes.length !== 2
      )
        throw Error(
          "Use must reconnect the existing database without creating another one",
        );
      out.checks.push(
        "Disconnect, PAT reconnect, Refresh and Use restore automatic sync without duplicate creation",
      );
      const doc = pref.document,
        root = doc.getElementById("z2n-root");
      const controls = ["db", "db-refresh", "db-save", "db-new"].map((id) =>
        doc.getElementById("z2n-" + id),
      );
      for (const width of [null, "420px"]) {
        root.style.width = width || "";
        await sleep(50);
        const rects = controls.map((el) => el.getBoundingClientRect());
        if (
          rects.some(
            (r) => r.height !== 30 || Math.abs(r.top - rects[0].top) > 1,
          )
        )
          throw Error("Database row alignment failed");
        if (root.scrollWidth > root.clientWidth)
          throw Error("Horizontal overflow");
      }
      root.style.width = "";
      {
        doc.getElementById("z2n-message").hidden = true;
        root.scrollIntoView({ block: "start", behavior: "instant" });
        await sleep(100);
        const canvas = doc.createElementNS(
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
        await IOUtils.write(
          "/tmp/z2n-019-preferences.png",
          Uint8Array.from(
            pref.atob(canvas.toDataURL("image/png").split(",")[1]),
            (c) => c.charCodeAt(0),
          ),
        );
        out.checks.push(
          "Database controls remain aligned at 30px height, with no overflow at default and 420px widths",
        );
      }
    }
  } catch (error) {
    out.errors.push(String(error) + "\n" + error.stack);
  } finally {
    try {
      await restore?.();
    } catch (error) {
      out.errors.push("Restore: " + error);
    }
    await IOUtils.writeUTF8(
      "/tmp/z2n-019-runtime-result.json",
      JSON.stringify(out, null, 2),
    );
  }
})();
