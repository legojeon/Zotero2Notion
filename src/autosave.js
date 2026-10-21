// Owned by the plugin, so closing the preferences window cannot cancel a save.
export class Autosave {
  constructor({
    persist,
    isBusy = () => false,
    timers,
    onChange = () => {},
    now = Date.now,
  }) {
    Object.assign(this, { persist, isBusy, timers, onChange, now });
    this.entries = new Map();
    this.waiters = new Set();
    this.working = false;
    this.closed = false;
  }
  set(key, value, delay = 500) {
    if (this.closed) throw new Error("Settings are closing.");
    this.entries.set(key, {
      value: structuredClone(value),
      due: this.now() + delay,
      status: "pending",
      error: "",
    });
    this.changed();
    this.schedule();
  }
  draft(key) {
    const entry = this.entries.get(key);
    return entry && entry.status !== "saved"
      ? structuredClone(entry.value)
      : undefined;
  }
  status() {
    const entries = [...this.entries.values()];
    const errors = entries.filter((e) => e.status === "error");
    if (errors.length)
      return { state: "error", message: errors.map((e) => e.error).join("\n") };
    if (entries.some((e) => e.status === "pending" || e.status === "saving"))
      return {
        state: "pending",
        message:
          this.isBusy() && !this.working ? "Waiting for sync…" : "Saving…",
      };
    return { state: "saved", message: "Saved" };
  }
  changed() {
    this.onChange();
    for (const waiter of this.waiters) {
      const entries = waiter.keys
        .map((k) => this.entries.get(k))
        .filter(Boolean);
      if (entries.some((e) => e.status === "pending" || e.status === "saving"))
        continue;
      this.waiters.delete(waiter);
      const error = entries.find((e) => e.status === "error");
      if (error) waiter.reject(new Error(error.error));
      else waiter.resolve();
    }
  }
  schedule() {
    this.timers.clearTimeout(this.timer);
    if (this.closed || this.working) return;
    const pending = [...this.entries.values()].filter(
      (e) => e.status === "pending",
    );
    if (!pending.length) return;
    const delay = this.isBusy()
      ? 100
      : Math.max(0, Math.min(...pending.map((e) => e.due)) - this.now());
    this.timer = this.timers.setTimeout(() => this.drain(), delay);
  }
  async drain() {
    if (this.closed || this.working) return;
    if (this.isBusy()) {
      this.changed();
      this.schedule();
      return;
    }
    this.working = true;
    try {
      for (const [key, entry] of this.entries) {
        if (entry.status !== "pending" || entry.due > this.now()) continue;
        if (this.isBusy()) break;
        entry.status = "saving";
        this.changed();
        try {
          await this.persist(key, structuredClone(entry.value));
          if (this.entries.get(key) === entry) entry.status = "saved";
        } catch (error) {
          if (this.entries.get(key) === entry) {
            entry.status = "error";
            entry.error = error.message || String(error);
          }
        }
        this.changed();
      }
    } finally {
      this.working = false;
      this.changed();
      this.schedule();
    }
  }
  flush(keys = [...this.entries.keys()]) {
    keys = typeof keys === "string" ? [keys] : keys;
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry?.status === "pending") entry.due = this.now();
    }
    const done = new Promise((resolve, reject) =>
      this.waiters.add({ keys, resolve, reject }),
    );
    this.changed();
    this.schedule();
    return done;
  }
  cancel(key) {
    this.entries.delete(key);
    this.changed();
    this.schedule();
  }
  retry() {
    for (const entry of this.entries.values())
      if (entry.status === "error") {
        entry.status = "pending";
        entry.error = "";
        entry.due = this.now();
      }
    this.changed();
    this.schedule();
    return this.flush();
  }
  async close() {
    try {
      await this.flush();
    } finally {
      this.closed = true;
      this.timers.clearTimeout(this.timer);
    }
  }
}
