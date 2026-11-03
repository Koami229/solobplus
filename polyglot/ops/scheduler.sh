#!/usr/bin/env bash
# cron-like loop (no cron/systemd on the box): daily backup at 02:30 local + offsite encrypted copy + weekly restore test (Sunday).
# Failures go to the alert queue (alert.sh) that the Grok Bot routine mails via Gmail.
S=${STAGING_DIR:-/workspace/staging}; H=$(dirname "$(readlink -f "$0")"); echo $$ > $S/run/scheduler.pid
last=""
while true; do
  d=$(date +%F); if [ "$(date +%H%M)" \> "0229" ] && [ "$last" != "$d" ]; then
    if $H/backup.sh >/dev/null 2>>$S/logs/backup.log; then
      $H/offsite.sh >/dev/null 2>>$S/logs/backup.log || true   # offsite.sh met lui-même l'alerte en file
    else $H/alert.sh backup "sauvegarde quotidienne échouée (voir logs/backup.log)"; fi
    [ "$(date +%u)" = 7 ] && { $H/restore-test.sh >/dev/null 2>>$S/logs/backup.log || $H/alert.sh restore "test de restauration hebdomadaire échoué"; }
    last=$d; fi
  sleep 300
done
