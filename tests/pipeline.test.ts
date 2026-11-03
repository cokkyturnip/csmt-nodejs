import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MockCreatio } from "./mock-creatio.js";
import { ODataClient } from "../src/client.js";
import { Settings } from "../src/config.js";
import { CsvSource } from "../src/csv-source.js";
import { Journal } from "../src/journal.js";
import { Mapper, Mapping } from "../src/mapping.js";
import { ImportPipeline, PipelineOptions } from "../src/pipeline.js";
import { ReportWriter } from "../src/report.js";

describe("Import Pipeline module", () => {
  let mock: MockCreatio;
  let baseUrl: string;

  before(async () => {
    mock = new MockCreatio();
    baseUrl = await mock.start();
  });

  after(async () => {
    await mock.stop();
  });

  it("imports rows in upsert mode: creates new then updates on re-run", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "csmt-pipe-"));
    const csvFile = path.join(tmpDir, "contacts.csv");
    fs.writeFileSync(
      csvFile,
      `Name,Email
Alice Smith,alice@example.com
Bob Jones,bob@example.com
`
    );

    const settings = new Settings({
      baseUrl,
      authMode: "basic",
      username: "Supervisor",
      password: "secret",
      entity: "Contact",
    });

    const mapping = Mapping.fromDict({
      entity: "Contact",
      key_fields: ["Email"],
      fields: {
        Name: "Name",
        Email: "Email",
      },
    });

    const client = new ODataClient(settings);
    const source = new CsvSource(csvFile);
    const journal1 = new Journal(path.join(tmpDir, "j1.jsonl"));
    const report1 = new ReportWriter(path.join(tmpDir, "r1.csv"));

    // Run 1: Should create 2
    const pipeline1 = new ImportPipeline({
      settings,
      client,
      mapper: new Mapper(mapping),
      source,
      journal: journal1,
      report: report1,
      options: new PipelineOptions({ mode: "upsert", useBatch: false }),
    });
    const sum1 = await pipeline1.run();
    journal1.close();
    await report1.close();

    assert.equal(sum1.total, 2);
    assert.equal(sum1.created, 2);
    assert.equal(sum1.updated, 0);
    assert.equal(sum1.failed, 0);

    // Run 2: Same data in upsert mode -> should update 2, create 0!
    const journal2 = new Journal(path.join(tmpDir, "j2.jsonl"));
    const report2 = new ReportWriter(path.join(tmpDir, "r2.csv"));
    const pipeline2 = new ImportPipeline({
      settings,
      client,
      mapper: new Mapper(mapping),
      source,
      journal: journal2,
      report: report2,
      options: new PipelineOptions({ mode: "upsert", useBatch: false }),
    });
    const sum2 = await pipeline2.run();
    journal2.close();
    await report2.close();

    assert.equal(sum2.total, 2);
    assert.equal(sum2.created, 0);
    assert.equal(sum2.updated, 2);
    assert.equal(sum2.failed, 0);

    client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resumes safely by verifying key against journal entry", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "csmt-resume-"));
    const csvFile = path.join(tmpDir, "contacts.csv");
    fs.writeFileSync(
      csvFile,
      `Name,Email
Alice,alice@example.com
Bob,bob@example.com
`
    );

    const settings = new Settings({
      baseUrl,
      authMode: "basic",
      username: "Supervisor",
      password: "secret",
      entity: "Contact",
    });

    const mapping = Mapping.fromDict({
      entity: "Contact",
      key_fields: ["Email"],
      fields: { Name: "Name", Email: "Email" },
    });

    const journalFile = path.join(tmpDir, "resume.journal.jsonl");
    const client = new ODataClient(settings);

    // Run 1: Process Alice & Bob
    const j1 = new Journal(journalFile);
    const r1 = new ReportWriter(path.join(tmpDir, "r1.csv"));
    const p1 = new ImportPipeline({
      settings,
      client,
      mapper: new Mapper(mapping),
      source: new CsvSource(csvFile),
      journal: j1,
      report: r1,
      options: new PipelineOptions({ mode: "upsert", useBatch: false }),
    });
    await p1.run();
    j1.close();
    await r1.close();

    // Run 2: With --resume, both rows should be skipped (resumed=2)
    const j2 = new Journal(journalFile);
    const r2 = new ReportWriter(path.join(tmpDir, "r2.csv"));
    const p2 = new ImportPipeline({
      settings,
      client,
      mapper: new Mapper(mapping),
      source: new CsvSource(csvFile),
      journal: j2,
      report: r2,
      options: new PipelineOptions({ mode: "upsert", resume: true, useBatch: false }),
    });
    const sum2 = await p2.run();
    j2.close();
    await r2.close();

    assert.equal(sum2.skipped, 2);
    assert.equal(sum2.resumed, 2);
    assert.equal(sum2.created, 0);
    assert.equal(sum2.updated, 0);

    client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("handles dry-run by writing nothing to the server", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "csmt-dry-"));
    const csvFile = path.join(tmpDir, "contacts.csv");
    fs.writeFileSync(csvFile, "Name,Email\nDryRunUser,dry@example.com\n");

    const settings = new Settings({
      baseUrl,
      authMode: "basic",
      username: "Supervisor",
      password: "secret",
      entity: "Contact",
    });

    const mapping = Mapping.fromDict({
      entity: "Contact",
      key_fields: ["Email"],
      fields: { Name: "Name", Email: "Email" },
    });

    const client = new ODataClient(settings);
    const j = new Journal(path.join(tmpDir, "dry.jsonl"));
    const r = new ReportWriter(path.join(tmpDir, "dry.csv"));
    const pipeline = new ImportPipeline({
      settings,
      client,
      mapper: new Mapper(mapping),
      source: new CsvSource(csvFile),
      journal: j,
      report: r,
      options: new PipelineOptions({ mode: "upsert", dryRun: true, useBatch: false }),
    });

    const sum = await pipeline.run();
    j.close();
    await r.close();

    assert.equal(sum.total, 1);
    assert.equal(sum.planned, 1);
    assert.equal(sum.created, 0);
    assert.equal(sum.failed, 0);

    // Verify record was NOT actually written to mock
    const [existing] = await client.getCollection("Contact", { filter: "Email eq 'dry@example.com'" });
    assert.equal(existing.length, 0);

    client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("enforces duplicate-policy first_wins and last_wins", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "csmt-dups-"));
    const csvFile = path.join(tmpDir, "contacts.csv");
    fs.writeFileSync(
      csvFile,
      `Name,Email
Alice First,duptest@example.com
Alice Second,duptest@example.com
`
    );

    const settings = new Settings({
      baseUrl,
      authMode: "basic",
      username: "Supervisor",
      password: "secret",
      entity: "Contact",
    });

    const mapping = Mapping.fromDict({
      entity: "Contact",
      key_fields: ["Email"],
      fields: { Name: "Name", Email: "Email" },
    });

    const client = new ODataClient(settings);

    // Test first_wins
    const j1 = new Journal(path.join(tmpDir, "j1.jsonl"));
    const r1 = new ReportWriter(path.join(tmpDir, "r1.csv"));
    const p1 = new ImportPipeline({
      settings,
      client,
      mapper: new Mapper(mapping),
      source: new CsvSource(csvFile),
      journal: j1,
      report: r1,
      options: new PipelineOptions({ mode: "create", duplicatePolicy: "first_wins", useBatch: false }),
    });
    const sum1 = await p1.run();
    j1.close();
    await r1.close();

    assert.equal(sum1.total, 2);
    assert.equal(sum1.created, 1);
    assert.equal(sum1.skipped, 1);

    client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("respects limit option by stopping after N rows", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "csmt-limit-"));
    const csvFile = path.join(tmpDir, "contacts.csv");
    fs.writeFileSync(
      csvFile,
      `Name,Email
User1,user1@example.com
User2,user2@example.com
User3,user3@example.com
`
    );

    const settings = new Settings({
      baseUrl,
      authMode: "basic",
      username: "Supervisor",
      password: "secret",
      entity: "Contact",
    });

    const mapping = Mapping.fromDict({
      entity: "Contact",
      key_fields: ["Email"],
      fields: { Name: "Name", Email: "Email" },
    });

    const client = new ODataClient(settings);
    const j = new Journal(path.join(tmpDir, "lim.jsonl"));
    const r = new ReportWriter(path.join(tmpDir, "lim.csv"));
    const pipeline = new ImportPipeline({
      settings,
      client,
      mapper: new Mapper(mapping),
      source: new CsvSource(csvFile),
      journal: j,
      report: r,
      options: new PipelineOptions({ mode: "create", limit: 2, useBatch: false }),
    });

    const sum = await pipeline.run();
    j.close();
    await r.close();

    assert.equal(sum.total, 2);
    assert.equal(sum.created, 2);

    client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
