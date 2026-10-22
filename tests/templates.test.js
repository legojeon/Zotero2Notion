import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  access,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { Store } from "../src/storage.js";
import { Autosave } from "../src/autosave.js";
import {
  initialConfig,
  BUILTIN_TEMPLATES,
  renderTemplate,
  selectTemplate,
} from "../src/model.js";
const addon = new URL("../addon/", import.meta.url).href;
globalThis.PathUtils = path;
globalThis.IOUtils = {
  makeDirectory: (p) => mkdir(p, { recursive: true }),
  exists: async (p) => {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  },
  readUTF8: (p) => readFile(p, "utf8"),
  writeUTF8: (p, s) => writeFile(p, s, "utf8"),
};
globalThis.Zotero = {
  getMainWindow: () => ({ crypto: webcrypto }),
  File: {
    getResourceAsync: (url) => {
      if (!url.startsWith("jar:")) return readFile(fileURLToPath(url), "utf8");
      const [archive, entry] = url.slice(4).split("!/");
      return execFileSync(
        "/usr/bin/unzip",
        ["-p", fileURLToPath(archive), entry],
        { encoding: "utf8" },
      );
    },
    getContentsAsync: () => {
      throw new Error(
        "Bundled jar resources cannot use the filesystem path reader",
      );
    },
  },
};
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "z2n-templates-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new Store(root);
}
test("new install exposes only two English templates with concise names and an English default", async (t) => {
  const store = await fixture(t);
  await store.init(addon);
  assert.deepEqual(
    store.config.templates.map((t) => t.name),
    ["Paper review", "Section summary"],
  );
  assert.equal(store.config.defaultTemplate, "paper-review-en");
  for (const template of BUILTIN_TEMPLATES) {
    assert((await store.readTemplate(template)).includes("[title]"));
    if (template.id.endsWith("-en")) {
      const rendered = renderTemplate(await store.readTemplate(template), {
        "Journal Name": "Example",
        "Paper URL": "https://example.org",
        Authors: "A; B",
        Year: 2026,
      });
      assert(rendered.includes("[Paper](https://example.org)"));
      assert(!/[가-힣]/.test(rendered));
      assert(
        !/[가-힣]/.test(renderTemplate(await store.readTemplate(template), {})),
      );
    }
  }
});
test("queued custom default survives closing preferences and a settings reload", async (t) => {
  const store = await fixture(t);
  await store.init(addon);
  const korean = { id: "korean", name: "Paper review (Korean)", file: "korean.md" };
  store.config.templates.push(korean);
  await store.saveTemplate(korean, "# [title]\n\n## 문제\n");
  await store.saveConfig();
  const autosave = new Autosave({
    timers: { setTimeout, clearTimeout },
    persist: async (key, patch) => {
      store.config = { ...store.config, ...patch };
      await store.saveConfig();
    },
  });
  t.after(() => autosave.close());
  autosave.set("settings:default", { defaultTemplate: korean.id }, 0);
  // No preferences-window callback or explicit Save is needed to persist it.
  await autosave.flush();
  assert.equal(autosave.status().state, "saved");
  const reloaded = new Store(store.root);
  await reloaded.init(addon);
  assert.equal(reloaded.config.defaultTemplate, korean.id);
  assert.equal(selectTemplate(reloaded.config, { tags: [], collectionKeys: [] }).id, korean.id);
  assert.equal(await reloaded.readTemplate(korean), "# [title]\n\n## 문제\n");
});
test("first startup from a packed XPI copies exact UTF-8 templates, including paths with spaces and @", async (t) => {
  const store = await fixture(t);
  const archive = path.join(store.root, "Zotero2Notion test@local.xpi");
  execFileSync("/usr/bin/zip", ["-q", "-r", archive, "templates"], {
    cwd: fileURLToPath(addon),
  });
  await store.init("jar:" + pathToFileURL(archive).href + "!/");
  for (const template of BUILTIN_TEMPLATES) {
    assert.equal(
      await store.readTemplate(template),
      await readFile(new URL("templates/" + template.file, addon), "utf8"),
    );
  }
  assert.equal(store.config.defaultTemplate, "paper-review-en");
});
test("upgrade adds English templates while preserving edited templates, default, and rules", async (t) => {
  const store = await fixture(t);
  const c = initialConfig();
  c.templates = [
    { id: "paper-review", name: "My review", file: "paper-review.md" },
    { id: "custom", name: "Custom", file: "custom.md" },
  ];
  delete c.bundledTemplates;
  c.defaultTemplate = "custom";
  c.rules = [{ kind: "tag", value: "keep", templateID: "custom" }];
  await mkdir(store.path("templates"));
  await writeFile(
    store.path("templates/paper-review.md"),
    "Customized existing content",
  );
  await writeFile(store.path("settings.json"), JSON.stringify(c));
  await store.init(addon);
  assert.equal(store.config.templates.length, 4);
  assert.equal(store.config.templates[0].name, "My review");
  assert.equal(
    await store.readTemplate(store.config.templates[0]),
    "Customized existing content",
  );
  assert.equal(store.config.defaultTemplate, "custom");
  assert.deepEqual(store.config.rules, c.rules);
  const loaded = new Store(store.root);
  await loaded.init(addon);
  assert.equal(loaded.config.templates.length, 4);
});
test("deleted optional built-in is not restored on restart", async (t) => {
  const store = await fixture(t);
  await store.init(addon);
  store.config.templates = store.config.templates.filter(
    (t) => t.id !== "section-summary-en",
  );
  await store.saveConfig();
  const loaded = new Store(store.root);
  await loaded.init(addon);
  assert(!loaded.config.templates.some((t) => t.id === "section-summary-en"));
});
test("upgrading preserves an already customized English template file and registration", async (t) => {
  const store = await fixture(t);
  await store.init(addon);
  const template = store.config.templates.find(
    (t) => t.id === "paper-review-en",
  );
  template.name = "My English frame";
  await store.saveTemplate(template, "# My notes\n$`\\alpha`$");
  await store.saveConfig();
  const loaded = new Store(store.root);
  await loaded.init(addon);
  const kept = loaded.config.templates.find((t) => t.id === template.id);
  assert.equal(kept.name, "My English frame");
  assert.equal(await loaded.readTemplate(kept), "# My notes\n$`\\alpha`$");
});

async function legacyFixture(t) {
  const store = await fixture(t);
  const legacy = {
    id: "paper-review",
    name: "Paper review",
    file: "paper-review.md",
  };
  store.config.templates = [
    legacy,
    ...BUILTIN_TEMPLATES.map((t) => ({
      ...t,
      name: `${t.name} (English)`,
    })),
  ];
  store.config.bundledTemplates = store.config.templates.map((t) => t.id);
  store.config.defaultTemplate = legacy.id;
  store.config.rules = [
    { kind: "collection", value: "1:C", templateID: legacy.id },
    { kind: "tag", value: "", templateID: legacy.id, enabled: false },
    { kind: "tag", value: "sections", templateID: "section-summary-en" },
  ];
  await mkdir(store.path("templates"));
  await store.saveTemplate(
    legacy,
    await readFile(
      new URL("fixtures/paper-review-0.1.6.md", import.meta.url),
      "utf8",
    ),
  );
  await store.saveConfig();
  return { store, legacy };
}

test("upgrade retires only the unchanged Korean default and remaps active and disabled rules once", async (t) => {
  const { store, legacy } = await legacyFixture(t);
  const original = await store.readTemplate(legacy);
  await store.init(addon);
  assert.deepEqual(
    store.config.templates.map((t) => t.name),
    ["Paper review", "Section summary"],
  );
  assert.equal(store.config.defaultTemplate, "paper-review-en");
  assert.deepEqual(
    store.config.rules.map((r) => r.templateID),
    ["paper-review-en", "paper-review-en", "section-summary-en"],
  );
  assert.equal(store.config.rules[1].enabled, false);
  assert.equal(await store.readTemplate(legacy), original);
  const saved = await readFile(store.path("settings.json"), "utf8");
  const loaded = new Store(store.root);
  await loaded.init(addon);
  assert.equal(await readFile(store.path("settings.json"), "utf8"), saved);
});

test("upgrade preserves a Korean template whose content, name, or path was customized", async (t) => {
  for (const edit of ["content", "name", "path"]) {
    const { store, legacy } = await legacyFixture(t);
    if (edit === "content")
      await store.saveTemplate(legacy, "# 내 골격\n$`\\alpha`$\n");
    if (edit === "name") legacy.name = "My review";
    if (edit === "path") {
      legacy.file = "custom-review.md";
      await store.saveTemplate(legacy, "# Custom path");
    }
    const original = await store.readTemplate(legacy);
    const rules = structuredClone(store.config.rules);
    await store.saveConfig();
    await store.init(addon);
    assert.deepEqual(
      store.config.templates.find((t) => t.id === legacy.id),
      legacy,
    );
    assert.equal(store.config.defaultTemplate, legacy.id);
    assert.deepEqual(store.config.rules, rules);
    assert.equal(await store.readTemplate(legacy), original);
  }
});

test("upgrade retains custom English content, names and user duplicates while replacing the old default", async (t) => {
  const { store } = await legacyFixture(t);
  const english = store.config.templates.find(
    (t) => t.id === "paper-review-en",
  );
  english.name = "My notes";
  english.file = "my-notes.md";
  const duplicate = {
    id: "custom",
    name: "Paper review (English) copy",
    file: "custom.md",
  };
  store.config.templates.push(duplicate);
  await store.saveTemplate(english, "# Edited English notes");
  await store.saveTemplate(duplicate, "# My copy");
  await store.saveConfig();
  await store.init(addon);
  assert.deepEqual(
    store.config.templates.find((t) => t.id === english.id),
    english,
  );
  assert.equal(await store.readTemplate(english), "# Edited English notes");
  assert.deepEqual(
    store.config.templates.find((t) => t.id === duplicate.id),
    duplicate,
  );
  assert.equal(await store.readTemplate(duplicate), "# My copy");
  assert.equal(store.config.defaultTemplate, english.id);
});

test("upgrade creates a missing English replacement before retiring the Korean default", async (t) => {
  const { store } = await legacyFixture(t);
  store.config.templates = store.config.templates.filter(
    (t) => t.id !== "paper-review-en",
  );
  await store.saveConfig();
  await store.init(addon);
  const replacement = store.config.templates.find(
    (t) => t.id === store.config.defaultTemplate,
  );
  assert.equal(replacement.id, "paper-review-en");
  assert.match(await store.readTemplate(replacement), /## Problem/);
});

test("a failed replacement write leaves the saved default and rules intact for a safe retry", async (t) => {
  const { store, legacy } = await legacyFixture(t);
  store.config.templates = [legacy];
  await store.saveConfig();
  const before = await readFile(store.path("settings.json"), "utf8");
  const write = IOUtils.writeUTF8;
  IOUtils.writeUTF8 = async (p, text) => {
    if (p.endsWith("paper-review-en.md")) throw new Error("Disk full");
    return write(p, text);
  };
  try {
    await assert.rejects(store.init(addon), /Disk full/);
  } finally {
    IOUtils.writeUTF8 = write;
  }
  assert.equal(await readFile(store.path("settings.json"), "utf8"), before);
  await store.init(addon);
  assert.equal(store.config.defaultTemplate, "paper-review-en");
});

test("template helper variables use English labels even when metadata is missing", () => {
  assert.equal(
    renderTemplate("[authors_short] · [paper_link]", {}),
    "Unknown author · Paper URL unavailable",
  );
  assert.equal(
    renderTemplate("[paper_link]", { "Paper URL": "https://example.org" }),
    "[Paper](https://example.org)",
  );
});

test("retired authentication service settings are removed without changing templates or sync state", async (t) => {
  const store = await fixture(t);
  await store.init(addon);
  store.config.oauthService = "https://retired.example";
  store.config.dataSourceID = "existing-db";
  store.config.autoSync = true;
  store.state.pending = [42];
  await store.saveConfig();
  await store.saveState();
  const expected = structuredClone(store.config);
  delete expected.oauthService;
  const loaded = new Store(store.root);
  await loaded.init(addon);
  assert.deepEqual(loaded.config, expected);
  assert.deepEqual(loaded.state, store.state);
  assert.deepEqual(
    JSON.parse(await readFile(store.path("settings.json"), "utf8")),
    expected,
  );
});

test('upgrade adds the notes token only to exact previous built-in outlines', async (t) => {
 const store=await fixture(t);await store.init(addon);
 for(const template of BUILTIN_TEMPLATES){await store.saveTemplate(template,await readFile(new URL('fixtures/v011-'+template.file,import.meta.url),'utf8'));}
 delete store.config.notesTemplateRevision;await store.saveConfig();const next=new Store(store.root);await next.init(addon);
 for(const template of BUILTIN_TEMPLATES)assert((await next.readTemplate(template)).includes('[zotero_notes]'));
 const custom=next.config.templates[0];await next.saveTemplate(custom,'# My layout\n');
 const reopened=new Store(store.root);await reopened.init(addon);assert.equal(await reopened.readTemplate(custom),'# My layout\n');
});


test('removing the notes token from a shipped template stays opt-out across restarts', async (t) => {
 const store=await fixture(t);await store.init(addon);const template=BUILTIN_TEMPLATES[0];
 const old=await readFile(new URL('fixtures/v011-'+template.file,import.meta.url),'utf8');
 await store.saveTemplate(template,old);const next=new Store(store.root);await next.init(addon);
 assert.equal(await next.readTemplate(template),old);
});
