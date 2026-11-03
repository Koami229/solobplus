#!/usr/bin/env bash
# Copie hors machine : chiffre la dernière sauvegarde (GPG symétrique AES256) et la pousse dans le dépôt GitHub PRIVÉ
# séparé $OFFSITE_REPO (défaut Koami229/solobplus-backups). Rétention : $KEEP_DAYS jours (défaut 14).
# Clé : $BACKUP_KEY_FILE (défaut ~/.solob-backup-key, chmod 600), JAMAIS dans un dépôt. Sans elle, les sauvegardes sont illisibles :
# conservez-en une copie hors machine (gestionnaire de mots de passe).
# Jeton : $GITHUB_PUSH_TOKEN, passé par un credential helper en mémoire (jamais écrit sur disque ni dans l'URL).
set -euo pipefail
S=${STAGING_DIR:-/workspace/staging}; H=$(dirname "$(readlink -f "$0")")
REPO=${OFFSITE_REPO:-Koami229/solobplus-backups}; KEEP_DAYS=${KEEP_DAYS:-14}
REMOTE=${OFFSITE_URL:-https://github.com/$REPO.git}
KEY=${BACKUP_KEY_FILE:-$HOME/.solob-backup-key}; W=${OFFSITE_WORK:-$S/offsite-repo}
fail() { $H/alert.sh offsite "copie hors machine échouée : $*"; echo "offsite: $*" >&2; exit 1; }
[ -n "${GITHUB_PUSH_TOKEN:-}" ] || fail "GITHUB_PUSH_TOKEN absent"
if [ ! -f "$KEY" ]; then umask 077; head -c 48 /dev/urandom | base64 > "$KEY"; fi
chmod 600 "$KEY"
f=${1:-$(ls -1t $S/backups/solob-*.dump | head -1)}; [ -f "$f" ] || fail "aucune sauvegarde locale"
sha256sum -c "$f.sha256" >/dev/null || fail "checksum local invalide $(basename $f)"
git_() { git -c credential.helper= -c credential.helper='!f(){ echo username=x-access-token; echo "password=$GITHUB_PUSH_TOKEN"; }; f' "$@"; }
if [ ! -d $W/.git ]; then git_ clone -q "$REMOTE" $W 2>/dev/null || fail "clone $REPO impossible (accès du jeton ?)"; fi
cd $W; git_ pull -q --ff-only 2>/dev/null || true
mkdir -p dumps; b=$(basename $f)
gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-file "$KEY" --symmetric --cipher-algo AES256 -o dumps/$b.gpg "$f"
sha256sum dumps/$b.gpg > dumps/$b.gpg.sha256
# rétention : supprime du dépôt les copies de plus de KEEP_DAYS jours (d'après la date dans le nom)
lim=$(date -d "-$KEEP_DAYS days" +%Y%m%d)
for o in dumps/solob-*.dump.gpg; do d=$(basename $o | cut -d- -f2); [ "$d" -lt "$lim" ] && git rm -q -f "$o" "$o.sha256" || true; done
[ -f README.md ] || printf '# solobplus-backups (PRIVÉ)\nSauvegardes pg_dump -Fc du staging SOLOB+, chiffrées GPG AES256. Clé hors dépôt.\nRestauration : `gpg --batch --pinentry-mode loopback --passphrase-file ~/.solob-backup-key -d FICHIER.gpg > solob.dump && pg_restore -d BASE solob.dump`\n' > README.md
git add -A; git -c user.name="SOLOB+ backup bot" -c user.email="backup@solob.invalid" commit -qm "backup $b" || true
git_ push -q origin HEAD 2>/dev/null || fail "push vers $REPO refusé"
echo "$(date -Is) offsite ok $REPO dumps/$b.gpg $(stat -c%s dumps/$b.gpg)B" >> $S/logs/backup.log
echo dumps/$b.gpg
