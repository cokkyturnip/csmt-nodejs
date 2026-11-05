/**
 * Command line interface for CSMT.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Command } from "commander";
import { ODataClient, hintForOdataError } from "./client.js";
import {
  Settings,
  asFloat,
  asInt,
  defaultIdentityUrl,
  loadEnvFile,
  normalizeBaseUrl,
} from "./config.js";
import { ConfigError, CreatioError, ODataError } from "./errors.js";
import { ExportOptions, Exporter, LookupExpansion } from "./export.js";
import { Journal } from "./journal.js";
import { Mapper, Mapping, buildIdentityMapping } from "./mapping.js";
import { ImportMode, ImportPipeline, PipelineOptions } from "./pipeline.js";
import { ReportWriter, Summary } from "./report.js";
import { openSource } from "./tabular.js";
import {
  buildTemplateColumns,
  buildTemplateMapping,
  templateFormatFor,
  writeCsvTemplate,
  writeXlsxTemplate,
} from "./template.js";
import { configureLogger, getLogger } from "./logger.js";

export function buildSettingsFromArgs(options: Record<string, any>): Settings {
  if (options.envFile) {
    loadEnvFile(options.envFile);
  } else {
    const defaultEnv = path.resolve(process.cwd(), ".env");
    if (fs.existsSync(defaultEnv)) {
      loadEnvFile(defaultEnv);
    }
  }

  const overrides: Record<string, any> = {
    baseUrl: options.baseUrl,
    odataPath: options.odataPath,
    entity: options.entity || undefined,
    authMode: options.authMode,
    username: options.username,
    password: options.password,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    identityUrl: options.identityUrl,
    scope: options.scope,
    timeout: options.timeout !== undefined ? asFloat(options.timeout, "--timeout") : undefined,
    maxRetries: options.maxRetries !== undefined ? asInt(options.maxRetries, "--max-retries") : undefined,
  };

  if (options.insecure) {
    overrides.verifySsl = false;
  }

  const explicitUser = Boolean(options.username && options.password);
  const explicitClient = Boolean(options.clientId && options.clientSecret);
  if (!options.authMode && explicitUser && !explicitClient) {
    overrides.authMode = "forms";
  }

  return Settings.fromEnv(process.env, overrides);
}

function parseKeys(raw?: string): string[] {
  if (!raw) return [];
  return raw.split(",").map((p) => p.trim()).filter(Boolean);
}

function defaultReportPath(csvPath: string): string {
  const parsed = path.parse(csvPath);
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return path.join(parsed.dir, `${parsed.name}-report-${stamp}.csv`);
}

function printSummary(summary: Summary): void {
  console.log("\nImport summary");
  console.log("--------------");
  for (const [key, value] of Object.entries(summary.asDict())) {
    console.log(`  ${key.padStart(17)}: ${value}`);
  }
}

function addConnectionOptions(cmd: Command): Command {
  return cmd
    .option("--base-url <url>", "Creatio base URL, e.g. https://mycreatio.com")
    .option("--odata-path <path>", "OData service path (default /0/odata for .NET Framework, /odata for .NET 8)")
    .option("--auth-mode <mode>", "Authentication method (auto, basic, forms, oauth2)")
    .option("--username <user>", "Username")
    .option("--password <pass>", "Password")
    .option("--client-id <id>", "OAuth 2.0 client id")
    .option("--client-secret <secret>", "OAuth 2.0 client secret")
    .option("--identity-url <url>", "OAuth 2.0 identity service URL")
    .option("--scope <scope>", "OAuth scope")
    .option("--insecure", "Do not verify TLS certificates")
    .option("--timeout <seconds>", "HTTP timeout in seconds")
    .option("--max-retries <n>", "Retries for 429/5xx/transport errors")
    .option("--env-file <file>", "Load configuration from this .env file")
    .option("--log-level <level>", "Logging level: debug, info, warning, error (default info)")
    .option("--log-file <file>", "Write log messages to this file")
    .option("--quiet", "Suppress log output except errors");
}

function packageVersion(): string {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(pkgUrl, "utf-8")) as { version?: string };
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function buildCli(): Command {
  const program = new Command();
  program
    .name("csmt")
    .description("Migrate spreadsheet (CSV/XLSX) data to and from Creatio through the OData 4 web service.")
    .version(packageVersion());

  program.hook("preAction", (thisCommand, actionCommand) => {
    const opts = actionCommand.opts();
    configureLogger({
      level: opts.logLevel,
      logFile: opts.logFile,
      quiet: Boolean(opts.quiet),
    });
  });

  // --- check ---
  addConnectionOptions(program.command("check"))
    .description("Verify URL, credentials and entity access")
    .option("--entity <entity>", "Also check that this entity set is readable")
    .action(async (opts) => {
      try {
        const settings = buildSettingsFromArgs(opts);
        const client = new ODataClient(settings);
        try {
          const info = await client.ping();
          if (settings.authMode === "oauth2" || settings.authMode === "auto") {
            const used = (client.auth.strategy as any)?.endpointUsed;
            if (used) {
              info.identity_endpoint_used = used;
            } else {
              info.identity_candidates = settings.identityCandidates;
            }
          }
          console.log(JSON.stringify(info, null, 2));
          console.log("OK: connection and credentials are valid");
        } catch (err: unknown) {
          if (err instanceof ODataError) {
            const hint = hintForOdataError(err);
            if (hint) {
              throw new ODataError(`${err.detail} | ${hint}`, {
                status: err.status,
                code: err.code,
                payload: err.payload,
                method: err.method,
                url: err.url,
              });
            }
          }
          throw err;
        } finally {
          client.close();
        }
      } catch (err: unknown) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 2;
      }
    });

  // --- schema ---
  addConnectionOptions(program.command("schema"))
    .description("Print entity fields and EDM types from $metadata")
    .requiredOption("--entity <entity>", "Entity set name")
    .option("--json", "Emit JSON instead of a table")
    .action(async (opts) => {
      try {
        const settings = buildSettingsFromArgs(opts);
        const client = new ODataClient(settings);
        try {
          const fields = await client.entityFields(opts.entity);
          if (opts.json) {
            console.log(JSON.stringify(fields, null, 2));
            return;
          }
          const fieldNames = Object.keys(fields).sort();
          const width = Math.max(...fieldNames.map((n) => n.length), 10);
          console.log(`Entity set: ${opts.entity} (${fieldNames.length} fields)`);
          for (const name of fieldNames) {
            console.log(`  ${name.padEnd(width)}  ${fields[name]}`);
          }
        } finally {
          client.close();
        }
      } catch (err: unknown) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 2;
      }
    });

  // --- template ---
  addConnectionOptions(program.command("template"))
    .description("Generate a CSV/XLSX import template (and optional mapping) from $metadata")
    .requiredOption("--entity <entity>", "Entity set name")
    .requiredOption("--out <file>", "Output file; the extension decides the format (.csv or .xlsx)")
    .option("--with-mapping <file>", "Also write a starter mapping JSON")
    .option("--key <keys>", "Comma separated key column(s) to store in the mapping")
    .option("--sample", "Include one example row")
    .option("--include-system", "Include system/read-only columns")
    .option("--lookup-key <field>", "Lookup field the cell value is matched against", "Name")
    .option("--delimiter <delim>", "CSV delimiter", ",")
    .option("--no-bom", "Write CSV without a UTF-8 BOM")
    .action(async (opts) => {
      try {
        const format = templateFormatFor(opts.out);
        const settings = buildSettingsFromArgs(opts);
        const client = new ODataClient(settings);
        try {
          const details = await client.entityFieldDetails(opts.entity);
          const columns = buildTemplateColumns(details, {
            includeSystem: Boolean(opts.includeSystem),
            lookupKey: opts.lookupKey,
          });
          const outPath = path.resolve(opts.out);
          if (format === "csv") {
            writeCsvTemplate(outPath, columns, {
              delimiter: opts.delimiter,
              bom: opts.bom !== false,
              sample: Boolean(opts.sample),
            });
          } else {
            await writeXlsxTemplate(outPath, opts.entity, columns, { sample: Boolean(opts.sample) });
          }
          const lookups = columns.filter((c) => c.lookupEntity).length;
          console.log(`Wrote ${format.toUpperCase()} template with ${columns.length} columns to ${outPath}`);
          console.log(`  ${columns.length - lookups} scalar, ${lookups} lookup (matched by ${JSON.stringify(opts.lookupKey)})`);
          if (opts.withMapping) {
            const mappingPath = path.resolve(opts.withMapping);
            const document = buildTemplateMapping(columns, {
              entity: opts.entity,
              keyColumns: parseKeys(opts.key),
            });
            fs.mkdirSync(path.dirname(mappingPath), { recursive: true });
            fs.writeFileSync(mappingPath, JSON.stringify(document, null, 2), "utf-8");
            console.log(`Wrote starter mapping to ${mappingPath}`);
          }
        } finally {
          client.close();
        }
      } catch (err: unknown) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 2;
      }
    });

  // --- init-mapping ---
  program
    .command("init-mapping")
    .description("Generate a starter mapping JSON from CSV/XLSX headers")
    .requiredOption("--csv <file>", "Path to the CSV or XLSX file")
    .option("--out <file>", "Output mapping path", "mapping.json")
    .option("--entity <entity>", "Entity set name to store in the mapping")
    .option("--key <keys>", "Comma separated key column(s)")
    .option("--delimiter <delim>", "CSV delimiter (auto-detected by default)")
    .option("--encoding <enc>", "CSV encoding (auto-detected by default)")
    .option("--no-header", "File has no header")
    .option("--sheet <sheet>", "Worksheet name or index (.xlsx/.xlsm only)")
    .option("--header-row <n>", "Header row number (.xlsx/.xlsm only)", "1")
    .action(async (opts) => {
      try {
        const source = await openSource(opts.csv, {
          encoding: opts.encoding,
          delimiter: opts.delimiter,
          hasHeader: opts.header !== false,
          sheet: opts.sheet,
          headerRow: opts.headerRow !== undefined ? asInt(opts.headerRow, "--header-row") : 1,
        });
        const info = await source.info();
        const document = buildIdentityMapping(info.fieldnames, {
          entity: opts.entity,
          keyColumns: parseKeys(opts.key),
        });
        const outPath = path.resolve(opts.out);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(document, null, 2), "utf-8");
        console.log(`Wrote starter mapping to ${outPath}`);
        if (info.format === "csv") {
          console.log(`Detected delimiter ${JSON.stringify(info.delimiter)}, encoding ${info.encoding}`);
        } else {
          console.log(`Detected sheet ${JSON.stringify(info.sheet)}, header row ${info.headerRow}, ${info.fieldnames.length} columns`);
        }
      } catch (err: unknown) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 2;
      }
    });

  // --- import ---
  addConnectionOptions(program.command("import"))
    .description("Import a CSV or XLSX file into Creatio")
    .requiredOption("--csv <file>", "Path to the CSV or XLSX file")
    .option("--entity <entity>", "Entity set name, e.g. Contact")
    .option("--mapping <file>", "JSON mapping file")
    .option("--key <keys>", "Comma separated key field(s)")
    .option("--mode <mode>", "create | update | upsert", "upsert")
    .option("--batch-size <n>", "Records per $batch request (1-100)", "50")
    .option("--no-batch", "Send one request per record")
    .option("--dry-run", "Validate and plan without writing")
    .option("--limit <n>", "Only process first N data rows")
    .option("--create-missing", "In update mode, create records whose key is missing")
    .option("--skip-existing", "In create mode, skip records whose key already exists")
    .option("--duplicate-policy <policy>", "error | first_wins | last_wins", "error")
    .option("--resume", "Skip rows already completed in journal")
    .option("--journal <file>", "Journal path")
    .option("--no-journal", "Disable resume journal")
    .option("--report <file>", "CSV report path")
    .option("--no-report", "Do not write CSV report")
    .option("--fail-fast", "Stop at first failed record")
    .option("--max-errors <n>", "Stop after N failed records", "0")
    .option("--strict-sources", "Fail when CSV lacks mapping columns")
    .option("--validate-fields", "Check mapping targets against entity schema")
    .option("--delimiter <delim>", "CSV delimiter")
    .option("--encoding <enc>", "CSV encoding")
    .option("--sheet <sheet>", "Worksheet name or index")
    .option("--header-row <n>", "Header row number", "1")
    .option("--chunk-rows <n>", "Rows buffered before processing", "500")
    .option("--progress-every <n>", "Log progress every N rows", "200")
    .option("--no-header", "File has no header row")
    .action(async (opts) => {
      try {
        const settings = buildSettingsFromArgs(opts);
        const csvPath = path.resolve(opts.csv);
        let entity = (opts.entity || settings.entity || "").trim();

        const source = await openSource(csvPath, {
          encoding: opts.encoding,
          delimiter: opts.delimiter,
          hasHeader: opts.header !== false,
          sheet: opts.sheet,
          headerRow: opts.headerRow !== undefined ? asInt(opts.headerRow, "--header-row") : 1,
        });
        const info = await source.info();
        const keys = parseKeys(opts.key);

        let mapping: Mapping;
        if (opts.mapping) {
          mapping = Mapping.load(opts.mapping);
          if (keys.length > 0) {
            mapping.keyFields = keys;
            mapping.validateKeys();
          }
          if (entity) {
            mapping.entity = entity;
          }
        } else {
          mapping = Mapping.identity(info.fieldnames, { keyFields: keys, entity: entity || undefined });
        }

        entity = (mapping.entity || entity || "").trim();
        if (!entity) {
          throw new ConfigError("Entity set name is required (--entity or 'entity' in mapping)");
        }
        mapping.entity = entity;
        const mapper = new Mapper(mapping);

        const journalPath = opts.journal === false ? null : opts.journal ? path.resolve(opts.journal) : `${csvPath}.journal.jsonl`;
        const reportPath = opts.report === false ? null : opts.report ? path.resolve(opts.report) : defaultReportPath(csvPath);

        const pipelineOptions = new PipelineOptions({
          mode: opts.mode as ImportMode,
          batchSize: opts.batchSize !== undefined ? asInt(opts.batchSize, "--batch-size") : 50,
          useBatch: opts.batch !== false,
          dryRun: Boolean(opts.dryRun),
          limit: opts.limit !== undefined ? asInt(opts.limit, "--limit") : null,
          createMissing: Boolean(opts.createMissing),
          skipExisting: Boolean(opts.skipExisting),
          continueOnError: !opts.failFast,
          duplicatePolicy: opts.duplicatePolicy,
          resume: Boolean(opts.resume),
          strictSources: Boolean(opts.strictSources),
          progressEvery: opts.progressEvery !== undefined ? asInt(opts.progressEvery, "--progress-every") : 200,
          chunkRows: opts.chunkRows !== undefined ? asInt(opts.chunkRows, "--chunk-rows") : 500,
          maxErrors: opts.maxErrors !== undefined ? asInt(opts.maxErrors, "--max-errors") : 0,
        });

        const client = new ODataClient(settings);
        const journal = new Journal(journalPath);
        const report = new ReportWriter(reportPath);

        let summary: Summary;
        try {
          if (opts.validateFields) {
            const fields = await client.entityFields(entity);
            mapper.mapping.validateTargets(Object.keys(fields));
          }

          const pipeline = new ImportPipeline({
            settings,
            client,
            mapper,
            source,
            journal,
            report,
            options: pipelineOptions,
          });
          summary = await pipeline.run();
        } finally {
          journal.close();
          await report.close();
          client.close();
        }

        printSummary(summary);
        if (summary.reportPath && summary.total > 0 && fs.existsSync(summary.reportPath)) {
          console.log(`Report: ${summary.reportPath}`);
        }
        if (summary.journalPath && fs.existsSync(summary.journalPath)) {
          console.log(`Journal: ${summary.journalPath}`);
        }

        if (summary.hasFailures) {
          console.error(`WARNING: ${summary.failed} failed and ${summary.unknown} unknown row(s). See the report for details.`);
          process.exitCode = 1;
        } else {
          process.exitCode = 0;
        }
      } catch (err: unknown) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 2;
      }
    });

  // --- export ---
  addConnectionOptions(program.command("export"))
    .description("Export Creatio records to a CSV or XLSX file")
    .requiredOption("--entity <entity>", "Entity set name, e.g. Contact")
    .option("--out <file>", "Output CSV or XLSX path")
    .option("--select <fields>", "Comma separated fields to export")
    .option("--filter <filter>", "OData $filter expression")
    .option("--orderby <orderby>", "OData $orderby expression")
    .option("--limit <n>", "Stop after N rows")
    .option("--page-size <n>", "Records per request")
    .option(
      "--expand-lookups <spec...>",
      "Replace GUIDs with captions, e.g. CountryId=Country.Name (repeatable)"
    )
    .option("--format <fmt>", "Output format (auto, csv, xlsx)", "auto")
    .option("--sheet-name <name>", "Worksheet name for .xlsx output")
    .option("--sheet <name>", "Alias for --sheet-name")
    .option("--delimiter <delim>", "CSV delimiter", ",")
    .option("--encoding <enc>", "CSV encoding", "utf-8-sig")
    .option("--lookup-chunk <n>", "Chunk size for lookup expansion queries", "30")
    .option("--log-every <n>", "Log progress every N rows", "1000")
    .option("--no-header", "Do not write the header row")
    .action(async (opts) => {
      try {
        const settings = buildSettingsFromArgs(opts);
        const entity = (opts.entity || settings.entity || "").trim();
        const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
        const outPath = opts.out || path.join(process.cwd(), `${entity}-export-${stamp}.${opts.format === "xlsx" ? "xlsx" : "csv"}`);

        const select = opts.select ? opts.select.split(",").map((p: string) => p.trim()).filter(Boolean) : [];
        const rawLookups = Array.isArray(opts.expandLookups)
          ? opts.expandLookups
          : opts.expandLookups
          ? [opts.expandLookups]
          : [];
        const lookups = rawLookups.map((r: string) => LookupExpansion.parse(r));

        const exportOptions = new ExportOptions({
          entity,
          out: outPath,
          select,
          filter: opts.filter,
          orderby: opts.orderby,
          limit: opts.limit !== undefined ? asInt(opts.limit, "--limit") : null,
          pageSize: opts.pageSize !== undefined ? asInt(opts.pageSize, "--page-size") : null,
          delimiter: opts.delimiter,
          encoding: opts.encoding,
          writeHeader: opts.header !== false,
          format: opts.format,
          sheetName: opts.sheetName || opts.sheet,
          lookups,
          lookupChunk: opts.lookupChunk !== undefined ? asInt(opts.lookupChunk, "--lookup-chunk") : 30,
          logEvery: opts.logEvery !== undefined ? asInt(opts.logEvery, "--log-every") : 1000,
        });

        const client = new ODataClient(settings);
        let result: Record<string, any>;
        try {
          const exporter = new Exporter(client, exportOptions);
          result = await exporter.run();
        } finally {
          client.close();
        }

        console.log("\nExport summary");
        console.log("--------------");
        for (const [key, value] of Object.entries(result)) {
          console.log(`  ${key.padStart(10)}: ${Array.isArray(value) ? value.join(", ") : value}`);
        }
      } catch (err: unknown) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 2;
      }
    });

  // --- wizard ---
  program
    .command("wizard")
    .description("Interactive wizard: create .env (URL, auth mode, credentials)")
    .option("--out <file>", "Target env file", ".env")
    .action(async (opts) => {
      try {
        await runWizard(opts.out);
      } catch (err: unknown) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 2;
      }
    });

  return program;
}

export async function runWizard(
  outFilePath: string,
  io?: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream; isTTY?: boolean }
): Promise<void> {
  const stdin = io?.input || process.stdin;
  const stdout = io?.output || process.stdout;
  const isTTY = io?.isTTY !== undefined ? io.isTTY : Boolean((stdin as any).isTTY);
  const linesQueue: string[] = [];
  const waiters: Array<(line: string) => void> = [];

  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    terminal: isTTY,
  });

  let muted = false;
  const rlAny = rl as unknown as { _writeToOutput: (s: string) => void };
  const originalWrite = rlAny._writeToOutput?.bind(rl);
  if (originalWrite) {
    rlAny._writeToOutput = (str: string) => {
      if (!muted) {
        originalWrite(str);
      } else if (str === "\r\n" || str === "\n") {
        originalWrite("\n");
      }
    };
  }

  rl.on("SIGINT", () => {
    rl.close();
    process.exit(130);
  });

  let closed = false;
  rl.on("close", () => {
    closed = true;
    while (waiters.length > 0) {
      const waiter = waiters.shift()!;
      waiter("");
    }
  });

  rl.on("line", (line) => {
    if (waiters.length > 0) {
      const resolve = waiters.shift()!;
      resolve(line);
    } else {
      linesQueue.push(line);
    }
  });

  const nextLine = (): Promise<string> =>
    new Promise((resolve, reject) => {
      if (linesQueue.length > 0) {
        resolve(linesQueue.shift()!);
      } else if (closed) {
        reject(new ConfigError("Input ended before wizard completed"));
      } else {
        waiters.push(resolve);
      }
    });

  const question = async (promptText: string, defaultVal?: string): Promise<string> => {
    const suffix = defaultVal ? ` [${defaultVal}]` : "";
    (stdout as any).write(`${promptText}${suffix}: `);
    const line = (await nextLine()).trim();
    return line || (defaultVal ?? "");
  };

  const questionSecret = async (promptText: string): Promise<string> => {
    (stdout as any).write(`${promptText}: `);
    if (isTTY) muted = true;
    try {
      const line = (await nextLine()).trim();
      return line;
    } finally {
      if (isTTY) muted = false;
    }
  };

  console.log("=== CSMT Configuration Wizard ===\n");
  const rawBaseUrl = await question("Creatio Base URL (mis. https://mycompany.creatio.com)");
  const [root, defaultOdata] = normalizeBaseUrl(rawBaseUrl);

  const odataPath = await question("OData path (/0/odata untuk .NET Framework, /odata untuk .NET 8)", defaultOdata);
  const authMode = await question("Metode autentikasi (oauth2, forms, basic)", "oauth2");

  let username = "";
  let password = "";
  let clientId = "";
  let clientSecret = "";
  let identityUrl = "";

  if (authMode === "forms" || authMode === "basic") {
    username = await question("Username");
    password = await questionSecret("Password");
  } else {
    clientId = await question("Client ID");
    clientSecret = await questionSecret("Client secret");
    const idDefault = defaultIdentityUrl(root) || "";
    identityUrl = await question("Identity service URL", idDefault);
  }

  const entity = await question("Entity set default (mis. Contact, lewati jika belum perlu)", "");
  const verifyTls = await question("Verifikasi TLS? (true/false)", "true");

  rl.close();

  const outPath = path.resolve(outFilePath);
  if (fs.existsSync(outPath)) {
    fs.copyFileSync(outPath, `${outPath}.bak`);
  }

  const lines = [
    "# Dibuat oleh: csmt wizard",
    "",
    `CREATIO_BASE_URL=${root}`,
    `CREATIO_ODATA_PATH=${odataPath}`,
    `CREATIO_AUTH_MODE=${authMode}`,
  ];

  if (username) lines.push(`CREATIO_USERNAME=${username}`);
  if (password) lines.push(`CREATIO_PASSWORD=${password}`);
  if (clientId) lines.push(`CREATIO_CLIENT_ID=${clientId}`);
  if (clientSecret) lines.push(`CREATIO_CLIENT_SECRET=${clientSecret}`);
  if (identityUrl) lines.push(`CREATIO_IDENTITY_URL=${identityUrl}`);
  lines.push(`CREATIO_ENTITY=${entity}`);
  lines.push(`CREATIO_VERIFY_SSL=${verifyTls}`);
  lines.push("");

  fs.writeFileSync(outPath, lines.join("\n"), "utf-8");
  try {
    fs.chmodSync(outPath, 0o600);
  } catch {}

  console.log(`\nConfig tersimpan di: ${outPath}`);
  console.log(`Lanjutkan dengan: npx csmt-nodejs check --env-file ${outPath}`);
}
