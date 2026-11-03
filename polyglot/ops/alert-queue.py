#!/usr/bin/env python3
"""File d'alertes SOLOB+ (lecture par la routine Grok Bot qui envoie le mail via le connecteur Gmail).
  alert-queue.py pending          -> JSON des alertes non envoyées
  alert-queue.py ack <id> [...]   -> marque envoyées (fichier alert-sent.txt, la file reste en ajout seul)"""
import json, os, sys
S = os.environ.get("STAGING_DIR", "/workspace/staging"); Q = f"{S}/logs/alert-queue.jsonl"; A = f"{S}/logs/alert-sent.txt"
sent = set(open(A).read().split()) if os.path.exists(A) else set()
rows = [json.loads(l) for l in open(Q)] if os.path.exists(Q) else []
if sys.argv[1:2] == ["pending"]:
    print(json.dumps([r for r in rows if r["id"] not in sent], ensure_ascii=False, indent=1))
elif sys.argv[1:2] == ["ack"]:
    with open(A, "a") as f:
        for i in sys.argv[2:]: f.write(i + "\n")
else:
    sys.exit(__doc__)
