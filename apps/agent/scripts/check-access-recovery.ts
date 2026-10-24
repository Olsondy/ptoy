/** Real LiveKit fault checks. Requires LIVEKIT_SERVER_BIN; never reads the runtime .env or real character files. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { createServer as createHttpServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Room, RoomEvent, AudioSource, AudioFrame, LocalAudioTrack, TrackPublishOptions, TrackSource } from '@livekit/rtc-node';
import { ParticipantInfo_State, RoomServiceClient } from 'livekit-server-sdk';
import { loadTokenServerConfig } from '../src/config.js';
import type { TokenResponse } from '../src/token-server.js';
import { AccessStore } from '../src/access/store.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const agentDir = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'ptoy-recovery-'));
const children = new Set<ChildProcess>();
const callers: Array<() => Promise<void>> = [];
const selected = new Set((process.env.RECOVERY_CASES ?? 'api,crash,lost,cleanup,cleanup-restart').split(','));
const freePort = async () => {
  const server = createTcpServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
};
async function until(check: () => boolean | Promise<boolean>, message: string, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await sleep(100); }
  throw new Error('Timed out: ' + message);
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    await new Promise<void>(resolve => { const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true}); killer.once('exit',()=>resolve()); });
  } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
  await until(() => child.exitCode !== null || child.signalCode !== null, 'test child exit', 5000);
  children.delete(child);
}
let apiChild: ChildProcess | undefined; let proxy: Server | undefined; let store: AccessStore | undefined;
async function main() {
  if([...selected].some(name=>!['api','crash','lost','cleanup','cleanup-restart'].includes(name))) throw new Error('Unknown RECOVERY_CASES selection');
  const binary=process.env.LIVEKIT_SERVER_BIN;
  if (!binary) throw new Error('Set LIVEKIT_SERVER_BIN to the local LiveKit executable');
  const [lkPort,tcpPort,udpPort,apiPort,proxyPort]=await Promise.all(Array.from({length:5},()=>freePort()));
  const livekitUrl=`ws://127.0.0.1:${lkPort}`;
  const base=`http://127.0.0.1:${apiPort}`;
  const env: NodeJS.ProcessEnv={...process.env, LIVEKIT_URL:livekitUrl, LIVEKIT_PUBLIC_URL:livekitUrl,
    LIVEKIT_API_KEY:'devkey',LIVEKIT_API_SECRET:'secret',AGENT_PIPELINE:'echo',LIVEKIT_AGENT_NAME:'',
    APP_ORIGIN:'http://localhost',INVITE_DB_PATH:join(scratch,'access.sqlite'),
    CHARACTERS_DIR:fileURLToPath(new URL('../../../tests/e2e/fixtures/characters',import.meta.url)),DEFAULT_CHARACTER:'xiaoyou',
    ACCESS_INTERNAL_URL:`http://127.0.0.1:${proxyPort}`,ACCESS_INTERNAL_SECRET:'recovery-test-internal-secret-32-chars',
    TOKEN_SERVER_HOST:'127.0.0.1',TOKEN_SERVER_PORT:String(apiPort),
    ACCESS_COOKIE_SECURE:'false',ACCESS_PENDING_TIMEOUT_MS:'15000',ACCESS_AGENT_TIMEOUT_MS:'10000',ACCESS_RECONCILE_MS:'1000',
    RECOVERY_SIGNAL_DIR:scratch,RECOVERY_CLEANUP_MS:'0',LOG_LEVEL:'info'};
  const config=loadTokenServerConfig(env);
  const lk=spawn(binary,['--dev','--bind','127.0.0.1'],{env:{...env,LIVEKIT_CONFIG:`port: ${lkPort}\nrtc:\n  tcp_port: ${tcpPort}\n  udp_port: ${udpPort}\n`},stdio:'ignore',windowsHide:true,detached:process.platform!=='win32'}); children.add(lk);
  await until(async()=>{try{return(await fetch(livekitUrl.replace('ws:','http:'))).ok}catch{return false}},'LiveKit startup');
  const rooms=new RoomServiceClient(livekitUrl.replace('ws:','http:'),'devkey','secret');
  const startApi=async()=>{
    store=new AccessStore(config.access.dbPath);
    let logs='';
    apiChild=spawn(process.execPath,[fileURLToPath(import.meta.resolve('tsx/cli')),'src/token-server.ts'],{
      cwd:agentDir,env,stdio:['ignore','pipe','pipe'],windowsHide:true,detached:process.platform!=='win32'});
    children.add(apiChild);
    for(const stream of [apiChild.stdout,apiChild.stderr])stream!.on('data',data=>{logs=(logs+String(data)).slice(-10000);});
    await until(async()=>{
      if(apiChild!.exitCode!==null)throw new Error('API process exited: '+logs.slice(-2000));
      try{return(await fetch(base+'/healthz')).ok}catch{return false;}
    },'API process startup');
  };
  const stopApi=async()=>{await kill(apiChild!);apiChild=undefined;store!.close();store=undefined;};
  await startApi();
  let loseNextAdmission=false; let lostResponse=false;
  proxy=createHttpServer(async(req,res)=>{
    try {
      const parts:Buffer[]=[]; for await(const part of req) parts.push(part as Buffer);
      const upstream=await fetch(base+req.url,{method:req.method,headers:{Authorization:req.headers.authorization??'','Content-Type':'application/json'},body:Buffer.concat(parts),signal:AbortSignal.timeout(5000)});
      const body=await upstream.text();
      if(loseNextAdmission&&req.url==='/internal/access/admit'&&upstream.ok){loseNextAdmission=false;lostResponse=true;res.destroy();return;}
      res.writeHead(upstream.status,{'Content-Type':'application/json'});res.end(body);
    }catch{res.writeHead(503,{'Content-Type':'application/json'});res.end('{"code":"offline"}');}
  });
  await new Promise<void>(resolve=>proxy!.listen(proxyPort,'127.0.0.1',resolve));
  const startWorker=async(cleanupMs=0)=>{
    let logs='';
    const child=spawn(process.execPath,[fileURLToPath(import.meta.resolve('tsx/cli')),'test/access-recovery-agent.ts','dev'],{
      cwd:agentDir,env:{...env,RECOVERY_CLEANUP_MS:String(cleanupMs)},stdio:['ignore','pipe','pipe'],windowsHide:true,detached:process.platform!=='win32'});
    children.add(child);
    for(const stream of [child.stdout,child.stderr])stream!.on('data',data=>{logs=(logs+String(data)).slice(-40000);});
    await until(()=>{if(child.exitCode!==null)throw new Error('Worker exited: '+logs.slice(-2000));return logs.includes('registered worker')},'worker registration');
    return child;
  };
  const post=async(path:string,body:unknown,cookie='')=>fetch(base+path,{method:'POST',headers:{Origin:config.access.origin,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});
  const friend=async()=>{
    const invite=store!.createInvite('fault-check');const response=await post('/api/invite/redeem',{code:invite.code});assert.equal(response.status,200);
    return response.headers.get('set-cookie')!.split(';')[0]!;
  };
  const state=(id:string)=>store!.attempt(id)?.state;
  const begin=async(cookie:string)=>{
    const requestId=randomUUID();const response=await post('/api/token',{requestId},cookie);assert.equal(response.status,200);
    const token=await response.json() as TokenResponse;
    const room=new Room();let audioTracks=0;room.on(RoomEvent.TrackSubscribed,()=>{audioTracks++;});
    await room.connect(token.serverUrl,token.participantToken,{autoSubscribe:true,dynacast:false});
    const source=new AudioSource(48000,1,100);const track=LocalAudioTrack.createAudioTrack('fixture-mic',source);
    await room.localParticipant!.publishTrack(track,new TrackPublishOptions({source:TrackSource.SOURCE_MICROPHONE}));
    let pumping=true;const pump=(async()=>{try{while(pumping){await source.captureFrame(new AudioFrame(new Int16Array(960),48000,1,960));}}catch{}})();
    let closed=false;const close=async()=>{if(closed)return;closed=true;pumping=false;await source.close();await track.close();await room.disconnect();await pump;};callers.push(close);
    return{token,requestId,room,close,audio:()=>audioTracks};
  };
  const busy=async(cookie:string)=>assert.equal((await post('/api/token',{requestId:randomUUID()},cookie)).status,409);
  const cancel=async(call:Awaited<ReturnType<typeof begin>>,cookie:string)=>{assert.equal((await post('/api/calls/cancel',{requestId:call.requestId},cookie)).status,200);await call.close();};

  let worker=await startWorker();
  if(selected.has('api')) {
    const cookie=await friend();const call=await begin(cookie);await until(()=>state(call.token.attemptId)==='established'&&call.audio()>0,'established echo');
    await stopApi();await sleep(4000);await startApi();
    assert.equal(state(call.token.attemptId),'established');await busy(cookie);
    await until(()=>Date.now()-(store!.attempt(call.token.attemptId)?.heartbeatAt??0)<3500,'heartbeat after API restart');
    assert.equal((await rooms.getParticipant(call.token.roomName,call.token.participantName)).state,ParticipantInfo_State.ACTIVE);
    assert(call.audio()>0);
    await cancel(call,cookie);await until(()=>state(call.token.attemptId)==='ended','finish after API restart');
    console.log('PASS API restart: persisted session/attempt, existing echo, second call rejected, heartbeat/cleanup recover');
  }
  if(selected.has('crash')) {
    const cookie=await friend();const call=await begin(cookie);await until(()=>state(call.token.attemptId)==='established'&&call.audio()>0,'echo before hard kill');
    await kill(worker);await busy(cookie);
    await until(()=>state(call.token.attemptId)==='ended','Agent hard crash reconciliation',30000);
    assert.equal((await rooms.listParticipants(call.token.roomName).catch(()=>[])).length,0);
    const response=await post('/api/token',{requestId:randomUUID()},cookie);assert.equal(response.status,200);
    store!.cancel((await response.json() as TokenResponse).attemptId);await call.close();
    console.log('PASS Agent hard kill: slot held initially, orphan room closed, slot reusable after live reconciliation');
  }
  await kill(worker);
  if(selected.has('lost')) {
    worker=await startWorker();
    const cookie=await friend();loseNextAdmission=true;lostResponse=false;const call=await begin(cookie);
    await until(()=>lostResponse,'successful admission response deliberately dropped');
    assert.equal(state(call.token.attemptId),'established');await busy(cookie);
    await until(()=>state(call.token.attemptId)==='ended','lost-admission cleanup recovery',30000);
    assert.equal(call.audio(),0);await call.close();
    console.log('PASS lost admission response: no echo pipeline, no concurrent admission, automatic recovery');
  }
  await kill(worker);
  if(selected.has('cleanup')) {
    worker=await startWorker(15000);
    const cookie=await friend();const call=await begin(cookie);await until(()=>state(call.token.attemptId)==='established'&&call.audio()>0,'echo before slow cleanup');
    await cancel(call,cookie);const started=join(scratch,`${call.token.roomName}.cleanup-start`);const done=join(scratch,`${call.token.roomName}.cleanup-done`);
    await until(()=>existsSync(started),'slow cleanup started');
    await sleep(11500);assert.equal(existsSync(done),false);assert.equal(state(call.token.attemptId),'ending');await busy(cookie);
    await until(()=>existsSync(done)&&state(call.token.attemptId)==='ended','slow cleanup completed',15000);
    console.log('PASS slow cleanup: 15-second cleanup exceeds 10-second stale threshold; slot held until cleanup finishes');
  }
  await kill(worker);
  if(selected.has('cleanup-restart')) {
    worker=await startWorker(20000);
    const cookie=await friend();const call=await begin(cookie);await until(()=>state(call.token.attemptId)==='established'&&call.audio()>0,'echo before combined fault');
    await cancel(call,cookie);
    const started=join(scratch,`${call.token.roomName}.cleanup-start`);const done=join(scratch,`${call.token.roomName}.cleanup-done`);
    await until(()=>existsSync(started),'combined slow cleanup started');
    await stopApi();await sleep(12000);await startApi();
    assert.equal(existsSync(done),false);await busy(cookie);
    await sleep(3500);assert.equal(existsSync(done),false);assert.equal(state(call.token.attemptId),'ending');await busy(cookie);
    await until(()=>existsSync(done)&&state(call.token.attemptId)==='ended','cleanup after prolonged API restart',15000);
    console.log('PASS cleanup + API restart: stale persisted lease not reclaimed before surviving Agent renews and completes cleanup');
    await kill(worker);
  }
  await stopApi();proxy.closeAllConnections();await new Promise<void>(resolve=>proxy!.close(()=>resolve()));proxy=undefined;
  await kill(lk);
}
let failure: unknown;
try { await main(); }
catch(error) { failure=error; }
finally {
  for(const close of callers)await close().catch(()=>undefined);
  if(proxy){proxy.closeAllConnections();await new Promise<void>(resolve=>proxy!.close(()=>resolve()));}
  if(apiChild)await kill(apiChild);
  store?.close();
  for(const child of children)await kill(child).catch(()=>undefined);
  const cleanupPath=realpathSync(scratch);
  assert(cleanupPath.startsWith(realpathSync(tmpdir())+sep)&&basename(cleanupPath).startsWith('ptoy-recovery-'));
  rmSync(cleanupPath,{recursive:true,force:true});
}
// rtc-node keeps its native runtime alive after Room cleanup (same as sim-call).
if(failure){console.error(failure);process.exit(1);}
console.log('PASS harness cleanup: owned services stopped and temporary database removed');
process.exit(0);
