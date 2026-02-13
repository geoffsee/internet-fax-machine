#!/usr/bin/env bun

/**
 * Send a fax via the Fax Worker API.
 *
 * Env vars:
 *   FAX_TO           — destination number (E.164 format)
 *   FAX_FILE         — path to PDF (defaults to test-data/sample.pdf)
 *   WORKER_URL       — worker URL (defaults to https://YOUR-WORKER-NAME.workers.dev)
 *   WORKER_USERNAME  — basic auth username (optional)
 *   WORKER_PASSWORD  — basic auth password (optional)
 */

import { readFileSync } from "fs";
import { basename, resolve } from "path";
import { FaxWorkerClient } from "./lib";

const to = must(process.env.FAX_TO, "FAX_TO");
const filePath =
  process.env.FAX_FILE ?? resolve(import.meta.dir, "test-data/sample.pdf");
const workerUrl =
  process.env.WORKER_URL ?? "https://YOUR-WORKER-NAME.workers.dev";
const username = process.env.WORKER_USERNAME;
const password = process.env.WORKER_PASSWORD;

const client = new FaxWorkerClient({ workerUrl, username, password });

const fileBuffer = readFileSync(filePath);
const fileName = basename(filePath);

console.log(`File: ${filePath} (${fileBuffer.byteLength} bytes)`);
console.log(`Worker: ${workerUrl}`);
console.log(`To: ${to}`);
console.log("\nUploading and sending fax...");

const result = await client.uploadAndSendFax(to, fileBuffer, fileName);

console.log("\nSuccess:", JSON.stringify(result, null, 2));

function must(v: string | undefined, name: string): string {
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}
