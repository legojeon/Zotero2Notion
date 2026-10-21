export function allCollections() {
  return Zotero.Libraries.getAll().flatMap((l) =>
    Zotero.Collections.getByLibrary(l.libraryID).map((c) => ({
      id: c.id,
      key: `${c.libraryID}:${c.key}`,
      name: collectionName(c),
      libraryID: c.libraryID,
    })),
  );
}
function collectionName(c) {
  const names = [c.name];
  let p = c.parentID;
  while (p) {
    const parent = Zotero.Collections.get(p);
    if (!parent) break;
    names.unshift(parent.name);
    p = parent.parentID;
  }
  return names.join(" / ");
}
function text(html) {
  const doc = new (Zotero.getMainWindow().DOMParser)().parseFromString(
    html,
    "text/html",
  );
  return doc.body.textContent.trim();
}
async function citation(item, style, inText) {
  return new Promise((resolve, reject) => {
    try {
      const result = Zotero.QuickCopy.getContentFromItems(
        [item],
        `bibliography=${style}`,
        (o, worked) =>
          worked
            ? resolve(text(o.string))
            : reject(new Error("Zotero could not generate the citation.")),
        inText,
      );
      if (result === false) reject(new Error("Check the citation style."));
      else if (result !== true)
        resolve((result.text || text(result.html || "")).trim());
    } catch (e) {
      reject(e);
    }
  });
}
export async function extractItem(item, style) {
  const data = item.toJSON();
  const names = (type) =>
    (data.creators || [])
      .filter((p) => p.creatorType === type)
      .map((p) => p.name || [p.firstName, p.lastName].filter(Boolean).join(" "))
      .filter(Boolean)
      .join("; ");
  const collections = item
    .getCollections()
    .map((id) => Zotero.Collections.get(id))
    .filter(Boolean);
  const collectionKeys = new Set();
  for (const c of collections) {
    let current = c;
    while (current) {
      collectionKeys.add(`${current.libraryID}:${current.key}`);
      current = current.parentID
        ? Zotero.Collections.get(current.parentID)
        : null;
    }
  }
  const tags = item.getTags().map((t) => t.tag);
  const year = data.date?.match(/\b(?:19|20)\d{2}\b/)?.[0];
  const attachments = await Zotero.Items.getAsync(item.getAttachments());
  const files = [];
  for (const a of attachments) {
    const f = await a.getFilePathAsync();
    if (f) files.push(f);
  }
  const date = (value) => {
    if (!value) return "";
    return value.includes("T") ? value : value.replace(" ", "T") + "Z";
  };
  const url = data.url || (data.DOI ? `https://doi.org/${data.DOI}` : "");
  const values = {
    "Journal Name": data.title || item.getDisplayTitle(),
    "Paper URL": url,
    DOI: data.DOI || "",
    Authors: names("author"),
    Editors: names("editor"),
    Abstract: data.abstractNote || "",
    Publication:
      data.publicationTitle ||
      data.proceedingsTitle ||
      data.conferenceName ||
      "",
    Year: year ? Number(year) : null,
    "Zotero URI": Zotero.URI.getItemURI(item).replace(/^http:/, "https:"),
    "Zotero Key": `${item.libraryID}:${item.key}`,
    "Citation Key":
      data.citationKey ||
      (data.extra || "").match(/^Citation Key:\s*(.+)$/im)?.[1] ||
      "",
    Collections: collections.map(collectionName),
    "Date Added": date(data.dateAdded),
    "Date Modified": date(data.dateModified),
    Date: data.date || "",
    Extra: data.extra || "",
    "File Path": files.join("\n"),
    "Full Citation": await citation(item, style, false),
    "In-Text Citation": await citation(item, style, true),
    "Item Type": data.itemType,
    Place: data.place || "",
    "Proceedings Title": data.proceedingsTitle || "",
    "Series Title": data.seriesTitle || "",
    "Short Title": data.shortTitle || "",
    Tags: tags,
    Project: collections.length === 1 ? collections[0].name : "",
  };
  return {
    id: item.id,
    libraryID: item.libraryID,
    values,
    tags,
    collectionKeys: [...collectionKeys],
  };
}
export function inScope(item, config) {
  return (
    item.isRegularItem() &&
    !item.deleted &&
    item.libraryID === Number(config.libraryID)
  );
}
