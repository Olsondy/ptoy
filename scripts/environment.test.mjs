import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { environmentOptions, loadEnvironment, checkEnvironment, livekitArguments } from './environment.mjs';

function removeFixture(dir) {
  assert.equal(dirname(resolve(dir)),resolve(tmpdir()));
  assert.match(dir.split(/[\\/]/).pop(),/^ptoy-/);
  rmSync(dir,{recursive:true,force:true});
}

test('environment arguments work through pnpm and leave application arguments intact', () => {
  assert.deepEqual(environmentOptions(['--','--env','hk','create','friend']), {name:'hk',check:false,args:['create','friend']});
  assert.deepEqual(environmentOptions(['--env=hk','--check-env']), {name:'hk',check:true,args:[]});
  assert.deepEqual(environmentOptions([]), {name:undefined,check:false,args:[]});
  for (const args of [['--env'],['--env='],['--env','../other'],['--env','hk','--env','local']]) {
    assert.throws(()=>environmentOptions(args));
  }
});

test('named environment never imports missing values from local .env or falls back', () => {
  const dir=mkdtempSync(join(tmpdir(),'ptoy-env-'));
  try {
    writeFileSync(join(dir,'.env'),'ASR_URL=http://127.0.0.1:8001\nLOCAL_ONLY=private\n');
    writeFileSync(join(dir,'.env.hk'),'ASR_URL=http://100.90.8.73:8001\nCLOUD_ONLY=cloud\n');
    const local=loadEnvironment(dir,undefined,{});
    const hk=loadEnvironment(dir,'hk',{});
    assert.equal(local.env.ASR_URL,'http://127.0.0.1:8001');
    assert.equal(hk.env.ASR_URL,'http://100.90.8.73:8001');
    assert.equal(hk.env.LOCAL_ONLY,undefined);
    assert.equal(local.env.CLOUD_ONLY,undefined);
    assert.equal(loadEnvironment(dir,'hk',{ASR_URL:'http://explicit-override:8001'}).env.ASR_URL,'http://explicit-override:8001');
    assert.throws(()=>loadEnvironment(dir,'missing',{},false),/环境配置不存在/);
    assert.deepEqual(loadEnvironment(join(dir,'missing-directory'),undefined,{},false).env,{});
  } finally { removeFixture(dir); }
});

test('production launch blocks incomplete domains and never falls back to LiveKit dev mode', () => {
  assert.doesNotThrow(()=>checkEnvironment({}));
  assert.throws(()=>checkEnvironment({NODE_ENV:'production'}),/APP_ORIGIN/);
  assert.throws(()=>checkEnvironment({NODE_ENV:'production',APP_ORIGIN:'https://voice.test'}),/LIVEKIT_PUBLIC_URL/);
  assert.throws(()=>livekitArguments({NODE_ENV:'production'}),/LIVEKIT_CONFIG/);
  const dir=mkdtempSync(join(tmpdir(),'ptoy-livekit-'));
  try {
    const config=join(dir,'livekit.yaml');
    assert.throws(()=>livekitArguments({LIVEKIT_CONFIG:config}),/不存在/);
    writeFileSync(config,'# fixture\n');
    assert.deepEqual(livekitArguments({NODE_ENV:'production',LIVEKIT_CONFIG:config}),['--config',config]);
    assert.deepEqual(livekitArguments({LIVEKIT_NODE_IP:'100.90.8.73'}),['--dev','--bind','0.0.0.0','--node-ip','100.90.8.73']);
  } finally { removeFixture(dir); }
});

test('Agent launcher passes the selected environment, working directory and application arguments to its child', () => {
  const root=mkdtempSync(join(tmpdir(),'ptoy-launch-'));
  try {
    const scripts=join(root,'scripts');
    const agent=join(root,'apps','agent');
    mkdirSync(scripts,{recursive:true});
    mkdirSync(join(agent,'node_modules','tsx','dist'),{recursive:true});
    for (const file of ['run-agent.mjs','environment.mjs']) copyFileSync(new URL(file,import.meta.url),join(scripts,file));
    writeFileSync(join(agent,'.env'),'ASR_URL=http://local:8001\nLOCAL_ONLY=local-secret\n');
    writeFileSync(join(agent,'.env.hk'),'ASR_URL=http://tailscale:8001\n');
    writeFileSync(join(agent,'node_modules','tsx','dist','cli.mjs'),
      'console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),asr:process.env.ASR_URL,local:process.env.LOCAL_ONLY}));');
    const run=args=>spawnSync(process.execPath,[join(scripts,'run-agent.mjs'),...args],{encoding:'utf8',env:{}});
    const hk=run(['start','--env','hk','--fixture-option','value']);
    assert.equal(hk.status,0,hk.stderr);
    assert.deepEqual(JSON.parse(hk.stdout),{args:['src/agent.ts','start','--fixture-option','value'],cwd:agent,asr:'http://tailscale:8001'});
    const local=run(['start:token']);
    assert.equal(local.status,0,local.stderr);
    assert.equal(JSON.parse(local.stdout).local,'local-secret');
    assert.deepEqual(JSON.parse(local.stdout).args,['src/token-server.ts']);
    const missing=run(['start','--env','missing']);
    assert.equal(missing.status,1);assert.match(missing.stderr,/环境配置不存在/);
  } finally { removeFixture(root); }
});
