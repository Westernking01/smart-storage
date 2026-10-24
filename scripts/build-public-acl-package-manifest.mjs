// Offline inventory only. Reads reviewed source/package bytes; never stages files.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const files = new Set([
  'scripts/inspect-public-acl-ownership-private.ps1',
  'scripts/inspect-public-acl-ownership-private.mjs',
  'scripts/public-acl-package-trust.ps1',
  'scripts/verify-public-acl-package.ps1',
  'scripts/public-acl-ownership-proposal.mjs',
  'scripts/predecessor-contracts.mjs',
  'scripts/predecessor-expressions.mjs',
  'scripts/predecessor-diagnostics.mjs',
  'scripts/migration-function-comparator.mjs',
  'scripts/predecessor-contracts.json',
  'scripts/predecessor-contract-sources.json',
  'scripts/migration-function-sources.json',
  'docs/targeted-public-acl-ownership.readonly.sql',
]);
for (const manifest of ['scripts/predecessor-contract-sources.json', 'scripts/migration-function-sources.json']) {
  for (const file of Object.keys(JSON.parse(fs.readFileSync(path.join(root, manifest), 'utf8')))) files.add(file);
}
const packages = new Set();
function inventory(name, from = require) {
  let baseEntry = path.dirname(from.resolve(name));
  while (!fs.existsSync(path.join(baseEntry,'package.json'))) {
    const parent=path.dirname(baseEntry);
    if(parent===baseEntry) throw Error('PACKAGE_METADATA_MISSING');
    baseEntry=parent;
  }
  const entry = path.join(baseEntry,'package.json');
  const base = path.dirname(entry);
  if (packages.has(base)) return;
  if (!base.startsWith(path.join(root, 'node_modules') + path.sep)) throw Error('EXTERNAL_DEPENDENCY');
  packages.add(base);
  const pkg = JSON.parse(fs.readFileSync(entry, 'utf8'));
  function walk(dir) {
    for (const item of fs.readdirSync(dir, {withFileTypes:true})) {
      const target = path.join(dir, item.name);
      if (item.isSymbolicLink()) throw Error('REPARSE_BLOCKED');
      if (item.isDirectory()) {
        if (!['test','tests','.github','node_modules'].includes(item.name)) walk(target);
      } else files.add(path.relative(root, target).replaceAll('\\','/'));
    }
  }
  walk(base);
  const local = createRequire(entry);
  for (const dep of Object.keys({...pkg.dependencies, ...pkg.optionalDependencies})) inventory(dep, local);
}
inventory('pg');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');
for (const source of ['scripts/predecessor-contract-sources.json','scripts/migration-function-sources.json']) {
  for (const [file, hash] of Object.entries(JSON.parse(fs.readFileSync(path.join(root,source),'utf8')))) {
    if (digest(file) !== hash) throw Error('SOURCE_PIN_BLOCKED');
  }
}
if (digest('docs/targeted-public-acl-ownership.readonly.sql') !== '10722d31f7e704ebfd54b420d3db0df152267ca7e3ef7e4c591a9ccb573cbfef') throw Error('SQL_PIN_BLOCKED');
const manifest = {version:1, executionAuthorized:false, files:[...files].sort().map(file => ({path:file,sha256:digest(file)}))};
const text = JSON.stringify(manifest,null,2)+'\n';
if (process.argv.length === 3 && process.argv[2] === '--check') {
  if (fs.readFileSync(path.join(root,'scripts/public-acl-package.manifest.json'),'utf8') !== text) throw Error('MANIFEST_REVIEW_REQUIRED');
} else {
  if(process.argv.length !== 2) throw Error('ARGUMENT_BLOCKED');
  fs.writeFileSync(path.join(root,'scripts/public-acl-package.manifest.json'), text);
}
console.log(`PASS: ${files.size} offline inventory entries; no staging or execution.`);
