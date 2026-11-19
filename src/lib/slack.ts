// Slack Incoming Webhook client and message builders (spec section 5).
// The client never throws: failures are logged with [slack] and reported as
// `false`, so they can't change an HTTP response.
import type { Status } from "@/src/lib/creators/transitions";

export interface SlackClient {
  /** Resolves to whether Slack accepted the message. Never rejects. */
  send(text: string): Promise<boolean>;
}

export type Logger = Pick<Console, "error">;

export type SlackClientOptions = {
  webhookUrl: string;
  fetch?: typeof fetch;
  /** Keeps a slow Slack from holding the webhook response. */
  timeoutMs?: number;
  logger?: Logger;
};

export const DEFAULT_SLACK_TIMEOUT_MS = 3000;

export function createSlackClient(options: SlackClientOptions): SlackClient {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SLACK_TIMEOUT_MS;
  const logger = options.logger ?? console;

  return {
    async send(text) {
      try {
        const res = await doFetch(options.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        // Release the connection; the body itself isn't needed.
        await res.body?.cancel().catch(() => undefined);
        if (!res.ok) {
          // Never log the webhook URL (it is a secret) or the message (creator data).
          logger.error(`[slack] send failed: status ${res.status}`);
          return false;
        }
        return true;
      } catch (err) {
        // Only the error name: messages can include request details.
        logger.error(`[slack] send failed: ${err instanceof Error ? err.name : "unknown error"}`);
        return false;
      }
    },
  };
}

/**
 * Makes creator-provided text safe for Slack mrkdwn:
 * - control characters, line/paragraph separators and bidi overrides become
 *   spaces, so a name can't fake extra lines or visually reorder one;
 * - `& < >` are escaped, so it can't trigger mentions like `<!channel>`.
 * Zero-width joiners are kept so emoji sequences stay intact.
 */
export function escapeSlack(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]/gu, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const HOUR_MS = 3_600_000;

function rawHours(from: Date, to: Date): number {
  return Math.max(0, (to.getTime() - from.getTime()) / HOUR_MS);
}

/** Hours between two dates, clamped to 0, rounded to one decimal. */
export function hoursBetween(from: Date, to: Date): number {
  return Math.round(rawHours(from, to) * 10) / 10;
}

/** Whole hours between two dates, clamped to 0 (never rounded up). */
export function wholeHoursBetween(from: Date, to: Date): number {
  return Math.floor(rawHours(from, to));
}

/** Longest name or handle shown, in code points, before escaping. */
export const MAX_FIELD_CHARS = 80;

function truncate(text: string): string {
  const chars = Array.from(text); // code points, so surrogate pairs aren't split
  return chars.length <= MAX_FIELD_CHARS ? text : `${chars.slice(0, MAX_FIELD_CHARS).join("")}…`;
}

function nameWithHandle(name: string, handle: string | null): string {
  const h = handle === null ? "" : ` (${escapeSlack(truncate(handle))})`;
  return `*${escapeSlack(truncate(name))}*${h}`;
}

export type LiveMessageInput = {
  name: string;
  handle: string | null;
  onboardingStartedAt: Date;
  /** occurred_at of the event that made the creator live */
  liveAt: Date;
};

export function liveMessage(c: LiveMessageInput): string {
  const hours = hoursBetween(c.onboardingStartedAt, c.liveAt);
  return `:rocket: ${nameWithHandle(c.name, c.handle)} is live! Onboarding took ${hours}h.`;
}

export type StuckCreator = {
  name: string;
  handle: string | null;
  status: Exclude<Status, "live">;
  lastStepAt: Date;
};

/**
 * Lines after this are summarized. Worst case per line is two 80-char fields
 * escaped to 5x (`&` -> `&amp;`), about 850 chars, so 30 lines stay under
 * Slack's ~40k text limit.
 */
export const MAX_STUCK_LINES = 30;

export function stuckMessage(creators: readonly [StuckCreator, ...StuckCreator[]], now: Date): string {
  const lines = creators
    .slice(0, MAX_STUCK_LINES)
    .map(
      (c) =>
        `• ${nameWithHandle(c.name, c.handle)}: ${c.status}, stuck ${wholeHoursBetween(c.lastStepAt, now)}h`,
    );
  const rest = creators.length - MAX_STUCK_LINES;
  if (rest > 0) lines.push(`…and ${rest} more`);
  return [`:warning: ${creators.length} creator(s) stuck for 48h+`, ...lines].join("\n");
}
