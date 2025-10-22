const { Cap, decoders } = require('cap');
const PROTOCOL = decoders.PROTOCOL;
const EventEmitter = require('events');

function safeLogger(lg) {
  const noop = () => {};
  return {
    info:  typeof lg?.info  === 'function' ? lg.info.bind(lg)  : console.log.bind(console),
    warn:  typeof lg?.warn  === 'function' ? lg.warn.bind(lg)  : console.warn.bind(console),
    error: typeof lg?.error === 'function' ? lg.error.bind(lg) : console.error.bind(console),
    debug: typeof lg?.debug === 'function' ? lg.debug.bind(lg) : noop,
  };
}

class Sniffer extends EventEmitter {
  constructor({ logger, userDataManager }) {
    super();
    this.log = safeLogger(logger);
    this.userDataManager = userDataManager;
    this.cap = null;
    this.running = false;
    this.processor = null;     // PacketProcessor instance
    this.buffers = new Map();  // flowKey -> Buffer
  }

  stop() {
    try { if (this.cap && this.running) this.cap.close(); } catch (_) {}
    this.cap = null;
    this.running = false;
    this.buffers.clear();
  }

  async switchDevice(deviceIndex, PacketProcessor) {
    this.stop();
    return this.start(deviceIndex, PacketProcessor);
  }

  _pickDefaultDeviceIndex() {
    const list = Cap.deviceList();
    if (!list || !list.length) throw new Error('No capture devices found. Install Npcap.');
    let idx = list.findIndex(d =>
      (d.addresses || []).some(a => a.addr && /^\d+\.\d+\.\d+\.\d+$/.test(a.addr)) &&
      !/loopback/i.test(d.description || '')
    );
    if (idx < 0) idx = 0;
    return idx;
  }

  async start(deviceIndex, PacketProcessor) {
    if (this.running) this.stop();

    const list = Cap.deviceList();
    const idx = Number.isInteger(deviceIndex) ? deviceIndex : this._pickDefaultDeviceIndex();
    if (!(idx >= 0 && idx < list.length)) throw new Error(`Invalid device index ${idx}`);

    const PacketProc = PacketProcessor || require('../../algo/packet');
    const loggerForProcessor = safeLogger(this.log);
    this.processor = new PacketProc({ logger: loggerForProcessor, userDataManager: this.userDataManager });

    const device = list[idx].name;
    const filter = 'tcp';
    const bufSize = 10 * 1024 * 1024;
    const buffer = Buffer.allocUnsafe(65535);

    const cap = new Cap();
    cap.open(device, filter, bufSize, buffer);
    if (cap.setMinBytes) cap.setMinBytes(0);

    this.cap = cap;
    this.running = true;

    this.log.info(`Sniffing on [${idx}] ${device} (${list[idx].description || ''})`);

    cap.on('packet', (nbytes) => {
      try {
        const eth = decoders.Ethernet(buffer);
        if (eth.info.type !== PROTOCOL.ETHERNET.IPV4) return;

        const ip = decoders.IPV4(buffer, eth.offset);
        if (ip.info.protocol !== PROTOCOL.IP.TCP) return;

        const tcp = decoders.TCP(buffer, ip.offset);
        const dataLen = ip.info.totallen - ip.hdrlen - tcp.hdrlen;
        if (dataLen <= 0) return;

        const payloadOffset = tcp.offset + tcp.hdrlen;
        const payload = Buffer.from(buffer.subarray(payloadOffset, payloadOffset + dataLen));

        const key = `${ip.info.srcaddr}:${tcp.info.srcport}>${ip.info.dstaddr}:${tcp.info.dstport}`;
        let acc = this.buffers.get(key) || Buffer.alloc(0);
        acc = Buffer.concat([acc, payload]);

        let offset = 0;
        while (acc.length - offset >= 4) {
          const len = acc.readUInt32BE(offset);
          if (len < 6 || len > 2 * 1024 * 1024) { offset += 1; continue; }
          if (acc.length - offset < len) break;
          const frame = acc.subarray(offset, offset + len);
          try { this.processor.processPacket(frame); } catch (_) {}
          offset += len;
        }
        this.buffers.set(key, offset > 0 ? acc.subarray(offset) : acc);
      } catch (_) {}
    });

    return true;
  }
}

module.exports = Sniffer;
