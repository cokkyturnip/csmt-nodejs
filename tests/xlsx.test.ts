import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import ExcelJS from "exceljs";
import { cellToText, XlsxSource } from "../src/xlsx-source.js";
import { openSource } from "../src/tabular.js";

describe("XLSX source module", () => {
  it("converts cell values to expected text", () => {
    assert.equal(cellToText(null), "");
    assert.equal(cellToText(undefined), "");
    assert.equal(cellToText(true), "true");
    assert.equal(cellToText(false), "false");
    assert.equal(cellToText(1234), "1234");
    assert.equal(cellToText(12.34), "12.34");
    assert.equal(cellToText({ formula: "1+1", result: 2 }), "2");
  });

  it("prioritizes exact numeric sheet name over 1-based index", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "csmt-xlsx-"));
    const xlsxFile = path.join(tmpDir, "sheets.xlsx");

    const workbook = new ExcelJS.Workbook();
    const ws1 = workbook.addWorksheet("Overview");
    ws1.addRow(["Col1"]);
    ws1.addRow(["Val1"]);

    const ws2 = workbook.addWorksheet("Summary");
    ws2.addRow(["Col2"]);
    ws2.addRow(["Val2"]);

    // Sheet named "2"
    const ws3 = workbook.addWorksheet("2");
    ws3.addRow(["Col3"]);
    ws3.addRow(["Val3"]);

    await workbook.xlsx.writeFile(xlsxFile);

    // Requesting sheet "2" should choose the sheet NAMED "2", not sheet index 2 ("Summary")!
    const source = new XlsxSource(xlsxFile, { sheet: "2" });
    const info = await source.info();
    assert.equal(info.sheet, "2");
    assert.deepEqual(info.fieldnames, ["Col3"]);

    const rows = [];
    for await (const row of source.iterRows()) {
      rows.push(row);
    }
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.values.Col3, "Val3");

    // openSource immediately populates fieldnames (L-6 regression)
    const opened = await openSource(xlsxFile, { sheet: "2" });
    assert.deepEqual(opened.fieldnames, ["Col3"]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
