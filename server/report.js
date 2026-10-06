// 温控报表：按时间区间 + 冷库 + 批次状态给出汇总，每个汇总数都带着同口径的明细。
// 一致性靠结构保证：每个批次只评估一次生成 eval，汇总数全部由明细数组直接 .length / 求和，
// 合计行由同一批 eval 聚合，不允许另算一套。
const store = require('./store');
const coldlib = require('./coldlib');
const { AppError } = require('./errors');
const { BATCH_STATUS } = require('./resources');

// 口径说明：页面与接口都从这里取，两处只能用同一套
const BASIS = [
  '计入批次：所选状态（在库、待放行、已放行、已拒收可勾）、所在冷库符合、且入库时刻落在时间区间内的批次；区间按入库时刻（含起止当天）归集。',
  '跨月归属：一个批次整批归到其入库时刻所在的月，跨月的记录与放行单不拆到两个月；按冷库汇总时整批归到其所在冷库。',
  '没有温度记录的批次：计入批次数，超限、断链、时长都按 0 计，不参与平均 MKT，并在明细中标出“无记录”。',
  '超限批次：区间内至少有 1 个超限段的批次（只看温度是否越限，不因断链或探头过期计入）。',
  '超限段与时长：连续越限为一段，回到范围内即断开；段时长按相邻记录的实际时刻差累加，并按区间端点裁剪。',
  '断链：相邻有效记录时刻差超过断链门槛算一处，处数与缺口时长都按区间端点裁剪后的实际时刻差计。',
  '平均 MKT：按批次全程有效记录以动力学公式逐批算出 MKT，再对有记录的批次取算术平均，保留两位小数。',
  '放行与拒收条数：取这些批次在时间区间内登记的放行单（按放行单的决定时刻归集），一单算一条；还没开单的批次不计。',
  '占比：超限批次占比＝超限批次数÷批次数；放行/拒收占比＝该决定条数÷放行单总数（放行单为 0 时占比记 0）。',
  '有效记录口径：同一探头同一时刻自动与手工并存时以手工为准；停用探头名下的记录不参与计算。',
];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function normalizeBound(value, endOfDay, field, errors) {
  if (value === undefined || value === null || String(value) === '') return '';
  const text = String(value);
  if (DAY_RE.test(text)) return text + (endOfDay ? ' 23:59:59' : ' 00:00:00');
  if (TS_RE.test(text)) return text;
  errors[field] = '时间格式要像 2026-09-01 或 2026-09-01 08:00:00';
  return '';
}

function parseCriteria(data, query) {
  const errors = {};
  const q = query || {};
  const from = normalizeBound(q.from, false, 'from', errors);
  const to = normalizeBound(q.to, true, 'to', errors);
  if (from && to && from > to) errors.to = '止不能早于起';

  let statuses = q.statuses;
  if (statuses === undefined) statuses = BATCH_STATUS.slice();
  else if (!Array.isArray(statuses)) statuses = String(statuses).split(',');
  statuses = statuses.map((s) => String(s).trim()).filter(Boolean);
  if (!statuses.length) statuses = BATCH_STATUS.slice();
  for (const s of statuses) {
    if (!BATCH_STATUS.includes(s)) errors.statuses = '状态只能是：' + BATCH_STATUS.join('、');
  }

  let roomId = q.roomId ? String(q.roomId) : '';
  if (roomId && !data.rooms.some((r) => r.id === roomId)) errors.roomId = '所选冷库不存在';

  const groupBy = q.groupBy === 'room' ? 'room' : 'month';
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '报表条件没通过校验', errors);
  }
  return { from, to, roomId, statuses, groupBy };
}

function inRange(text, from, to) {
  return (!from || text >= from) && (!to || text <= to);
}

// 把 [startAt, endAt] 的区间裁到报表区间内，返回 {startAt,endAt,minutes} 或 null
function clipSpan(startAt, endAt, from, to) {
  if (from && endAt < from) return null;
  if (to && startAt > to) return null;
  const s = from && startAt < from ? from : startAt;
  const e = to && endAt > to ? to : endAt;
  return { startAt: s, endAt: e, minutes: store.minutesBetween(s, e) };
}

function evaluateBatch(data, batch, criteria) {
  const room = data.rooms.find((r) => r.id === batch.roomId) || null;
  const stats = coldlib.excursionStats(data, batch.id);
  const chain = coldlib.chainGaps(data, batch.id);
  const mkt = coldlib.mktCelsius(data, batch.id);
  const { from, to } = criteria;

  const segments = [];
  for (const seg of stats.segments) {
    const clipped = clipSpan(seg.startAt, seg.endAt, from, to);
    if (clipped) segments.push(Object.assign({ batchId: batch.id }, clipped, { peakC: seg.peakC, points: seg.points }));
  }
  const gaps = [];
  for (const gap of chain.gaps) {
    const clipped = clipSpan(gap.from, gap.to, from, to);
    if (clipped) gaps.push(Object.assign({ batchId: batch.id, from: clipped.startAt, to: clipped.endAt, minutes: clipped.minutes }));
  }

  const releases = data.releases
    .filter((r) => r.batchId === batch.id && inRange(r.decidedAt, from, to))
    .map((r) => ({
      id: r.id, batchId: batch.id, decision: r.decision,
      decidedAt: r.decidedAt, decider: r.decider, basis: r.basis,
    }));

  const excursionMinutes = segments.reduce((acc, s) => acc + s.minutes, 0);
  return {
    batchId: batch.id,
    code: batch.code,
    product: batch.product,
    status: batch.status,
    roomId: batch.roomId,
    roomCode: room ? room.code : '',
    roomName: room ? room.name : '',
    loadedAt: batch.loadedAt,
    month: String(batch.loadedAt).slice(0, 7),
    recordCount: stats.recordCount,
    noRecord: stats.recordCount === 0,
    mkt,
    segments,
    gaps,
    releases,
    excursionMinutes,
    excursionBatch: segments.length > 0,
  };
}

function rate(part, whole) {
  return whole > 0 ? store.round((part / whole) * 100, 1) : 0;
}

// 汇总数全部直接来自明细数组，保证对得上
function summarize(evals) {
  const batches = evals;
  const excursionBatches = evals.filter((e) => e.excursionBatch);
  const segments = evals.reduce((acc, e) => acc.concat(e.segments.map((s) => Object.assign({}, s, { batchCode: e.code, roomCode: e.roomCode }))), []);
  const gaps = evals.reduce((acc, e) => acc.concat(e.gaps.map((g) => Object.assign({}, g, { batchCode: e.code, roomCode: e.roomCode }))), []);
  const releases = evals.reduce((acc, e) => acc.concat(e.releases.map((r) => Object.assign({}, r, { batchCode: e.code, roomCode: e.roomCode }))), []);
  const released = releases.filter((r) => r.decision === '放行');
  const rejected = releases.filter((r) => r.decision === '拒收');
  const mkts = evals.filter((e) => !e.noRecord).map((e) => e.mkt);

  return {
    batchCount: batches.length,
    excursionBatchCount: excursionBatches.length,
    excursionMinutes: segments.reduce((acc, s) => acc + s.minutes, 0),
    chainGapCount: gaps.length,
    averageMkt: mkts.length ? store.round(mkts.reduce((a, b) => a + b, 0) / mkts.length, 2) : 0,
    releasedCount: released.length,
    rejectedCount: rejected.length,
    excursionRate: rate(excursionBatches.length, batches.length),
    releasedRate: rate(released.length, releases.length),
    rejectedRate: rate(rejected.length, releases.length),
    details: {
      batches: batches.map(batchDetailItem),
      excursionBatches: excursionBatches.map(batchDetailItem),
      segments: segments.map((s) => ({
        batchId: s.batchId, batchCode: s.batchCode, roomCode: s.roomCode,
        startAt: s.startAt, endAt: s.endAt, minutes: s.minutes, peakC: s.peakC, points: s.points,
      })),
      gaps: gaps.map((g) => ({
        batchId: g.batchId, batchCode: g.batchCode, roomCode: g.roomCode,
        from: g.from, to: g.to, minutes: g.minutes,
      })),
      releases: releases.map((r) => ({
        id: r.id, batchId: r.batchId, batchCode: r.batchCode, roomCode: r.roomCode,
        decision: r.decision, decidedAt: r.decidedAt, decider: r.decider, basis: r.basis,
      })),
      // 平均 MKT 的明细：参与平均的批次逐个列出
      mktBatches: evals.filter((e) => !e.noRecord).map((e) => ({
        batchId: e.batchId, code: e.code, roomCode: e.roomCode,
        recordCount: e.recordCount, mkt: e.mkt,
      })),
    },
  };
}

function batchDetailItem(e) {
  return {
    batchId: e.batchId, code: e.code, product: e.product, status: e.status,
    roomId: e.roomId, roomCode: e.roomCode, loadedAt: e.loadedAt, month: e.month,
    recordCount: e.recordCount, noRecord: e.noRecord,
    segmentCount: e.segments.length, excursionMinutes: e.excursionMinutes,
    gapCount: e.gaps.length, mkt: e.mkt,
    releasedCount: e.releases.filter((r) => r.decision === '放行').length,
    rejectedCount: e.releases.filter((r) => r.decision === '拒收').length,
  };
}

function buildReport(data, query) {
  const criteria = parseCriteria(data, query);
  const picked = data.batches.filter((b) => {
    if (!criteria.statuses.includes(b.status)) return false;
    if (criteria.roomId && b.roomId !== criteria.roomId) return false;
    if (!inRange(b.loadedAt, criteria.from, criteria.to)) return false;
    return true;
  });
  const evals = picked.map((b) => evaluateBatch(data, b, criteria));

  const groups = new Map();
  const order = [];
  for (const e of evals) {
    const key = criteria.groupBy === 'room' ? e.roomId || '(none)' : e.month;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key).push(e);
  }
  const rows = order.map((key) => {
    const list = groups.get(key);
    const first = list[0];
    const label = criteria.groupBy === 'room'
      ? { key, code: first.roomCode || '—', name: first.roomName || '（冷库已不存在）' }
      : { key, month: key };
    return Object.assign({ scope: label }, summarize(list));
  });
  if (criteria.groupBy === 'room') {
    rows.sort((a, b) => (a.scope.code < b.scope.code ? -1 : 1));
  } else {
    rows.sort((a, b) => (a.scope.month < b.scope.month ? -1 : 1));
  }

  return {
    criteria: {
      from: criteria.from, to: criteria.to, roomId: criteria.roomId,
      statuses: criteria.statuses, groupBy: criteria.groupBy,
    },
    basis: BASIS,
    rows,
    total: Object.assign({ scope: { key: 'TOTAL' } }, summarize(evals)),
  };
}

module.exports = { buildReport, BASIS };
