/**
 * Read .xlsx/.xlsm workbooks as tabular data.
 */

import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { CsvError } from "./errors.js";
import { normalizeHeader, Row, TableInfo, TabularSource } from "./tabular.js";

export function cellToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";

  // ExcelJS formula cell object: { formula: '...', result: ... }
  if (typeof value === "object" && value !== null && "result" in value) {
    return cellToText((value as { result: unknown }).result);
  }

  // ExcelJS rich text object: { richText: [...] }
  if (typeof value === "object" && value !== null && "richText" in value) {
    const parts = (value as { richText: Array<{ text: string }> }).richText;
    return parts.map((p) => p.text || "").join("");
  }

  if (value instanceof Date) {
    // Check if midnight in local/UTC
    if (value.getUTCHours() === 0 && value.getUTCMinutes() === 0 && value.getUTCSeconds() === 0 && value.getUTCMilliseconds() === 0) {
      return value.toISOString().slice(0, 10);
    }
    return value.toISOString().slice(0, 19);
  }

  if (typeof value === "number") {
    if (Number.isInteger(value) && Math.abs(value) < 1e16) {
      return String(value);
    }
    // Round to 15 digits like Excel
    return String(Number(value.toPrecision(15)));
  }

  return String(value);
}

export class XlsxSource implements TabularSource {
  public path: string;
  public headerRow: number;
  public hasHeader: boolean;
  private requestedSheet?: string;
  private selectedSheetName?: string;
  private cachedFieldnames?: string[];

  constructor(
    filePath: string,
    options?: {
      sheet?: string;
      headerRow?: number;
      hasHeader?: boolean;
    }
  ) {
    this.path = path.resolve(filePath);
    if (!fs.existsSync(this.path)) {
      throw new CsvError(`Spreadsheet not found: ${this.path}`);
    }
    const stat = fs.statSync(this.path);
    if (!stat.isFile()) {
      throw new CsvError(`Spreadsheet path is not a file: ${this.path}`);
    }

    this.headerRow = options?.headerRow ?? 1;
    if (this.headerRow < 1) {
      throw new CsvError("--header-row must be 1 or greater");
    }
    this.hasHeader = options?.hasHeader ?? true;
    this.requestedSheet = options?.sheet;
  }

  private async loadWorkbook(): Promise<ExcelJS.Workbook> {
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.readFile(this.path);
      return workbook;
    } catch (err: unknown) {
      throw new CsvError(`Cannot open workbook ${this.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private selectWorksheet(workbook: ExcelJS.Workbook): ExcelJS.Worksheet {
    const sheet = this.requestedSheet;
    const names = workbook.worksheets.map((ws) => ws.name);

    if (sheet === undefined || sheet === null) {
      const chosen = workbook.worksheets[0];
      if (!chosen) {
        throw new CsvError(`Workbook has no worksheets: ${this.path}`);
      }
      this.selectedSheetName = chosen.name;
      return chosen;
    }

    // 1. Exact sheet name always wins!
    const exactWs = workbook.getWorksheet(sheet);
    if (exactWs) {
      this.selectedSheetName = exactWs.name;
      return exactWs;
    }

    // 2. Fall back to numeric sheet index
    if (typeof sheet === "string" && /^\d+$/.test(sheet.trim())) {
      const idx = Number.parseInt(sheet.trim(), 10);
      if (idx < 1 || idx > workbook.worksheets.length) {
        throw new CsvError(
          `Sheet index ${idx} is out of range; workbook has ${names.length} sheet(s): ${names.join(", ")}`
        );
      }
      const chosen = workbook.worksheets[idx - 1]!;
      this.selectedSheetName = chosen.name;
      return chosen;
    }

    throw new CsvError(`Sheet ${JSON.stringify(sheet)} not found in ${path.basename(this.path)}; available: ${names.join(", ")}`);
  }

  private async readHeaderAsync(): Promise<string[]> {
    if (this.cachedFieldnames) return this.cachedFieldnames;

    const workbook = await this.loadWorkbook();
    const ws = this.selectWorksheet(workbook);

    let headerValues: unknown[] = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === this.headerRow) {
        // row.values is 1-indexed in ExcelJS (index 0 is undefined)
        const vals = Array.isArray(row.values) ? row.values.slice(1) : [];
        headerValues = vals;
      }
    });

    if (headerValues.length === 0) {
      throw new CsvError(`Worksheet ${JSON.stringify(this.selectedSheetName)} has no row ${this.headerRow} to use as a header`);
    }

    // Pop trailing empty columns
    while (headerValues.length > 0) {
      const last = headerValues[headerValues.length - 1];
      if (last === null || last === undefined || String(last).trim() === "") {
        headerValues.pop();
      } else {
        break;
      }
    }

    if (headerValues.length === 0) {
      throw new CsvError(`Worksheet ${JSON.stringify(this.selectedSheetName)} row ${this.headerRow} is empty`);
    }

    if (this.hasHeader) {
      this.cachedFieldnames = normalizeHeader(headerValues);
    } else {
      this.cachedFieldnames = headerValues.map((_, i) => `column_${i + 1}`);
    }
    return this.cachedFieldnames;
  }

  get fieldnames(): string[] {
    if (!this.cachedFieldnames) {
      // Synchronous probe if already cached, otherwise will be populated
      return [];
    }
    return [...this.cachedFieldnames];
  }

  get sheetName(): string | undefined {
    return this.selectedSheetName;
  }

  async info(): Promise<TableInfo> {
    const fieldnames = await this.readHeaderAsync();
    const format = path.extname(this.path).toLowerCase().replace(/^\./, "");
    return new TableInfo(
      this.path,
      format,
      fieldnames,
      undefined,
      undefined,
      this.selectedSheetName,
      this.headerRow,
      this.hasHeader
    );
  }

  async *iterRows(): AsyncGenerator<Row> {
    const fieldnames = await this.readHeaderAsync();
    const workbook = await this.loadWorkbook();
    const ws = this.selectWorksheet(workbook);

    const startRow = this.hasHeader ? this.headerRow : this.headerRow - 1;

    let currentRowNumber = 0;
    // Iterate rows
    for (let rowIdx = 1; rowIdx <= ws.rowCount; rowIdx++) {
      currentRowNumber = rowIdx;
      if (currentRowNumber <= startRow) continue;

      const row = ws.getRow(currentRowNumber);
      if (!row || !row.hasValues) continue;

      const rawValues = Array.isArray(row.values) ? row.values.slice(1) : [];
      if (rawValues.length === 0 || rawValues.every((v) => v === null || v === undefined || String(v).trim() === "")) {
        continue;
      }

      const values: Record<string, string> = {};
      for (let i = 0; i < fieldnames.length; i++) {
        const col = fieldnames[i]!;
        const rawCell = i < rawValues.length ? rawValues[i] : null;
        values[col] = cellToText(rawCell);
      }

      yield { lineno: currentRowNumber, values };
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
