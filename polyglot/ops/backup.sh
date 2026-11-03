#!/usr/bin/env bash
# Daily logical backup (pg_dump -Fc) with rotation (KEEP days) + checksum. Never deletes live data.
# Off-machine copy: set OFFSITE_DIR to a mounted disk/folder (user decision; see README).
set -euo pipefail
S=${STAGING_DIR:-/workspace/staging}; PG=${PG_BIN:-/usr/bin}; KEEP=${KEEP:-14}
set -a; . $S/.env; set +a
D=${BACKUP_DIR:-$S/backups}; mkdir -p $D; chmod 700 $D
f=$D/solob-$(date +%Y%m%d-%H%M%S).dump
PGPASSWORD="$POSTGRES_PASSWORD" $PG/pg_dump -h 127.0.0.1 -p $PGPORT -U solob -Fc -f $f solob
sha256sum $f > $f.sha256; chmod 600 $f $f.sha256
ls -1t $D/solob-*.dump | tail -n +$((KEEP+1)) | while read o; do rm -f "$o" "$o.sha256"; done
[ -n "${OFFSITE_DIR:-}" ] && cp $f $f.sha256 "$OFFSITE_DIR"/
echo "$(date -Is) backup ok $f $(stat -c%s $f)B" >> $S/logs/backup.log
echo $f
