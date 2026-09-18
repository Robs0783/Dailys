# Dailys

Shared daily-operations app for a two-location dealership group: task tracking, meetings, KPI metrics, training, and project planning, with per-store and per-employee views.

## Structure

- `server.js` — zero-dependency Node `http`/`fs` backend. Flat JSON key-value store persisted to a file on disk (Railway volume in production).
- `index.html` — Dealership Daily Ops. The main app: daily tasks, meetings, metrics dashboard/entry, training library, project planner, team targets.
- `mapper.html` — Task Workflow Mapper. Admin tool for configuring the task roster/cadence that drives `index.html`.

No build step, no framework, no npm dependencies. `node server.js` runs it.

## Data model

Everything is stored under string keys via `/api/state` (read) and per-key `GET`/`POST` endpoints. The client always `JSON.parse()`s each key's value after fetch.

Keys in `ADMIN_ONLY_KEYS` (see top of `server.js`) require an access code to write:
`roster`, `meetings`, `metrics`, `training`, `targets`.

Everything else is open-write by design. This is deliberate: definitions (what a metric is, what a meeting's action items are) are staff-gated, but an individual employee's own day-to-day entries against those definitions are not. That pattern shows up three times:

| Definitions (gated) | Entries (ungated) |
|---|---|
| `metrics` | `metric-entries:{metricId}` |
| Project Planner definitions | each project's step status |
| `meetings` (action item text/assignee/deadline) | `action-item-status` (done/notes per item id) |

If you add a new "staff defines it, an employee reports against it" feature, follow this split rather than adding a new field to a gated key.

## Access tiers

Three tiers, set via an access code checked against `/api/verify-access`: owner (full access, including Project Planner, Export/Import, and deleting Training content), manager (everything except Projects/Export/Import), employee (no code — their own store/day view only). Codes live in `server.js`, not in this repo's history — check with Rob or the Railway service variables for current values.

## Deploying

Hosted on Railway, connected directly to this repo's `main` branch — a push here triggers a redeploy automatically. No CI/tests currently configured; verify manually in the browser after deploy (there's no staging environment).

## Local development

```
node server.js
```

Serves on the port in `PORT` env var (defaults to a local port — check `server.js`). Data persists to a local JSON file; delete it to reset to empty state.
