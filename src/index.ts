#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { BangoClient } from "./client.js";
import { createServer } from "./server.js";
import { VERSION } from "./version.js";

const arg = process.argv[2];
if (arg === "--version" || arg === "-v") {
  console.log(VERSION);
  process.exit(0);
}

const client = new BangoClient({
  apiKey: process.env.BANGO_API_KEY,
  baseUrl: process.env.BANGO_API_BASE_URL,
});
const server = createServer({ client });

await server.connect(new StdioServerTransport());
if (!process.env.BANGO_API_KEY) {
  // stdout はプロトコル用なので、案内は stderr に出す
  console.error("[bango-mcp] BANGO_API_KEY が未設定です。https://bango-api.jp/signup で無料のAPIキーを取得してください。");
}
