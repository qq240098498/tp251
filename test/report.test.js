// 报表口径与一致性校验：node test/report.test.js
// 不依赖测试框架，失败即抛错退出非零。
const assert = require('assert');
const store = require('../server/store');
const { buildReport } = require('../server/report');
const coldlib = require('../server/coldlib');

const data = store.load();
let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log('  ✓ ' + name);
}

const SUM_KEYS = ['batchCount', 'excursionBatchCount', 'excursionMinutes', 'chainGapCount', 'releasedCount', 'rejectedCount'];

function checkRowsMatchTotal(r, tag) {
  const sums = {};
  SUM_KEYS.forEach((k) => { sums[k] = 0; });
  for (const row of r.rows) {
    // 每行：明细数组长度（或求和）必须等于汇总数
    assert.strictEqual(row.details.batches.length, row.batchCount, tag + ' 批次数明细对不上');
    assert.strictEqual(row.details.excursionBatches.length, row.excursionBatchCount, tag + ' 超限批次明细对不上');
    assert.strictEqual(row.details.segments.length,
      row.details.excursionBatches.reduce((a, b) => a + b.segmentCount, 0), tag + ' 超限段明细对不上');
    assert.strictEqual(row.details.segments.reduce((a, s) => a + s.minutes, 0), row.excursionMinutes, tag + ' 超限时长明细对不上');
    assert.strictEqual(row.details.gaps.length, row.chainGapCount, tag + ' 断链明细对不上');
    assert.strictEqual(row.details.releases.filter((x) => x.decision === '放行').length, row.releasedCount, tag + ' 放线条数明细对不上');
    assert.strictEqual(row.details.releases.filter((x) => x.decision === '拒收').length, row.rejectedCount, tag + ' 拒收条数明细对不上');
    const mktAvg = row.details.mktBatches.length
      ? store.round(row.details.mktBatches.reduce((a, b) => a + b.mkt, 0) / row.details.mktBatches.length, 2) : 0;
    assert.strictEqual(mktAvg, row.averageMkt, tag + ' 平均 MKT 明细对不上');
    SUM_KEYS.forEach((k) => { sums[k] += row[k]; });
  }
  // 合计行 = 各行之和，且合计行自己的明细也对得上自己的汇总数
  SUM_KEYS.forEach((k) => assert.strictEqual(sums[k], r.total[k], tag + ' 合计对不上：' + k));
  assert.strictEqual(r.total.details.batches.length, r.total.batchCount, tag + ' 合计批次明细对不上');
  assert.strictEqual(r.total.details.segments.reduce((a, s) => a + s.minutes, 0), r.total.excursionMinutes, tag + ' 合计时长明细对不上');
  assert.strictEqual(r.total.details.gaps.length, r.total.chainGapCount, tag + ' 合计断链明细对不上');
  // 合计行的明细集合 = 各行明细集合（同一条明细不会两处不一样）
  const byRows = r.rows.map((x) => x.details.segments.map((s) => s.batchId + '@' + s.startAt).sort()).flat().sort();
  const byTotal = r.total.details.segments.map((s) => s.batchId + '@' + s.startAt).sort();
  assert.deepStrictEqual(byRows, byTotal, tag + ' 合计超限段集合与各行不一致');
}

console.log('报表一致性：');

ok('按月：每行明细=汇总，各行之和=合计', () => {
  checkRowsMatchTotal(buildReport(data, { groupBy: 'month' }), '按月');
});

ok('按冷库：每行明细=汇总，各行之和=合计', () => {
  checkRowsMatchTotal(buildReport(data, { groupBy: 'room' }), '按冷库');
});

ok('同一条件重复生成两次结果完全一致（数组传参与逗号传参等价）', () => {
  const q1 = { from: '2026-09-01', to: '2026-09-30 23:59:59', groupBy: 'month', statuses: ['在库', '待放行'] };
  const q2 = { from: '2026-09-01', to: '2026-09-30 23:59:59', groupBy: 'month', statuses: '在库,待放行' };
  assert.strictEqual(JSON.stringify(buildReport(data, q1)), JSON.stringify(buildReport(data, q2)));
  assert.strictEqual(JSON.stringify(buildReport(data, q1)), JSON.stringify(buildReport(data, q1)));
});

ok('改批次状态条件：批次数、放行条数、占比同时变', () => {
  const all = buildReport(data, { groupBy: 'month' });
  const open = buildReport(data, { groupBy: 'month', statuses: ['在库', '待放行'] });
  assert.strictEqual(all.total.batchCount, 6);
  assert.strictEqual(open.total.batchCount, 5);
  assert.strictEqual(all.total.releasedCount, 1);
  assert.strictEqual(open.total.releasedCount, 0);
  assert.strictEqual(all.rows.find((r) => r.scope.month === '2026-09').excursionRate, 20);
  assert.strictEqual(open.rows.find((r) => r.scope.month === '2026-09').excursionRate, 25);
});

ok('改冷库条件：只剩该冷库批次，合计同步变', () => {
  const r = buildReport(data, { groupBy: 'room', roomId: 'rm-0001' });
  assert.strictEqual(r.total.batchCount, 3);
  assert.strictEqual(r.rows.length, 1);
});

ok('改时间区间：超限段/断链/放行单都按端点裁剪，明细与汇总同步变', () => {
  const cut = buildReport(data, { to: '2026-09-10 11:30:00', groupBy: 'month' });
  const sep = cut.rows.find((r) => r.scope.month === '2026-09');
  assert.strictEqual(sep.excursionMinutes, 30); // 11:00-11:40 的段裁到 11:30
  assert.ok(sep.details.segments.every((s) => s.endAt <= '2026-09-10 11:30:00'));
  const before = buildReport(data, { to: '2026-09-01', groupBy: 'month' });
  assert.strictEqual(before.total.releasedCount, 0); // 放行单 09-06 不在区间
});

ok('跨月批次整批归入库月（bt-0001 记录跨 8/9 月，全部计入 2026-08）', () => {
  const r = buildReport(data, { groupBy: 'month' });
  const aug = r.rows.find((x) => x.scope.month === '2026-08');
  assert.strictEqual(aug.batchCount, 1);
  assert.strictEqual(aug.excursionMinutes, 150);
  assert.strictEqual(aug.details.batches[0].code, 'B-2026-0001');
});

ok('无记录批次计入批次数但不参与平均 MKT，并在明细中标出', () => {
  const r = buildReport(data, { groupBy: 'month' });
  const sep = r.rows.find((x) => x.scope.month === '2026-09');
  const noRecord = sep.details.batches.find((b) => b.code === 'B-2026-0005');
  assert.ok(noRecord && noRecord.noRecord === true);
  assert.ok(!sep.details.mktBatches.some((b) => b.code === 'B-2026-0005'));
});

ok('口径说明随报表返回且页面用同一份（basis 非空、9 条）', () => {
  const r = buildReport(data, {});
  assert.ok(Array.isArray(r.basis) && r.basis.length >= 9);
});

console.log('口径修正回归：');

ok('同探头同时刻自动+人工以手工为准（bt-0004 无超限段）', () => {
  const st = coldlib.excursionStats(data, 'bt-0004');
  assert.strictEqual(st.recordCount, 80);
  assert.strictEqual(st.segmentCount, 0);
});

ok('超限段时长按实际时刻差（bt-0002 段 11:00-11:40 = 40 分钟）', () => {
  const st = coldlib.excursionStats(data, 'bt-0002');
  assert.strictEqual(st.longestMinutes, 40);
  assert.strictEqual(st.totalMinutes, 40);
});

ok('断链按实际缺口分钟（bt-0002 有 4 处，缺口 40/55/25/25）', () => {
  const ch = coldlib.chainGaps(data, 'bt-0002');
  assert.deepStrictEqual(ch.gaps.map((g) => g.minutes), [40, 55, 25, 25]);
  assert.strictEqual(ch.totalGapMinutes, 145);
});

ok('MKT 按 Arrhenius 动力学公式而不是算术平均', () => {
  const ea = Number(data.settings.mktActivationEnergy);
  const rg = Number(data.settings.gasConstant);
  const rows = coldlib.effectiveRecords(data, 'bt-0001');
  let sum = 0;
  rows.forEach((r) => { sum += Math.exp(-ea / (rg * (Number(r.temperatureC) + 273.15))); });
  const expect = store.round(-ea / (rg * Math.log(sum / rows.length)) - 273.15, 2);
  assert.strictEqual(coldlib.mktCelsius(data, 'bt-0001'), expect);
  assert.strictEqual(coldlib.mktCelsius(data, 'bt-0001'), 5.35);
});

ok('无记录批次不满足放行条件', () => {
  const b = data.batches.find((x) => x.id === 'bt-0005');
  const rc = coldlib.releaseCheck(data, b);
  assert.strictEqual(rc.pass, false);
  assert.ok(rc.failed.includes('records'));
});

ok('改设置（上限放宽到 10℃）后超限相关汇总与明细同时归零，MKT 不受影响', () => {
  const clone = JSON.parse(JSON.stringify(data));
  clone.settings.upperLimitC = 10;
  const r = buildReport(clone, { groupBy: 'month' });
  assert.strictEqual(r.total.excursionBatchCount, 0);
  assert.strictEqual(r.total.excursionMinutes, 0);
  assert.strictEqual(r.total.details.segments.length, 0);
  assert.strictEqual(r.total.averageMkt, buildReport(data, { groupBy: 'month' }).total.averageMkt);
});

console.log('\n全部通过：' + passed + ' 项');
