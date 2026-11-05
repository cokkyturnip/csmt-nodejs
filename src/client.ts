/**
 * Thin, resilient OData 4 client for Creatio.
 */

import { XMLParser } from "fast-xml-parser";
import { AuthManager } from "./auth.js";
import { Settings } from "./config.js";
import { BatchError, ConfigError, ODataError } from "./errors.js";

export const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
export const IDEMPOTENT_METHODS = new Set(["GET", "PATCH", "DELETE"]);
export const JSON_CONTENT_TYPE = "application/json; charset=utf-8; IEEE754Compatible=true";
export const BATCH_CONTENT_TYPE = "application/json; odata=verbose; IEEE754Compatible=true";
export const EDM_NS = "http://docs.oasis-open.org/odata/ns/edm";

export function odataEscape(value: unknown): string {
  return String(value ?? "").replace(/'/g, "''");
}

export function odataLiteral(value: unknown, quote = true): string {
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (quote) {
    return `'${odataEscape(value)}'`;
  }
  return String(value);
}

export class BatchResult {
  constructor(
    public id: string,
    public status: number,
    public body: any = null,
    public headers: Record<string, string> = {}
  ) {}

  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  get recordId(): string | null {
    if (this.body && typeof this.body === "object") {
      for (const key of ["Id", "id"]) {
        const val = this.body[key];
        if (typeof val === "string" && val) {
          return val;
        }
      }
    }
    const location = this.headers["location"] || this.headers["Location"];
    if (location) {
      const match = location.match(/\(([0-9a-fA-F-]{36})\)/);
      if (match && match[1]) {
        return match[1];
      }
    }
    return null;
  }

  get errorMessage(): string | null {
    if (this.ok) return null;
    return extractErrorMessage(this.body) || `HTTP ${this.status}`;
  }
}

export function extractErrorMessage(body: unknown): string | null {
  if (body === null || body === undefined) return null;
  let parsed = body;
  if (typeof body === "string") {
    const text = body.trim();
    if (!text) return null;
    try {
      parsed = JSON.parse(text);
    } catch {
      return text.slice(0, 1000);
    }
  }
  if (parsed && typeof parsed === "object") {
    const map = parsed as Record<string, any>;
    const error = map.error;
    if (error && typeof error === "object") {
      const msg = error.message;
      if (msg) return String(msg);
    }
    for (const key of ["Message", "message", "error_description", "detail"]) {
      if (map[key]) return String(map[key]);
    }
    return JSON.stringify(parsed).slice(0, 1000);
  }
  return String(parsed).slice(0, 1000);
}

export function hintForOdataError(error: ODataError): string | null {
  const message = (error.detail || "").toLowerCase();
  const payload = String(error.payload || "").toLowerCase();
  const blob = `${message} ${payload}`;

  if (blob.includes("permissions to use odata")) {
    return (
      'User integrasi belum punya izin OData. Di Creatio: Setup > Users > ' +
      'System operation permissions, aktifkan operation "Access to OData" ' +
      '(code CanUseODataService) untuk user tersebut; lalu cek juga hak baca/tulis ' +
      'pada object yang dipakai (Access rights to objects).'
    );
  }
  if (message.includes("html") || message.includes("halaman html")) {
    return (
      "Path OData kemungkinan salah. Untuk Creatio .NET Framework gunakan " +
      "/0/odata; untuk .NET 8 gunakan /odata. Cek dengan " +
      "'csmt check --odata-path /0/odata'."
    );
  }
  if (blob.includes("bpmcsrf")) {
    return (
      "Token CSRF ditolak. Untuk Forms auth pastikan cookie BPMCSRF terkirim; " +
      "untuk Basic auth perlindungan CSRF harus dimatikan (UseCsrfToken=false)."
    );
  }
  if (blob.includes("insufficient permissions to") && blob.includes("object")) {
    return (
      "Izin pada object kurang. Beri user integrasi hak baca/tambah/ubah pada " +
      "object tersebut (System Designer > Access rights to objects)."
    );
  }
  return null;
}

export function extractRecordIdFromLocation(location?: string | null): string | null {
  if (!location) return null;
  const match = location.match(/\(([0-9a-fA-F-]{36})\)/);
  if (match && match[1]) {
    return match[1];
  }
  const parts = location.split("/");
  const tail = parts[parts.length - 1]?.replace(/\)$/, "");
  return tail || null;
}

export interface RequestOptions {
  params?: Record<string, any>;
  jsonBody?: any;
  rawBody?: string | Uint8Array;
  headers?: Record<string, string>;
  contentType?: string;
  expected?: number[];
  allow404?: boolean;
  maxAuthRetries?: number;
}

export interface CollectionOptions {
  filter?: string | null;
  select?: string[] | null;
  top?: number | null;
  skip?: number | null;
  orderby?: string | null;
  count?: boolean;
}

export class ODataClient {
  public settings: Settings;
  public auth: AuthManager;
  private sleepFn: (ms: number) => Promise<void>;

  constructor(
    settings: Settings,
    options?: {
      auth?: AuthManager;
      sleep?: (ms: number) => Promise<void>;
    }
  ) {
    this.settings = settings;
    this.auth = options?.auth || new AuthManager(settings);
    this.sleepFn = options?.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

    if (!settings.verifySsl && typeof process !== "undefined" && process.env) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    }
  }

  private url(path = ""): string {
    const trimmed = (path || "").trim();
    if (/^https?:\/\//i.test(trimmed)) {
      return trimmed;
    }
    if (!trimmed) {
      return this.settings.odataUrl;
    }
    return `${this.settings.odataUrl}/${trimmed.replace(/^\/+/, "")}`;
  }

  private requireEntity(entity?: string | null): string {
    const clean = (entity || "").trim().replace(/^\/+|\/+$/g, "");
    if (!clean) {
      throw new ConfigError("An entity set name is required (--entity, e.g. Contact)");
    }
    return clean;
  }

  async request(method: string, path = "", options: RequestOptions = {}): Promise<{ status: number; text: string; json: any; headers: Headers }> {
    const upperMethod = method.toUpperCase();
    let url = this.url(path);
    let retries = 0;
    let authRetries = 0;
    const maxAuthRetries = options.maxAuthRetries ?? 1;
    const expected = options.expected ?? [200, 201, 204];

    if (options.jsonBody !== undefined && options.rawBody !== undefined) {
      throw new ConfigError("Pass either jsonBody or rawBody, not both");
    }

    if (options.params && Object.keys(options.params).length > 0) {
      const u = new URL(url);
      for (const [k, v] of Object.entries(options.params)) {
        if (v !== undefined && v !== null) {
          u.searchParams.set(k, String(v));
        }
      }
      url = u.toString();
    }

    while (true) {
      const requestHeaders: Record<string, string> = {
        Accept: "application/json",
        ForceUseSession: "true",
      };

      if (options.jsonBody !== undefined || options.rawBody !== undefined) {
        requestHeaders["Content-Type"] = options.contentType || JSON_CONTENT_TYPE;
      } else if (options.contentType) {
        requestHeaders["Content-Type"] = options.contentType;
      }

      try {
        const authHdrs = await this.auth.headers();
        Object.assign(requestHeaders, authHdrs);
      } catch (err: unknown) {
        throw new ODataError(
          `Authentication failed before ${upperMethod} ${url}: ${err instanceof Error ? err.message : String(err)}`,
          { method: upperMethod, url }
        );
      }

      if (options.headers) {
        Object.assign(requestHeaders, options.headers);
      }

      let body: any | undefined;
      if (options.jsonBody !== undefined) {
        body = JSON.stringify(options.jsonBody);
      } else if (options.rawBody !== undefined) {
        body = options.rawBody as any;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.settings.timeout * 1000);
      let response: Response;

      try {
        response = await fetch(url, {
          method: upperMethod,
          headers: requestHeaders,
          body,
          signal: controller.signal,
        });
      } catch (err: unknown) {
        clearTimeout(timer);
        if (retries < this.settings.maxRetries && IDEMPOTENT_METHODS.has(upperMethod)) {
          retries += 1;
          await this.backoff(retries, null, err);
          continue;
        }
        throw new ODataError(
          `${upperMethod} ${url} failed after ${retries + 1} attempt(s): ${err instanceof Error ? err.message : String(err)}`,
          { method: upperMethod, url, retryable: true }
        );
      }
      clearTimeout(timer);

      const status = response.status;
      const text = await response.text();
      let parsedJson: any = null;
      try {
        parsedJson = JSON.parse(text);
      } catch {
        parsedJson = null;
      }

      // Check session expiry / rejection
      if (status === 401 || (status === 403 && this.auth.usesCsrf)) {
        if (authRetries < maxAuthRetries) {
          authRetries += 1;
          await this.auth.ensure(true);
          continue;
        }
      }

      // 429 rate limit backoff is allowed for ALL methods
      if (status === 429 || (RETRY_STATUSES.has(status) && IDEMPOTENT_METHODS.has(upperMethod))) {
        if (retries < this.settings.maxRetries) {
          retries += 1;
          const retryAfter = response.headers.get("retry-after") || response.headers.get("Retry-After");
          await this.backoff(retries, retryAfter, null);
          continue;
        }
        throw ODataError.fromResponse({ status, statusText: response.statusText, json: parsedJson, text }, { method: upperMethod, url });
      }

      if (RETRY_STATUSES.has(status)) {
        // Non-idempotent POST/$batch on 5xx: surface to pipeline for reconciliation
        throw ODataError.fromResponse({ status, statusText: response.statusText, json: parsedJson, text }, { method: upperMethod, url });
      }

      if (expected.includes(status)) {
        return { status, text, json: parsedJson, headers: response.headers };
      }
      if (options.allow404 && status === 404) {
        return { status, text, json: parsedJson, headers: response.headers };
      }

      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      if (contentType.includes("html") || text.includes("<html") || text.includes("<!DOCTYPE html")) {
        throw new ODataError(
          "Endpoint mengembalikan halaman HTML, bukan JSON OData. " +
            "Kemungkinan path OData salah untuk instance ini (diarahkan ke halaman login), " +
            "atau sesi tidak diotorisasi. Coba /0/odata dan /odata secara bergantian.",
          { status, payload: text.slice(0, 500), method: upperMethod, url }
        );
      }

      throw ODataError.fromResponse({ status, statusText: response.statusText, json: parsedJson, text }, { method: upperMethod, url });
    }
  }

  private async backoff(attempt: number, retryAfter: string | null, exc: unknown): Promise<void> {
    let delay: number;
    try {
      if (retryAfter !== null && retryAfter !== undefined && retryAfter.trim() !== "") {
        delay = Math.max(0, Number(retryAfter.trim()));
        if (Number.isNaN(delay)) throw new Error("not a number");
      } else {
        throw new Error("fallback");
      }
    } catch {
      delay = this.settings.retryBackoff * Math.pow(2, Math.max(0, attempt - 1));
    }
    delay = Math.min(delay, this.settings.retryMaxDelay);
    delay += delay ? Math.random() * (0.25 * delay) : 0;
    await this.sleepFn(delay * 1000);
  }

  async getCollection(entity: string, options: CollectionOptions = {}): Promise<[any[], number | null]> {
    const cleanEntity = this.requireEntity(entity);
    const params: Record<string, string> = {};

    if (options.filter) params["$filter"] = options.filter;
    if (options.select && options.select.length > 0) params["$select"] = options.select.join(",");
    if (options.top !== undefined && options.top !== null) params["$top"] = String(options.top);
    if (options.skip !== undefined && options.skip !== null) params["$skip"] = String(options.skip);
    if (options.orderby) params["$orderby"] = options.orderby;
    if (options.count) params["$count"] = "true";

    const res = await this.request("GET", cleanEntity, { params, expected: [200] });
    const payload = res.json;
    const items = payload && typeof payload === "object" && Array.isArray(payload.value) ? payload.value : [];
    let total: number | null = null;
    if (options.count && payload && typeof payload === "object") {
      const rawCount = payload["@odata.count"];
      if (rawCount !== undefined && rawCount !== null) {
        const num = Number(rawCount);
        if (!Number.isNaN(num)) total = num;
      }
    }
    return [items, total];
  }

  async *iterCollection(entity: string, options: Omit<CollectionOptions, "count"> = {}): AsyncGenerator<any> {
    const cleanEntity = this.requireEntity(entity);
    const pageSize = options.top || this.settings.pageSize;
    let skip = options.skip || 0;

    while (true) {
      const [items] = await this.getCollection(cleanEntity, {
        filter: options.filter,
        select: options.select,
        top: pageSize,
        skip: skip > 0 ? skip : null,
        orderby: options.orderby,
      });

      if (!items || items.length === 0) return;
      for (const item of items) {
        yield item;
      }
      if (items.length < pageSize) return;
      skip += items.length;
    }
  }

  async count(entity: string, options?: { filter?: string | null }): Promise<number> {
    const cleanEntity = this.requireEntity(entity);
    const params: Record<string, string> = { $count: "true", $top: "0" };
    if (options?.filter) params["$filter"] = options.filter;

    const res = await this.request("GET", cleanEntity, { params, expected: [200] });
    const payload = res.json;
    if (payload && typeof payload === "object") {
      const raw = payload["@odata.count"] ?? payload["value"];
      if (raw !== undefined && raw !== null) {
        const num = Number(raw);
        if (!Number.isNaN(num)) return num;
      }
    }

    let count = 0;
    for await (const _ of this.iterCollection(cleanEntity, { filter: options?.filter, select: ["Id"] })) {
      count++;
    }
    return count;
  }

  async getRecord(entity: string, recordId: string): Promise<Record<string, any> | null> {
    const cleanEntity = this.requireEntity(entity);
    const res = await this.request("GET", `${cleanEntity}(${recordId})`, {
      expected: [200],
      allow404: true,
    });
    if (res.status === 404) return null;
    return res.json && typeof res.json === "object" ? res.json : null;
  }

  async create(entity: string, payload: Record<string, any>): Promise<Record<string, any>> {
    const cleanEntity = this.requireEntity(entity);
    const res = await this.request("POST", cleanEntity, {
      jsonBody: payload,
      expected: [200, 201],
    });
    if (res.json && typeof res.json === "object" && !Array.isArray(res.json)) {
      return res.json;
    }
    const loc = res.headers.get("location") || res.headers.get("Location");
    const recId = extractRecordIdFromLocation(loc);
    return recId ? { Id: recId } : {};
  }

  async update(entity: string, recordId: string, payload: Record<string, any>): Promise<void> {
    const cleanEntity = this.requireEntity(entity);
    if (!recordId) {
      throw new ODataError("Cannot PATCH a record without an id", { method: "PATCH" });
    }
    await this.request("PATCH", `${cleanEntity}(${recordId})`, {
      jsonBody: payload,
      expected: [200, 204],
    });
  }

  async batch(operations: Array<Record<string, any>>, options?: { continueOnError?: boolean }): Promise<Record<string, BatchResult>> {
    if (!operations || operations.length === 0) return {};
    if (operations.length > 100) {
      throw new ConfigError(`A Creatio batch can contain at most 100 requests, got ${operations.length}`);
    }

    const continueOnError = options?.continueOnError ?? true;
    const body = { requests: operations };
    const headers: Record<string, string> = continueOnError ? { Prefer: "continue-on-error" } : {};

    let res: { status: number; text: string; json: any; headers: Headers };
    try {
      res = await this.request("POST", "$batch", {
        jsonBody: body,
        headers,
        contentType: BATCH_CONTENT_TYPE,
        expected: [200, 202],
      });
    } catch (err: unknown) {
      if (err instanceof ODataError) {
        throw new BatchError(`Batch request failed: ${err.detail}`, {
          status: err.status,
          code: err.code,
          payload: err.payload,
          method: "POST",
          url: this.url("$batch"),
          retryable: err.retryable,
        });
      }
      throw err;
    }

    const payload = res.json;
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.responses)) {
      throw new BatchError("Unrecognised batch response shape; expected {'responses': [...]}", {
        payload,
      });
    }

    const results: Record<string, BatchResult> = {};
    for (const item of payload.responses) {
      if (!item || typeof item !== "object") continue;
      const reqId = item.id;
      if (reqId === undefined || reqId === null) continue;
      const status = Number(item.status) || 0;
      let itemBody = item.body;
      if (typeof itemBody === "string") {
        try {
          itemBody = JSON.parse(itemBody);
        } catch {}
      }
      const rawHeaders = item.headers || {};
      const hdrs: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawHeaders)) {
        hdrs[k.toLowerCase()] = String(v);
      }
      results[String(reqId)] = new BatchResult(String(reqId), status, itemBody, hdrs);
    }
    return results;
  }

  async fetchMetadata(): Promise<string> {
    // Creatio .NET Framework tidak mendukung JSON metadata dan menjawab 500
    // ("The JSON metadata is not supported at this platform") bila Accept JSON.
    const res = await this.request("GET", "$metadata", {
      expected: [200],
      headers: { Accept: "application/xml" },
    });
    return res.text;
  }

  async entityFields(entity: string): Promise<Record<string, string>> {
    const metadata = await this.fetchMetadata();
    return parseCsdlEntityFields(metadata, this.requireEntity(entity));
  }

  async serviceDocument(): Promise<Record<string, any>> {
    const res = await this.request("GET", "", { expected: [200] });
    return res.json && typeof res.json === "object" ? res.json : {};
  }

  async ping(): Promise<Record<string, any>> {
    const info: Record<string, any> = {
      root_url: this.settings.rootUrl,
      odata_url: this.settings.odataUrl,
      auth_mode: this.auth.mode,
    };
    const doc = await this.serviceDocument();
    const collections = doc.value;
    info.collections = Array.isArray(collections) ? collections.length : null;

    const entity = this.settings.entity;
    if (entity) {
      const [items] = await this.getCollection(entity, { top: 1 });
      info.entity = entity;
      info.entity_reachable = true;
      info.sample_fields = items && items[0] ? Object.keys(items[0]).sort() : [];
    }
    return info;
  }

  close(): void {
    this.auth.close();
  }
}

export function parseCsdlEntityFields(xmlText: string, entitySet: string): Record<string, string> {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    removeNSPrefix: true,
  });

  let parsed: any;
  try {
    parsed = parser.parse(xmlText);
  } catch (err: unknown) {
    throw new ODataError(`Could not parse $metadata: ${err instanceof Error ? err.message : String(err)}`);
  }

  const edmx = parsed?.Edmx ?? parsed;
  const dataServices = edmx?.DataServices;
  const schemas = Array.isArray(dataServices?.Schema) ? dataServices.Schema : [dataServices?.Schema].filter(Boolean);

  const entityTypes: Record<string, any> = {};
  const entitySets: Record<string, string> = {};

  for (const schema of schemas) {
    const types = Array.isArray(schema.EntityType) ? schema.EntityType : [schema.EntityType].filter(Boolean);
    for (const t of types) {
      if (t?.Name) {
        entityTypes[t.Name] = t;
      }
    }

    const containers = Array.isArray(schema.EntityContainer) ? schema.EntityContainer : [schema.EntityContainer].filter(Boolean);
    for (const c of containers) {
      const sets = Array.isArray(c.EntitySet) ? c.EntitySet : [c.EntitySet].filter(Boolean);
      for (const s of sets) {
        if (s?.Name) {
          const typeAttr = s.EntityType || "";
          const typeName = typeAttr.split(".").pop() || s.Name;
          entitySets[s.Name] = typeName;
        }
      }
    }
  }

  let typeName = entitySets[entitySet];
  if (!typeName && entityTypes[entitySet]) {
    typeName = entitySet;
  }

  if (!typeName || !entityTypes[typeName]) {
    throw new ODataError(
      `Entity set ${JSON.stringify(entitySet)} was not found in $metadata (known: ${Object.keys(entityTypes).sort().slice(0, 15).join(", ")})`
    );
  }

  const fields: Record<string, string> = {};
  const visited = new Set<string>();

  function collect(currentType: string, depth = 0): void {
    if (depth > 10 || visited.has(currentType) || !entityTypes[currentType]) return;
    visited.add(currentType);

    const typeDef = entityTypes[currentType];
    const props = Array.isArray(typeDef.Property) ? typeDef.Property : [typeDef.Property].filter(Boolean);
    for (const p of props) {
      if (p?.Name) {
        fields[p.Name] = p.Type || "";
      }
    }

    const base = typeDef.BaseType;
    if (base) {
      const baseName = String(base).split(".").pop();
      if (baseName) {
        collect(baseName, depth + 1);
      }
    }
  }

  collect(typeName);
  return fields;
}
