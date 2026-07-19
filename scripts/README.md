# Scripts

| Path | Role |
|------|------|
| `start.ts` / `production.ts` | Runtime entry (via `etteum` CLI) |
| `doctor.ts` / `preflight.ts` | Health / install checks |
| `serve-dashboard.ts` | Dashboard static server |
| `auth/` | Browser login automation |
| `grok-farm/` | HTTP farm package |
| `legacy/` | Deprecated CLIs (`aiproxy`, `poolprox`) + systemd unit |
| `scratch/` | One-off probes (not product) |

Prefer unit tests under `src/**/*.test.ts` and `test/`.
