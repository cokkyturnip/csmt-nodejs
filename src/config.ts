/**
 * Configuration: CLI flags, environment variables and .env files.
 */

import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "./errors.js";

const TRUE_SET = new Set(["1", "true", "yes", "y", "on"]);
const FALSE_SET = new Set(["0", "false", "no", "n", "off"]);
const AUTH_MODES = new Set(["auto", "basic", "forms", "oauth2"]);
const ODATA_SUFFIXES = ["/0/odata", "/odata"] as const;

export function asBool(value: unknown, name: string): boolean {
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (TRUE_SET.has(text)) return true;
  if (FALSE_SET.has(text)) return false;
  throw new ConfigError(`${name} must be a boolean, got ${JSON.stringify(value)}`);
}

export function asFloat(value: unknown, name: string): number {
  const num = Number(value);
  if (Number.isNaN(num)) {
    throw new ConfigError(`${name} must be a number, got ${JSON.stringify(value)}`);
  }
  return num;
}

export function asInt(value: unknown, name: string): number {
  const num = Number.parseInt(String(value), 10);
  if (Number.isNaN(num)) {
    throw new ConfigError(`${name} must be an integer, got ${JSON.stringify(value)}`);
  }
  return num;
}

export const CREATIO_CLOUD_SUFFIX = ".creatio.com";

export function identityUrlCandidates(baseUrl: string): string[] {
  let text = String(baseUrl || "").trim();
  if (!/^https?:\/\//i.test(text)) {
    text = "https://" + text;
  }
  let host = "";
  try {
    host = new URL(text).hostname.toLowerCase();
  } catch {
    return [];
  }
  if (!host.endsWith(CREATIO_CLOUD_SUFFIX)) {
    return [];
  }
  const subdomain = host.slice(0, -CREATIO_CLOUD_SUFFIX.length);
  if (!subdomain || subdomain.includes(".")) {
    return [];
  }
  return [
    `https://${subdomain}-is${CREATIO_CLOUD_SUFFIX}`,
    `https://${subdomain}_is${CREATIO_CLOUD_SUFFIX}`,
  ];
}

export function defaultIdentityUrl(baseUrl: string): string | null {
  const candidates = identityUrlCandidates(baseUrl);
  return candidates[0] ?? null;
}

export function normalizeBaseUrl(raw: string, odataPath = "/0/odata"): [string, string] {
  if (!raw || !String(raw).trim()) {
    throw new ConfigError("Creatio base URL is required (--base-url or CREATIO_BASE_URL)");
  }

  let text = String(raw).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(text)) {
    text = "https://" + text;
  }

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new ConfigError(`Invalid Creatio base URL: ${JSON.stringify(raw)}`);
  }

  if (!parsed.host) {
    throw new ConfigError(`Invalid Creatio base URL: ${JSON.stringify(raw)}`);
  }

  if (!/^[A-Za-z0-9.[\]:\-]+(:\d+)?$/.test(parsed.host)) {
    throw new ConfigError(`Invalid Creatio base URL host: ${JSON.stringify(raw)}`);
  }

  let pathname = parsed.pathname.replace(/\/+$/, "");
  let resolvedOdata = (odataPath || "/0/odata").trim();
  if (!resolvedOdata.startsWith("/")) {
    resolvedOdata = "/" + resolvedOdata;
  }

  for (const suffix of ODATA_SUFFIXES) {
    if (pathname.endsWith(suffix)) {
      pathname = pathname.slice(0, -suffix.length);
      resolvedOdata = suffix;
      break;
    }
  }

  const root = `${parsed.protocol}//${parsed.host}${pathname}`;
  return [root.replace(/\/+$/, ""), resolvedOdata];
}

export interface SettingsOptions {
  baseUrl: string;
  odataPath?: string;
  entity?: string;
  authMode?: string;
  username?: string | null;
  password?: string | null;
  clientId?: string | null;
  clientSecret?: string | null;
  identityUrl?: string | null;
  scope?: string | null;
  verifySsl?: boolean;
  timeout?: number;
  maxRetries?: number;
  retryBackoff?: number;
  retryMaxDelay?: number;
  userAgent?: string;
  pageSize?: number;
}

export class Settings {
  public baseUrl: string;
  public odataPath: string;
  public entity: string;
  public authMode: string;

  public username: string | null;
  public password: string | null;
  public clientId: string | null;
  public clientSecret: string | null;
  public identityUrl: string | null;
  public scope: string | null;

  public verifySsl: boolean;
  public timeout: number;
  public maxRetries: number;
  public retryBackoff: number;
  public retryMaxDelay: number;
  public userAgent: string;
  public pageSize: number;

  public rootUrl: string;

  constructor(opts: SettingsOptions) {
    if (!opts.baseUrl) {
      throw new ConfigError("Creatio base URL is required (--base-url or CREATIO_BASE_URL)");
    }
    const [root, odata] = normalizeBaseUrl(opts.baseUrl, opts.odataPath || "/0/odata");
    this.rootUrl = root;
    this.baseUrl = opts.baseUrl;
    this.odataPath = odata;
    this.entity = (opts.entity || "").trim();

    const mode = (opts.authMode || "auto").trim().toLowerCase();
    if (!AUTH_MODES.has(mode)) {
      throw new ConfigError(
        `Unknown auth mode ${JSON.stringify(mode)}; expected one of ${Array.from(AUTH_MODES).sort()}`
      );
    }
    this.authMode = mode;

    this.username = opts.username ?? null;
    this.password = opts.password ?? null;
    this.clientId = opts.clientId ?? null;
    this.clientSecret = opts.clientSecret ?? null;
    this.identityUrl = opts.identityUrl ?? null;
    this.scope = opts.scope ?? null;

    this.verifySsl = opts.verifySsl ?? true;
    this.timeout = opts.timeout !== undefined ? Number(opts.timeout) : 60.0;
    if (this.timeout <= 0) {
      throw new ConfigError("timeout must be greater than zero");
    }
    this.maxRetries = opts.maxRetries !== undefined ? Math.floor(Number(opts.maxRetries)) : 5;
    if (this.maxRetries < 0) {
      throw new ConfigError("max_retries must be zero or greater");
    }
    this.retryBackoff = opts.retryBackoff !== undefined ? Number(opts.retryBackoff) : 1.0;
    this.retryMaxDelay = opts.retryMaxDelay !== undefined ? Number(opts.retryMaxDelay) : 30.0;
    this.userAgent = opts.userAgent || "csmt-node/1.0";
    const rawPageSize = opts.pageSize !== undefined ? Math.floor(Number(opts.pageSize)) : 500;
    this.pageSize = Math.max(1, Math.min(rawPageSize, 20000));
  }

  get odataUrl(): string {
    return `${this.rootUrl}${this.odataPath}`;
  }

  get loginUrl(): string {
    return `${this.rootUrl}/ServiceModel/AuthService.svc/Login`;
  }

  get identityCandidates(): string[] {
    const explicit = (this.identityUrl || "").trim().replace(/\/+$/, "");
    const derived = identityUrlCandidates(this.rootUrl);
    if (explicit) {
      return [explicit, ...derived.filter((cand) => cand !== explicit)];
    }
    return derived;
  }

  get resolvedIdentityUrl(): string | null {
    const candidates = this.identityCandidates;
    return candidates[0] ?? null;
  }

  get tokenEndpoint(): string {
    const identity = this.resolvedIdentityUrl;
    if (!identity) {
      throw new ConfigError(
        "OAuth 2.0 membutuhkan identity service URL (--identity-url / " +
          "CREATIO_IDENTITY_URL), yaitu nilai system setting OAuth20IdentityServerUrl. " +
          "Untuk domain non-cloud tidak ada default."
      );
    }
    const base = identity.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(base)) {
      throw new ConfigError(`Identity service URL harus absolut (http/https): ${JSON.stringify(identity)}`);
    }
    if (base.toLowerCase().endsWith("/connect/token")) {
      return base;
    }
    return `${base}/connect/token`;
  }

  get resolvedAuthMode(): string {
    let mode = this.authMode;
    if (mode === "auto") {
      if (this.clientId && this.clientSecret) {
        mode = "oauth2";
      } else if (this.username && this.password) {
        mode = "forms";
      } else {
        throw new ConfigError(
          "Cannot pick an authentication method: provide username/password " +
            "(Basic or Forms) or client-id/client-secret (OAuth 2.0), or set --auth-mode explicitly."
        );
      }
    }

    if ((mode === "basic" || mode === "forms") && !(this.username && this.password)) {
      throw new ConfigError(`auth mode ${JSON.stringify(mode)} requires --username and --password`);
    }
    if (mode === "oauth2" && !(this.clientId && this.clientSecret)) {
      throw new ConfigError("auth mode 'oauth2' requires --client-id and --client-secret");
    }
    if (mode === "oauth2" && !this.resolvedIdentityUrl) {
      throw new ConfigError(
        "auth mode 'oauth2' requires --identity-url (OAuth20IdentityServerUrl); no default exists for non-cloud domains"
      );
    }
    return mode;
  }

  withOverrides(overrides: Partial<SettingsOptions>): Settings {
    return new Settings({
      baseUrl: overrides.baseUrl ?? this.baseUrl,
      odataPath: overrides.odataPath ?? this.odataPath,
      entity: overrides.entity ?? this.entity,
      authMode: overrides.authMode ?? this.authMode,
      username: overrides.username !== undefined ? overrides.username : this.username,
      password: overrides.password !== undefined ? overrides.password : this.password,
      clientId: overrides.clientId !== undefined ? overrides.clientId : this.clientId,
      clientSecret: overrides.clientSecret !== undefined ? overrides.clientSecret : this.clientSecret,
      identityUrl: overrides.identityUrl !== undefined ? overrides.identityUrl : this.identityUrl,
      scope: overrides.scope !== undefined ? overrides.scope : this.scope,
      verifySsl: overrides.verifySsl !== undefined ? overrides.verifySsl : this.verifySsl,
      timeout: overrides.timeout !== undefined ? overrides.timeout : this.timeout,
      maxRetries: overrides.maxRetries !== undefined ? overrides.maxRetries : this.maxRetries,
      retryBackoff: overrides.retryBackoff !== undefined ? overrides.retryBackoff : this.retryBackoff,
      retryMaxDelay: overrides.retryMaxDelay !== undefined ? overrides.retryMaxDelay : this.retryMaxDelay,
      userAgent: overrides.userAgent ?? this.userAgent,
      pageSize: overrides.pageSize !== undefined ? overrides.pageSize : this.pageSize,
    });
  }

  static fromEnv(env?: Record<string, string | undefined>, overrides: Partial<SettingsOptions> = {}): Settings {
    const source = env || process.env;

    const get = (...names: string[]): string | null => {
      for (const name of names) {
        const val = source[name];
        if (val !== undefined && String(val).trim() !== "") {
          return String(val).trim();
        }
      }
      return null;
    };

    const pick = <T>(key: keyof SettingsOptions, envNames: string[], caster?: (val: string) => T): T | undefined => {
      if (overrides[key] !== undefined) {
        return overrides[key] as T;
      }
      const raw = get(...envNames);
      if (raw === null) return undefined;
      return caster ? caster(raw) : (raw as unknown as T);
    };

    const baseUrl = pick<string>("baseUrl", ["CREATIO_BASE_URL", "CREATIO_URL"]) ?? "";
    const odataPath = pick<string>("odataPath", ["CREATIO_ODATA_PATH"]) ?? "/0/odata";
    const entity = pick<string>("entity", ["CREATIO_ENTITY"]) ?? "";
    const authMode = pick<string>("authMode", ["CREATIO_AUTH_MODE"]) ?? "auto";
    const username = pick<string>("username", ["CREATIO_USERNAME", "CREATIO_USER"]);
    const password = pick<string>("password", ["CREATIO_PASSWORD", "CREATIO_PASS"]);
    const clientId = pick<string>("clientId", ["CREATIO_CLIENT_ID"]);
    const clientSecret = pick<string>("clientSecret", ["CREATIO_CLIENT_SECRET"]);
    const identityUrl = pick<string>("identityUrl", ["CREATIO_IDENTITY_URL"]);
    const scope = pick<string>("scope", ["CREATIO_SCOPE"]);
    const verifySsl = pick<boolean>("verifySsl", ["CREATIO_VERIFY_SSL"], (v) => asBool(v, "CREATIO_VERIFY_SSL"));
    const timeout = pick<number>("timeout", ["CREATIO_TIMEOUT"], (v) => asFloat(v, "CREATIO_TIMEOUT"));
    const maxRetries = pick<number>("maxRetries", ["CREATIO_MAX_RETRIES"], (v) => asInt(v, "CREATIO_MAX_RETRIES"));
    const retryBackoff = pick<number>("retryBackoff", ["CREATIO_RETRY_BACKOFF"], (v) => asFloat(v, "CREATIO_RETRY_BACKOFF"));
    const retryMaxDelay = pick<number>("retryMaxDelay", ["CREATIO_RETRY_MAX_DELAY"], (v) => asFloat(v, "CREATIO_RETRY_MAX_DELAY"));
    const pageSize = pick<number>("pageSize", ["CREATIO_PAGE_SIZE"], (v) => asInt(v, "CREATIO_PAGE_SIZE"));

    return new Settings({
      baseUrl,
      odataPath,
      entity,
      authMode,
      username,
      password,
      clientId,
      clientSecret,
      identityUrl,
      scope,
      verifySsl,
      timeout,
      maxRetries,
      retryBackoff,
      retryMaxDelay,
      pageSize,
    });
  }
}

export function loadEnvFile(filePath: string, options?: { override?: boolean }): Record<string, string> {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new ConfigError(`Env file not found: ${resolved}`);
  }

  const content = fs.readFileSync(resolved, "utf-8");
  const loaded: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.toLowerCase().startsWith("export ")) {
      line = line.slice(7).trimStart();
    }
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();

    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
        value = value.slice(1, -1);
      }
    }

    if (!key) continue;
    loaded[key] = value;
    if (options?.override || !(key in process.env)) {
      process.env[key] = value;
    }
  }

  return loaded;
}
