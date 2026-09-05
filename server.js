'use strict';

// ─────────────────────────────────────────────
//  BOT WA ADNAN — Server
//  Express + WebSocket + Baileys
// ─────────────────────────────────────────────

const express  = require('express');
const http     = require('http');
const { WebSocketServer } = require('ws');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const pino     = require('pino');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} = require('@whiskeysockets/baileys');

// ── Config ────────────────────────────────────
const PORT       = process.env.PORT || 3000;
const PREFIX     = '.';
const BOT_NAME   = 'Bot Adnan';
const OWNER      = 'Adnan';
const SESSION_DIR = path.join(__dirname, 'session');

if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

// ── UUID tanpa crypto ─────────────────────────
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ── Logger ────────────────────────────────────
const logger = pino({ level: 'silent' });

// ── Express ───────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── State ─────────────────────────────────────
let sock     = null;
let botReady = false;
let clients  = new Set();

// Game & RPG state
const rpgData   = {};
const guessGame = {};
const tttGame   = {};

// ── WS Helpers ────────────────────────────────
function send(ws, data) {
  try { if (ws.readyState === 1) ws.send(JSON.stringify(data)); } catch (_) {}
}
function broadcast(data) {
  clients.forEach(c => send(c, data));
}

// ── WebSocket ─────────────────────────────────
wss.on('connection', ws => {
  clients.add(ws);

  // Kirim status saat client konek
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

// ── Start Bot ─────────────────────────────────
async function startBot(ws, nomor) {
  try {
    // Kalau bot sudah jalan, disconnect dulu
    if (sock) {
      try { sock.end(); } catch (_) {}
      sock = null;
      botReady = false;
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
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
    });

    send(ws, { type: 'log', cls: 's', msg: '✓ Socket dibuat' });
    send(ws, { type: 'progress', val: 50 });

    // Minta pairing code
    if (!sock.authState.creds.registered) {
      send(ws, { type: 'log', cls: 'i', msg: `→ Request pairing code +${nomor}...` });
      send(ws, { type: 'progress', val: 70 });

      // Tunggu socket siap dulu
      await new Promise(r => setTimeout(r, 2000));

      try {
        const code = await sock.requestPairingCode(nomor);
        const formatted = code.match(/.{1,4}/g).join('-'); // format jadi XXXX-XXXX
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

    // ── Event: connection ────────────────────
    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (connection === 'open') {
        botReady = true;
        const id = sock?.user?.id || '';
        console.log('[BOT] Terhubung:', id);
        broadcast({ type: 'connected', nomor: id.split(':')[0] });
        broadcast({ type: 'log', cls: 's', msg: '✅ BOT TERHUBUNG KE WHATSAPP!' });
      }

      if (connection === 'close') {
        botReady = false;
        broadcast({ type: 'disconnected' });
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        console.log('[BOT] Putus, kode:', code);
        if (!loggedOut) {
          console.log('[BOT] Reconnecting...');
          setTimeout(() => startBot(ws, nomor), 5000);
        } else {
          // Hapus session kalau logout
          fs.rmSync(SESSION_DIR, { recursive: true, force: true });
          fs.mkdirSync(SESSION_DIR, { recursive: true });
          broadcast({ type: 'log', cls: 'e', msg: 'Sesi berakhir, silakan tautkan ulang.' });
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // ── Event: pesan masuk ───────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        await handleMessage(msg);
      }
    });

  } catch (err) {
    console.error('[ERROR]', err);
    send(ws, { type: 'error', msg: err.message });
  }
}

// ── Bot Logic ─────────────────────────────────
function getRpg(jid) {
  if (!rpgData[jid]) rpgData[jid] = { hp: 100, mp: 80, xp: 0, lvl: 1, kills: 0, gold: 0 };
  return rpgData[jid];
}

function boardStr(board) {
  const s = board.map((v, i) => v === 'X' ? '❌' : v === 'O' ? '⭕' : String(i + 1));
  return `${s[0]} │ ${s[1]} │ ${s[2]}\n──┼───┼──\n${s[3]} │ ${s[4]} │ ${s[5]}\n──┼───┼──\n${s[6]} │ ${s[7]} │ ${s[8]}`;
}

function checkWin(b, p) {
  return [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]]
    .some(([a,b2,c]) => b[a]===p && b[b2]===p && b[c]===p);
}

async function reply(jid, text) {
  if (!sock || !botReady) return;
  try {
    await sock.sendPresenceUpdate('composing', jid);
    await new Promise(r => setTimeout(r, 500));
    await sock.sendMessage(jid, { text });
    broadcast({ type: 'activity', jid, cmd: text.split('\n')[0].slice(0, 30) });
  } catch (e) {
    console.error('[REPLY ERROR]', e.message);
  }
}

async function replyBtn(jid, text, footer, buttons) {
  if (!sock || !botReady) return;
  try {
    await sock.sendPresenceUpdate('composing', jid);
    await new Promise(r => setTimeout(r, 500));
    await sock.sendMessage(jid, { text, footer, buttons, headerType: 1 });
    broadcast({ type: 'activity', jid, cmd: text.split('\n')[0].slice(0, 30) });
  } catch {
    // Fallback ke text biasa kalau button gagal
    await sock.sendMessage(jid, { text });
  }
}

async function handleMessage(msg) {
  try {
    const jid  = msg.key.remoteJid;
    const body =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption || '';

    if (!body.startsWith(PREFIX)) return;

    const args = body.slice(PREFIX.length).trim().split(/\s+/);
    const cmd  = args.shift().toLowerCase();
    const text = args.join(' ');

    console.log(`[CMD] .${cmd} | ${jid}`);

    const now  = new Date();
    const jam  = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    const tgl  = now.toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    // ── MENU ──────────────────────────────────
    if (cmd === 'menu' || cmd === 'help') {
      await replyBtn(jid,
`✧₊˚
┌─[ ✦ ${BOT_NAME.toUpperCase()} ]
│ Ohayou gozaimasu!
│ Semoga harimu menyenangkan! (✿◡‿◡)
└────────────────────
✧₊˚

┌─[ ✦ INFO SISTEM ]
│ ◇ Bot     : ${BOT_NAME}
│ ◇ Versi   : 1.0.0
│ ◇ Creator : ${OWNER}
│ ◇ Mode    : Public
└────────────────────
✧₊˚

┌─[ ✦ WAKTU & TANGGAL ]
│ ◇ Tanggal : ${tgl}
│ ◇ Jam     : ${jam} WIB
└────────────────────
✧₊˚

_Ketik nama menu untuk buka kategori_
${BOT_NAME} • v1.0.0`,
        BOT_NAME + ' • v1.0.0',
        [
          { buttonId: '.menuall',  buttonText: { displayText: '📋 Semua Menu' },  type: 1 },
          { buttonId: '.menugame', buttonText: { displayText: '🎮 Game' },         type: 1 },
          { buttonId: '.menurpg',  buttonText: { displayText: '⚔️ RPG' },          type: 1 },
        ]
      );
    }

    // ── SEMUA MENU ────────────────────────────
    else if (cmd === 'menuall') {
      await replyBtn(jid,
`📋 *[ SEMUA MENU — ${BOT_NAME} ]*

◈ .menuall       — Semua perintah
◈ .menugame      — Mini Game
◈ .menurpg       — Sistem RPG
◈ .menuminigame  — Mini Game lanjut
◈ .menujodoh     — Jodoh & Sosial
◈ .menutiktok    — TikTok
◈ .menuyoutube   — YouTube
◈ .menudownloder — Downloader
◈ .menugrup      — Fitur Grup`,
        BOT_NAME,
        [
          { buttonId: '.menugame',      buttonText: { displayText: '🎮 Game' },       type: 1 },
          { buttonId: '.menurpg',       buttonText: { displayText: '⚔️ RPG' },        type: 1 },
          { buttonId: '.menudownloder', buttonText: { displayText: '⬇️ Downloader' }, type: 1 },
        ]
      );
    }

    // ── MENU GAME ─────────────────────────────
    else if (cmd === 'menugame') {
      await replyBtn(jid,
`🎮 *[ MENU GAME ]*

◈ .ttt           — Tic-Tac-Toe
◈ .pilih [1-9]   — Pilih kotak TTT
◈ .tebak         — Tebak angka 1-100
◈ .jawab [angka] — Jawab tebakan
◈ .suit [pilihan]— Suit vs Bot`,
        BOT_NAME,
        [
          { buttonId: '.ttt',        buttonText: { displayText: '🎮 TTT' },   type: 1 },
          { buttonId: '.tebak',      buttonText: { displayText: '🔢 Tebak' }, type: 1 },
          { buttonId: '.suit batu',  buttonText: { displayText: '✊ Suit' },  type: 1 },
        ]
      );
    }

    // ── MENU RPG ──────────────────────────────
    else if (cmd === 'menurpg') {
      const r = getRpg(jid);
      await replyBtn(jid,
`⚔️ *[ MENU RPG ]*

◈ .rpg     — Status karakter
◈ .serang  — Serang musuh (+XP)
◈ .sihir   — Pakai sihir (-15 MP)
◈ .sembuh  — Pulihkan HP & MP
◈ .jelajah — Jelajah & reward
◈ .top     — Leaderboard

📊 Kamu: Lvl ${r.lvl} | HP ${r.hp} | Gold ${r.gold}`,
        BOT_NAME,
        [
          { buttonId: '.serang',  buttonText: { displayText: '⚔️ Serang' },  type: 1 },
          { buttonId: '.sembuh',  buttonText: { displayText: '💊 Sembuh' },  type: 1 },
          { buttonId: '.jelajah', buttonText: { displayText: '🗺️ Jelajah' }, type: 1 },
        ]
      );
    }

    // ── MENU MINIGAME ─────────────────────────
    else if (cmd === 'menuminigame') {
      await replyBtn(jid, `🕹️ *[ MINI GAME ]*\n\n◈ .ttt\n◈ .tebak\n◈ .suit\n◈ .quiz\n◈ .trivia`, BOT_NAME,
        [{ buttonId: '.ttt', buttonText: { displayText: '🎮 Main TTT' }, type: 1 }]);
    }

    // ── MENU JODOH ────────────────────────────
    else if (cmd === 'menujodoh') {
      await replyBtn(jid, `💘 *[ JODOH & SOSIAL ]*\n\n◈ .jodoh\n◈ .ship\n◈ .rate\n◈ .zodiak`, BOT_NAME,
        [{ buttonId: '.jodoh', buttonText: { displayText: '💘 Cari Jodoh' }, type: 1 }]);
    }

    // ── MENU TIKTOK ───────────────────────────
    else if (cmd === 'menutiktok') {
      await replyBtn(jid, `🎵 *[ TIKTOK ]*\n\n◈ .tiktok [kata]\n◈ .ttdown [link]\n◈ .tttrend`, BOT_NAME,
        [{ buttonId: '.tttrend', buttonText: { displayText: '🔥 Trending' }, type: 1 }]);
    }

    // ── MENU YOUTUBE ──────────────────────────
    else if (cmd === 'menuyoutube') {
      await replyBtn(jid, `▶️ *[ YOUTUBE ]*\n\n◈ .ytsearch [q]\n◈ .ytmp3 [link]\n◈ .ytdown [link]`, BOT_NAME,
        [{ buttonId: '.ytsearch', buttonText: { displayText: '🔍 Cari' }, type: 1 }]);
    }

    // ── MENU DOWNLOADER ───────────────────────
    else if (cmd === 'menudownloder') {
      await replyBtn(jid, `⬇️ *[ DOWNLOADER ]*\n\n◈ .ttdown [link]\n◈ .ytdown [link]\n◈ .igdown [link]\n◈ .fbdown [link]\n◈ .twdown [link]`, BOT_NAME,
        [{ buttonId: '.ttdown', buttonText: { displayText: '🎵 TikTok' }, type: 1 }]);
    }

    // ── MENU GRUP ─────────────────────────────
    else if (cmd === 'menugrup') {
      await replyBtn(jid, `👥 *[ GRUP ]*\n\n◈ .hidetag\n◈ .tagall\n◈ .kick\n◈ .add\n◈ .promote\n◈ .demote\n◈ .antilink\n◈ .welcome\n\n_⚠ Butuh admin bot_`, BOT_NAME,
        [{ buttonId: '.hidetag', buttonText: { displayText: '📢 Hidetag' }, type: 1 }]);
    }

    // ── PING ──────────────────────────────────
    else if (cmd === 'ping') {
      const up  = Math.floor(process.uptime());
      const h   = Math.floor(up / 3600);
      const m   = Math.floor((up % 3600) / 60);
      const s   = up % 60;
      const mem = process.memoryUsage();
      const tot = os.totalmem(), free = os.freemem();
      const ram = (((tot - free) / tot) * 100).toFixed(1);
      const ms  = Date.now() % 500 + 50;
      await reply(jid,
`📡 *SERVER LIVE*
● REALTIME MONITOR · ${ms} ms

⏱️ *BOT UPTIME*
${h}j ${m}m ${s}s

💾 *RAM* ${ram}%
${'█'.repeat(Math.round(ram / 10))}${'░'.repeat(10 - Math.round(ram / 10))}
${((tot - free) / 1024 / 1024).toFixed(0)} MB / ${(tot / 1024 / 1024).toFixed(0)} MB

🧠 HEAP: ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB
🖥️ CPU: ${os.cpus().length} core
⚙️ ${os.platform()} ${os.arch()}
🚀 Node ${process.version}

_by ${BOT_NAME}_`);
    }

    // ── TAUTKAN ───────────────────────────────
    else if (cmd === 'tautkan' || cmd === 'link') {
      const url = process.env.WEB_URL || 'https://bot-adnan.up.railway.app';
      await replyBtn(jid,
`🔗 *Tautkan Bot WA Adnan*

Buka link berikut untuk menautkan nomor WA ke bot:

${url}

_Masukkan nomormu → dapat kode → paste ke WA_`,
        BOT_NAME,
        [{ buttonId: 'open', buttonText: { displayText: '🌐 Buka Web Tautkan' }, type: 1 }]
      );
    }

    // ── BRAT ──────────────────────────────────
    else if (cmd === 'brat' || cmd === 'sticker') {
      if (!text) { await reply(jid, `❌ Contoh: ${PREFIX}brat halo`); return; }
      await reply(jid,
`🖼️ *BRAT STICKER*

┌─────────────────────┐
│                     │
│   *${text}*   │
│                     │
│      _by Adnan_     │
└─────────────────────┘`);
    }

    // ── TTT ───────────────────────────────────
    else if (cmd === 'ttt') {
      tttGame[jid] = { board: Array(9).fill(null), turn: 'X', over: false };
      await reply(jid, `*TIC-TAC-TOE*\n\n${boardStr(tttGame[jid].board)}\n\nGiliran: ❌\nKetik: .pilih [1-9]`);
    }

    else if (cmd === 'pilih') {
      const g = tttGame[jid];
      if (!g) { await reply(jid, '❌ Mulai dulu: .ttt'); return; }
      if (g.over) { await reply(jid, 'Game selesai! Ketik .ttt untuk main lagi.'); return; }
      const idx = parseInt(text) - 1;
      if (isNaN(idx) || idx < 0 || idx > 8) { await reply(jid, '❌ Pilih angka 1-9'); return; }
      if (g.board[idx]) { await reply(jid, '❌ Kotak sudah terisi!'); return; }
      g.board[idx] = g.turn;
      const won  = checkWin(g.board, g.turn);
      const full = g.board.every(Boolean);
      let out = `*TIC-TAC-TOE*\n\n${boardStr(g.board)}\n\n`;
      if (won)       { out += `🎉 ${g.turn === 'X' ? '❌' : '⭕'} Menang!`; g.over = true; }
      else if (full) { out += '🤝 Seri!'; g.over = true; }
      else           { g.turn = g.turn === 'X' ? 'O' : 'X'; out += `Giliran: ${g.turn === 'X' ? '❌' : '⭕'}`; }
      await reply(jid, out);
    }

    // ── TEBAK ANGKA ───────────────────────────
    else if (cmd === 'tebak') {
      guessGame[jid] = { angka: Math.floor(Math.random() * 100) + 1, sisa: 7 };
      await reply(jid, '🔢 *Tebak Angka!*\n\nAku pikir angka 1–100.\nKamu punya 7 kesempatan!\n\nKetik: .jawab [angka]');
    }

    else if (cmd === 'jawab') {
      const g = guessGame[jid];
      if (!g) { await reply(jid, '❌ Mulai dulu: .tebak'); return; }
      const n = parseInt(text);
      if (isNaN(n)) { await reply(jid, '❌ Masukkan angka!'); return; }
      g.sisa--;
      if (n === g.angka) {
        await reply(jid, `🎉 Benar! Angkanya ${g.angka}!\nMain lagi? .tebak`);
        delete guessGame[jid];
      } else if (g.sisa === 0) {
        await reply(jid, `😢 Habis! Jawaban: *${g.angka}*\nMain lagi? .tebak`);
        delete guessGame[jid];
      } else {
        await reply(jid, `${n < g.angka ? '⬆️ Terlalu kecil' : '⬇️ Terlalu besar'}!\nSisa: ${g.sisa} kesempatan`);
      }
    }

    // ── SUIT ──────────────────────────────────
    else if (cmd === 'suit') {
      const opts = ['batu', 'gunting', 'kertas'];
      if (!opts.includes(text.toLowerCase())) { await reply(jid, '❌ .suit batu / gunting / kertas'); return; }
      const bot = opts[Math.floor(Math.random() * 3)];
      const u   = text.toLowerCase();
      let hasil = '🤝 Seri!';
      if ((u==='batu'&&bot==='gunting')||(u==='gunting'&&bot==='kertas')||(u==='kertas'&&bot==='batu')) hasil = '🎉 Kamu Menang!';
      else if (u !== bot) hasil = '😢 Kamu Kalah!';
      const em = { batu: '🪨', gunting: '✂️', kertas: '📄' };
      await reply(jid, `✊ *SUIT!*\n\nKamu: ${em[u]} ${u}\nBot: ${em[bot]} ${bot}\n\n${hasil}`);
    }

    // ── RPG ───────────────────────────────────
    else if (cmd === 'rpg') {
      const r = getRpg(jid);
      await reply(jid,
`⚔️ *RPG — ${OWNER}*

Level : ${r.lvl}
HP    : ${r.hp}/100 ❤️
MP    : ${r.mp}/80 💙
XP    : ${r.xp} ⭐
Gold  : ${r.gold} 🪙
Kills : ${r.kills} 💀

.serang | .sihir | .sembuh | .jelajah`);
    }

    else if (cmd === 'serang') {
      const r = getRpg(jid);
      const dmg  = Math.floor(Math.random() * 20) + 10;
      const balik = Math.floor(Math.random() * 10);
      const xpGet = Math.floor(Math.random() * 30) + 10;
      r.hp   = Math.max(0, r.hp - balik);
      r.xp  += xpGet;
      r.kills++;
      r.gold += Math.floor(Math.random() * 20) + 5;
      if (r.xp >= r.lvl * 100) { r.xp = 0; r.lvl++; }
      await reply(jid, `⚔️ Serang!\n\nDMG ke musuh : ${dmg}\nBalasan      : -${balik} HP\nXP didapat   : +${xpGet}\n\nHP: ${r.hp}/100 | Gold: ${r.gold}`);
    }

    else if (cmd === 'sihir') {
      const r = getRpg(jid);
      if (r.mp < 15) { await reply(jid, '❌ MP kurang! Pakai .sembuh dulu.'); return; }
      const dmg = Math.floor(Math.random() * 40) + 20;
      r.mp -= 15; r.xp += 40; r.kills++;
      if (r.xp >= r.lvl * 100) { r.xp = 0; r.lvl++; }
      await reply(jid, `✨ Fireball!\n\nDMG : ${dmg} 🔥\nMP  : -15\n\nHP: ${r.hp}/100 | MP: ${r.mp}/80`);
    }

    else if (cmd === 'sembuh') {
      const r = getRpg(jid);
      const heal = Math.floor(Math.random() * 30) + 20;
      r.hp = Math.min(100, r.hp + heal);
      r.mp = Math.min(80, r.mp + 20);
      await reply(jid, `💊 Sembuh!\n\n+${heal} HP | +20 MP\n\nHP: ${r.hp}/100 | MP: ${r.mp}/80`);
    }

    else if (cmd === 'jelajah') {
      const r = getRpg(jid);
      const evs = [
        { t: '🗺️ Harta karun! +50 Gold',  fn: () => { r.gold += 50; } },
        { t: '👺 Bertemu Goblin! +30 XP',  fn: () => { r.xp += 30; } },
        { t: '🌿 Istirahat di hutan +15 HP',fn: () => { r.hp = Math.min(100, r.hp + 15); } },
        { t: '💎 Menemukan permata! +100 Gold', fn: () => { r.gold += 100; } },
        { t: '☠️ Jebakan! -10 HP',          fn: () => { r.hp = Math.max(0, r.hp - 10); } },
        { t: '🧙 Dapat ilmu baru +20 MP',   fn: () => { r.mp = Math.min(80, r.mp + 20); } },
      ];
      const ev = evs[Math.floor(Math.random() * evs.length)];
      ev.fn();
      await reply(jid, `🗺️ *Jelajah!*\n\n${ev.t}\n\nHP: ${r.hp} | MP: ${r.mp} | Gold: ${r.gold}`);
    }

    else if (cmd === 'top') {
      const sorted = Object.entries(rpgData).sort((a, b) => b[1].lvl - a[1].lvl).slice(0, 5);
      if (!sorted.length) { await reply(jid, 'Belum ada data RPG!'); return; }
      let out = '🏆 *Leaderboard RPG*\n\n';
      sorted.forEach(([id, d], i) => { out += `${i+1}. ${id.split('@')[0]} — Lvl ${d.lvl} | Gold ${d.gold}\n`; });
      await reply(jid, out);
    }

    // ── JODOH ─────────────────────────────────
    else if (cmd === 'jodoh') {
      const names = ['Sakura','Yuki','Rina','Hana','Mira','Ayu','Sari','Luna','Nana','Rei'];
      const cocok = Math.floor(Math.random() * 30) + 70;
      await reply(jid, `💘 Jodohmu: *${names[Math.floor(Math.random() * names.length)]}*!\nKecocokan: ${cocok}% ❤️\n\nSemoga langgeng~ (◕‿◕)`);
    }

    else if (cmd === 'rate') {
      const r = Math.floor(Math.random() * 30) + 70;
      await reply(jid, `⭐ Rating kamu: *${r}/100*\n${'█'.repeat(Math.round(r/10))}${'░'.repeat(10-Math.round(r/10))}\n\n${r>=90?'😍 Kamu keren banget!':r>=80?'😊 Lumayan keren!':'🙂 Tetap semangat!'}`);
    }

    else if (cmd === 'ship') {
      const c = Math.floor(Math.random() * 100);
      await reply(jid, `💑 Kecocokan: *${c}%*\n\n${c>=80?'❤️ Sangat cocok!':c>=50?'💛 Lumayan cocok!':'💔 Kurang cocok...'}`);
    }

    // ── INFO / OWNER ──────────────────────────
    else if (cmd === 'info') {
      await reply(jid, `ℹ️ *Info Bot*\n\nNama   : ${BOT_NAME}\nOwner  : ${OWNER}\nPrefix : .\nVersi  : 1.0.0\nStatus : Online ✅`);
    }

    else if (cmd === 'owner') {
      await reply(jid, `👑 *Owner Bot*\n\nNama: ${OWNER}\nBot ini dibuat dan dikelola oleh ${OWNER}.`);
    }

    // ── DEFAULT ───────────────────────────────
    else {
      await reply(jid, `❓ Perintah tidak dikenal.\nKetik *${PREFIX}menu* untuk daftar perintah.`);
    }

  } catch (err) {
    console.error('[ERROR handleMessage]', err);
  }
}

// ── Start Server ──────────────────────────────
server.listen(PORT, () => {
  console.log(`\n╔═══════════════════════════════╗`);
  console.log(`║   BOT WA ADNAN — v1.0.0      ║`);
  console.log(`║   Port: ${PORT}                  ║`);
  console.log(`╚═══════════════════════════════╝\n`);
});
