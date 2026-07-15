#!/usr/bin/env bash
set -Eeuo pipefail

# Compatibility entrypoint: current production runs on Kubernetes.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
exec bash "$ROOT/scripts/k8s-update.sh" "$@"
