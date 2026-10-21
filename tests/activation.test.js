import test from "node:test";
import assert from "node:assert/strict";
import { initialConfig, TYPES } from "../src/model.js";
import { inScope } from "../src/zotero.js";
globalThis.Zotero = {};
await import("../src/plugin.js");
const base = Zotero.Zotero2Notion;
const item = (id, libraryID = 1, regular = true, deleted = false) => ({
  id,
  libraryID,
  deleted,
  isRegularItem: () => regular,
});
function setup() {
  const properties = Object.fromEntries(
    Object.entries(TYPES).map(([k, type]) => [k, { type }]),
  );
  let scans = 0,
    schedules = 0,
    activations = 0;
  const win = { clearTimeout() {} };
  Zotero.getMainWindow = () => win;
  Zotero.Styles = { get: () => ({}) };
  Zotero.Items = {
    getAll: async () => {
      scans++;
      return [
        item(1),
        item(2),
        item(3, 2),
        item(4, 1, false),
        item(5, 1, true, true),
      ];
    },
  };
  const app = Object.assign(Object.create(base), {
    stopped: false,
    running: false,
    busy: false,
    forceScan: false,
    store: {
      config: { ...initialConfig(), dataSourceID: "db" },
      state: { pending: [], records: {} },
      saveConfig: async () => {},
      saveState: async () => {},
    },
    credentials: { read: async () => ({ access_token: "test" }) },
    api: { schema: async () => ({ properties }) },
    emit() {},
    log() {},
    schedule() {
      schedules++;
    },
    requestSyncActivation(forceScan) {
      this.forceScan ||= forceScan;
      activations++;
    },
  });
  return {
    app,
    properties,
    get scans() {
      return scans;
    },
    get schedules() {
      return schedules;
    },
    get activations() {
      return activations;
    },
  };
}
test("ready database automatically queues all regular My Library items once", async () => {
  const f = setup();
  await f.app.activateSync();
  assert.equal(f.app.store.config.autoSync, true);
  assert.deepEqual(f.app.store.state.pending, [1, 2]);
  assert.equal(f.app.store.state.initializedSources.db, true);
  await f.app.activateSync();
  assert.equal(f.scans, 1);
  f.app.forceScan = true;
  await f.app.activateSync();
  assert.equal(f.scans, 2);
  assert.deepEqual(f.app.store.state.pending, [1, 2]);
});
test("connection and complete database properties are required before auto sync", async () => {
  const f = setup();
  f.app.credentials.read = async () => null;
  await f.app.activateSync();
  assert.equal(f.scans, 0);
  f.app.credentials.read = async () => ({ access_token: "test" });
  delete f.properties.Authors;
  await f.app.activateSync();
  assert.equal(f.app.store.config.autoSync, false);
  assert.equal(f.scans, 0);
  assert.equal(f.schedules, 0);
});
test("failed queue persistence leaves the initial scan eligible for retry", async () => {
  const f = setup();
  f.app.store.saveState = async () => {
    throw Error("Disk full");
  };
  await assert.rejects(f.app.activateSync(), /Disk full/);
  assert.deepEqual(f.app.store.state.pending, []);
  assert.equal(f.app.store.state.initializedSources, undefined);
  assert.equal(f.app.busy, false);
  f.app.store.saveState = async () => {};
  await f.app.activateSync();
  assert.equal(f.scans, 2);
  assert.deepEqual(f.app.store.state.pending, [1, 2]);
});
test("initial scan holds the destination stable until its queue is persisted", async () => {
  const f = setup();
  let release, entered;
  const enteredScan = new Promise((r) => (entered = r));
  Zotero.Items.getAll = async () => {
    entered();
    return new Promise((r) => (release = () => r([item(1)])));
  };
  const activate = f.app.activateSync();
  await enteredScan;
  await assert.rejects(f.app.chooseSource("other", "Other"), /Wait for/);
  release();
  await activate;
  assert.equal(f.app.store.config.dataSourceID, "db");
  assert.deepEqual(f.app.store.state.initializedSources, { db: true });
});
test("mapping changes save without blocking the add-missing-properties flow", async () => {
  const f = setup();
  f.app.store.config.autoSync = true;
  const config = structuredClone(f.app.store.config);
  config.mapping.Authors = "All authors";
  await f.app.saveSettings(config);
  assert.equal(f.app.store.config.mapping.Authors, "All authors");
  assert.equal(f.app.store.config.autoSync, false);
  assert.equal(f.activations, 1);
  assert.equal(f.app.forceScan, true);
});
test("personal-library scope ignores obsolete collection and type filters", () => {
  assert.equal(
    inScope(item(1), {
      libraryID: 1,
      collections: ["missing"],
      paperTypes: ["missing"],
    }),
    true,
  );
  assert.equal(inScope(item(1, 2), { libraryID: 1 }), false);
});

test("initial connection failures retry with bounded delays and recover automatically", async () => {
  const tasks = [],
    logs = [];
  let fail = true;
  const app = Object.assign(Object.create(base), {
    stopped: false,
    running: false,
    busy: false,
    activationAttempts: 0,
    timers: {
      clearTimeout() {},
      setTimeout(fn, delay) {
        tasks.push({ fn, delay });
      },
    },
    activateSync: async () => {
      if (fail) throw Error("Offline");
    },
    log: (text) => logs.push(text),
  });
  app.requestSyncActivation();
  assert.equal(tasks[0].delay, 500);
  await tasks.shift().fn();
  assert.equal(tasks[0].delay, 5000);
  await tasks.shift().fn();
  assert.equal(tasks[0].delay, 15000);
  fail = false;
  await tasks.shift().fn();
  assert.equal(app.activationAttempts, 0);
  assert.equal(tasks.length, 0);
  assert.equal(logs.length, 2);
});
