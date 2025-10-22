const winston = require('winston');
const path = require('path');
const fsPromises = require('fs').promises;
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
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
      const json = JSON.parse(raw);
      Object.assign(globalSettings, json || {});
    }
  } catch (e) {
    console.log('Failed to load settings.json, using defaults:', e.message);
  }
}

async function saveSettings() {
  try {
    await fsPromises.writeFile(SETTINGS_PATH, JSON.stringify(globalSettings, null, 2), 'utf8');
  } catch (e) {
    console.log('Failed to save settings.json:', e.message);
  }
}

function makeLogger() {
  return winston.createLogger({
    level: 'info',
    format: winston.format.combine(
      winston.format.colorize({ all: true }),
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.printf((info) => `[${info.timestamp}] [${info.level}] ${info.message}`)
    ),
    transports: [new winston.transports.Console()]
  });
}

async function main() {
  const logger = makeLogger();

  if (!zlib.zstdDecompressSync) {
    console.log('zstdDecompressSync is not available! Please update your Node.js!');
    process.exit(1);
  }

  await loadSettings();

  const userDataManager = new UserDataManager(logger);
  let sniffer = new Sniffer({ logger, userDataManager });

  // args: [port] [deviceIndex]
  const args = process.argv.slice(2);
  let server_port = 8989;
  let deviceIdxFromArgs = undefined;
  if (args[0] && /^\d+$/.test(args[0])) server_port = parseInt(args[0], 10);
  if (args[1] && /^\d+$/.test(args[1])) deviceIdxFromArgs = parseInt(args[1], 10);

  // prefer saved adapter
  let deviceIdx = (globalSettings.selectedDevice !== undefined) ? globalSettings.selectedDevice : deviceIdxFromArgs;

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
  });

  // core API (UI, stats, position endpoint, etc.)
  initializeApi(app, server, io, userDataManager, logger, globalSettings);

  // ===== Adapter selection API =====
  // GET /api/adapters -> list NICs on this machine
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

  // POST /api/adapter { index?:number, name?:string } -> switch capture interface
  app.use(express.json());
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

  async function switchAdapter(idx) {
    try {
      if (typeof sniffer.switchDevice === 'function') {
        await sniffer.switchDevice(idx, PacketProcessor);
      } else if (typeof sniffer.stop === 'function') {
        try { sniffer.stop(); } catch (_) {}
        await sniffer.start(idx, PacketProcessor);
      } else {
        // fallback: replace instance
        try { sniffer.cap && sniffer.cap.close && sniffer.cap.close(); } catch (_) {}
        sniffer = new Sniffer({ logger, userDataManager });
        await sniffer.start(idx, PacketProcessor);
      }
      logger.info(`Switched capture to adapter index ${idx}`);
      return true;
    } catch (e) {
      logger.error(`Switch failed: ${e.message}`);
      return false;
    }
  }
  // ===== End adapter selection API =====

  server.listen(server_port, '0.0.0.0', () => {
    const localUrl = `http://localhost:${server_port}`;
    console.log(`Server running at ${localUrl}`);
  });

  try {
    await sniffer.start(deviceIdx, PacketProcessor);
  } catch (error) {
    logger.error(`Error starting sniffer: ${error.message}`);
  }

  // maintenance
  setInterval(() => {
    userDataManager.checkTimeoutClear();
  }, 10000);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
