import test from "node:test";
import assert from "node:assert/strict";
import {
  initialConfig,
  TYPES,
  renderTemplate,
  selectTemplate,
  richText,
  encodeProperties,
  inspectSchema,
  schemaCheckMessage,
  matchExisting,
  decodePage,
} from "../src/model.js";
import { SyncEngine } from "../src/sync.js";
import { NotionClient } from "../src/notion.js";
const config = () => ({ ...initialConfig(), dataSourceID: "db" });
const schema = () =>
  Object.fromEntries(
    Object.entries(TYPES).map(([k, type]) => [k, { type, [type]: {} }]),
  );
const values = () => ({
  "Journal Name": "A Paper",
  "Zotero Key": "1:ABC",
  Authors: "A; B",
  Year: 2026,
  "Paper URL": "https://arxiv.org/abs/2601.12345",
  DOI: "",
  Tags: [],
  Collections: [],
  Project: "Sample Project",
});
function page(v, id = "page") {
  const c = config();
  return {
    id,
    parent: { data_source_id: "db" },
    url: "https://notion.so/" + id,
    properties: Object.fromEntries(
      Object.entries(
        encodeProperties(v, schema(), c.mapping, { isNew: true }),
      ).map(([k, p]) => [k, { type: Object.keys(p)[0], ...p }]),
    ),
  };
}
function fixture() {
  const c = config(),
    v = values(),
    s = schema();
  let pages = [],
    body = "",
    calls = [],
    saved = 0;
  const store = {
    state: { records: {} },
    async saveState() {
      saved++;
    },
  };
  const api = {
    async schema() {
      return { properties: s };
    },
    async rows() {
      return [...pages];
    },
    async page(id) {
      const p = pages.find((p) => p.id === id);
      if (!p) throw Error("404");
      return p;
    },
    async create(id, props) {
      calls.push("create");
      const p = {
        id: "page",
        url: "https://notion.so/page",
        parent: { data_source_id: "db" },
        properties: Object.fromEntries(
          Object.entries(props).map(([k, p]) => [
            k,
            { type: Object.keys(p)[0], ...p },
          ]),
        ),
      };
      pages.push(p);
      return p;
    },
    async update(id, props) {
      calls.push("update");
      let p = pages.find((p) => p.id === id);
      for (const [k, v] of Object.entries(props))
        p.properties[k] = { type: Object.keys(v)[0], ...v };
      return p;
    },
    async markdown() {
      return { markdown: body };
    },
    async appendMarkdown(id, text) {
      calls.push("body");
      body += text;
    },
  };
  const engine = new SyncEngine({
    api,
    store,
    readTemplate: async () => "# [title]\n[authors]\n",
  });
  return {
    c,
    v,
    s,
    store,
    api,
    engine,
    calls,
    item: { values: v, tags: [], collectionKeys: [] },
    get pages() {
      return pages;
    },
    set pages(v) {
      pages = v;
    },
    get body() {
      return body;
    },
    set body(v) {
      body = v;
    },
  };
}
test("rendering preserves LaTeX, unknown tokens and does not recursively replace metadata", () => {
  const md =
    "# [title]\n[Authors]\n[Custom]\n[§ ]\n- [ ]\n$$\n\\alpha+\\beta\n$$";
  assert.equal(
    renderTemplate(md, {
      "Journal Name": "[Authors]",
      Authors: "A",
      Custom: "$`\\gamma`$",
    }),
    "# [Authors]\nA\n$`\\gamma`$\n[§ ]\n- [ ]\n$$\n\\alpha+\\beta\n$$",
  );
});
test("first matching tag/collection rule wins, default fallback", () => {
  const c = config();
  c.templates.push({ id: "second" });
  c.rules = [
    { kind: "tag", value: "robot", templateID: "second" },
    { kind: "collection", value: "1:C", templateID: "paper-review-en" },
  ];
  assert.equal(
    selectTemplate(c, { tags: ["robot"], collectionKeys: ["1:C"] }).id,
    "second",
  );
  assert.equal(
    selectTemplate(c, { tags: [], collectionKeys: [] }).id,
    "paper-review-en",
  );
});
test("Unicode rich text is split without truncating or separating surrogate pairs", () => {
  const text = "가".repeat(1999) + "😀" + "x".repeat(5000);
  const chunks = richText(text);
  assert.equal(chunks.map((c) => c.text.content).join(""), text);
  assert(chunks.every((c) => c.text.content.length <= 2000));
});
test("schema mismatch and duplicate property mapping are caught", () => {
  const c = config(),
    s = schema();
  s.Authors.type = "select";
  c.mapping.Editors = "Authors";
  const r = inspectSchema(s, c.mapping);
  assert.equal(r.conflicts.length, 2);
});
test("reading status, existing DOI and manual Project overrides are preserved", () => {
  const props = encodeProperties(
    { ...values(), Status: "Not started", DOI: "10.1/new" },
    schema(),
    config().mapping,
    {
      existing: { Status: "Reading", Project: "Manual", DOI: "10.1/old" },
      managedProject: "Previous",
    },
  );
  assert(!props.Status);
  assert(!props.DOI);
  assert(!props.Project);
  assert.deepEqual(props.Tags, { multi_select: [] });
});
test("DOI/arXiv matching avoids duplicate and refuses ambiguous title-only records", () => {
  const c = config(),
    v = values();
  assert.equal(
    matchExisting(
      v,
      [
        page({
          ...v,
          "Zotero Key": "",
          "Paper URL": "https://arxiv.org/pdf/2601.12345v2",
        }),
      ],
      c.mapping,
    ).id,
    "page",
  );
  assert.throws(
    () => matchExisting(v, [page({ "Journal Name": "A paper" })], c.mapping),
    /same title/,
  );
  assert.throws(
    () => matchExisting(v, [page(v), page(v, "p2")], c.mapping),
    /Multiple/,
  );
});
test("new page gets one body; second sync does not duplicate", async () => {
  const f = fixture();
  await f.engine.run(f.item, f.c, {});
  await f.engine.run(f.item, f.c, {});
  assert.equal(f.calls.filter((v) => v === "create").length, 1);
  assert.equal(f.calls.filter((v) => v === "body").length, 1);
});
test("existing note body never changes", async () => {
  const f = fixture();
  f.pages = [page(f.v)];
  f.body = "My own notes";
  await f.engine.run(f.item, f.c, {});
  assert.equal(f.body, "My own notes");
});
test("lost create response is recovered by persisted Zotero key", async () => {
  const f = fixture();
  const create = f.api.create;
  f.api.create = async (...a) => {
    await create(...a);
    throw Error("response lost");
  };
  await assert.rejects(f.engine.run(f.item, f.c, {}));
  f.api.create = create;
  await f.engine.run(f.item, f.c, {});
  assert.equal(f.pages.length, 1);
  assert.equal(f.calls.filter((v) => v === "create").length, 1);
  assert.equal(f.calls.filter((v) => v === "body").length, 1);
});
test("unresolved creation is never automatically repeated", async () => {
  const f = fixture();
  f.api.create = async () => {
    f.calls.push("create");
    throw Error("timeout");
  };
  await assert.rejects(f.engine.run(f.item, f.c, {}));
  await assert.rejects(f.engine.run(f.item, f.c, {}), /uncertain/);
  assert.deepEqual(f.calls, ["create"]);
});
test("failed body insertion resumes without creating again", async () => {
  const f = fixture(),
    append = f.api.appendMarkdown;
  f.api.appendMarkdown = async () => {
    throw Error("network");
  };
  await assert.rejects(f.engine.run(f.item, f.c, {}));
  f.api.appendMarkdown = append;
  await f.engine.run(f.item, f.c, {});
  assert.equal(f.pages.length, 1);
  assert.equal(f.body, "# A Paper\nA; B\n");
});
test("lost body response does not append it twice", async () => {
  const f = fixture(),
    append = f.api.appendMarkdown;
  f.api.appendMarkdown = async (...a) => {
    await append(...a);
    throw Error("lost");
  };
  await assert.rejects(f.engine.run(f.item, f.c, {}));
  f.api.appendMarkdown = append;
  await f.engine.run(f.item, f.c, {});
  assert.equal(f.calls.filter((v) => v === "body").length, 1);
});
test("archived page does not get recreated", async () => {
  const f = fixture();
  await f.engine.run(f.item, f.c, {});
  f.pages[0].in_trash = true;
  await assert.rejects(f.engine.run(f.item, f.c, {}), /trash/);
  assert.equal(f.pages.length, 1);
});
test("a different Zotero record cannot overwrite canonical source", async () => {
  const f = fixture();
  f.pages = [page({ ...f.v, "Zotero Key": "1:OTHER" })];
  await assert.rejects(f.engine.run(f.item, f.c, {}), /different Zotero/);
  assert.equal(f.calls.length, 0);
});
test("missing schema/template fail before creating a page", async () => {
  const f = fixture();
  delete f.s.Authors;
  await assert.rejects(f.engine.run(f.item, f.c, {}), /Click Add missing.*properties/);
  assert.equal(f.calls.length, 0);
});

test("property recovery names the available action and prioritizes conflicts", () => {
  const c = config(), s = schema();
  delete s["Zotero Key"];
  let message = schemaCheckMessage(inspectSchema(s, c.mapping));
  assert.match(message, /Click Add missing/);
  assert.match(message, /Zotero Key \(rich_text\)/);
  s.Authors.type = "number";
  message = schemaCheckMessage(inspectSchema(s, c.mapping));
  assert.match(message, /Property mapping/);
  assert.match(message, /Check properties/);
  assert.doesNotMatch(message, /Click Add missing/);
  assert.equal(schemaCheckMessage(inspectSchema(schema(), c.mapping)), "All properties are ready.");
});
test("HTTP retry respects 429 but never blindly retries a create on 5xx", async () => {
  let n = 0;
  const api = new NotionClient({
    token: async () => "secret",
    sleep: async () => {},
    fetch: async () => {
      n++;
      return new Response(
        JSON.stringify(n === 1 ? { message: "slow" } : { id: "ok" }),
        { status: n === 1 ? 429 : 200 },
      );
    },
  });
  assert.equal((await api.me()).id, "ok");
  assert.equal(n, 2);
  n = 0;
  api.fetch = async () => {
    n++;
    return new Response("{}", { status: 503 });
  };
  await assert.rejects(api.create("db", {}));
  assert.equal(n, 1);
});

test("updated canonical source is reflected in the same-batch row cache", async () => {
  const f = fixture();
  f.pages = [page({ ...f.v, "Zotero Key": "" })];
  // Real HTTP returns independent response objects, not shared mock references.
  const update = f.api.update;
  f.api.update = async (...a) => structuredClone(await update(...a));
  f.api.rows = async () => structuredClone(f.pages);
  const context = {};
  await f.engine.run(f.item, f.c, context);
  await assert.rejects(
    f.engine.run(
      { ...f.item, values: { ...f.v, "Zotero Key": "1:SECOND" } },
      f.c,
      context,
    ),
    /different Zotero/,
  );
});
test("nonempty reading status blocks stamping a blank existing page", async () => {
  const f = fixture();
  f.pages = [page({ ...f.v, Status: "Reading" })];
  await f.engine.run(f.item, f.c, {});
  assert.equal(f.body, "");
  assert(!f.calls.includes("body"));
});

test("unknown blocks and existing blank reading status are not treated as a new empty page", async () => {
  const f = fixture();
  f.pages = [page(f.v)];
  await f.engine.run(f.item, f.c, {});
  assert(!f.calls.includes("body"));
  const g = fixture();
  g.pages = [page({ ...g.v, Status: "Not started" })];
  g.api.markdown = async () => ({
    markdown: "",
    unknown_block_ids: ["unsupported"],
  });
  await g.engine.run(g.item, g.c, {});
  assert(!g.calls.includes("body"));
});

test("empty saved template never creates a Notion page", async () => {
  const f = fixture();
  f.engine.readTemplate = async () => "";
  await assert.rejects(f.engine.run(f.item, f.c, {}), /template is empty/);
  assert.deepEqual(f.calls, []);
});

test('page sync includes opt-in notes and later metadata updates preserve the personal outline', async () => {
  const f = fixture();
  f.v['Zotero URI'] = 'https://www.zotero.org/users/1/items/ABC';
  f.engine.readTemplate = async () => '# [title]\n[zotero_notes]\n## My reading';
  f.engine.notes.readNotes = async () => [{key:'1:N',title:'Source',html:'<p>[authors] stays literal</p>',uri:'https://www.zotero.org/users/1/items/N'}];
  f.engine.notes.renderNote = async () => ({markdown:'[authors] stays literal'});
  f.api.editMarkdown = async (id, oldText, newText) => { assert.equal(f.body.split(oldText).length,2);f.body=f.body.replace(oldText,()=>newText);return {markdown:f.body} };
  await f.engine.run(f.item,f.c,{});
  assert(f.body.includes('# A Paper'));assert(f.body.includes('[authors] stays literal'));assert(!f.body.includes('[zotero_notes]'));
  f.body+='\nPersonal conclusions';const body=f.body;f.v.Authors='Changed metadata';
  await f.engine.run(f.item,f.c,{});assert.equal(f.body,body);assert.equal(f.pages.length,1);
});
test('invalid note placement fails before creating a database row',async()=>{
  const f=fixture();f.engine.readTemplate=async()=> 'inline [zotero_notes]';
  await assert.rejects(f.engine.run(f.item,f.c,{}),/own line/);assert.equal(f.pages.length,0);
});
