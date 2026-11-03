# Build context: repository root (the gateway embeds ../../../db/migrations/*.sql at compile time).
#   docker build -f polyglot/gateway-rust/Dockerfile .
# Base images pinned by digest (resolved 2026-10-31); bump deliberately, e.g. via Dependabot docker updates.
FROM rust:1-bookworm@sha256:9181b56c2a21ab1d5e73cffe04fc762426d30aa7fac3c91141dd033f49a7fc8b AS build
WORKDIR /src
COPY db/migrations ./db/migrations
COPY polyglot/gateway-rust/Cargo.toml polyglot/gateway-rust/Cargo.lock ./polyglot/gateway-rust/
COPY polyglot/gateway-rust/src ./polyglot/gateway-rust/src
WORKDIR /src/polyglot/gateway-rust
RUN cargo build --release --locked

FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f
COPY --from=build /src/polyglot/gateway-rust/target/release/solob-gateway /usr/local/bin/solob-gateway
USER nonroot:nonroot
EXPOSE 8100
ENV BIND_ADDR=0.0.0.0:8100
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 CMD ["/usr/local/bin/solob-gateway","healthcheck"]
ENTRYPOINT ["/usr/local/bin/solob-gateway"]
