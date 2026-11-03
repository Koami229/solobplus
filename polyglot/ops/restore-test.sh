#!/usr/bin/env bash
# Restores the latest (or given) dump into a throwaway database, compares row counts with live, drops the scratch DB.
set -euo pipefail
S=${STAGING_DIR:-/workspace/staging}; PG=${PG_BIN:-/usr/bin}
set -a; . $S/.env; set +a; export PGPASSWORD="$POSTGRES_PASSWORD"
f=${1:-$(ls -1t ${BACKUP_DIR:-$S/backups}/solob-*.dump | head -1)}
sha256sum -c $f.sha256 >/dev/null
db=solob_restore_test_$(date +%s); C="-h 127.0.0.1 -p $PGPORT -U solob"
$PG/createdb $C $db; trap "$PG/dropdb $C $db" EXIT
# pg_dump 17 emits "SET transaction_timeout" which PG16 rejects: filter it, fail on any other error
$PG/pg_restore --no-owner -f - $f | grep -v "^SET transaction_timeout" | $PG/psql $C -d $db -q -v ON_ERROR_STOP=1 >/dev/null
q="SELECT string_agg(relname||'='||n_live_tup, ',' ORDER BY relname) FROM (SELECT relname,(xpath('/row/c/text()',query_to_xml('select count(*) as c from '||quote_ident(schemaname)||'.'||quote_ident(relname),false,true,'')))[1]::text AS n_live_tup FROM pg_stat_user_tables) t"
a=$($PG/psql $C -d solob -tAc "$q"); b=$($PG/psql $C -d $db -tAc "$q")
if [ "$a" = "$b" ]; then echo "$(date -Is) restore-test OK $f tables=$(echo $a | tr ',' '\n' | wc -l)" | tee -a $S/logs/backup.log
else echo "$(date -Is) restore-test MISMATCH $f" | tee -a $S/logs/backup.log; diff <(echo $a|tr , '\n') <(echo $b|tr , '\n'); exit 1; fi
