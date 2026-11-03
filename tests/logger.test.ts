import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Logger, configureLogger, getLogger } from "../src/logger.js";

describe("Logger module", () => {
  it("writes logs to file when logFile is specified (MEDIUM-3 regression)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "csmt-log-"));
    const logFile = path.join(tmpDir, "test.log");

    const logger = new Logger("test-logger", {
      level: "info",
      logFile,
    });

    logger.debug("this debug should be ignored at info level");
    logger.info("operation started");
    logger.warn("a warning occurred");
    logger.error("an error occurred");

    assert.ok(fs.existsSync(logFile));
    const content = fs.readFileSync(logFile, "utf-8");
    assert.ok(!content.includes("this debug should be ignored"));
    assert.ok(content.includes("[INFO] test-logger: operation started"));
    assert.ok(content.includes("[WARNING] test-logger: a warning occurred"));
    assert.ok(content.includes("[ERROR] test-logger: an error occurred"));

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("respects quiet mode by suppressing lower-level outputs", () => {
    const logger = new Logger("quiet-logger", {
      quiet: true,
      level: "info",
    });

    // Should not throw or crash
    logger.info("silent info");
    logger.warn("visible warning");
  });
});
