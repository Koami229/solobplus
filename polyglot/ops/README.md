# SOLOB+ exploitation (gratuit, auto-hébergé, sans systemd)

| Script | Rôle |
|---|---|
| `watchdog.sh` | Surveille school/business/gateway/cloudflared toutes les 30 s, relance ce qui tombe, journalise `logs/alerts.log`, battement `run/watchdog.heartbeat`. `PUBLIC_URL=https://…` vérifie aussi l'accès public. |
| `scheduler.sh` | Boucle type cron : `backup.sh` chaque jour après 02:30, `restore-test.sh` le dimanche. |
| `backup.sh` | `pg_dump -Fc` + SHA-256, rotation `KEEP=14`, copie hors machine si `OFFSITE_DIR` est défini. |
| `offsite.sh` | Chiffre le dernier dump (GPG AES256, clé `~/.solob-backup-key` chmod 600, hors dépôt) et le pousse dans le dépôt GitHub **privé** `Koami229/solobplus-backups` ; rétention 14 jours ; échec → alerte. Lancé par `scheduler.sh` après chaque sauvegarde. |
| `alert.sh` / `alert-queue.py` | File d'alertes `logs/alert-queue.jsonl` (kinds : downtime ≥ 2 min, backup, offsite, 5xx, restore ; 1 alerte/kind/30 min). La routine Grok Bot lit `alert-queue.py pending`, envoie le mail via Gmail, puis `alert-queue.py ack <id>`. |
| `restore-test.sh` | Restaure le dernier dump dans une base jetable, compare le nombre de lignes de chaque table, supprime la base jetable. |
| `release.sh` / `rollback.sh` | Sauvegarde le binaire avant déploiement ; retour arrière vers une release nommée. |

Démarrage : `nohup polyglot/ops/watchdog.sh >/dev/null 2>&1 &` et `nohup polyglot/ops/scheduler.sh >/dev/null 2>&1 &`.
Après un redémarrage de la machine, relancer `staging/start.sh`, `cloudflare/tunnel-start.sh`, puis ces deux boucles.
Aucun secret ici : tout est lu depuis `staging/.env` et `cloudflare/cf.env` (hors dépôt, chmod 600).
