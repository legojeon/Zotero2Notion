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
  async request(method, path, body, { safe = true } = {}) {
    const token = await this.token();
    for (let n = 0; n < 4; n++) {
      let response;
      try {
        response = await this.fetch("https://api.notion.com/v1" + path, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            "Notion-Version": "2026-03-11",
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
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
    return this.request(
      "PATCH",
      `/pages/${id}/markdown`,
      {
        type: "insert_content",
        insert_content: { content, position: { type: "end" } },
      },
      { safe: false },
    );
  }
}
