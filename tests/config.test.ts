import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  asBool,
  asFloat,
  asInt,
  defaultIdentityUrl,
  identityUrlCandidates,
  loadEnvFile,
  normalizeBaseUrl,
  Settings,
} from "../src/config.js";
import { ConfigError } from "../src/errors.js";

describe("Config module", () => {
  it("normalizes base URL correctly", () => {
    const [root1, odata1] = normalizeBaseUrl("https://mycreatio.com");
    assert.equal(root1, "https://mycreatio.com");
    assert.equal(odata1, "/0/odata");

    const [root2, odata2] = normalizeBaseUrl("https://mycreatio.com/0/odata");
    assert.equal(root2, "https://mycreatio.com");
    assert.equal(odata2, "/0/odata");

    const [root3, odata3] = normalizeBaseUrl("https://mycreatio.com/odata");
    assert.equal(root3, "https://mycreatio.com");
    assert.equal(odata3, "/odata");

    const [root4, odata4] = normalizeBaseUrl("mycreatio.com");
    assert.equal(root4, "https://mycreatio.com");
    assert.equal(odata4, "/0/odata");

    assert.throws(() => normalizeBaseUrl(""), ConfigError);
    assert.throws(() => normalizeBaseUrl("not a valid host!!!"), ConfigError);
  });

  it("derives identity URL candidates for cloud sites", () => {
    const candidates = identityUrlCandidates("https://mycompany.creatio.com");
    assert.deepEqual(candidates, [
      "https://mycompany-is.creatio.com",
      "https://mycompany_is.creatio.com",
    ]);
    assert.equal(defaultIdentityUrl("https://mycompany.creatio.com"), "https://mycompany-is.creatio.com");

    const onPrem = identityUrlCandidates("https://creatio.mycompany.internal");
    assert.deepEqual(onPrem, []);
    assert.equal(defaultIdentityUrl("https://creatio.mycompany.internal"), null);
  });

  it("handles boolean, float, and int parsers", () => {
    assert.equal(asBool("true", "test"), true);
    assert.equal(asBool("1", "test"), true);
    assert.equal(asBool("false", "test"), false);
    assert.equal(asBool("0", "test"), false);
    assert.throws(() => asBool("invalid", "test"), ConfigError);

    assert.equal(asFloat("12.34", "test"), 12.34);
    assert.throws(() => asFloat("abc", "test"), ConfigError);

    assert.equal(asInt("42", "test"), 42);
    assert.throws(() => asInt("xyz", "test"), ConfigError);
  });

  it("resolves auto auth mode and credentials", () => {
    const s1 = new Settings({
      baseUrl: "https://cloud.creatio.com",
      authMode: "auto",
      username: "user",
      password: "pass",
    });
    assert.equal(s1.resolvedAuthMode, "forms");

    const s2 = new Settings({
      baseUrl: "https://cloud.creatio.com",
      authMode: "auto",
      clientId: "cid",
      clientSecret: "csec",
    });
    assert.equal(s2.resolvedAuthMode, "oauth2");

    const s3 = new Settings({
      baseUrl: "https://cloud.creatio.com",
      authMode: "basic",
      username: "u",
      password: "p",
    });
    assert.equal(s3.resolvedAuthMode, "basic");

    assert.throws(
      () =>
        new Settings({
          baseUrl: "https://cloud.creatio.com",
          authMode: "auto",
        }).resolvedAuthMode,
      ConfigError
    );
  });

  it("loads .env files properly", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "csmt-test-"));
    const envFile = path.join(tmpDir, ".env");
    fs.writeFileSync(
      envFile,
      `# Comment
export CREATIO_BASE_URL="https://env-test.creatio.com"
CREATIO_USERNAME='admin'
CREATIO_PASSWORD=secret
`
    );

    const loaded = loadEnvFile(envFile);
    assert.equal(loaded.CREATIO_BASE_URL, "https://env-test.creatio.com");
    assert.equal(loaded.CREATIO_USERNAME, "admin");
    assert.equal(loaded.CREATIO_PASSWORD, "secret");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads Settings from environment variables and does not let undefined overrides clobber env (B1 regression)", () => {
    const fakeEnv = {
      CREATIO_BASE_URL: "https://from-env.creatio.com",
      CREATIO_USERNAME: "envuser",
      CREATIO_PASSWORD: "envpassword",
      CREATIO_PAGE_SIZE: "250",
    };

    // Case 1: Pure env
    const s1 = Settings.fromEnv(fakeEnv);
    assert.equal(s1.baseUrl, "https://from-env.creatio.com");
    assert.equal(s1.username, "envuser");
    assert.equal(s1.password, "envpassword");
    assert.equal(s1.pageSize, 250);

    // Case 2: Overrides containing undefined values (like Commander CLI parses unset flags)
    const s2 = Settings.fromEnv(fakeEnv, {
      baseUrl: undefined,
      username: undefined,
      password: undefined,
      pageSize: undefined,
      entity: "Contact",
    });
    assert.equal(s2.baseUrl, "https://from-env.creatio.com");
    assert.equal(s2.username, "envuser");
    assert.equal(s2.password, "envpassword");
    assert.equal(s2.pageSize, 250);
    assert.equal(s2.entity, "Contact");

    // Case 3: Explicit override takes precedence
    const s3 = Settings.fromEnv(fakeEnv, {
      baseUrl: "https://override.creatio.com",
      pageSize: 50,
    });
    assert.equal(s3.baseUrl, "https://override.creatio.com");
    assert.equal(s3.username, "envuser");
    assert.equal(s3.pageSize, 50);
  });
});
