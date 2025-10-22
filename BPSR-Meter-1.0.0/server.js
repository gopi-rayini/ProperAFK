const path = require('path');
const os = require('os');
const fs = require('fs');
const fsPromises = fs.promises;
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const winston = require('winston');
const { Cap } = require('cap');
const zlib = require('zlib');

const { UserDataManager } = require(path.join(__dirname, 'src', 'server', 'dataManager'));
const Sniffer = require(path.join(__dirname, 'src', 'server', 'sniffer'));
const PacketProcessor = require(path.join(__dirname, 'algo', 'packet'));

function settingsPath() {
  const base = process.env.APPDATA || process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const dir = path.join(base, 'bpsr-meter');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'settings.json');
}
const SETTINGS_PATH = settingsPath();

let globalSettings = {
  autoClearOnServerChange: true,
  autoClearOnTimeout: false,
  onlyRecordEliteDummy: false,
  enableFightLog: false,
  enableDpsLog: false,
  enableHistorySave: false,
  isPaused: false,
  selectedDevice: undefined
};

async function loadSettings() {
  try { if (fs.existsSync(SETTINGS_PATH)) Object.assign(globalSettings, JSON.parse(await fsPromises.readFile(SETTINGS_PATH, 'utf8')) || {}); }
  catch (_) {}
}
async function saveSettings() {
  try { await fsPromises.writeFile(SETTINGS_PATH, JSON.stringify(globalSettings, null, 2), 'utf8'); }
  catch (_) {}
}

function makeLogger() {
  const base = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
      winston.format.colorize({ all: true }),
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.printf(i => `[${i.timestamp}] [${i.level}] ${i.message}`)
    ),
    transports: [new winston.transports.Console()]
  });
  const noop = () => {};
  return {
    info:  (...a) => base.info(...a),
    warn:  (...a) => base.warn(...a),
    error: (...a) => base.error(...a),
    debug: (...a) => (base.debug ? base.debug(...a) : noop()),
  };
}

function safeLogger(lg) {
  const noop = () => {};
  return {
    info:  typeof lg?.info  === 'function' ? lg.info.bind(lg)  : console.log.bind(console),
    warn:  typeof lg?.warn  === 'function' ? lg.warn.bind(lg)  : console.warn.bind(console),
    error: typeof lg?.error === 'function' ? lg.error.bind(lg) : console.error.bind(console),
    debug: typeof lg?.debug === 'function' ? lg.debug.bind(lg) : noop,
  };
}

(async function main() {
  await loadSettings();

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  // Root always 200 to satisfy Electron health check
  app.get('/', (_req, res) => {
    res.type('html').send(
      '<!doctype html><meta charset=utf-8><title>BPSR Meter</title>' +
      '<h1 style="font-family:system-ui">BPSR Meter</h1>' +
      '<p>Server OK. <a href="/adapter.html">Select network adapter</a>.</p>'
    );
  });

  // Inline adapter UI if file not present
  app.get('/adapter.html', (_req, res) => {
    res.type('html').send(`
<!doctype html><meta charset="utf-8"><title>Adapter</title>
<style>body{font-family:system-ui;margin:24px} select,button,input{padding:8px;margin:4px 0}</style>
<h2>Network Adapter Selection</h2>
<div><button id="refresh">Refresh</button></div>
<div>
  <label>Adapters</label><br/>
  <select id="sel"></select>
</div>
<div>
  <label>Or name</label><br/>
  <input id="name" placeholder="\\\\Device\\\\NPF_{GUID}">
</div>
<div><button id="apply">Apply</button> <button id="test">Test position</button></div>
<pre id="out"></pre>
<script>
const out = document.getElementById('out'), sel = document.getElementById('sel'), nameI = document.getElementById('name');
async function j(u,o){const r=await fetch(u,o);const t=await r.text();try{return{ok:r.ok,data:JSON.parse(t)}}catch{return{ok:r.ok,data:t}}}
async function load(){out.textContent='loading...';const r=await j('/api/adapters');if(!r.ok){out.textContent='failed';return}
const {data,selected}=r.data; sel.innerHTML=''; data.forEach(d=>{const o=document.createElement('option');o.value=d.index;o.textContent='['+d.index+'] '+(d.name||'')+' — '+(d.description||''); sel.appendChild(o);});
if(typeof selected==='number') sel.value=String(selected); out.textContent='ready';}
document.getElementById('refresh').onclick=load;
document.getElementById('apply').onclick=async()=>{
  const body=nameI.value.trim()?{name:nameI.value.trim()}:{index:parseInt(sel.value,10)};
  const r=await j('/api/adapter',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  out.textContent=JSON.stringify(r.data||r, null, 2);
};
document.getElementById('test').onclick=async()=>{
  const r=await j('/api/position'); out.textContent=JSON.stringify(r.data||r, null, 2);
};
load();
</script>`);
  });

  const logger = makeLogger();
  const snifferLogger = safeLogger(logger);

  const userDataManager = new UserDataManager(logger);
  userDataManager.globalSettings = userDataManager.globalSettings || globalSettings;
  if (typeof userDataManager.setLocalPosition !== 'function') {
    userDataManager.setLocalPosition = function(pos){ this.localPosition = { ...pos, ts: Date.now() }; };
  }
  if (typeof userDataManager.getLocalPosition !== 'function') {
    userDataManager.getLocalPosition = function(){ return this.localPosition || null; };
  }

  // Existing API if present
  try { require(path.join(__dirname, 'src', 'server', 'api'))(app, server, io, userDataManager, logger, globalSettings); }
  catch (_) {}

  // Position endpoint
  app.get('/api/position', (_req, res) => {
    const pos = userDataManager.getLocalPosition && userDataManager.getLocalPosition();
    if (!pos) return res.status(404).json({ code: 1, msg: 'no position' });
    res.json({ code: 0, pos });
  });

  // Adapter APIs
  app.get('/api/adapters', (_req, res) => {
    try {
      const list = Cap.deviceList().map((d, i) => ({
        index: i,
        name: d.name,
        description: d.description || '',
        addresses: (d.addresses || []).map(a => a.addr)
      }));
      res.json({ code: 0, data: list, selected: globalSettings.selectedDevice ?? null });
    } catch (e) {
      res.status(500).json({ code: 1, msg: String(e) });
    }
  });

  let sniffer = new Sniffer({ logger: snifferLogger, userDataManager });

  async function switchAdapter(idx) {
    try {
      await sniffer.switchDevice(idx, PacketProcessor);
      logger.info(`Switched adapter -> ${idx}`);
      return true;
    } catch (e) {
      logger.error(`Switch failed: ${e.message}`);
      return false;
    }
  }

  app.post('/api/adapter', async (req, res) => {
    try {
      const { index, name } = req.body || {};
      const list = Cap.deviceList();
      let idx = Number.isInteger(index) ? index : list.findIndex(x => x.name === name);
      if (!(idx >= 0 && idx < list.length)) return res.status(400).json({ code: 1, msg: 'invalid index/name' });
      const live = await switchAdapter(idx);
      globalSettings.selectedDevice = idx;
      await saveSettings();
      res.json({ code: 0, live, selected: idx });
    } catch (e) {
      res.status(500).json({ code: 2, msg: String(e) });
    }
  });

  // Port + device
  const args = process.argv.slice(2);
  let server_port = 8989;
  if (args[0] && /^\d+$/.test(args[0])) server_port = parseInt(args[0], 10);
  const deviceIdxFromArgs = (args[1] && /^\d+$/.test(args[1])) ? parseInt(args[1], 10) : undefined;
  const deviceIdx = (globalSettings.selectedDevice !== undefined) ? globalSettings.selectedDevice : deviceIdxFromArgs;

  server.listen(server_port, '0.0.0.0', () => {
    console.log(`Server running at http://localhost:${server_port}`);
  });

  try {
    await sniffer.start(deviceIdx, PacketProcessor);
  } catch (e) {
    logger.error(`Error starting sniffer: ${e.message}`);
  }

  setInterval(() => {
    try { userDataManager.checkTimeoutClear && userDataManager.checkTimeoutClear(); } catch(_) {}
  }, 10000);
})().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
