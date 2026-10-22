import { migrate } from '../migrate.js';
import { runSync } from '../hollihop/sync.js';
import { pool } from '../db.js';

const full = process.argv.includes('full');
await migrate();
const r = await runSync({ full });
console.log(r);
await pool.end();
