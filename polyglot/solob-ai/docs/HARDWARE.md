# Rapport matériel (mesuré le 30/10/2026, machine de développement)

| Ressource | Valeur mesurée |
|---|---|
| CPU | 8 vCPU (pas de GPU, pas de CUDA) |
| RAM | 15 Gi total, ~2–3 Gi disponibles pendant les mesures |
| Disque libre | ~110 Go |
| PostgreSQL | 16.4 local jetable pour les tests (`/home/box/tc/pg16`) |
| Python | 3.12 (venv isolé `.venv`, dépendances verrouillées par hash) |
| PyTorch | 2.5.1+cpu |

Ce que la machine permet: collecte de petits échantillons, laboratoire tokenizer, prototypes ≤ ~5 M paramètres
sur ≤ 60 min. Ce qu'elle ne permet pas: tout modèle de taille utile (≥ 100 M paramètres, ≥ milliards de tokens).
Les mesures réelles de l'entraînement (débit, mémoire) sont dans `REPORT-MISSION2.md`.
