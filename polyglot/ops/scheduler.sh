#!/usr/bin/env bash
# cron-like loop (no cron/systemd on the box): daily backup at 02:30 local + weekly restore test (Sunday).
S=${STAGING_DIR:-/workspace/staging}; H=$(dirname "$(readlink -f "$0")"); echo $$ > $S/run/scheduler.pid
last=""
while true; do
  d=$(date +%F); if [ "$(date +%H%M)" \> "0229" ] && [ "$last" != "$d" ]; then
    $H/backup.sh >/dev/null 2>>$S/logs/backup.log || echo "$(date -Is) ALERT backup failed" >> $S/logs/alerts.log
    [ "$(date +%u)" = 7 ] && { $H/restore-test.sh >/dev/null 2>>$S/logs/backup.log || echo "$(date -Is) ALERT restore-test failed" >> $S/logs/alerts.log; }
    last=$d; fi
  sleep 300
done
