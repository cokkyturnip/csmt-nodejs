/**
 * Exception hierarchy for the importer.
 *
 * Every error raised on purpose by this package derives from CreatioError
 * so callers can catch one type. Errors that carry an HTTP response keep the
 * status code and the server payload around for reporting.
 */

export class CreatioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ConfigError extends CreatioError {}

export class AuthError extends CreatioError {}

export class CsvError extends CreatioError {}

export class MappingError extends CreatioError {}

export class ValidationError extends CreatioError {
  public field?: string;
  public value?: unknown;

  constructor(message: string, options?: { field?: string; value?: unknown }) {
    const formatted = options?.field ? `${options.field}: ${message}` : message;
    super(formatted);
    this.field = options?.field;
    this.value = options?.value;
  }
}

export class ODataError extends CreatioError {
  public status?: number;
  public code?: string;
  public payload?: unknown;
  public method?: string;
  public url?: string;
  public retryable: boolean;
  public detail: string;
  public pre_absent?: Set<string>;

  constructor(
    message: string,
    options?: {
      status?: number;
      code?: string;
      payload?: unknown;
      method?: string;
      url?: string;
      retryable?: boolean;
    }
  ) {
    super(message);
    this.status = options?.status;
    this.code = options?.code;
    this.payload = options?.payload;
    this.method = options?.method;
    this.url = options?.url;
    this.retryable = options?.retryable ?? false;
    this.detail = message;
  }

  override toString(): string {
    const parts: string[] = [];
    if (this.method && this.url) {
      parts.push(`${this.method} ${this.url}`);
    }
    if (this.status !== undefined) {
      parts.push(`HTTP ${this.status}`);
    }
    if (this.code) {
      parts.push(`code=${this.code}`);
    }
    parts.push(this.detail);
    return parts.filter(Boolean).join(" | ");
  }

  static fromResponse(
    response: { status: number; statusText?: string; json?: unknown; text?: string },
    options?: { method?: string; url?: string }
  ): ODataError {
    const status = response.status;
    let payload: unknown = response.json;
    let code: string | undefined;
    let message: string | undefined;

    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const map = payload as Record<string, unknown>;
      const error = map.error;
      if (error && typeof error === "object" && !Array.isArray(error)) {
        const errMap = error as Record<string, unknown>;
        code = errMap.code !== undefined ? String(errMap.code) : undefined;
        message = errMap.message !== undefined ? String(errMap.message) : undefined;
        const details = errMap.details;
        if (!message && details !== undefined) {
          message = typeof details === "object" ? JSON.stringify(details) : String(details);
        }
      } else {
        code = (map.code ?? map.Code) !== undefined ? String(map.code ?? map.Code) : undefined;
        message = (map.Message ?? map.message) !== undefined ? String(map.Message ?? map.message) : undefined;
      }
    }

    if (!message) {
      const text = response.text || "";
      message = text.trim().slice(0, 2000) || response.statusText || "request failed";
    }

    const retryable = status === 408 || status === 425 || status === 429 || status >= 500;
    return new ODataError(message, {
      status,
      code,
      payload: payload !== undefined ? payload : response.text,
      method: options?.method,
      url: options?.url,
      retryable,
    });
  }
}

export class BatchError extends ODataError {}
