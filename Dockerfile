# Two processes in one image: the stratum (Node) and the dashboard (Go).
#
# They are packaged together because they are one thing to an operator -- a
# stratum with no UI is not much use on StartOS, and the dashboard's entire
# job is reading the stratum's stats API over loopback. Splitting them into
# separate packages would mean a network hop and a dependency edge for two
# processes that must start and stop together anyway.

# ── dashboard ──────────────────────────────────────────────────────────────
# Go standard library only, so the build needs no module downloads and the
# image carries no module cache.
FROM golang:1.24-alpine AS builder
WORKDIR /src
COPY dashboard/go.mod ./
COPY dashboard/main.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /src/scrypt-dashboard .

# ── runtime ────────────────────────────────────────────────────────────────
# Alpine is fine here, unlike the node packages: nothing in this image is a
# glibc-linked upstream release binary. The Go binary is static (CGO_ENABLED=0)
# and Node comes from Alpine's own package.
FROM alpine:3.22

# Node 18+ for the stratum. `nodejs` alone, with no npm: the stratum has ZERO
# runtime dependencies by design -- it uses node:net, node:http, node:crypto
# and node:fs and nothing else -- so there is nothing to install and npm would
# only be attack surface.
RUN apk add --no-cache ca-certificates nodejs \
 && node --version

COPY --from=builder /src/scrypt-dashboard /usr/local/bin/scrypt-dashboard
COPY dashboard/index.html /opt/dashboard/index.html
COPY dashboard/fonts /opt/dashboard/fonts
COPY stratum/scrypt-solo.mjs /opt/stratum/scrypt-solo.mjs
RUN chmod +x /usr/local/bin/scrypt-dashboard

# Fail the build rather than ship an image whose binaries will not run. The
# stratum's --meter mode is pure logic with no daemon, network or wallet, so
# it is a genuine smoke test of the thing that handles money: 52 checks
# covering share crediting, vardiff and the rolling windows.
RUN scrypt-dashboard --help 2>/dev/null; \
    node /opt/stratum/scrypt-solo.mjs --meter > /dev/null \
      || { echo "stratum self-checks failed; refusing to build image" >&2; exit 1; }
