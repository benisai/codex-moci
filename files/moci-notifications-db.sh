#!/bin/sh

set -eu

PATH="/usr/sbin:/usr/bin:/sbin:/bin"
DB_PATH_DEFAULT="/tmp/moci-notifications.sqlite"
DB_PATH="$(uci -q get moci.notifications.db_path 2>/dev/null || true)"
[ -n "$DB_PATH" ] || DB_PATH="$DB_PATH_DEFAULT"

SQLITE_BIN=""
if command -v sqlite3 >/dev/null 2>&1; then
	SQLITE_BIN="$(command -v sqlite3)"
elif command -v sqlite3-cli >/dev/null 2>&1; then
	SQLITE_BIN="$(command -v sqlite3-cli)"
else
	echo "sqlite3/sqlite3-cli not found"
	exit 1
fi

init_db() {
	mkdir -p "$(dirname "$DB_PATH")"
	"$SQLITE_BIN" "$DB_PATH" <<'SQL'
CREATE TABLE IF NOT EXISTS notifications (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	timestamp INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
	app TEXT NOT NULL DEFAULT '',
	msg TEXT NOT NULL DEFAULT '',
	archived INTEGER NOT NULL DEFAULT 0,
	"delete" INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_notifications_timestamp ON notifications(timestamp);
CREATE INDEX IF NOT EXISTS idx_notifications_archived ON notifications(archived);
SQL
	echo "initialized: $DB_PATH"
}

case "${1:-}" in
--init-db)
	init_db
	;;
*)
	echo "Usage: $0 --init-db"
	exit 1
	;;
esac
