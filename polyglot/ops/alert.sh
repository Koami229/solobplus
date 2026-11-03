#!/usr/bin/env bash
# Usage: alert.sh <kind> <message>   kinds: downtime | backup | offsite | 5xx | restore
# Ajoute une alerte à la file $S/logs/alert-queue.jsonl (une ligne JSON) que la routine Grok Bot
# « SOLOB alertes » lit puis envoie par Gmail à l'adresse du propriétaire. Anti-spam : une alerte par kind / 30 min.
# Aucune donnée secrète ni personnelle dans le message.
set -uo pipefail
S=${STAGING_DIR:-/workspace/staging}; Q=$S/logs/alert-queue.jsonl; kind=${1:?kind}; shift; msg="$*"
mkdir -p $S/logs $S/run; st=$S/run/alert-last-$kind; now=$(date +%s)
echo "$(date -Is) ALERT [$kind] $msg" >> $S/logs/alerts.log
if [ -f $st ] && [ $((now - $(cat $st))) -lt ${ALERT_DEDUP_S:-1800} ]; then exit 0; fi
echo $now > $st
python3 - "$Q" "$kind" "$msg" <<'PY'
import json, sys, datetime, secrets
q, kind, msg = sys.argv[1:4]
row = {"id": "al_" + secrets.token_hex(6), "at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
       "kind": kind, "severity": "critical" if kind in ("downtime", "backup", "offsite") else "warning",
       "host": "staging.solob.dpdns.org", "message": msg[:500], "status": "pending"}
open(q, "a").write(json.dumps(row, ensure_ascii=False) + "\n")
PY
