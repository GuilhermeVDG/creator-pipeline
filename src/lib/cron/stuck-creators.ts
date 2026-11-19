// GET /api/cron/stuck-creators (spec section 4). Built from a factory so tests
// can pass the in-memory repository, a fake Slack client and a fixed clock.
import { createHash, timingSafeEqual } from "node:crypto";
import {
  RepositoryError,
  UNEXPECTED_SHAPE,
  type ClaimedStuckCreator,
  type CreatorRepository,
} from "@/src/lib/creators/repository";
import { stuckMessage, type SlackClient } from "@/src/lib/slack";

export type CronLogger = Pick<Console, "info" | "error">;

export type CronDeps = {
  repository: CreatorRepository;
  slack: SlackClient;
  cronSecret: string;
  now: () => Date;
  logger: CronLogger;
};

const json = (status: number, body: Record<string, string | number>) => Response.json(body, { status });
const unauthorized = () => json(401, { error: "unauthorized" });
const internalError = () => json(500, { error: "internal error" });

/**
 * Timing-safe check of `Authorization: Bearer <secret>`. Both sides are hashed
 * first, so the comparison is always over equal lengths and doesn't reveal the
 * secret's length.
 */
export function isAuthorized(header: string | null, secret: string): boolean {
  if (header === null) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

/** At most this many ids per log line; the rest are counted. */
export const MAX_LOGGED_IDS = 20;

function logIds(claimed: readonly ClaimedStuckCreator[]): string {
  const shown = claimed.slice(0, MAX_LOGGED_IDS).map((c) => c.id).join(",");
  const more = claimed.length - MAX_LOGGED_IDS;
  return more > 0 ? `${shown} …+${more}` : shown;
}

export function createStuckCreatorsHandler(getDeps: () => CronDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    // Read request data first: with cacheComponents this keeps the GET handler
    // dynamic (never prerendered at build time, which has no secrets).
    const authorization = request.headers.get("authorization");

    let deps: CronDeps;
    try {
      deps = getDeps();
    } catch (err) {
      // Only EnvError messages are known to be safe (variable names, never values).
      const detail = err instanceof Error ? (err.name === "EnvError" ? err.message : err.name) : "unknown";
      console.error(`[cron] configuration error: ${detail}`);
      return internalError();
    }
    const { repository, slack, cronSecret, now, logger } = deps;

    try {
      if (!isAuthorized(authorization, cronSecret)) {
        logger.error("[cron] unauthorized");
        return unauthorized();
      }

      // One atomic claim: found and marked together, so overlapping runs can't double-alert.
      let claimed: ClaimedStuckCreator[];
      try {
        claimed = await repository.claimStuckCreators();
      } catch (err) {
        const code = err instanceof RepositoryError ? err.code : undefined;
        if (code === UNEXPECTED_SHAPE) {
          // The rows were already marked as alerted, so these alerts are lost.
          logger.error(`[cron] claimed but unparseable response (${UNEXPECTED_SHAPE}): alerts lost`);
        } else {
          logger.error(`[cron] database error: ${code ?? "unknown"}`);
        }
        return internalError();
      }

      const [first, ...rest] = claimed;
      if (first === undefined) {
        logger.info("[cron] no stuck creators");
        return json(200, { alerted: 0 });
      }

      const ids = logIds(claimed);
      let delivered = false;
      try {
        delivered = await slack.send(stuckMessage([first, ...rest], now()));
      } catch {
        delivered = false;
      }
      if (delivered) {
        logger.info(`[cron] alerted ${claimed.length} creator(s): ${ids}`);
      } else {
        // Already marked: no retry (spec section 4, known limitation).
        logger.error(`[cron] slack failed, ${claimed.length} alert(s) lost: ${ids}`);
      }
      return json(200, { alerted: claimed.length });
    } catch (err) {
      logger.error(`[cron] unexpected error: ${err instanceof Error ? err.name : "unknown"}`);
      return internalError();
    }
  };
}
