# Updating

This package has no upstream: the dashboard and its collector are maintained here.

## When the node package changes

If go-quai-startos renames a host id, a port or a health check id, update `startos/utils.ts` and `startos/dependencies.ts` to match, and raise `versionRange` to the node version that introduced the change.

## When go-quai changes its stratum API

The collector reads `/api/pool/stats`, `/api/pool/workers`, `/api/pool/shares` and `/api/pool/blocks`, plus `quai_getMiningInfo` over RPC. Check those shapes against the tag the node package pins:

```sh
git diff <old-tag> <new-tag> -- stratum/ internal/quaiapi/quai_api.go
```
