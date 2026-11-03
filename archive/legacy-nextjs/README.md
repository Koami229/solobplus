# Archive — ancienne version TypeScript / Next.js 15 de SOLOB+

Ce dossier contient la **version d'origine de SOLOB+ écrite en TypeScript avec Next.js 15** (`src/`, `tests/`, `scripts/`, `package.json`, configurations Next, Tailwind, PostCSS, Vitest, TypeScript).

- Conservée **uniquement pour référence** : rien n'a été supprimé, les fichiers ont été déplacés avec `git mv` (historique préservé, `git log --follow`).
- **Non maintenue** et **non déployée**. La pile active est dans `polyglot/` (passerelle Rust, School Python, Business Java, moteur de notation C++, SOLOB AI).
- Exclue de la barre de langages GitHub via `.gitattributes` (`linguist-vendored`).
- Les migrations `db/`, `.env.example`, `DEPLOYMENT.md` et `SECURITY.md` restent à la racine du dépôt (partagées) ; la CI crée des liens symboliques pour continuer à tester cette archive.

Pour la lancer localement : voir la section *Quick Start* du `README.md` racine.
