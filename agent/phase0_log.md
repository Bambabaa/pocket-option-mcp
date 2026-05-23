# Phase 0 — Research Log

Append-only session log. Each entry records: task run, key findings, decision for next task.

---

## Session 1 — 2026-05-22

### R.0 — Database setup (complete)

- Created `agent/data/phase0_research.db` via `VACUUM INTO` from live `agent.db`
- File size: 304 MB
- `PRAGMA integrity_check` → **ok**

**Row counts in `phase0_research.db`:**
| Table | Rows | Time span (unix) |
|---|---|---|
| candles | 28,505 | 1779305100 → 1779511200 (≈ 57.25 h) |
| indicators | 28,428 | 1779305400 → 1779511200 |
| prices | 3,975,721 | 1779334977 → 1779511734 |
| agent_orders | 0 | — |
| agent_log | 0 | — |

Distinct assets: **77** (mix of OTC and non-OTC forex).

**Deviation flagged:** `phase0-agent.md` line 112 states the `prices` table is empty. It is not — 3.97M tick rows exist. This means R.4 (1m-filter improvement test) is potentially runnable if R.3 produces a survivor; not auto-skipped as the prompt assumed. Decision deferred until R.3 completes.

**Next:** Build and run R.1 — signal capture using the fixed 24-gate inventory, 3-bar independence rule, 70/30 chronological train/test fold per asset. Pending user confirmation before code is written.

---
