/**
 * PEYVA persistent model (Phase 3). PostgreSQL via Drizzle. All timestamps are timestamptz (stored in UTC).
 * No credentials or secrets are stored in goal records; the Telegram bot token lives only in the environment.
 */
import { sql } from "drizzle-orm";
import { bigint, bigserial, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const conversations = pgTable("conversations", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  createdAt: ts("created_at").notNull().defaultNow(),
  /** Structured working state of the agent session (versioned snapshot), so a restarted server can resume. */
  state: jsonb("state"),
  updatedAt: ts("updated_at"),
}, (t) => [index("conversations_user_idx").on(t.userId)]);

export const messages = pgTable("messages", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  conversationId: bigint("conversation_id", { mode: "number" }).notNull().references(() => conversations.id),
  userId: text("user_id").notNull().references(() => users.id),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [index("messages_conversation_idx").on(t.conversationId), check("messages_role_ck", sql`${t.role} in ('user','assistant')`)]);

export const preferences = pgTable("preferences", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  key: text("key").notNull(),
  value: jsonb("value").notNull(),
  confirmedAt: ts("confirmed_at").notNull(),
  sourceMessageId: bigint("source_message_id", { mode: "number" }).references(() => messages.id),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("preferences_user_key_uq").on(t.userId, t.key)]);

export const GOAL_STATUSES = ["draft", "active", "paused", "canceled", "expired"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const goals = pgTable("goals", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  type: text("type").notNull(),
  name: text("name").notNull(),
  structuredConstraints: jsonb("structured_constraints").notNull(),
  /** sha256 of the canonical constraints; approval binds to it, so any material edit needs a new approval. */
  constraintsHash: text("constraints_hash").notNull(),
  approvedConstraintsHash: text("approved_constraints_hash"),
  status: text("status").$type<GoalStatus>().notNull(),
  approvedAt: ts("approved_at"),
  nextCheckAt: ts("next_check_at"),
  lastCheckedAt: ts("last_checked_at"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  /** Execution lease: which worker holds the goal, and until when. An expired lease can be reclaimed (crash recovery). */
  claimedBy: text("claimed_by"),
  claimExpiresAt: ts("claim_expires_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
  /** A change the user asked for but has not approved yet. The approved conditions above stay in force meanwhile. */
  proposedConstraints: jsonb("proposed_constraints"),
  proposedHash: text("proposed_hash"),
  proposedAt: ts("proposed_at"),
}, (t) => [
  index("goals_due_idx").on(t.status, t.nextCheckAt),
  index("goals_user_idx").on(t.userId),
  check("goals_status_ck", sql`${t.status} in ('draft','active','paused','canceled','expired')`),
  check("goals_active_approved_ck", sql`${t.status} <> 'active' or (${t.approvedConstraintsHash} = ${t.constraintsHash} and ${t.approvedAt} is not null)`),
]);

export const CHECK_STATUSES = ["MATCH_FOUND", "NO_MATCH", "INCOMPLETE_DATA", "PROVIDER_ERROR"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export const goalChecks = pgTable("goal_checks", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  goalId: bigint("goal_id", { mode: "number" }).notNull().references(() => goals.id),
  provider: text("provider").notNull(),
  status: text("status").$type<CheckStatus>().notNull(),
  checkedAt: ts("checked_at").notNull(),
  /** Minimal summary (best option ids, totals, counts). Raw provider responses are not stored. */
  resultSummary: jsonb("result_summary"),
  errorReason: text("error_reason"),
  workerId: text("worker_id"),
  durationMs: integer("duration_ms"),
}, (t) => [index("goal_checks_goal_idx").on(t.goalId, t.checkedAt),
  check("goal_checks_status_ck", sql`${t.status} in ('MATCH_FOUND','NO_MATCH','INCOMPLETE_DATA','PROVIDER_ERROR')`)]);

export const DELIVERY_STATUSES = ["stored", "read", "pending", "sending", "retrying", "sent", "failed", "unknown"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const notifications = pgTable("notifications", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  goalId: bigint("goal_id", { mode: "number" }).references(() => goals.id),
  type: text("type").notNull(),
  channel: text("channel").notNull(),
  payload: jsonb("payload").notNull(),
  deliveryStatus: text("delivery_status").$type<DeliveryStatus>().notNull(),
  /** Unique per channel: the same result can never be queued twice for the same channel. */
  deduplicationKey: text("deduplication_key").notNull(),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: ts("next_attempt_at"),
  lastError: text("last_error"),
  createdAt: ts("created_at").notNull().defaultNow(),
  deliveredAt: ts("delivered_at"),
}, (t) => [uniqueIndex("notifications_dedup_uq").on(t.deduplicationKey), index("notifications_user_idx").on(t.userId, t.createdAt),
  index("notifications_outbox_idx").on(t.channel, t.deliveryStatus, t.nextAttemptAt),
  check("notifications_channel_ck", sql`${t.channel} in ('in_app','telegram')`),
  check("notifications_status_ck", sql`${t.deliveryStatus} in ('stored','read','pending','sending','retrying','sent','failed','unknown')`)]);

/** A Telegram chat is linked only after the user sent the one-time code to the bot (verified bot interaction). */
export const telegramLinks = pgTable("telegram_links", {
  userId: text("user_id").primaryKey().references(() => users.id),
  chatId: bigint("chat_id", { mode: "number" }).notNull(),
  verifiedAt: ts("verified_at").notNull(),
});

export const telegramLinkCodes = pgTable("telegram_link_codes", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  /** sha256 of the one-time code; the code itself is never stored. */
  codeHash: text("code_hash").notNull(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

/** Small key/value state, e.g. the Telegram getUpdates offset. */
export const appState = pgTable("app_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/**
 * Spend-control counters that must survive a restart. `period` is a UTC day (YYYY-MM-DD) or month (YYYY-MM);
 * `key` is `tokens`, `turn:<visitor>` or `search:<visitor>`. No IP addresses are stored here.
 */
export const usageCounters = pgTable("usage_counters", {
  period: text("period").notNull(),
  key: text("key").notNull(),
  n: bigint("n", { mode: "number" }).notNull().default(0),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("usage_counters_period_key").on(t.period, t.key)]);
