import test from "node:test";
import assert from "node:assert/strict";
import { initialConfig, TYPES } from "../src/model.js";

globalThis.Zotero = {};
await import("../src/plugin.js");
const base = Zotero.Zotero2Notion;

function fixture() {
  const items = [1, 2].map((id) => ({
    id, libraryID: 1, key: `KEY${id}`,
    isRegularItem: () => true,
    getDisplayTitle: () => `Paper ${id}`,
    toJSON: () => ({ title: `Paper ${id}`, itemType: "journalArticle" }),
    getCollections: () => [], getTags: () => [], getAttachments: () => [],
  }));
  const retries = [], calls = [];
  Zotero.Items = {
    getAsync: async (ids) => Array.isArray(ids)
      ? ids.map((id) => items.find((i) => i.id === id))
      : items.find((i) => i.id === ids),
    getAll: async () => items,
  };
  Zotero.URI = { getItemURI: (item) => `https://zotero.org/users/1/items/${item.key}` };
  Zotero.QuickCopy = { getContentFromItems: () => ({ text: "Citation" }) };
  Zotero.getMainWindow = () => ({ setTimeout: (fn) => retries.push(fn), clearTimeout() {} });
  const app = Object.assign(Object.create(base), {
    running: false, stopped: false, busy: false, attempts: 0,
    dirty: new Set(), restoreRequests: new Set(),
    store: {
      config: { ...initialConfig(), dataSourceID: "db", autoSync: true },
      state: { pending: [], records: {} },
      saveState: async () => {}, saveConfig: async () => {},
    },
    autosave: { flush: async () => {} },
    engine: { run: async (item, config, context, options) => calls.push({ id: item.id, ...options }) },
    api: { schema: async () => ({ properties: Object.fromEntries(Object.entries(TYPES).map(([k, type]) => [k, { type }])) }) },
    schedule() {}, log() {}, requestSyncActivation() {},
  });
  return { app, calls, retries };
}

test("Send to Notion restores only selected items in a mixed automatic queue", async () => {
  const f = fixture();
  await f.app.enqueue([2]);
  await f.app.sendItems([1]);
  await f.app.enqueue([1]); // Later automatic events do not lose the explicit request.
  await f.app.drain();
  assert.deepEqual(f.calls, [{ id: 2, restoreTrashed: false }, { id: 1, restoreTrashed: true }]);
  assert.equal(f.app.restoreRequests.size, 0);
  await f.app.enqueue([1]);
  await f.app.drain();
  assert.deepEqual(f.calls.at(-1), { id: 1, restoreTrashed: false });
});

test("Recheck library and collection notifications never grant restoration", async () => {
  const f = fixture();
  await f.app.queueScope();
  await f.app.drain();
  await f.app.notify("modify", "collection", [42]);
  await f.app.drain();
  assert.equal(f.calls.length, 4);
  assert(f.calls.every((call) => call.restoreTrashed === false));
});

test("scheduled retries cannot replay a consumed restore request", async () => {
  const f = fixture();
  f.app.engine.run = async (item, config, context, options) => {
    f.calls.push(options.restoreTrashed);
    throw Error("Offline");
  };
  await f.app.sendItems([1]);
  await f.app.drain();
  assert.deepEqual(f.app.store.state.pending, [1]);
  await f.retries.shift()();
  assert.deepEqual(f.calls, [true, false]);
});

test("a Send arriving during an automatic sync is honored on the following pass", async () => {
  const f = fixture();
  f.app.engine.run = async (item, config, context, options) => {
    f.calls.push(options.restoreTrashed);
    if (f.calls.length === 1) await f.app.sendItems([1]);
  };
  await f.app.enqueue([1]);
  await f.app.drain();
  assert.deepEqual(f.calls, [false, true]);
  assert.equal(f.app.restoreRequests.size, 0);
});

test("changing databases discards restore requests even after switching back", async () => {
  const f = fixture();
  await f.app.sendItems([1]);
  await f.app.chooseSource("other", "Other");
  await f.app.chooseSource("db", "Original");
  await f.app.queueScope();
  await f.app.drain();
  assert(f.calls.every((call) => call.restoreTrashed === false));
});

test("persisted failures do not authorize restoration after a restart", async () => {
  const f = fixture();
  await f.app.sendItems([1]);
  const persisted = JSON.parse(JSON.stringify(f.app.store.state));
  const restarted = fixture();
  restarted.app.store.state = persisted;
  await restarted.app.drain();
  assert.deepEqual(restarted.calls, [{ id: 1, restoreTrashed: false }]);
});
