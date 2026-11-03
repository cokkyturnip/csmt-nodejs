/**
 * Append-only progress journal used to resume interrupted imports.
 */

import fs from "node:fs";
import path from "node:path";
import { RowResult, SUCCESS_STATUSES } from "./report.js";

export class Journal {
  public path: string | null;
  private fd: number | null = null;

  constructor(journalPath?: string | null) {
    this.path = journalPath ? path.resolve(journalPath) : null;
  }

  get enabled(): boolean {
    return this.path !== null;
  }

  loadCompleted(): Record<number, Record<string, any>> {
    const completed: Record<number, Record<string, any>> = {};
    if (!this.path || !fs.existsSync(this.path)) {
      return completed;
    }

    const content = fs.readFileSync(this.path, "utf-8");
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (!line) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!entry || typeof entry !== "object") continue;

      const rawRow = entry.row;
      const status = String(entry.status || "");
      const row = Number.parseInt(String(rawRow), 10);
      if (Number.isNaN(row) || row <= 0) continue;

      if (SUCCESS_STATUSES.has(status)) {
        completed[row] = entry;
      } else if (["failed", "unknown", "aborted"].includes(status)) {
        delete completed[row];
      }
    }

    return completed;
  }

  record(result: RowResult): void {
    if (!this.path) return;
    if (result.status === "planned") return;

    const entry = {
      ts: result.finishedAt,
      row: result.lineno,
      key: result.dedupeKey,
      action: result.action,
      status: result.status,
      http_status: result.httpStatus ?? null,
      record_id: result.recordId ?? null,
      error: result.error ?? null,
    };

    if (this.fd === null) {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      this.fd = fs.openSync(this.path, "a");
    }

    const line = JSON.stringify(entry) + "\n";
    fs.writeSync(this.fd, line);
  }

  close(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } finally {
        this.fd = null;
      }
    }
  }
}
