/**
 * The import orchestrator.
 */

import { ODataClient, odataEscape } from "./client.js";
import { Settings } from "./config.js";
import { BatchError, ConfigError, MappingError, ODataError, ValidationError } from "./errors.js";
import { Journal } from "./journal.js";
import { Mapper, PreparedRow } from "./mapping.js";
import { ReportWriter, RowResult, Summary } from "./report.js";
import { TabularSource } from "./tabular.js";
import { getLogger } from "./logger.js";

export const MODES = ["create", "update", "upsert"] as const;
export type ImportMode = (typeof MODES)[number];

export const DUPLICATE_POLICIES = ["error", "first_wins", "last_wins"] as const;
export type DuplicatePolicy = (typeof DUPLICATE_POLICIES)[number];

const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function normalise(val: unknown): string {
  return String(val ?? "").trim().toLowerCase();
}

function looksLikeGuid(val: unknown): boolean {
  return GUID_RE.test(String(val ?? "").trim());
}

export class ExistingIndex {
  public cache: Map<string, string | null> = new Map();

  constructor(
    public client: ODataClient,
    public entity: string,
    public keyFields: string[],
    public quoteFields: Record<string, boolean> = {},
    public chunkChars = 1400
  ) {}

  literal(fieldName: string, value: unknown): string {
    let quote = this.quoteFields[fieldName];
    if (quote === undefined) {
      quote = !(fieldName.endsWith("Id") && (looksLikeGuid(value) || /^\d+$/.test(String(value).trim())));
    }
    if (quote) {
      return `'${odataEscape(value)}'`;
    }
    return String(value);
  }

  clause(keyValues: Record<string, any>): string {
    const parts = this.keyFields.map((name) => `${name} eq ${this.literal(name, keyValues[name])}`);
    return `(${parts.join(" and ")})`;
  }

  cacheKey(keyValues: Record<string, any>): string {
    return this.keyFields.map((name) => normalise(keyValues[name])).join("|");
  }

  private *chunks(rows: Array<Record<string, any>>): Generator<Array<Record<string, any>>> {
    let chunk: Array<Record<string, any>> = [];
    let size = 0;
    for (const row of rows) {
      const cl = this.clause(row);
      if (chunk.length > 0 && (size + cl.length > this.chunkChars || chunk.length >= 30)) {
        yield chunk;
        chunk = [];
        size = 0;
      }
      chunk.push(row);
      size += cl.length + 4;
    }
    if (chunk.length > 0) {
      yield chunk;
    }
  }

  async preload(rows: Iterable<Record<string, any>>): Promise<void> {
    const pending: Array<Record<string, any>> = [];
    const seen = new Set<string>();

    for (const row of rows) {
      const ck = this.cacheKey(row);
      if (this.cache.has(ck) || seen.has(ck)) continue;
      seen.add(ck);
      pending.push(row);
    }

    for (const chunk of this.chunks(pending)) {
      const filterText = chunk.map((r) => this.clause(r)).join(" or ");
      const select = ["Id", ...this.keyFields.filter((k) => k !== "Id")];

      let items: any[];
      try {
        const [ret] = await this.client.getCollection(this.entity, {
          filter: filterText,
          select,
          top: Math.max(chunk.length * 4, 20),
        });
        items = ret;
      } catch (err: unknown) {
        if (err instanceof ODataError) {
          throw new ODataError(`Key lookup failed: ${err.detail}`, {
            status: err.status,
            code: err.code,
            payload: err.payload,
            method: "GET",
            url: err.url,
          });
        }
        throw err;
      }

      const found = new Map<string, string>();
      for (const item of items) {
        if (!item || item.Id === undefined) continue;
        const rk = this.keyFields.map((name) => normalise(item[name])).join("|");
        if (!found.has(rk)) {
          found.set(rk, String(item.Id));
        } else {
          console.warn(`WARNING: Multiple existing records match key ${JSON.stringify(rk)} in ${this.entity}; using first id ${found.get(rk)}`);
        }
      }

      for (const row of chunk) {
        const ck = this.cacheKey(row);
        this.cache.set(ck, found.get(ck) ?? null);
      }
    }
  }

  get(keyValues: Record<string, any>): string | null | undefined {
    return this.cache.get(this.cacheKey(keyValues));
  }

  remember(keyValues: Record<string, any>, recordId: string | null): void {
    this.cache.set(this.cacheKey(keyValues), recordId);
  }
}

export interface PipelineOptionsArgs {
  mode?: ImportMode;
  batchSize?: number;
  useBatch?: boolean;
  dryRun?: boolean;
  limit?: number | null;
  createMissing?: boolean;
  skipExisting?: boolean;
  continueOnError?: boolean;
  duplicatePolicy?: DuplicatePolicy;
  resume?: boolean;
  strictSources?: boolean;
  progressEvery?: number;
  chunkRows?: number;
  maxErrors?: number;
}

export class PipelineOptions {
  public mode: ImportMode;
  public batchSize: number;
  public useBatch: boolean;
  public dryRun: boolean;
  public limit?: number | null;
  public createMissing: boolean;
  public skipExisting: boolean;
  public continueOnError: boolean;
  public duplicatePolicy: DuplicatePolicy;
  public resume: boolean;
  public strictSources: boolean;
  public progressEvery: number;
  public chunkRows: number;
  public maxErrors: number;

  constructor(opts: PipelineOptionsArgs = {}) {
    this.mode = opts.mode || "upsert";
    if (!MODES.includes(this.mode)) {
      throw new ConfigError(`Unknown mode ${JSON.stringify(this.mode)}; expected one of ${MODES.join(", ")}`);
    }

    this.duplicatePolicy = opts.duplicatePolicy || "error";
    if (!DUPLICATE_POLICIES.includes(this.duplicatePolicy)) {
      throw new ConfigError(
        `Unknown duplicate policy ${JSON.stringify(this.duplicatePolicy)}; expected one of ${DUPLICATE_POLICIES.join(", ")}`
      );
    }

    this.batchSize = opts.batchSize ?? 50;
    if (this.batchSize < 1 || this.batchSize > 100) {
      throw new ConfigError("batch_size must be between 1 and 100 (Creatio limit)");
    }

    this.useBatch = opts.useBatch ?? true;
    this.dryRun = Boolean(opts.dryRun);
    this.limit = opts.limit ?? null;
    this.createMissing = Boolean(opts.createMissing);
    this.skipExisting = Boolean(opts.skipExisting);
    this.continueOnError = opts.continueOnError ?? true;
    this.resume = Boolean(opts.resume);
    this.strictSources = Boolean(opts.strictSources);
    this.progressEvery = opts.progressEvery ?? 200;
    this.chunkRows = Math.max(opts.chunkRows ?? 500, this.batchSize);
    this.maxErrors = opts.maxErrors ?? 0;
  }
}

export class Operation {
  constructor(
    public prepared: PreparedRow,
    public action: string,
    public recordId?: string | null
  ) {}

  get dedupeKey(): string {
    return this.prepared.keyText;
  }
}

export class Decision {
  constructor(
    public action: string, // create | update | skip | fail
    public recordId?: string | null,
    public error?: string | null
  ) {}
}

export class ImportPipeline {
  public settings: Settings;
  public client: ODataClient;
  public mapper: Mapper;
  public source: TabularSource;
  public journal: Journal;
  public report: ReportWriter;
  public options: PipelineOptions;

  public entity: string;
  public keyFields: string[];
  public index: ExistingIndex | null = null;
  public lookupCache: Map<string, string | null> = new Map();

  private seenKeys: Map<string, number> = new Map();
  private completed: Record<number, Record<string, any>> = {};
  private processed = 0;
  private abort = false;
  private errorCount = 0;
  private createdNow: Map<string, string> = new Map();
  private warnedRowShift = false;
  private started = 0;

  constructor(opts: {
    settings: Settings;
    client: ODataClient;
    mapper: Mapper;
    source: TabularSource;
    journal: Journal;
    report: ReportWriter;
    options?: PipelineOptions;
  }) {
    this.settings = opts.settings;
    this.client = opts.client;
    this.mapper = opts.mapper;
    this.source = opts.source;
    this.journal = opts.journal;
    this.report = opts.report;
    this.options = opts.options || new PipelineOptions();

    this.entity = (this.mapper.mapping.entity || this.settings.entity || "").trim();
    if (!this.entity) {
      throw new ConfigError("Entity set name is required (--entity or mapping.entity)");
    }

    this.keyFields = [...this.mapper.mapping.keyFields];
    const quoteFields: Record<string, boolean> = {};
    for (const spec of this.mapper.mapping.fields) {
      if (this.keyFields.includes(spec.target)) {
        quoteFields[spec.target] = spec.type !== "guid" && spec.type !== "lookup";
      }
    }

    if (this.keyFields.length > 0) {
      this.index = new ExistingIndex(this.client, this.entity, this.keyFields, quoteFields);
    }
  }

  async run(): Promise<Summary> {
    this.started = Date.now();
    const info = await this.source.info();

    const missing = this.mapper.mapping.missingSources(info.fieldnames);
    if (missing.length > 0) {
      const msg = `CSV/spreadsheet is missing column(s) used by the mapping: ${missing.join(", ")}`;
      if (this.options.strictSources) {
        throw new MappingError(msg);
      }
    }

    if (["update", "upsert"].includes(this.options.mode) && this.keyFields.length === 0) {
      throw new ConfigError(`mode '${this.options.mode}' needs key fields (--key or mapping.key_fields)`);
    }

    if (this.options.resume) {
      this.completed = this.journal.loadCompleted();
    }

    try {
      await this.consume();
    } finally {
      this.report.summary.durationSeconds = (Date.now() - this.started) / 1000;
      this.report.summary.journalPath = this.journal.path;
      await this.report.close();
    }

    const summary = this.report.summary;
    this.report.writeSummaryJson();
    return summary;
  }

  private async consume(): Promise<void> {
    let chunk: PreparedRow[] = [];
    const chunkIndex = new Map<string, number>();
    let rowsRead = 0;

    for await (const row of this.source.iterRows()) {
      if (this.abort) break;
      if (this.options.limit !== null && this.options.limit !== undefined && rowsRead >= this.options.limit) {
        break;
      }
      rowsRead += 1;

      let prepared: PreparedRow;
      try {
        prepared = this.mapper.prepare(row);
      } catch (err: unknown) {
        this.emit(
          new RowResult({
            lineno: row.lineno,
            dedupeKey: `row:${row.lineno}`,
            action: "map",
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
          })
        );
        continue;
      }

      const dedupeKey = prepared.keyText;

      // Resume validation
      if (this.options.resume && row.lineno in this.completed) {
        const completedEntry = this.completed[row.lineno]!;
        if (String(completedEntry.key || "") === dedupeKey) {
          this.seenKeys.set(dedupeKey, row.lineno);
          this.emit(
            new RowResult({
              lineno: row.lineno,
              dedupeKey,
              action: "resume",
              status: "skipped",
              error: "already completed in a previous run",
            }),
            true
          );
          continue;
        }
        if (!this.warnedRowShift) {
          this.warnedRowShift = true;
        }
      }

      const duplicateOf = this.seenKeys.get(dedupeKey);
      let replaced = false;

      if (duplicateOf !== undefined) {
        if (this.options.duplicatePolicy === "last_wins" && this.options.mode !== "create") {
          if (chunkIndex.has(dedupeKey)) {
            const pos = chunkIndex.get(dedupeKey)!;
            const superseded = chunk[pos]!;
            this.emit(
              new RowResult({
                lineno: superseded.lineno,
                dedupeKey,
                action: "skip",
                status: "skipped",
                error: `superseded by the row on line ${row.lineno} (duplicate-policy=last_wins)`,
              })
            );
            chunk[pos] = prepared;
            replaced = true;
          }
        } else if (this.options.duplicatePolicy === "last_wins") {
          this.emit(
            new RowResult({
              lineno: row.lineno,
              dedupeKey,
              action: "skip",
              status: "skipped",
              error: `duplicate key (first seen on line ${duplicateOf}); last_wins is not safe in create mode`,
            })
          );
          continue;
        } else {
          const status = this.options.duplicatePolicy === "error" ? "failed" : "skipped";
          this.emit(
            new RowResult({
              lineno: row.lineno,
              dedupeKey,
              action: "skip",
              status,
              error: `duplicate key in CSV (first seen on line ${duplicateOf})`,
            })
          );
          continue;
        }
      } else {
        this.seenKeys.set(dedupeKey, row.lineno);
      }

      if (!replaced) {
        chunkIndex.set(dedupeKey, chunk.length);
        chunk.push(prepared);
      }

      if (chunk.length >= this.options.chunkRows) {
        await this.processChunk(chunk);
        chunk = [];
        chunkIndex.clear();
      }
    }

    if (chunk.length > 0 && !this.abort) {
      await this.processChunk(chunk);
    }
  }

  private async processChunk(chunk: PreparedRow[]): Promise<void> {
    await this.resolveLookups(chunk);

    const preparedList: PreparedRow[] = [];
    for (const item of chunk) {
      try {
        preparedList.push(this.mapper.finalize(item));
      } catch (err: unknown) {
        this.emit(
          new RowResult({
            lineno: item.lineno,
            dedupeKey: item.keyText,
            action: "map",
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
          })
        );
      }
    }

    if (preparedList.length === 0) return;

    if (this.needsExistingLookup() && this.index) {
      try {
        await this.index.preload(preparedList.map((item) => item.keyQueryValues));
      } catch (err: unknown) {
        const msg = err instanceof ODataError ? err.detail : String(err);
        const status = err instanceof ODataError ? err.status : undefined;
        for (const item of preparedList) {
          this.emit(
            new RowResult({
              lineno: item.lineno,
              dedupeKey: item.keyText,
              action: "lookup",
              status: "failed",
              httpStatus: status,
              error: `key lookup failed: ${msg}`,
            })
          );
        }
        return;
      }
    }

    const operations: Operation[] = [];
    for (const item of preparedList) {
      const decision = this.decide(item);
      if (decision.action === "fail") {
        this.emit(
          new RowResult({
            lineno: item.lineno,
            dedupeKey: item.keyText,
            action: "update",
            status: "failed",
            error: decision.error || "record not found",
          })
        );
        continue;
      }
      if (decision.action === "skip") {
        this.emit(
          new RowResult({
            lineno: item.lineno,
            dedupeKey: item.keyText,
            action: "skip",
            status: "skipped",
            recordId: decision.recordId,
            error: "record already exists (skip-existing)",
          })
        );
        continue;
      }
      if (!item.payload || Object.keys(item.payload).length === 0) {
        this.emit(
          new RowResult({
            lineno: item.lineno,
            dedupeKey: item.keyText,
            action: decision.action,
            status: "failed",
            error: "mapped payload is empty",
          })
        );
        continue;
      }
      operations.push(new Operation(item, decision.action, decision.recordId));
    }

    if (operations.length === 0 || this.abort) return;

    if (this.options.dryRun) {
      for (const op of operations) {
        this.emit(
          new RowResult({
            lineno: op.prepared.lineno,
            dedupeKey: op.dedupeKey,
            action: op.action,
            status: "planned",
            recordId: op.recordId,
          })
        );
      }
      return;
    }

    if (this.options.useBatch && operations.length > 1) {
      await this.executeBatch(operations);
    } else {
      for (const op of operations) {
        await this.executeOne(op);
        if (this.abort) break;
      }
    }
  }

  private needsExistingLookup(): boolean {
    if (!this.index) return false;
    if (["update", "upsert"].includes(this.options.mode)) return true;
    return this.options.skipExisting;
  }

  private decide(prepared: PreparedRow): Decision {
    const existingId = this.index ? this.index.get(prepared.keyQueryValues) : null;

    if (this.options.mode === "create") {
      if (existingId && this.options.skipExisting) {
        return new Decision("skip", existingId);
      }
      return new Decision("create");
    }

    if (this.options.mode === "update") {
      if (existingId) {
        return new Decision("update", existingId);
      }
      if (this.options.createMissing) {
        return new Decision("create");
      }
      const keyParts = Object.entries(prepared.keyValues).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
      return new Decision("fail", null, `no record found for key ${keyParts.join(", ")}`);
    }

    // Upsert mode
    if (existingId) {
      return new Decision("update", existingId);
    }
    return new Decision("create");
  }

  private async resolveLookups(rows: PreparedRow[]): Promise<void> {
    const groups = new Map<string, { entity: string; keyField: string; quote: boolean; select: string[]; items: any[] }>();

    for (const row of rows) {
      for (const pending of row.pending) {
        const key = `${pending.entity}::${pending.keyField}::${pending.quote}::${pending.select.join(",")}`;
        if (!groups.has(key)) {
          groups.set(key, {
            entity: pending.entity,
            keyField: pending.keyField,
            quote: pending.quote,
            select: pending.select,
            items: [],
          });
        }
        groups.get(key)!.items.push(pending);
      }
    }

    for (const group of groups.values()) {
      const unresolved = new Map<string, any[]>();
      for (const pending of group.items) {
        const ck = `${group.entity}::${group.keyField}::${normalise(pending.value)}`;
        if (this.lookupCache.has(ck)) {
          pending.resolvedId = this.lookupCache.get(ck) ?? undefined;
        } else {
          const normVal = normalise(pending.value);
          if (!unresolved.has(normVal)) unresolved.set(normVal, []);
          unresolved.get(normVal)!.push(pending);
        }
      }

      if (unresolved.size === 0) continue;

      const found = new Map<string, string>();
      const valuesList = Array.from(unresolved.keys());

      for (const chunk of this.chunkValues(valuesList)) {
        const filterText = chunk
          .map((v) => `${group.keyField} eq ${group.quote ? `'${odataEscape(v)}'` : v}`)
          .join(" or ");
        const selectFields = Array.from(new Set(["Id", group.keyField, ...group.select]));

        try {
          const [records] = await this.client.getCollection(group.entity, {
            filter: filterText,
            select: selectFields,
            top: Math.max(chunk.length * 4, 20),
          });

          for (const record of records) {
            if (!record || record.Id === undefined) continue;
            let val = record[group.keyField];
            if (val === undefined || val === null) {
              for (const s of group.select) {
                if (record[s] !== undefined && record[s] !== null) {
                  val = record[s];
                  break;
                }
              }
            }
            if (val !== undefined && val !== null) {
              found.set(normalise(val), String(record.Id));
            }
          }
        } catch (err: unknown) {
          // Never cache negative on network error!
          const status = err instanceof ODataError ? err.status : undefined;
          const detail = err instanceof ODataError ? err.detail : String(err);

          for (const valKey of chunk) {
            const pendingItems = unresolved.get(valKey) || [];
            for (const p of pendingItems) {
              p.resolvedId = undefined;
              p.errorStatus = status;
              p.errorMessage = `lookup query ${group.entity}.${group.keyField} failed: ${detail}`;
            }
          }
          continue;
        }
      }

      for (const [valKey, pendingItems] of unresolved.entries()) {
        const recordId = found.get(valKey) ?? null;
        const errored = pendingItems.some((p) => p.errorStatus);
        if (!errored) {
          this.lookupCache.set(`${group.entity}::${group.keyField}::${valKey}`, recordId);
        }
        for (const p of pendingItems) {
          p.resolvedId = recordId ?? undefined;
        }
      }
    }
  }

  private *chunkValues(values: string[], maxValues = 30, maxChars = 1200): Generator<string[]> {
    let chunk: string[] = [];
    let size = 0;
    for (const v of values) {
      if (chunk.length > 0 && (chunk.length >= maxValues || size + v.length > maxChars)) {
        yield chunk;
        chunk = [];
        size = 0;
      }
      chunk.push(v);
      size += v.length + 20;
    }
    if (chunk.length > 0) {
      yield chunk;
    }
  }

  private async executeOne(op: Operation): Promise<void> {
    const payload = op.prepared.payload;
    let wasKnownAbsent = false;
    let cacheKey: string | null = null;

    try {
      if (op.action === "create") {
        if (this.index) {
          cacheKey = this.index.cacheKey(op.prepared.keyQueryValues);
          wasKnownAbsent = this.index.cache.has(cacheKey) && this.index.cache.get(cacheKey) === null;
          this.index.remember(op.prepared.keyQueryValues, null);
        }
        const created = await this.client.create(this.entity, payload);
        const recordId = created ? String(created.Id || created.id || "") : null;
        if (this.index) {
          this.index.remember(op.prepared.keyQueryValues, recordId);
          if (recordId && cacheKey) {
            this.createdNow.set(cacheKey, recordId);
          }
        }
        this.emit(
          new RowResult({
            lineno: op.prepared.lineno,
            dedupeKey: op.dedupeKey,
            action: "create",
            status: "created",
            recordId,
            httpStatus: 201,
          })
        );
      } else {
        await this.client.update(this.entity, op.recordId || "", payload);
        this.emit(
          new RowResult({
            lineno: op.prepared.lineno,
            dedupeKey: op.dedupeKey,
            action: "update",
            status: "updated",
            recordId: op.recordId,
            httpStatus: 204,
          })
        );
      }
    } catch (err: unknown) {
      if (err instanceof ODataError && op.action === "create") {
        const reconciled = await this.reconcileFailedCreate(op, err, wasKnownAbsent);
        if (reconciled) {
          this.emit(reconciled);
          return;
        }
      }
      const status = err instanceof ODataError ? err.status : undefined;
      const detail = err instanceof ODataError ? err.detail : String(err);
      this.emit(
        new RowResult({
          lineno: op.prepared.lineno,
          dedupeKey: op.dedupeKey,
          action: op.action,
          status: "failed",
          recordId: op.recordId,
          httpStatus: status,
          error: detail,
        })
      );
    }
  }

  private async reconcileFailedCreate(
    op: Operation,
    exc: ODataError,
    wasKnownAbsent: boolean
  ): Promise<RowResult | null> {
    if (!this.index || this.keyFields.length === 0) return null;
    const cacheKey = this.index.cacheKey(op.prepared.keyQueryValues);
    if (this.createdNow.has(cacheKey)) return null;

    // Evict first so preload queries server
    this.index.cache.delete(cacheKey);
    try {
      await this.index.preload([op.prepared.keyQueryValues]);
    } catch {
      return null;
    }

    const existing = this.index.get(op.prepared.keyQueryValues);
    if (!existing) return null;

    if (this.createdNow.has(cacheKey) || wasKnownAbsent) {
      this.createdNow.set(cacheKey, existing);
      return new RowResult({
        lineno: op.prepared.lineno,
        dedupeKey: op.dedupeKey,
        action: "create",
        status: "created",
        recordId: existing,
        httpStatus: exc.status,
        error: "reconciled after failed create",
      });
    }

    return new RowResult({
      lineno: op.prepared.lineno,
      dedupeKey: op.dedupeKey,
      action: "create",
      status: "unknown",
      recordId: existing,
      httpStatus: exc.status,
      error: "create failed but a record with this key exists; the import never verified it was absent before, so the outcome is unknown",
    });
  }

  private async executeBatch(operations: Operation[]): Promise<void> {
    const batchOps: Array<Record<string, any>> = [];
    const byId = new Map<string, Operation>();

    for (let i = 0; i < operations.length; i++) {
      const op = operations[i]!;
      const reqId = String(i + 1);
      byId.set(reqId, op);

      if (op.action === "create") {
        batchOps.push({
          method: "POST",
          url: this.entity,
          id: reqId,
          body: op.prepared.payload,
          headers: {
            "Content-Type": "application/json;odata=verbose",
            Accept: "application/json;odata=verbose",
            Prefer: "continue-on-error",
          },
        });
      } else {
        batchOps.push({
          method: "PATCH",
          url: `${this.entity}(${op.recordId})`,
          id: reqId,
          body: op.prepared.payload,
          headers: {
            "Content-Type": "application/json;odata=verbose",
            Accept: "application/json;odata=verbose",
            Prefer: "continue-on-error",
          },
        });
      }
    }

    for (let start = 0; start < batchOps.length; start += this.options.batchSize) {
      if (this.abort) return;
      const window = batchOps.slice(start, start + this.options.batchSize);

      const windowKnownAbsent = new Set<string>();
      if (this.index) {
        for (const item of window) {
          const op = byId.get(item.id)!;
          if (op.action === "create") {
            const ck = this.index.cacheKey(op.prepared.keyQueryValues);
            if (this.index.cache.has(ck) && this.index.cache.get(ck) === null) {
              windowKnownAbsent.add(ck);
            }
          }
        }
      }

      const windowOps = window.map((item) => byId.get(item.id)!);
      let results: Record<string, any>;

      try {
        results = await this.client.batch(window, { continueOnError: true });
      } catch (err: unknown) {
        if (err instanceof BatchError) {
          err.pre_absent = windowKnownAbsent;
          await this.recoverFromBatchError(windowOps, err);
          continue;
        }
        throw err;
      }

      const retryOps: Operation[] = [];
      for (const item of window) {
        const op = byId.get(item.id)!;
        const result = results[item.id];

        if (!result) {
          this.emit(
            new RowResult({
              lineno: op.prepared.lineno,
              dedupeKey: op.dedupeKey,
              action: op.action,
              status: "unknown",
              recordId: op.recordId,
              error: "no response entry in $batch response",
            })
          );
          continue;
        }

        if (result.ok) {
          const recordId = result.recordId || op.recordId;
          if (this.index) {
            this.index.remember(op.prepared.keyQueryValues, recordId);
            if (op.action === "create" && recordId) {
              this.createdNow.set(this.index.cacheKey(op.prepared.keyQueryValues), recordId);
            }
          }
          this.emit(
            new RowResult({
              lineno: op.prepared.lineno,
              dedupeKey: op.dedupeKey,
              action: op.action,
              status: op.action === "create" ? "created" : "updated",
              recordId,
              httpStatus: result.status,
            })
          );
          continue;
        }

        if (result.status === 404 && op.action === "update" && this.options.mode === "upsert") {
          if (this.index) {
            this.index.remember(op.prepared.keyQueryValues, null);
          }
          retryOps.push(new Operation(op.prepared, "create"));
          continue;
        }

        this.emit(
          new RowResult({
            lineno: op.prepared.lineno,
            dedupeKey: op.dedupeKey,
            action: op.action,
            status: "failed",
            recordId: op.recordId,
            httpStatus: result.status,
            error: result.errorMessage,
          })
        );
      }

      for (const op of retryOps) {
        await this.executeOne(op);
        if (this.abort) return;
      }
    }
  }

  private async recoverFromBatchError(operations: Operation[], exc: BatchError): Promise<void> {
    if (!this.index || this.keyFields.length === 0) {
      for (const op of operations) {
        this.emit(
          new RowResult({
            lineno: op.prepared.lineno,
            dedupeKey: op.dedupeKey,
            action: op.action,
            status: "unknown",
            recordId: op.recordId,
            httpStatus: exc.status,
            error: `batch outcome unknown: ${exc.detail}`,
          })
        );
      }
      return;
    }

    const preAbsent = new Set<string>(exc.pre_absent || []);
    for (const op of operations) {
      if (op.action === "create" && this.index) {
        const ck = this.index.cacheKey(op.prepared.keyQueryValues);
        if (this.index.cache.has(ck) && this.index.cache.get(ck) === null) {
          preAbsent.add(ck);
        }
      }
    }

    this.index.cache.clear();
    try {
      await this.index.preload(operations.map((op) => op.prepared.keyQueryValues));
    } catch {
      for (const op of operations) {
        this.emit(
          new RowResult({
            lineno: op.prepared.lineno,
            dedupeKey: op.dedupeKey,
            action: op.action,
            status: "unknown",
            recordId: op.recordId,
            httpStatus: exc.status,
            error: `batch outcome unknown: ${exc.detail}`,
          })
        );
      }
      return;
    }

    for (const op of operations) {
      const existing = this.index.get(op.prepared.keyQueryValues);
      if (op.action === "create") {
        const ck = this.index.cacheKey(op.prepared.keyQueryValues);
        if (existing) {
          if (this.createdNow.has(ck) || preAbsent.has(ck)) {
            this.createdNow.set(ck, existing);
            this.emit(
              new RowResult({
                lineno: op.prepared.lineno,
                dedupeKey: op.dedupeKey,
                action: "create",
                status: "created",
                recordId: existing,
                httpStatus: exc.status,
                error: "reconciled: record now exists for key",
              })
            );
          } else {
            this.emit(
              new RowResult({
                lineno: op.prepared.lineno,
                dedupeKey: op.dedupeKey,
                action: "create",
                status: "unknown",
                recordId: existing,
                httpStatus: exc.status,
                error: "batch outcome unknown: record with this key already existed and this run never verified its absence",
              })
            );
          }
          continue;
        }
        await this.executeOne(new Operation(op.prepared, "create"));
      } else {
        if (!existing) {
          if (this.options.createMissing) {
            await this.executeOne(new Operation(op.prepared, "create"));
          } else {
            this.emit(
              new RowResult({
                lineno: op.prepared.lineno,
                dedupeKey: op.dedupeKey,
                action: "update",
                status: "failed",
                httpStatus: exc.status,
                error: "batch outcome unknown: key no longer resolves to a record",
              })
            );
          }
          if (this.abort) return;
          continue;
        }
        await this.executeOne(new Operation(op.prepared, "update", existing));
      }
      if (this.abort) return;
    }
  }

  private emit(result: RowResult, resumed = false): void {
    this.report.add(result, resumed);
    this.journal.record(result);
    this.processed += 1;

    if (this.options.progressEvery > 0 && this.processed % this.options.progressEvery === 0) {
      getLogger("csmt").info(
        `Progress: ${this.processed} rows processed (${this.report.summary.created} created, ${this.report.summary.updated} updated, ${this.report.summary.failed} failed)`
      );
    }

    if (["failed", "unknown"].includes(result.status)) {
      this.errorCount += 1;
    }

    if (!this.options.continueOnError && ["failed", "unknown"].includes(result.status)) {
      this.abort = true;
    } else if (this.options.maxErrors > 0 && this.errorCount >= this.options.maxErrors) {
      this.abort = true;
    }
  }
}
