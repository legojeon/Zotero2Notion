import test from "node:test";
import assert from "node:assert/strict";
import { Credentials } from "../src/storage.js";
import { initialConfig } from "../src/model.js";
import { NotionClient } from "../src/notion.js";
globalThis.Zotero = {};
await import("../src/plugin.js");
const base = Zotero.Zotero2Notion;

function savedLogin(value) {
  let login = { password: JSON.stringify(value) },
    removed = 0;
  globalThis.Services = {
    logins: {
      async searchLoginsAsync(query) {
        assert.deepEqual(query, {
          origin: "https://api.notion.com",
          httpRealm: "zotero2notion/connection",
        });
        return login ? [login] : [];
      },
      removeLogin(target) {
        assert.equal(target, login);
        login = null;
        removed++;
      },
    },
  };
  return {
    credentials: new Credentials(),
    get removed() {
      return removed;
    },
  };
}

test("existing PAT credentials survive an upgrade unchanged", async () => {
  for (const value of [
    {
      mode: "token",
      access_token: "test-pat",
      rootPages: true,
      workspace_name: "Test",
    },
    { mode: "token", access_token: "legacy-pat" },
  ]) {
    const f = savedLogin(value);
    assert.equal(await f.credentials.clearUnsupported(), false);
    assert.deepEqual(await f.credentials.read(), value);
    assert.equal(f.removed, 0);
  }
});

test("unsupported credentials are never used and are removed once", async () => {
  for (const value of [
    {
      mode: "oauth",
      access_token: "old-access",
      refresh_token: "old-refresh",
      service: "https://retired.example",
    },
    { mode: "token", access_token: "internal-token", rootPages: false },
  ]) {
    const f = savedLogin(value);
    assert.equal(await f.credentials.read(), null);
    assert.equal(await f.credentials.clearUnsupported(), true);
    assert.equal(await f.credentials.clearUnsupported(), false);
    assert.equal(f.removed, 1);
  }
});

function connection() {
  const f = {
    credential: {
      mode: "token",
      access_token: "existing-pat",
      rootPages: true,
    },
    requests: [],
    saves: 0,
    activations: 0,
    status: 200,
    me: {
      id: "user-bot",
      bot: { owner: { type: "user" }, workspace_name: "Test" },
    },
  };
  Zotero.getMainWindow = () => ({
    fetch: async (url, options) => {
      f.requests.push({ url, options });
      return new Response(JSON.stringify(f.me), { status: f.status });
    },
  });
  f.app = Object.assign(Object.create(base), {
    busy: false,
    running: false,
    credentials: {
      read: async () => structuredClone(f.credential),
      save: async (c) => {
        f.credential = structuredClone(c);
        f.saves++;
      },
    },
    store: {
      config: {
        ...initialConfig(),
        dataSourceID: "existing-db",
        databaseName: "My papers",
        autoSync: true,
      },
      state: {
        version: 1,
        pending: [42],
        records: { "1:ITEM": { pageID: "page" } },
      },
      async saveConfig() {},
      async saveState() {},
    },
    requestSyncActivation() {
      f.activations++;
    },
    log() {},
  });
  return f;
}

test("reconnecting the same PAT preserves the database, queued sync, templates and rules", async () => {
  const f = connection();
  const config = structuredClone(f.app.store.config),
    state = structuredClone(f.app.store.state);
  await f.app.connectToken("  existing-pat  ");
  assert.deepEqual(f.app.store.config, config);
  assert.deepEqual(f.app.store.state, state);
  assert.equal(f.requests[0].url, "https://api.notion.com/v1/users/me");
  assert.equal(
    f.requests[0].options.headers.Authorization,
    "Bearer existing-pat",
  );
  assert.equal(f.credential.mode, "token");
  assert.equal(f.activations, 1);
});

test("a new PAT clears the selected destination while preserving templates and existing page records", async () => {
  const f = connection();
  const templates = structuredClone(f.app.store.config.templates);
  const records = structuredClone(f.app.store.state.records);
  await f.app.connectToken("new-pat");
  assert.equal(f.credential.access_token, "new-pat");
  assert.equal(f.app.store.config.dataSourceID, "");
  assert.equal(f.app.store.config.autoSync, false);
  assert.deepEqual(f.app.store.state.pending, []);
  assert.deepEqual(f.app.store.config.templates, templates);
  assert.deepEqual(f.app.store.state.records, records);
});

test("invalid or non-personal tokens cannot replace a working PAT connection", async () => {
  for (const kind of ["empty", "revoked", "internal"]) {
    const f = connection();
    const config = structuredClone(f.app.store.config),
      state = structuredClone(f.app.store.state);
    if (kind === "revoked") f.status = 401;
    if (kind === "internal") f.me.bot.owner.type = "workspace";
    await assert.rejects(
      f.app.connectToken(kind === "empty" ? "  " : "bad-token"),
      /personal access token/,
    );
    assert.equal(f.saves, 0);
    assert.equal(f.requests.length, kind === "empty" ? 0 : 1);
    assert.deepEqual(f.app.store.config, config);
    assert.deepEqual(f.app.store.state, state);
  }
});

test("missing credentials fail before any network request or retry", async () => {
  let requests = 0,
    retries = 0;
  const api = new NotionClient({
    token: async () => {
      throw new Error("Connect to Notion first.");
    },
    fetch: async () => {
      requests++;
    },
    sleep: async () => {
      retries++;
    },
  });
  await assert.rejects(api.me(), /Connect to Notion/);
  assert.equal(requests, 0);
  assert.equal(retries, 0);
});
