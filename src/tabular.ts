/**
 * Tabular source abstraction: common types and header normalization.
 */

import path from "node:path";
import { ConfigError } from "./errors.js";
import { CsvSource } from "./csv-source.js";
import { XlsxSource } from "./xlsx-source.js";

export const SUPPORTED_SUFFIXES = new Set([".csv", ".xlsx", ".xlsm"]);
export const LEGACY_SUFFIX = ".xls";

export interface Row {
  lineno: number;
  values: Record<string, string>;
}

export class TableInfo {
  constructor(
    public path: string,
    public format: string,
    public fieldnames: string[],
    public encoding?: string,
    public delimiter?: string,
    public sheet?: string,
    public headerRow?: number,
    public hasHeader = true
  ) {}

  describe(): string {
    const parts: string[] = [`format=${this.format}`];
    if (this.encoding) parts.push(`encoding=${this.encoding}`);
    if (this.delimiter) parts.push(`delimiter=${JSON.stringify(this.delimiter)}`);
    if (this.sheet) parts.push(`sheet=${JSON.stringify(this.sheet)}`);
    if (this.headerRow && this.headerRow !== 1) parts.push(`header_row=${this.headerRow}`);
    parts.push(`columns=${this.fieldnames.length}`);
    return parts.join(", ");
  }
}

export interface TabularSource {
  path: string;
  fieldnames: string[];
  info(): Promise<TableInfo>;
  iterRows(): AsyncGenerator<Row>;
  sampleRows(limit?: number): Promise<Row[]>;
}

export function normalizeHeader(rawHeader: unknown[]): string[] {
  const names: string[] = [];
  const taken = new Set<string>();

  for (let index = 1; index <= rawHeader.length; index++) {
    const raw = rawHeader[index - 1];
    const text = raw === null || raw === undefined ? "" : String(raw);
    let name = text.replace(/\ufeff/g, "").trim();
    if (!name) {
      name = `column_${index}`;
    }
    let candidate = name;
    let suffix = 2;
    while (taken.has(candidate)) {
      candidate = `${name}_${suffix}`;
      suffix += 1;
    }
    taken.add(candidate);
    names.push(candidate);
  }
  return names;
}

export async function openSource(
  filePath: string,
  options?: {
    encoding?: string;
    delimiter?: string;
    hasHeader?: boolean;
    sheet?: string;
    headerRow?: number;
  }
): Promise<TabularSource> {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === LEGACY_SUFFIX) {
    throw new ConfigError(
      `${filePath} is a legacy .xls workbook. Save it as .xlsx first (Excel: File > Save As > Excel Workbook).`
    );
  }
  if (!SUPPORTED_SUFFIXES.has(ext)) {
    throw new ConfigError(
      `Unsupported file type ${JSON.stringify(ext || "(none)")} for ${filePath}. Supported: ${Array.from(SUPPORTED_SUFFIXES).sort().join(", ")}`
    );
  }

  if (ext === ".csv") {
    if (options?.sheet) {
      throw new ConfigError("--sheet only applies to .xlsx/.xlsm files");
    }
    if (options?.headerRow && options.headerRow !== 1) {
      throw new ConfigError("--header-row only applies to .xlsx/.xlsm files");
    }
    return new CsvSource(filePath, {
      encoding: options?.encoding,
      delimiter: options?.delimiter,
      hasHeader: options?.hasHeader,
    });
  }

  if (options?.encoding) {
    console.warn("WARNING: --encoding is ignored for Excel (.xlsx) files");
  }
  if (options?.delimiter) {
    console.warn("WARNING: --delimiter is ignored for Excel (.xlsx) files");
  }

  const src = new XlsxSource(filePath, {
    sheet: options?.sheet,
    headerRow: options?.headerRow,
    hasHeader: options?.hasHeader,
  });
  await src.info();
  return src;
}
