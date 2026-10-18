#!/usr/bin/env bash
set -euo pipefail
root=$(dirname "$(dirname "$(dirname "$(realpath "$0")")")")
cd "$root"
: "${PROTOC:?Set PROTOC to the pinned protoc 36.2 executable}"
"$PROTOC" --plugin=protoc-gen-ts_proto=node_modules/.bin/protoc-gen-ts_proto \
  --ts_proto_out=packages/protocol/src \
  --ts_proto_opt=forceLong=string,oneof=unions,outputJsonMethods=false,outputClientImpl=false,esModuleInterop=true,importSuffix=.js \
  --proto_path=packages/protocol/proto packages/protocol/proto/execution.proto
