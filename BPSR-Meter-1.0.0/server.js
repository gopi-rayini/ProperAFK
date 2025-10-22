const path = require('path');
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
const initializeApi = require(path.join(__dirname, 'src', 'server', 'api'));
const PacketProcessor = require(path.join(__dirname, 'algo', 'packet'));

const VERSION = '3.1';
const SETTINGS_PATH = path.join(__dirname, 'settings.json');

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
      const raw = await fsPromises.readFile(SETTINGS_PATH, 'utf8');
      Object.assign(globalSettings, JSON.parse(raw) || {});
    }
  } catch (e) {
    console.log('settings.json load failed:', e.message);
  }
}

async function saveSettings() {
  try {
    await fsPromises.writeFile(SETTINGS_PATH, JSON.stringify(globalSettings, null, 2), 'utf8');
  } catch (e) {
    console.log('settings.json save failed:', e.message);
  }
}

function makeLogger() {
  return winston.createLogger({
    level: 'info',
    format: winston.format.combine(
      winston.format.colorize({ all: true }),
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.printf(i => `[${i.timestamp}] [${i.level}] ${i.message}`)
    ),
    transports: [new winston.transports.Console()]
  });
}

// provide .info/.warn/.error/.debug always
function normalizeLogger(lg) {
  const noop = () => {};
  return {
    info:  (lg && lg.info)  ? lg.info.bind(lg)  : console.log.bind(console),
    warn:  (lg && lg.warn)  ? lg.warn.bind(lg)  : console.warn.bind(console),
    error: (lg && lg.error) ? lg.error.bind(lg) : console.error.bind(console),
    debug: (lg && lg.debug) ? lg.debug.bind(lg) : noop
  };
}

async function main() {
  if (!zlib.zstdDecompressSync) {
    console.log('zstdDecompressSync missing. Update Node/Electron.');
    process.exit(1);
  }

  await loadSettings();

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });
  app.use(express.static(path.join(__dirname, 'public')));
  app.use(express.json());

  const logger = makeLogger();
  const snifferLogger = normalizeLogger(logger);

  // User data manager + ensure settings + position helpers
  const userDataManager = new UserDataManager(logger);
  userDataManager.globalSettings = userDataManager.globalSettings || globalSettings; // inject so checkTimeoutClear works
  const nowMs = () => Date.now();
  if (typeof userDataManager.setLocalPosition !== 'function') {
    userDataManager.setLocalPosition = function(pos){ this.localPosition = { ...pos, ts: nowMs() }; };
  }
  if (typeof userDataManager.getLocalPosition !== 'function') {
    userDataManager.getLocalPosition = function(){ return this.localPosition || null; };
  }

  // Minimal API (existing + position endpoint)
  initializeApi(app, server, io, userDataManager, logger, globalSettings);

  // Position polling endpoint (idempotent if already present)
  app.get('/api/position', (req, res) => {
    try {
      const pos = userDataManager.getLocalPosition && userDataManager.getLocalPosition();
      if (!pos) return res.status(404).json({ code: 1, msg: 'no position' });
      res.json({ code: 0, pos });
    } catch (e) {
      res.status(500).json({ code: 2, msg: String(e) });
    }
  });

  // Adapter management
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

  let sniffer = new Sniffer({ logger: snifferLogger, userDataManager });

  async function switchAdapter(idx) {
    try {
      if (typeof sniffer.switchDevice === 'function') {
        await sniffer.switchDevice(idx, PacketProcessor);
      } else {
        if (typeof sniffer.stop === 'function') { try { sniffer.stop(); } catch(_){} }
        if (!(sniffer instanceof Sniffer)) sniffer = new Sniffer({ logger: snifferLogger, userDataManager });
        await sniffer.start(idx, PacketProcessor);
      }
      logger.info(`Switched adapter to index ${idx}`);
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

  // Port + default adapter
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
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
