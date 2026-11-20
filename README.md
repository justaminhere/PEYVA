# PEYVA (پیوا)

An AI-native Persian personal agent for Iranian online services. The first vertical slice is travel: it builds a trip goal in conversation, searches MrBilit read-only, compares options deterministically and monitors prices in the background. This is an educational project (Bozhan course). It runs in single-user mode, with no booking, no payment and no public deployment.

## Quick start

```bash
bun install
cp .env.example .env            # LLM settings; PEYVA_DATABASE_URL for memory and monitoring
bun run db:start                # embedded PostgreSQL (keep running); prints PEYVA_DATABASE_URL
bun run peyva:chat              # chat (Persian)
bun run peyva:worker            # background monitoring worker (separate terminal)
bun run peyva:goals help        # goals, notifications, preferences and Telegram without the LLM
bun run test && bun run typecheck
```

## Docs

- `docs/TRAVEL_MCP_FEASIBILITY.md`, `docs/TRAVEL_MCP_READINESS.md`: Phase 1 / 1.5 provider research
- `docs/PHASE2A_AGENT_CORE.md`, `docs/LLM_TOKEN_BUDGET.md`: agent core and token diet
- `docs/PHASE3_PERSISTENT_AGENT.md`: memory, goals, worker and notifications
