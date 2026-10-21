import test from "node:test";
import assert from "node:assert/strict";
import { Autosave } from "../src/autosave.js";
const timers = { setTimeout, clearTimeout };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

test("rapid template input coalesces and preserves Markdown, Unicode and LaTeX exactly", async () => {
  const writes = [];
  const q = new Autosave({
    timers,
    persist: async (k, v) => writes.push([k, v]),
  });
  const text =
    "# 논문\n$`\\alpha`$\n$$\n\\beta + \\gamma\n$$\n```js\nconst a = 1;\n```";
  q.set("template:x", { markdown: "intermediate" });
  q.set("template:x", { markdown: text });
  await q.flush();
  assert.deepEqual(writes, [["template:x", { markdown: text }]]);
  assert.equal(q.status().state, "saved");
  await q.close();
});

test("an edit arriving during a save stays pending until the new value is written", async () => {
  const first = deferred(),
    second = deferred(),
    started = deferred();
  const writes = [];
  const q = new Autosave({
    timers,
    persist: async (k, v) => {
      writes.push(v);
      started.resolve();
      await (v === "first" ? first : second).promise;
    },
  });
  q.set("text", "first", 0);
  await started.promise;
  q.set("text", "second", 0);
  const done = q.flush();
  first.resolve();
  await tick();
  assert.equal(q.status().state, "pending");
  assert.equal(q.draft("text"), "second");
  second.resolve();
  await done;
  assert.deepEqual(writes, ["first", "second"]);
  assert.equal(q.draft("text"), undefined);
  await q.close();
});

test("settings wait for sync and retain independent group changes", async () => {
  let busy = true;
  let config = { citation: "old", rules: [], other: "keep" };
  const q = new Autosave({
    timers,
    isBusy: () => busy,
    persist: async (k, v) => {
      config = { ...config, ...v };
    },
  });
  q.set("citation", { citation: "new" }, 0);
  q.set("rules", { rules: ["tag"] }, 0);
  const done = q.flush();
  await tick();
  assert.equal(q.status().message, "Waiting for sync…");
  assert.equal(config.citation, "old");
  busy = false;
  await done;
  assert.deepEqual(config, { citation: "new", rules: ["tag"], other: "keep" });
  await q.close();
});

test("write failures remain visible and retain the exact draft for retry", async () => {
  let fail = true,
    saved;
  const q = new Autosave({
    timers,
    persist: async (k, v) => {
      if (fail) throw Error("Disk unavailable");
      saved = v;
    },
  });
  q.set("text", "unsaved draft");
  await assert.rejects(q.flush(), /Disk unavailable/);
  assert.equal(q.status().state, "error");
  assert.equal(q.draft("text"), "unsaved draft");
  fail = false;
  await q.retry();
  assert.equal(saved, "unsaved draft");
  assert.equal(q.status().state, "saved");
  await q.close();
});

test("closing the queue flushes pending debounce writes, including empty drafts", async () => {
  const writes = [];
  const q = new Autosave({ timers, persist: async (k, v) => writes.push(v) });
  q.set("text", "", 60000);
  await q.close();
  assert.deepEqual(writes, [""]);
  assert.throws(() => q.set("text", "later"), /closing/);
});
