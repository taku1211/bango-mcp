import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { VERSION } from "../src/version.js";

const read = (path: string) =>
  JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

// npm と公式 MCP Registry に出すときは4か所の version がそろっている必要がある（docs/PUBLISHING.md §5）。
describe("version", () => {
  it("matches across package.json, server.json and src/version.ts", () => {
    const pkg = read("package.json");
    const server = read("server.json");
    expect(pkg.version).toBe(VERSION);
    expect(server.version).toBe(VERSION);
    expect(server.packages[0].version).toBe(VERSION);
  });
});
