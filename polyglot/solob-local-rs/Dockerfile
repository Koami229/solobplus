# solob-local — serveur d'inférence EXPÉRIMENTAL (Rust/candle, CPU). Contexte de build : racine du dépôt.
#   docker build -f polyglot/solob-local-rs/Dockerfile -t solob-plus/solob-local:local .
# Les poids NE SONT PAS dans l'image : monter le dossier exporté par tools/export_weights.py en lecture seule sur /models.
# Images de base épinglées par digest (mêmes que la passerelle).
FROM rust:1-bookworm@sha256:9181b56c2a21ab1d5e73cffe04fc762426d30aa7fac3c91141dd033f49a7fc8b AS build
RUN apt-get update && apt-get install -y --no-install-recommends cmake && rm -rf /var/lib/apt/lists/*
WORKDIR /src/polyglot/solob-local-rs
COPY polyglot/solob-local-rs/Cargo.toml polyglot/solob-local-rs/Cargo.lock ./
COPY polyglot/solob-local-rs/src ./src
RUN cargo build --release --locked --bin solob-local

FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f
COPY --from=build /src/polyglot/solob-local-rs/target/release/solob-local /usr/local/bin/solob-local
USER nonroot:nonroot
# Désactivé par défaut : SOLOB_LOCAL_SERVE doit être mis à 1 explicitement. Boucle locale uniquement.
ENV SOLOB_LOCAL_BIND=127.0.0.1:8300 SOLOB_LOCAL_MODEL_DIR=/models
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 CMD ["/usr/local/bin/solob-local","healthcheck"]
ENTRYPOINT ["/usr/local/bin/solob-local"]
