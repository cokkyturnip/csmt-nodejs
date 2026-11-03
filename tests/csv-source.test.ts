import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CsvSource, detectDelimiter, detectEncoding } from "../src/csv-source.js";
import { normalizeHeader } from "../src/tabular.js";

describe("CSV source module", () => {
  it("normalizes headers with duplicate avoidance", () => {
    const raw = ["Name", "Name", "Email", "", "Name_2"];
    const normalized = normalizeHeader(raw);
    assert.deepEqual(normalized, ["Name", "Name_2", "Email", "column_4", "Name_2_2"]);
  });

  it("detects delimiters accurately", () => {
    assert.equal(detectDelimiter("A,B,C\n1,2,3\n4,5,6"), ",");
    assert.equal(detectDelimiter("A;B;C\n1;2;3\n4;5;6"), ";");
    assert.equal(detectDelimiter("A\tB\tC\n1\t2\t3\n4\t5\t6"), "\t");
    assert.equal(detectDelimiter("A|B|C\n1|2|3\n4|5|6"), "|");
  });

  it("streams rows and preserves physical line numbers", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "csmt-csv-"));
    const csvFile = path.join(tmpDir, "data.csv");
    fs.writeFileSync(
      csvFile,
      `Name,Email,Score
Alice,alice@example.com,90
Bob,bob@example.com,85

Charlie,charlie@example.com,95
`
    );

    const source = new CsvSource(csvFile);
    assert.deepEqual(source.fieldnames, ["Name", "Email", "Score"]);

    const rows = [];
    for await (const row of source.iterRows()) {
      rows.push(row);
    }

    assert.equal(rows.length, 3);
    assert.equal(rows[0]!.lineno, 2);
    assert.equal(rows[0]!.values.Name, "Alice");
    assert.equal(rows[1]!.lineno, 3);
    assert.equal(rows[1]!.values.Name, "Bob");
    assert.equal(rows[2]!.lineno, 5); // Empty line on line 4 was skipped
    assert.equal(rows[2]!.values.Name, "Charlie");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("handles multi-byte UTF-8 split at 64 KiB boundary without misdetecting latin1 (H2 regression)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "csmt-csv-h2-"));
    const csvFile = path.join(tmpDir, "split-boundary.csv");

    // Construct 65536 + 10 bytes where byte 65534-65535 is start of 3-byte UTF-8 char \xe2\x82\xac (€)
    // and byte 65536 is \xac
    const part1 = Buffer.alloc(65534, 0x61); // 65534 'a's
    const euro = Buffer.from("€", "utf8"); // 3 bytes: 0xe2, 0x82, 0xac
    const splitAt64k = Buffer.concat([part1, euro, Buffer.from("\nsecond_line", "utf8")]);
    fs.writeFileSync(csvFile, splitAt64k);

    const detected = detectEncoding(csvFile);
    assert.equal(detected, "utf-8");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("strips UTF-8 BOM properly when reading CSV files (M1/M2 regression)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "csmt-csv-bom-"));
    const csvFile = path.join(tmpDir, "bom.csv");

    // Write file with UTF-8 BOM
    const content = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("Name,Email\nAlice,alice@example.com\n", "utf8"),
    ]);
    fs.writeFileSync(csvFile, content);

    const source = new CsvSource(csvFile);
    assert.deepEqual(source.fieldnames, ["Name", "Email"]);
    assert.equal(source.fieldnames[0], "Name"); // No BOM in header name!

    const rows = [];
    for await (const row of source.iterRows()) {
      rows.push(row);
    }
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.values.Name, "Alice");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("safely loads CSV header larger than 64 KiB without truncation (L-5 regression)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "csmt-csv-large-header-"));
    const csvFile = path.join(tmpDir, "large-header.csv");

    // Generate 5000 columns (approx 70 KiB header line)
    const cols = Array.from({ length: 5000 }, (_, i) => `column_very_long_name_${i}`);
    const headerLine = cols.join(",") + "\n";
    const dataLine = cols.map((_, i) => `val_${i}`).join(",") + "\n";

    fs.writeFileSync(csvFile, headerLine + dataLine, "utf-8");

    const source = new CsvSource(csvFile);
    assert.equal(source.fieldnames.length, 5000);
    assert.equal(source.fieldnames[0], "column_very_long_name_0");
    assert.equal(source.fieldnames[4999], "column_very_long_name_4999");

    const rows = [];
    for await (const row of source.iterRows()) {
      rows.push(row);
    }
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.values["column_very_long_name_4999"], "val_4999");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
