const express   = require("express");
const { WebSocketServer } = require("ws");
const http      = require("http");
const path      = require("path");
const fs        = require("fs");
const os        = require("os");
const readline  = require("readline");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");
const pino = require("pino");

// ── Config ────────────────────────────────────
const PORT     = process.env.PORT || 3000;
const PREFIX   = ".";
const BOT_NAME = "Bot Adnan";
const OWNER    = "Adnan";

// ── Express + HTTP + WS ───────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ── State global ──────────────────────────────
let sock       = null;
let botReady   = false;
let clients    = new Set(); // semua WS client yg konek

function broadcast(data) {
  const msg = JSON.stringify(data);
  clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

function sendTo(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

// ── WebSocket handler ─────────────────────────
wss.on("connection", (ws) => {
  clients.add(ws);
  console.log("[WS] Client konek. Total:", clients.size);

  // Kirim status awal
  sendTo(ws, { type: "status", botReady, msg: botReady ? "Bot sudah online!" : "Bot belum terhubung" });

  ws.on("message", async (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // Client minta pairing code
    if (data.type === "requestCode") {
      const nomor = String(data.nomor).replace(/\D/g, "");
      if (!nomor || nomor.length < 10) {
        sendTo(ws, { type: "error", msg: "Nomor tidak valid!" });
        return;
      }
      await startBot(ws, nomor);
    }

    // Client kirim perintah bot (untuk test di web)
    if (data.type === "cmd" && botReady && sock) {
      // simulasi perintah dari web → proses → kirim balik hasilnya
      const result = await handleCmdWeb(data.cmd, data.args);
      sendTo(ws, { type: "cmdResult", result });
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log("[WS] Client disconnect. Sisa:", clients.size);
  });
});

// ── Start Bot + Pairing Code ──────────────────
async function startBot(ws, nomor) {
  try {
    sendTo(ws, { type: "log", cls: "i", msg: "→ Inisialisasi Baileys..." });

    const sessionDir = path.join(__dirname, "session");
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    sendTo(ws, { type: "log", cls: "s", msg: "✓ Modul Baileys loaded" });
    sendTo(ws, { type: "progress", val: 30 });

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
      },
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      browser: [BOT_NAME, "Chrome", "1.0.0"],
    });

    sendTo(ws, { type: "log", cls: "s", msg: "✓ Socket dibuat" });
    sendTo(ws, { type: "progress", val: 50 });

    // Request pairing code
    if (!sock.authState.creds.registered) {
      sendTo(ws, { type: "log", cls: "i", msg: `→ Request pairing code untuk +${nomor}...` });
      sendTo(ws, { type: "progress", val: 70 });

      await new Promise(r => setTimeout(r, 1500));

      try {
        const code = await sock.requestPairingCode(nomor);
        sendTo(ws, { type: "progress", val: 100 });
        sendTo(ws, { type: "log", cls: "s", msg: "✓ Kode berhasil didapat!" });
        sendTo(ws, { type: "code", code }); // kirim kode ke web!
      } catch (e) {
        sendTo(ws, { type: "error", msg: "Gagal dapat kode: " + e.message });
        return;
      }
    } else {
      sendTo(ws, { type: "log", cls: "w", msg: "Session sudah ada, skip pairing..." });
      sendTo(ws, { type: "progress", val: 100 });
    }

    // Event handlers
    sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
      if (connection === "open") {
        botReady = true;
        console.log("[BOT] ✅ Terhubung ke WhatsApp!");
        broadcast({ type: "connected", nomor: sock.user?.id });
        broadcast({ type: "log", cls: "s", msg: "✅ BOT TERHUBUNG KE WHATSAPP!" });
      }
      if (connection === "close") {
        botReady = false;
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        broadcast({ type: "disconnected" });
        if (shouldReconnect) {
          console.log("[BOT] Reconnecting...");
          setTimeout(() => startBot(ws, nomor), 3000);
        }
      }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        await handleMessage(msg);
      }
    });

  } catch (err) {
    console.error("[ERROR startBot]", err);
    sendTo(ws, { type: "error", msg: "Error: " + err.message });
  }
}

// ── Bot Logic (sama persis bot.js) ────────────
const rpgData  = {};
const guessGame = {};
const tttGame  = {};

function getRpg(jid) {
  if (!rpgData[jid]) rpgData[jid] = { hp: 100, mp: 80, xp: 0, lvl: 1, kills: 0, gold: 0 };
  return rpgData[jid];
}

function renderTTT(jid) {
  const g = tttGame[jid];
  const s = g.board.map((v, i) => v === "X" ? "❌" : v === "O" ? "⭕" : String(i + 1));
  return `*TIC-TAC-TOE*\n\n${s[0]} │ ${s[1]} │ ${s[2]}\n──┼───┼──\n${s[3]} │ ${s[4]} │ ${s[5]}\n──┼───┼──\n${s[6]} │ ${s[7]} │ ${s[8]}`;
}
function checkTTT(b, p) {
  return [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]]
    .some(([a, bb, c]) => b[a] === p && b[bb] === p && b[c] === p);
}

async function handleMessage(msg) {
  try {
    const jid  = msg.key.remoteJid;
    const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
    if (!body.startsWith(PREFIX)) return;

    const args = body.slice(PREFIX.length).trim().split(/\s+/);
    const cmd  = args.shift().toLowerCase();
    const text = args.join(" ");

    console.log(`[CMD] .${cmd} dari ${jid}`);

    await sock.sendPresenceUpdate("composing", jid);
    await new Promise(r => setTimeout(r, 600));

    // Broadcast ke web bahwa ada pesan masuk
    broadcast({ type: "activity", jid, cmd: "." + cmd });

    const now = new Date();
    const jam = now.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
    const tgl = now.toLocaleDateString("id-ID", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    const hari = now.toLocaleDateString("id-ID", { weekday: "long" });

    // ─── MENU ────────────────────────────────────
    if (cmd === "menu" || cmd === "help") {
      const menu =
`✧₊˚
[ ✦ ${BOT_NAME.toUpperCase()} ]
Ohayou gozaimasu!
Semoga harimu menyenangkan! (✿◡‿◡)
✧₊˚

┌─[ ✦ PROFIL PENGGUNA ]
│ ◇ Nama : ${OWNER}
│ ◇ Role : Free user
│ ◇ Limit : 30/30
└──────────────────
✧₊˚

┌─[ ✦ INFO SISTEM ]
│ ◇ Bot : ${BOT_NAME}
│ ◇ Versi : 1.0.0
│ ◇ Creator : ${OWNER}
│ ◇ Mode : Public
└──────────────────
✧₊˚

┌─[ ✦ WAKTU & TANGGAL ]
│ ◇ Tanggal : ${tgl}
│ ◇ Hari : ${hari}
│ ◇ Jam : ${jam} WIB
└──────────────────
✧₊˚

_Ketik .help <cmd> untuk info detail._
${BOT_NAME} • Versi 1.0.0`;

      await sock.sendMessage(jid, {
        text: menu,
        footer: BOT_NAME + " • Versi 1.0.0",
        buttons: [
          { buttonId: ".menuall",  buttonText: { displayText: "📋 Semua Menu" },  type: 1 },
          { buttonId: ".menugame", buttonText: { displayText: "🎮 Game Menu" },   type: 1 },
          { buttonId: ".menurpg",  buttonText: { displayText: "⚔️ RPG Menu" },    type: 1 },
        ],
        headerType: 1
      });
    }

    else if (cmd === "tautkan" || cmd === "link") {
      const webUrl = process.env.WEB_URL || "https://bot-adnan.up.railway.app";
      await sock.sendMessage(jid, {
        text: `🔗 *Tautkan Bot WA Adnan*\n\nBuka link berikut untuk menautkan nomor WA ke bot:\n\n${webUrl}\n\n_Masukkan nomormu → dapat kode → paste ke WA_`,
        footer: BOT_NAME,
        buttons: [{ buttonId: "open", buttonText: { displayText: "🌐 Buka Web Tautkan" }, type: 1 }],
        headerType: 1
      });
    }

    else if (cmd === "menuall") {
      const msg =
`📋 *[ SEMUA MENU — ${BOT_NAME} ]*

◈ .menuall       — Semua perintah
◈ .menugame      — Mini Game
◈ .menurpg       — Sistem RPG
◈ .menuminigame  — Mini Game lanjut
◈ .menujodoh     — Jodoh & Sosial
◈ .menutiktok    — TikTok Fitur
◈ .menuyoutube   — YouTube Fitur
◈ .menudownloder — Downloader
◈ .menugrup      — Fitur Grup`;
      await sock.sendMessage(jid, {
        text: msg, footer: BOT_NAME,
        buttons: [
          { buttonId: ".menugame",      buttonText: { displayText: "🎮 Game" },       type: 1 },
          { buttonId: ".menurpg",       buttonText: { displayText: "⚔️ RPG" },        type: 1 },
          { buttonId: ".menudownloder", buttonText: { displayText: "⬇️ Downloader" }, type: 1 },
        ], headerType: 1
      });
    }

    else if (cmd === "menugame") {
      await sock.sendMessage(jid, {
        text: `🎮 *[ MENU GAME ]*\n\n◈ .ttt — Tic-Tac-Toe\n◈ .tebak — Tebak angka\n◈ .suit [batu/gunting/kertas]\n◈ .kuro — Kuro Slash Game`,
        footer: BOT_NAME,
        buttons: [
          { buttonId: ".ttt",   buttonText: { displayText: "🎮 TTT" },   type: 1 },
          { buttonId: ".tebak", buttonText: { displayText: "🔢 Tebak" }, type: 1 },
          { buttonId: ".kuro",  buttonText: { displayText: "🌑 Kuro" },  type: 1 },
        ], headerType: 1
      });
    }

    else if (cmd === "menurpg") {
      const r = getRpg(jid);
      await sock.sendMessage(jid, {
        text: `⚔️ *[ MENU RPG ]*\n\n◈ .rpg — Status karakter\n◈ .serang — Serang musuh\n◈ .sihir — Pakai sihir\n◈ .sembuh — Pulihkan HP/MP\n◈ .jelajah — Jelajah dunia\n◈ .top — Leaderboard\n\n📊 Kamu: Lvl ${r.lvl} | HP ${r.hp} | Gold ${r.gold}`,
        footer: BOT_NAME,
        buttons: [
          { buttonId: ".serang",  buttonText: { displayText: "⚔️ Serang" },  type: 1 },
          { buttonId: ".sembuh",  buttonText: { displayText: "💊 Sembuh" },  type: 1 },
          { buttonId: ".jelajah", buttonText: { displayText: "🗺️ Jelajah" }, type: 1 },
        ], headerType: 1
      });
    }

    else if (cmd === "menuminigame") {
      await sock.sendMessage(jid, { text: `🕹️ *[ MINI GAME ]*\n\n◈ .ttt\n◈ .tebak\n◈ .suit\n◈ .kuro\n◈ .quiz\n◈ .trivia`, footer: BOT_NAME, buttons: [{ buttonId: ".kuro", buttonText: { displayText: "🌑 Kuro Slash" }, type: 1 }], headerType: 1 });
    }
    else if (cmd === "menujodoh") {
      await sock.sendMessage(jid, { text: `💘 *[ JODOH & SOSIAL ]*\n\n◈ .jodoh\n◈ .ship\n◈ .rate\n◈ .zodiak`, footer: BOT_NAME, buttons: [{ buttonId: ".jodoh", buttonText: { displayText: "💘 Cari Jodoh" }, type: 1 }], headerType: 1 });
    }
    else if (cmd === "menutiktok") {
      await sock.sendMessage(jid, { text: `🎵 *[ TIKTOK ]*\n\n◈ .tiktok [kata]\n◈ .ttdown [link]\n◈ .tttrend`, footer: BOT_NAME, buttons: [{ buttonId: ".tttrend", buttonText: { displayText: "🔥 Trending" }, type: 1 }], headerType: 1 });
    }
    else if (cmd === "menuyoutube") {
      await sock.sendMessage(jid, { text: `▶️ *[ YOUTUBE ]*\n\n◈ .ytsearch [q]\n◈ .ytmp3 [link]\n◈ .ytdown [link]`, footer: BOT_NAME, buttons: [{ buttonId: ".ytsearch", buttonText: { displayText: "🔍 Cari" }, type: 1 }], headerType: 1 });
    }
    else if (cmd === "menudownloder") {
      await sock.sendMessage(jid, { text: `⬇️ *[ DOWNLOADER ]*\n\n◈ .ttdown [link]\n◈ .ytdown [link]\n◈ .igdown [link]\n◈ .fbdown [link]\n◈ .twdown [link]`, footer: BOT_NAME, buttons: [{ buttonId: ".ttdown", buttonText: { displayText: "🎵 TikTok" }, type: 1 }], headerType: 1 });
    }
    else if (cmd === "menugrup") {
      await sock.sendMessage(jid, { text: `👥 *[ GRUP ]*\n\n◈ .hidetag\n◈ .tagall\n◈ .kick\n◈ .add\n◈ .promote\n◈ .demote\n◈ .antilink\n◈ .welcome`, footer: BOT_NAME, buttons: [{ buttonId: ".hidetag", buttonText: { displayText: "📢 Hidetag" }, type: 1 }], headerType: 1 });
    }

    // ─── PING ─────────────────────────────────
    else if (cmd === "ping") {
      const up = Math.floor(process.uptime());
      const h = Math.floor(up/3600), m = Math.floor((up%3600)/60), s = up%60;
      const mem = process.memoryUsage();
      const total = os.totalmem(), free = os.freemem();
      const ramPct = (((total-free)/total)*100).toFixed(1);
      const ms = Math.floor(Math.random()*200+50);
      await sock.sendMessage(jid, { text:
`📡 *SERVER LIVE*
● REALTIME MONITOR · ${ms} ms

⏱️ *BOT UPTIME*
${h}j ${m}m ${s}s

💾 *RAM* ${ramPct}%
${"█".repeat(Math.round(ramPct/10))}${"░".repeat(10-Math.round(ramPct/10))}
${((total-free)/1024/1024).toFixed(0)} MB / ${(total/1024/1024).toFixed(0)} MB

🧠 *HEAP / RSS*
${(mem.heapUsed/1024/1024).toFixed(1)} MB / ${(mem.rss/1024/1024).toFixed(1)} MB

🖥️ CPU: ${os.cpus().length} core
⚙️ OS: ${os.platform()} ${os.arch()}
🚀 Node ${process.version}

_by ${BOT_NAME}_`
      });
    }

    // ─── BRAT ─────────────────────────────────
    else if (cmd === "brat" || cmd === "sticker") {
      if (!text) { await sock.sendMessage(jid, { text: `❌ Contoh: ${PREFIX}brat halo` }); return; }
      await sock.sendMessage(jid, { text: `🖼️ BRAT STICKER\n\n┌─────────────────┐\n│  ${text}  │\n│   by Adnan      │\n└─────────────────┘` });
    }

    // ─── TTT ──────────────────────────────────
    else if (cmd === "ttt") {
      tttGame[jid] = { board: Array(9).fill(null), turn: "X", over: false };
      await sock.sendMessage(jid, { text: renderTTT(jid) + "\n\nGiliran: ❌\nKetik: .pilih [1-9]" });
    }
    else if (cmd === "pilih") {
      const g = tttGame[jid];
      if (!g) { await sock.sendMessage(jid, { text: "❌ Mulai dulu: .ttt" }); return; }
      const idx = parseInt(text) - 1;
      if (isNaN(idx)||idx<0||idx>8||g.board[idx]) { await sock.sendMessage(jid, { text: "❌ Pilihan tidak valid!" }); return; }
      g.board[idx] = g.turn;
      const won = checkTTT(g.board, g.turn);
      const full = g.board.every(Boolean);
      let result = renderTTT(jid);
      if (won) { result += `\n\n🎉 ${g.turn==="X"?"❌":"⭕"} Menang!`; g.over = true; }
      else if (full) { result += "\n\n🤝 Seri!"; g.over = true; }
      else { g.turn = g.turn==="X"?"O":"X"; result += `\n\nGiliran: ${g.turn==="X"?"❌":"⭕"}`; }
      await sock.sendMessage(jid, { text: result });
    }

    // ─── TEBAK ────────────────────────────────
    else if (cmd === "tebak") {
      guessGame[jid] = { angka: Math.floor(Math.random()*100)+1, sisa: 7 };
      await sock.sendMessage(jid, { text: "🔢 Tebak angka 1–100!\nKamu punya 7 kesempatan!\nKetik: .jawab [angka]" });
    }
    else if (cmd === "jawab") {
      const g = guessGame[jid];
      if (!g) { await sock.sendMessage(jid, { text: "❌ Mulai dulu: .tebak" }); return; }
      const n = parseInt(text); g.sisa--;
      if (n === g.angka) { await sock.sendMessage(jid, { text: `🎉 Benar! Angkanya ${g.angka}!` }); delete guessGame[jid]; }
      else if (g.sisa===0) { await sock.sendMessage(jid, { text: `😢 Habis! Jawaban: ${g.angka}` }); delete guessGame[jid]; }
      else { await sock.sendMessage(jid, { text: `${n<g.angka?"⬆️ Terlalu kecil":"⬇️ Terlalu besar"}! Sisa: ${g.sisa}` }); }
    }

    // ─── SUIT ─────────────────────────────────
    else if (cmd === "suit") {
      const pl = ["batu","gunting","kertas"];
      if (!pl.includes(text.toLowerCase())) { await sock.sendMessage(jid, { text: "❌ .suit batu/gunting/kertas" }); return; }
      const bot = pl[Math.floor(Math.random()*3)]; const u = text.toLowerCase();
      let h = "🤝 Seri!";
      if ((u==="batu"&&bot==="gunting")||(u==="gunting"&&bot==="kertas")||(u==="kertas"&&bot==="batu")) h = "🎉 Kamu Menang!";
      else if (u!==bot) h = "😢 Kamu Kalah!";
      const em = {batu:"🪨",gunting:"✂️",kertas:"📄"};
      await sock.sendMessage(jid, { text: `✊ SUIT!\n\nKamu: ${em[u]} ${u}\nBot: ${em[bot]} ${bot}\n\n${h}` });
    }

    // ─── RPG ──────────────────────────────────
    else if (cmd === "rpg") {
      const r = getRpg(jid);
      await sock.sendMessage(jid, { text: `⚔️ *RPG — ${OWNER}*\n\nLevel: ${r.lvl}\nHP: ${r.hp}/100 ❤️\nMP: ${r.mp}/80 💙\nXP: ${r.xp} ⭐\nGold: ${r.gold} 🪙\nKills: ${r.kills} 💀` });
    }
    else if (cmd === "serang") {
      const r = getRpg(jid); const dmg=Math.floor(Math.random()*20)+10; const balik=Math.floor(Math.random()*10); const xp=Math.floor(Math.random()*30)+10;
      r.hp=Math.max(0,r.hp-balik); r.xp+=xp; r.kills++; r.gold+=Math.floor(Math.random()*20)+5;
      if(r.xp>=r.lvl*100){r.xp=0;r.lvl++;}
      await sock.sendMessage(jid, { text: `⚔️ DMG: ${dmg} | Balik: -${balik} HP | +${xp} XP\nHP: ${r.hp}/100` });
    }
    else if (cmd === "sihir") {
      const r = getRpg(jid);
      if(r.mp<15){ await sock.sendMessage(jid, { text: "❌ MP kurang! Pakai .sembuh" }); return; }
      const dmg=Math.floor(Math.random()*40)+20; r.mp-=15; r.xp+=40; r.kills++;
      if(r.xp>=r.lvl*100){r.xp=0;r.lvl++;}
      await sock.sendMessage(jid, { text: `✨ Fireball! DMG: ${dmg} 🔥\nMP -15 | HP: ${r.hp}/100 | MP: ${r.mp}/80` });
    }
    else if (cmd === "sembuh") {
      const r = getRpg(jid); const heal=Math.floor(Math.random()*30)+20;
      r.hp=Math.min(100,r.hp+heal); r.mp=Math.min(80,r.mp+20);
      await sock.sendMessage(jid, { text: `💊 +${heal} HP | +20 MP\nHP: ${r.hp}/100 | MP: ${r.mp}/80` });
    }
    else if (cmd === "jelajah") {
      const r = getRpg(jid);
      const evs=["🗺️ Harta karun! +50 Gold","👺 Goblin! +30 XP","🌿 Istirahat +15 HP","💎 Permata! +100 Gold","☠️ Jebakan! -10 HP"];
      const ev=evs[Math.floor(Math.random()*evs.length)];
      if(ev.includes("Gold"))r.gold+=ev.includes("100")?100:50;
      if(ev.includes("XP"))r.xp+=30;
      if(ev.includes("+15 HP"))r.hp=Math.min(100,r.hp+15);
      if(ev.includes("-10 HP"))r.hp=Math.max(0,r.hp-10);
      await sock.sendMessage(jid, { text: `🗺️ ${ev}\n\nHP: ${r.hp} | MP: ${r.mp} | Gold: ${r.gold}` });
    }
    else if (cmd === "top") {
      const sorted = Object.entries(rpgData).sort((a,b)=>b[1].lvl-a[1].lvl).slice(0,5);
      let top = "🏆 *Leaderboard RPG*\n\n";
      sorted.forEach(([id,d],i) => { top += `${i+1}. ${id.split("@")[0]} — Lvl ${d.lvl}\n`; });
      await sock.sendMessage(jid, { text: top || "Belum ada data RPG!" });
    }
    else if (cmd === "jodoh") {
      const names=["Sakura","Yuki","Rina","Hana","Mira","Ayu","Sari","Luna"];
      await sock.sendMessage(jid, { text: `💘 Jodohmu: *${names[Math.floor(Math.random()*names.length)]}*!\nKecocokan: ${Math.floor(Math.random()*30)+70}% ❤️` });
    }
    else if (cmd === "rate") {
      const r=Math.floor(Math.random()*30)+70;
      await sock.sendMessage(jid, { text: `⭐ Rating: ${r}/100\n${"█".repeat(Math.round(r/10))}${"░".repeat(10-Math.round(r/10))}\n${r>=90?"😍 Keren banget!":"😊 Lumayan!"}` });
    }
    else if (cmd === "ship") {
      const c=Math.floor(Math.random()*100);
      await sock.sendMessage(jid, { text: `💑 Kecocokan: ${c}%\n${c>=80?"❤️ Sangat cocok!":c>=50?"💛 Lumayan!":"💔 Kurang cocok..."}` });
    }
    else if (cmd === "info") {
      await sock.sendMessage(jid, { text: `ℹ️ *Info Bot*\n\nNama: ${BOT_NAME}\nOwner: ${OWNER}\nPrefix: .\nVersi: 1.0.0\nStatus: Online ✅` });
    }
    else if (cmd === "owner") {
      await sock.sendMessage(jid, { text: `👑 Owner: ${OWNER}` });
    }
    else {
      await sock.sendMessage(jid, { text: `❓ Perintah tidak dikenal.\nKetik *${PREFIX}menu* untuk daftar.` });
    }

  } catch (err) {
    console.error("[ERROR handleMessage]", err);
  }
}

// ── Untuk test cmd dari web (tanpa kirim ke WA) ──
async function handleCmdWeb(cmd, args = "") {
  const r = getRpg("web");
  if (cmd === "rpg") return `⚔️ Level: ${r.lvl} | HP: ${r.hp} | MP: ${r.mp} | XP: ${r.xp} | Gold: ${r.gold}`;
  if (cmd === "ping") return `📡 Pong! Bot aktif. Uptime: ${Math.floor(process.uptime())}s`;
  return `✓ Perintah .${cmd} diterima`;
}

// ── Start server ──────────────────────────────
server.listen(PORT, () => {
  console.log(`\n╔═══════════════════════════════╗`);
  console.log(`║   BOT WA ADNAN — Web Server   ║`);
  console.log(`║   http://localhost:${PORT}        ║`);
  console.log(`╚═══════════════════════════════╝\n`);
});
