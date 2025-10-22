// server.js
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
const initializeApi = (() => {
  try { return require(path.join(__dirname, 'src', 'server', 'api')); }
  catch { return () => {}; }
})();
const PacketProcessor = require(path.join(__dirname, 'algo', 'packet'));

// writable settings location (never inside app.asar)
function getSettingsPath() {
  const base =
    process.env.APPDATA ||
    process.env.LOCALAPPDATA ||
    path.join(os.homedir(), 'AppData', 'Roaming');
  const dir = path.join(base, 'bpsr-meter');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'settings.json');
}
const SETTINGS_PATH = getSettingsPath();

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
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      Object.assign(globalSettings, JSON.parse(await fsPromises.readFile(SETTINGS_PATH, 'utf8')) || {});
    }
  } catch (_) {}
}
async function saveSettings() {
  try {
    await fsPromises.writeFile(SETTINGS_PATH, JSON.stringify(globalSettings, null, 2), 'utf8');
  } catch (_) {}
}

// winston logger + guaranteed API shape
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
    debug: (...a) => (base.debug ? base.debug(...a) : noop())
  };
}

(async function main() {
  await loadSettings();

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public'))); // serves /adapter.html

  const logger = makeLogger();

  // user data manager
  const userDataManager = new UserDataManager(logger);
  userDataManager.globalSettings = userDataManager.globalSettings || globalSettings;
  if (typeof userDataManager.setLocalPosition !== 'function') {
    userDataManager.setLocalPosition = function(pos){ this.localPosition = { ...pos, ts: Date.now() }; };
  }
  if (typeof userDataManager.getLocalPosition !== 'function') {
    userDataManager.getLocalPosition = function(){ return this.localPosition || null; };
  }

  // core API (existing UI + endpoints)
  initializeApi(app, server, io, userDataManager, logger, globalSettings);

  // position endpoint
  app.get('/api/position', (req, res) => {
    const pos = userDataManager.getLocalPosition && userDataManager.getLocalPosition();
    if (!pos) return res.status(404).json({ code: 1, msg: 'no position' });
    res.json({ code: 0, pos });
  });

  // adapter listing
  app.get('/api/adapters', (req, res) => {
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

  let sniffer = new Sniffer({ logger, userDataManager });

  async function switchAdapter(idx) {
    try {
      if (typeof sniffer.switchDevice === 'function') {
        await sniffer.switchDevice(idx, PacketProcessor);
      } else {
        if (typeof sniffer.stop === 'function') { try { sniffer.stop(); } catch(_){} }
        sniffer = new Sniffer({ logger, userDataManager });
        await sniffer.start(idx, PacketProcessor);
      }
      logger.info(`Switched adapter -> ${idx}`);
      return true;
    } catch (e) {
      logger.error(`Switch failed: ${e.message}`);
      return false;
    }
  }

  // adapter select (UI posts here; /adapter.html is the page)
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

  // port + device args
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
