#!/usr/bin/env bash
# Avvio di GrokBot Solana su Mac o Linux
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js non è installato. Scarica la versione LTS da https://nodejs.org/it/download e riprova."
  (command -v open >/dev/null && open "https://nodejs.org/it/download") || (command -v xdg-open >/dev/null && xdg-open "https://nodejs.org/it/download") || true
  read -r -p "Premi Invio per chiudere" _; exit 1
fi
if [ ! -d node_modules ]; then
  echo "Installazione dei componenti (solo la prima volta, 1-2 minuti)..."
  npm install --omit=dev || { echo "Installazione non riuscita"; read -r _; exit 1; }
fi
export OPEN_BROWSER=1
# Su Mac 'caffeinate' impedisce lo stop del computer mentre il bot lavora
if command -v caffeinate >/dev/null 2>&1; then caffeinate -i node server.js; else node server.js; fi
