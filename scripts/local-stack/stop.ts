/** Stop gateway, PostgREST and PostgreSQL. `--keep-db` leaves PostgreSQL running. */
import { spawnSync } from 'node:child_process';
import { PG_DATA, config, isPortOpen, parseArgs, pgBin, stopByPidFile } from './lib.ts';

const args = parseArgs(process.argv.slice(2), ['keep-db']);
const cfg = config();

console.log(stopByPidFile('gateway') ? 'gateway stopped' : 'gateway was not running');
console.log(stopByPidFile('postgrest') ? 'PostgREST stopped' : 'PostgREST was not running');

if (!args['keep-db']) {
  if (await isPortOpen(cfg.pgPort)) {
    spawnSync(pgBin('pg_ctl'), ['-D', PG_DATA, '-m', 'fast', '-w', 'stop'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    console.log('PostgreSQL stopped');
  } else console.log('PostgreSQL was not running');
}
