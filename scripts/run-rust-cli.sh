#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
PROFILE=${VORKER_RUST_PROFILE:-debug}
VORKER_BIN="$REPO_ROOT/target/rust/$PROFILE/vorker"

if [ -x "$VORKER_BIN" ]; then
  exec "$VORKER_BIN" "$@"
fi

if [ -f "${HOME:-}/.cargo/env" ]; then
  . "$HOME/.cargo/env"
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo not found. Install Rust or source ~/.cargo/env first." >&2
  exit 1
fi

echo "Building Vorker Rust runtime once..." >&2
(cd "$REPO_ROOT" && cargo build --quiet -p vorker-cli)
exec "$VORKER_BIN" "$@"
