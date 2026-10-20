# The dashboard server: Go standard library only, so the build needs no modules.
FROM golang:1.24-alpine AS builder
WORKDIR /src
COPY dashboard/go.mod ./
COPY dashboard/main.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /src/quai-dashboard .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=builder /src/quai-dashboard /usr/local/bin/quai-dashboard
COPY dashboard/index.html /opt/dashboard/index.html
COPY dashboard/fonts /opt/dashboard/fonts
RUN chmod +x /usr/local/bin/quai-dashboard
