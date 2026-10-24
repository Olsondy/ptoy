// Linux-only isolated shell contract tests. Every managed path and command is replaced inside
// a temporary copy; these tests never invoke systemd, install a user, or read real resources.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, readlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here=dirname(fileURLToPath(import.meta.url));
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'ptoy-release-test-'));
  const path=p=>join(root,p.replace(/^\//,''));
  for(const dir of ['scripts','bin','source/apps/agent/src','opt/ptoy/releases/old','var/www/ptoy/releases/old','var/lib/ptoy/resources/characters']) mkdirSync(path(dir),{recursive:true});
  for(const file of ['source/package.json','source/pnpm-lock.yaml','source/apps/agent/src/token-server.ts','var/lib/ptoy/resources/characters/_rules.md','var/lib/ptoy/resources/characters/fixture.md']) writeFileSync(path(file),'synthetic fixture');
  symlinkSync(path('opt/ptoy/releases/old'),path('opt/ptoy/current'));
  symlinkSync(path('var/www/ptoy/releases/old'),path('var/www/ptoy/current'));
  const script=readFileSync(join(here,'release.sh'),'utf8').replaceAll('/opt/ptoy',path('opt/ptoy')).replaceAll('/var/www/ptoy',path('var/www/ptoy')).replaceAll('/var/lib/ptoy',path('var/lib/ptoy'));
  writeFileSync(path('scripts/release.sh'),script);
  writeFileSync(path('scripts/lib.sh'),`set -Eeuo pipefail
fail() { printf '%s\\n' "$*" >&2; exit 1; }
require_root_ubuntu() { :; }
managed_paths() { :; }
lock_deployment() { :; }
check_tailscale() { :; }
check_public_interface() { :; }
load_runtime() { NODE_BIN="$REAL_NODE"; PNPM_BIN="$MOCK_BIN/pnpm"; ENV_FILE=/unused; RUNTIME_PATH="$PATH"; }
env_value() { printf fixture; }
ops() {
  printf 'ops %s\\n' "$1" >> "$MOCK_LOG"
  if [[ "$1" == wait-drain && "\${MOCK_DRAIN_FAIL:-}" == 1 ]]; then return 1; fi
  if [[ "$1" == maintenance-off ]]; then printf '{"maintenance":false,"activeCount":0,"modelsReady":false}';
  else printf '{"maintenance":true,"activeCount":0,"modelsReady":false}'; fi
}
`);
  const mocks={
    systemctl:`printf 'systemctl %s\\n' "$*" >> "$MOCK_LOG"; exit 0`,
    chown:`exit 0`,
    install:`mkdir -p -- "\${@: -1}"`,
    rsync:`src="\${@: -2:1}"; dst="\${@: -1}"; if [[ "$src" == */dist/ ]]; then cp -r "$src". "$dst"; else mkdir -p "$dst/apps/web/dist"; fi`,
    runuser:`shift 3; if [[ "$*" == *'/check-native.mjs'* ]]; then printf 'native-check\\n' >> "$MOCK_LOG"; [[ "\${MOCK_NATIVE_FAIL:-}" != 1 ]]; exit $?; fi; exec "$@"`,
    pnpm:`printf 'pnpm %s\\n' "$*" >> "$MOCK_LOG"; if [[ "\${MOCK_BUILD_FAIL:-}" == 1 ]]; then exit 1; fi; if [[ "$*" == *'@ptoy/web build'* ]]; then mkdir -p "$2/apps/web/dist"; printf '<!doctype html>fixture' > "$2/apps/web/dist/index.html"; fi`,
    curl:`exit 0`,
  };
  for(const [name,body] of Object.entries(mocks)) writeFileSync(path('bin/'+name),'#!/usr/bin/env bash\nset -eu\n'+body+'\n',{mode:0o755});
  const run=env=>spawnSync('bash',[path('scripts/release.sh'),path('source'),'new',process.execPath,'1'],{encoding:'utf8',env:{...process.env,PATH:path('bin')+':/usr/bin:/bin',REAL_NODE:process.execPath,MOCK_BIN:path('bin'),MOCK_LOG:path('commands.log'),...env}});
  return {root,path,run,logs:()=>readFileSync(path('commands.log'),'utf8')};
}
test('release builds before draining, switches only after drain, and opens access with offline models',{skip:process.platform!=='linux'},()=>{
  const f=fixture();try{
    const result=f.run({});assert.equal(result.status,0,result.stderr);
    const log=f.logs();
    assert.ok(log.indexOf('pnpm --dir')<log.indexOf('ops maintenance-on'));
    assert.match(log,/install --frozen-lockfile --prod=false/);
    assert.ok(log.indexOf('native-check')<log.indexOf('ops maintenance-on'));
    assert.ok(log.indexOf('ops wait-drain')<log.indexOf('systemctl stop ptoy-agent'));
    assert.ok(log.indexOf('systemctl stop ptoy-token')<log.indexOf('systemctl start ptoy-token'));
    assert.ok(log.indexOf('systemctl enable')<log.indexOf('ops maintenance-off'));
    assert.equal(readlinkSync(f.path('opt/ptoy/current')),f.path('opt/ptoy/releases/new'));
    assert.equal(readlinkSync(f.path('var/www/ptoy/current')),f.path('var/www/ptoy/releases/new'));
    assert.match(result.stdout,/models offline/);
    assert.doesNotMatch(log,/stop ptoy-livekit|kill|litespeed|lsws/);
  }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('failed drain leaves current releases and live services untouched, retaining maintenance',{skip:process.platform!=='linux'},()=>{
  const f=fixture();try{
    const result=f.run({MOCK_DRAIN_FAIL:'1'});assert.notEqual(result.status,0);
    assert.equal(readlinkSync(f.path('opt/ptoy/current')),f.path('opt/ptoy/releases/old'));
    assert.doesNotMatch(f.logs(),/systemctl stop|maintenance-off/);
    assert.match(f.logs(),/ops maintenance-on/);
  }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('failed build does not enter maintenance or stop existing services',{skip:process.platform!=='linux'},()=>{
  const f=fixture();try{
    const result=f.run({MOCK_BUILD_FAIL:'1'});assert.notEqual(result.status,0);
    assert.equal(readlinkSync(f.path('opt/ptoy/current')),f.path('opt/ptoy/releases/old'));
    assert.doesNotMatch(f.logs(),/ops maintenance|systemctl stop/);
  }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('failed native binding preflight does not enter maintenance or replace current',{skip:process.platform!=='linux'},()=>{
  const f=fixture();try{
    const result=f.run({MOCK_NATIVE_FAIL:'1'});assert.notEqual(result.status,0);
    assert.equal(readlinkSync(f.path('opt/ptoy/current')),f.path('opt/ptoy/releases/old'));
    assert.match(f.logs(),/native-check/);
    assert.doesNotMatch(f.logs(),/ops maintenance|systemctl stop/);
  }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('systemd units validate in an isolated directory with a harmless executable stand-in',{skip:process.platform!=='linux'},()=>{
  const dir=mkdtempSync(join(tmpdir(),'ptoy-unit-test-'));
  try {
    const units=['ptoy-livekit','ptoy-token','ptoy-agent'].map(name=>{
      const path=join(dir,name+'.service');
      const content=readFileSync(join(here,'systemd',name+'.service'),'utf8').replace('/usr/local/lib/ptoy/run-service.sh','/usr/bin/true');
      writeFileSync(path,content,{mode:0o644});return path;
    });
    const result=spawnSync('/usr/bin/systemd-analyze',['verify',...units],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
