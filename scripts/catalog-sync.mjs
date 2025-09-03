name: catalog-sync

on:
  workflow_dispatch: {}

permissions:
  contents: write   # allow this workflow to push commits

jobs:
  run:
    runs-on: ubuntu-latest

    # Make the token and sync settings available to the script
    env:
      GH_TOKEN: ${{ secrets.TEXTS_RW_TOKEN }}   # <-- uses your existing repo secret
      TEXTS_OWNER: Info1691
      TEXTS_REPO: Law-Texts-ui
      TEXTS_BRANCH: main
      TEXTS_BASE: https://texts.wwwbcb.org

    steps:
      - name: Checkout Law-Tools (this repo)
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Sync catalogs (update url_txt automatically)
        run: |
          if [ -z "${GH_TOKEN}" ]; then
            echo "GH_TOKEN is missing"; exit 1
          fi
          node scripts/catalog-sync.mjs
