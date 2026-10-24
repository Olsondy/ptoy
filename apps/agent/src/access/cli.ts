import { loadAccessConfig } from './config.js';
import { AccessStore } from './store.js';

const [command, ...args] = process.argv.slice(2);
const config = loadAccessConfig();
const store = new AccessStore(config.dbPath, Date.now, config.maintenanceDefault);
try {
  if (command === 'create') {
    const note = args.join(' ').trim();
    if (!note || note.length > 200) throw new Error('create requires a note (1–200 characters)');
    console.log(JSON.stringify(store.createInvite(note), null, 2));
  } else if (command === 'list') {
    console.log(JSON.stringify(store.listInvites(), null, 2));
  } else if (command === 'revoke' && args[0]) {
    if (!store.revokeInvite(args[0])) throw new Error('invite not found');
    console.log('Invitation revoked. Established calls may finish.');
  } else throw new Error('Usage: pnpm --filter @ptoy/agent invite create <note> | list | revoke <id>');
} finally { store.close(); }
