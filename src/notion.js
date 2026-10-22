export class NotionError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}
export class NotionClient {
  constructor({
    token,
    fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  }) {
    Object.assign(this, { token, fetch, sleep });
  }
  async request(method, path, body, { safe = true, multipart = false } = {}) {
    const token = await this.token();
    for (let n = 0; n < 4; n++) {
      let response;
      try {
        response = await this.fetch("https://api.notion.com/v1" + path, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            "Notion-Version": "2026-03-11",
            ...(multipart ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
          signal: AbortSignal.timeout(45000),
        });
      } catch {
        if (safe && n < 3) {
          await this.sleep(1000 * 2 ** n);
          continue;
        }
        throw new NotionError(
          "No response from Notion. Check your connection and try again.",
        );
      }
      if (response.status === 401)
        throw new NotionError(
          "Your personal access token is no longer valid. Create a new token and reconnect.",
          401,
        );
      if (
        (response.status === 429 || (safe && response.status >= 500)) &&
        n < 3
      ) {
        await this.sleep(
          Math.min(
            60000,
            Math.max(
              1000,
              Number(response.headers.get("Retry-After") || 2 ** n) * 1000,
            ),
          ),
        );
        continue;
      }
      let data;
      try {
        data = await response.json();
      } catch {
        throw new NotionError(
          "Notion returned an unexpected response format.",
          response.status,
        );
      }
      if (!response.ok) {
        const message =
          response.status === 403
            ? "This connection cannot edit the page. Check its permissions in Notion."
            : response.status === 404
              ? "The page does not exist or is not shared with this connection."
              : response.status === 429
                ? "Notion is limiting requests. Try again in a moment."
                : `Notion request failed (${response.status}): ${String(data.message || "").slice(0, 300)}`;
        throw new NotionError(message, response.status);
      }
      return data;
    }
  }
  async pages(path, body = {}) {
    let all = [],
      cursor;
    do {
      const r = await this.request("POST", path, {
        ...body,
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      all.push(...r.results);
      cursor = r.has_more ? r.next_cursor : null;
    } while (cursor);
    return all;
  }
  me() {
    return this.request("GET", "/users/me");
  }
  sources() {
    return this.pages("/search", {
      filter: { value: "data_source", property: "object" },
      sort: { direction: "descending", timestamp: "last_edited_time" },
    });
  }
  schema(id) {
    return this.request("GET", `/data_sources/${id}`);
  }
  rows(id) {
    return this.pages(`/data_sources/${id}/query`);
  }
  page(id) {
    return this.request("GET", `/pages/${id}`);
  }
  createWorkspacePage() {
    return this.request(
      "POST",
      "/pages",
      {
        parent: { type: "workspace", workspace: true },
        properties: {
          title: {
            title: [{ type: "text", text: { content: "Zotero2Notion" } }],
          },
        },
      },
      { safe: false },
    );
  }
  createDatabase(pageID, properties) {
    return this.request(
      "POST",
      "/databases",
      {
        parent: { type: "page_id", page_id: pageID },
        title: [{ type: "text", text: { content: "JournalDB" } }],
        is_inline: true,
        initial_data_source: { properties },
      },
      { safe: false },
    );
  }
  database(id) {
    return this.request("GET", `/databases/${id}`);
  }
  update(id, properties) {
    return this.request("PATCH", `/pages/${id}`, { properties });
  }
  create(id, properties) {
    return this.request(
      "POST",
      "/pages",
      { parent: { type: "data_source_id", data_source_id: id }, properties },
      { safe: false },
    );
  }
  addProperties(id, properties) {
    return this.request("PATCH", `/data_sources/${id}`, { properties });
  }
  markdown(id) {
    return this.request("GET", `/pages/${id}/markdown`);
  }
  appendMarkdown(id, content) {
    return this.insertMarkdown(id, content, "end");
  }
  insertMarkdown(id, content, position) {
    return this.request(
      "PATCH",
      `/pages/${id}/markdown`,
      {
        type: "insert_content",
        insert_content: { content, position: { type: position } },
      },
      { safe: false },
    );
  }
  editMarkdown(id, old_str, new_str) {
    return this.request("PATCH", `/pages/${id}/markdown`, {
      type: "update_content",
      update_content: { content_updates: [{ old_str, new_str }] },
    }, { safe: false });
  }
  replaceNoteRange(id, content_range, content) {
    return this.request("PATCH", `/pages/${id}/markdown`, {
      type: "replace_content_range",
      replace_content_range: { content_range, content },
    }, { safe: false });
  }
  async uploadNoteImage(bytes, contentType) {
    if (!bytes.length || bytes.length > 20 * 1024 * 1024)
      throw new Error("A note image is empty or larger than 20 MB. Resize it in Zotero before syncing.");
    const extensions = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
    if (!extensions[contentType]) throw new Error("Convert this note image to PNG, JPEG, GIF, or WebP before syncing.");
    const filename = "note-image." + extensions[contentType];
    const upload = await this.request("POST", "/file_uploads", {
      mode: "single_part", filename, content_type: contentType,
    }, { safe: false });
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: contentType }), filename);
    const result = await this.request("POST", `/file_uploads/${upload.id}/send`, form, { safe: false, multipart: true });
    if (result.status !== "uploaded") throw new Error("Notion could not finish uploading a note image.");
    return upload.id;
  }
  async children(id) {
    const blocks = [];
    let cursor;
    do {
      const result = await this.request("GET", `/blocks/${id}/children?page_size=100${cursor ? "&start_cursor=" + encodeURIComponent(cursor) : ""}`);
      blocks.push(...result.results);
      cursor = result.has_more ? result.next_cursor : null;
    } while (cursor);
    return blocks;
  }
  async finishNoteImages(pageID, images, allowMissing = false) {
    if (!images.length) return;
    const pending = new Map(images.map((image) => [image.marker, image]));
    const visit = async (id, noteScope = null) => {
      for (const block of await this.children(id)) {
        let scope = noteScope;
        if (block.type === "toggle") {
          const links = (block.toggle.rich_text || []).map((r) => r.href || r.text?.link?.url);
          scope = images.find((image) => links.includes(image.noteLink))?.noteLink || scope;
        }
        if (block.type === "image" && scope) {
          const marker = (block.image.caption || []).map((r) => r.plain_text ?? r.text?.content ?? "").join("");
          const image = pending.get(marker);
          if (image?.noteLink === scope) {
            await this.request("PATCH", `/blocks/${block.id}`, { image: {
              file_upload: { id: image.id },
              caption: image.caption ? [{ type: "text", text: { content: image.caption.slice(0, 2000) } }] : [],
            } });
            pending.delete(marker);
          }
        }
        if (block.has_children && !["child_page", "child_database", "synced_block"].includes(block.type))
          await visit(block.id, scope);
      }
    };
    await visit(pageID);
    if (pending.size && !allowMissing) throw new Error("A note image could not be located after upload. Review Check incomplete.");
  }
}
