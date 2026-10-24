import { readFile } from 'node:fs/promises';

// UTF-8 decoding retains U+FEFF; remove only the optional first character.
export async function readMigrationSql(file) {
  return (await readFile(file, 'utf8')).replace(/^\uFEFF/, '');
}
