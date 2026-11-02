#!/bin/zsh
cd "${0:A:h}"
if ! command -v node >/dev/null; then
  if [ -s "$HOME/.nvm/nvm.sh" ]; then source "$HOME/.nvm/nvm.sh"; fi
fi
if ! command -v node >/dev/null; then
  echo 'Node.js 22以降が必要です。'; read; exit 1
fi
(sleep 2; open http://127.0.0.1:4317) &
npm start
