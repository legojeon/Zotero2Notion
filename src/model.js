export const TYPES = {
  "Journal Name": "title",
  "Paper URL": "url",
  DOI: "rich_text",
  Status: "select",
  Project: "select",
  Tags: "multi_select",
  Abstract: "rich_text",
  Authors: "rich_text",
  Editors: "rich_text",
  Publication: "rich_text",
  Year: "number",
  "Zotero URI": "url",
  "Citation Key": "rich_text",
  Collections: "multi_select",
  Date: "rich_text",
  "Date Added": "date",
  "Date Modified": "date",
  Extra: "rich_text",
  "File Path": "rich_text",
  "Full Citation": "rich_text",
  "In-Text Citation": "rich_text",
  "Item Type": "select",
  Place: "rich_text",
  "Proceedings Title": "rich_text",
  "Series Title": "rich_text",
  "Short Title": "rich_text",
  "Zotero Key": "rich_text",
};
export const BUILTIN_TEMPLATES = [
  {
    id: "paper-review-en",
    name: "Paper review",
    file: "paper-review-en.md",
  },
  {
    id: "section-summary-en",
    name: "Section summary",
    file: "section-summary-en.md",
  },
];
export const initialConfig = () => ({
  version: 1,
  dataSourceID: "",
  databaseName: "",
  autoSync: false,
  libraryID: 1,
  citationStyle: "http://www.zotero.org/styles/apa",
  defaultTemplate: "paper-review-en",
  templates: BUILTIN_TEMPLATES.map((t) => ({ ...t })),
  bundledTemplates: BUILTIN_TEMPLATES.map((t) => t.id),
  rules: [],
  mapping: Object.fromEntries(Object.keys(TYPES).map((k) => [k, k])),
});
export function scalar(v) {
  return v == null
    ? ""
    : Array.isArray(v)
      ? v.join("; ")
      : typeof v === "object"
        ? JSON.stringify(v)
        : String(v);
}
export function renderTemplate(md, properties) {
  const values = {};
  for (const [k, v] of Object.entries(properties)) {
    values[k] = scalar(v);
    values[
      k
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_]+/gu, "_")
        .replace(/^_|_$/g, "")
    ] = scalar(v);
  }
  const authors = scalar(properties.Authors).split("; ").filter(Boolean);
  Object.assign(values, {
    title: scalar(properties["Journal Name"]),
    url: scalar(properties["Paper URL"]),
    authors_short: authors.length
      ? authors[0] + (authors.length > 1 ? " et al." : "")
      : "Unknown author",
    paper_link: properties["Paper URL"]
      ? `[Paper](${properties["Paper URL"]})`
      : "Paper URL unavailable",
    zotero_link: properties["Zotero URI"]
      ? `[Zotero](${properties["Zotero URI"]})`
      : "",
  });
  // Single pass: values containing another token or LaTeX are never interpreted again.
  return md.replace(/\[([^\]\n]+)\]/g, (token, k) =>
    Object.hasOwn(values, k) ? values[k] : token,
  );
}
export function selectTemplate(config, item) {
  const match = config.rules.find(
    (r) =>
      r.enabled !== false &&
      (r.kind === "tag"
        ? item.tags.includes(r.value)
        : r.kind === "collection"
          ? item.collectionKeys.includes(r.value)
          : false),
  );
  const id = match?.templateID || config.defaultTemplate;
  const template = config.templates.find((t) => t.id === id);
  if (!template)
    throw new Error(
      "A rule references a missing template. Choose a template in settings.",
    );
  return template;
}
export const normalizeDOI = (v) =>
  String(v || "")
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .toLowerCase();
export const arxivID = (v) =>
  (String(v || "").match(
    /(?:arxiv\.org\/(?:abs|pdf)\/|arxiv[:.])([a-z-]+\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/i,
  ) || [])[1]?.toLowerCase() || "";
export const normalizeTitle = (v) =>
  String(v || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
export function richText(s) {
  const chunks = [];
  let part = "";
  for (const char of String(s ?? "")) {
    if (part.length + char.length > 2000) {
      chunks.push({ type: "text", text: { content: part } });
      part = "";
    }
    part += char;
  }
  if (part) chunks.push({ type: "text", text: { content: part } });
  if (chunks.length > 100)
    throw new Error("The text exceeds Notion’s property size limit.");
  return chunks;
}
export function decodeProperty(p) {
  if (!p) return "";
  switch (p.type) {
    case "title":
    case "rich_text":
      return p[p.type]
        .map((t) => t.plain_text ?? t.text?.content ?? "")
        .join("");
    case "url":
    case "number":
    case "checkbox":
      return p[p.type];
    case "select":
    case "status":
      return p[p.type]?.name || "";
    case "multi_select":
      return p.multi_select.map((v) => v.name);
    case "date":
      return p.date?.start || "";
    case "created_time":
    case "last_edited_time":
      return p[p.type];
    default:
      return "";
  }
}
export function decodePage(page, mapping) {
  const values = Object.fromEntries(
    Object.entries(page.properties || {}).map(([k, v]) => [
      k,
      decodeProperty(v),
    ]),
  );
  for (const [k, name] of Object.entries(mapping))
    if (name && page.properties?.[name])
      values[k] = decodeProperty(page.properties[name]);
  return values;
}
export function inspectSchema(schema, mapping) {
  const missing = [],
    conflicts = [];
  const used = new Set();
  for (const [key, type] of Object.entries(TYPES)) {
    const name = mapping[key];
    if (!name) {
      if (["Journal Name", "Zotero Key"].includes(key))
        conflicts.push(`${key}: This property is required.`);
      continue;
    }
    if (used.has(name)) {
      conflicts.push(`${name}: This property is mapped to two fields.`);
      continue;
    }
    used.add(name);
    if (!schema[name]) missing.push({ key, name, type });
    else if (
      schema[name].type !== type &&
      !(key === "Status" && schema[name].type === "status")
    )
      conflicts.push(`${name}: Expected ${type}; found ${schema[name].type}.`);
  }
  return { missing, conflicts };
}
export function missingSchemaProperties(missing) {
  return Object.fromEntries(
    missing.map(({ name, type }) => [
      name,
      type === "select"
        ? {
            select: {
              options: name === "Status" ? [{ name: "Not started" }] : [],
            },
          }
        : { [type]: {} },
    ]),
  );
}
export function encodeProperties(
  values,
  schema,
  mapping,
  { existing = {}, managedProject = "", isNew = false } = {},
) {
  const props = {};
  for (const [key, value] of Object.entries(values)) {
    const name = mapping[key],
      type = schema[name]?.type;
    if (!name || !type || !TYPES[key]) continue;
    if (key === "Status" && !isNew) continue;
    if (key === "DOI" && existing[key]) continue;
    if (
      key === "Project" &&
      (!value || (existing[key] && existing[key] !== managedProject))
    )
      continue;
    if (
      (value === "" || value == null) &&
      !["Tags", "Collections"].includes(key)
    )
      continue;
    const old = existing[key];
    if (!isNew && JSON.stringify(value) === JSON.stringify(old)) continue;
    if (type === "title" || type === "rich_text")
      props[name] = { [type]: richText(value) };
    else if (type === "multi_select") {
      const names = [
        ...new Set(
          (value || [])
            .map((v) =>
              v
                .replace(/,/g, key === "Tags" ? " · " : ";")
                .replace(/\s+/g, " ")
                .trim(),
            )
            .filter(Boolean),
        ),
      ];
      if (names.some((n) => n.length > 100))
        throw new Error(`${name}: An option exceeds 100 characters.`);
      props[name] = { multi_select: names.map((name) => ({ name })) };
    } else if (type === "select" || type === "status") {
      if (String(value).length > 100)
        throw new Error(`${name}: The option name is too long.`);
      if (
        type === "status" &&
        !schema[name].status.options.some((o) => o.name === value)
      )
        throw new Error(`${name} needs a '${value}' status option.`);
      props[name] = { [type]: value ? { name: String(value) } : null };
    } else if (type === "date")
      props[name] = { date: value ? { start: value } : null };
    else if (type === "number")
      props[name] = { number: value == null ? null : Number(value) };
    else if (type === "url") props[name] = { url: value || null };
  }
  return props;
}
export function matchExisting(values, rows, mapping) {
  const normalized = rows.map((page) => ({
    page,
    v: decodePage(page, mapping),
  }));
  const exact = normalized.filter(
    ({ v }) => v["Zotero Key"] === values["Zotero Key"],
  );
  if (exact.length > 1)
    throw new Error(
      "Multiple pages have the same Zotero key. Resolve the duplicates first.",
    );
  if (exact.length) return exact[0].page;
  const d = normalizeDOI(values.DOI),
    a = arxivID(values["Paper URL"]) || arxivID(d),
    title = normalizeTitle(values["Journal Name"]);
  const candidates = normalized.filter(({ v }) => {
    const vd = normalizeDOI(v.DOI),
      va = arxivID(v["Paper URL"]) || arxivID(vd);
    if (d && vd && d !== vd && !(a && va === a)) return false;
    return (
      (d && vd === d) ||
      (a && a === va) ||
      (values["Paper URL"] &&
        v["Paper URL"] === values["Paper URL"] &&
        normalizeTitle(v["Journal Name"]) === title)
    );
  });
  if (candidates.length > 1)
    throw new Error("Multiple Notion pages appear to match this paper.");
  if (candidates.length) return candidates[0].page;
  if (normalized.some(({ v }) => normalizeTitle(v["Journal Name"]) === title))
    throw new Error("A page has the same title. Check the DOI or source link.");
  return null;
}
