/** Print which local stack services are listening. */
import { config, isPortOpen } from './lib.ts';

const cfg = config();
const rows: Array<[string, number]> = [
  ['PostgreSQL', cfg.pgPort],
  ['PostgREST', cfg.postgrestPort],
  ['Gateway (API URL)', cfg.gatewayPort],
];
for (const [name, port] of rows) {
  console.log(`${(await isPortOpen(port)) ? '●' : '○'} ${name.padEnd(18)} :${port}`);
}
