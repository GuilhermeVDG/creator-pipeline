import { describe, expect, it, vi } from "vitest";
import {
  MAX_FIELD_CHARS,
  MAX_STUCK_LINES,
  createSlackClient,
  escapeSlack,
  hoursBetween,
  liveMessage,
  stuckMessage,
  type StuckCreator,
} from "@/src/lib/slack";

const WEBHOOK_URL = "https://hooks.slack.com/services/TEST/TEST/test-path";
const T0 = new Date("2026-11-01T00:00:00Z");
const h = (hours: number) => new Date(T0.getTime() + hours * 3_600_000);

function setup(fetchImpl: typeof fetch, timeoutMs?: number) {
  const logger = { error: vi.fn<(msg: string) => void>() };
  const client = createSlackClient({
    webhookUrl: WEBHOOK_URL,
    fetch: fetchImpl,
    logger,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  const logged = () => logger.error.mock.calls.map((c) => c[0]).join("\n");
  return { client, logger, logged };
}

describe("createSlackClient: failures never throw", () => {
  it("non-2xx response: returns false and logs the status", async () => {
    const { client, logged } = setup(async () => new Response("invalid_payload", { status: 400 }));
    await expect(client.send("hello")).resolves.toBe(false);
    expect(logged()).toBe("[slack] send failed: status 400");
  });

  it("network error: returns false and logs only the error name", async () => {
    const { client, logged } = setup(async () => {
      throw new TypeError(`fetch failed for ${WEBHOOK_URL}`);
    });
    await expect(client.send("hello")).resolves.toBe(false);
    expect(logged()).toBe("[slack] send failed: TypeError");
  });

  it("non-Error rejection: returns false", async () => {
    const { client, logged } = setup(() => Promise.reject("boom"));
    await expect(client.send("hello")).resolves.toBe(false);
    expect(logged()).toBe("[slack] send failed: unknown error");
  });

  it("times out instead of hanging", async () => {
    const hanging: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const { client, logged } = setup(hanging, 20);
    await expect(client.send("hello")).resolves.toBe(false);
    expect(logged()).toBe("[slack] send failed: TimeoutError");
  });

  it("logs never include the webhook URL or the message", async () => {
    const { client, logged } = setup(async () => {
      throw new Error(`could not reach ${WEBHOOK_URL} with Ana Souza`);
    });
    await client.send("Ana Souza is live");
    expect(logged()).not.toContain("test-path");
    expect(logged()).not.toContain("Ana");
  });
});

describe("createSlackClient: success", () => {
  it("POSTs JSON { text } to the webhook URL and returns true", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok", { status: 200 }));
    const { client, logger } = setup(fetchMock);
    await expect(client.send("hello")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(WEBHOOK_URL);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({ text: "hello" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe("createSlackClient: releases the response body", () => {
  it.each([200, 500])("cancels the body on status %i", async (status) => {
    const cancel = vi.fn();
    const { client } = setup(async () => new Response(new ReadableStream({ cancel }), { status }));
    await client.send("hello");
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("escapeSlack", () => {
  it.each([
    ["<!channel>", "&lt;!channel&gt;"],
    ["<@U123>", "&lt;@U123&gt;"],
    ["<https://evil.example|click>", "&lt;https://evil.example|click&gt;"],
    ["Tom & Jerry", "Tom &amp; Jerry"],
    ["&lt;", "&amp;lt;"], // already-escaped text is escaped again, not passed through
    ["Ana\nfake line", "Ana fake line"],
    ["Ana\r\n\tSouza\u0007", "Ana   Souza "],
    ["José 🚀", "José 🚀"],
    ["Ana\u2028fake", "Ana fake"],
    ["Ana\u2029fake", "Ana fake"],
    ["\u202Eevil", " evil"],
    ["a\u2066b\u2069", "a b "],
    ["👩\u200D💻", "👩\u200D💻"], // ZWJ kept: emoji sequence intact
  ])("%j -> %j", (input, expected) => {
    expect(escapeSlack(input)).toBe(expected);
  });
});

describe("hoursBetween", () => {
  it("clamps negative durations to 0", () => {
    expect(hoursBetween(h(1), h(0))).toBe(0);
  });
  it("rounds to one decimal", () => {
    expect(hoursBetween(h(0), h(26.26))).toBe(26.3);
    expect(hoursBetween(h(0), h(0.5))).toBe(0.5);
  });
});

describe("liveMessage", () => {
  it("matches the spec format, with hours from onboardingStartedAt", () => {
    expect(
      liveMessage({ name: "Ana Souza", handle: "@anasouza", onboardingStartedAt: h(0), liveAt: h(26) }),
    ).toBe(":rocket: *Ana Souza* (@anasouza) is live! Onboarding took 26h.");
  });

  it("clamps to 0h when payment_done happened before signup", () => {
    expect(liveMessage({ name: "Ana", handle: "@ana", onboardingStartedAt: h(1), liveAt: h(0) })).toBe(
      ":rocket: *Ana* (@ana) is live! Onboarding took 0h.",
    );
  });

  it("escapes name and handle", () => {
    const text = liveMessage({ name: "<!channel>", handle: "@a&b\nX", onboardingStartedAt: h(0), liveAt: h(1) });
    expect(text).toBe(":rocket: *&lt;!channel&gt;* (@a&amp;b X) is live! Onboarding took 1h.");
  });

  it("omits the parentheses when there is no handle", () => {
    expect(liveMessage({ name: "Ana", handle: null, onboardingStartedAt: h(0), liveAt: h(2) })).toBe(
      ":rocket: *Ana* is live! Onboarding took 2h.",
    );
  });
});

describe("stuckMessage", () => {
  const ana: StuckCreator = { name: "Ana", handle: "@ana", status: "signed_up", lastStepAt: h(0) };
  const bo: StuckCreator = { name: "Bo <!here>", handle: null, status: "app_installed", lastStepAt: h(10) };

  it("header plus one line per creator, with a readable step and whole hours stuck", () => {
    expect(stuckMessage([ana, bo], h(60.9))).toBe(
      [
        ":warning: 2 creator(s) stuck for 48h+",
        "• *Ana* (@ana): signed up, stuck 60h",
        "• *Bo &lt;!here&gt;*: app installed, stuck 50h",
      ].join("\n"),
    );
  });

  it("whole hours are floored, never rounded up", () => {
    expect(stuckMessage([ana], h(59.96))).toContain("stuck 59h");
    expect(stuckMessage([ana], h(47.96))).toContain("stuck 47h");
  });

  it(`truncates names and handles to ${MAX_FIELD_CHARS} characters before escaping`, () => {
    const name = "&".repeat(200);
    const line = stuckMessage([{ ...ana, name, handle: "🚀".repeat(100) }], h(50)).split("\n")[1] ?? "";
    expect(line).toContain(`*${"&amp;".repeat(MAX_FIELD_CHARS)}…*`);
    expect(line).toContain(`(${"🚀".repeat(MAX_FIELD_CHARS)}…)`);
  });

  it("worst-case message stays under 40k characters", () => {
    const worst: StuckCreator = { ...ana, name: "&".repeat(200), handle: "<".repeat(100) };
    const text = stuckMessage([worst, ...Array.from({ length: 500 }, () => worst)], h(50));
    expect(text.length).toBeLessThan(40_000);
  });

  it("a newline in a name can't add a fake line", () => {
    const text = stuckMessage([{ ...ana, name: "Ana\n• *Fake* (@x): signed_up, stuck 99h" }], h(50));
    expect(text.split("\n")).toHaveLength(2);
  });

  it(`caps the list at ${MAX_STUCK_LINES} lines and counts the rest`, () => {
    const many = Array.from({ length: MAX_STUCK_LINES + 3 }, (_, i) => ({ ...ana, name: `C${i}` }));
    const lines = stuckMessage([ana, ...many.slice(1)], h(50)).split("\n");
    expect(lines[0]).toBe(`:warning: ${MAX_STUCK_LINES + 3} creator(s) stuck for 48h+`);
    expect(lines).toHaveLength(1 + MAX_STUCK_LINES + 1);
    expect(lines.at(-1)).toBe("…and 3 more");
  });
});
