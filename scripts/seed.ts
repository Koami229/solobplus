import { runSyntheticSeed } from '../src/lib/db/seed';
import { getDb } from '../src/lib/db/index';

async function main() {
  console.log('[SOLOB+ Seed] Running synthetic seed...');
  const result = await runSyntheticSeed();
  console.log(JSON.stringify(result, null, 2));
  await getDb().close();
}

main().catch((err) => {
  console.error('[SOLOB+ Seed] Fatal error:', err);
  process.exit(1);
});
