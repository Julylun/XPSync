import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const target = new URL('.env', import.meta.url);
const contents = `HOST=0.0.0.0\nPORT=3001\nDB_PATH=./data/xpsync.db\nJWT_SECRET=${randomBytes(48).toString('hex')}\nSETUP_TOKEN=${randomBytes(24).toString('hex')}\nCLIENT_ORIGINS=*\n`;
try {
  await writeFile(target, contents, { flag: 'wx', mode: 0o600 });
  console.log(
    'Created server/.env. Read SETUP_TOKEN in that file to create the first admin at /admin/.',
  );
} catch (error) {
  if (error.code === 'EEXIST') console.log('server/.env already exists; left unchanged.');
  else throw error;
}
