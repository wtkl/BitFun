#!/usr/bin/env bash
# BitFun Relay Server — one-click deploy script.
# Usage:  bash deploy.sh [--build-mobile] [--skip-build] [--skip-health-check]
#
# Prerequisites: Docker, Docker Compose

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

BUILD_MOBILE=false
SKIP_BUILD=false
SKIP_HEALTH_CHECK=false

usage() {
  cat <<'EOF'
BitFun Relay Server deploy script

Usage:
  bash deploy.sh [options]

Options:
  --build-mobile       Build mobile-web static files before deploy
  --skip-build         Skip docker compose build, only restart services
  --skip-health-check  Skip post-deploy health check
  -h, --help           Show this help message
EOF
}

check_command() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: '$cmd' is required but not installed."
    exit 1
  fi
}

check_docker_compose() {
  if docker compose version >/dev/null 2>&1; then
    return 0
  fi
  echo "Error: Docker Compose (docker compose) is required."
  exit 1
}

for arg in "$@"; do
  case "$arg" in
    --build-mobile) BUILD_MOBILE=true ;;
    --skip-build) SKIP_BUILD=true ;;
    --skip-health-check) SKIP_HEALTH_CHECK=true ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $arg"
      usage
      exit 1
      ;;
  esac
done

echo "=== BitFun Relay Server Deploy ==="
check_command docker
check_docker_compose

# Build mobile web static files if requested
if [ "$BUILD_MOBILE" = true ] && [ -d "$PROJECT_ROOT/src/mobile-web" ]; then
  check_command npm
  echo "[1/3] Building mobile web client..."
  cd "$PROJECT_ROOT/src/mobile-web"
  npm ci
  npm run build
  mkdir -p "$SCRIPT_DIR/static"
  cp -r dist/* "$SCRIPT_DIR/static/"
  cd "$SCRIPT_DIR"
  echo "  Mobile web built → $SCRIPT_DIR/static/"
else
  echo "[1/3] Skipping mobile web build (use --build-mobile to include)"
fi

# Build and start containers
cd "$SCRIPT_DIR"
if [ "$SKIP_BUILD" = true ]; then
  echo "[2/3] Skipping Docker build (--skip-build)"
else
  echo "[2/3] Building Docker images..."
  docker compose build
fi

echo "[3/3] Starting services..."
docker compose up -d

if [ "$SKIP_HEALTH_CHECK" = false ]; then
  echo "Checking relay health endpoint..."
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS --max-time 8 "http://127.0.0.1:9700/health" >/dev/null; then
      echo "Health check passed: http://127.0.0.1:9700/health"
    else
      echo "Warning: health check failed. Check logs below."
    fi
  else
    echo "Warning: 'curl' not found, skipped health check."
  fi
fi

echo ""
echo "=== Deploy complete ==="
echo "Relay server running on port 9700"
echo "Caddy proxy on ports 80/443"
echo ""
echo "Custom Server URL examples for BitFun Desktop:"
echo "  - Direct relay:        http://<YOUR_SERVER_IP>:9700"
echo "  - Reverse proxy root:  https://<YOUR_DOMAIN>"
echo "  - Reverse proxy /relay:https://<YOUR_DOMAIN>/relay  (if you configured path prefix)"
echo ""
echo "Check status:  docker compose ps"
echo "View logs:     docker compose logs -f relay-server"
echo "Stop:          docker compose down"
