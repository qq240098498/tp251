const { AppError } = require('./errors');
const store = require('./store');
const coldlib = require('./coldlib');

const ROOM_STATUS = ['运行', '检修', '停用'];
const ROOM_TYPE = ['冷藏库', '冷藏车', '冷冻库'];
const PROBE_STATUS = ['在用', '停用', '送检'];
const BATCH_STATUS = ['在库', '待放行', '已放行', '已拒收'];
const SOURCE_LIST = ['自动', '人工'];

function roomCode(data, id) {
  const room = data.rooms.find((r) => r.id === id);
  return room ? room.code : '';
}
function batchCode(data, id) {
  const batch = data.batches.find((b) => b.id === id);
  return batch ? batch.code : '';
}
function probeCode(data, id) {
  const probe = data.probes.find((p) => p.id === id);
  return probe ? probe.code : '';
}

function decorateRoom(data, room) {
  const probes = data.probes.filter((p) => p.roomId === room.id);
  const batches = data.batches.filter((b) => b.roomId === room.id);
  return Object.assign({}, room, {
    probeCount: probes.length,
    runningProbeCount: probes.filter((p) => p.status === '在用').length,
    batchCount: batches.length,
    openBatchCount: batches.filter((b) => b.status === '在库' || b.status === '待放行').length,
  });
}

function decorateProbe(data, probe) {
  const records = data.records.filter((r) => r.probeId === probe.id);
  return Object.assign({}, probe, {
    roomCode: roomCode(data, probe.roomId),
    recordCount: records.length,
    manualCount: records.filter((r) => r.source === '人工').length,
    expired: !coldlib.probeValidOn(probe, store.nowText().slice(0, 10)),
  });
}

function decorateBatch(data, batch) {
  const stats = coldlib.excursionStats(data, batch.id);
  const check = coldlib.releaseCheck(data, batch);
  const releases = data.releases.filter((r) => r.batchId === batch.id);
  return Object.assign({}, batch, {
    roomCode: roomCode(data, batch.roomId),
    recordCount: stats.recordCount,
    longestExcursionMinutes: stats.longestMinutes,
    totalExcursionMinutes: stats.totalMinutes,
    mkt: check.mkt,
    chainGapCount: check.chain.gapCount,
    expiredProbeCodes: check.expiredProbes.map((p) => p.probeCode),
    releaseCheck: check,
    releaseCount: releases.length,
    lastDecision: releases.length ? releases[releases.length - 1].decision : '',
  });
}

function listRooms(data, query) {
  const q = query || {};
  let rows = data.rooms.slice();
  if (q.status) rows = rows.filter((r) => r.status === q.status);
  if (q.type) rows = rows.filter((r) => r.type === q.type);
  if (q.keyword) {
    const kw = String(q.keyword).toLowerCase();
    rows = rows.filter((r) => [r.code, r.name, r.location].some((f) => String(f || '').toLowerCase().includes(kw)));
  }
  return rows.map((r) => decorateRoom(data, r)).sort((a, b) => (a.code < b.code ? -1 : 1));
}

function roomDetail(data, id) {
  const room = data.rooms.find((r) => r.id === id);
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', '这个冷库或者车厢不存在');
  return Object.assign({}, decorateRoom(data, room), {
    probes: data.probes.filter((p) => p.roomId === id).map((p) => decorateProbe(data, p)),
    batches: data.batches.filter((b) => b.roomId === id).map((b) => decorateBatch(data, b)),
  });
}

function validateRoom(payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.code || '').trim()) errors.code = '编码不能为空';
  if (!String(merged.name || '').trim()) errors.name = '名称不能为空';
  if (!ROOM_TYPE.includes(merged.type)) errors.type = '类型只能是：' + ROOM_TYPE.join('、');
  if (!ROOM_STATUS.includes(merged.status)) errors.status = '状态只能是：' + ROOM_STATUS.join('、');
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '有项目没通过校验', errors);
}

function createRoom(data, payload) {
  validateRoom(payload, null);
  const room = {
    id: store.nextId('rm', data.rooms),
    code: String(payload.code).trim(),
    name: String(payload.name).trim(),
    type: payload.type,
    location: String(payload.location || '').trim(),
    capacityPlt: Number(payload.capacityPlt) || 0,
    status: payload.status,
    remark: String(payload.remark || ''),
  };
  data.rooms.push(room);
  return decorateRoom(data, room);
}

function updateRoom(data, id, payload) {
  const room = data.rooms.find((r) => r.id === id);
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', '这个冷库或者车厢不存在');
  validateRoom(payload, room);
  const merged = Object.assign({}, room, payload);
  Object.assign(room, {
    name: String(merged.name).trim(),
    type: merged.type,
    location: String(merged.location || '').trim(),
    capacityPlt: Number(merged.capacityPlt) || 0,
    status: merged.status,
    remark: String(merged.remark || ''),
  });
  return decorateRoom(data, room);
}

function removeRoom(data, id) {
  const room = data.rooms.find((r) => r.id === id);
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', '这个冷库或者车厢不存在');
  const used = data.probes.filter((p) => p.roomId === id).length + data.batches.filter((b) => b.roomId === id).length;
  if (used > 0) throw new AppError(409, 'ROOM_IN_USE', '名下还有 ' + used + ' 条探头或者批次，不能删除', { count: used });
  data.rooms = data.rooms.filter((r) => r.id !== id);
  return { removed: id };
}

function listProbes(data, query) {
  const q = query || {};
  let rows = data.probes.slice();
  if (q.roomId) rows = rows.filter((p) => p.roomId === q.roomId);
  if (q.status) rows = rows.filter((p) => p.status === q.status);
  return rows.map((p) => decorateProbe(data, p)).sort((a, b) => (a.code < b.code ? -1 : 1));
}

function validateProbe(data, payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.code || '').trim()) errors.code = '编号不能为空';
  if (!data.rooms.some((r) => r.id === merged.roomId)) errors.roomId = '所属冷库不存在';
  if (!PROBE_STATUS.includes(merged.status)) errors.status = '状态只能是：' + PROBE_STATUS.join('、');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(merged.calibratedUntil || ''))) errors.calibratedUntil = '校准有效期要像 2026-12-31';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '有几项没通过校验', errors);
}

function createProbe(data, payload) {
  validateProbe(data, payload, null);
  const probe = {
    id: store.nextId('pb', data.probes),
    code: String(payload.code).trim(),
    roomId: payload.roomId,
    position: String(payload.position || '').trim(),
    status: payload.status,
    calibratedUntil: String(payload.calibratedUntil),
    remark: String(payload.remark || ''),
  };
  data.probes.push(probe);
  return decorateProbe(data, probe);
}

function updateProbe(data, id, payload) {
  const probe = data.probes.find((p) => p.id === id);
  if (!probe) throw new AppError(404, 'PROBE_NOT_FOUND', '这个探头不存在');
  validateProbe(data, payload, probe);
  const merged = Object.assign({}, probe, payload);
  Object.assign(probe, {
    roomId: merged.roomId,
    position: String(merged.position || '').trim(),
    status: merged.status,
    calibratedUntil: String(merged.calibratedUntil),
    remark: String(merged.remark || ''),
  });
  return decorateProbe(data, probe);
}

function removeProbe(data, id) {
  const probe = data.probes.find((p) => p.id === id);
  if (!probe) throw new AppError(404, 'PROBE_NOT_FOUND', '这个探头不存在');
  const used = data.records.filter((r) => r.probeId === id).length;
  if (used > 0) throw new AppError(409, 'PROBE_IN_USE', '这个探头名下还有 ' + used + ' 条温度记录，不能删除', { count: used });
  data.probes = data.probes.filter((p) => p.id !== id);
  return { removed: id };
}

function listBatches(data, query) {
  const q = query || {};
  let rows = data.batches.slice();
  if (q.roomId) rows = rows.filter((b) => b.roomId === q.roomId);
  if (q.status) rows = rows.filter((b) => b.status === q.status);
  if (q.product) rows = rows.filter((b) => String(b.product || '').includes(q.product));
  const decorated = rows.map((b) => decorateBatch(data, b));
  return decorated.sort((a, b) => (a.loadedAt < b.loadedAt ? 1 : -1));
}

function batchDetail(data, id) {
  const batch = data.batches.find((b) => b.id === id);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  const rows = coldlib.recordsOfBatch(data, id).map((r) => Object.assign({}, r, {
    probeCode: probeCode(data, r.probeId),
    probeExpired: !coldlib.probeValidOn(coldlib.probeOf(data, r.probeId), String(r.at).slice(0, 10)),
  }));
  return Object.assign({}, decorateBatch(data, batch), {
    records: rows,
    effectiveRecords: coldlib.effectiveRecords(data, id).map((r) => Object.assign({}, r, { probeCode: probeCode(data, r.probeId) })),
    segments: coldlib.excursionStats(data, id).segments,
    chainGaps: coldlib.chainGaps(data, id).gaps,
    releases: data.releases.filter((r) => r.batchId === id).slice().sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : -1)),
  });
}

function validateBatch(data, payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.code || '').trim()) errors.code = '批次号不能为空';
  if (!String(merged.product || '').trim()) errors.product = '品名不能为空';
  if (!data.rooms.some((r) => r.id === merged.roomId)) errors.roomId = '所在冷库不存在';
  if (!BATCH_STATUS.includes(merged.status)) errors.status = '状态只能是：' + BATCH_STATUS.join('、');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(merged.loadedAt || ''))) errors.loadedAt = '入库时刻格式要像 2026-09-01 08:00:00';
  const units = Number(merged.units);
  if (!Number.isFinite(units) || units <= 0) errors.units = '件数要是大于零的数';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '有几项没通过校验', errors);
}

function createBatch(data, payload) {
  validateBatch(data, payload, null);
  const batch = {
    id: store.nextId('bt', data.batches),
    code: String(payload.code).trim(),
    product: String(payload.product).trim(),
    spec: String(payload.spec || '').trim(),
    units: Number(payload.units),
    roomId: payload.roomId,
    loadedAt: String(payload.loadedAt),
    supplier: String(payload.supplier || '').trim(),
    status: payload.status,
    remark: String(payload.remark || ''),
  };
  data.batches.push(batch);
  return decorateBatch(data, batch);
}

function updateBatch(data, id, payload) {
  const batch = data.batches.find((b) => b.id === id);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  validateBatch(data, payload, batch);
  const merged = Object.assign({}, batch, payload);
  Object.assign(batch, {
    product: String(merged.product).trim(),
    spec: String(merged.spec || '').trim(),
    units: Number(merged.units),
    roomId: merged.roomId,
    loadedAt: String(merged.loadedAt),
    supplier: String(merged.supplier || '').trim(),
    status: merged.status,
    remark: String(merged.remark || ''),
  });
  return decorateBatch(data, batch);
}

function removeBatch(data, id) {
  const batch = data.batches.find((b) => b.id === id);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  if (batch.status === '已放行') throw new AppError(409, 'BATCH_RELEASED', '这个批次已经放行，不能直接删除', { code: batch.code });
  const used = data.records.filter((r) => r.batchId === id).length;
  data.records = data.records.filter((r) => r.batchId !== id);
  data.releases = data.releases.filter((r) => r.batchId !== id);
  data.batches = data.batches.filter((b) => b.id !== id);
  return { removed: id, removedRecords: used };
}

function listRecords(data, query) {
  const q = query || {};
  let rows = data.records.slice();
  if (q.batchId) rows = rows.filter((r) => r.batchId === q.batchId);
  if (q.probeId) rows = rows.filter((r) => r.probeId === q.probeId);
  if (q.source) rows = rows.filter((r) => r.source === q.source);
  if (q.from) rows = rows.filter((r) => r.at >= q.from);
  if (q.to) rows = rows.filter((r) => r.at <= q.to);
  return rows
    .map((r) => Object.assign({}, r, {
      batchCode: batchCode(data, r.batchId),
      probeCode: probeCode(data, r.probeId),
      outOfRange: Number(r.temperatureC) > Number(data.settings.upperLimitC) || Number(r.temperatureC) < Number(data.settings.lowerLimitC),
    }))
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}

function validateRecord(data, payload) {
  const errors = {};
  const batch = data.batches.find((b) => b.id === payload.batchId);
  if (!batch) errors.batchId = '批次不存在';
  const probe = data.probes.find((p) => p.id === payload.probeId);
  if (!probe) errors.probeId = '探头不存在';
  if (!SOURCE_LIST.includes(payload.source)) errors.source = '来源只能是：' + SOURCE_LIST.join('、');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(payload.at || ''))) errors.at = '记录时刻格式要像 2026-09-01 08:00:00';
  if (payload.temperatureC === undefined || payload.temperatureC === '') errors.temperatureC = '温度不能为空';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '这条温度记录没通过校验', errors);
  return { batch, probe };
}

function createRecord(data, payload) {
  validateRecord(data, payload);
  const record = {
    id: store.nextId('rc', data.records),
    batchId: payload.batchId,
    probeId: payload.probeId,
    at: String(payload.at),
    temperatureC: Number(payload.temperatureC),
    source: payload.source,
    operator: String(payload.operator || '').trim(),
    remark: String(payload.remark || ''),
  };
  data.records.push(record);
  return Object.assign({}, record, { batchCode: batchCode(data, record.batchId), probeCode: probeCode(data, record.probeId) });
}

function removeRecord(data, id) {
  const record = data.records.find((r) => r.id === id);
  if (!record) throw new AppError(404, 'RECORD_NOT_FOUND', '这条温度记录不存在');
  data.records = data.records.filter((r) => r.id !== id);
  return { removed: id };
}

function listReleases(data, query) {
  const q = query || {};
  let rows = data.releases.slice();
  if (q.batchId) rows = rows.filter((r) => r.batchId === q.batchId);
  if (q.decision) rows = rows.filter((r) => r.decision === q.decision);
  return rows
    .map((r) => Object.assign({}, r, { batchCode: batchCode(data, r.batchId) }))
    .sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : -1));
}

/* ---------- 温控报表 ----------
   口径（与批次清单、放行判定同一套 coldlib 函数）：
   - 批次按入库时刻 loadedAt 落入 [from, to] 圈定，不填起止表示不限；批次状态不限，全部计入。
   - 跨月批次整体归入入库时刻所在的月份，超限时长按批次全周期累计，不拆分、跨月不重置。
   - 没有温度记录的批次：计入批次数，超限与断链计 0，不参与平均 MKT。
   - 放行与拒收条数：被圈定批次名下的放行台账记录条数。
   - 汇总行的每个数字都由同一份明细聚合而来，明细随汇总一起返回，两处天然一致。
   - 全部排序固定，同一条件重复生成结果一致。 */

const TIME_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function byText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function reportBatchItem(data, batch) {
  const stats = coldlib.excursionStats(data, batch.id);
  const chain = coldlib.chainGaps(data, batch.id);
  const releases = data.releases
    .filter((r) => r.batchId === batch.id)
    .slice()
    .sort((a, b) => byText(a.decidedAt, b.decidedAt) || byText(a.id, b.id));
  const item = {
    id: batch.id,
    code: batch.code,
    product: batch.product,
    roomId: batch.roomId,
    roomCode: roomCode(data, batch.roomId),
    loadedAt: batch.loadedAt,
    status: batch.status,
    recordCount: stats.recordCount,
    longestExcursionMinutes: stats.longestMinutes,
    totalExcursionMinutes: stats.totalMinutes,
    mkt: coldlib.mktCelsius(data, batch.id),
    chainGapCount: chain.gapCount,
    releaseCount: releases.filter((r) => r.decision === '放行').length,
    rejectCount: releases.filter((r) => r.decision === '拒收').length,
  };
  const segments = stats.segments.map((s) => ({
    batchId: batch.id, batchCode: batch.code,
    startAt: s.startAt, endAt: s.endAt, minutes: s.minutes, peakC: s.peakC, points: s.points,
  }));
  const gaps = chain.gaps.map((g) => ({
    batchId: batch.id, batchCode: batch.code, from: g.from, to: g.to, minutes: g.minutes,
  }));
  const releaseRows = releases.map((r) => ({
    id: r.id, batchId: batch.id, batchCode: batch.code,
    decision: r.decision, decidedAt: r.decidedAt, decider: r.decider, basis: r.basis,
  }));
  return { item, segments, gaps, releaseRows };
}

// 把一组批次的指标聚成一行汇总，并带上这一组的全部明细
function aggregateReport(items) {
  const batchCount = items.length;
  const excursionItems = items.filter((x) => x.item.totalExcursionMinutes > 0);
  const mktItems = items.filter((x) => x.item.recordCount > 0);
  const releaseCount = items.reduce((acc, x) => acc + x.item.releaseCount, 0);
  const rejectCount = items.reduce((acc, x) => acc + x.item.rejectCount, 0);
  const sortByBatchThen = (field) => (a, b) => byText(a.batchCode, b.batchCode) || byText(a[field], b[field]);
  return {
    batchCount,
    excursionBatchCount: excursionItems.length,
    excursionBatchRatio: batchCount ? store.round(excursionItems.length / batchCount, 4) : null,
    totalExcursionMinutes: items.reduce((acc, x) => acc + x.item.totalExcursionMinutes, 0),
    chainGapCount: items.reduce((acc, x) => acc + x.item.chainGapCount, 0),
    totalGapMinutes: items.reduce((acc, x) => acc + x.gaps.reduce((a, g) => a + g.minutes, 0), 0),
    avgMkt: mktItems.length ? store.round(mktItems.reduce((acc, x) => acc + x.item.mkt, 0) / mktItems.length, 2) : 0,
    mktBatchCount: mktItems.length,
    releaseCount,
    rejectCount,
    releaseRatio: releaseCount + rejectCount ? store.round(releaseCount / (releaseCount + rejectCount), 4) : null,
    batches: items.map((x) => x.item),
    excursionBatches: excursionItems.map((x) => x.item),
    segments: items.reduce((acc, x) => acc.concat(x.segments), []).sort(sortByBatchThen('startAt')),
    chainGaps: items.reduce((acc, x) => acc.concat(x.gaps), []).sort(sortByBatchThen('from')),
    mktBatches: mktItems.map((x) => ({ id: x.item.id, code: x.item.code, product: x.item.product, recordCount: x.item.recordCount, mkt: x.item.mkt })),
    releases: items.reduce((acc, x) => acc.concat(x.releaseRows), []).sort((a, b) => byText(a.decidedAt, b.decidedAt) || byText(a.id, b.id)),
  };
}

function temperatureReport(data, query) {
  const q = query || {};
  const errors = {};
  if (q.from && !TIME_TEXT.test(String(q.from))) errors.from = '起始时刻格式要像 2026-09-01 08:00:00';
  if (q.to && !TIME_TEXT.test(String(q.to))) errors.to = '截止时刻格式要像 2026-09-30 23:59:59';
  if (!errors.from && !errors.to && q.from && q.to && q.from > q.to) errors.to = '起始时刻不能晚于截止时刻';
  const groupBy = q.groupBy || 'room';
  if (!['room', 'month'].includes(groupBy)) errors.groupBy = '分组方式只能是 room 或者 month';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '报表条件没通过校验', errors);

  let batches = data.batches.slice();
  if (q.roomId) batches = batches.filter((b) => b.roomId === q.roomId);
  if (q.from) batches = batches.filter((b) => b.loadedAt >= q.from);
  if (q.to) batches = batches.filter((b) => b.loadedAt <= q.to);
  batches.sort((a, b) => byText(a.loadedAt, b.loadedAt) || byText(a.id, b.id));

  const entries = batches.map((b) => reportBatchItem(data, b));

  const buckets = new Map();
  for (const entry of entries) {
    const key = groupBy === 'month' ? entry.item.loadedAt.slice(0, 7) : entry.item.roomId;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(entry);
  }

  const groups = Array.from(buckets.keys()).map((key) => {
    const room = groupBy === 'room' ? data.rooms.find((r) => r.id === key) : null;
    const label = groupBy === 'month' ? key : (room ? room.code + ' ' + room.name : key);
    return Object.assign(
      { key, label, roomStatus: room ? room.status : '' },
      aggregateReport(buckets.get(key))
    );
  });
  groups.sort((a, b) => byText(a.label, b.label));

  return {
    query: { from: q.from || '', to: q.to || '', roomId: q.roomId || '', groupBy },
    settings: {
      lowerLimitC: Number(data.settings.lowerLimitC),
      upperLimitC: Number(data.settings.upperLimitC),
      allowExcursionMinutes: Number(data.settings.allowExcursionMinutes),
      allowTotalExcursionMinutes: Number(data.settings.allowTotalExcursionMinutes),
      chainGapMinutes: Number(data.settings.chainGapMinutes),
    },
    groups,
    total: aggregateReport(entries),
  };
}

// 放行：登记放行单并改批次状态
function decide(data, batchId, payload) {
  const batch = data.batches.find((b) => b.id === batchId);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  if (!['放行', '拒收'].includes(payload.decision)) {
    throw new AppError(400, 'VALIDATION_FAILED', '决定只能是放行或者拒收', { decision: '请选择放行或者拒收' });
  }
  if (!String(payload.decider || '').trim()) {
    throw new AppError(400, 'VALIDATION_FAILED', '经办人要填', { decider: '经办人不能为空' });
  }
  const check = coldlib.releaseCheck(data, batch);
  const release = {
    id: store.nextId('rl', data.releases),
    batchId: batch.id,
    decision: payload.decision,
    decidedAt: String(payload.decidedAt || store.nowText()),
    decider: String(payload.decider).trim(),
    mkt: check.mkt,
    longestExcursionMinutes: check.longestMinutes,
    totalExcursionMinutes: check.totalMinutes,
    chainGapCount: check.chain.gapCount,
    basis: String(payload.basis || '').trim(),
    remark: String(payload.remark || ''),
  };
  data.releases.push(release);
  batch.status = payload.decision === '放行' ? '已放行' : '已拒收';
  batch.decidedAt = release.decidedAt;
  return { release, batch: decorateBatch(data, batch) };
}

module.exports = {
  listRooms, roomDetail, createRoom, updateRoom, removeRoom,
  listProbes, createProbe, updateProbe, removeProbe,
  listBatches, batchDetail, createBatch, updateBatch, removeBatch,
  listRecords, createRecord, removeRecord,
  listReleases, decide, temperatureReport,
  ROOM_STATUS, ROOM_TYPE, PROBE_STATUS, BATCH_STATUS, SOURCE_LIST,
};
