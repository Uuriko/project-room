#!/usr/bin/env node
import { main } from "../cli/main.mjs";

try {
  const code = await main(process.argv.slice(2));
  process.exitCode = code ?? 0;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
