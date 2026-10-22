#!/usr/bin/env bash
# Деплой бота на сервер. Устанавливается в /usr/local/bin/hollibot-deploy (владелец root, 755)
# и вызывается из GitHub Actions: ssh deploy@host <commit-sha>
# Пользователь deploy может выполнить только этот скрипт (forced command + sudoers).
set -euo pipefail

APP_DIR=/opt/hollihop-tg-bot
APP_USER=hollibot
SERVICE=hollibot
BRANCH=master

REF="${1:-${SSH_ORIGINAL_COMMAND:-}}"
REF="${REF:-origin/$BRANCH}"
if [[ ! "$REF" =~ ^([0-9a-f]{7,40}|origin/$BRANCH)$ ]]; then
  echo "Недопустимый ref: $REF" >&2
  exit 2
fi

exec 9>/run/lock/hollibot-deploy.lock
flock -w 300 9

as_app() { runuser -u "$APP_USER" -- "$@"; }
cd "$APP_DIR"

PREV=$(as_app git rev-parse HEAD)
as_app git fetch --quiet origin "$BRANCH"
as_app git reset --quiet --hard "$REF"
NEW=$(as_app git rev-parse HEAD)
echo "Деплой ${PREV:0:7} -> ${NEW:0:7}"

install_deps() {
  if ! as_app git diff --quiet "$1" "$2" -- package.json package-lock.json || [ ! -d node_modules ]; then
    echo "Зависимости изменились, npm ci"
    as_app npm ci --omit=dev --no-audit --no-fund
  fi
}

healthy() {
  sleep 15
  systemctl is-active --quiet "$SERVICE" && [ "$(systemctl show -p NRestarts --value "$SERVICE")" = "0" ]
}

install_deps "$PREV" "$NEW"
systemctl restart "$SERVICE"

if healthy; then
  echo "Сервис $SERVICE запущен на ${NEW:0:7}"
  exit 0
fi

echo "Сервис не поднялся, откат на ${PREV:0:7}" >&2
journalctl -u "$SERVICE" -n 40 --no-pager >&2 || true
as_app git reset --quiet --hard "$PREV"
install_deps "$NEW" "$PREV"
systemctl restart "$SERVICE"
exit 1
