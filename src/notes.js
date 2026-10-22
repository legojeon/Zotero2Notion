export const NOTES_TOKEN = "[zotero_notes]";

// A block insertion point, not an inline metadata variable. Ignore code examples.
export function notesPlacement(markdown, { page = false } = {}) {
  let fence = "", offset = 0, found;
  for (const line of markdown.split(/(?<=\n)/)) {
    const trimmed = line.trim();
    const code = trimmed.match(/^(`{3,}|~{3,})/);
    if (code) {
      if (!fence) fence = code[1];
      else if (code[1][0] === fence[0] && code[1].length >= fence.length) fence = "";
    } else if (!fence && (page ? [NOTES_TOKEN, "\\[zotero_notes\\]"].includes(trimmed) : trimmed.includes(NOTES_TOKEN))) {
      if ((trimmed !== NOTES_TOKEN && !(page && trimmed === "\\[zotero_notes\\]")) || found)
        throw new Error("Use [zotero_notes] once, on its own line in the template.");
      found = { before: markdown.slice(0, offset), after: markdown.slice(offset + line.length) };
      if (page) found.token = trimmed;
    }
    offset += line.length;
  }
  return found;
}

export const escapeNoteText = (text) => String(text).replace(/[\\*_!#~`$\[\]<>{}|^]/g, "\\$&");
export const indent = (text) => text.split("\n").map((line) => "\t" + line).join("\n");
export const noteLink = (note) => note.uri.replace(/#.*$/, "") + "#z2n-note";
export const groupLink = (item) => item.values["Zotero URI"].replace(/#.*$/, "") + "#z2n-notes";
export const wrapNote = (note, markdown) =>
  `<details>\n<summary>[${escapeNoteText((note.title || "Untitled note").replace(/\s+/g, " "))}](${noteLink(note)})</summary>\n${indent(markdown)}\n\t[Source note](${noteLink(note)}-end)\n</details>`;
export const wrapNotes = (item, notes) =>
  `<details>\n<summary>[Zotero Notes](${groupLink(item)})</summary>\n${indent(notes.join("\n"))}\n</details>`;

export async function digest(text) {
  const result = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(result), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Signed Notion image URLs expire; their signatures are not user edits.
export const canonicalNote = (text) => text.replace(
  /https:\/\/[^\s)"<>]+/g,
  (value) => {
    try {
      const url = new URL(value);
      if (/(?:^|\.)(?:amazonaws\.com|notion\.so|notionusercontent\.com)$/.test(url.hostname))
        url.search = "";
      return url.href;
    } catch { return value; }
  },
);

// Identify complete toggles and validate their boundaries before any write.
export function findNoteToggle(markdown, link) {
  const stack = [], matches = [];
  let offset = 0, fence = "";
  for (const line of markdown.split(/(?<=\n)/)) {
    const trim = line.trim(), code = trim.match(/^(`{3,}|~{3,})/);
    if (code) {
      if (!fence) fence = code[1];
      else if (code[1][0] === fence[0] && code[1].length >= fence.length) fence = "";
    } else if (!fence) {
      if (/^<details(?:\s[^>]*)?>$/.test(trim))
        stack.push({ start: offset, indent: line.match(/^\s*/)[0].replace(/\n/g, ""), summary: "" });
      else if (/^<summary>/.test(trim) && stack.length)
        stack[stack.length - 1].summary = line.trimEnd();
      else if (trim === "</details>" && stack.length) {
        const block = stack.pop();
        if (block.summary.includes(`](${link})`))
          matches.push({ ...block, text: markdown.slice(block.start, offset + line.trimEnd().length) });
      }
    }
    offset += line.length;
  }
  if (matches.length > 1) throw new Error("Duplicate Zotero note sections found in Notion. Keep one copy before syncing.");
  return matches[0];
}

function complete(result) {
  if (result.truncated || result.unknown_block_ids?.length)
    throw new Error("Notion could not read the complete page. Zotero notes were left unchanged.");
  return result.markdown || "";
}

export class NotesSync {
  constructor({ api, store, readNotes, renderNote }) {
    Object.assign(this, { api, store, readNotes, renderNote });
  }
  async sync(item, record, placement) {
    if (!placement) return; // Removing the token stops syncing; never deletes old notes.
    const notes = await this.readNotes(item);
    const state = record.notes ||= { entries: {} };
    if (state.pending)
      throw new Error("A Zotero note update is unconfirmed. Open Advanced → Check incomplete and review it before retrying.");
    let markdown = complete(await this.api.markdown(record.pageID));
    let group = findNoteToggle(markdown, groupLink(item));
    if (state.created && !group)
      throw new Error("The Zotero Notes section was removed or renamed in Notion. Restore it to resume note sync.");
    if (group && !state.created)
      throw new Error("An untracked Zotero Notes section already exists. It will not be overwritten.");
    const placeholder = !group && notesPlacement(markdown, { page: true });
    if (!group && !notes.length) {
      if (placeholder) {
        state.anchor = { before: placeholder.before, after: placeholder.after };
        await this.store.saveState();
        await this.api.editMarkdown(record.pageID, placeholder.token, "");
      }
      return;
    }
    const write = async (operation, changes, images = []) => {
      state.pending = { changes, images };
      await this.store.saveState();
      let result;
      try { result = await operation(); }
      catch (error) {
        // A rejected request did not apply. Timeouts/5xx remain uncertain.
        if (error.status >= 400 && error.status < 500 && error.status !== 408) {
          delete state.pending;
          await this.store.saveState();
        }
        throw error;
      }
      markdown = complete(result);
      if (result.warnings?.length)
        throw new Error("Notion reported a note conversion warning. Review Check incomplete before continuing.");
      if (images.length) {
        await this.api.finishNoteImages(record.pageID, images);
        markdown = complete(await this.api.markdown(record.pageID));
      }
      for (const [key, change] of Object.entries(changes)) {
        const block = findNoteToggle(findNoteToggle(markdown, groupLink(item))?.text || "", change.link);
        if (!block) throw new Error("The new Zotero note could not be verified. Review Check incomplete.");
        state.entries[key] = { ...change, remoteHash: await digest(canonicalNote(block.text)) };
      }
      state.created = true;
      delete state.pending;
      await this.store.saveState();
      group = findNoteToggle(markdown, groupLink(item));
    };
    if (!group) {
      const blocks = [], changes = {}, images = [];
      for (const note of notes) {
        const rendered = await this.renderNote(note);
        blocks.push(wrapNote(note, rendered.markdown));
        images.push(...(rendered.images || []));
        changes[note.key] = { sourceHash: await digest(note.html), link: noteLink(note) };
      }
      const content = wrapNotes(item, blocks);
      if (placeholder) {
        await write(() => this.api.editMarkdown(record.pageID, placeholder.token, content), changes, images);
      } else if (!placement.after.trim()) {
        await write(() => this.api.appendMarkdown(record.pageID, content), changes, images);
      } else if (!placement.before.trim()) {
        await write(() => this.api.insertMarkdown(record.pageID, content, "start"), changes, images);
      } else if (state.anchor?.after.trim() && markdown.includes(state.anchor.after.trim())) {
        const anchor = state.anchor.after.trim();
        await write(() => this.api.editMarkdown(record.pageID, anchor, content + "\n\n" + anchor), changes, images);
      } else {
        throw new Error("To place Zotero notes in this existing page, add [zotero_notes] on its own line in Notion, then retry.");
      }
      return;
    }
    for (const note of notes) {
      const sourceHash = await digest(note.html), link = noteLink(note);
      const previous = state.entries[note.key];
      if (previous?.sourceHash === sourceHash) continue;
      const current = findNoteToggle(group.text, link);
      if (previous && (!current || await digest(canonicalNote(current.text)) !== previous.remoteHash)) {
        state.conflict = true;
        await this.store.saveState();
        throw new Error(`“${note.title}” was edited in Notion. Its content was preserved. Review it under Advanced → Check incomplete.`);
      }
      if (!previous && current)
        throw new Error(`“${note.title}” already exists in Notion without a sync record. It was preserved.`);
      const result = await this.renderNote(note);
      const rendered = indent(wrapNote(note, result.markdown));
      const changes = { [note.key]: { sourceHash, link } };
      if (current) {
        await write(async () => {
          // Uploads may take time. Check again immediately before changing a note.
          const latest = complete(await this.api.markdown(record.pageID));
          const fresh = findNoteToggle(findNoteToggle(latest, groupLink(item))?.text || "", link);
          if (!fresh || await digest(canonicalNote(fresh.text)) !== previous.remoteHash) {
            state.conflict = true;
            throw Object.assign(new Error("This note changed in Notion during sync. It was preserved. Review Check incomplete."), { status: 409 });
          }
          // Signed image URLs differ even between consecutive server reads. A
          // range bounded by this note's unique title and source link avoids
          // matching those URLs or spanning another note. Plain notes use exact CAS.
          if (/!\[[^\n]*\]\(https:\/\/[^\s)]*(?:amazonaws\.com|notionusercontent\.com)/.test(fresh.text)) {
            const start = fresh.indent + "<details>\n" + fresh.summary;
            const end = `${fresh.indent}\t[Source note](${link}-end)\n${fresh.indent}</details>`;
            if (!fresh.text.startsWith(start) || !fresh.text.endsWith(end))
              throw Object.assign(new Error("Restore this note's Source note link in Notion before syncing."), { status: 409 });
            return this.api.replaceNoteRange(record.pageID, start + "..." + end, rendered);
          }
          return this.api.editMarkdown(record.pageID, fresh.text, rendered);
        }, changes, result.images);
      } else {
        const summary = group.summary;
        await write(() => this.api.editMarkdown(record.pageID, summary, summary + "\n" + rendered), changes, result.images);
      }
    }
  }
  async acceptCurrent(item, record) {
    if (record.notes.pending?.images?.length)
      await this.api.finishNoteImages(record.pageID, record.notes.pending.images, true);
    const markdown = complete(await this.api.markdown(record.pageID));
    const state = record.notes;
    const group = findNoteToggle(markdown, groupLink(item));
    if (!group && state.created)
      throw new Error("Restore the Zotero Notes section in Notion before reviewing its notes.");
    const notes = await this.readNotes(item);
    for (const note of notes) {
      const block = findNoteToggle(group?.text || "", noteLink(note));
      if (state.entries[note.key] && !block)
        throw new Error(`Restore “${note.title}” and its source link in Notion before reviewing it.`);
      if (block) state.entries[note.key] = {
        link: noteLink(note), sourceHash: await digest(note.html),
        remoteHash: await digest(canonicalNote(block.text)),
      };
    }
    state.created = !!group;
    delete state.pending;
    delete state.conflict;
    await this.store.saveState();
  }
}
