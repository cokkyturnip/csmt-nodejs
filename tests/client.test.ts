import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { MockCreatio } from "./mock-creatio.js";
import { ODataClient, parseCsdlEntityFields } from "../src/client.js";
import { Settings } from "../src/config.js";
import { ODataError } from "../src/errors.js";

describe("Client module with MockCreatio", () => {
  let mock: MockCreatio;
  let baseUrl: string;

  before(async () => {
    mock = new MockCreatio();
    baseUrl = await mock.start();
  });

  after(async () => {
    await mock.stop();
  });

  it("authenticates via forms auth and sets cookies", async () => {
    const settings = new Settings({
      baseUrl,
      authMode: "forms",
      username: "Supervisor",
      password: "secret",
    });
    const client = new ODataClient(settings);
    const doc = await client.serviceDocument();
    assert.ok(Array.isArray(doc.value));
    client.close();
  });

  it("authenticates via basic auth", async () => {
    const settings = new Settings({
      baseUrl,
      authMode: "basic",
      username: "Supervisor",
      password: "secret",
    });
    const client = new ODataClient(settings);
    const ping = await client.ping();
    assert.equal(ping.auth_mode, "basic");
    client.close();
  });

  it("authenticates via OAuth 2.0 client credentials", async () => {
    const settings = new Settings({
      baseUrl,
      authMode: "oauth2",
      clientId: "client",
      clientSecret: "client-secret",
      identityUrl: baseUrl,
    });
    const client = new ODataClient(settings);
    const ping = await client.ping();
    assert.equal(ping.auth_mode, "oauth2");
    client.close();
  });

  it("performs create, update, get, iterCollection and count", async () => {
    const settings = new Settings({
      baseUrl,
      authMode: "basic",
      username: "Supervisor",
      password: "secret",
      entity: "Contact",
    });
    const client = new ODataClient(settings);

    // Create
    const created = await client.create("Contact", { Name: "Test Contact", Email: "test@example.com" });
    assert.ok(created.Id);
    const id = created.Id;

    // Get
    const record = await client.getRecord("Contact", id);
    assert.equal(record?.Name, "Test Contact");

    // Update
    await client.update("Contact", id, { Name: "Updated Contact" });
    const updated = await client.getRecord("Contact", id);
    assert.equal(updated?.Name, "Updated Contact");

    // Count
    const cnt = await client.count("Contact");
    assert.ok(cnt >= 1);

    // Iter
    const all = [];
    for await (const rec of client.iterCollection("Contact")) {
      all.push(rec);
    }
    assert.ok(all.some((r) => r.Id === id));
    client.close();
  });

  it("executes $batch operations", async () => {
    const settings = new Settings({
      baseUrl,
      authMode: "basic",
      username: "Supervisor",
      password: "secret",
    });
    const client = new ODataClient(settings);

    const ops = [
      { method: "POST", url: "Contact", id: "1", body: { Name: "Batch 1" } },
      { method: "POST", url: "Contact", id: "2", body: { Name: "Batch 2" } },
    ];

    const results = await client.batch(ops);
    assert.ok(results["1"]?.ok);
    assert.ok(results["2"]?.ok);
    assert.ok(results["1"]?.recordId);
    client.close();
  });

  it("parses CSDL entity fields with BaseType inheritance", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Terrasoft.Configuration" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="BaseEntity">
        <Property Name="Id" Type="Edm.Guid" Nullable="false" />
        <Property Name="CreatedOn" Type="Edm.DateTimeOffset" />
      </EntityType>
      <EntityType Name="Contact" BaseType="Terrasoft.Configuration.BaseEntity">
        <Property Name="Name" Type="Edm.String" />
        <Property Name="Email" Type="Edm.String" />
      </EntityType>
      <EntityContainer Name="Service">
        <EntitySet Name="Contact" EntityType="Terrasoft.Configuration.Contact" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

    const fields = parseCsdlEntityFields(xml, "Contact");
    // Inherited from BaseEntity
    assert.ok("Id" in fields);
    assert.ok("CreatedOn" in fields);
    // Directly on Contact
    assert.ok("Name" in fields);
    assert.ok("Email" in fields);
  });
});
