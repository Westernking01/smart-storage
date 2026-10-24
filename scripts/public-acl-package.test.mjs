import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root = path.resolve(import.meta.dirname,'..');
const source = fs.readFileSync(path.join(root,'scripts/inspect-public-acl-ownership-private.mjs'),'utf8');
const body = source.replace(/^import[\s\S]*?from\s+"[^"\n]+";\r?\n/gm,'');
assert.doesNotMatch(body,/^import /m);
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
for (const relocated of ['C:/isolated/package/scripts','D:/reviewed/other/scripts']) {
  for (const consumed of [false,true]) test(`relocation ${relocated}; consumed=${consumed}`,async()=>{
    const writes=[]; const events=[]; let readPassword=false; let exitCode=0;
    const sql=fs.readFileSync(path.join(root,'docs/targeted-public-acl-ownership.readonly.sql'),'utf8');
    const fakeFs={readFile:async()=>sql,writeFile:async(file,data,options)=>{
      writes.push({file,options});
      events.push('exclusive-write');
      if (consumed) throw Object.assign(Error('exists'),{code:'EEXIST'});
    }};
    const fakeProcess={argv:['node','host'],stdin:{async *[Symbol.asyncIterator](){readPassword=true;events.push('synthetic-input');yield 'SYNTHETIC_TEST_VALUE';}},set exitCode(v){exitCode=v;}};
    const fakePg={Client:class {
      constructor(){events.push('client-created');}
      on(){}
      async connect(){events.push('mock-connect');throw Error('OFFLINE_STOP');}
      async end(){events.push('mock-cleanup');}
    }};
    const run = new AsyncFunction('fs','path','crypto','assert','loadPredecessorContracts','pg','process','console',
      body.replaceAll('import.meta.dirname',JSON.stringify(relocated)));
    await run(fakeFs,path.win32,crypto,assert,async()=>({}),fakePg,fakeProcess,{log(){}});
    assert.equal(writes[0].file,'C:\\Users\\Admin\\Desktop\\NEW\\smart-storage\\.cache\\browser-roundtrip-20261020\\public-acl-ownership-once.20261022-once-dd28b358ee5a42b7a7323f8a802c4351.json');
    assert.equal(writes[0].options.flag,'wx');
    assert.equal(readPassword,!consumed);
    assert.equal(exitCode,1);
    if(consumed) {
      assert.equal(writes.length,1);
      assert.deepEqual(events,['exclusive-write']);
    } else {
      assert.ok(writes[1].file.startsWith(path.win32.resolve(relocated,'..')+'\\docs\\'));
      assert.deepEqual(events,['exclusive-write','synthetic-input','client-created','mock-connect','exclusive-write','mock-cleanup']);
    }
  });
}
test('all staged bytes match manifest and exclude protected state',()=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'scripts/public-acl-package.manifest.json'),'utf8'));
  assert.equal(manifest.executionAuthorized,false);
  for(const entry of manifest.files){
    assert.doesNotMatch(entry.path, /(?:\.cache|admin\.dpapi|public-acl-ownership-(?:evidence|execution|once)\.)/);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,entry.path))).digest('hex'),entry.sha256);
  }
});
test('wrapper trusts pinned package/runtime before protected-state access',()=>{
  const wrapper=fs.readFileSync(path.join(root,'scripts/inspect-public-acl-ownership-private.ps1'),'utf8');
  assert.ok(wrapper.indexOf('Assert-PublicAclPackage') < wrapper.indexOf("$ancestor = Join-Path $base 'admin.dpapi'"));
  assert.doesNotMatch(wrapper,/Get-Command node/);
  assert.match(wrapper,/\$node = \$NodeExecutable/);
  assert.match(wrapper,/C:\\Users\\Admin\\Desktop\\NEW\\smart-storage\\\.cache\\browser-roundtrip-20261020/);
  assert.match(wrapper,/Join-Path \$base 'postgres'/);
  assert.match(source,/host: "127\.0\.0\.1"[\s\S]*port: 55461,[\s\S]*database: "smart_storage_gateway_test"/);
});
