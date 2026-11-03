#!/usr/bin/env node
import { buildCli } from "../dist/cli.js";

const cli = buildCli();
await cli.parseAsync(process.argv);
