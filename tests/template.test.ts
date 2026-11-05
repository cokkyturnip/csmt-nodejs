import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { parseCsdlFieldDetails } from "../src/client.js";
import {
  buildTemplateColumns,
  buildTemplateMapping,
  edmToMappingType,
  sampleValue,
  templateFormatFor,
  writeCsvTemplate,
  writeXlsxTemplate,
} from "../src/template.js";
import { ConfigError } from "../src/errors.js";

const CSDL = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Terrasoft.Configuration.OData">
      <EntityType Name="Contact">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.Guid" />
        <Property Name="Name" Type="Edm.String" Nullable="false" />
        <Property Name="Email" Type="Edm.String" MaxLength="250" />
        <Property Name="AnnualRevenue" Type="Edm.Decimal" />
        <Property Name="Confirmed" Type="Edm.Boolean" />
        <Property Name="OwnerId" Type="Edm.Guid" />
        <Property Name="CreatedOn" Type="Edm.DateTimeOffset" />
        <Property Name="CreatedById" Type="Edm.Guid" />
        <Property Name="ProcessListeners" Type="Edm.Int32" />
        <Property Name="ContactPhoto" Type="Edm.Stream" />
        <NavigationProperty Name="Owner" Type="Terrasoft.Configuration.OData.Contact" Partner="ContactCollectionByOwner" />
        <NavigationProperty Name="CreatedBy" Type="Terrasoft.Configuration.OData.Contact" />
        <NavigationProperty Name="ContactCollectionByOwner" Type="Collection(Terrasoft.Configuration.OData.Contact)" Partner="Owner" />
      </EntityType>
      <EntityContainer Name="ODataContainer">
        <EntitySet Name="Contact" EntityType="Terrasoft.Configuration.OData.Contact" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

describe("Template metadata parsing", () => {
  it("detects lookups, keys, streams and max length", () => {
    const details = parseCsdlFieldDetails(CSDL, "Contact");
    const byName = new Map(details.map((d) => [d.name, d]));

    assert.equal(byName.get("Id")?.key, true);
    assert.equal(byName.get("Name")?.nullable, false);
    assert.equal(byName.get("Email")?.maxLength, 250);
    assert.equal(byName.get("Email")?.nullable, true);
    assert.equal(byName.get("ContactPhoto")?.type, "Edm.Stream");

    assert.deepEqual(byName.get("OwnerId")?.lookup, { navigation: "Owner", entity: "Contact" });
    // CreatedById has a navigation named CreatedBy, so it is a lookup too.
    assert.equal(byName.get("CreatedById")?.lookup?.entity, "Contact");
    // Plain GUID without navigation stays a plain guid column.
    assert.equal(byName.get("Id")?.lookup, undefined);
  });

  it("keeps parseCsdlEntityFields shape stable", () => {
    const details = parseCsdlFieldDetails(CSDL, "Contact");
    assert.equal(details.length, 10);
    assert.equal(details.filter((d) => d.name === "Name")[0]?.type, "Edm.String");
  });
});

describe("Template column building", () => {
  const details = parseCsdlFieldDetails(CSDL, "Contact");

  it("drops system and stream columns by default", () => {
    const headers = buildTemplateColumns(details).map((c) => c.header);
    for (const dropped of ["Id", "CreatedOn", "CreatedBy", "ModifiedOn", "ModifiedById", "ProcessListeners", "ContactPhoto"]) {
      assert.equal(headers.includes(dropped), false, `${dropped} should be excluded`);
    }
    assert.deepEqual(headers, ["Name", "Email", "AnnualRevenue", "Confirmed", "Owner"]);
  });

  it("keeps system columns when includeSystem is set", () => {
    const headers = buildTemplateColumns(details, { includeSystem: true }).map((c) => c.header);
    assert.equal(headers.includes("Id"), true);
    assert.equal(headers.includes("ProcessListeners"), true);
    // Stream columns stay out even then.
    assert.equal(headers.includes("ContactPhoto"), false);
  });

  it("heads lookup columns with the navigation name and keeps the OData target", () => {
    const owner = buildTemplateColumns(details).find((c) => c.header === "Owner")!;
    assert.equal(owner.target, "OwnerId");
    assert.equal(owner.lookupEntity, "Contact");
    assert.deepEqual(owner.mapping, {
      type: "lookup",
      target: "OwnerId",
      lookup: { entity: "Contact", key: "Name" },
    });
  });

  it("honours a custom lookup key", () => {
    const owner = buildTemplateColumns(details, { lookupKey: "Email" }).find((c) => c.header === "Owner")!;
    assert.deepEqual(owner.mapping.lookup, { entity: "Contact", key: "Email" });
  });

  it("maps EDM types to mapping types", () => {
    assert.equal(edmToMappingType("Edm.String"), "string");
    assert.equal(edmToMappingType("Edm.Guid"), "guid");
    assert.equal(edmToMappingType("Edm.Int32"), "int");
    assert.equal(edmToMappingType("Edm.Decimal"), "decimal");
    assert.equal(edmToMappingType("Edm.Boolean"), "bool");
    assert.equal(edmToMappingType("Edm.DateTimeOffset"), "datetime");
    assert.equal(edmToMappingType("Edm.Unknown"), "string");

    const columns = buildTemplateColumns(details);
    assert.equal(columns.find((c) => c.header === "AnnualRevenue")?.mappingType, "decimal");
    assert.equal(columns.find((c) => c.header === "Confirmed")?.mappingType, "bool");
    assert.equal(columns.find((c) => c.header === "Email")?.mapping.max_length, 250);
  });

  it("builds a mapping document with key fields", () => {
    const columns = buildTemplateColumns(details);
    const mapping = buildTemplateMapping(columns, { entity: "Contact", keyColumns: ["Email"] });
    assert.equal(mapping.entity, "Contact");
    assert.deepEqual(mapping.key_fields, ["Email"]);
    assert.equal(mapping.fields.Owner.type, "lookup");
    assert.equal(mapping.fields.Name.target, "Name");
  });

  it("produces sample values per type", () => {
    const columns = buildTemplateColumns(details);
    assert.equal(sampleValue(columns.find((c) => c.header === "Name")!), "contoh teks");
    assert.equal(sampleValue(columns.find((c) => c.header === "Confirmed")!), "true");
    assert.match(sampleValue(columns.find((c) => c.header === "Owner")!), /^contoh Contact$/);
  });
});

describe("Template file writers", () => {
  let dir: string;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "csmt-template-"));
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const details = parseCsdlFieldDetails(CSDL, "Contact");
  const columns = buildTemplateColumns(details);

  it("writes CSV with BOM, header and optional sample row", () => {
    const out = path.join(dir, "contact-template.csv");
    writeCsvTemplate(out, columns, { sample: true });
    const text = fs.readFileSync(out, "utf-8");
    assert.equal(text.startsWith("\ufeff"), true);
    const lines = text.replace(/^\ufeff/, "").trimEnd().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(lines[0], "Name,Email,AnnualRevenue,Confirmed,Owner");
    assert.match(lines[1]!, /^contoh teks,contoh teks,1\.5,true,contoh Contact$/);
  });

  it("writes CSV without BOM when disabled", () => {
    const out = path.join(dir, "no-bom.csv");
    writeCsvTemplate(out, columns, { bom: false });
    const text = fs.readFileSync(out, "utf-8");
    assert.equal(text.startsWith("\ufeff"), false);
    assert.equal(text.trimEnd().split("\n").length, 1);
  });

  it("writes XLSX with a data sheet and a schema sheet", async () => {
    const out = path.join(dir, "contact-template.xlsx");
    await writeXlsxTemplate(out, "Contact", columns, { sample: true });
    assert.equal(fs.existsSync(out), true);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(out);
    assert.deepEqual(workbook.worksheets.map((w) => w.name), ["Contact", "schema"]);

    const data = workbook.getWorksheet("Contact")!;
    assert.equal(data.getRow(1).getCell(1).value, "Name");
    assert.equal(data.getRow(1).getCell(5).value, "Owner");
    assert.equal(data.getRow(2).getCell(5).value, "contoh Contact");

    const schema = workbook.getWorksheet("schema")!;
    assert.deepEqual(schema.getRow(1).values.slice(1, 7), [
      "header",
      "target",
      "edm_type",
      "nullable",
      "max_length",
      "lookup_entity",
    ]);
    const ownerRow = schema.getRow(columns.findIndex((c) => c.header === "Owner") + 2);
    assert.deepEqual(ownerRow.values.slice(1, 7), ["Owner", "OwnerId", "Edm.Guid", "yes", "", "Contact"]);
  });

  it("infers format from extension", () => {
    assert.equal(templateFormatFor("out.csv"), "csv");
    assert.equal(templateFormatFor("out.XLSX"), "xlsx");
    assert.throws(() => templateFormatFor("out.json"), ConfigError);
  });

  it("refuses to write an empty template", () => {
    assert.throws(() => writeCsvTemplate(path.join(dir, "empty.csv"), []), ConfigError);
  });
});
