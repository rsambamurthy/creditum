/** Command line: node dist/database/cli.js migrate | revert | seed */
import 'reflect-metadata';
import { loadDbEnv } from '../config/env';
import { createDataSource } from './data-source';
import { seedAll } from './seed';

async function main() {
  const cmd = process.argv[2];
  const ds = createDataSource(loadDbEnv());
  await ds.initialize();
  try {
    if (cmd === 'migrate') console.log(`Migrations applied: ${(await ds.runMigrations()).map(m => m.name).join(', ') || 'none pending'}`);
    else if (cmd === 'revert') { await ds.undoLastMigration(); console.log('Last migration reverted'); }
    else if (cmd === 'seed') console.log(JSON.stringify(await seedAll(ds)));
    else throw new Error('Usage: cli.js migrate | revert | seed');
  } finally {
    await ds.destroy();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
