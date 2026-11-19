// Guards that modules holding secrets keep their `server-only` import, so a
// client import fails the Next build instead of shipping them to the browser.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SERVER_ONLY_MODULES = ["src/lib/env.ts", "src/lib/creators/repository.ts"];

describe("server-only modules", () => {
  it.each(SERVER_ONLY_MODULES)("%s imports server-only", (path) => {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    expect(source).toMatch(/^import "server-only";$/m);
  });
});
