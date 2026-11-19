// POST /api/webhooks/onboarding (spec section 1). Built from a factory so tests
// can pass the in-memory repository, a fake Slack client and a fixed clock.
import {
  RepositoryError,
  type CreatorRepository,
  type JsonValue,
  type ProcessResult,
} from "@/src/lib/creators/repository";
import { liveMessage, type SlackClient } from "@/src/lib/slack";
import { parseOnboardingEvent } from "@/src/lib/webhooks/schema";
import { verifySignature } from "@/src/lib/webhooks/signature";

export type OnboardingLogger = Pick<Console, "info" | "error">;

export type OnboardingDeps = {
  repository: CreatorRepository;
  slack: SlackClient;
  webhookSecret: string;
  now: () => Date;
  logger: OnboardingLogger;
};

/**
 * Postgres codes for text/jsonb the database can't store (e.g. NUL in an
 * ignored field): a 400, not a 500. Deliberately not 22P02: a bug in our own
 * SQL can raise it, and it must stay a 500 so the sender retries.
 */
const UNSTORABLE_INPUT_CODES = new Set(["22P05", "22021"]);

/** Our payload is tiny; anything bigger is rejected before it's read. */
export const MAX_BODY_BYTES = 64 * 1024;

const json = (status: number, body: Record<string, string>) => Response.json(body, { status });
const unauthorized = () => json(401, { error: "unauthorized" });
const invalidPayload = () => json(400, { error: "invalid payload" });
const internalError = () => json(500, { error: "internal error" });
const tooLarge = () => json(413, { error: "payload too large" });

/**
 * Reads the body as raw bytes, stopping as soon as it exceeds `max`
 * (returns null). Content-Length can be absent or wrong, so this is the real cap.
 */
async function readBodyCapped(request: Request, max: number): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * `getDeps` is called per request, so missing env becomes a 500 for that
 * request instead of crashing the module; the route caches the deps itself.
 */
export function createOnboardingHandler(getDeps: () => OnboardingDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    let deps: OnboardingDeps;
    try {
      deps = getDeps();
    } catch (err) {
      // Only EnvError messages are known to be safe (they name variables, never
      // values); anything else logs just its name. Checked by name to keep
      // env.ts (server-only) out of this module.
      const detail = err instanceof Error ? (err.name === "EnvError" ? err.message : err.name) : "unknown";
      console.error(`[onboarding] configuration error: ${detail}`);
      return internalError();
    }
    const { repository, slack, webhookSecret, now, logger } = deps;

    try {
      // 0. Size cap: a declared Content-Length over the cap is rejected before
      //    reading anything; the capped read covers absent or wrong headers.
      const declared = request.headers.get("content-length");
      if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_BODY_BYTES) {
        logger.error("[onboarding] payload too large: content-length");
        return tooLarge();
      }

      // 1. Raw bytes: the signature is over exactly what was sent.
      const rawBody = await readBodyCapped(request, MAX_BODY_BYTES);
      if (rawBody === null) {
        logger.error("[onboarding] payload too large: body");
        return tooLarge();
      }

      // 2. Signature and replay window, before any parsing. Same 401 for every
      //    reason; only the reason code is logged, never the header values.
      const check = verifySignature({
        rawBody,
        timestamp: request.headers.get("x-timestamp"),
        signature: request.headers.get("x-signature"),
        secret: webhookSecret,
        now: now(),
      });
      if (!check.ok) {
        logger.error(`[onboarding] signature rejected: ${check.reason}`);
        return unauthorized();
      }

      // 3. JSON and schema. Issues are field paths and codes, never values.
      let body: JsonValue;
      try {
        body = JSON.parse(utf8.decode(rawBody)) as JsonValue;
      } catch {
        logger.error("[onboarding] invalid payload: invalid_json");
        return invalidPayload();
      }
      const parsed = parseOnboardingEvent(body, now());
      if (!parsed.ok) {
        logger.error(`[onboarding] invalid payload: ${parsed.issues.join(", ")}`);
        return invalidPayload();
      }
      const { event } = parsed;
      // event_id is sender-controlled free text: JSON-quoted so newlines or
      // control characters can't forge log lines. creator_id and step are
      // already constrained by the schema.
      const ids = `event_id=${JSON.stringify(event.eventId)} creator_id=${event.creatorId} step=${event.step}`;

      // 4–5. Record and apply atomically.
      let result: ProcessResult;
      try {
        result = await repository.processEvent({ event, payload: body });
      } catch (err) {
        const code = err instanceof RepositoryError ? err.code : undefined;
        if (code !== undefined && UNSTORABLE_INPUT_CODES.has(code)) {
          logger.error(`[onboarding] invalid payload: unstorable (${code}) ${ids}`);
          return invalidPayload();
        }
        logger.error(`[onboarding] database error: ${code ?? "unknown"} ${ids}`);
        return internalError();
      }

      switch (result.result) {
        case "duplicate":
          logger.info(`[onboarding] duplicate ${ids}`);
          return json(200, { status: "duplicate" });
        case "pending":
          logger.info(`[onboarding] pending ${ids}`);
          return json(200, { status: "pending" });
        case "email_conflict":
          // Not retried by us; the sender gets a 409.
          logger.error(`[onboarding] email conflict ${ids}`);
          return json(409, { error: "email already in use" });
        case "processed":
          logger.info(`[onboarding] processed ${ids}${result.becameLive ? " became_live" : ""}`);
          // 6. Live message. The client never throws; the guard keeps a broken
          //    one from failing the response anyway.
          if (result.becameLive) {
            try {
              await slack.send(liveMessage(result.creator));
            } catch {
              logger.error(`[slack] send threw ${ids}`);
            }
          }
          return json(200, { status: "processed" });
      }
    } catch (err) {
      logger.error(`[onboarding] unexpected error: ${err instanceof Error ? err.name : "unknown"}`);
      return internalError();
    }
  };
}
