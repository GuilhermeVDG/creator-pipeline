import { createStuckCreatorsHandler, type CronDeps } from "@/src/lib/cron/stuck-creators";
import { createSupabaseCreatorRepository } from "@/src/lib/creators/repository";
import { getEnv } from "@/src/lib/env";
import { createSlackClient } from "@/src/lib/slack";

// Built once per instance, on the first request (not at import, so the build
// doesn't need secrets). If env is invalid, nothing is cached and the request gets a 500.
let deps: CronDeps | undefined;

function getDeps(): CronDeps {
  if (deps === undefined) {
    const env = getEnv();
    deps = {
      repository: createSupabaseCreatorRepository(),
      slack: createSlackClient({ webhookUrl: env.SLACK_WEBHOOK_URL }),
      cronSecret: env.CRON_SECRET,
      now: () => new Date(),
      logger: console,
    };
  }
  return deps;
}

export const GET = createStuckCreatorsHandler(getDeps);

// Without this, Next answers HEAD with the GET handler, so a HEAD with a valid
// token would claim and alert without the caller seeing the result.
export function HEAD(): Response {
  return new Response(null, { status: 405, headers: { allow: "GET" } });
}
