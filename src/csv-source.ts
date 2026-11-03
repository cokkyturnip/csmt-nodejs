/**
 * CSV reading with encoding/delimiter detection and sane header handling.
 */

import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { parse } from "csv-parse";
import { parse as parseSync } from "csv-parse/sync";
import { CsvError } from "./errors.js";
import { normalizeHeader, Row, TableInfo, TabularSource } from "./tabular.js";

export const CANDIDATE_DELIMITERS = [",", ";", "\t", "|"] as const;
const SAMPLE_BYTES = 65536;

export function normalizeEncoding(enc?: string): string {
  if (!enc) return "utf-8";
  const lower = enc.toLowerCase().trim().replace(/_/g, "-");
  if (lower === "utf-8" || lower === "utf8") return "utf-8";
  if (lower === "utf-8-sig" || lower === "utf8-sig") return "utf-8-sig";
  if (lower === "cp1252" || lower === "windows-1252") return "windows-1252";
  if (lower === "iso-8859-1" || lower === "latin1") return "iso-8859-1";
  return enc;
}

export function decodeBuffer(buf: Buffer, encoding: string): string {
  const norm = normalizeEncoding(encoding);
  if (norm === "utf-8-sig") {
    let str = new TextDecoder("utf-8").decode(buf);
    if (str.charCodeAt(0) === 0xfeff) str = str.slice(1);
    return str;
  }
  if (norm === "windows-1252") {
    return new TextDecoder("windows-1252").decode(buf);
  }
  if (norm === "iso-8859-1") {
    return new TextDecoder("iso-8859-1").decode(buf);
  }
  return new TextDecoder(norm as any).decode(buf);
}

export function detectEncoding(filePath: string): string {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch (err: unknown) {
    throw new CsvError(`Cannot read ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const buffer = Buffer.alloc(SAMPLE_BYTES);
  const bytesRead = fs.readSync(fd, buffer, 0, SAMPLE_BYTES, 0);
  fs.closeSync(fd);

  const raw = buffer.subarray(0, bytesRead);
  if (raw.length === 0) return "utf-8-sig";
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    return "utf-8-sig";
  }

  // Check utf-8 with 0..4 trailing byte trims (prevents misdetecting multibyte char split at 64 KiB boundary)
  for (let trim = 0; trim <= 4; trim++) {
    const chunk = trim > 0 ? raw.subarray(0, raw.length - trim) : raw;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(chunk);
      return "utf-8";
    } catch {
      // try next trim
    }
  }

  // Check windows-1252 / cp1252
  try {
    new TextDecoder("windows-1252", { fatal: true }).decode(raw);
    return "cp1252";
  } catch {
    // fallback
  }

  return "iso-8859-1";
}

export function detectDelimiter(sampleText: string): string {
  const lines = sampleText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 10);

  if (lines.length === 0) return ",";

  const scored: Array<{ score: number; count: number; delimiter: string }> = [];

  for (const delimiter of CANDIDATE_DELIMITERS) {
    const counts: number[] = [];
    for (const line of lines) {
      let numCols = 0;
      try {
        const records = parseSync(line, { delimiter, relax_quotes: true }) as string[][];
        for (const row of records) {
          numCols = row.length;
          break;
        }
      } catch {
        numCols = 0;
      }
      counts.push(numCols);
    }

    const nonZero = counts.filter((c) => c > 0);
    if (nonZero.length === 0) continue;

    // Find most common count
    const freq: Record<number, number> = {};
    for (const c of nonZero) {
      freq[c] = (freq[c] || 0) + 1;
    }
    let mostCommon = 0;
    let maxFreq = 0;
    for (const [colCountStr, countFreq] of Object.entries(freq)) {
      const colCount = Number(colCountStr);
      if (countFreq > maxFreq) {
        maxFreq = countFreq;
        mostCommon = colCount;
      }
    }

    const consistency = maxFreq / nonZero.length;
    const score = consistency * 100 + Math.min(mostCommon, 50);
    scored.push({ score, count: mostCommon, delimiter });
  }

  if (scored.length === 0) return ",";
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.count <= 1) return ",";
  return best.delimiter;
}

export class CsvSource implements TabularSource {
  public path: string;
  public hasHeader: boolean;
  public encoding: string;
  private explicitDelimiter?: string;
  private detectedDelimiter?: string;
  private cachedFieldnames?: string[];
  private sampleText?: string;

  constructor(
    filePath: string,
    options?: {
      encoding?: string;
      delimiter?: string;
      hasHeader?: boolean;
    }
  ) {
    this.path = path.resolve(filePath);
    if (!fs.existsSync(this.path)) {
      throw new CsvError(`CSV file not found: ${this.path}`);
    }
    const stat = fs.statSync(this.path);
    if (!stat.isFile()) {
      throw new CsvError(`CSV path is not a file: ${this.path}`);
    }

    this.hasHeader = options?.hasHeader ?? true;
    this.encoding = normalizeEncoding(options?.encoding || detectEncoding(this.path));
    this.explicitDelimiter = options?.delimiter;
  }

  private readSample(): string {
    if (this.sampleText === undefined) {
      const fd = fs.openSync(this.path, "r");
      const buffer = Buffer.alloc(SAMPLE_BYTES);
      const bytesRead = fs.readSync(fd, buffer, 0, SAMPLE_BYTES, 0);
      fs.closeSync(fd);
      this.sampleText = decodeBuffer(buffer.subarray(0, bytesRead), this.encoding);
    }
    return this.sampleText;
  }

  get delimiter(): string {
    if (this.explicitDelimiter) return this.explicitDelimiter;
    if (!this.detectedDelimiter) {
      this.detectedDelimiter = detectDelimiter(this.readSample());
    }
    return this.detectedDelimiter;
  }

  private loadHeaderSync(): string[] {
    if (this.cachedFieldnames) return this.cachedFieldnames;

    // Read chunks until a newline is encountered to safely extract the header line (handles >64 KiB header)
    const fd = fs.openSync(this.path, "r");
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(SAMPLE_BYTES);
    let foundNewline = false;
    let totalRead = 0;
    try {
      while (!foundNewline && totalRead < 16 * 1024 * 1024) {
        const bytesRead = fs.readSync(fd, buf, 0, SAMPLE_BYTES, null);
        if (bytesRead === 0) break;
        const slice = Buffer.from(buf.subarray(0, bytesRead));
        chunks.push(slice);
        totalRead += bytesRead;
        if (slice.includes(0x0a) || slice.includes(0x0d)) {
          foundNewline = true;
        }
      }
    } finally {
      fs.closeSync(fd);
    }

    const text = decodeBuffer(Buffer.concat(chunks), this.encoding);
    const lines = text.split(/\r?\n/);
    let firstLine = "";
    for (const line of lines) {
      if (line.trim()) {
        firstLine = line;
        break;
      }
    }

    if (!firstLine) {
      throw new CsvError(`CSV file has no header row: ${this.path}`);
    }

    let parsedHeader: string[] = [];
    try {
      const records = parseSync(firstLine, {
        delimiter: this.delimiter,
        relax_quotes: true,
        bom: true,
      }) as string[][];
      for (const row of records) {
        parsedHeader = row;
        break;
      }
    } catch {
      parsedHeader = [];
    }

    if (parsedHeader.length === 0) {
      throw new CsvError(`CSV file has no header row: ${this.path}`);
    }

    if (this.hasHeader) {
      this.cachedFieldnames = normalizeHeader(parsedHeader);
    } else {
      this.cachedFieldnames = parsedHeader.map((_, i) => `column_${i + 1}`);
    }
    return this.cachedFieldnames;
  }

  get fieldnames(): string[] {
    return [...this.loadHeaderSync()];
  }

  async info(): Promise<TableInfo> {
    return new TableInfo(
      this.path,
      "csv",
      this.fieldnames,
      this.encoding,
      this.delimiter,
      undefined,
      undefined,
      this.hasHeader
    );
  }

  async *iterRows(): AsyncGenerator<Row> {
    const fieldnames = this.loadHeaderSync();
    const stream = fs.createReadStream(this.path);
    const norm = normalizeEncoding(this.encoding);

    let inputStream: NodeJS.ReadableStream = stream;
    if (norm === "windows-1252" || norm === "iso-8859-1") {
      const decoder = new TextDecoder(norm);
      const transform = new Transform({
        transform(chunk, _, cb) {
          cb(null, decoder.decode(chunk, { stream: true }));
        },
      });
      inputStream = stream.pipe(transform);
    }

    const parser = inputStream.pipe(
      parse({
        delimiter: this.delimiter,
        relax_quotes: true,
        relax_column_count: true,
        skip_empty_lines: true,
        bom: true,
        info: true,
      })
    );

    let skippedHeader = !this.hasHeader;
    for await (const recordWithInfo of parser) {
      const rawValues: string[] = recordWithInfo.record;
      const lineno: number = recordWithInfo.info.lines;

      if (!skippedHeader) {
        skippedHeader = true;
        continue;
      }

      if (!rawValues || rawValues.length === 0 || rawValues.every((v) => !v || !String(v).trim())) {
        continue;
      }

      const values: Record<string, string> = {};
      for (let i = 0; i < fieldnames.length; i++) {
        const col = fieldnames[i]!;
        values[col] = i < rawValues.length ? String(rawValues[i] ?? "") : "";
      }
      yield { lineno, values };
    }
  }

  async sampleRows(limit = 5): Promise<Row[]> {
    const rows: Row[] = [];
    for await (const row of this.iterRows()) {
      rows.push(row);
      if (rows.length >= limit) break;
    }
    return rows;
  }
}
