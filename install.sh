#!/bin/sh
set -e

RED='\033[0;31m'
ORANGE='\033[0;33m'
GREEN='\033[0;32m'
NC='\033[0m'

echo ""
echo "  🔥 Installing torch..."
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "${RED}error:${NC} Node.js is required (v20+). Install from https://nodejs.org"
  exit 1
fi

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "${RED}error:${NC} Node.js 20+ required (detected v$(node -v))"
  exit 1
fi

npm install -g @agentcomputer/torch

echo ""
echo "  ${GREEN}✓${NC} torch installed"
echo ""
echo "  ${ORANGE}torch${NC} https://news.ycombinator.com"
echo ""
