import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSetup } from "../src/setup.js";
import { NotionClient } from "../src/notion.js";
import { initialConfig, TYPES } from "../src/model.js";

globalThis.Zotero = {};
await import("../src/plugin.js");
const base = Zotero.Zotero2Notion;
const PAGE = "11111111-1111-4111-8111-111111111111";
const DB = "22222222-2222-4222-8222-222222222222";
const SOURCE = "33333333-3333-4333-8333-333333333333";
function fixture() {
  const f = {
    calls: [],
    writes: [],
    token: "pat-test-token",
    me: {
      id: "pat-bot",
      bot: {
        workspace_id: "workspace",
        owner: { type: "user", user: { id: "owner" } },
      },
    },
  };
  f.store = {
    config: initialConfig(),
    state: { records: {}, pending: [] },
    async saveState() {
      f.disk = structuredClone(this.state);
    },
    async saveConfig() {
      f.configDisk = structuredClone(this.config);
    },
  };
  f.api = new NotionClient({
    token: async () => f.token,
    sleep: async () => {},
    fetch: async (url, options) => {
      const path = url.replace("https://api.notion.com/v1", "");
      const body = options.body && JSON.parse(options.body);
      f.calls.push({
        path,
        method: options.method,
        body,
        headers: options.headers,
      });
      const error = await f.fail?.(path, options);
      if (error)
        return new Response(JSON.stringify({ message: "Injected failure" }), {
          status: error,
        });
      let data;
      if (options.method === "POST") {
        f.writes.push({ path, body });
        const record = Object.values(f.disk.databaseSetups)[0];
        assert.equal(
          record.pending,
          path === "/pages" ? "page" : "database",
          "intent must be durable before HTTP",
        );
        if (path === "/pages") {
          data = f.page = { id: PAGE, ...body, created_by: { id: f.me.id } };
        } else if (path === "/databases") {
          assert.equal(body.parent.page_id, PAGE);
          f.schema = {
            id: SOURCE,
            properties: Object.fromEntries(
              Object.entries(body.initial_data_source.properties).map(
                ([name, p]) => [name, { type: Object.keys(p)[0], ...p }],
              ),
            ),
          };
          data = f.db = {
            id: DB,
            parent: body.parent,
            data_sources: [{ id: SOURCE, name: "JournalDB" }],
          };
        } else throw Error("Unexpected POST " + path);
        await f.afterWrite?.(path);
      } else if (path === "/users/me") data = f.me;
      else if (path === "/pages/" + PAGE) data = f.page;
      else if (path === "/databases/" + DB) data = f.db;
      else if (path === "/data_sources/" + SOURCE) data = f.schema;
      else throw Error("Unexpected endpoint " + path);
      return new Response(JSON.stringify(data), { status: 200 });
    },
  });
  f.setup = () => new DatabaseSetup(f.api, f.store);
  return f;
}
test("PAT creates the root page, inline database and all default properties", async () => {
  const f = fixture();
  const result = await f.setup().run();
  assert.equal(result.id, SOURCE);
  assert.equal(result.name, "JournalDB");
  assert.deepEqual(result.check, { missing: [], conflicts: [] });
  assert.deepEqual(f.writes[0].body.parent, {
    type: "workspace",
    workspace: true,
  });
  assert.equal(
    f.writes[0].body.properties.title.title[0].text.content,
    "Zotero2Notion",
  );
  const body = f.writes[1].body;
  assert.equal(body.is_inline, true);
  assert.deepEqual(
    Object.keys(body.initial_data_source.properties),
    Object.keys(TYPES),
  );
  assert.deepEqual(
    body.initial_data_source.properties.Project.select.options,
    [],
  );
  assert.deepEqual(
    body.initial_data_source.properties.Status.select.options.map(
      (x) => x.name,
    ),
    ["Not started", "Reading", "Completed"],
  );
  assert(f.calls.every((c) => c.headers.Authorization === "Bearer " + f.token));
  assert(f.calls.every((c) => c.headers["Notion-Version"] === "2026-03-11"));
  assert(!JSON.stringify(f.disk).includes(f.token));
  f.store.state = structuredClone(f.disk); // restart
  await f.setup().run();
  assert.equal(
    f.writes.length,
    2,
    "another New must reuse the completed setup",
  );
});

test("a revoked PAT rejects creation once and can be retried after reconnecting", async () => {
  const f = fixture();
  f.fail = (path) => (path === "/pages" ? 401 : 0);
  await assert.rejects(
    f.setup().run(),
    (e) => e.status === 401 && /personal access token/.test(e.message),
  );
  assert.equal(f.calls.filter((c) => c.path === "/pages").length, 1);
  assert.equal(await f.setup().incomplete(), "");
  assert.equal(f.writes.length, 0);
  f.token = "replacement-pat";
  f.fail = null;
  await f.setup().run();
  assert.equal(f.writes.length, 2);
  assert.equal(f.calls.at(-1).headers.Authorization, "Bearer replacement-pat");
});
test("internal integrations are rejected before any content is created", async () => {
  const f = fixture();
  f.me.bot.owner = { type: "workspace", workspace: true };
  await assert.rejects(f.setup().run(), /personal access token/);
  assert.equal(f.writes.length, 0);
});
test("database permission failure resumes under the original root page", async () => {
  const f = fixture();
  f.fail = (path) => (path === "/databases" ? 403 : 0);
  await assert.rejects(f.setup().run(), /permissions/);
  assert.equal(f.writes.length, 1);
  f.store.state = structuredClone(f.disk);
  f.fail = null;
  await f.setup().run();
  assert.equal(f.writes.length, 2);
});
for (const stage of ["page", "database"])
  test(
    "lost " +
      stage +
      " response blocks replay across restarts and recovers from its URL",
    async () => {
      const f = fixture();
      f.afterWrite = (path) => {
        if (path === (stage === "page" ? "/pages" : "/databases"))
          throw Error("Connection lost");
      };
      await assert.rejects(f.setup().run(), /could not be confirmed/);
      const writes = f.writes.length;
      f.store.state = structuredClone(f.disk);
      f.afterWrite = null;
      await assert.rejects(f.setup().run(), /could not be confirmed/);
      assert.equal(f.writes.length, writes);
      assert.equal(await f.setup().incomplete(), stage);
      await f
        .setup()
        .recover(
          "https://www.notion.so/" +
            (stage === "page" ? PAGE : DB).replaceAll("-", ""),
        );
      await f.setup().run();
      assert.equal(f.writes.length, 2);
    },
  );
test("5xx has an unknown outcome and is not replayed without an explicit recovery decision", async () => {
  const f = fixture();
  f.fail = (path) => (path === "/pages" ? 503 : 0);
  await assert.rejects(f.setup().run(), /could not be confirmed/);
  assert.equal(f.calls.filter((c) => c.path === "/pages").length, 1);
  await assert.rejects(f.setup().run(), /could not be confirmed/);
  await f.setup().recover(); // user confirmed no page exists
  f.fail = null;
  await f.setup().run();
  assert.equal(f.writes.length, 2);
});
test("an unsaved creation intent never sends a create request", async () => {
  const f = fixture();
  f.store.saveState = async () => {
    throw Error("Disk full");
  };
  await assert.rejects(f.setup().run(), /Disk full/);
  assert.equal(f.writes.length, 0);
});
test("failure to save the returned ID remains recoverable after restart", async () => {
  const f = fixture();
  const save = f.store.saveState.bind(f.store);
  let n = 0;
  f.store.saveState = async () => {
    if (++n === 2) throw Error("Disk full");
    await save();
  };
  await assert.rejects(f.setup().run(), /Disk full/);
  assert.equal(f.writes.length, 1);
  f.store.state = structuredClone(f.disk);
  await assert.rejects(f.setup().run(), /could not be confirmed/);
  f.store.saveState = save;
  await f.setup().recover(PAGE);
  await f.setup().run();
  assert.equal(f.writes.length, 2);
});
test("recovery rejects unrelated pages and rolls back when recovery cannot be saved", async () => {
  const f = fixture();
  f.afterWrite = () => {
    throw Error("Offline");
  };
  await assert.rejects(f.setup().run());
  f.afterWrite = null;
  await assert.rejects(
    f.setup().recover("https://example.com/" + PAGE),
    /Notion/,
  );
  f.page.created_by.id = "another-user";
  await assert.rejects(f.setup().recover(PAGE), /this connection/);
  f.page.created_by.id = f.me.id;
  f.store.saveState = async () => {
    throw Error("Disk full");
  };
  await assert.rejects(f.setup().recover(PAGE), /Disk full/);
  assert.equal(await f.setup().incomplete(), "page");
  await assert.rejects(f.setup().run(), /could not be confirmed/);
  assert.equal(f.writes.length, 1);
});
test("a trashed setup page is not recreated", async () => {
  const f = fixture();
  await f.setup().run();
  f.page.in_trash = true;
  await assert.rejects(f.setup().run(), /Restore/);
  assert.equal(f.writes.length, 2);
});
test("setup records do not cross connection identities", async () => {
  const f = fixture();
  await f.setup().run();
  f.me.id = "another-bot";
  f.fail = (path) => (path === "/pages" ? 403 : 0);
  await assert.rejects(f.setup().run(), /permissions/);
  assert.equal(f.calls.at(-1).path, "/pages");
  assert.equal(Object.keys(f.disk.databaseSetups).length, 2);
});
test("New only switches destination after schema and local config are saved; templates and queued items survive", async () => {
  const f = fixture();
  const app = Object.assign(Object.create(base), {
    api: f.api,
    store: f.store,
    busy: false,
    running: false,
    log() {},
    requestSyncActivation(force) {
      this.activated = force;
    },
  });
  f.store.config.dataSourceID = "old";
  f.store.config.defaultTemplate = "paper-review-en";
  f.store.config.rules = [
    { kind: "tag", value: "reading", templateID: "section-summary-en" },
  ];
  f.store.state.pending = [42];
  const original = structuredClone(f.store.config);
  f.store.saveConfig = async () => {
    throw Error("Disk full");
  };
  await assert.rejects(app.newDatabase(), /Disk full/);
  assert.deepEqual(f.store.config, original);
  assert.equal(app.activated, undefined);
  assert.equal(app.busy, false);
  f.store.saveConfig = async () => {};
  await app.newDatabase();
  assert.equal(f.writes.length, 2);
  assert.equal(f.store.config.dataSourceID, SOURCE);
  assert.equal(f.store.config.autoSync, false);
  assert.equal(f.store.config.defaultTemplate, original.defaultTemplate);
  assert.deepEqual(f.store.config.rules, original.rules);
  assert.deepEqual(f.store.state.pending, [42]);
  assert.equal(app.activated, true);
  app.busy = true;
  await assert.rejects(app.newDatabase(), /Wait for/);
});
