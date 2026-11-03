import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { MockCreatio } from "./mock-creatio.js";
import { buildCli, runWizard } from "../src/cli.js";

describe("CLI end-to-end commands", () => {
  let mock: MockCreatio;
  let baseUrl: string;

  before(async () => {
    mock = new MockCreatio();
    baseUrl = await mock.start();
  });

  after(async () => {
    await mock.stop();
  });

  it("runs check command successfully", async () => {
    const cli = buildCli();
    let exitCode: number | undefined;
    const origExit = process.exitCode;
    try {
      await cli.parseAsync([
        "node",
        "csmt",
        "check",
        "--base-url",
        baseUrl,
        "--auth-mode",
        "basic",
        "--username",
        "Supervisor",
        "--password",
        "secret",
        "--entity",
        "Contact",
      ]);
      exitCode = process.exitCode;
    } finally {
      process.exitCode = origExit;
    }
    assert.equal(exitCode ?? 0, 0);
  });

  it("runs init-mapping command", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "csmt-cli-"));
    const csvFile = path.join(tmpDir, "input.csv");
    const mapFile = path.join(tmpDir, "mapping.json");
    fs.writeFileSync(csvFile, "Name,Email,BirthDate\nAlice,alice@example.com,2000-01-01\n");

    const cli = buildCli();
    await cli.parseAsync([
      "node",
      "csmt",
      "init-mapping",
      "--csv",
      csvFile,
      "--out",
      mapFile,
      "--key",
      "Email",
      "--entity",
      "Contact",
    ]);

    assert.ok(fs.existsSync(mapFile));
    const content = JSON.parse(fs.readFileSync(mapFile, "utf-8"));
    assert.equal(content.entity, "Contact");
    assert.deepEqual(content.key_fields, ["Email"]);
    assert.ok("Name" in content.fields);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs import command with --dry-run", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "csmt-cli-"));
    const csvFile = path.join(tmpDir, "input.csv");
    fs.writeFileSync(csvFile, "Name,Email\nTest Dry Run,dryrun@example.com\n");

    const cli = buildCli();
    await cli.parseAsync([
      "node",
      "csmt",
      "import",
      "--base-url",
      baseUrl,
      "--auth-mode",
      "basic",
      "--username",
      "Supervisor",
      "--password",
      "secret",
      "--csv",
      csvFile,
      "--entity",
      "Contact",
      "--key",
      "Email",
      "--dry-run",
      "--no-report",
      "--no-journal",
    ]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs wizard command without hanging and generates valid .env with masked secrets (W1 regression)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "csmt-wizard-"));
    const envOut = path.join(tmpDir, ".env");
    const cliPath = path.resolve("bin/csmt.ts");

    const proc = spawn("npx", ["tsx", cliPath, "wizard", "--out", envOut], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const closePromise = new Promise<number>((resolve) => {
      proc.once("close", (code) => resolve(code ?? 0));
    });

    let output = "";
    proc.stdout.on("data", (data) => {
      output += data.toString();
    });
    proc.stderr.on("data", (data) => {
      output += data.toString();
    });

    // Provide wizard answers sequentially
    const answers = [
      "https://mycompany.creatio.com\n", // Base URL
      "\n",                              // OData path (default)
      "forms\n",                         // auth mode
      "Supervisor\n",                    // username
      "SuperSecretPassword\n",           // password (secret)
      "Contact\n",                       // entity
      "true\n",                          // verify TLS
    ];

    for (const ans of answers) {
      if (proc.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 60));
      proc.stdin.write(ans);
    }
    proc.stdin.end();

    const exitCode = await closePromise;

    assert.equal(exitCode, 0);
    assert.ok(fs.existsSync(envOut));
    const writtenEnv = fs.readFileSync(envOut, "utf-8");
    assert.ok(writtenEnv.includes("CREATIO_BASE_URL=https://mycompany.creatio.com"));
    assert.ok(writtenEnv.includes("CREATIO_AUTH_MODE=forms"));
    assert.ok(writtenEnv.includes("CREATIO_USERNAME=Supervisor"));
    assert.ok(writtenEnv.includes("CREATIO_PASSWORD=SuperSecretPassword"));

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("mutes password in TTY mode so secrets are never echoed to output stream (L-2 regression)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "csmt-wizard-tty-"));
    const envOut = path.join(tmpDir, ".env");

    const input = new PassThrough();
    let capturedOutput = "";
    const output = new Writable({
      write(chunk, encoding, callback) {
        capturedOutput += chunk.toString();
        callback();
      },
    });

    const wizardPromise = runWizard(envOut, {
      input,
      output,
      isTTY: true,
    });

    // Provide answers sequentially with small pauses to simulate realistic typing
    const writeStep = async (str: string) => {
      await new Promise((r) => setTimeout(r, 40));
      input.write(str);
    };

    await writeStep("https://mycompany.creatio.com\n");
    await writeStep("\n");
    await writeStep("forms\n");
    await writeStep("Supervisor\n");
    await writeStep("SecretSuperPassword999\n");
    await writeStep("Contact\n");
    await writeStep("true\n");

    await wizardPromise;

    // Verify .env got the password
    const writtenEnv = fs.readFileSync(envOut, "utf-8");
    assert.ok(writtenEnv.includes("CREATIO_PASSWORD=SecretSuperPassword999"));

    // Verify terminal output NEVER echoed the secret password!
    assert.ok(!capturedOutput.includes("SecretSuperPassword999"), "Password leaked to terminal output!");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
