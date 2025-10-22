const zlib = require('zlib');
const pb = require('./blueprotobuf');
const Long = require('long');
const pbjs = require('protobufjs/minimal');
const fs = require('fs');

const monsterNames = require('../tables/monster_names.json');

class BinaryReader {
    constructor(buffer, offset = 0) {
        this.buffer = buffer;
        this.offset = offset;
    }

    readUInt64() {
        const value = this.buffer.readBigUInt64BE(this.offset);
        this.offset += 8;
        return value;
    }

    readUInt32() {
        const value = this.buffer.readUInt32BE(this.offset);
        this.offset += 4;
        return value;
    }

    readUInt32LE() {
        const value = this.buffer.readUInt32LE(this.offset);
        this.offset += 4;
        return value;
    }

    readUInt16() {
        const value = this.buffer.readUInt16BE(this.offset);
        this.offset += 2;
        return value;
    }

    readInt32() {
        const value = this.buffer.readInt32BE(this.offset);
        this.offset += 4;
        return value;
    }

    readFloat32() {
        const value = this.buffer.readFloatBE(this.offset);
        this.offset += 4;
        return value;
    }

    readBytes(length) {
        const value = this.buffer.subarray(this.offset, this.offset + length);
        this.offset += length;
        return value;
    }

    peekUInt32() {
        return this.buffer.readUInt32BE(this.offset);
    }

    remaining() {
        return this.buffer.length - this.offset;
    }

    readRemaining() {
        return this.readBytes(this.remaining());
    }
}

const MessageType = {
    None: 0,
    Call: 1,
    Notify: 2,
    Return: 3,
    Echo: 4,
    FrameUp: 5,
    FrameDown: 6,
};

const NotifyMethod = {
    SyncNearEntities: 0x00000006,
    SyncContainerData: 0x00000015,
    SyncContainerDirtyData: 0x00000016,
    SyncServerTime: 0x0000002b, // También contiene CharTeam (TeamId, LeaderId)
    SyncNearDeltaInfo: 0x0000002d,
    SyncToMeDeltaInfo: 0x0000002e,
};

const AttrType = {
    AttrName: 0x01,
    AttrId: 0x0a,
    AttrProfessionId: 0xdc,
    AttrFightPoint: 0x272e,
    AttrLevel: 0x2710,
    AttrRankLevel: 0x274c,
    AttrCri: 0x2b66,
    AttrLucky: 0x2b7a,
    AttrHp: 0x2c2e,
    AttrMaxHp: 0x2c38,
    AttrElementFlag: 0x646d6c,
    AttrReductionLevel: 0x64696d,
    AttrReduntionId: 0x6f6c65,
    AttrEnergyFlag: 0x543cd3c6,
};

const ProfessionType = {
    雷影剑士: 21,
    冰魔导师: 22,
    涤罪恶火_战斧: 23,
    涤罪恶火_战剑: 24,
    核能射手: 25,
    兽化斗士: 26,
};

const ElementType = {
    None: 0,
    Fire: 1,
    Ice: 2,
    Poison: 3,
    Thunder: 4,
    Wind: 5,
    Rock: 6,
    Light: 7,
    Dark: 8,
    Count: 9,
};

const getProfessionNameFromId = (professionId) => {
    switch (professionId) {
        case ProfessionType.雷影剑士:
            return '雷影剑士';
        case ProfessionType.冰魔导师:
            return '冰魔导师';
        case ProfessionType.涤罪恶火_战斧:
            return '涤罪恶火_战斧';
        case ProfessionType.涤罪恶火_战剑:
            return '涤罪恶火_战剑';
        case ProfessionType.核能射手:
            return '核能射手';
        case ProfessionType.兽化斗士:
            return '兽化斗士';
        default:
            return '未知职业';
    }
};

const getDamageElement = (elementFlag) => {
    switch (elementFlag) {
        case 0:
            return 'None';
        case 1:
            return 'Fire';
        case 2:
            return 'Ice';
        case 3:
            return 'Poison';
        case 4:
            return 'Thunder';
        case 5:
            return 'Wind';
        case 6:
            return 'Rock';
        case 7:
            return 'Light';
        case 8:
            return 'Dark';
        default:
            return 'Unknown';
    }
};

const cap = require('cap').Cap;
const decoders = require('cap').decoders;
const PROTOCOL = decoders.PROTOCOL;

let currentUserUuid = Long.ZERO;

function isUuidPlayer(uuid) {
    if (!uuid) return false;
    // from testing: player uuid has the last 16 bits as 0x0001
    const low16 = uuid.and(Long.fromString('0xffff', true, 16)).toNumber();
    return low16 === 1;
}

function isUuidMonster(uuid) {
    if (!uuid) return false;
    // from testing: monster uuid has the last 16 bits as 0x0002
    const low16 = uuid.and(Long.fromString('0xffff', true, 16)).toNumber();
    return low16 === 2;
}

const ReadString = (reader) => {
    const length = reader.readUInt32LE();
    reader.readInt32();
    const buffer = reader.readBytes(length);
    reader.readInt32();
    return buffer.toString();
};

class PacketProcessor {
    constructor({ logger, userDataManager }) {
        this.logger = logger;
        this.userDataManager = userDataManager;
    }

    _decompressPayload(buffer) {
        if (!zlib.zstdDecompressSync) {
            this.logger.warn('zstdDecompressSync is not available! Please check your Node.js version!');
            return;
        }
        return zlib.zstdDecompressSync(buffer);
    }

    _processAoiSyncDelta(aoiSyncDelta) {
        if (!aoiSyncDelta) return;

        let targetUuid = aoiSyncDelta.Uuid;
        if (!targetUuid) return;
        const isTargetPlayer = isUuidPlayer(targetUuid);
        const isTargetMonster = isUuidMonster(targetUuid);
        targetUuid = targetUuid.shiftRight(16);

        const attrCollection = aoiSyncDelta.Attrs;
        if (attrCollection && attrCollection.Attrs) {
            if (isTargetPlayer) {
                this._processPlayerAttrs(targetUuid.toNumber(), attrCollection.Attrs);
            } else if (isTargetMonster) {
                this._processEnemyAttrs(targetUuid.toNumber(), attrCollection.Attrs);
            }
        }

        const damageEvents = aoiSyncDelta.DamageEvents;
        if (damageEvents && damageEvents.Events) {
            for (const syncDamageInfo of damageEvents.Events) {
                if (!syncDamageInfo) continue;

                const skillId = syncDamageInfo.OwnerId;
                if (!skillId) continue;

                let attackerUuid = syncDamageInfo.TopSummonerId || syncDamageInfo.AttackerUuid;
                if (!attackerUuid) continue;
                const isAttackerPlayer = isUuidPlayer(attackerUuid);
                attackerUuid = attackerUuid.shiftRight(16);

                const value = syncDamageInfo.Value;
                const luckyValue = syncDamageInfo.LuckyValue;
                const damage = value ?? luckyValue ?? Long.ZERO;
                if (damage.isZero()) continue;

                // syncDamageInfo.IsCrit doesn't seem to be set by server, use typeFlag instead
                // const isCrit = syncDamageInfo.IsCrit != null ? syncDamageInfo.IsCrit : false;
                const isCrit = syncDamageInfo.TypeFlag != null ? (syncDamageInfo.TypeFlag & 1) === 1 : false;

                // TODO: from testing, first bit is set when there's crit, 3rd bit for lucky, require more testing here
                const isCauseLucky = syncDamageInfo.TypeFlag != null ? (syncDamageInfo.TypeFlag & 0b100) === 0b100 : false;

                const isMiss = syncDamageInfo.IsMiss != null ? syncDamageInfo.IsMiss : false;
                const isHeal = syncDamageInfo.Type === pb.EDamageType.Heal;
                const isDead = syncDamageInfo.IsDead != null ? syncDamageInfo.IsDead : false;
                const isLucky = !!luckyValue;
                const hpLessenValue = syncDamageInfo.HpLessenValue != null ? syncDamageInfo.HpLessenValue : Long.ZERO;
                const damageElement = getDamageElement(syncDamageInfo.Property);
                const damageSource = syncDamageInfo.DamageSource ?? 0;

                if (isTargetPlayer) {
                    //玩家目标
                    if (isAttackerPlayer) {
                        //玩家对玩家
                        // ignore
                    } else {
                        // pve - 玩家被怪打
                        this.userDataManager.processDamageToPlayer({
                            playerUid: targetUuid.toNumber(),
                            source: damageSource,
                            value: damage.toNumber(),
                            luckyValue: luckyValue?.toNumber?.() ?? 0,
                            isCrit,
                            isCauseLucky,
                            isHeal,
                            isMiss,
                            isDead,
                            isLucky,
                            hpLessenValue: hpLessenValue?.toNumber?.() ?? 0,
                            damageElement,
                            skillId,
                        });
                    }
                } else if (isTargetMonster) {
                    //怪物目标
                    if (isAttackerPlayer) {
                        //玩家对怪
                        this.userDataManager.processPlayerDamage({
                            attackerUid: attackerUuid.toNumber(),
                            source: damageSource,
                            value: damage.toNumber(),
                            luckyValue: luckyValue?.toNumber?.() ?? 0,
                            isCrit,
                            isCauseLucky,
                            isHeal,
                            isMiss,
                            isDead,
                            isLucky,
                            hpLessenValue: hpLessenValue?.toNumber?.() ?? 0,
                            damageElement,
                            skillId,
                        });
                    } else {
                        //怪对怪, ignore
                    }
                } else {
                    //未知目标, ignore
                }
            }
        }
    }

    _processPlayerAttrs(playerUid, attrs) {
        if (!attrs) return;

        for (const attr of attrs) {
            switch (attr.AttrId) {
                case AttrType.AttrName: {
                    if (!attr.AttrData) break;
                    const reader = new BinaryReader(attr.AttrData);
                    try {
                        const name = ReadString(reader).trim();
                        if (name) this.userDataManager.setName(playerUid, name);
                    } catch (e) {}
                    break;
                }
                case AttrType.AttrProfessionId: {
                    if (!attr.AttrData) break;
                    const reader = new BinaryReader(attr.AttrData);
                    try {
                        const value = reader.readUInt32();
                        const professionName = getProfessionNameFromId(value);
                        this.userDataManager.setProfession(playerUid, professionName);
                    } catch (e) {}
                    break;
                }
                case AttrType.AttrFightPoint: {
                    if (!attr.AttrData) break;
                    const reader = new BinaryReader(attr.AttrData);
                    try {
                        const value = reader.readUInt32();
                        this.userDataManager.setFightPoint(playerUid, value);
                    } catch (e) {}
                    break;
                }
                case AttrType.AttrLevel: {
                    if (!attr.AttrData) break;
                    const reader = new BinaryReader(attr.AttrData);
                    try {
                        const value = reader.readUInt32();
                        this.userDataManager.setLevel(playerUid, value);
                    } catch (e) {}
                    break;
                }
                default:
                    break;
            }
        }
    }

    _processEnemyAttrs(enemyUid, attrs) {
        if (!attrs) return;

        let name = 'Unknown';
        let hp = 0;
        let maxHp = 0;
        let reductionLevel = 0;
        let reductionId = 0;
        let elementFlag = 0;

        for (const attr of attrs) {
            switch (attr.AttrId) {
                case AttrType.AttrName: {
                    if (!attr.AttrData) break;
                    const reader = new BinaryReader(attr.AttrData);
                    try {
                        name = ReadString(reader).trim();
                        if (name && monsterNames[name]) name = monsterNames[name];
                        this.userDataManager.setEnemyName(enemyUid, name);
                    } catch (e) {}
                    break;
                }
                case AttrType.AttrId: {
                    if (!attr.AttrData) break;
                    const reader = new BinaryReader(attr.AttrData);
                    try {
                        const id = reader.readUInt32();
                        this.userDataManager.setEnemyId(enemyUid, id);
                    } catch (e) {}
                    break;
                }
                case AttrType.AttrHp: {
                    if (!attr.AttrData) break;
                    const reader = new BinaryReader(attr.AttrData);
                    try {
                        hp = reader.readUInt32();
                        this.userDataManager.setEnemyHp(enemyUid, hp);
                    } catch (e) {}
                    break;
                }
                case AttrType.AttrMaxHp: {
                    if (!attr.AttrData) break;
                    const reader = new BinaryReader(attr.AttrData);
                    try {
                        maxHp = reader.readUInt32();
                        this.userDataManager.setEnemyMaxHp(enemyUid, maxHp);
                    } catch (e) {}
                    break;
                }
                case AttrType.AttrReductionLevel: {
                    if (!attr.AttrData) break;
                    const reader = new BinaryReader(attr.AttrData);
                    try {
                        reductionLevel = reader.readUInt32();
                        this.userDataManager.setEnemyReductionLevel(enemyUid, reductionLevel);
                    } catch (e) {}
                    break;
                }
                case AttrType.AttrReduntionId: {
                    if (!attr.AttrData) break;
                    const reader = new BinaryReader(attr.AttrData);
                    try {
                        reductionId = reader.readUInt32();
                        this.userDataManager.setEnemyReductionId(enemyUid, reductionId);
                    } catch (e) {}
                    break;
                }
                case AttrType.AttrElementFlag: {
                    if (!attr.AttrData) break;
                    const reader = new BinaryReader(attr.AttrData);
                    try {
                        elementFlag = reader.readUInt32();
                        this.userDataManager.setEnemyElement(enemyUid, getDamageElement(elementFlag));
                    } catch (e) {}
                    break;
                }
                default:
                    break;
            }
        }

        if (name !== 'Unknown' && maxHp > 0) {
            this.userDataManager.addEnemy(enemyUid, { name, hp, maxHp, reductionLevel, reductionId, elementFlag });
        }
    }

    _processSyncContainerData(payloadBuffer) {
        const syncContainerData = pb.SyncContainerData.decode(payloadBuffer);
        // this.logger.debug(JSON.stringify(syncContainerData, null, 2));

        if (!syncContainerData.Uuid) return;

        const entityInfo = syncContainerData.Entity;
        if (!entityInfo) return;

        let playerUid = syncContainerData.Uuid.shiftRight(16);
        if (isUuidPlayer(syncContainerData.Uuid)) {
            // jugador
            const container = entityInfo.Container;
            if (!container) return;

            if (!container.CharBaseData) return;
            const vData = container.CharBaseData;
            if (!vData.CharBase) return;
            const charBase = vData.CharBase;

            if (charBase.Name) {
                this.logger.debug(`_processSyncContainerData: Setting player name for UID ${playerUid}: ${charBase.Name}`);
                this.userDataManager.setName(playerUid, charBase.Name);
            }

            if (charBase.FightPoint) this.userDataManager.setFightPoint(playerUid, charBase.FightPoint);

            if (!vData.ProfessionList) return;
            const professionList = vData.ProfessionList;
            if (professionList.CurProfessionId) {
                const professionName = getProfessionNameFromId(professionList.CurProfessionId);
                this.logger.debug(`_processSyncContainerData: Setting player profession for UID ${playerUid}: ${professionName}`);
                this.userDataManager.setProfession(playerUid, professionName);
            }
        } else if (isUuidMonster(syncContainerData.Uuid)) {
            // monster
            const container = entityInfo.Container;
            if (!container) return;

            if (!container.MonsterBaseData) return;
            const vData = container.MonsterBaseData;
            if (!vData.MonsterBase) return;
            const monsterBase = vData.MonsterBase;

            if (monsterBase.Id) this.userDataManager.setEnemyId(playerUid.toNumber(), monsterBase.Id);
        } else {
            // ignore other entities
        }
    }

    _processSyncContainerDirtyData(payloadBuffer) {
        const syncContainerDirtyData = pb.SyncContainerDirtyData.decode(payloadBuffer);
        // this.logger.debug(JSON.stringify(syncContainerDirtyData, null, 2));

        if (!syncContainerDirtyData.Uuid) return;

        const entityInfo = syncContainerDirtyData.Entity;
        if (!entityInfo) return;

        let playerUid = syncContainerDirtyData.Uuid.shiftRight(16);
        if (isUuidPlayer(syncContainerDirtyData.Uuid)) {
            // jugador
            const container = entityInfo.Container;
            if (!container) return;

            const attrCollection = container.Attrs;
            if (attrCollection && attrCollection.Attrs) {
                this._processPlayerAttrs(playerUid.toNumber(), attrCollection.Attrs);
            }
        } else if (isUuidMonster(syncContainerDirtyData.Uuid)) {
            // monstruo
            const container = entityInfo.Container;
            if (!container) return;

            const attrCollection = container.Attrs;
            if (attrCollection && attrCollection.Attrs) {
                this._processEnemyAttrs(playerUid.toNumber(), attrCollection.Attrs);
            }
        } else {
            // otros
        }
    }

    _processSyncNearEntities(payloadBuffer) {
        const syncNearEntities = pb.SyncNearEntities.decode(payloadBuffer);
        // this.logger.debug(JSON.stringify(syncNearEntities, null, 2));
        const entities = syncNearEntities.Entities;
        if (!entities) return;

        for (const entity of entities) {
            const uuid = entity.Uuid;
            if (uuid && !currentUserUuid.eq(uuid)) {
                currentUserUuid = uuid;
                this.logger.info('Got player UUID! UUID: ' + currentUserUuid + ' UID: ' + currentUserUuid.shiftRight(16));
            }

            if (!entity.Entity) continue;
            const entityInfo = entity.Entity;
            const container = entityInfo.Container;
            if (!container) continue;

            if (isUuidPlayer(uuid)) {
                const vData = container.CharBaseData;
                if (!vData || !vData.CharBase) continue;
                const charBase = vData.CharBase;

                if (charBase.Name) {
                    this.logger.debug(`_processSyncNearEntities: Setting player name for UID ${uuid.shiftRight(16)}: ${charBase.Name}`);
                    this.userDataManager.setName(uuid.shiftRight(16).toNumber(), charBase.Name);
                }

                if (charBase.FightPoint) {
                    this.userDataManager.setFightPoint(uuid.shiftRight(16).toNumber(), charBase.FightPoint);
                }

                if (vData.ProfessionList && vData.ProfessionList.CurProfessionId) {
                    const professionName = getProfessionNameFromId(vData.ProfessionList.CurProfessionId);
                    this.logger.debug(`_processSyncNearEntities: Setting player profession for UID ${uuid.shiftRight(16)}: ${professionName}`);
                    this.userDataManager.setProfession(uuid.shiftRight(16).toNumber(), professionName);
                }
            } else if (isUuidMonster(uuid)) {
                const vData = container.MonsterBaseData;
                if (!vData || !vData.MonsterBase) continue;
                const monsterBase = vData.MonsterBase;

                if (monsterBase.Id) {
                    this.userDataManager.setEnemyId(uuid.shiftRight(16).toNumber(), monsterBase.Id);
                }
            } else {
                // ignore
            }
        }
    }

    _processSyncServerTime(payloadBuffer) {
        const syncServerTime = pb.SyncServerTime.decode(payloadBuffer);
        // this.logger.debug(JSON.stringify(syncServerTime, null, 2));

        const deltaInfo = syncServerTime.DeltaInfo;
        if (!deltaInfo) return;

        this._processAoiSyncDelta(deltaInfo);
    }

    _processSyncNearDeltaInfo(payloadBuffer) {
        const syncNearDeltaInfo = pb.SyncNearDeltaInfo.decode(payloadBuffer);
        // this.logger.debug(JSON.stringify(syncNearDeltaInfo, null, 2));

        const deltas = syncNearDeltaInfo.DeltaInfos;
        if (!deltas) return;

        for (const delta of deltas) {
            this._processAoiSyncDelta(delta);
        }
    }

    _processSyncToMeDeltaInfo(payloadBuffer) {
        const syncToMeDeltaInfo = pb.SyncToMeDeltaInfo.decode(payloadBuffer);
        // this.logger.debug(JSON.stringify(syncToMeDeltaInfo, null, 2));

        const aoiSyncToMeDelta = syncToMeDeltaInfo.DeltaInfo;

        const uuid = aoiSyncToMeDelta.Uuid;
        if (uuid && !currentUserUuid.eq(uuid)) {
            currentUserUuid = uuid;
            this.logger.info('Got player UUID! UUID: ' + currentUserUuid + ' UID: ' + currentUserUuid.shiftRight(16));
        }

        const aoiSyncDelta = aoiSyncToMeDelta.BaseDelta;
        if (!aoiSyncDelta) return;

        this._processAoiSyncDelta(aoiSyncDelta);
    }

    _processNotifyMsg(reader, isZstdCompressed) {
        const serviceUuid = reader.readUInt64();
        const stubId = reader.readUInt32();
        const methodId = reader.readUInt32();

        if (serviceUuid !== 0x0000000063335342n) {
            this.logger.debug(`Skipping NotifyMsg with serviceId ${serviceUuid}`);
            return;
        }

        let msgPayload = reader.readRemaining();
        if (isZstdCompressed) {
            msgPayload = this._decompressPayload(msgPayload);
        }

        switch (methodId) {
            case NotifyMethod.SyncNearEntities:
                this._processSyncNearEntities(msgPayload);
                break;
            case NotifyMethod.SyncContainerData:
                this._processSyncContainerData(msgPayload);
                break;
            case NotifyMethod.SyncContainerDirtyData:
                this._processSyncContainerDirtyData(msgPayload);
                break;
            case NotifyMethod.SyncServerTime:
                this._processSyncServerTime(msgPayload);
                break;
            case NotifyMethod.SyncToMeDeltaInfo:
                this._processSyncToMeDeltaInfo(msgPayload);
                break;
            case NotifyMethod.SyncNearDeltaInfo:
                this._processSyncNearDeltaInfo(msgPayload);
                break;
            default:
                // Try to opportunistically decode movement packets
                this._processPossibleMove(msgPayload);
                break;
        }
        return;
    }

    _processReturnMsg(reader, isZstdCompressed) {
        this.logger.debug(`Unimplemented processing return`);
    }

    processPacket(packets) {
        try {
            const packetsReader = new BinaryReader(packets);

            do {
                let packetSize = packetsReader.peekUInt32();
                if (packetSize < 6) {
                    this.logger.debug(`Received invalid packet`);
                    return;
                }

                const packetReader = new BinaryReader(packetsReader.readBytes(packetSize));
                packetSize = packetReader.readUInt32(); // to advance
                const packetType = packetReader.readUInt16();
                const isZstdCompressed = packetType & 0x8000;
                const msgTypeId = packetType & 0x7fff;

                switch (msgTypeId) {
                    case MessageType.Notify:
                        this._processNotifyMsg(packetReader, isZstdCompressed);
                        break;
                    case MessageType.Return:
                        this._processReturnMsg(packetReader, isZstdCompressed);
                        break;
                    case MessageType.Call:
                    case MessageType.Echo:
                    case MessageType.FrameDown:
                    case MessageType.FrameUp:
                        // nested packet
                        let nestedPacket = packetReader.readRemaining();

                        // decompress if the packet is compressed
                        const nestedReader = new BinaryReader(nestedPacket);
                        const nestedPacketSize = nestedReader.readUInt32();
                        const nestedPacketType = nestedReader.readUInt16();
                        const isNestedZstdCompressed = nestedPacketType & 0x8000;
                        if (isNestedZstdCompressed) {
                            nestedPacket = this._decompressPayload(nestedReader.readRemaining());
                        } else {
                            nestedPacket = nestedReader.readRemaining();
                        }

                        this.processPacket(nestedPacket);
                        break;
                    default:
                        // this.logger.debug(`Ignore packet with message type ${msgTypeId}.`);
                        break;
                }
            } while (packetsReader.remaining() > 0);
        } catch (e) {
            this.logger.error(`Fail while parsing data for player ${currentUserUuid.shiftRight(16)}.\nErr: ${e}`);
        }
    }
}

// ---- movement helper (appended safely) ----
PacketProcessor.prototype._processPossibleMove = function (payloadBuffer) {
    try {
        if (pb.NewMove && pb.NewMove.decode) {
            const m = pb.NewMove.decode(payloadBuffer);
            if (m && m.Info && m.Info.CurPos) {
                const p = m.Info.CurPos;
                const uid = currentUserUuid.shiftRight(16).toNumber();
                this.userDataManager.setLocalPosition({
                    uid,
                    x: p.X ?? 0,
                    y: p.Y ?? 0,
                    z: p.Z ?? 0,
                    dir: p.Dir ?? 0,
                    moveVersion: m.Info.MoveVersion ?? 0,
                });
                return;
            }
        }
    } catch (e) {}
    try {
        if (pb.UserControlInfo && pb.UserControlInfo.decode) {
            const u = pb.UserControlInfo.decode(payloadBuffer);
            if (u && u.CurPos) {
                const p = u.CurPos;
                const uid = currentUserUuid.shiftRight(16).toNumber();
                this.userDataManager.setLocalPosition({
                    uid,
                    x: p.X ?? 0,
                    y: p.Y ?? 0,
                    z: p.Z ?? 0,
                    dir: p.Dir ?? 0,
                    moveVersion: u.MoveVersion ?? 0,
                });
                return;
            }
        }
    } catch (e) {}
};

module.exports = PacketProcessor;
