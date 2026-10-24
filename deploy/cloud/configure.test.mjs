import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configure, parseEnv, validateSettings, applicationEnv, livekitYaml } from './configure.mjs';
import { operations, validateStatus } from './ops.mjs';

const settings = () => ({APP_DOMAIN:'voice.ptoy-demo.dev',RTC_DOMAIN:'rtc.ptoy-demo.dev',PUBLIC_IPV4:'8.8.8.8',MODEL_HOST:'100.64.0.2',ASR_PORT:'8001',LLM_PORT:'8080',TTS_PORT:'8002',LLM_MODEL:'fixture',LLM_API_KEY:'no-key',DEFAULT_CHARACTER:'fixture',NODE_BIN:'/usr/bin/node',PNPM_BIN:'/usr/local/bin/pnpm',LIVEKIT_BIN:'/usr/local/bin/livekit-server',LIVEKIT_VERSION:'1.9.0'});
test('rejects unsafe deployment endpoints and placeholder values before writing', () => {
  for (const PUBLIC_IPV4 of ['127.0.0.1','100.100.100.100','192.168.1.1','203.0.113.2','::1']) assert.throws(()=>validateSettings({...settings(),PUBLIC_IPV4}));
  assert.throws(()=>validateSettings({...settings(),APP_DOMAIN:'voice.example.com'}));
  assert.throws(()=>validateSettings({...settings(),RTC_DOMAIN:settings().APP_DOMAIN}));
  assert.throws(()=>validateSettings({...settings(),MODEL_HOST:'8.8.8.8'}));
  assert.throws(()=>validateSettings({...settings(),NODE_BIN:'/usr/bin/../bin/node'}));
  assert.throws(()=>validateSettings({...settings(),LIVEKIT_VERSION:'latest'}));
  assert.throws(()=>parseEnv('NODE_BIN=/usr/bin/node\nNODE_BIN=/tmp/node'));
});
test('first configuration is protected, stable on repeat, and never silently rotates secrets or changes settings', () => {
  const dir=mkdtempSync(join(tmpdir(),'ptoy-cloud-config-'));
  try {
    const input=join(dir,'settings.env'),output=join(dir,'output');
    const write=s=>writeFileSync(input,Object.entries(s).map(([k,v])=>`${k}=${v}`).join('\n'));
    write(settings()); configure(input,output);
    const before=readFileSync(join(output,'app.env'),'utf8');
    configure(input,output);
    assert.equal(readFileSync(join(output,'app.env'),'utf8'),before);
    assert.equal(parseEnv(before).ACCESS_MAINTENANCE_DEFAULT,'true');
    assert.equal(parseEnv(before).CLOUD_MODEL_CHECKS,'true');
    if(process.platform!=='win32') assert.equal(statSync(join(output,'app.env')).mode&0o777,0o640);
    write({...settings(),APP_DOMAIN:'changed.ptoy-demo.dev'});
    assert.throws(()=>configure(input,output),/refusing automatic overwrite/);
    assert.equal(readFileSync(join(output,'app.env'),'utf8'),before);
    writeFileSync(join(output,'app.env'),before.replace(/^ACCESS_INTERNAL_SECRET=.*$/m,'ACCESS_INTERNAL_SECRET="short"'));
    write(settings());assert.throws(()=>configure(input,output),/refusing secret rotation/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('production config separates internal HTTP from explicitly advertised public media',()=>{
  const e=applicationEnv(settings());const yaml=livekitYaml(e);
  assert.match(yaml,/bind_addresses:\n  - 127\.0\.0\.1/);
  assert.match(yaml,/use_external_ip: false\n  node_ip: 8\.8\.8\.8/);
  assert.match(yaml,/udp_port: 7882/);assert.match(yaml,/turn:\n  enabled: false/);
  assert.equal(e.ACCESS_INTERNAL_URL,'http://127.0.0.1:8787');
  assert.equal(e.AGENT_HEALTH_HOST,'127.0.0.1');assert.equal(e.INVITE_DB_PATH,'/var/lib/ptoy/access.sqlite');
  assert.equal(e.TTS_BACKEND,'fastapi');assert.notEqual(e.LIVEKIT_API_SECRET,e.ACCESS_INTERNAL_SECRET);
});
test('operations authenticates locally, drains conservatively and permits offline-model service',async()=>{
  const original=globalThis.fetch;
  const env=applicationEnv(settings());let requests=[];
  try {
    globalThis.fetch=async(url,options)=>{
      requests.push({url,options});
      return Response.json({maintenance:options.method==='POST'?JSON.parse(options.body).enabled:true,activeCount:0,modelsReady:false});
    };
    const status=await operations('maintenance-off',env);
    assert.deepEqual(status,{maintenance:false,activeCount:0,modelsReady:false});
    assert.equal(requests[0].options.headers.Authorization,'Bearer '+env.ACCESS_INTERNAL_SECRET);
    assert.equal(requests[0].url,'http://127.0.0.1:8787/internal/ops/maintenance');
    assert.equal((await operations('wait-drain',env)).activeCount,0);
    globalThis.fetch=async()=>Response.json({maintenance:false,activeCount:1,modelsReady:true});
    await assert.rejects(operations('wait-drain',env),/Maintenance must remain enabled/);
    globalThis.fetch=async()=>new Response('',{status:503});
    await assert.rejects(operations('status',env),/503/);
    assert.throws(()=>validateStatus({maintenance:true,activeCount:-1,modelsReady:true}));
    await assert.rejects(operations('status',{...env,ACCESS_INTERNAL_URL:'http://remote.invalid'}),/Invalid local/);
  } finally {globalThis.fetch=original;}
});
