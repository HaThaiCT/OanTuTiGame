#!/usr/bin/env bash
# Build reviewed commissioning inputs as the invoking user, never as root.
set -euo pipefail
[[ $EUID != 0 ]] || { echo 'Run preparation as your normal user, without sudo.' >&2; exit 1; }
repo=$(realpath -- "$(dirname -- "$0")/../..")
image_file=$(mktemp)
trap 'rm -f -- "$image_file"' EXIT
docker build --iidfile "$image_file" --file "$repo/deploy/linux/native-build.Dockerfile" "$repo/deploy/linux"
image=$(cat "$image_file")
[[ -n $image ]] || { echo 'Docker build returned no image identity.' >&2; exit 1; }
docker run --rm --user "$(id -u):$(id -g)" --env CARGO_HOME=/tmp/cargo --mount "type=bind,src=$repo,dst=/work" --workdir /work "$image" cargo build --release --locked -p arena-supervisor --bin arena-job-broker --bin arena-worker --bin arena-reaper
bash "$repo/deploy/linux/operator-commission-worker.sh" --check-inputs
