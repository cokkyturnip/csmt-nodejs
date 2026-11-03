/**
 * Authentication strategies for Creatio.
 */

import { Settings } from "./config.js";
import { AuthError } from "./errors.js";

export class NotIdentityServer extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotIdentityServer";
  }
}

export interface AuthHeaders {
  [key: string]: string;
}

export abstract class AuthStrategy {
  public abstract name: string;
  constructor(public settings: Settings) {}

  public abstract authenticate(): Promise<void>;
  public abstract headers(): AuthHeaders;
  public invalidate(): void {}
}

export class BasicAuth extends AuthStrategy {
  public name = "basic";

  constructor(settings: Settings) {
    super(settings);
    if (!settings.username || !settings.password) {
      throw new AuthError("Basic authentication requires a username and password");
    }
  }

  public async authenticate(): Promise<void> {
    // Basic auth is stateless
  }

  public headers(): AuthHeaders {
    const creds = Buffer.from(`${this.settings.username || ""}:${this.settings.password || ""}`).toString("base64");
    return {
      Authorization: `Basic ${creds}`,
    };
  }
}

export class FormsAuth extends AuthStrategy {
  public name = "forms";
  private csrf: string | null = null;
  private cookies: Map<string, string> = new Map();

  constructor(settings: Settings) {
    super(settings);
    if (!settings.username || !settings.password) {
      throw new AuthError("Forms authentication requires a username and password");
    }
  }

  public async authenticate(): Promise<void> {
    const payload = {
      UserName: this.settings.username,
      UserPassword: this.settings.password,
    };

    let response: Response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.timeout * 1000);

    try {
      response = await fetch(this.settings.loginUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Accept: "application/json",
          ForceUseSession: "true",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      throw new AuthError(`Login request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }

    // Capture cookies from set-cookie headers
    this.extractCookies(response);

    let body: any = null;
    const text = await response.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }

    if (!response.ok) {
      const detail = body !== null ? JSON.stringify(body) : text.slice(0, 500);
      throw new AuthError(`Login failed with HTTP ${response.status}: ${detail}`);
    }

    let code: any = null;
    let message = "";
    if (body && typeof body === "object") {
      code = body.Code ?? body.code;
      message = String(body.Message ?? body.message ?? "");
    }

    if (code !== 0 && code !== "0" && code !== null && code !== undefined) {
      throw new AuthError(`Login rejected (Code=${code}): ${message || "invalid credentials"}`);
    }

    let csrf = this.cookies.get("BPMCSRF");
    if (!csrf && body && typeof body === "object") {
      csrf = body.BPMCSRF ?? body.CsrfToken;
      if (csrf) {
        this.cookies.set("BPMCSRF", String(csrf));
      }
    }

    if (!csrf) {
      throw new AuthError(
        "Login succeeded but no BPMCSRF token was returned; verify that CSRF protection is enabled on the Creatio site."
      );
    }

    this.csrf = String(csrf);
  }

  private extractCookies(response: Response): void {
    // In Node fetch, getSetCookie() returns all set-cookie header strings
    const setCookieHeaders: string[] = typeof (response.headers as any).getSetCookie === "function"
      ? (response.headers as any).getSetCookie()
      : [response.headers.get("set-cookie") || ""].filter(Boolean);

    for (const header of setCookieHeaders) {
      const parts = header.split(";");
      const first = parts[0];
      if (first && first.includes("=")) {
        const [k, ...v] = first.split("=");
        const cookieName = k.trim();
        const cookieValue = v.join("=").trim();
        if (cookieName) {
          this.cookies.set(cookieName, cookieValue);
        }
      }
    }
  }

  public headers(): AuthHeaders {
    if (!this.csrf) {
      throw new AuthError("Not authenticated; call authenticate() first");
    }
    const cookiePairs: string[] = [];
    for (const [k, v] of this.cookies.entries()) {
      cookiePairs.push(`${k}=${v}`);
    }
    const headers: AuthHeaders = {
      BPMCSRF: this.csrf,
    };
    if (cookiePairs.length > 0) {
      headers.Cookie = cookiePairs.join("; ");
    }
    return headers;
  }

  public override invalidate(): void {
    this.csrf = null;
    this.cookies.clear();
  }
}

export class OAuth2Auth extends AuthStrategy {
  public name = "oauth2";
  private token: string | null = null;
  public endpointUsed: string | null = null;

  constructor(settings: Settings) {
    super(settings);
    if (!settings.clientId || !settings.clientSecret) {
      throw new AuthError("OAuth 2.0 requires a client id and client secret");
    }
  }

  public async authenticate(): Promise<void> {
    const candidates = this.settings.identityCandidates;
    if (candidates.length === 0) {
      throw new AuthError(
        "OAuth 2.0 membutuhkan identity service URL (--identity-url / " +
          "CREATIO_IDENTITY_URL), yaitu nilai system setting " +
          "OAuth20IdentityServerUrl. Domain ini bukan *.creatio.com sehingga tidak ada nilai default."
      );
    }

    const problems: string[] = [];
    for (const candidate of candidates) {
      const endpoint = candidate.toLowerCase().endsWith("/connect/token")
        ? candidate
        : `${candidate.replace(/\/+$/, "")}/connect/token`;

      try {
        const token = await this.requestToken(endpoint);
        this.token = token;
        this.endpointUsed = endpoint;
        return;
      } catch (err: unknown) {
        if (err instanceof NotIdentityServer) {
          problems.push(`${endpoint}: ${err.message}`);
          continue;
        }
        throw err;
      }
    }

    throw new AuthError(
      "OAuth 2.0 gagal: tidak ada identity service yang menjawab di " +
        candidates.join(", ") +
        ". Nilai yang benar ada di system setting OAuth20IdentityServerUrl " +
        "(Setup > System settings), biasanya https://<subdomain>-is.creatio.com. " +
        "Set dengan --identity-url. Detail: " +
        problems.join(" | ")
    );
  }

  private async requestToken(endpoint: string): Promise<string> {
    const params = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.settings.clientId || "",
      client_secret: this.settings.clientSecret || "",
    });
    if (this.settings.scope) {
      params.set("scope", this.settings.scope);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.timeout * 1000);
    let response: Response;

    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("CERT_") || msg.includes("certificate") || msg.includes("TLS")) {
        throw new NotIdentityServer(
          "TLS gagal (sertifikat tidak cocok untuk host ini). Biasanya berarti hostname identity service salah"
        );
      }
      throw new NotIdentityServer(`tidak bisa dihubungi: ${msg}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }

    if (response.status === 200 && body && typeof body === "object") {
      const token = body.access_token;
      if (token) {
        return String(token);
      }
      throw new AuthError(
        `Respons token dari ${endpoint} tidak memuat access_token: ${JSON.stringify(body).slice(0, 300)}`
      );
    }

    if ((response.status === 400 || response.status === 401) && body && typeof body === "object") {
      const detail = body.error_description || body.error || text.slice(0, 300);
      throw new AuthError(`Identity server ${endpoint} menolak kredensial (HTTP ${response.status}): ${detail}`);
    }

    throw new NotIdentityServer(`HTTP ${response.status}, bukan respons token JSON`);
  }

  public headers(): AuthHeaders {
    if (!this.token) {
      throw new AuthError("Not authenticated; call authenticate() first");
    }
    return {
      Authorization: `Bearer ${this.token}`,
    };
  }

  public override invalidate(): void {
    this.token = null;
    this.endpointUsed = null;
  }
}

export class AuthManager {
  public strategy: AuthStrategy;
  private authenticated = false;

  constructor(public settings: Settings, strategy?: AuthStrategy) {
    this.strategy = strategy || this.buildStrategy();
  }

  private buildStrategy(): AuthStrategy {
    const mode = this.settings.resolvedAuthMode;
    if (mode === "basic") {
      return new BasicAuth(this.settings);
    }
    if (mode === "forms") {
      return new FormsAuth(this.settings);
    }
    if (mode === "oauth2") {
      return new OAuth2Auth(this.settings);
    }
    throw new AuthError(`Unsupported auth mode: ${mode}`);
  }

  get mode(): string {
    return this.strategy.name;
  }

  get usesCsrf(): boolean {
    return this.strategy.name === "forms";
  }

  async ensure(force = false): Promise<void> {
    if (force) {
      this.strategy.invalidate();
      this.authenticated = false;
    }
    if (this.authenticated) {
      return;
    }
    await this.strategy.authenticate();
    this.authenticated = true;
  }

  async headers(): Promise<AuthHeaders> {
    await this.ensure();
    return this.strategy.headers();
  }

  close(): void {
    this.strategy.invalidate();
  }
}
