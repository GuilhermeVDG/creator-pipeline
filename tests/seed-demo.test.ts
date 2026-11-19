// Runs the seed-demo and send-test-webhook skill scripts against the real
// webhook handler (in-memory repository, fake Slack) over local HTTP.
// Offline: a dummy secret is passed in the environment; .env.local is never loaded.
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryCreatorRepository } from "@/src/lib/creators/repository";
import { createOnboardingHandler } from "@/src/lib/webhooks/handler";

const SECRET = "d".repeat(32);
const SEED = ".claude/skills/seed-demo/seed.mjs";
const SEND = ".claude/skills/send-test-webhook/send.mjs";

/** Minimal env for the scripts: no inherited secrets, no .env.local. */
function childEnv(secret: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "", NODE_ENV: "test", WEBHOOK_SECRET: secret };
}

let repo: InMemoryCreatorRepository;
let sent: string[];
let server: Server;
let origin: string;

function run(script: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: childEnv(SECRET),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

beforeAll(async () => {
  repo = new InMemoryCreatorRepository();
  sent = [];
  const handler = createOnboardingHandler(() => ({
    repository: repo,
    slack: { send: async (text: string) => (sent.push(text), true) },
    webhookSecret: SECRET,
    now: () => new Date(),
    logger: { info: () => undefined, error: () => undefined },
  }));
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const request = new Request(`http://127.0.0.1${req.url ?? "/"}`, {
        method: req.method ?? "GET",
        headers,
        body: new Uint8Array(Buffer.concat(chunks)),
      });
      void handler(request).then(async (response) => {
        res.writeHead(response.status, { "content-type": "application/json" });
        res.end(Buffer.from(await response.arrayBuffer()));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("seed-demo", { timeout: 30_000 }, () => {
  it("requires --url", async () => {
    const r = await run(SEED, []);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Usage");
  });

  it("seeds 9 creators through the webhook: 3 live messages, 4 stuck, 2 recent", async () => {
    const r = await run(SEED, ["--url", origin]); // bare origin: the webhook path is added
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);

    const events = repo.getEvents();
    expect(events).toHaveLength(18); // 3 live x 3 steps + stuck 1+2+1+2 + recent 1+2
    expect(events.every((e) => e.eventId.startsWith("evt_demo_"))).toBe(true);

    // Live messages with realistic durations (18h to 3 days).
    expect(sent).toEqual([
      ":rocket: *Lucas Ferreira* (@lucasferreira) is live! Onboarding took 19h.",
      ":rocket: *Mariana Costa* (@mari.costa) is live! Onboarding took 41h.",
      ":rocket: *Rafael Oliveira* (@rafaoliveira) is live! Onboarding took 68h.",
    ]);

    // The cron would alert exactly the 4 stuck creators, longest stuck first; not the 2 recent ones.
    const claimed = await repo.claimStuckCreators();
    expect(claimed.map((c) => [c.name, c.status])).toEqual([
      ["Pedro Henrique Lima", "app_installed"],
      ["Thiago Almeida", "signed_up"],
      ["Camila Rocha", "app_installed"],
      ["Beatriz Santos", "signed_up"],
    ]);

    expect(repo.getCreator("dec0de00-0000-4000-8000-000000000008")).toMatchObject({ status: "signed_up" });
    expect(repo.getCreator("dec0de00-0000-4000-8000-000000000009")).toMatchObject({ status: "app_installed" });
    expect(repo.getCreator("dec0de00-0000-4000-8000-000000000007")).toMatchObject({
      email: "pedro.henrique.lima@example.com",
      handle: "@pedrohlima",
    });

    // Summary and cleanup SQL that only touches evt_demo_ data.
    expect(r.stdout).toContain("Seeded 9 demo creators");
    expect(r.stdout).toContain("Next cron run should alert 4 creator(s), longest stuck first: Pedro Henrique Lima, Thiago Almeida, Camila Rocha, Beatriz Santos.");
    expect(r.stdout).toContain(
      "delete from public.creators where id in (select creator_id from public.webhook_events where starts_with(event_id, 'evt_demo_'));",
    );
    expect(r.stdout).toContain("delete from public.webhook_events where starts_with(event_id, 'evt_demo_');");
  });

  it("re-running without cleanup is safe: every event is a duplicate and nothing is resent", async () => {
    const before = repo.getEvents().length;
    const r = await run(SEED, ["--url", `${origin}/api/webhooks/onboarding`]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain(":processed");
    expect(r.stdout.match(/:duplicate/g)).toHaveLength(18);
    expect(repo.getEvents()).toHaveLength(before);
    expect(sent).toHaveLength(3);
  });

  it("fails loudly when the server rejects the events", async () => {
    const child = spawn(process.execPath, [SEED, "--url", origin], {
      env: childEnv("x".repeat(32)), // wrong secret: 401
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const code = await new Promise((resolve) => child.on("close", resolve));
    expect(code).toBe(1);
    expect(stderr).toContain("did not return 200");
  });
});

describe("send-test-webhook (after moving signing into webhook.mjs)", { timeout: 30_000 }, () => {
  it("signup is processed", async () => {
    const r = await run(SEND, ["--step", "signup", "--url", `${origin}/api/webhooks/onboarding`]);
    expect(r.stdout).toContain("status:  200");
    expect(r.stdout).toContain('"status":"processed"');
  });

  it.each([["--bad-signature"], ["--old"]])("%s is rejected with 401", async (flag) => {
    const r = await run(SEND, ["--step", "signup", flag, "--url", `${origin}/api/webhooks/onboarding`]);
    expect(r.stdout).toContain("status:  401");
  });
});
