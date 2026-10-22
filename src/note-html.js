import { escapeNoteText } from "./notes.js";

// Zotero stores notes as HTML. Convert only document content; never execute it.
export async function noteHTMLToMarkdown(html, { parse, image }) {
  const doc = parse(html);
  const join = async (node) => {
    let result = "";
    for (const child of node.childNodes) result += await render(child);
    return result;
  };
  const block = (content) => content.trim() ? "\n\n" + content.trim() + "\n\n" : "";
  const indent = (value) => value.split("\n").map((s) => "\t" + s).join("\n");
  const safeURL = (url) => /^(https?:|zotero:|mailto:)/i.test(url || "")
    ? url.replace(/[\s()<>]/g, (c) => encodeURIComponent(c)) : "";
  async function render(node) {
    if (node.nodeType === 3) return escapeNoteText(node.textContent.replace(/[\t\r\n]+/g, " "));
    if (node.nodeType !== 1) return "";
    const tag = node.localName.toLowerCase();
    if (["script", "style", "iframe", "object", "input", "button"].includes(tag)) return "";
    if (node.hasAttribute("data-annotation")) {
      const clone = node.cloneNode(true);
      clone.removeAttribute("data-annotation");
      const content = await render(clone);
      try {
        const data = JSON.parse(decodeURIComponent(node.getAttribute("data-annotation")));
        const key = (data.attachmentURI || data.uri || "").match(/\/items\/([A-Z0-9]+)$/)?.[1];
        const page = Number(data.position?.pageIndex) + 1;
        if (key && Number.isFinite(page) && page > 0)
          return content + ` [PDF p. ${page}](zotero://open-pdf/library/items/${key}?page=${page}${data.annotationKey ? "&annotation=" + encodeURIComponent(data.annotationKey) : ""})`;
      } catch { /* Retain the visible quote even if old metadata is malformed. */ }
      return content;
    }
    if (node.classList?.contains("citation") && node.hasAttribute("data-citation")) {
      const content = await join(node);
      try {
        const data = JSON.parse(decodeURIComponent(node.getAttribute("data-citation")));
        const uri = safeURL(data.citationItems?.[0]?.uris?.[0]);
        if (uri) return `[${content}](${uri})`;
      } catch { /* Plain citation text is still useful. */ }
      return content;
    }
    if (node.classList?.contains("math")) {
      let value = node.textContent.trim();
      const display = tag === "pre" || value.startsWith("$$");
      value = value.replace(/^\$\$?|\$\$?$/g, "");
      return display ? block("$$\n" + value + "\n$$") : "$`" + value + "`$";
    }
    if (tag === "img") return block(await image(node));
    if (tag === "br") return "<br>";
    if (tag === "hr") return "\n\n---\n\n";
    if (tag === "pre") {
      const value = node.textContent;
      const fences = Math.max(3, ...Array.from(value.matchAll(/`+/g), (m) => m[0].length + 1));
      const fence = "`".repeat(fences);
      return block(fence + "\n" + value + "\n" + fence);
    }
    if (tag === "code") {
      const value = node.textContent.replace(/\n/g, "<br>");
      const fence = "`".repeat(Math.max(1, ...Array.from(value.matchAll(/`+/g), (m) => m[0].length + 1)));
      return fence + value + fence;
    }
    if (tag === "ul" || tag === "ol") {
      let output = "", number = Number(node.getAttribute("start")) || 1;
      for (const li of Array.from(node.children).filter((n) => n.localName === "li")) {
        let content = (await join(li)).trim();
        const prefix = tag === "ol" ? `${number++}. ` : "- ";
        const lines = content.split(/\n+/);
        output += prefix + (lines.shift() || "") + "\n";
        if (lines.length) output += indent(lines.join("\n")) + "\n";
      }
      return block(output);
    }
    if (tag === "table") {
      const rows = Array.from(node.querySelectorAll("tr"));
      const width = Math.max(0, ...rows.map((r) => r.children.length));
      const result = [];
      for (const row of rows) {
        const cells = [];
        for (const cell of Array.from(row.children)) {
          if (cell.querySelector("img, table, pre, ul, ol"))
            throw new Error("Move images, code blocks, and lists out of note table cells before syncing.");
          if (Number(cell.getAttribute("colspan") || 1) > 1 || Number(cell.getAttribute("rowspan") || 1) > 1)
            throw new Error("A Zotero note contains merged table cells. Unmerge them before syncing.");
          cells.push((await join(cell)).trim().replace(/\n+/g, "<br>"));
        }
        while (cells.length < width) cells.push("");
        result.push("\t<tr>\n" + cells.map((c) => `\t\t<td>${c}</td>`).join("\n") + "\n\t</tr>");
      }
      return block(`<table header-row="${!!rows[0]?.querySelector("th")}">\n${result.join("\n")}\n</table>`);
    }
    let content = await join(node);
    if (["strong", "b"].includes(tag)) return content ? `**${content}**` : "";
    if (["em", "i"].includes(tag)) return content ? `*${content}*` : "";
    if (["del", "s", "strike"].includes(tag)) return content ? `~~${content}~~` : "";
    if (tag === "u" || node.style?.textDecoration?.includes("underline"))
      return `<span underline="true">${content}</span>`;
    if (tag === "a") {
      const href = safeURL(node.getAttribute("href"));
      return href ? `[${content}](${href})` : content;
    }
    if (/^h[1-6]$/.test(tag)) return block("#".repeat(Math.min(4, Number(tag[1]))) + " " + content.trim());
    if (tag === "blockquote") return block("> " + content.trim().replace(/\n+/g, "<br>"));
    if (["p", "div", "section"].includes(tag)) return block(content);
    return content;
  }
  return (await join(doc.body)).trim();
}
