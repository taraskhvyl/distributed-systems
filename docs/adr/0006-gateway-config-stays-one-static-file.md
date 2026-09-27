---
status: accepted
---

# The gateway config stays one static file

`infra/gateway/envoy.yaml` (~300 lines) mixes three jobs: the listener (TLS, filter chain),
the routes (hosts, headers, limits: the part edited most) and the clusters. Envoy's static
config has no includes. The supported way to split it is filesystem xDS: a small bootstrap
whose `dynamic_resources` point at `listener.yaml` (LDS), `routes.yaml` (RDS) and
`clusters.yaml` (CDS), which Envoy also promises to hot-reload.

We tried it (spike, Phase 3) and kept the single static file. Measured on Envoy 1.39,
Docker Desktop (macOS):

1. **`--mode validate` stops checking.** It only reads the bootstrap. A route to an
   unknown cluster, and unknown fields in each of the three files, all printed "OK". The
   pre-restart check in AGENTS.md would silently stop protecting us.
2. **Hot reload never fires.** Envoy reloads a file on an inotify `MOVED_TO` (the way a
   Kubernetes ConfigMap is swapped). Docker Desktop delivers host edits to the container
   as `CREATE`/`MODIFY` only, even for a real `mv`, so neither an in-place write nor an
   atomic replace was picked up. A restart is still needed.
3. **Mistakes become quiet at runtime.** Dynamic resources are lenient by default:
   - an unknown field is dropped with a warning (a misspelled `timeout: 0s` would silently
     fall back to 15 s and cut every SSE stream);
   - RDS doesn't check that a route's cluster exists: the gateway started, reported
     **healthy**, and answered `app.localhost` with 503.

   In the static file both are startup errors.

So the split traded three safety nets (validation, startup errors, a failing healthcheck)
for tidiness, and the promised benefit (no restart) doesn't exist on this setup.

## When to revisit

- The gateway gets a real control plane (Istio, Envoy Gateway, a Go xDS server): then
  config arrives over gRPC xDS, validated by the control plane, and this file goes away.
- Or on Linux/Kubernetes, where `MOVED_TO` does arrive: split it then, and add
  `--reject-unknown-dynamic-fields`, `validate_clusters: true` on the route config, and a
  validation step that starts a throwaway Envoy on the files (since validate mode won't).

Until then, readability comes from comments and YAML anchors inside the one file.
