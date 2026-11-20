import { serve } from "@hono/node-server";

import { DEFAULT_BASE_URL } from "../client.js";
import { AccountGateway } from "./account.js";
import { createRemoteApp } from "./app.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`[bango-mcp-remote] 環境変数 ${name} が未設定です。`);
    process.exit(1);
  }
  return value;
}

const bangoApiBaseUrl = process.env.BANGO_API_BASE_URL?.trim() || DEFAULT_BASE_URL;

const app = createRemoteApp({
  publicUrl: required("MCP_PUBLIC_URL"),
  tokenSecret: required("MCP_TOKEN_SECRET"),
  bangoApiBaseUrl,
  googleLoginEnabled: process.env.MCP_GOOGLE_LOGIN === "1",
  account: new AccountGateway({
    supabaseUrl: required("SUPABASE_URL"),
    supabaseAnonKey: required("SUPABASE_ANON_KEY"),
    bangoApiBaseUrl,
  }),
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
  console.log(`[bango-mcp-remote] listening on :${info.port}`);
});
