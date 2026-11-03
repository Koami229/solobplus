# Build context: polyglot/gateway-rust
FROM rust:1-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /src/target/release/solob-gateway /usr/local/bin/solob-gateway
USER nonroot:nonroot
EXPOSE 8100
ENV BIND_ADDR=0.0.0.0:8100
ENTRYPOINT ["/usr/local/bin/solob-gateway"]
