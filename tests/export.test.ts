import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MockCreatio } from "./mock-creatio.js";
import { ODataClient } from "../src/client.js";
import { Settings } from "../src/config.js";
import { cleanGuid, ExportOptions, Exporter, idKey, LookupExpansion, LookupResolver } from "../src/export.js";

describe("Export module", () => {
  let mock: MockCreatio;
  let baseUrl: string;

  before(async () => {
    mock = new MockCreatio();
    baseUrl = await mock.start();
  });

  after(async () => {
    await mock.stop();
  });

  it("handles cleanGuid and idKey normalization", () => {
    const guid = "680A71FB-AB02-4E17-B9E9-EC074CBEC136";
    const braced = `{${guid}}`;
    assert.equal(cleanGuid(braced), guid);
    assert.equal(idKey(braced), guid.toLowerCase());
    assert.equal(cleanGuid("not-a-guid"), null);
    assert.equal(idKey("Raw Text"), "Raw Text");
  });

  it("exports 0 rows with --limit 0 without requesting records", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "csmt-exp-"));
    const outFile = path.join(tmpDir, "template.csv");

    const settings = new Settings({
      baseUrl,
      authMode: "basic",
      username: "Supervisor",
      password: "secret",
    });
    const client = new ODataClient(settings);

    const exportOptions = new ExportOptions({
      entity: "Contact",
      out: outFile,
      limit: 0,
      select: ["Name", "Email"],
    });

    const exporter = new Exporter(client, exportOptions);
    const result = await exporter.run();
    assert.equal(result.rows, 0);

    const content = fs.readFileSync(outFile, "utf-8").trim();
    assert.equal(content, "Name,Email");

    client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("expands lookups and resolves captions with case-insensitive cache", async () => {
    const countryId = mock.seed("Country", { Name: "Indonesia" });
    mock.seed("Contact", { Name: "Budi", Email: "budi@example.com", CountryId: countryId.toUpperCase() });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "csmt-exp-"));
    const outFile = path.join(tmpDir, "contacts.csv");

    const settings = new Settings({
      baseUrl,
      authMode: "basic",
      username: "Supervisor",
      password: "secret",
    });
    const client = new ODataClient(settings);

    const exportOptions = new ExportOptions({
      entity: "Contact",
      out: outFile,
      select: ["Name", "CountryId"],
      lookups: [LookupExpansion.parse("CountryId=Country.Name")],
    });

    const exporter = new Exporter(client, exportOptions);
    const result = await exporter.run();
    assert.ok(result.rows >= 1);

    const content = fs.readFileSync(outFile, "utf-8");
    assert.ok(content.includes("Indonesia"));

    client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
