/**
 * Import template generation: turn $metadata field details into a CSV/XLSX
 * template plus an optional starter mapping.
 */

import fs from "node:fs";
import path from "node:path";
import { stringify as stringifySync } from "csv-stringify/sync";
import ExcelJS from "exceljs";
import { CsdlFieldDetail } from "./client.js";
import { ConfigError } from "./errors.js";

/** System/read-only columns that are never useful in an import template. */
export const SYSTEM_COLUMNS = [
  "Id",
  "CreatedOn",
  "CreatedById",
  "ModifiedOn",
  "ModifiedById",
  "ProcessListeners",
];

const EDM_TO_MAPPING: Record<string, string> = {
  "Edm.String": "string",
  "Edm.Guid": "guid",
  "Edm.Int16": "int",
  "Edm.Int32": "int",
  "Edm.Int64": "int",
  "Edm.Byte": "int",
  "Edm.SByte": "int",
  "Edm.Decimal": "decimal",
  "Edm.Double": "decimal",
  "Edm.Single": "decimal",
  "Edm.Boolean": "bool",
  "Edm.DateTimeOffset": "datetime",
  "Edm.Date": "date",
  "Edm.TimeOfDay": "string",
};

const SAMPLES: Record<string, string> = {
  string: "contoh teks",
  guid: "00000000-0000-0000-0000-000000000000",
  int: "1",
  decimal: "1.5",
  bool: "true",
  datetime: "2026-01-31T00:00:00Z",
  date: "2026-01-31",
};

export interface TemplateColumn {
  /** CSV/XLSX column header. */
  header: string;
  /** OData property the column is written to. */
  target: string;
  edmType: string;
  mappingType: string;
  nullable: boolean;
  maxLength?: number;
  lookupEntity?: string;
  lookupKey?: string;
  mapping: Record<string, any>;
}

export interface TemplateOptions {
  includeSystem?: boolean;
  lookupKey?: string;
}

export function edmToMappingType(edmType: string): string {
  return EDM_TO_MAPPING[edmType] || "string";
}

export function sampleValue(column: TemplateColumn): string {
  if (column.lookupEntity) {
    return `contoh ${column.lookupEntity}`;
  }
  return SAMPLES[column.mappingType] ?? "contoh";
}

/**
 * Build template columns from metadata details.
 *
 * Lookup columns (`OwnerId`, `TypeId`, ...) are headed by the navigation name
 * (`Owner`, `Type`) because the cell holds the label/name, not a GUID. The
 * mapping keeps the real OData target and resolves the label through
 * `lookup.key`.
 */
export function buildTemplateColumns(details: CsdlFieldDetail[], options: TemplateOptions = {}): TemplateColumn[] {
  const lookupKey = options.lookupKey || "Name";
  const includeSystem = Boolean(options.includeSystem);
  const columns: TemplateColumn[] = [];
  const usedHeaders = new Set<string>();

  for (const detail of details) {
    if (detail.type === "Edm.Stream") continue;
    if (!includeSystem && SYSTEM_COLUMNS.includes(detail.name)) continue;

    const mappingType = edmToMappingType(detail.type);
    let header = detail.lookup ? detail.lookup.navigation : detail.name;
    if (!header || usedHeaders.has(header)) {
      header = detail.name;
    }
    usedHeaders.add(header);

    const mapping: Record<string, any> = detail.lookup
      ? {
          type: "lookup",
          target: detail.name,
          lookup: { entity: detail.lookup.entity, key: lookupKey },
        }
      : { type: mappingType, target: detail.name };

    if (!detail.lookup && detail.maxLength !== undefined && mappingType === "string") {
      mapping.max_length = detail.maxLength;
    }

    columns.push({
      header,
      target: detail.name,
      edmType: detail.type,
      mappingType: detail.lookup ? "lookup" : mappingType,
      nullable: detail.nullable,
      maxLength: detail.maxLength,
      lookupEntity: detail.lookup?.entity,
      lookupKey: detail.lookup ? lookupKey : undefined,
      mapping,
    });
  }

  return columns;
}

export function buildTemplateMapping(
  columns: TemplateColumn[],
  options: { entity?: string; keyColumns?: string[] } = {}
): Record<string, any> {
  const fields: Record<string, any> = {};
  for (const column of columns) {
    fields[column.header] = column.mapping;
  }

  const document: Record<string, any> = { fields };
  if (options.entity) {
    document.entity = options.entity;
  }
  if (options.keyColumns && options.keyColumns.length > 0) {
    document.key_fields = options.keyColumns.map((key) => key.trim()).filter(Boolean);
  }
  return document;
}

function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function writeCsvTemplate(
  outPath: string,
  columns: TemplateColumn[],
  options: { delimiter?: string; bom?: boolean; sample?: boolean } = {}
): void {
  if (columns.length === 0) {
    throw new ConfigError("Template has no columns");
  }
  const rows: string[][] = [columns.map((c) => c.header)];
  if (options.sample) {
    rows.push(columns.map((c) => sampleValue(c)));
  }

  const text = stringifySync(rows, {
    delimiter: options.delimiter || ",",
    record_delimiter: "\n",
  });

  ensureDir(outPath);
  const bom = options.bom !== false ? "\ufeff" : "";
  fs.writeFileSync(outPath, bom + text, "utf-8");
}

function sheetTitle(entity: string): string {
  let title = (entity || "Template").slice(0, 31);
  for (const char of "[]:*?/\\") {
    title = title.replaceAll(char, "_");
  }
  return title || "Template";
}

export async function writeXlsxTemplate(
  outPath: string,
  entity: string,
  columns: TemplateColumn[],
  options: { sample?: boolean } = {}
): Promise<void> {
  if (columns.length === 0) {
    throw new ConfigError("Template has no columns");
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetTitle(entity), {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  const headerRow = sheet.addRow(columns.map((c) => c.header));
  headerRow.font = { bold: true };

  if (options.sample) {
    sheet.addRow(columns.map((c) => sampleValue(c)));
  }

  columns.forEach((column, index) => {
    const width = Math.max(column.header.length + 2, column.lookupEntity ? 24 : 12);
    sheet.getColumn(index + 1).width = Math.min(width, 60);
  });

  const schema = workbook.addWorksheet("schema", { views: [{ state: "frozen", ySplit: 1 }] });
  const schemaHeader = schema.addRow(["header", "target", "edm_type", "nullable", "max_length", "lookup_entity"]);
  schemaHeader.font = { bold: true };
  for (const column of columns) {
    schema.addRow([
      column.header,
      column.target,
      column.edmType,
      column.nullable ? "yes" : "no",
      column.maxLength ?? "",
      column.lookupEntity ?? "",
    ]);
  }
  for (const [index, width] of [24, 24, 24, 10, 12, 28].entries()) {
    schema.getColumn(index + 1).width = width;
  }

  ensureDir(outPath);
  await workbook.xlsx.writeFile(outPath);
}

/** Infer the output format from the file extension. */
export function templateFormatFor(outPath: string): "csv" | "xlsx" {
  const ext = path.extname(outPath).toLowerCase();
  if (ext === ".csv") return "csv";
  if (ext === ".xlsx") return "xlsx";
  throw new ConfigError(
    `--out must end with .csv or .xlsx (got ${JSON.stringify(outPath)})`
  );
}
