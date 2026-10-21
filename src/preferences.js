window.Z2NPreferences = {
  async init() {
    const root = document.getElementById("z2n-root");
    if (!root || root.dataset.loaded) return;
    root.dataset.loaded = "true";
    const app = Zotero.Zotero2Notion;

    const $ = (id) => document.getElementById("z2n-" + id);
    let snapshot,
      templateID = "",
      rules = [],
      connected = false,
      canCreateDatabase = false,
      acting = false;
    const make = (tag) =>
      document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    const opts = (el, items, selected) => {
      el.replaceChildren();
      for (const item of items) {
        const o = make("option");
        o.value = item.id;
        o.textContent = item.name;
        o.selected = Array.isArray(selected)
          ? selected.includes(item.id)
          : item.id === selected;
        el.append(o);
      }
    };
    const message = (text, error = false) => {
      $("message").hidden = false;
      $("message").classList.toggle("error", error);
      $("message").textContent = text;
    };
    const action = (fn) => async () => {
      if (acting) return;
      acting = true;
      const buttons = [
        ...root.querySelectorAll("button, input, select, textarea"),
      ];
      buttons.forEach((b) => (b.disabled = true));
      try {
        await fn();
      } catch (e) {
        message(e.message, true);
      } finally {
        acting = false;
        buttons.forEach((b) => (b.disabled = false));
        $("disconnect").disabled = !connected;
        $("db-new").disabled = !canCreateDatabase;
        root
          .querySelector('.rule [data-first-rule="true"]')
          ?.setAttribute("disabled", "");
      }
    };
    const click = (id, fn) => $(id).addEventListener("click", action(fn));
    const groups = ["mapping", "default", "rules", "citation"];
    const configForUI = (config = app.store.config) => {
      const result = structuredClone(config);
      for (const group of groups)
        Object.assign(result, app.autosave.draft("settings:" + group) || {});
      return result;
    };
    const queueSettings = (group, patch, delay = 0) =>
      app.autosave.set("settings:" + group, patch, delay);
    const flushTemplate = () => app.autosave.flush("template:" + templateID);
    const queueTemplate = () => {
      app.autosave.set("template:" + templateID, {
        name: $("template-name").value,
        markdown: $("markdown").value,
      });
    };
    const queueRules = (delay = 0) =>
      queueSettings(
        "rules",
        {
          rules: rules.map((r) => ({
            ...r,
            value: r.value.trim(),
            enabled: !!r.value.trim() && !!r.templateID,
          })),
        },
        delay,
      );
    const updateSavedState = () => {
      const status = app.autosave.status();
      $("autosave-status").textContent =
        status.state === "error"
          ? "Not saved: " + status.message
          : status.message;
      $("autosave-retry").hidden = status.state !== "error";
      $("autosave-status").classList.toggle("error", status.state === "error");
      $("dirty").textContent = app.autosave.draft("template:" + templateID)
        ? "· Saving…"
        : "";
      if (
        status.state === "error" &&
        app.autosave.draft("template:" + templateID)
      )
        $("dirty").textContent = "· Not saved";
      $("sync-status").hidden = !app.store.config.dataSourceID;
      $("sync-status").textContent = app.running
        ? "Syncing…"
        : app.store.config.autoSync
          ? app.store.state.pending.length
            ? `${app.store.state.pending.length} items pending`
            : "Automatic sync on"
          : "Click Check properties to review database setup.";
      // Updating labels must not reload the editor or move its caret.
      for (const select of root.querySelectorAll(
        "#z2n-template, #z2n-default, [id^='z2n-rule-template-']",
      )) {
        for (const option of select.options) {
          const template = app.store.config.templates.find(
            (t) => t.id === option.value,
          );
          if (template && option.textContent !== template.name)
            option.textContent = template.name;
        }
      }
    };
    const log = () => {
      if (!$("log")) return;
      updateSavedState();
      $("log").textContent = app.logs
        .map((l) => `${l.time} ${l.error ? "⚠ " : ""}${l.message}`)
        .join("\n");
    };
    app.listeners.add(log);
    window.addEventListener("unload", () => app.listeners.delete(log), {
      once: true,
    });
    click("autosave-retry", () => app.autosave.retry());
    async function connection() {
      const s = await app.settings();
      connected = s.connected;
      canCreateDatabase = s.canCreateDatabase;
      $("db-new").disabled = !canCreateDatabase;
      $("db-new").title = canCreateDatabase
        ? "Create a private Zotero2Notion page with JournalDB"
        : "Connect with a personal access token to create a database";
      $("disconnect").disabled = !connected;
      $("disconnect").hidden = !connected;
      $("connection").textContent = s.connected
        ? s.connection || "Connected"
        : "Not connected";
      $("token-controls").hidden = connected;
    }
    async function templateList(preferred = templateID) {
      snapshot = await app.settings();
      snapshot.config = configForUI(snapshot.config);
      opts(
        $("template"),
        snapshot.config.templates,
        preferred || snapshot.config.defaultTemplate,
      );
      await loadTemplate($("template").value);
      opts(
        $("default"),
        snapshot.config.templates,
        snapshot.config.defaultTemplate,
      );
    }
    async function loadTemplate(id) {
      templateID = id;
      const draft = app.autosave.draft("template:" + id);
      $("markdown").value = draft ? draft.markdown : await app.templateText(id);
      $("template-name").value = draft
        ? draft.name
        : app.store.config.templates.find((t) => t.id === id).name;
      $("dirty").textContent = "";
      $("preview-text").hidden = true;
    }
    function drawRules() {
      const host = $("rules");
      host.replaceChildren();
      rules.forEach((r, index) => {
        const row = make("div");
        row.className = "rule";
        const title = make("span");
        title.className = "rule-index";
        title.textContent = `${index + 1}.`;
        title.setAttribute("aria-label", `Rule ${index + 1}`);
        const actions = make("div");
        actions.className = "rule-actions";
        for (const [symbol, label, fn] of [
          [
            "↑",
            "Move rule up",
            () => {
              if (index) {
                [rules[index - 1], rules[index]] = [
                  rules[index],
                  rules[index - 1],
                ];
                drawRules();
                queueRules();
              }
            },
          ],
          [
            "×",
            "Remove rule",
            () => {
              rules.splice(index, 1);
              drawRules();
              queueRules();
            },
          ],
        ]) {
          const b = make("button");
          b.type = "button";
          b.className = "icon-button";
          b.textContent = symbol;
          b.title = label;
          b.setAttribute("aria-label", `${label}: ${index + 1}`);
          if (symbol === "↑" && index === 0) {
            b.disabled = true;
            b.dataset.firstRule = "true";
          }
          b.onclick = fn;
          actions.append(b);
        }
        const condition = make("div");
        condition.className = "rule-condition";
        const kind = make("select");
        kind.id = `z2n-rule-kind-${index}`;
        kind.className = "rule-kind";
        kind.setAttribute("aria-label", "Match by");
        opts(
          kind,
          [
            { id: "collection", name: "Collection" },
            { id: "tag", name: "Tag" },
          ],
          r.kind,
        );
        const value = make(r.kind === "collection" ? "select" : "input");
        value.id = `z2n-rule-value-${index}`;
        value.className = "rule-value";
        value.setAttribute(
          "aria-label",
          r.kind === "collection" ? "Collection" : "Tag name",
        );
        if (r.kind === "collection") {
          opts(
            value,
            [
              { id: "", name: "Choose a collection" },
              ...snapshot.collections.map((c) => ({ id: c.key, name: c.name })),
            ],
            r.value,
          );
        } else {
          value.value = r.value;
          value.placeholder = "Exact tag name";
        }
        value.oninput = () => {
          r.value = value.value;
          queueRules(500);
        };
        value.onchange = () => {
          r.value = value.value;
          queueRules();
        };
        kind.onchange = () => {
          r.kind = kind.value;
          r.value = "";
          drawRules();
          queueRules();
        };
        condition.append(title, kind, value, actions);
        const templateField = make("div");
        templateField.className = "field";
        const templateLabel = make("label");
        templateLabel.textContent = "Template";
        const template = make("select");
        template.id = `z2n-rule-template-${index}`;
        templateLabel.htmlFor = template.id;
        opts(template, snapshot.config.templates, r.templateID);
        template.onchange = () => {
          r.templateID = template.value;
          queueRules();
        };
        templateField.append(templateLabel, template);
        row.append(condition, templateField);
        host.append(row);
      });
    }
    async function showSchema(result) {
      result ||= await app.schemaCheck();
      $("schema").hidden = false;
      $("schema").textContent = app.schemaMessage(result);
      $("schema-add").hidden =
        !result.missing.length || !!result.conflicts.length;
    }
    click("token-help", () =>
      Zotero.launchURL("https://www.notion.so/developers/tokens"),
    );
    click("token-connect", async () => {
      await app.connectToken($("token").value);
      $("token").value = "";
      await connection();
      opts($("db"), [{ id: "", name: "Choose a database" }], "");
      message("Connected. Choose a database or create one with New.");
    });
    click("disconnect", async () => {
      await app.disconnect();
      await connection();
      message("Disconnected from Notion.");
    });
    click("db-refresh", async () => {
      const sources = await app.sources();
      opts($("db"), sources, app.store.config.dataSourceID);
      message(
        sources.length
          ? `Found ${sources.length} data sources.`
          : "No accessible databases found. Create one with New, or check access in Notion.",
      );
    });
    click("db-save", async () => {
      if (!$("db").value) throw new Error("Choose a database.");
      await app.autosave.flush("settings:mapping");
      await app.chooseSource(
        $("db").value,
        $("db").selectedOptions[0].textContent,
      );
      await showSchema();
      drawMapping((await app.settings()).config);
      message("Database selected. Review the property check below.");
    });
    click("db-new", async () => {
      await app.autosave.flush();
      message("Setting up JournalDB…");
      const result = await app.newDatabase();
      const options = [...$("db").options]
        .filter((o) => o.value && o.value !== result.id)
        .map((o) => ({ id: o.value, name: o.textContent }));
      opts($("db"), [...options, result], result.id);
      drawMapping(app.store.config);
      await showSchema(result.check);
      message("JournalDB is ready. Automatic sync will start shortly.");
    });
    click("schema-check", async () => {
      await app.autosave.flush("settings:mapping");
      await showSchema();
    });
    click("schema-add", async () => {
      await app.autosave.flush("settings:mapping");
      const c = await app.schemaCheck();
      if (
        window.confirm(
          "Add these properties to the database? Existing properties will be preserved.\n\n" +
            c.missing.map((p) => p.name).join(", "),
        )
      )
        await showSchema(await app.addMissing());
    });
    function drawMapping(config) {
      $("mapping").replaceChildren();
      for (const k of snapshot.fields) {
        const label = make("label");
        label.textContent = k;
        const input = make("input");
        input.value = config.mapping[k] || "";
        input.dataset.field = k;
        input.id = `z2n-map-${k.replace(/[^a-zA-Z0-9]/g, "-")}`;
        label.htmlFor = input.id;
        input.setAttribute("aria-label", k + " Notion property name");
        input.oninput = () => queueMapping(500);
        input.onchange = () => queueMapping(0);
        $("mapping").append(label, input);
      }
    }
    function queueMapping(delay) {
      const mapping = Object.fromEntries(
        [...$("mapping").querySelectorAll("input")].map((input) => [
          input.dataset.field,
          input.value.trim(),
        ]),
      );
      queueSettings("mapping", { mapping }, delay);
    }
    $("template").onchange = action(async () => {
      const next = $("template").value;
      try {
        await flushTemplate();
      } catch (error) {
        $("template").value = templateID;
        throw error;
      }
      await loadTemplate(next);
    });
    for (const id of ["markdown", "template-name"]) {
      $(id).oninput = queueTemplate;
      $(id).onblur = () => flushTemplate().catch(() => {});
    }
    click("template-new", async () => {
      await flushTemplate();
      const id = await app.createTemplate(
        "New template",
        "# [title]\n[paper_link]\n",
      );
      await templateList(id);
      drawRules();
    });
    click("template-copy", async () => {
      await flushTemplate();
      const id = await app.createTemplate(
        $("template-name").value + " copy",
        $("markdown").value,
      );
      await templateList(id);
      drawRules();
    });
    click("template-delete", async () => {
      await flushTemplate();
      await app.autosave.flush(["settings:rules", "settings:default"]);
      if (
        !window.confirm(
          "Remove this template from the list? Its Markdown file will be kept for recovery.",
        )
      )
        return;
      await app.deleteTemplate(templateID);
      await templateList(app.store.config.defaultTemplate);
      drawRules();
    });
    click("preview", async () => {
      $("preview-text").textContent = await app.preview($("markdown").value);
      $("preview-text").hidden = false;
    });
    click("folder", async () => {
      await flushTemplate();
      Zotero.launchFile(app.store.path("templates"));
    });
    click("rule-add", () => {
      rules.push({
        kind: "collection",
        value: "",
        templateID: $("default").value,
        enabled: true,
      });
      drawRules();
      queueRules();
    });
    $("default").onchange = action(async () => {
      const next = $("default").value;
      // Queue the plugin-owned save before awaiting editor work. Closing the
      // settings window immediately must not discard the selected default.
      queueSettings("default", { defaultTemplate: next });
      await flushTemplate();
      $("template").value = next;
      await loadTemplate(next);
    });
    $("citation").oninput = () =>
      queueSettings(
        "citation",
        { citationStyle: $("citation").value.trim() },
        500,
      );
    $("citation").onchange = () =>
      queueSettings("citation", { citationStyle: $("citation").value.trim() });
    click("send-scope", async () => {
      await app.autosave.flush();
      if (
        window.confirm(
          "Recheck all items in My Library and update their Notion pages?",
        )
      )
        await app.queueScope();
    });
    click("retry", async () => {
      await app.autosave.flush();
      app.attempts = 0;
      app.activationAttempts = 0;
      app.requestSyncActivation();
      app.schedule();
      message("Retrying failed items.");
    });
    click("recovery", async () => {
      const keys = await app.unresolved();
      $("unresolved").replaceChildren();
      const stage = await app.incompleteDatabase();
      if (stage) {
        const row = make("div");
        row.className = "recovery-row";
        const label = make("span");
        label.textContent = `Unconfirmed ${stage} creation`;
        row.append(label);
        for (const [text, fn] of [
          [
            "Use Notion URL",
            async () => {
              const url = window.prompt(
                `Paste the URL of the ${stage} created by New:`,
              );
              if (!url?.trim()) return;
              await app.recoverDatabase(url);
              row.remove();
              message("Setup recovered. Choose New to continue.");
            },
          ],
          [
            "Allow retry",
            async () => {
              if (
                !window.confirm(
                  `Check Notion first. If the ${stage} already exists, cancel and use its URL instead.\n\nConfirm that no ${stage} was created and allow another attempt?`,
                )
              )
                return;
              await app.recoverDatabase();
              row.remove();
              message("Choose New to retry setup.");
            },
          ],
        ]) {
          const button = make("button");
          button.textContent = text;
          button.onclick = action(fn);
          row.append(button);
        }
        $("unresolved").append(row);
      }
      if (!keys.length && !stage) {
        $("unresolved").textContent = "No incomplete page creation records.";
        return;
      }
      for (const key of keys) {
        const row = make("div");
        row.className = "recovery-row";
        const name = make("span");
        name.textContent = key;
        row.append(name);
        const b = make("button");
        b.textContent = "Check page";
        b.onclick = action(async () => {
          if (
            !window.confirm(
              "Recheck the Notion database and allow creation if no matching key is found? Confirm that no duplicate page exists in Notion before continuing.",
            )
          )
            return;
          await app.resolveUncertain(key);
          row.remove();
          message("Record checked. Choose Retry failed to continue.");
        });
        row.append(b);
        $("unresolved").append(row);
      }
    });
    try {
      snapshot = await app.settings();
      const c = configForUI(snapshot.config);
      await connection();
      opts(
        $("db"),
        [
          {
            id: c.dataSourceID,
            name: c.databaseName || "Choose a database",
          },
        ],
        c.dataSourceID,
      );
      drawMapping(c);
      await templateList(c.defaultTemplate);
      rules = structuredClone(c.rules);
      drawRules();
      $("citation").value = c.citationStyle;
      $("variables").textContent = snapshot.fields
        .map((k) => `[${k}]`)
        .join(" · ");
      log();
    } catch (e) {
      message(e.message, true);
    }
  },
};
