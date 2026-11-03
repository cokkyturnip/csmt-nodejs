/**
 * Export Creatio records to a CSV or XLSX file.
 */

import fs from "node:fs";
import path from "node:path";
import { stringify } from "csv-stringify";
import ExcelJS from "exceljs";
import { ODataClient, odataEscape } from "./client.js";
import { ConfigError, ODataError } from "./errors.js";
import { getLogger } from "./logger.js";

const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function cleanGuid(value: unknown): string | null {
  const text = String(value ?? "").trim().replace(/^\{|\}$/g, "").trim();
  return GUID_RE.test(text) ? text : null;
}

export function idKey(value: unknown): string {
  const cleaned = cleanGuid(value);
  if (cleaned !== null) {
    return cleaned.toLowerCase();
  }
  return String(value ?? "").trim();
}

export function idLiteral(value: string): string {
  const cleaned = cleanGuid(value);
  return cleaned !== null ? cleaned : `'${odataEscape(value)}'`;
}

export class LookupExpansion {
  constructor(
    public field: string,
    public entity: string,
    public captionField = "Name",
    public quote = false
  ) {}

  static parse(raw: string): LookupExpansion {
    if (!raw.includes("=")) {
      throw new ConfigError(`--expand-lookups expects Field=Entity.CaptionField, got ${JSON.stringify(raw)}`);
    }
    const [source, ...rest] = raw.split("=");
    const target = rest.join("=").trim();
    const cleanSource = source!.trim();
    if (!cleanSource) {
      throw new ConfigError(`--expand-lookups is missing the field name in ${JSON.stringify(raw)}`);
    }
    if (!target) {
      throw new ConfigError(`--expand-lookups is missing the entity in ${JSON.stringify(raw)}`);
    }
    const [entity, ...captionParts] = target.split(".");
    const cleanEntity = entity!.trim();
    const caption = captionParts.join(".").trim() || "Name";
    if (!cleanEntity) {
      throw new ConfigError(`--expand-lookups has an empty entity in ${JSON.stringify(raw)}`);
    }
    return new LookupExpansion(cleanSource, cleanEntity, caption);
  }
}

export interface ExportOptionsArgs {
  entity: string;
  out: string;
  select?: string[];
  filter?: string | null;
  orderby?: string | null;
  limit?: number | null;
  pageSize?: number | null;
  delimiter?: string;
  encoding?: BufferEncoding;
  writeHeader?: boolean;
  format?: string;
  sheetName?: string | null;
  lookups?: LookupExpansion[];
  lookupChunk?: number;
  logEvery?: number;
}

export class ExportOptions {
  public entity: string;
  public out: string;
  public select: string[];
  public filter?: string | null;
  public orderby?: string | null;
  public limit?: number | null;
  public pageSize?: number | null;
  public delimiter: string;
  public encoding: string;
  public writeHeader: boolean;
  public format: "csv" | "xlsx";
  public sheetName?: string | null;
  public lookups: LookupExpansion[];
  public lookupChunk: number;
  public logEvery: number;

  constructor(opts: ExportOptionsArgs) {
    this.entity = (opts.entity || "").trim();
    if (!this.entity) {
      throw new ConfigError("Export needs an entity set name (--entity)");
    }
    this.delimiter = opts.delimiter ?? ",";
    if (!this.delimiter || this.delimiter.length !== 1) {
      throw new ConfigError("--delimiter must be a single character");
    }
    if (opts.limit !== undefined && opts.limit !== null && opts.limit < 0) {
      throw new ConfigError("--limit must be zero or greater");
    }
    if (opts.pageSize !== undefined && opts.pageSize !== null && opts.pageSize < 1) {
      throw new ConfigError("--page-size must be greater than zero");
    }

    this.out = path.resolve(opts.out);
    this.select = opts.select || [];
    this.filter = opts.filter;
    this.orderby = opts.orderby;
    this.limit = opts.limit;
    this.pageSize = opts.pageSize;
    this.encoding = opts.encoding || "utf-8-sig";
    this.writeHeader = opts.writeHeader ?? true;
    this.sheetName = opts.sheetName;
    this.lookups = opts.lookups || [];
    this.lookupChunk = opts.lookupChunk ?? 30;
    this.logEvery = opts.logEvery ?? 1000;

    const ext = path.extname(this.out).toLowerCase();
    const detected = ext === ".csv" ? "csv" : ext === ".xlsx" || ext === ".xlsm" ? "xlsx" : undefined;
    const requested = (opts.format || "auto").trim().toLowerCase();

    if (requested === "auto") {
      if (!detected) {
        throw new ConfigError(
          `Cannot infer the output format from ${JSON.stringify(path.basename(this.out))}; use --format csv|xlsx or an .csv/.xlsx extension`
        );
      }
      this.format = detected;
    } else {
      if (requested !== "csv" && requested !== "xlsx") {
        throw new ConfigError("--format must be csv or xlsx");
      }
      if (detected && detected !== requested) {
        throw new ConfigError(`--format ${requested} conflicts with the output name ${JSON.stringify(path.basename(this.out))}`);
      }
      this.format = requested;
    }
  }
}

export function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object" && !(value instanceof Date)) {
    return JSON.stringify(value);
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 19);
  }
  return String(value);
}

export class LookupResolver {
  private cache = new Map<string, Map<string, string>>();
  private missing = new Map<string, Set<string>>();

  constructor(
    public client: ODataClient,
    public chunkSize = 30
  ) {
    this.chunkSize = Math.max(1, chunkSize);
  }

  private bucketKey(spec: LookupExpansion): string {
    return `${spec.entity}::${spec.captionField}`;
  }

  private bucket(spec: LookupExpansion): Map<string, string> {
    const key = this.bucketKey(spec);
    if (!this.cache.has(key)) {
      this.cache.set(key, new Map());
    }
    return this.cache.get(key)!;
  }

  private missingIds(spec: LookupExpansion): Set<string> {
    const key = this.bucketKey(spec);
    if (!this.missing.has(key)) {
      this.missing.set(key, new Set());
    }
    return this.missing.get(key)!;
  }

  async resolve(spec: LookupExpansion, values: Iterable<unknown>): Promise<void> {
    const bkt = this.bucket(spec);
    const knownMissing = this.missingIds(spec);
    const missing: string[] = [];
    const seen = new Set<string>();

    for (const val of values) {
      if (val === null || val === undefined || val === "") continue;
      const k = idKey(val);
      if (bkt.has(k) || knownMissing.has(k) || seen.has(k)) continue;
      seen.add(k);
      missing.push(String(val));
    }

    for (let start = 0; start < missing.length; start += this.chunkSize) {
      const chunk = missing.slice(start, start + this.chunkSize);
      const filterText = chunk.map((v) => `Id eq ${idLiteral(v)}`).join(" or ");

      let records: any[];
      try {
        const [ret] = await this.client.getCollection(spec.entity, {
          filter: filterText,
          select: ["Id", spec.captionField],
          top: Math.max(chunk.length * 2, 20),
        });
        records = ret;
      } catch (err: unknown) {
        continue;
      }

      const returned = new Set<string>();
      for (const rec of records) {
        if (!rec || rec.Id === undefined) continue;
        const k = idKey(rec.Id);
        returned.add(k);
        const caption = rec[spec.captionField];
        bkt.set(k, caption === null || caption === undefined ? "" : String(caption));
      }

      for (const val of chunk) {
        const k = idKey(val);
        if (!returned.has(k)) {
          knownMissing.add(k);
        }
      }
    }
  }

  caption(spec: LookupExpansion, value: unknown): string {
    if (value === null || value === undefined || value === "") return "";
    const k = idKey(value);
    const c = this.bucket(spec).get(k);
    if (c !== undefined) return c;
    return String(value);
  }
}

export interface RowSink {
  writeHeader(fieldnames: string[]): Promise<void> | void;
  writeRow(fieldnames: string[], values: Record<string, any>): Promise<void> | void;
  close(): Promise<void>;
}

export class CsvSink implements RowSink {
  private writeStream: fs.WriteStream;
  private stringifier: any;

  constructor(public options: ExportOptions) {
    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    this.writeStream = fs.createWriteStream(options.out);
    const norm = options.encoding ? options.encoding.toLowerCase().replace(/_/g, "-") : "utf-8-sig";
    if (norm === "utf-8-sig" || norm === "utf8-sig") {
      this.writeStream.write("\ufeff", "utf8");
    }
    this.stringifier = stringify({
      delimiter: options.delimiter,
      header: false,
    });
    this.stringifier.pipe(this.writeStream);
  }

  writeHeader(fieldnames: string[]): void {
    if (this.options.writeHeader) {
      this.stringifier.write(fieldnames);
    }
  }

  writeRow(fieldnames: string[], values: Record<string, any>): void {
    const row = fieldnames.map((name) => cell(values[name]));
    this.stringifier.write(row);
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.writeStream.on("finish", () => resolve());
      this.writeStream.on("error", reject);
      this.stringifier.on("error", reject);
      this.stringifier.end();
    });
  }
}

export class XlsxSink implements RowSink {
  private workbook: any;
  private worksheet: any;

  constructor(public options: ExportOptions) {
    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    this.workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      filename: options.out,
      useStyles: true,
    });
    let title = (options.sheetName || options.entity || "Export").slice(0, 31);
    for (const char of "[]:*?/\\") {
      title = title.replaceAll(char, "_");
    }
    this.worksheet = this.workbook.addWorksheet(title || "Export", {
      views: [{ state: "frozen", ySplit: 1 }],
    });
  }

  writeHeader(fieldnames: string[]): void {
    for (let i = 0; i < fieldnames.length; i++) {
      const name = fieldnames[i]!;
      const col = this.worksheet.getColumn(i + 1);
      col.width = Math.max(8, Math.min(name.length + 2, 60));
    }
    if (this.options.writeHeader) {
      const row = this.worksheet.addRow(fieldnames);
      row.commit();
    }
  }

  writeRow(fieldnames: string[], values: Record<string, any>): void {
    const rowValues = fieldnames.map((name) => {
      const val = values[name];
      if (typeof val === "boolean" || typeof val === "number") {
        return val;
      }
      return cell(val) || null;
    });
    const row = this.worksheet.addRow(rowValues);
    row.commit();
  }

  async close(): Promise<void> {
    await this.worksheet.commit();
    await this.workbook.commit();
  }
}

export function openSink(options: ExportOptions): RowSink {
  return options.format === "xlsx" ? new XlsxSink(options) : new CsvSink(options);
}

export class Exporter {
  constructor(
    public client: ODataClient,
    public options: ExportOptions
  ) {}

  async run(): Promise<Record<string, any>> {
    const opts = this.options;
    fs.mkdirSync(path.dirname(opts.out), { recursive: true });
    const resolver = new LookupResolver(this.client, opts.lookupChunk);

    let written = 0;
    let fieldnames = [...opts.select];
    const lookupsByField = new Map<string, LookupExpansion>();
    for (const spec of opts.lookups) {
      lookupsByField.set(spec.field, spec);
    }

    if (opts.limit === 0) {
      if (fieldnames.length === 0) {
        try {
          const fields = await this.client.entityFields(opts.entity);
          fieldnames = Object.keys(fields);
        } catch {}
      }
      const sink = openSink(opts);
      try {
        if (fieldnames.length > 0) {
          await sink.writeHeader(fieldnames);
        }
      } finally {
        await sink.close();
      }
      return {
        entity: opts.entity,
        rows: 0,
        out: opts.out,
        format: opts.format,
        columns: fieldnames,
        lookups: opts.lookups.map((l) => l.field),
      };
    }

    const sink = openSink(opts);
    let headerWritten = false;
    let pending: Array<Record<string, any>> = [];

    try {
      for await (const record of this.client.iterCollection(opts.entity, {
        filter: opts.filter,
        select: opts.select.length > 0 ? opts.select : null,
        top: opts.pageSize,
        orderby: opts.orderby,
      })) {
        if (!headerWritten) {
          if (fieldnames.length === 0) {
            fieldnames = Object.keys(record);
          }
          await sink.writeHeader(fieldnames);
          headerWritten = true;
        }

        pending.push(record);
        written += 1;

        if (opts.logEvery > 0 && written % opts.logEvery === 0) {
          getLogger("csmt").info(`Exported ${written} record(s) from ${opts.entity}...`);
        }

        if (pending.length >= 200) {
          await this.flush(pending, sink, fieldnames, resolver, lookupsByField);
          pending = [];
        }

        if (opts.limit !== null && opts.limit !== undefined && written >= opts.limit) {
          break;
        }
      }

      if (pending.length > 0) {
        await this.flush(pending, sink, fieldnames, resolver, lookupsByField);
      } else if (!headerWritten && fieldnames.length > 0) {
        await sink.writeHeader(fieldnames);
      }
    } finally {
      await sink.close();
    }

    return {
      entity: opts.entity,
      rows: written,
      out: opts.out,
      format: opts.format,
      columns: fieldnames,
      lookups: opts.lookups.map((l) => l.field),
    };
  }

  private async flush(
    rows: Array<Record<string, any>>,
    sink: RowSink,
    fieldnames: string[],
    resolver: LookupResolver,
    lookupsByField: Map<string, LookupExpansion>
  ): Promise<void> {
    for (const [name, spec] of lookupsByField.entries()) {
      if (!fieldnames.includes(name)) continue;
      await resolver.resolve(spec, rows.map((r) => r[name]));
    }

    for (const row of rows) {
      const values: Record<string, any> = {};
      for (const name of fieldnames) {
        const val = row[name];
        const spec = lookupsByField.get(name);
        values[name] = spec ? resolver.caption(spec, val) || "" : val;
      }
      await sink.writeRow(fieldnames, values);
    }
  }
}
