// Server-only env vars (spec section 6). Validated lazily on first use, so
// `next build` doesn't need secrets, and fails fast at runtime when one is
// missing. Error messages name the variable and the problem, never the value.
import { z } from "zod";

const https = z.url({ protocol: /^https$/, hostname: /\./ });

// Not trimmed (the value must match the other side exactly), but surrounding
// whitespace is rejected: a pasted trailing newline would otherwise fail
// every signature silently.
const secret = (min: number) =>
  z
    .string()
    .min(min)
    .refine((v) => v === v.trim(), { message: "surrounding whitespace" });

const envSchema = z.object({
  SUPABASE_URL: https,
  SUPABASE_SERVICE_ROLE_KEY: secret(1),
  // An empty or short secret would let anyone forge signatures.
  WEBHOOK_SECRET: secret(32),
  SLACK_WEBHOOK_URL: https,
  CRON_SECRET: secret(16),
});

export type Env = Readonly<z.infer<typeof envSchema>>;

export class EnvError extends Error {
  override name = "EnvError";
}

/** Validates a given source. No caching; use `getEnv()` in app code. */
export function loadEnv(source: Readonly<Record<string, string | undefined>>): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => {
      const value = source[String(i.path[0])];
      const why = value === undefined || value === "" ? "missing" : i.code;
      return `${i.path.join(".")} (${why})`;
    });
    throw new EnvError(`invalid environment: ${problems.join(", ")}`);
  }
  return Object.freeze(parsed.data);
}

let cached: Env | undefined;

/** Validated env from `process.env`, cached after the first successful call. */
export function getEnv(): Env {
  cached ??= loadEnv(process.env);
  return cached;
}
