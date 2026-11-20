/** Conversation history in PostgreSQL (single-user educational mode: rows are scoped to the configured user). */
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { conversations, messages } from "../db/schema.ts";

export class ConversationStore {
  constructor(private db: Db) {}
  async start(userId: string, now = new Date()): Promise<number> {
    const [c] = await this.db.insert(conversations).values({ userId, createdAt: now }).returning({ id: conversations.id });
    return c!.id;
  }
  async add(userId: string, conversationId: number, role: "user" | "assistant", content: string, now = new Date()): Promise<number> {
    const [m] = await this.db.insert(messages).values({ userId, conversationId, role, content: content.slice(0, 20_000), createdAt: now }).returning({ id: messages.id });
    return m!.id;
  }
  async recent(userId: string, conversationId: number, limit = 20) {
    const rows = await this.db.select().from(messages)
      .where(and(eq(messages.userId, userId), eq(messages.conversationId, conversationId))).orderBy(desc(messages.id)).limit(limit);
    return rows.reverse();
  }
}
