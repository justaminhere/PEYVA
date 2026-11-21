/** Shared runtime setup for the CLIs: database, services, travel provider, single-user educational mode. */
import { connect, databaseUrlFromEnv, ensureUser, migrateDb, redactUrl, type DbHandle } from "../db/client.ts";
import { GoalService, type GoalLimits } from "../goals/service.ts";
import { ExecutorRegistry } from "../goals/types.ts";
import { makeTravelPriceExecutor } from "../goals/travel.ts";
import { PreferenceStore } from "../memory/preferences.ts";
import { NotificationService, TelegramLinker } from "../notify/service.ts";
import { telegramFromEnv } from "../notify/telegram.ts";
import { McpTravelProvider, type TravelSearchProvider } from "../travel/index.ts";
import type { CommandContext } from "./commands.ts";

/** Single-user educational mode: no authentication; every row belongs to this id. */
export const userIdFromEnv = () => (process.env.PEYVA_USER_ID?.trim() || "local").slice(0, 40);

export interface Runtime extends CommandContext { db: DbHandle; provider: TravelSearchProvider; dbLabel: string; telegramEnabled: boolean; close: () => Promise<void> }

export async function openRuntime(opts: { goalLimits?: GoalLimits; onProviderCall?: Parameters<typeof McpTravelProvider.create>[1] extends infer O ? O extends { onCall?: infer C } ? C : never : never } = {}): Promise<Runtime | null> {
  const url = databaseUrlFromEnv();
  if (!url) return null;
  const db = connect(url, { max: 4 });
  try {
    await migrateDb(db.db); // idempotent
  } catch (e) {
    await db.close().catch(() => {});
    const cause = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message.slice(0, 120);
    console.error(`PostgreSQL در ${redactUrl(url)} در دسترس نیست (${cause}). آیا \`bun run db:start\` در ترمینال دیگری در حال اجراست؟`);
    process.exit(2);
  }
  const userId = userIdFromEnv();
  await ensureUser(db.db, userId);
  const provider = McpTravelProvider.create("mrbilit", { onCall: opts.onProviderCall });
  const registry = new ExecutorRegistry().register(makeTravelPriceExecutor(provider));
  const tg = telegramFromEnv();
  return {
    db, provider, registry, userId, dbLabel: redactUrl(url), telegramEnabled: !!tg,
    goals: new GoalService(db.db, registry, opts.goalLimits), prefs: new PreferenceStore(db.db), notifications: new NotificationService(db.db, tg),
    linker: tg ? new TelegramLinker(db.db, tg) : null,
    close: async () => { await provider.close(); await db.close(); },
  };
}
