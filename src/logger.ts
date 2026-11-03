import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warning" | "error";

const LEVEL_WEIGHTS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warning: 30,
  error: 40,
};

export interface LoggerOptions {
  level?: LogLevel | string;
  logFile?: string | null;
  quiet?: boolean;
}

export class Logger {
  private levelWeight: number;
  private logFilePath: string | null = null;
  private quiet: boolean;

  constructor(public name: string = "csmt", options: LoggerOptions = {}) {
    const rawLevel = (options.level || "info").toLowerCase();
    const lvlKey: LogLevel = rawLevel === "warn" ? "warning" : (rawLevel in LEVEL_WEIGHTS ? (rawLevel as LogLevel) : "info");
    this.levelWeight = LEVEL_WEIGHTS[lvlKey] ?? 20;
    this.quiet = Boolean(options.quiet);

    if (options.logFile) {
      this.logFilePath = path.resolve(options.logFile);
      const dir = path.dirname(this.logFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  private formatMessage(level: string, message: string): string {
    const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    return `${stamp} [${level.toUpperCase()}] ${this.name}: ${message}`;
  }

  private write(level: LogLevel, message: string) {
    const weight = LEVEL_WEIGHTS[level];
    const formatted = this.formatMessage(level, message);

    // If a log file is configured, always write if it meets file level threshold
    if (this.logFilePath && weight >= this.levelWeight) {
      try {
        fs.appendFileSync(this.logFilePath, formatted + "\n", "utf-8");
      } catch {
        // Silently ignore log write failures
      }
    }

    // Console output
    if (this.quiet) {
      // Quiet mode only outputs warnings and errors to stderr
      if (weight >= LEVEL_WEIGHTS.warning) {
        console.error(formatted);
      }
    } else {
      if (weight >= this.levelWeight) {
        if (weight >= LEVEL_WEIGHTS.warning) {
          console.error(formatted);
        } else {
          console.error(formatted);
        }
      }
    }
  }

  debug(message: string): void {
    this.write("debug", message);
  }

  info(message: string): void {
    this.write("info", message);
  }

  warn(message: string): void {
    this.write("warning", message);
  }

  error(message: string): void {
    this.write("error", message);
  }
}

let defaultLogger = new Logger("csmt");

export function configureLogger(options: LoggerOptions): Logger {
  defaultLogger = new Logger("csmt", options);
  return defaultLogger;
}

export function getLogger(name: string = "csmt"): Logger {
  return name === "csmt" ? defaultLogger : new Logger(name);
}
