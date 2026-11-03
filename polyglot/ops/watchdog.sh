#!/usr/bin/env bash
# SOLOB+ watchdog (no systemd needed): checks every service each INTERVAL s, restarts what is down,
# writes status + alerts to $S/logs. Start: nohup ./watchdog.sh >/dev/null 2>&1 &   (pid in $S/run/watchdog.pid)
# Free, local only. Alerts go to $S/logs/alerts.log (hook a free notifier later if wanted).
set -uo pipefail
S=${STAGING_DIR:-/workspace/staging}; INTERVAL=${INTERVAL:-30}; PUBLIC_URL=${PUBLIC_URL:-}
echo $$ > $S/run/watchdog.pid
alive() { [ -f $S/run/$1.pid ] && kill -0 "$(cat $S/run/$1.pid)" 2>/dev/null; }
log() { echo "$(date -Is) $*" >> $S/logs/watchdog.log; }
alert() { echo "$(date -Is) ALERT $*" >> $S/logs/alerts.log; log "ALERT $*"; }
while true; do
  down=""
  for n in school business gateway; do alive $n || down="$down $n"; done
  curl -fs -m 5 -o /dev/null http://127.0.0.1:8100/api/health || down="$down gateway-health"
  if [ -n "$down" ]; then
    alert "down:$down -> restart"
    for n in school business gateway; do alive $n || rm -f $S/run/$n.pid; done
    case "$down" in *gateway-health*) alive gateway && ! curl -fs -m 5 -o /dev/null http://127.0.0.1:8100/api/health && { kill "$(cat $S/run/gateway.pid)"; rm -f $S/run/gateway.pid; };; esac
    $S/start.sh >> $S/logs/watchdog.log 2>&1 && log "restart ok" || alert "restart FAILED"
  fi
  if ! alive cloudflared; then alert "cloudflared down -> restart"; $S/cloudflare/tunnel-start.sh >> $S/logs/watchdog.log 2>&1; fi
  if [ -n "$PUBLIC_URL" ]; then
    c=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$PUBLIC_URL/api/health"); if [ "$c" = 200 ]; then pubfail=0; else pubfail=$((${pubfail:-0}+1)); alert "public $PUBLIC_URL/api/health -> $c ($pubfail)"
      # 530/502 twice in a row while local is healthy = tunnel lost its edge connections: restart cloudflared
      if [ $pubfail -ge 2 ] && alive cloudflared; then kill "$(cat $S/run/cloudflared.pid)"; sleep 2; rm -f $S/run/cloudflared.pid
        $S/cloudflare/tunnel-start.sh >> $S/logs/watchdog.log 2>&1 && log "tunnel restarted"; pubfail=0; fi; fi
  fi
  date -Is > $S/run/watchdog.heartbeat
  sleep $INTERVAL
done
