/**
 * Per-row results, the CSV report and the run summary.
 */

import fs from "node:fs";
import path from "node:path";
import { stringify } from "csv-stringify";

export const SUCCESS_STATUSES = new Set(["created", "updated", "skipped"]);
export const FAILURE_STATUSES = new Set(["failed", "unknown"]);

export const REPORT_COLUMNS = [
  "row",
  "key",
  "action",
  "status",
  "http_status",
  "record_id",
  "error",
] as const;

export class RowResult {
  public lineno: number;
  public dedupeKey: string;
  public action: string;
  public status: string;
  public recordId?: string | null;
  public httpStatus?: number | null;
  public error?: string | null;
  public finishedAt: string;

  constructor(opts: {
    lineno: number;
    dedupeKey: string;
    action: string;
    status: string;
    recordId?: string | null;
    httpStatus?: number | null;
    error?: string | null;
    finishedAt?: string;
  }) {
    this.lineno = opts.lineno;
    this.dedupeKey = opts.dedupeKey;
    this.action = opts.action;
    this.status = opts.status;
    this.recordId = opts.recordId;
    this.httpStatus = opts.httpStatus;
    this.error = opts.error;
    this.finishedAt = opts.finishedAt || new Date().toISOString().slice(0, 19) + "Z";
  }

  get ok(): boolean {
    return SUCCESS_STATUSES.has(this.status);
  }
}

export class Summary {
  public total = 0;
  public created = 0;
  public updated = 0;
  public skipped = 0;
  public planned = 0;
  public failed = 0;
  public unknown = 0;
  public resumed = 0;
  public durationSeconds = 0.0;
  public reportPath?: string | null;
  public journalPath?: string | null;

  constructor(opts?: { reportPath?: string | null; journalPath?: string | null }) {
    this.reportPath = opts?.reportPath;
    this.journalPath = opts?.journalPath;
  }

  add(result: RowResult, resumed = false): void {
    this.total += 1;
    if (resumed) this.resumed += 1;

    switch (result.status) {
      case "created":
        this.created += 1;
        break;
      case "updated":
        this.updated += 1;
        break;
      case "skipped":
        this.skipped += 1;
        break;
      case "planned":
        this.planned += 1;
        break;
      case "failed":
        this.failed += 1;
        break;
      case "unknown":
        this.unknown += 1;
        break;
    }
  }

  get hasFailures(): boolean {
    return this.failed > 0 || this.unknown > 0;
  }

  asDict(): Record<string, any> {
    return {
      total: this.total,
      created: this.created,
      updated: this.updated,
      skipped: this.skipped,
      planned: this.planned,
      failed: this.failed,
      unknown: this.unknown,
      resumed: this.resumed,
      duration_seconds: Math.round(this.durationSeconds * 100) / 100,
      report_path: this.reportPath,
      journal_path: this.journalPath,
    };
  }

  log(logger?: { info: (msg: string) => void }): void {
    const logFn = logger ? logger.info.bind(logger) : console.log;
    logFn(
      `Done: total=${this.total} created=${this.created} updated=${this.updated} skipped=${this.skipped} planned=${this.planned} failed=${this.failed} unknown=${this.unknown} resumed=${this.resumed} in ${this.durationSeconds.toFixed(1)}s`
    );
  }
}

export class ReportWriter {
  public path?: string | null;
  public summary: Summary;
  private writeStream?: fs.WriteStream;
  private stringifier?: any;

  constructor(reportPath?: string | null) {
    this.path = reportPath ? path.resolve(reportPath) : null;
    this.summary = new Summary({ reportPath: this.path });
  }

  private ensureWriter(): void {
    if (!this.path) return;
    if (!this.writeStream) {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      this.writeStream = fs.createWriteStream(this.path, { encoding: "utf-8" });
      this.stringifier = stringify({ header: true, columns: [...REPORT_COLUMNS] });
      this.stringifier.pipe(this.writeStream);
    }
  }

  add(result: RowResult, resumed = false): void {
    this.summary.add(result, resumed);
    if (!this.path) return;
    this.ensureWriter();

    this.stringifier.write({
      row: result.lineno,
      key: result.dedupeKey,
      action: result.action,
      status: result.status,
      http_status: result.httpStatus ?? "",
      record_id: result.recordId ?? "",
      error: (result.error || "").replace(/\n/g, " ").slice(0, 1000),
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.stringifier || !this.writeStream) {
        resolve();
        return;
      }
      this.stringifier.end(() => {
        this.writeStream!.end(() => {
          resolve();
        });
      });
    });
  }

  writeSummaryJson(targetPath?: string | null): string | null {
    let out = targetPath ? path.resolve(targetPath) : null;
    if (!out && this.path) {
      out = this.path.replace(/\.[^/.]+$/, "") + ".summary.json";
    }
    if (!out) return null;

    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(this.summary.asDict(), null, 2), "utf-8");
    return out;
  }
}
