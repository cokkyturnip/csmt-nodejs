/**
 * In-memory Creatio OData 4 mock server for testing.
 */

import http from "node:http";
import { AddressInfo } from "node:net";
import crypto from "node:crypto";

export interface EntityDef {
  name: string;
  fields: Record<string, string>;
  required?: string[];
  unique?: string[];
  defaults?: Record<string, any>;
}

export const DEFAULT_ENTITIES: Record<string, EntityDef> = {
  Contact: {
    name: "Contact",
    fields: {
      Id: "Edm.Guid",
      Name: "Edm.String",
      Email: "Edm.String",
      BirthDate: "Edm.DateTime",
      CountryId: "Edm.Guid",
      UsrScore: "Edm.Decimal",
      Active: "Edm.Boolean",
      ProcessListeners: "Edm.Int32",
    },
    required: ["Name"],
    unique: ["Email"],
    defaults: { ProcessListeners: 0, Active: true },
  },
  Country: {
    name: "Country",
    fields: { Id: "Edm.Guid", Name: "Edm.String" },
    required: ["Name"],
    unique: ["Name"],
  },
  Gender: {
    name: "Gender",
    fields: { Id: "Edm.Guid", Name: "Edm.String" },
    required: ["Name"],
    unique: ["Name"],
  },
};

export class MockCreatio {
  public server: http.Server;
  public port = 0;
  public username: string;
  public password: string;
  public clientId: string;
  public clientSecret: string;
  public entities: Record<string, EntityDef>;
  public store: Record<string, Record<string, Record<string, any>>> = {};
  public sessionToken = crypto.randomUUID();
  public csrfToken = crypto.randomUUID();
  public bearerToken = crypto.randomUUID();
  public attempts: Record<string, number> = {};
  public requests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body?: any }> = [];

  constructor(opts?: {
    username?: string;
    password?: string;
    clientId?: string;
    clientSecret?: string;
    entities?: Record<string, EntityDef>;
  }) {
    this.username = opts?.username || "Supervisor";
    this.password = opts?.password || "secret";
    this.clientId = opts?.clientId || "client";
    this.clientSecret = opts?.clientSecret || "client-secret";
    this.entities = { ...(opts?.entities || DEFAULT_ENTITIES) };

    for (const name of Object.keys(this.entities)) {
      this.store[name] = {};
    }

    this.server = http.createServer((req, res) => this.handleRequest(req, res));
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get identityUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<string> {
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server.address() as AddressInfo;
        this.port = addr.port;
        resolve(this.baseUrl);
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  seed(entity: string, record: Record<string, any>): string {
    const recId = record.Id || crypto.randomUUID();
    const cleanRec = { ...record, Id: recId };
    this.store[entity] = this.store[entity] || {};
    this.store[entity]![recId] = cleanRec;
    return recId;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const buffers: Buffer[] = [];
    for await (const chunk of req) {
      buffers.push(chunk);
    }
    const rawBody = Buffer.concat(buffers).toString("utf-8");
    let jsonBody: any = null;
    try {
      jsonBody = JSON.parse(rawBody);
    } catch {
      jsonBody = rawBody;
    }

    this.requests.push({
      method: req.method || "GET",
      url: req.url || "/",
      headers: req.headers,
      body: jsonBody,
    });

    const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = parsedUrl.pathname;

    // Login endpoint
    if (pathname.includes("/ServiceModel/AuthService.svc/Login")) {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      if (jsonBody?.UserName === this.username && jsonBody?.UserPassword === this.password) {
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Set-Cookie": [
            `.ASPXAUTH=${this.sessionToken}; path=/; HttpOnly`,
            `BPMCSRF=${this.csrfToken}; path=/`,
          ],
        });
        res.end(JSON.stringify({ Code: 0, Message: "" }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ Code: -1, Message: "Invalid user name or password." }));
      }
      return;
    }

    // Token endpoint
    if (pathname.endsWith("/connect/token")) {
      const params = new URLSearchParams(rawBody);
      const grantType = params.get("grant_type");
      const cid = params.get("client_id");
      const csec = params.get("client_secret");

      if (grantType === "client_credentials" && cid === this.clientId && csec === this.clientSecret) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ access_token: this.bearerToken, token_type: "Bearer", expires_in: 3600 }));
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_client", error_description: "Bad client credentials" }));
      }
      return;
    }

    // Auth check on OData endpoints
    const isAuthorized = this.checkAuth(req);
    if (!isAuthorized) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "401", message: "Unauthorized" } }));
      return;
    }

    // OData path stripping
    let odataSub = "";
    for (const prefix of ["/0/odata", "/odata"]) {
      if (pathname === prefix || pathname === `${prefix}/`) {
        odataSub = "";
        break;
      }
      if (pathname.startsWith(`${prefix}/`)) {
        odataSub = pathname.slice(prefix.length + 1);
        break;
      }
    }

    // Service doc
    if (!odataSub) {
      const collections = Object.keys(this.entities).map((name) => ({
        name,
        kind: "EntitySet",
        url: name,
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ value: collections }));
      return;
    }

    // Metadata
    if (odataSub === "$metadata") {
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end(this.buildMetadataXml());
      return;
    }

    // $batch endpoint
    if (odataSub === "$batch") {
      this.handleBatch(jsonBody, res);
      return;
    }

    // Single entity operations
    this.handleEntityOperation(req.method || "GET", odataSub, parsedUrl.searchParams, jsonBody, res);
  }

  private checkAuth(req: http.IncomingMessage): boolean {
    const authHeader = req.headers["authorization"] || "";
    if (authHeader.startsWith("Basic ")) {
      const creds = Buffer.from(authHeader.slice(6), "base64").toString("utf-8");
      return creds === `${this.username}:${this.password}`;
    }
    if (authHeader.startsWith("Bearer ")) {
      return authHeader.slice(7) === this.bearerToken;
    }
    const cookie = req.headers["cookie"] || "";
    const bpmcsrf = req.headers["bpmcsrf"];
    if (cookie.includes(`.ASPXAUTH=${this.sessionToken}`) && bpmcsrf === this.csrfToken) {
      return true;
    }
    return false;
  }

  private handleBatch(jsonBody: any, res: http.ServerResponse): void {
    const requests = jsonBody?.requests || [];
    const responses: any[] = [];

    for (const sub of requests) {
      const method = (sub.method || "GET").toUpperCase();
      const subUrl = sub.url || "";
      const subId = sub.id;
      const subBody = sub.body;

      // Extract entity and optional (Id)
      const match = subUrl.match(/^([A-Za-z0-9_]+)(?:\(([0-9a-fA-F-]+)\))?$/);
      if (!match) {
        responses.push({ id: subId, status: 400, body: { error: { message: "Invalid URL" } } });
        continue;
      }

      const entity = match[1]!;
      const recId = match[2];

      if (method === "POST") {
        const name = subBody?.Name;
        if (name === "magic-fail-500") {
          responses.push({ id: subId, status: 500, body: { error: { message: "Internal server error" } } });
          continue;
        }
        const newId = subBody?.Id || crypto.randomUUID();
        const record = { ...subBody, Id: newId };
        this.store[entity] = this.store[entity] || {};
        this.store[entity]![newId] = record;
        responses.push({ id: subId, status: 201, body: record, headers: { Location: `${entity}(${newId})` } });
      } else if (method === "PATCH") {
        if (!recId || !this.store[entity] || !this.store[entity]![recId]) {
          responses.push({ id: subId, status: 404, body: { error: { message: "Not found" } } });
          continue;
        }
        Object.assign(this.store[entity]![recId], subBody);
        responses.push({ id: subId, status: 204 });
      } else {
        responses.push({ id: subId, status: 405 });
      }
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ responses }));
  }

  private handleEntityOperation(
    method: string,
    subPath: string,
    params: URLSearchParams,
    body: any,
    res: http.ServerResponse
  ): void {
    const match = subPath.match(/^([A-Za-z0-9_]+)(?:\(([0-9a-fA-F-]+)\))?$/);
    if (!match) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Resource not found" } }));
      return;
    }

    const entity = match[1]!;
    const recId = match[2];

    if (method === "GET") {
      if (recId) {
        const item = this.store[entity]?.[recId];
        if (!item) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Not found" } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(item));
        return;
      }

      // Collection query
      let items = Object.values(this.store[entity] || {});
      const filter = params.get("$filter");
      if (filter) {
        items = items.filter((item) => this.evalFilter(filter, item));
      }

      const totalCount = items.length;
      const skip = Number(params.get("$skip")) || 0;
      const top = params.has("$top") ? Number(params.get("$top")) : null;

      if (skip > 0) items = items.slice(skip);
      if (top !== null) items = items.slice(0, top);

      const select = params.get("$select")?.split(",").map((s) => s.trim());
      if (select && select.length > 0) {
        items = items.map((item) => {
          const projected: Record<string, any> = {};
          for (const s of select) {
            projected[s] = item[s];
          }
          return projected;
        });
      }

      const out: Record<string, any> = { value: items };
      if (params.get("$count") === "true") {
        out["@odata.count"] = totalCount;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
      return;
    }

    if (method === "POST") {
      const name = body?.Name;
      if (name === "transient-fail") {
        this.attempts[name] = (this.attempts[name] || 0) + 1;
        if (this.attempts[name] === 1) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Service Unavailable" } }));
          return;
        }
      } else if (name === "permanent-fail") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Internal server error" } }));
        return;
      }

      const newId = body?.Id || crypto.randomUUID();
      const record = { ...body, Id: newId };
      this.store[entity] = this.store[entity] || {};
      this.store[entity]![newId] = record;

      res.writeHead(201, {
        "Content-Type": "application/json",
        Location: `${entity}(${newId})`,
      });
      res.end(JSON.stringify(record));
      return;
    }

    if (method === "PATCH") {
      if (!recId || !this.store[entity] || !this.store[entity]![recId]) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Not found" } }));
        return;
      }
      Object.assign(this.store[entity]![recId], body);
      res.writeHead(204).end();
      return;
    }

    res.writeHead(405).end();
  }

  private evalFilter(filter: string, item: Record<string, any>): boolean {
    // Basic filter parser supporting " or " and " and "
    const orParts = filter.split(/\s+or\s+/i);
    if (orParts.length > 1) {
      return orParts.some((part) => this.evalFilter(part.trim().replace(/^\(|\)$/g, ""), item));
    }

    const andParts = filter.split(/\s+and\s+/i);
    for (const part of andParts) {
      const cleanPart = part.trim().replace(/^\(|\)$/g, "");
      const eqIdx = cleanPart.indexOf(" eq ");
      if (eqIdx !== -1) {
        const left = cleanPart.slice(0, eqIdx).trim();
        let right = cleanPart.slice(eqIdx + 4).trim();
        if ((right.startsWith("'") && right.endsWith("'")) || (right.startsWith('"') && right.endsWith('"'))) {
          right = right.slice(1, -1).replace(/''/g, "'");
        }
        const itemVal = item[left];
        if (String(itemVal ?? "").toLowerCase() !== String(right).toLowerCase()) {
          return false;
        }
      }
    }
    return true;
  }

  private buildMetadataXml(): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Terrasoft.Configuration" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="BaseEntity">
        <Property Name="Id" Type="Edm.Guid" Nullable="false" />
        <Property Name="CreatedOn" Type="Edm.DateTimeOffset" />
        <Property Name="ProcessListeners" Type="Edm.Int32" />
      </EntityType>
      <EntityType Name="Contact" BaseType="Terrasoft.Configuration.BaseEntity">
        <Property Name="Name" Type="Edm.String" />
        <Property Name="Email" Type="Edm.String" />
        <Property Name="CountryId" Type="Edm.Guid" />
      </EntityType>
      <EntityType Name="Country" BaseType="Terrasoft.Configuration.BaseEntity">
        <Property Name="Name" Type="Edm.String" />
      </EntityType>
      <EntityContainer Name="ConfigurationService">
        <EntitySet Name="Contact" EntityType="Terrasoft.Configuration.Contact" />
        <EntitySet Name="Country" EntityType="Terrasoft.Configuration.Country" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;
  }
}
