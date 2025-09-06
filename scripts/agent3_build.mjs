# .github/workflows/agent3-build.yml
name: Agent3 Build (BM25/Lunr)

on:
  workflow_dispatch:
  push:
    paths:
      - 'Law-Tools/scripts/agent3-build.mjs'
      - 'data/**'
      - 'Law-Tools/**'

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Sanity: show tree (top level)
        run: ls -la && echo && ls -la Law-Tools || true

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install deps
        run: |
          npm init -y >/dev/null 2>&1 || true
          npm install lunr

      - name: Build Agent3 index (cd into Law-Tools)
        working-directory: Law-Tools
        run: |
          test -f scripts/agent3-build.mjs || (echo "Missing: Law-Tools/scripts/agent3-build.mjs" && exit 1)
          node scripts/agent3-build.mjs \
            --src ../data \
            --out ../agent3-bm25 \
            --base https://texts.wwwbcb.org/data \
            --lines 12 \
            --step 6

      - name: Commit outputs
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add agent3-bm25/*
          git commit -m "agent3-bm25: rebuild $(date -u +'%Y-%m-%dT%H:%M:%SZ')" || echo "No changes"
          git push
