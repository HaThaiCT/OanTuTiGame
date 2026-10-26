FROM rust:1.99.1-slim-bookworm@sha256:f48da6dc0c99631cb89cc86b041e3ba8bc17dfab112e9ce85176d02cf220d660
RUN apt-get update && apt-get install -y --no-install-recommends protobuf-compiler && rm -rf /var/lib/apt/lists/*
