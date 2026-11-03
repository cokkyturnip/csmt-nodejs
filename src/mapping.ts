/**
 * Mapping CSV/XLSX columns to Creatio fields, with type coercion and lookups.
 */

import fs from "node:fs";
import path from "node:path";
import { MappingError, ValidationError } from "./errors.js";
import { Row } from "./tabular.js";

const TRUE_VALUES = new Set(["1", "true", "t", "yes", "y", "ya", "yup"]);
const FALSE_VALUES = new Set(["0", "false", "f", "no", "n", "tidak", "tid", "nope"]);

export const SUPPORTED_TYPES = new Set([
  "string",
  "text",
  "guid",
  "int",
  "integer",
  "decimal",
  "float",
  "bool",
  "boolean",
  "date",
  "datetime",
  "lookup",
]);

const GUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const TRANSFORMS: Record<string, (val: string) => string> = {
  none: (v) => v,
  trim: (v) => v.trim(),
  upper: (v) => v.trim().toUpperCase(),
  lower: (v) => v.trim().toLowerCase(),
  title: (v) =>
    v
      .split(/\s+/)
      .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1).toLowerCase() : ""))
      .join(" "),
  capitalize: (v) => {
    const s = v.trim();
    return s ? s[0]!.toUpperCase() + s.slice(1) : "";
  },
  collapse_spaces: (v) => v.replace(/\s+/g, " ").trim(),
  digits: (v) => v.replace(/\D+/g, ""),
  digits_plus_prefix: (v) => {
    const d = v.replace(/\D+/g, "");
    return d ? `+${d}` : "";
  },
  strip_zero_width: (v) => v.replace(/[\u200b\ufeff]/g, "").trim(),
};

export class LookupSpec {
  constructor(
    public entity: string,
    public keyField = "Name",
    public quote = true,
    public select: string[] = []
  ) {}

  static fromDict(data: Record<string, any>): LookupSpec {
    const entity = String(data.entity || "").trim();
    if (!entity) {
      throw new MappingError("lookup.entity is required");
    }
    const keyField = String(data.key_field || data.key || "Name").trim();
    let select: string[] = [];
    if (Array.isArray(data.select)) {
      select = data.select.map(String);
    } else if (typeof data.select === "string") {
      select = data.select.split(",").map((p: string) => p.trim()).filter(Boolean);
    }
    return new LookupSpec(entity, keyField, data.quote !== false, select);
  }
}

export class FieldSpec {
  public source: string;
  public target: string;
  public type: string;
  public transform?: string;
  public required: boolean;
  public default?: any;
  public nullForEmpty: boolean;
  public dateFormat?: string;
  public lookup?: LookupSpec;
  public choices?: Record<string, string>;
  public maxLength?: number;

  constructor(opts: {
    source: string;
    target?: string;
    type?: string;
    transform?: string;
    required?: boolean;
    default?: any;
    nullForEmpty?: boolean;
    dateFormat?: string;
    lookup?: LookupSpec;
    choices?: Record<string, string>;
    maxLength?: number;
  }) {
    this.source = opts.source;
    this.target = opts.target || opts.source;
    this.type = (opts.type || "string").trim().toLowerCase();
    this.transform = opts.transform;
    this.required = Boolean(opts.required);
    this.default = opts.default;
    this.nullForEmpty = Boolean(opts.nullForEmpty);
    this.dateFormat = opts.dateFormat;
    this.lookup = opts.lookup;
    this.choices = opts.choices;
    this.maxLength = opts.maxLength;

    if (!SUPPORTED_TYPES.has(this.type)) {
      throw new MappingError(
        `Field ${JSON.stringify(this.source)}: unsupported type ${JSON.stringify(this.type)}; expected one of ${Array.from(SUPPORTED_TYPES).sort().join(", ")}`
      );
    }
    if (this.transform && !(this.transform in TRANSFORMS)) {
      throw new MappingError(
        `Field ${JSON.stringify(this.source)}: unknown transform ${JSON.stringify(this.transform)}; expected one of ${Object.keys(TRANSFORMS).sort().join(", ")}`
      );
    }
    if (this.type === "lookup" && !this.lookup) {
      throw new MappingError(`Field ${JSON.stringify(this.source)}: type 'lookup' requires a lookup spec`);
    }
    if (this.choices) {
      const normalizedChoices: Record<string, string> = {};
      for (const [k, v] of Object.entries(this.choices)) {
        normalizedChoices[String(k).trim()] = String(v);
      }
      this.choices = normalizedChoices;
    }
  }

  static fromDict(source: string, data: any): FieldSpec {
    if (typeof data === "string") {
      return new FieldSpec({ source, target: data });
    }
    if (!data || typeof data !== "object") {
      throw new MappingError(`Field ${JSON.stringify(source)}: definition must be an object or a string`);
    }

    const lookup = data.lookup && typeof data.lookup === "object" ? LookupSpec.fromDict(data.lookup) : undefined;
    return new FieldSpec({
      source,
      target: String(data.target || source).trim(),
      type: String(data.type || "string"),
      transform: data.transform,
      required: Boolean(data.required),
      default: data.default,
      nullForEmpty: Boolean(data.null_for_empty),
      dateFormat: data.format || data.date_format,
      lookup,
      choices: data.choices,
      maxLength: data.max_length ? Number(data.max_length) : undefined,
    });
  }
}

export class PendingLookup {
  public resolvedId?: string;
  public errorStatus?: number;
  public errorMessage?: string;

  constructor(
    public target: string,
    public entity: string,
    public keyField: string,
    public value: string,
    public quote = true,
    public select: string[] = []
  ) {}
}

export class PreparedRow {
  public pending: PendingLookup[] = [];
  public keyValues: Record<string, any> = {};
  public keyQueryValues: Record<string, any> = {};

  constructor(
    public lineno: number,
    public payload: Record<string, any>,
    options?: {
      pending?: PendingLookup[];
      keyValues?: Record<string, any>;
      keyQueryValues?: Record<string, any>;
    }
  ) {
    if (options?.pending) this.pending = options.pending;
    if (options?.keyValues) this.keyValues = options.keyValues;
    if (options?.keyQueryValues) this.keyQueryValues = options.keyQueryValues;
  }

  get keyTuple(): string[] {
    return Object.keys(this.keyValues).map((k) => String(this.keyValues[k] ?? ""));
  }

  get keyText(): string {
    const keys = Object.keys(this.keyValues);
    if (keys.length === 0) return `row:${this.lineno}`;
    return keys.map((k) => `${k}=${this.keyValues[k]}`).join("|");
  }
}

export class Mapping {
  constructor(
    public fields: FieldSpec[],
    public keyFields: string[] = [],
    public constants: Record<string, any> = {},
    public defaults: Record<string, any> = {},
    public entity?: string
  ) {
    this.validateKeys();
  }

  static fromDict(data: Record<string, any>): Mapping {
    if (!data || typeof data !== "object") {
      throw new MappingError("Mapping must be a JSON object");
    }

    const rawFields = data.fields;
    const fields: FieldSpec[] = [];

    if (rawFields && typeof rawFields === "object" && !Array.isArray(rawFields)) {
      for (const [source, spec] of Object.entries(rawFields)) {
        fields.push(FieldSpec.fromDict(source, spec));
      }
    } else if (Array.isArray(rawFields)) {
      for (const item of rawFields) {
        if (!item || typeof item !== "object" || !item.source) {
          throw new MappingError("Each entry in 'fields' needs a 'source' key");
        }
        fields.push(FieldSpec.fromDict(String(item.source), item));
      }
    } else {
      throw new MappingError("Mapping needs a 'fields' object or list");
    }

    let keyFields: string[] = [];
    const rawKeys = data.key_fields || data.keys;
    if (typeof rawKeys === "string") {
      keyFields = rawKeys.split(",").map((p) => p.trim()).filter(Boolean);
    } else if (Array.isArray(rawKeys)) {
      keyFields = rawKeys.map(String);
    }

    const constants: Record<string, any> = {};
    if (data.constants && typeof data.constants === "object") {
      for (const [k, v] of Object.entries(data.constants)) {
        constants[k] = v;
      }
    }

    const defaults: Record<string, any> = {};
    if (data.defaults && typeof data.defaults === "object") {
      for (const [k, v] of Object.entries(data.defaults)) {
        defaults[k] = v;
      }
    }

    return new Mapping(fields, keyFields, constants, defaults, data.entity);
  }

  static load(filePath: string): Mapping {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      throw new MappingError(`Mapping file not found: ${resolved}`);
    }
    let data: any;
    try {
      const content = fs.readFileSync(resolved, "utf-8").replace(/^\ufeff/, "");
      data = JSON.parse(content);
    } catch (err: unknown) {
      throw new MappingError(`Mapping file ${resolved} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    return Mapping.fromDict(data);
  }

  static identity(columns: string[], options?: { keyFields?: string[]; entity?: string }): Mapping {
    const fields = columns.map((col) => {
      const trimmed = col.trim();
      const lowered = trimmed.toLowerCase();
      const type = lowered === "id" || lowered === "recordid" ? "guid" : "string";
      return new FieldSpec({ source: col, target: trimmed, type });
    });
    return new Mapping(fields, options?.keyFields || [], {}, {}, options?.entity);
  }

  get targets(): string[] {
    return this.fields.map((f) => f.target);
  }

  validateKeys(): void {
    const targetSet = new Set(this.targets);
    const unknown = this.keyFields.filter((k) => !targetSet.has(k));
    if (unknown.length > 0) {
      throw new MappingError(
        `Key field(s) ${JSON.stringify(unknown)} are not produced by the mapping. Known targets: ${Array.from(targetSet).sort().join(", ")}`
      );
    }

    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const spec of this.fields) {
      if (seen.has(spec.target)) {
        duplicates.add(spec.target);
      }
      seen.add(spec.target);
    }
    if (duplicates.size > 0) {
      throw new MappingError(`Duplicate target field(s) in mapping: ${Array.from(duplicates).sort().join(", ")}`);
    }
  }

  missingSources(columns: Iterable<string>): string[] {
    const available = new Set(columns);
    return this.fields.filter((spec) => !available.has(spec.source)).map((s) => s.source);
  }

  validateTargets(allowed: Iterable<string>): void {
    const allowedSet = new Set(allowed);
    if (allowedSet.size === 0) return;
    const unknown = this.targets.filter((t) => !allowedSet.has(t)).sort();
    if (unknown.length > 0) {
      throw new MappingError(`Mapping targets field(s) that do not exist on the entity: ${unknown.join(", ")}`);
    }
  }
}

export class Mapper {
  constructor(public mapping: Mapping) {}

  prepare(row: Row): PreparedRow {
    const payload: Record<string, any> = { ...this.mapping.constants };
    const pending: PendingLookup[] = [];
    const keyValues: Record<string, any> = {};
    const keyQueryValues: Record<string, any> = {};

    for (const spec of this.mapping.fields) {
      const raw = row.values[spec.source];
      const isEmpty = raw === undefined || raw === null || String(raw).trim() === "";

      if (isEmpty) {
        if (spec.default !== undefined && spec.default !== null) {
          if (spec.type === "lookup") {
            const lookup = spec.lookup!;
            pending.push(
              new PendingLookup(
                spec.target,
                lookup.entity,
                lookup.keyField,
                String(spec.default).trim(),
                lookup.quote,
                lookup.select
              )
            );
            payload[spec.target] = null;
            if (this.mapping.keyFields.includes(spec.target)) {
              keyValues[spec.target] = String(spec.default).trim();
            }
            continue;
          }
          const val = this.coerce(spec, spec.default);
          payload[spec.target] = val;
        } else if (spec.required) {
          throw new ValidationError("value is required but empty", { field: spec.source });
        } else if (spec.nullForEmpty) {
          payload[spec.target] = null;
        } else {
          continue;
        }
      } else {
        const val = this.prepareValue(spec, String(raw));
        if (val instanceof PendingLookup) {
          pending.push(val);
          payload[spec.target] = null;
          if (this.mapping.keyFields.includes(spec.target)) {
            keyValues[spec.target] = val.value;
          }
          continue;
        }
        payload[spec.target] = val;
      }

      if (this.mapping.keyFields.includes(spec.target)) {
        keyValues[spec.target] = payload[spec.target];
      }
    }

    for (const [target, defaultVal] of Object.entries(this.mapping.defaults)) {
      if (payload[target] === undefined) {
        payload[target] = defaultVal;
      }
    }

    for (const key of this.mapping.keyFields) {
      if (keyValues[key] === undefined && payload[key] !== undefined && payload[key] !== null) {
        keyValues[key] = payload[key];
      }
    }

    if (this.mapping.keyFields.length > 0) {
      for (const key of this.mapping.keyFields) {
        if (keyValues[key] === undefined || keyValues[key] === null || keyValues[key] === "") {
          throw new ValidationError(`key field ${JSON.stringify(key)} is empty; cannot match the record`, {
            field: key,
          });
        }
      }
      Object.assign(keyQueryValues, keyValues);
    }

    return new PreparedRow(row.lineno, payload, { pending, keyValues, keyQueryValues });
  }

  private prepareValue(spec: FieldSpec, raw: string): any {
    let value = raw;
    if (spec.choices) {
      const mapped = spec.choices[value.trim()];
      if (mapped === undefined) {
        throw new ValidationError(
          `value ${JSON.stringify(value)} is not one of ${Object.keys(spec.choices).sort().join(", ")}`,
          { field: spec.source }
        );
      }
      value = mapped;
    }

    if (spec.transform) {
      const fn = TRANSFORMS[spec.transform];
      if (fn) {
        try {
          value = fn(value);
        } catch (err: unknown) {
          throw new ValidationError(
            `transform ${JSON.stringify(spec.transform)} failed: ${err instanceof Error ? err.message : String(err)}`,
            { field: spec.source }
          );
        }
      }
    }

    if (spec.type === "lookup") {
      const lookup = spec.lookup!;
      return new PendingLookup(
        spec.target,
        lookup.entity,
        lookup.keyField,
        String(value).trim(),
        lookup.quote,
        lookup.select
      );
    }

    return this.coerce(spec, value);
  }

  private coerce(spec: FieldSpec, value: any): any {
    const converter = CONVERTERS[spec.type] || toStringConverter;
    let converted: any;
    try {
      converted = converter(value, spec);
    } catch (err: unknown) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError(err instanceof Error ? err.message : "invalid value", {
        field: spec.source,
        value,
      });
    }

    if (spec.maxLength && typeof converted === "string" && converted.length > spec.maxLength) {
      throw new ValidationError(`value is ${converted.length} characters, max is ${spec.maxLength}`, {
        field: spec.source,
        value,
      });
    }
    return converted;
  }

  finalize(prepared: PreparedRow): PreparedRow {
    for (const lookup of prepared.pending) {
      if (!lookup.resolvedId) {
        if (lookup.errorStatus) {
          throw new ValidationError(`lookup query for ${JSON.stringify(lookup.value)} failed: ${lookup.errorMessage}`, {
            field: lookup.target,
            value: lookup.value,
          });
        }
        throw new ValidationError(
          `lookup value ${JSON.stringify(lookup.value)} was not found in ${lookup.entity}.${lookup.keyField}`,
          { field: lookup.target, value: lookup.value }
        );
      }

      prepared.payload[lookup.target] = lookup.resolvedId;
      if (this.mapping.keyFields.includes(lookup.target)) {
        prepared.keyValues[lookup.target] = lookup.value;
        prepared.keyQueryValues[lookup.target] = lookup.resolvedId;
      }
    }

    for (const key of this.mapping.keyFields) {
      const val = prepared.payload[key];
      if (val === undefined || val === null || val === "") {
        throw new ValidationError(`key field ${JSON.stringify(key)} is empty; cannot match the record`, {
          field: key,
        });
      }
    }

    prepared.pending = [];
    return prepared;
  }
}

// Converters
function toStringConverter(value: any, spec: FieldSpec): string {
  const text = String(value ?? "");
  if (spec.transform === undefined) {
    return text.trim();
  }
  return text;
}

function toGuidConverter(value: any, spec: FieldSpec): string {
  const clean = String(value ?? "").trim().replace(/^\{|\}$/g, "");
  if (!GUID_REGEX.test(clean)) {
    throw new ValidationError(`${JSON.stringify(value)} is not a valid GUID`, {
      field: spec.source,
      value,
    });
  }
  return clean.toLowerCase();
}

export function parseDecimal(value: any, spec?: FieldSpec): string {
  let text = String(value ?? "").trim().replace(/\u00a0/g, "").replace(/ /g, "");
  if (!text) throw new Error("empty number");

  const negative = text.startsWith("-") || (text.startsWith("(") && text.endsWith(")"));
  text = text.replace(/^\(|\)$/g, "").replace(/^[+-]/, "");

  // Reject non-decimal forms like hex 0x10 or Infinity
  if (/^0x/i.test(text) || text.toLowerCase() === "infinity" || text.toLowerCase() === "nan") {
    throw new Error(`invalid number: ${value}`);
  }

  let commaDecimal = false;
  if (text.includes(",") && text.includes(".")) {
    commaDecimal = text.lastIndexOf(",") > text.lastIndexOf(".");
  } else if (text.includes(",")) {
    const tail = text.slice(text.lastIndexOf(",") + 1);
    commaDecimal = tail.length <= 2;
  }

  if (commaDecimal) {
    text = text.replace(/\./g, "").replace(/,/g, ".");
  } else {
    text = text.replace(/,/g, "");
  }

  const num = Number(text);
  if (Number.isNaN(num) || !Number.isFinite(num)) {
    throw new Error(`invalid number: ${value}`);
  }

  // Canonicalize scientific notation if present (e.g. 1e5 -> 100000)
  if (/[eE]/.test(text)) {
    text = num.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 });
  }

  // Canonicalize trailing dot e.g. "1." -> "1"
  if (/^\d+\.$/.test(text)) {
    text = text.slice(0, -1);
  }

  if (!/^\d+(?:\.\d+)?$/.test(text)) {
    throw new Error(`invalid number: ${value}`);
  }

  return (negative ? "-" : "") + text;
}

function toIntConverter(value: any, spec: FieldSpec): number {
  const decStr = parseDecimal(value, spec);
  const num = Number(decStr);
  if (!Number.isInteger(num)) {
    throw new ValidationError(`${JSON.stringify(value)} is not an integer`, {
      field: spec.source,
      value,
    });
  }
  return num;
}

function toDecimalConverter(value: any, spec: FieldSpec): string {
  return parseDecimal(value, spec);
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

export const DEFAULT_DATE_FORMATS = [
  "%Y-%m-%d",
  "%Y-%m-%dT%H:%M:%S",
  "%Y-%m-%d %H:%M:%S",
  "%Y-%m-%dT%H:%M",
  "%Y-%m-%d %H:%M",
  "%d/%m/%Y",
  "%d/%m/%Y %H:%M:%S",
  "%d/%m/%Y %H:%M",
  "%d-%m-%Y",
  "%d.%m.%Y",
  "%Y/%m/%d",
  "%d/%m/%y",
  "%m/%d/%Y",
  "%Y%m%d",
];

const DATE_ONLY_FORMATS = new Set([
  "%Y-%m-%d",
  "%d/%m/%Y",
  "%d-%m-%Y",
  "%d.%m.%Y",
  "%Y/%m/%d",
  "%d/%m/%y",
  "%m/%d/%Y",
  "%Y%m%d",
]);

export interface ParsedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  isDateOnly: boolean;
  tzOffset?: string;
}

function parseWithFormat(text: string, fmt: string): ParsedDateParts | null {
  let regexPattern = "^";
  const fields: string[] = [];
  let i = 0;
  while (i < fmt.length) {
    if (fmt[i] === "%" && i + 1 < fmt.length) {
      const code = fmt[i + 1]!;
      i += 2;
      switch (code) {
        case "Y":
          regexPattern += "(\\d{4})";
          fields.push("Y");
          break;
        case "y":
          regexPattern += "(\\d{2})";
          fields.push("y");
          break;
        case "m":
          regexPattern += "(\\d{1,2})";
          fields.push("m");
          break;
        case "d":
          regexPattern += "(\\d{1,2})";
          fields.push("d");
          break;
        case "H":
          regexPattern += "(\\d{1,2})";
          fields.push("H");
          break;
        case "M":
          regexPattern += "(\\d{1,2})";
          fields.push("M");
          break;
        case "S":
          regexPattern += "(\\d{1,2})";
          fields.push("S");
          break;
        case "b":
        case "B":
          regexPattern += "([A-Za-z]+)";
          fields.push(code);
          break;
        default:
          regexPattern += "\\" + code;
      }
    } else {
      const ch = fmt[i]!;
      regexPattern += /[.\\+*?[^\]$(){}=!<>|:-]/.test(ch) ? "\\" + ch : ch;
      i++;
    }
  }
  regexPattern += "$";

  const match = text.match(new RegExp(regexPattern, "i"));
  if (!match) return null;

  let year = 1970;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;

  for (let idx = 0; idx < fields.length; idx++) {
    const f = fields[idx]!;
    const val = match[idx + 1]!;
    switch (f) {
      case "Y":
        year = Number(val);
        break;
      case "y": {
        const y2 = Number(val);
        year = y2 >= 69 ? 1900 + y2 : 2000 + y2;
        break;
      }
      case "m":
        month = Number(val);
        break;
      case "d":
        day = Number(val);
        break;
      case "H":
        hour = Number(val);
        break;
      case "M":
        minute = Number(val);
        break;
      case "S":
        second = Number(val);
        break;
      case "b":
      case "B": {
        const mNum = MONTH_NAMES[val.toLowerCase()];
        if (!mNum) return null;
        month = mNum;
        break;
      }
    }
  }

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    isDateOnly: DATE_ONLY_FORMATS.has(fmt),
  };
}

function parseIsoFallback(text: string): ParsedDateParts | null {
  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:(Z|[+-]\d{2}:?\d{2}))?$/i);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    const hour = Number(isoMatch[4]);
    const minute = Number(isoMatch[5]);
    const second = Number(isoMatch[6] || 0);
    const tzOffset = isoMatch[7] || undefined;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { year, month, day, hour, minute, second, isDateOnly: false, tzOffset };
    }
  }
  return null;
}

export function parseDate(value: any, spec?: FieldSpec): Date {
  const text = String(value ?? "").trim();
  if (!text) throw new Error("empty date");

  const formats: string[] = [];
  if (spec?.dateFormat) {
    formats.push(spec.dateFormat);
  }
  formats.push(...DEFAULT_DATE_FORMATS);

  for (const fmt of formats) {
    const parsed = parseWithFormat(text, fmt);
    if (parsed) {
      const d = new Date(parsed.year, parsed.month - 1, parsed.day, parsed.hour, parsed.minute, parsed.second);
      (d as any)._parsedComponents = parsed;
      return d;
    }
  }

  const iso = parseIsoFallback(text);
  if (iso) {
    const d = new Date(iso.year, iso.month - 1, iso.day, iso.hour, iso.minute, iso.second);
    (d as any)._parsedComponents = iso;
    return d;
  }

  throw new Error(`${JSON.stringify(value)} is not a recognised date`);
}

function toBoolConverter(value: any, spec: FieldSpec): boolean {
  const text = String(value ?? "").trim().toLowerCase();
  if (TRUE_VALUES.has(text)) return true;
  if (FALSE_VALUES.has(text)) return false;
  throw new ValidationError(
    `${JSON.stringify(value)} is not a boolean (expected one of ${Array.from(new Set([...TRUE_VALUES, ...FALSE_VALUES])).sort().join(", ")})`,
    { field: spec.source, value }
  );
}

function toDateConverter(value: any, spec: FieldSpec): string {
  const d = parseDate(value, spec);
  const comp = (d as any)._parsedComponents as ParsedDateParts | undefined;
  const year = comp ? comp.year : d.getFullYear();
  const month = comp ? comp.month : d.getMonth() + 1;
  const day = comp ? comp.day : d.getDate();
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function toDatetimeConverter(value: any, spec: FieldSpec): string {
  const d = parseDate(value, spec);
  const comp = (d as any)._parsedComponents as ParsedDateParts | undefined;
  const year = comp ? comp.year : d.getFullYear();
  const month = comp ? comp.month : d.getMonth() + 1;
  const day = comp ? comp.day : d.getDate();
  const hour = comp ? comp.hour : d.getHours();
  const min = comp ? comp.minute : d.getMinutes();
  const sec = comp ? comp.second : d.getSeconds();
  const base = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  if (comp?.tzOffset) {
    return `${base}${comp.tzOffset}`;
  }
  return base;
}

const CONVERTERS: Record<string, (val: any, spec: FieldSpec) => any> = {
  string: toStringConverter,
  text: toStringConverter,
  guid: toGuidConverter,
  int: toIntConverter,
  integer: toIntConverter,
  decimal: toDecimalConverter,
  float: toDecimalConverter,
  bool: toBoolConverter,
  boolean: toBoolConverter,
  date: toDateConverter,
  datetime: toDatetimeConverter,
};

export function buildIdentityMapping(
  columns: string[],
  options?: { entity?: string; keyColumns?: string[] }
): Record<string, any> {
  const fields: Record<string, any> = {};
  for (const column of columns) {
    const lowered = column.trim().toLowerCase();
    const spec: Record<string, any> = { target: column.trim() };
    if (lowered === "id" || lowered === "recordid") {
      spec.type = "guid";
    } else if (["date", "tanggal", "tgl"].some((token) => lowered.includes(token))) {
      spec.type = "date";
    } else if (
      ["amount", "price", "score", "nilai", "jumlah", "total", "nominal"].some((token) => lowered.includes(token))
    ) {
      spec.type = "decimal";
    } else {
      spec.type = "string";
    }
    fields[column] = spec;
  }

  const document: Record<string, any> = { fields };
  if (options?.entity) {
    document.entity = options.entity;
  }
  if (options?.keyColumns && options.keyColumns.length > 0) {
    document.key_fields = options.keyColumns.map((c) => c.trim());
  }
  return document;
}
