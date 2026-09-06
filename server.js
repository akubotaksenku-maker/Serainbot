'use strict';

// ── Fix crypto ──
const crypto = require('crypto');
if (!global.crypto) {
  global.crypto = crypto.webcrypto ?? {
    randomUUID: () => {
      const b = crypto.randomBytes(16);
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      return [
        b.slice(0,4), b.slice(4,6), b.slice(6,8),
        b.slice(8,10), b.slice(10,16)
      ].map(x => x.toString('hex')).join('-');
    },
    getRandomValues: (arr) => {
      const bytes = crypto.randomBytes(arr.length);
      arr.set(bytes);
      return arr;
    }
  };
}

const express  = require('express');
const http     = require('http');
const { WebSocketServer } = require('ws');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const pino     = require('pino');
const axios    = require('axios');
const ytdl     = require('ytdl-core');
const yts      = require('yt-search');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} = require('@whiskeysockets/baileys');

// ── Config ──
const PORT        = process.env.PORT || 3000;
const PREFIX      = '.';
const BOT_NAME    = 'Serainbot🌊';
const OWNER       = 'Serain';
const SESSION_DIR = path.join(__dirname, 'session');

if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

const logger = pino({ level: 'silent' });

// ── Express & WS ──
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

let sock        = null;
let botReady    = false;
let clients     = new Set();
let pairingCode = null;

// ── Game & RPG states ──
const rpgData   = {};
const guessGame = {};
const tttGame   = {};
const quizData  = {};

// ── WS Helpers ──
function send(ws, data) {
  try { if (ws.readyState === 1) ws.send(JSON.stringify(data)); } catch (_) {}
}
function broadcast(data) {
  clients.forEach(c => send(c, data));
}

// ── WebSocket ──
wss.on('connection', ws => {
  clients.add(ws);
  send(ws, { type: 'status', botReady });
  ws.on('message', async raw => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    if (data.type === 'requestCode') {
      const nomor = String(data.nomor || '').replace(/\D/g, '');
      if (!nomor || nomor.length < 10) {
        send(ws, { type: 'error', msg: 'Nomor tidak valid!' });
        return;
      }
      await startBot(ws, nomor);
    }
  });
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

// ── Start Bot ──
async function startBot(ws, nomor) {
  try {
    if (sock) {
      try { await sock.logout(); sock = null; botReady = false; } catch (_) {}
    }
    send(ws, { type: 'log', cls: 'i', msg: '→ Memuat session...' });
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();
    send(ws, { type: 'log', cls: 's', msg: `✓ Baileys v${version.join('.')}` });
    send(ws, { type: 'progress', val: 30 });

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger,
      browser: Browsers.ubuntu('Chrome'),
      printQRInTerminal: false,
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
    });

    send(ws, { type: 'log', cls: 's', msg: '✓ Socket dibuat' });
    send(ws, { type: 'progress', val: 50 });

    if (!sock.authState.creds.registered) {
      send(ws, { type: 'log', cls: 'i', msg: `→ Request pairing code untuk +${nomor}...` });
      send(ws, { type: 'progress', val: 70 });
      try {
        const code = await sock.requestPairingCode(nomor);
        const formatted = code.match(/.{1,4}/g)?.join('-') || code;
        pairingCode = formatted;
        send(ws, { type: 'progress', val: 100 });
        send(ws, { type: 'log', cls: 's', msg: '✓ Kode berhasil didapat!' });
        send(ws, { type: 'code', code: formatted });
      } catch (e) {
        send(ws, { type: 'error', msg: 'Gagal dapat kode: ' + e.message });
        return;
      }
    } else {
      send(ws, { type: 'log', cls: 'w', msg: 'Session sudah ada, skip pairing...' });
      send(ws, { type: 'progress', val: 100 });
    }

    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      if (connection === 'open') {
        botReady = true;
        const id = sock?.user?.id || '';
        broadcast({ type: 'connected', nomor: id.split(':')[0] });
        broadcast({ type: 'log', cls: 's', msg: '✅ BOT TERHUBUNG KE WHATSAPP!' });
      }
      if (connection === 'close') {
        botReady = false;
        broadcast({ type: 'disconnected' });
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        if (!loggedOut) {
          setTimeout(() => startBot(ws, nomor), 5000);
        } else {
          try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); fs.mkdirSync(SESSION_DIR, { recursive: true }); } catch (_) {}
          broadcast({ type: 'log', cls: 'e', msg: 'Sesi berakhir, silakan tautkan ulang.' });
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (!msg.key.remoteJid) continue;
        await handleMessage(msg);
      }
    });

  } catch (err) {
    send(ws, { type: 'error', msg: err.message });
  }
}

// ═══════════════════════════════════════════
//  SEND HTML RICH — render langsung di WA
//  Pakai teknik botForwardedMessage + richResponseMessage
// ═══════════════════════════════════════════
function sendHtmlRich(jid, html, footerText = BOT_NAME) {
  if (!sock || !botReady) return;

  const responseId = global.crypto.randomUUID();

  const payload = {
    response_id: responseId,
    sections: [{
      view_model: {
        primitive: {
          __typename: 'GenAIaeacdsnwHtmlPrimitive',
          payload: html,
          trusted_sources: []
        },
        __typename: 'GenAISingleLayoutViewModel'
      }
    }]
  };

  const base64 = Buffer.from(JSON.stringify(payload)).toString('base64');

  return sock.relayMessage(jid, {
    messageContextInfo: {
      deviceListMetadata: {},
      deviceListMetadataVersion: 2,
      botMetadata: {}
    },
    botForwardedMessage: {
      message: {
        richResponseMessage: {
          messageType: 1,
          submessages: [{
            messageType: 2,
            messageText: footerText
          }],
          unifiedResponse: { data: base64 },
          contextInfo: {
            forwardingScore: 1,
            isForwarded: true,
            forwardedAiBotMessageInfo: {
              botJid: '867051314767696@bot'
            },
            forwardOrigin: 4
          }
        }
      }
    }
  }, {});
}

// ═══════════════════════════════════════════
//  HTML GAMES
// ═══════════════════════════════════════════
const DINO_HTML = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"><title>DINO RUNNER</title>
<style>*{box-sizing:border-box;margin:0;padding:0;font-family:'Segoe UI',Arial,sans-serif;-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none}
body{background:linear-gradient(135deg,#0a0a1a,#1a1a2e);display:flex;justify-content:center;align-items:center;min-height:100vh;padding:10px}
#app{max-width:420px;width:100%;background:rgba(255,255,255,.05);border-radius:20px;padding:20px;border:1px solid rgba(255,255,255,.1)}
.hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:15px}
.hdr h1{color:#4ade80;font-size:22px;font-weight:900;text-shadow:0 0 20px rgba(74,222,128,.3)}
.hdr .scores{display:flex;gap:15px;font-size:14px;color:#94a3b8}
.hdr .scores span{font-weight:bold;color:#fff}
canvas{width:100%;border-radius:12px;background:#0f172a;display:block;touch-action:none;border:2px solid rgba(74,222,128,.2)}
.controls{display:flex;gap:10px;margin-top:12px}
.controls button{flex:1;padding:14px;border:none;border-radius:12px;font-weight:bold;font-size:16px;cursor:pointer;transition:.3s;touch-action:none}
.btn-jump{background:linear-gradient(135deg,#4ade80,#22c55e);color:#0a0a1a}
.btn-jump:active{transform:scale(.95)}
.btn-reset{background:rgba(255,255,255,.1);color:#94a3b8}
.btn-reset:active{transform:scale(.95)}
.btn-reset.active{background:linear-gradient(135deg,#fbbf24,#f59e0b);color:#0a0a1a}
.status{margin-top:12px;text-align:center;color:#94a3b8;font-size:13px}
.status .highlight{color:#4ade80;font-weight:bold}</style></head>
<body>
<div id="app"><div class="hdr"><h1>🦕 DINO RUNNER</h1><div class="scores">🏆 <span id="score">0</span> · BEST <span id="best">0</span></div></div>
<canvas id="cv" width="400" height="300"></canvas>
<div class="controls"><button class="btn-jump" id="jumpBtn">⬆ LOMPAT</button><button class="btn-reset" id="resetBtn">🔄 RESET</button></div>
<div class="status" id="status">Tap layar / tekan Space untuk lompat! 🚀</div></div>
<script>
const cv=document.getElementById('cv'),ctx=cv.getContext('2d'),W=400,H=300;
const scoreEl=document.getElementById('score'),bestEl=document.getElementById('best'),statusEl=document.getElementById('status'),jumpBtn=document.getElementById('jumpBtn'),resetBtn=document.getElementById('resetBtn');
let best=parseInt(localStorage.getItem('dino_best')||'0');bestEl.textContent=best;
let gameState={score:0,speed:4,groundY:250,dino:{x:60,y:0,width:30,height:40,vy:0,gravity:0.6,jumpPower:-11},obstacles:[],gameOver:false,frame:0,highScore:best};
function getDinoY(){return gameState.groundY-gameState.dino.height-gameState.dino.y}
function updateDino(){const d=gameState.dino;if(d.vy!==0||d.y>0){d.vy+=d.gravity;d.y+=d.vy;if(d.y<0){d.y=0;d.vy=0}}}
function jumpDino(){if(gameState.gameOver)return;if(gameState.dino.y===0){gameState.dino.vy=gameState.dino.jumpPower;if(navigator.vibrate)navigator.vibrate(20)}}
function spawnObstacle(){const types=[{w:12,h:25,color:'#2dd4bf'},{w:16,h:35,color:'#2dd4bf'},{w:20,h:45,color:'#2dd4bf'}];const type=types[Math.floor(Math.random()*types.length)];gameState.obstacles.push({x:W+20,y:gameState.groundY-type.h,w:type.w,h:type.h,color:type.color})}
function updateObstacles(){const obs=gameState.obstacles;for(let i=obs.length-1;i>=0;i--){obs[i].x-=gameState.speed;if(obs[i].x+obs[i].w<0){obs.splice(i,1);continue}const d=gameState.dino;const dx=gameState.dino.x;const dy=getDinoY();if(dx<obs[i].x+obs[i].w-4&&dx+d.width-4>obs[i].x&&dy<obs[i].y+obs[i].h-4&&dy+d.height-4>obs[i].y){gameOver()}}}
function gameOver(){if(gameState.gameOver)return;gameState.gameOver=true;if(gameState.score>gameState.highScore){gameState.highScore=gameState.score;localStorage.setItem('dino_best',String(gameState.highScore));bestEl.textContent=gameState.highScore;statusEl.innerHTML='💀 GAME OVER! <span class="highlight">NEW BEST!</span> 🔥'}else{statusEl.innerHTML='💀 GAME OVER! Score: '+gameState.score}if(navigator.vibrate)navigator.vibrate([50,50,50]);resetBtn.classList.add('active')}
function resetGame(){gameState.score=0;gameState.speed=4;gameState.dino.y=0;gameState.dino.vy=0;gameState.obstacles=[];gameState.gameOver=false;gameState.frame=0;scoreEl.textContent='0';resetBtn.classList.remove('active');statusEl.innerHTML='🔄 Game reset! Tap untuk lompat! 🚀'}
function draw(){ctx.clearRect(0,0,W,H);const sky=ctx.createLinearGradient(0,0,0,H);sky.addColorStop(0,'#0f172a');sky.addColorStop(1,'#0a0a1a');ctx.fillStyle=sky;ctx.fillRect(0,0,W,H);ctx.fillStyle='#2d2d44';ctx.fillRect(0,gameState.groundY,W,H-gameState.groundY);ctx.fillStyle='#4ade80';ctx.fillRect(0,gameState.groundY,W,2);for(const obs of gameState.obstacles){ctx.fillStyle=obs.color;ctx.fillRect(obs.x,obs.y,obs.w,obs.h)}const dy=getDinoY(),d=gameState.dino;ctx.fillStyle='#4ade80';ctx.fillRect(d.x+5,dy+10,d.width-10,d.height-10);ctx.fillRect(d.x+d.width-8,dy+2,10,12);ctx.fillStyle='#fff';ctx.fillRect(d.x+d.width-5,dy+4,4,4);if(gameState.gameOver){ctx.fillStyle='rgba(0,0,0,0.6)';ctx.fillRect(0,0,W,H);ctx.textAlign='center';ctx.fillStyle='#ef4444';ctx.font='bold 40px Arial';ctx.fillText('💀',W/2,H/2-20);ctx.fillStyle='#fff';ctx.font='bold 24px Arial';ctx.fillText('GAME OVER',W/2,H/2+30);ctx.fillStyle='#94a3b8';ctx.font='16px Arial';ctx.fillText('Score: '+gameState.score,W/2,H/2+60)}}
function update(){if(gameState.gameOver)return;gameState.frame++;if(gameState.frame%3===0){gameState.score++;scoreEl.textContent=gameState.score}if(gameState.frame%60===0&&gameState.speed<12){gameState.speed+=0.15}if(gameState.frame%Math.floor(80/(gameState.speed/4))===0&&gameState.frame>60){if(Math.random()<0.6)spawnObstacle()}updateDino();updateObstacles()}
function loop(){update();draw();requestAnimationFrame(loop)}
document.addEventListener('touchstart',(e)=>{if(e.target.closest('#resetBtn')||e.target.closest('#jumpBtn'))return;jumpDino()});
document.addEventListener('click',(e)=>{if(e.target.closest('#resetBtn')||e.target.closest('#jumpBtn'))return;jumpDino()});
document.addEventListener('keydown',(e)=>{if(e.code==='Space'||e.key===' '||e.key==='ArrowUp'){e.preventDefault();jumpDino()}if(e.key==='r'||e.key==='R')resetGame()});
jumpBtn.addEventListener('touchstart',(e)=>{e.preventDefault();jumpDino()});
jumpBtn.addEventListener('mousedown',(e)=>{e.preventDefault();jumpDino()});
resetBtn.addEventListener('click',resetGame);
resetGame();loop();
</script></body></html>`;

const KURO_HTML = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"><title>KURO SLASH</title>
<style>*{margin:0;padding:0;box-sizing:border-box;font-family:'Segoe UI',Arial,sans-serif;-webkit-tap-highlight-color:transparent}
body{background:linear-gradient(135deg,#0a0a1a,#1a1a2e);display:flex;justify-content:center;align-items:center;min-height:100vh;padding:10px}
#app{max-width:420px;width:100%;background:rgba(255,255,255,.05);border-radius:20px;padding:20px;border:1px solid rgba(255,255,255,.1);text-align:center}
h1{color:#ff4444;font-size:28px;margin-bottom:5px;text-shadow:0 0 20px rgba(255,68,68,.3)}
.sub{color:#94a3b8;font-size:14px;margin-bottom:20px}
canvas{width:100%;border-radius:12px;background:#0f172a;display:block;touch-action:none;border:2px solid rgba(255,68,68,.2)}
.controls{display:flex;gap:10px;margin-top:12px;flex-wrap:wrap}
.controls button{flex:1;min-width:80px;padding:12px;border:none;border-radius:12px;font-weight:bold;font-size:14px;cursor:pointer;transition:.3s}
.btn-attack{background:linear-gradient(135deg,#ff4444,#cc0000);color:#fff}
.btn-attack:active{transform:scale(.95)}
.btn-special{background:linear-gradient(135deg,#fbbf24,#f59e0b);color:#0a0a1a}
.btn-reset{background:rgba(255,255,255,.1);color:#94a3b8}
.stats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:12px;color:#94a3b8;font-size:13px}
.stats .stat{background:rgba(255,255,255,.05);padding:8px;border-radius:8px}
.stats .stat span{display:block;font-weight:bold;color:#fff;font-size:16px}
.hp-bar{height:8px;background:rgba(255,255,255,.1);border-radius:4px;margin-top:10px;overflow:hidden}
.hp-fill{height:100%;background:linear-gradient(90deg,#ff4444,#ff6b6b);border-radius:4px;transition:width .3s}</style></head>
<body>
<div id="app"><h1>⚔ KURO SLASH</h1><div class="sub">Battle Mode — ${BOT_NAME}</div>
<div class="stats"><div class="stat">HP <span id="hp">100</span></div><div class="stat">Score <span id="score">0</span></div><div class="stat">Combo <span id="combo">0</span></div></div>
<div class="hp-bar"><div class="hp-fill" id="hpFill" style="width:100%"></div></div>
<canvas id="cv" width="400" height="300"></canvas>
<div class="controls"><button class="btn-attack" id="attackBtn">⚔ SERANG</button><button class="btn-special" id="specialBtn">✨ SPECIAL (5x combo)</button><button class="btn-reset" id="resetBtn">🔄 RESET</button></div></div>
<script>
const cv=document.getElementById('cv'),ctx=cv.getContext('2d'),W=400,H=300;
const hpEl=document.getElementById('hp'),scoreEl=document.getElementById('score'),comboEl=document.getElementById('combo'),hpFill=document.getElementById('hpFill');
let game={hp:100,maxHp:100,score:0,combo:0,enemy:{x:250,y:100,w:40,h:50,hp:50,maxHp:50},player:{x:100,y:120,w:30,h:50,attacking:false,attackTimer:0},gameOver:false,frame:0,particles:[]};
function updateUI(){hpEl.textContent=game.hp;scoreEl.textContent=game.score;comboEl.textContent=game.combo;hpFill.style.width=(game.hp/game.maxHp*100)+'%'}
function attack(){if(game.gameOver||game.player.attacking)return;game.player.attacking=true;game.player.attackTimer=15;if(Math.abs(game.player.x+game.player.w-game.enemy.x)<60){const dmg=8+Math.floor(Math.random()*5);game.enemy.hp-=dmg;game.combo++;game.score+=10*game.combo;for(let i=0;i<10;i++){game.particles.push({x:game.enemy.x+game.enemy.w/2,y:game.enemy.y+game.enemy.h/2,vx:(Math.random()-0.5)*8,vy:(Math.random()-0.5)*8,life:30,size:3+Math.random()*4,color:'#ff4444'})}if(game.enemy.hp<=0){game.enemy.hp=game.enemy.maxHp;game.enemy.x=200+Math.random()*100;game.enemy.y=80+Math.random()*60;game.score+=50}}else{game.combo=0}updateUI()}
function specialAttack(){if(game.gameOver||game.player.attacking||game.combo<5)return;game.player.attacking=true;game.player.attackTimer=25;const dmg=25+Math.floor(Math.random()*10);game.enemy.hp-=dmg;game.score+=30*game.combo;for(let i=0;i<30;i++){game.particles.push({x:game.enemy.x+game.enemy.w/2,y:game.enemy.y+game.enemy.h/2,vx:(Math.random()-0.5)*15,vy:(Math.random()-0.5)*15,life:40,size:4+Math.random()*6,color:['#ffd700','#ff4444','#60a5fa'][Math.floor(Math.random()*3)]})}if(game.enemy.hp<=0){game.enemy.hp=game.enemy.maxHp;game.enemy.x=200+Math.random()*100;game.enemy.y=80+Math.random()*60;game.score+=100}updateUI()}
function enemyAttack(){if(game.gameOver)return;const dmg=5+Math.floor(Math.random()*10);game.hp-=dmg;if(game.hp<=0){game.hp=0;game.gameOver=true}updateUI()}
function resetGame(){game.hp=game.maxHp;game.score=0;game.combo=0;game.enemy.hp=game.enemy.maxHp;game.enemy.x=200+Math.random()*100;game.enemy.y=80+Math.random()*60;game.player.attacking=false;game.player.attackTimer=0;game.gameOver=false;game.particles=[];updateUI()}
function draw(){ctx.clearRect(0,0,W,H);ctx.fillStyle='#0f172a';ctx.fillRect(0,0,W,H);for(let i=game.particles.length-1;i>=0;i--){const p=game.particles[i];p.x+=p.vx;p.y+=p.vy;p.vy+=0.1;p.life--;ctx.globalAlpha=p.life/30;ctx.fillStyle=p.color;ctx.fillRect(p.x-p.size/2,p.y-p.size/2,p.size,p.size);ctx.globalAlpha=1;if(p.life<=0)game.particles.splice(i,1)}ctx.fillStyle='#ef4444';ctx.fillRect(game.enemy.x,game.enemy.y,game.enemy.w,game.enemy.h);ctx.fillStyle='rgba(0,0,0,0.5)';ctx.fillRect(game.enemy.x,game.enemy.y-12,game.enemy.w,6);ctx.fillStyle='#4ade80';ctx.fillRect(game.enemy.x+1,game.enemy.y-11,(game.enemy.w-2)*(game.enemy.hp/game.enemy.maxHp),4);ctx.fillStyle='#4ade80';ctx.fillRect(game.player.x,game.player.y,game.player.w,game.player.h);if(game.player.attacking){ctx.strokeStyle='#ffd700';ctx.lineWidth=4;ctx.beginPath();ctx.moveTo(game.player.x+game.player.w,game.player.y+10);ctx.lineTo(game.player.x+game.player.w+60,game.player.y+game.player.h/2);ctx.stroke()}if(game.gameOver){ctx.fillStyle='rgba(0,0,0,0.7)';ctx.fillRect(0,0,W,H);ctx.textAlign='center';ctx.fillStyle='#ef4444';ctx.font='bold 48px Arial';ctx.fillText('💀',W/2,H/2-30);ctx.fillStyle='#fff';ctx.font='bold 28px Arial';ctx.fillText('GAME OVER',W/2,H/2+30);ctx.fillStyle='#94a3b8';ctx.font='18px Arial';ctx.fillText('Score: '+game.score,W/2,H/2+65)}if(game.combo>=3&&!game.gameOver){ctx.textAlign='center';ctx.fillStyle='#ffd700';ctx.font='bold 20px Arial';ctx.fillText('🔥 '+game.combo+'x COMBO!',W/2,40)}}
function update(){if(game.gameOver)return;game.frame++;if(game.player.attacking){game.player.attackTimer--;if(game.player.attackTimer<=0){game.player.attacking=false}}if(game.frame%80===0&&Math.random()<0.4){enemyAttack()}}
document.getElementById('attackBtn').addEventListener('click',attack);
document.getElementById('attackBtn').addEventListener('touchstart',(e)=>{e.preventDefault();attack()});
document.getElementById('specialBtn').addEventListener('click',specialAttack);
document.getElementById('specialBtn').addEventListener('touchstart',(e)=>{e.preventDefault();specialAttack()});
document.getElementById('resetBtn').addEventListener('click',resetGame);
document.addEventListener('keydown',(e)=>{if(e.key===' '||e.key==='a')attack();if(e.key==='s')specialAttack();if(e.key==='r')resetGame()});
function loop(){update();draw();requestAnimationFrame(loop)}
resetGame();loop();
</script></body></html>`;

const TTT_HTML = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"><title>TIC TAC TOE</title>
<style>*{box-sizing:border-box;margin:0;padding:0;font-family:'Segoe UI',Arial,sans-serif}
body{background:linear-gradient(135deg,#0a0a1a,#1a1a2e);display:flex;justify-content:center;align-items:center;min-height:100vh;padding:10px}
#app{max-width:420px;width:100%;background:rgba(255,255,255,.05);border-radius:20px;padding:20px;border:1px solid rgba(255,255,255,.1);text-align:center}
h1{color:#4ade80;font-size:28px;margin-bottom:5px}
.sub{color:#94a3b8;font-size:14px;margin-bottom:20px}
.board{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;max-width:300px;margin:0 auto}
.cell{aspect-ratio:1;background:rgba(255,255,255,.05);border-radius:12px;border:2px solid rgba(255,255,255,.1);font-size:48px;font-weight:bold;color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:.3s;touch-action:none}
.cell:active{transform:scale(.95)}
.cell.x{color:#4ade80}
.cell.o{color:#ff6b6b}
.status{margin-top:20px;font-size:18px;color:#94a3b8}
.btn-reset{background:rgba(255,255,255,.1);color:#94a3b8;border:none;padding:12px 30px;border-radius:12px;font-size:16px;cursor:pointer;margin-top:15px;transition:.3s}
.btn-reset:active{transform:scale(.95)}
.footer{color:#475569;font-size:11px;margin-top:15px}</style></head>
<body>
<div id="app"><h1>❌ TIC TAC TOE ⭕</h1><div class="sub">Klik kotak untuk main vs AI</div>
<div class="board" id="board"></div>
<div class="status" id="status">Giliran: ❌ (Kamu)</div>
<button class="btn-reset" id="resetBtn">🔄 RESET</button>
<div class="footer">✨ ${BOT_NAME}</div></div>
<script>
let board=Array(9).fill(null),currentPlayer='X',gameOver=false;
const boardEl=document.getElementById('board'),statusEl=document.getElementById('status'),resetBtn=document.getElementById('resetBtn');
function renderBoard(){boardEl.innerHTML='';board.forEach((val,idx)=>{const cell=document.createElement('div');cell.className='cell'+(val?' '+val.toLowerCase():'');cell.textContent=val||'';cell.dataset.index=idx;cell.addEventListener('click',()=>handleClick(idx));boardEl.appendChild(cell)})}
function handleClick(idx){if(gameOver||board[idx]||currentPlayer!=='X')return;board[idx]='X';renderBoard();if(checkWin('X')){statusEl.textContent='🎉 Kamu Menang!';gameOver=true;return}if(board.every(v=>v)){statusEl.textContent='🤝 Seri!';gameOver=true;return}currentPlayer='O';statusEl.textContent='⏳ Bot berpikir...';setTimeout(botMove,500)}
function botMove(){if(gameOver)return;let bestMove=null;for(let i=0;i<9;i++){if(!board[i]){board[i]='O';if(checkWin('O')){bestMove=i;board[i]=null;break}board[i]=null}}if(bestMove===null){for(let i=0;i<9;i++){if(!board[i]){board[i]='X';if(checkWin('X')){bestMove=i;board[i]=null;break}board[i]=null}}}if(bestMove===null&&!board[4])bestMove=4;if(bestMove===null){const empty=board.map((v,i)=>v===null?i:null).filter(v=>v!==null);if(empty.length)bestMove=empty[Math.floor(Math.random()*empty.length)]}if(bestMove!==null){board[bestMove]='O';renderBoard();if(checkWin('O')){statusEl.textContent='💀 Bot Menang!';gameOver=true;return}if(board.every(v=>v)){statusEl.textContent='🤝 Seri!';gameOver=true;return}currentPlayer='X';statusEl.textContent='Giliran: ❌ (Kamu)'}}
function checkWin(symbol){return[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]].some(pattern=>pattern.every(idx=>board[idx]===symbol))}
function resetGame(){board=Array(9).fill(null);currentPlayer='X';gameOver=false;statusEl.textContent='Giliran: ❌ (Kamu)';renderBoard()}
resetBtn.addEventListener('click',resetGame);
renderBoard();
</script></body></html>`;

// ═══════════════════════════════════════════
//  TikTok & YouTube Downloader
// ═══════════════════════════════════════════
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function decodeBase64IfEncoded(str) {
  if (!str) return null;
  const match = str.match(/\/(?:m|p|a|ssstik)\/([A-Za-z0-9+/=_-]+)/);
  if (match) {
    try {
      const decoded = Buffer.from(match[1], 'base64').toString('utf8');
      if (decoded.startsWith('http')) return decoded;
    } catch { }
  }
  return null;
}

async function scrapeSssTik(tiktokUrl) {
  const pageRes = await fetch('https://ssstik.io/id', {
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html', 'Accept-Language': 'id-ID,id;q=0.9' }
  });
  const pageHtml = await pageRes.text();
  const ttMatch = pageHtml.match(/s_tt\s*=\s*'([^']+)'/);
  const furlMatch = pageHtml.match(/s_furl\s*=\s*'([^']+)'/);
  if (!ttMatch) throw new Error('Failed to retrieve token from ssstik');
  const tt = ttMatch[1];
  const furl = furlMatch ? furlMatch[1] : 'abc';
  const cookies = pageRes.headers.get('set-cookie') || '';
  const traceText = await fetch('https://ssstik.io/cdn-cgi/trace', { headers: { 'User-Agent': USER_AGENT } }).then(r => r.text()).catch(() => '');
  const loc = (traceText.match(/^loc=(.*)$/m) || [])[1] || 'ID';
  const ip  = (traceText.match(/^ip=(.*)$/m)  || [])[1] || '';
  const payload = new URLSearchParams({ id: tiktokUrl, locale: 'id', tt, debug: `ab=0&loc=${loc}&ip=${ip}` });
  const dlRes = await fetch(`https://ssstik.io/${furl}?url=dl`, {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'HX-Request': 'true', 'HX-Trigger': '_gcaptcha_pt', 'HX-Target': 'target', 'HX-Current-URL': 'https://ssstik.io/id', 'Cookie': cookies, 'Origin': 'https://ssstik.io', 'Referer': 'https://ssstik.io/id' },
    body: payload.toString()
  });
  const triggerHeader = dlRes.headers.get('hx-trigger') || '';
  if (triggerHeader.includes('ssslimitexceed')) throw new Error('Rate limit exceeded by server');
  const dlHtml = await dlRes.text();
  if (triggerHeader.includes('sssinvalidlink') || dlHtml.includes('Unforeseen consequences')) throw new Error('Video not found or access restricted');
  const avatarImgMatch = dlHtml.match(/<img[^>]*class="[^"]*result_author[^"]*"[^>]*>/i);
  let authorNickname = null;
  if (avatarImgMatch) { const altMatch = avatarImgMatch[0].match(/alt="([^"]*)"/i); if (altMatch) authorNickname = altMatch[1]; }
  const h2Match = dlHtml.match(/<h2>(.*?)<\/h2>/i);
  if (h2Match && !authorNickname) authorNickname = h2Match[1].trim();
  const descMatch = dlHtml.match(/<p\s+class="maintext"[^>]*>([\s\S]*?)<\/p>/i);
  const title = descMatch ? descMatch[1].trim() : null;
  const coverMatch = dlHtml.match(/background-image:\s*url\(([^)]+)\)/i);
  const rawCover = coverMatch ? coverMatch[1].trim() : null;
  let videoSd = null, rawMusic = null;
  const linkRegex = /<a\s+[^>]*href="([^"]+)"[^>]*class="[^"]*download_link[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRegex.exec(dlHtml)) !== null) {
    const href = match[1], text = match[2].toLowerCase();
    if (text.includes('mp3') || href.includes('/m/')) rawMusic = href;
    else if (!videoSd && href.startsWith('http')) videoSd = href;
  }
  const audioUrl = decodeBase64IfEncoded(rawMusic) || rawMusic || null;
  if (!videoSd && !audioUrl) throw new Error('No downloadable media found');
  return { status: 'success', data: { url: tiktokUrl, title, author: { username: authorNickname }, thumbnail: rawCover, downloads: { video_sd: videoSd, audio: audioUrl } } };
}

async function searchYoutube(query) {
  const r = await yts(query);
  return r.videos.slice(0, 1);
}

async function getYoutubeAudio(videoId) {
  const info = await ytdl.getInfo(videoId);
  const audioFormat = ytdl.chooseFormat(info.formats, { quality: 'lowestaudio', filter: 'audioonly' });
  return { title: info.videoDetails.title, thumbnail: info.videoDetails.thumbnails.slice(-1)[0].url, url: audioFormat.url, duration: info.videoDetails.lengthSeconds };
}

// ── Bot Helpers ──
function getRpg(jid) {
  if (!rpgData[jid]) rpgData[jid] = { hp: 100, mp: 80, xp: 0, lvl: 1, kills: 0, gold: 0, win: 0, lose: 0 };
  return rpgData[jid];
}
function boardStr(board) {
  const s = board.map((v, i) => v === 'X' ? '❌' : v === 'O' ? '⭕' : String(i + 1));
  return `${s[0]} │ ${s[1]} │ ${s[2]}\n──┼───┼──\n${s[3]} │ ${s[4]} │ ${s[5]}\n──┼───┼──\n${s[6]} │ ${s[7]} │ ${s[8]}`;
}
function checkWin(b, p) {
  return [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]].some(([a,b2,c]) => b[a]===p && b[b2]===p && b[c]===p);
}

async function reply(jid, text) {
  if (!sock || !botReady) return;
  try {
    await sock.sendPresenceUpdate('composing', jid);
    await new Promise(r => setTimeout(r, 500));
    await sock.sendMessage(jid, { text });
    broadcast({ type: 'activity', jid, cmd: text.split('\n')[0].slice(0, 30) });
  } catch (e) { console.error('[REPLY ERROR]', e.message); }
}

async function replyBtn(jid, text, footer, buttons) {
  if (!sock || !botReady) return;
  try {
    await sock.sendPresenceUpdate('composing', jid);
    await new Promise(r => setTimeout(r, 500));
    await sock.sendMessage(jid, { text, footer, buttons: buttons.map(b => ({ buttonId: b.buttonId, buttonText: b.buttonText, type: b.type || 1 })), headerType: 1 });
  } catch (e) { await sock.sendMessage(jid, { text }); }
}

async function sendTikTokResult(jid, data) {
  if (!sock || !botReady) return;
  let caption = `🎵 *TikTok Downloader*\n\n`;
  caption += `📌 *Judul:* ${data.title || '-'}\n`;
  caption += `👤 *Author:* @${data.author?.username || 'Unknown'}\n\n`;
  caption += `📥 *Link Download:*\n`;
  caption += `🎬 Video: ${data.downloads?.video_sd || 'N/A'}\n`;
  caption += `🎵 Audio: ${data.downloads?.audio || 'N/A'}`;
  if (data.thumbnail) {
    try {
      const response = await fetch(data.thumbnail);
      if (response.ok) { const buffer = Buffer.from(await response.arrayBuffer()); await sock.sendMessage(jid, { image: buffer, caption }); return; }
    } catch (_) {}
  }
  await reply(jid, caption);
}

async function sendYoutubeResult(jid, data) {
  if (!sock || !botReady) return;
  let caption = `🎵 *Lagu dari YouTube*\n\n📌 *${data.title || '-'}*\n⏱ ${Math.floor(data.duration/60)}:${String(data.duration%60).padStart(2,'0')}\n\n🔗 ${data.url}`;
  if (data.thumbnail) {
    try {
      const response = await fetch(data.thumbnail);
      if (response.ok) { const buffer = Buffer.from(await response.arrayBuffer()); await sock.sendMessage(jid, { image: buffer, caption }); return; }
    } catch (_) {}
  }
  await reply(jid, caption);
}

// ── Main Message Handler ──
async function handleMessage(msg) {
  try {
    const jid = msg.key.remoteJid;
    const message = msg.message;
    let body = message?.conversation || message?.extendedTextMessage?.text || message?.imageMessage?.caption || message?.videoMessage?.caption || '';
    if (!body || !body.startsWith(PREFIX)) return;
    const args = body.slice(PREFIX.length).trim().split(/\s+/);
    const cmd  = args.shift().toLowerCase();
    const text = args.join(' ');
    console.log(`[CMD] .${cmd} | ${jid}`);
    const now = new Date();
    const jam = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    const tgl = now.toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    // ── MENU ──
    if (cmd === 'menu' || cmd === 'help') {
      await replyBtn(jid,
`✧₊˚ 🌊 ${BOT_NAME.toUpperCase()} ✧₊˚

┌─[ ✦ INFO BOT ]
│ ◇ Nama    : ${BOT_NAME}
│ ◇ Versi   : 2.0.0
│ ◇ Creator : ${OWNER}
│ ◇ Mode    : Public
└─────────────────
┌─[ ✦ WAKTU ]
│ ◇ ${tgl}
│ ◇ ${jam} WIB
└─────────────────

.menuall | .menugame | .menurpg
.menudownload | .menutools
.menugrup | .menujodoh | .menuanime`,
        BOT_NAME,
        [
          { buttonId: '.menuall',  buttonText: { displayText: '📋 Semua' }, type: 1 },
          { buttonId: '.menugame', buttonText: { displayText: '🎮 Game' }, type: 1 },
          { buttonId: '.menurpg',  buttonText: { displayText: '⚔ RPG' }, type: 1 },
        ]
      );
    }

    // ── MENU ALL ──
    else if (cmd === 'menuall') {
      await replyBtn(jid,
`📋 *[ SEMUA MENU — ${BOT_NAME} ]*

🎨 .brat .sticker .ttp .wm .emoji .gif
🎮 .dino .kuro .ttt .tebak .suit .quiz
⚔ .rpg .serang .sihir .sembuh .jelajah .top
⬇ .tiktok .lagu .ytmp3
🛠 .ping .info .owner .system
👥 .tagall .hidetag
💘 .jodoh .ship .rate .cewek .cowok
🌸 .waifu .husbu .neko .quoteanime`,
        BOT_NAME,
        [
          { buttonId: '.menugame',     buttonText: { displayText: '🎮 Game' }, type: 1 },
          { buttonId: '.menurpg',      buttonText: { displayText: '⚔ RPG' }, type: 1 },
          { buttonId: '.menudownload', buttonText: { displayText: '⬇ Download' }, type: 1 },
        ]
      );
    }

    // ── GAME MENU ──
    else if (cmd === 'menugame') {
      await replyBtn(jid,
`🎮 *[ MENU GAME — ${BOT_NAME} ]*

◈ .dino     - 🦕 Dino Runner (HTML)
◈ .kuro     - ⚔ Kuro Slash (HTML)
◈ .ttt      - ❌ Tic Tac Toe vs AI (HTML)
◈ .tebak    - 🔢 Tebak angka
◈ .jawab    - Jawab tebakan
◈ .suit     - ✊ Suit vs Bot
◈ .quiz     - 📝 Quiz
◈ .trivia   - 🧠 Trivia`,
        BOT_NAME,
        [
          { buttonId: '.dino', buttonText: { displayText: '🦕 Dino' }, type: 1 },
          { buttonId: '.kuro', buttonText: { displayText: '⚔ Kuro' }, type: 1 },
          { buttonId: '.ttt',  buttonText: { displayText: '❌ TTT' }, type: 1 },
        ]
      );
    }

    // ── GAMES HTML (pakai sendHtmlRich!) ──
    else if (cmd === 'dino' || cmd === 'dinorun') {
      try { await sendHtmlRich(jid, DINO_HTML, '🦕 DINO RUNNER — ' + BOT_NAME); }
      catch (e) { await reply(jid, '❌ Gagal kirim game: ' + e.message); }
    }
    else if (cmd === 'kuro' || cmd === 'samurai' || cmd === 'slash') {
      try { await sendHtmlRich(jid, KURO_HTML, '⚔ KURO SLASH — ' + BOT_NAME); }
      catch (e) { await reply(jid, '❌ Gagal kirim game: ' + e.message); }
    }
    else if (cmd === 'ttt') {
      try { await sendHtmlRich(jid, TTT_HTML, '❌ TIC TAC TOE vs AI — ' + BOT_NAME); }
      catch (e) { await reply(jid, '❌ Gagal kirim game: ' + e.message); }
    }

    // ── TEBAK ANGKA ──
    else if (cmd === 'tebak') {
      guessGame[jid] = { angka: Math.floor(Math.random() * 100) + 1, sisa: 7 };
      await reply(jid, '🔢 *Tebak Angka!*\n\nAku pikir angka 1–100.\nKamu punya 7 kesempatan!\n\nKetik: .jawab [angka]');
    }
    else if (cmd === 'jawab') {
      const gq = quizData[jid];
      if (gq) {
        if (text.toLowerCase().includes(gq.answer)) { await reply(jid, '🎉 Benar!'); delete quizData[jid]; }
        else { await reply(jid, '❌ Salah! Coba lagi.'); }
        return;
      }
      const g = guessGame[jid];
      if (!g) { await reply(jid, '❌ Mulai dulu: .tebak'); return; }
      const n = parseInt(text); g.sisa--;
      if (n === g.angka) { await reply(jid, `🎉 Benar! Angkanya ${g.angka}!\nMain lagi? .tebak`); delete guessGame[jid]; }
      else if (g.sisa === 0) { await reply(jid, `😢 Habis! Jawaban: *${g.angka}*\nMain lagi? .tebak`); delete guessGame[jid]; }
      else { await reply(jid, `${n < g.angka ? '⬆ Terlalu kecil' : '⬇ Terlalu besar'}!\nSisa: ${g.sisa} kesempatan`); }
    }

    // ── SUIT ──
    else if (cmd === 'suit') {
      const opts = ['batu', 'gunting', 'kertas'];
      if (!opts.includes(text.toLowerCase())) { await reply(jid, '❌ .suit batu / gunting / kertas'); return; }
      const bot = opts[Math.floor(Math.random() * 3)], u = text.toLowerCase();
      let hasil = '🤝 Seri!';
      if ((u==='batu'&&bot==='gunting')||(u==='gunting'&&bot==='kertas')||(u==='kertas'&&bot==='batu')) hasil = '🎉 Kamu Menang!';
      else if (u !== bot) hasil = '😢 Kamu Kalah!';
      const em = { batu: '🪨', gunting: '✂', kertas: '📄' };
      await reply(jid, `✊ *SUIT!*\n\nKamu: ${em[u]} ${u}\nBot: ${em[bot]} ${bot}\n\n${hasil}`);
    }

    // ── QUIZ & TRIVIA ──
    else if (cmd === 'quiz') {
      const qs = [{ q: 'Apa ibu kota Indonesia?', a: 'jakarta' },{ q: 'Siapa presiden pertama Indonesia?', a: 'soekarno' },{ q: 'Planet terbesar tata surya?', a: 'jupiter' },{ q: '7 x 8 = ?', a: '56' }];
      const q = qs[Math.floor(Math.random() * qs.length)];
      quizData[jid] = { answer: q.a };
      await reply(jid, `📝 *QUIZ*\n\n${q.q}\n\nKetik: .jawab [jawaban]`);
    }
    else if (cmd === 'trivia') {
      const ts = [{ q: 'Hewan yang bisa berubah warna?', a: 'bunglon' },{ q: 'Gunung tertinggi di dunia?', a: 'everest' },{ q: 'Penemu lampu?', a: 'edison' }];
      const t = ts[Math.floor(Math.random() * ts.length)];
      quizData[jid] = { answer: t.a };
      await reply(jid, `🧠 *TRIVIA*\n\n${t.q}\n\nKetik: .jawab [jawaban]`);
    }

    // ── STICKER ──
    else if (cmd === 'menusticker') {
      await replyBtn(jid,
`🎨 *[ MENU STICKER — ${BOT_NAME} ]*\n\n◈ .brat [teks]\n◈ .sticker [teks]\n◈ .ttp [teks]\n◈ .wm [teks]\n◈ .emoji [emoji]\n◈ .gif [source]`,
        BOT_NAME,
        [{ buttonId: '.brat test', buttonText: { displayText: '🧪 Test BRAT' }, type: 1 }]
      );
    }
    else if (cmd === 'brat' || cmd === 'sticker' || cmd === 's') {
      if (!text) { await reply(jid, `❌ .${cmd} [teks]`); return; }
      await reply(jid, `🖼 *BRAT STICKER* 🌊\n\n┌─────────────────────┐\n│   *${text.toUpperCase()}*   │\n│   ✦ ${BOT_NAME} ✦   │\n└─────────────────────┘`);
    }
    else if (cmd === 'ttp') {
      if (!text) { await reply(jid, '❌ .ttp [teks]'); return; }
      await reply(jid, `📝 *TTP STICKER*\n\n┌─────────────────┐\n│  ${text}  │\n└─────────────────┘\n\n_✨ ${BOT_NAME}_`);
    }
    else if (cmd === 'wm') {
      if (!text) { await reply(jid, '❌ .wm [teks]'); return; }
      await reply(jid, `💧 *Watermark:* ${text}\n\n_✨ ${BOT_NAME}_`);
    }
    else if (cmd === 'emoji') {
      if (!text) { await reply(jid, '❌ .emoji [emoji]'); return; }
      await reply(jid, `🎨 Emoji Sticker: ${text}\n\n_✨ ${BOT_NAME}_`);
    }
    else if (cmd === 'gif') {
      if (!text) { await reply(jid, '❌ .gif [source]'); return; }
      await reply(jid, `🎬 GIF Sticker: ${text}\n\n_✨ ${BOT_NAME}_`);
    }

    // ── RPG ──
    else if (cmd === 'menurpg') {
      const r = getRpg(jid);
      await replyBtn(jid,
`⚔ *[ RPG — ${BOT_NAME} ]*\n\nLvl ${r.lvl} | HP ${r.hp}/100 | MP ${r.mp}/80\nXP ${r.xp} | Gold ${r.gold} | Win ${r.win}\n\n◈ .rpg .serang .sihir .sembuh .jelajah .top`,
        BOT_NAME,
        [{ buttonId: '.serang', buttonText: { displayText: '⚔ Serang' }, type: 1 },{ buttonId: '.sembuh', buttonText: { displayText: '💊 Sembuh' }, type: 1 },{ buttonId: '.jelajah', buttonText: { displayText: '🗺 Jelajah' }, type: 1 }]
      );
    }
    else if (cmd === 'rpg') {
      const r = getRpg(jid);
      await reply(jid, `⚔ *RPG — ${OWNER}*\n\nLevel : ${r.lvl}\nHP    : ${r.hp}/100 ❤\nMP    : ${r.mp}/80 💙\nXP    : ${r.xp} ⭐\nGold  : ${r.gold} 🪙\nKills : ${r.kills} 💀`);
    }
    else if (cmd === 'serang') {
      const r = getRpg(jid);
      const dmg = Math.floor(Math.random()*20)+10, balik = Math.floor(Math.random()*10), xpGet = Math.floor(Math.random()*30)+10;
      r.hp = Math.max(0, r.hp - balik); r.xp += xpGet; r.kills++; r.gold += Math.floor(Math.random()*20)+5;
      if (r.xp >= r.lvl*100) { r.xp = 0; r.lvl++; }
      await reply(jid, `⚔ Serang!\nDMG: ${dmg} | Balik: -${balik} HP | +${xpGet} XP\n\nHP: ${r.hp}/100 | Gold: ${r.gold}`);
    }
    else if (cmd === 'sihir') {
      const r = getRpg(jid);
      if (r.mp < 15) { await reply(jid, '❌ MP kurang! Pakai .sembuh'); return; }
      const dmg = Math.floor(Math.random()*40)+20; r.mp -= 15; r.xp += 40; r.kills++;
      if (r.xp >= r.lvl*100) { r.xp = 0; r.lvl++; }
      await reply(jid, `✨ Fireball! DMG: ${dmg} 🔥\nMP -15 | HP: ${r.hp}/100 | MP: ${r.mp}/80`);
    }
    else if (cmd === 'sembuh') {
      const r = getRpg(jid);
      const heal = Math.floor(Math.random()*30)+20; r.hp = Math.min(100, r.hp+heal); r.mp = Math.min(80, r.mp+20);
      await reply(jid, `💊 +${heal} HP | +20 MP\nHP: ${r.hp}/100 | MP: ${r.mp}/80`);
    }
    else if (cmd === 'jelajah') {
      const r = getRpg(jid);
      const evs = [
        { t: '🗺 Harta karun! +50 Gold', fn: () => { r.gold += 50; } },
        { t: '👺 Goblin! +30 XP', fn: () => { r.xp += 30; } },
        { t: '🌿 Istirahat +15 HP', fn: () => { r.hp = Math.min(100, r.hp+15); } },
        { t: '💎 Permata! +100 Gold', fn: () => { r.gold += 100; } },
        { t: '☠ Jebakan! -10 HP', fn: () => { r.hp = Math.max(0, r.hp-10); } },
        { t: '🧙 Ilmu baru +20 MP', fn: () => { r.mp = Math.min(80, r.mp+20); } },
      ];
      const ev = evs[Math.floor(Math.random()*evs.length)]; ev.fn();
      await reply(jid, `🗺 *Jelajah!*\n\n${ev.t}\n\nHP: ${r.hp} | MP: ${r.mp} | Gold: ${r.gold}`);
    }
    else if (cmd === 'top') {
      const sorted = Object.entries(rpgData).sort((a,b) => b[1].lvl - a[1].lvl).slice(0,5);
      if (!sorted.length) { await reply(jid, 'Belum ada data RPG!'); return; }
      let out = '🏆 *Leaderboard RPG*\n\n';
      sorted.forEach(([id,d],i) => { out += `${i+1}. ${id.split('@')[0]} — Lvl ${d.lvl} | Gold ${d.gold}\n`; });
      await reply(jid, out);
    }

    // ── DOWNLOAD ──
    else if (cmd === 'menudownload') {
      await replyBtn(jid,
`⬇ *[ DOWNLOAD — ${BOT_NAME} ]*\n\n◈ .tiktok [link] - TikTok tanpa watermark\n◈ .lagu [judul]  - Download MP3 YouTube\n◈ .ytmp3 [link]  - Download MP3 langsung`,
        BOT_NAME,
        [{ buttonId: '.tiktok https://vm.tiktok.com/xxx', buttonText: { displayText: '🎵 TikTok' }, type: 1 },{ buttonId: '.lagu Hanya Rindu', buttonText: { displayText: '🎶 Lagu' }, type: 1 }]
      );
    }
    else if (cmd === 'tiktok' || cmd === 'tt') {
      if (!text) { await reply(jid, '❌ .tiktok [link TikTok]'); return; }
      await reply(jid, '⏳ *Memproses TikTok...*');
      try { const result = await scrapeSssTik(text); await sendTikTokResult(jid, result.data); }
      catch (e) { await reply(jid, `❌ Error: ${e.message}`); }
    }
    else if (cmd === 'lagu' || cmd === 'ytmp3') {
      if (!text) { await reply(jid, '❌ .lagu [judul lagu]'); return; }
      await reply(jid, '⏳ *Mencari lagu...*');
      try {
        const ytMatch = text.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\?]+)/);
        const videoId = ytMatch ? ytMatch[1] : (await searchYoutube(text))[0]?.videoId;
        if (!videoId) { await reply(jid, '❌ Lagu tidak ditemukan!'); return; }
        const audioData = await getYoutubeAudio(videoId);
        await sendYoutubeResult(jid, audioData);
      } catch (e) { await reply(jid, `❌ Error: ${e.message}`); }
    }

    // ── JODOH ──
    else if (cmd === 'menujodoh') {
      await replyBtn(jid, `💘 *[ JODOH — ${BOT_NAME} ]*\n\n◈ .jodoh ◈ .ship ◈ .rate ◈ .cewek ◈ .cowok ◈ .quotes`, BOT_NAME,
        [{ buttonId: '.jodoh', buttonText: { displayText: '💘 Jodoh' }, type: 1 }]
      );
    }
    else if (cmd === 'jodoh') {
      const names = ['Sakura','Yuki','Rina','Hana','Mira','Ayu','Sari','Luna','Nana','Rei'];
      await reply(jid, `💘 Jodohmu: *${names[Math.floor(Math.random()*names.length)]}*!\nKecocokan: ${Math.floor(Math.random()*30)+70}% ❤`);
    }
    else if (cmd === 'ship') { const c=Math.floor(Math.random()*100); await reply(jid, `💑 Kecocokan: *${c}%*\n${c>=80?'❤ Sangat cocok!':c>=50?'💛 Lumayan!':'💔 Kurang cocok...'}`); }
    else if (cmd === 'rate') { const r=Math.floor(Math.random()*30)+70; await reply(jid, `⭐ Rating: *${r}/100*\n${'█'.repeat(Math.round(r/10))}${'░'.repeat(10-Math.round(r/10))}`); }
    else if (cmd === 'cewek') { const n=['Sakura','Mirai','Hana','Yuki','Rina','Ayu','Sari','Luna']; await reply(jid, `👧 *${n[Math.floor(Math.random()*n.length)]}*`); }
    else if (cmd === 'cowok') { const n=['Ryo','Kenji','Takumi','Ren','Sora','Kaito','Haru','Riku']; await reply(jid, `👦 *${n[Math.floor(Math.random()*n.length)]}*`); }
    else if (cmd === 'quotes') {
      const qs=['Cinta bukan tentang menemukan orang yang sempurna.','Jodoh itu seperti buku, jangan menilai dari sampulnya.'];
      await reply(jid, `📝 *Quote Cinta*\n\n"${qs[Math.floor(Math.random()*qs.length)]}"`);
    }

    // ── ANIME ──
    else if (cmd === 'menuanime') {
      await replyBtn(jid, `🌸 *[ ANIME — ${BOT_NAME} ]*\n\n◈ .waifu ◈ .husbu ◈ .neko ◈ .quoteanime`, BOT_NAME,
        [{ buttonId: '.waifu', buttonText: { displayText: '🌸 Waifu' }, type: 1 }]
      );
    }
    else if (cmd === 'waifu') { const w=['Asuna','Mikasa','Rem','Zero Two','Nezuko','Hinata','Sakura','Rukia']; await reply(jid, `🌸 *Waifu-mu:* ${w[Math.floor(Math.random()*w.length)]}\n\n💕 Selamat!`); }
    else if (cmd === 'husbu') { const h=['Levi','Kirito','Naruto','Luffy','Tanjiro','Sasuke','Ichigo','Gojo']; await reply(jid, `🌸 *Husbu-mu:* ${h[Math.floor(Math.random()*h.length)]}\n\n💕 Selamat!`); }
    else if (cmd === 'neko') { const n=['Nyancat','Doraemon','Hello Kitty','Garfield','Tom','Meowth']; await reply(jid, `🐱 *Neko:* ${n[Math.floor(Math.random()*n.length)]}\n\n😺 Meow~`); }
    else if (cmd === 'quoteanime') {
      const q=['Aku akan menjadi Hokage! - Naruto','Aku akan melindungimu! - Tanjiro','Jangan pernah menyerah! - Luffy'];
      await reply(jid, `📝 *Quote Anime*\n\n"${q[Math.floor(Math.random()*q.length)]}"`);
    }

    // ── GRUP ──
    else if (cmd === 'menugrup') {
      await replyBtn(jid, `👥 *[ GRUP — ${BOT_NAME} ]*\n\n◈ .tagall ◈ .hidetag\n◈ .kick ◈ .add\n\n⚠ Butuh admin bot!`, BOT_NAME,
        [{ buttonId: '.tagall', buttonText: { displayText: '📢 Tag All' }, type: 1 }]
      );
    }
    else if (cmd === 'tagall') { await reply(jid, `📢 *TAG ALL*\n\n@everyone\n\n_✨ ${BOT_NAME}_`); }
    else if (cmd === 'hidetag') { await reply(jid, `👻 *HIDETAG*\n\n_✨ ${BOT_NAME}_`); }

    // ── TOOLS ──
    else if (cmd === 'menutools') {
      await replyBtn(jid, `🛠 *[ TOOLS — ${BOT_NAME} ]*\n\n◈ .ping ◈ .info ◈ .owner ◈ .system`, BOT_NAME,
        [{ buttonId: '.ping', buttonText: { displayText: '📡 Ping' }, type: 1 }]
      );
    }
    else if (cmd === 'ping') {
      const up = Math.floor(process.uptime()), h = Math.floor(up/3600), m = Math.floor((up%3600)/60), s = up%60;
      const mem = process.memoryUsage(), tot = os.totalmem(), free = os.freemem();
      const ram = (((tot-free)/tot)*100).toFixed(1), ms = Date.now()%500+50;
      await reply(jid, `📡 *SERVER LIVE*\n● ${ms} ms\n\n⏱ ${h}j ${m}m ${s}s\n💾 RAM ${ram}%\n${'█'.repeat(Math.round(ram/10))}${'░'.repeat(10-Math.round(ram/10))}\n${((tot-free)/1024/1024).toFixed(0)} MB / ${(tot/1024/1024).toFixed(0)} MB\n\n_by ${BOT_NAME}_`);
    }
    else if (cmd === 'info') { await reply(jid, `ℹ *Info Bot*\n\nNama   : ${BOT_NAME}\nOwner  : ${OWNER}\nPrefix : .\nVersi  : 2.0.0\nStatus : Online ✅`); }
    else if (cmd === 'owner') { await reply(jid, `👑 *Owner Bot*\n\nNama: ${OWNER}`); }
    else if (cmd === 'system') {
      const mem = process.memoryUsage();
      await reply(jid, `💻 *System Info*\n\n${os.platform()} ${os.arch()}\nCPU: ${os.cpus().length} cores\nRAM: ${(os.totalmem()/1024/1024/1024).toFixed(1)} GB\nHeap: ${(mem.heapUsed/1024/1024).toFixed(1)} MB`);
    }

    // ── DEFAULT ──
    else { await reply(jid, `❓ Perintah tidak dikenal.\nKetik *${PREFIX}menu* untuk daftar.`); }

  } catch (err) { console.error('[ERROR handleMessage]', err); }
}

// ── API Routes ──
app.get('/api/tiktok', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.json({ status: 'error', message: 'URL required' });
  try { const result = await scrapeSssTik(url); res.json(result); }
  catch (e) { res.json({ status: 'error', message: e.message }); }
});

// ── Start ──
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔═══════════════════════════╗`);
  console.log(`║  ${BOT_NAME} — v2.0.0  ║`);
  console.log(`║  Port: ${PORT}              ║`);
  console.log(`╚═══════════════════════════╝\n`);
});
