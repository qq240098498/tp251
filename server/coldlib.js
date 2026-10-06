// 温控口径都集中在这里：超限段、断链、MKT、放行判定
const store = require('./store');

function toDate(text) {
  return new Date(String(text).replace(' ', 'T') + '+08:00');
}

function recordsOfBatch(data, batchId) {
  return data.records
    .filter((r) => r.batchId === batchId)
    .slice()
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function probeOf(data, probeId) {
  return data.probes.find((p) => p.id === probeId) || null;
}

// 同一探头同一时刻既有自动记录又有手工更正时，以手工为准；停用探头名下的记录不参与判定
function effectiveRecords(data, batchId) {
  const rows = recordsOfBatch(data, batchId).filter((row) => {
    const probe = probeOf(data, row.probeId);
    return !probe || probe.status !== '停用';
  });
  const picked = {};
  const order = [];
  for (const row of rows) {
    const key = row.probeId + '|' + row.at;
    if (picked[key] === undefined) {
      picked[key] = row;
      order.push(key);
      continue;
    }
    const current = picked[key];
    // 同一探头同一时刻：人工更正记录覆盖自动采集记录
    if (current.source === '自动' && row.source === '人工') picked[key] = row;
  }
  return order.map((key) => picked[key]);
}

// 超限：连续超出上下限的时段，回到范围内即断开；时长按相邻记录的实际时刻差累加
function segmentStats(rows, settings) {
  const segments = [];
  let current = null;
  for (const row of rows) {
    const value = Number(row.temperatureC);
    const out = value > Number(settings.upperLimitC) || value < Number(settings.lowerLimitC);
    if (out) {
      if (current) {
        current.minutes += store.minutesBetween(current.endAt, row.at);
        current.endAt = row.at;
        current.peakC = value > current.peakC ? value : current.peakC;
        current.points += 1;
      } else {
        current = { startAt: row.at, endAt: row.at, minutes: 0, peakC: value, points: 1 };
        segments.push(current);
      }
    } else {
      current = null;
    }
  }
  const longest = segments.reduce((acc, s) => (s.minutes > acc.minutes ? s : acc), { minutes: 0, startAt: '', endAt: '', peakC: 0, points: 0 });
  const total = segments.reduce((acc, s) => acc + s.minutes, 0);
  return { segments, longestMinutes: longest.minutes, longest, totalMinutes: total, segmentCount: segments.length };
}

function excursionStats(data, batchId) {
  const rows = effectiveRecords(data, batchId);
  const stats = segmentStats(rows, data.settings);
  return Object.assign({}, stats, {
    recordCount: rows.length,
    firstAt: rows.length ? rows[0].at : '',
    lastAt: rows.length ? rows[rows.length - 1].at : '',
  });
}

// 断链：相邻记录的时刻差超过门槛
function chainGaps(data, batchId) {
  const settings = data.settings;
  const rows = effectiveRecords(data, batchId);
  const gaps = [];
  for (let i = 1; i < rows.length; i += 1) {
    const minutes = store.minutesBetween(rows[i - 1].at, rows[i].at);
    if (minutes > Number(settings.chainGapMinutes)) {
      gaps.push({ from: rows[i - 1].at, to: rows[i].at, minutes, countedMinutes: minutes });
    }
  }
  return { gaps, gapCount: gaps.length, totalGapMinutes: gaps.reduce((acc, g) => acc + g.countedMinutes, 0) };
}

// MKT：平均动力学温度 MKT = -Ea / (R·ln((Σ e^(-Ea/(R·T)))/n)) - 273.15，T 用开尔文
function mktCelsius(data, batchId) {
  const settings = data.settings;
  const ea = Number(settings.mktActivationEnergy);
  const r = Number(settings.gasConstant);
  const rows = effectiveRecords(data, batchId);
  if (!rows.length) return 0;
  let sum = 0;
  for (const row of rows) {
    const kelvin = Number(row.temperatureC) + 273.15;
    sum += Math.exp(-ea / (r * kelvin));
  }
  const mktKelvin = -ea / (r * Math.log(sum / rows.length));
  return store.round(mktKelvin - 273.15, 2);
}

// 探头校准有效期
function probeValidOn(probe, day) {
  if (!probe || !probe.calibratedUntil) return true;
  return String(day) <= String(probe.calibratedUntil);
}

function expiredProbes(data, batchId, day) {
  const rows = effectiveRecords(data, batchId);
  const bad = [];
  for (const row of rows) {
    const probe = probeOf(data, row.probeId);
    if (!probe) continue;
    if (!probeValidOn(probe, String(row.at).slice(0, 10))) {
      if (!bad.some((b) => b.probeCode === probe.code)) {
        bad.push({ probeId: probe.id, probeCode: probe.code, calibratedUntil: probe.calibratedUntil, at: row.at });
      }
    }
  }
  return bad;
}

// 累计超限时长：按批次周期累计，跨月不重置
function accumulatedExcursionMinutes(data, batchId) {
  return excursionStats(data, batchId).totalMinutes;
}

// 放行判定：最长超限、累计超限、断链、探头校准四条
function releaseCheck(data, batch) {
  const settings = data.settings;
  const stats = excursionStats(data, batch.id);
  const chain = chainGaps(data, batch.id);
  const accumulated = accumulatedExcursionMinutes(data, batch.id);
  const expired = expiredProbes(data, batch.id, batch.loadedAt ? String(batch.loadedAt).slice(0, 10) : '');
  const conditions = [
    { key: 'records', ok: stats.recordCount > 0, value: stats.recordCount, limit: 1, text: '至少有 1 条温度记录' },
    { key: 'longest', ok: stats.longestMinutes <= Number(settings.allowExcursionMinutes), value: stats.longestMinutes, limit: Number(settings.allowExcursionMinutes), text: '单次连续超限不超过 ' + settings.allowExcursionMinutes + ' 分钟' },
    { key: 'total', ok: accumulated <= Number(settings.allowTotalExcursionMinutes), value: accumulated, limit: Number(settings.allowTotalExcursionMinutes), text: '累计超限不超过 ' + settings.allowTotalExcursionMinutes + ' 分钟' },
    { key: 'chain', ok: chain.gapCount === 0, value: chain.gapCount, limit: 0, text: '全程没有断链' },
  ];
  return {
    mkt: mktCelsius(data, batch.id),
    longestMinutes: stats.longestMinutes,
    totalMinutes: stats.totalMinutes,
    recordCount: stats.recordCount,
    firstAt: stats.firstAt,
    lastAt: stats.lastAt,
    chain,
    expiredProbes: expired,
    conditions,
    pass: conditions.every((c) => c.ok),
    failed: conditions.filter((c) => !c.ok).map((c) => c.key),
  };
}

module.exports = {
  toDate,
  probeOf,
  recordsOfBatch,
  effectiveRecords,
  excursionStats,
  chainGaps,
  mktCelsius,
  probeValidOn,
  expiredProbes,
  accumulatedExcursionMinutes,
  releaseCheck,
};
