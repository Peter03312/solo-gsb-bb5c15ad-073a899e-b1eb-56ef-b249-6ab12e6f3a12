'use strict';

// 单视野细胞覆盖核对自测（node test-coverage.js）：
// 视野标识解析（非字符串/空白/不存在）、净面积（外环−孔洞）、覆盖面积几何交集
// （跨边界只计内部、多细胞重叠只计一次、细胞孔洞/视野孔洞不贡献、仅边界接触为 0、
// 孔洞被其他细胞补上）、未覆盖面积与覆盖率、未定标像素面积与“待定标”物理面积。

const assert = require('assert');
const cov = require('./server/coverage');

const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const SCALE = 1; // 1 px = 1 μm → 1 px² = 1e-6 mm²

let n = 0;
function ok(name) { n += 1; console.log('ok', n, name); }

function coverage(field, cells, scale = SCALE) {
  const resolved = cov.resolveField([field], field.id);
  return cov.buildFieldCoverage(resolved.field, resolved.index, cells, scale);
}

// ---------- 视野标识解析 ----------

assert.throws(() => cov.resolveField([{ id: 'f1' }], undefined), /fieldId 必须是单个非空/);
assert.throws(() => cov.resolveField([{ id: 'f1' }], ['f1']), /fieldId 必须是单个非空/);
assert.throws(() => cov.resolveField([{ id: 'f1' }], '  '), /fieldId 必须是单个非空/);
assert.throws(() => cov.resolveField([{ id: 'f1' }], 'nope'), /视野标识不存在：nope/);
{
  const fields = [{ id: 'a' }, { id: 'b' }];
  const r = cov.resolveField(fields, 'b');
  assert.strictEqual(r.field.id, 'b');
  assert.strictEqual(r.index, 1);
}
ok('视野标识：非字符串/空白/不存在明确拒绝，存在则返回该视野与序号');

// ---------- 基础净面积与无细胞 ----------

{
  const f = { id: 'f1', name: 'F', outer: rect(0, 0, 100, 100), holes: [] };
  const r = coverage(f, []);
  assert.strictEqual(r.fieldAreaPx, 10000);
  assert.strictEqual(r.coveredAreaPx, 0);
  assert.strictEqual(r.uncoveredAreaPx, 10000);
  assert.strictEqual(r.coveragePercent, 0);
  assert.strictEqual(r.coverageText, '0%');
  assert.strictEqual(r.contributingCellCount, 0);
  ok('无细胞：净面积 10000、覆盖 0、未覆盖 10000、覆盖率 0%');
}

// ---------- 视野孔洞从净面积扣除 ----------

{
  const f = { id: 'f1', outer: rect(0, 0, 100, 100), holes: [rect(40, 40, 20, 20)] };
  const r = coverage(f, []);
  assert.strictEqual(r.fieldAreaPx, 9600);
  assert.strictEqual(r.uncoveredAreaPx, 9600);
  ok('视野孔洞：净面积 = 10000−400 = 9600');
}

// ---------- 细胞完全覆盖 ----------

{
  const f = { id: 'f1', outer: rect(0, 0, 100, 100), holes: [] };
  const r = coverage(f, [{ id: 'a', name: 'A', outer: rect(0, 0, 100, 100), holes: [] }]);
  assert.strictEqual(r.coveredAreaPx, 10000);
  assert.strictEqual(r.uncoveredAreaPx, 0);
  assert.strictEqual(r.coveragePercent, 100);
  assert.strictEqual(r.coverageText, '100%');
  assert.strictEqual(r.contributingCellCount, 1);
  ok('单细胞完全覆盖：覆盖 10000、覆盖率 100%');
}

// ---------- 跨越视野边界：只计内部部分 ----------

{
  const f = { id: 'f1', outer: rect(0, 0, 100, 100), holes: [] };
  // 细胞 x 从 -10 到 50：内部为 0..50 共 5000
  const cells = [{ id: 'a', outer: rect(-10, 0, 60, 100), holes: [] }];
  const r = coverage(f, cells);
  assert.strictEqual(r.coveredAreaPx, 5000);
  assert.strictEqual(r.uncoveredAreaPx, 5000);
  assert.ok(Math.abs(r.coveragePercent - 50) < 1e-9);
  assert.strictEqual(r.contributingCells[0].intersectionAreaPx, 5000);
  ok('跨边界细胞：只计视野内部部分（5000），外部不计');
}

// ---------- 多细胞重叠：重叠部分只计一次（并集） ----------

{
  const f = { id: 'f1', outer: rect(0, 0, 100, 100), holes: [] };
  const cells = [
    { id: 'a', outer: rect(0, 0, 60, 100), holes: [] },   // 6000
    { id: 'b', outer: rect(40, 0, 30, 100), holes: [] }   // 3000，与 a 重叠 2000
  ];
  const r = coverage(f, cells);
  assert.strictEqual(r.coveredAreaPx, 7000); // 6000+3000−2000
  assert.strictEqual(r.uncoveredAreaPx, 3000);
  // 每个细胞的交集面积仍分别给出（含重叠），但覆盖总面积只计一次
  const per = Object.fromEntries(r.contributingCells.map((c) => [c.key, c.intersectionAreaPx]));
  assert.strictEqual(per.a, 6000);
  assert.strictEqual(per.b, 3000);
  ok('多细胞重叠：覆盖面积按并集去重（6000+3000−2000=7000），逐细胞交集仍分别给出');
}

// ---------- 细胞孔洞不贡献；被另一细胞补上的孔洞部分计入 ----------

{
  const f = { id: 'f1', outer: rect(0, 0, 100, 100), holes: [] };
  const cells = [
    { id: 'a', outer: rect(10, 10, 50, 50), holes: [rect(20, 20, 20, 20)] }, // 2500−400=2100
    { id: 'b', outer: rect(25, 25, 10, 10), holes: [] }                       // 100 落在 a 的孔洞内
  ];
  const r = coverage(f, cells);
  assert.strictEqual(r.coveredAreaPx, 2200); // 2100 + 100
  ok('细胞孔洞不贡献（2500−400=2100）；另一细胞覆盖孔洞区域时该部分计入（+100=2200）');
}

// ---------- 视野孔洞：即使细胞覆盖该处也不计入 ----------

{
  const f = { id: 'f1', outer: rect(0, 0, 100, 100), holes: [rect(40, 40, 20, 20)] };
  const cells = [{ id: 'a', outer: rect(0, 0, 100, 100), holes: [] }];
  const r = coverage(f, cells);
  assert.strictEqual(r.fieldAreaPx, 9600);
  assert.strictEqual(r.coveredAreaPx, 9600);
  assert.strictEqual(r.uncoveredAreaPx, 0);
  assert.strictEqual(r.coveragePercent, 100);
  ok('视野孔洞区域被细胞覆盖也不计入：覆盖 9600（而非 10000）');
}

// ---------- 仅边界接触（切线/共边）不贡献面积 ----------

{
  const f = { id: 'f1', outer: rect(0, 0, 50, 50), holes: [] };
  const cells = [
    { id: 'edge', outer: rect(50, 0, 10, 50), holes: [] },     // 与右边界共边，主体在外
    { id: 'corner', outer: rect(50, 50, 10, 10), holes: [] }  // 仅顶点接触
  ];
  const r = coverage(f, cells);
  assert.strictEqual(r.coveredAreaPx, 0);
  assert.strictEqual(r.contributingCellCount, 0);
  ok('仅边界/顶点接触：覆盖面积为 0，细胞不计入贡献列表');
}

// ---------- 细胞完全落在视野孔洞内：不贡献 ----------

{
  const f = { id: 'f1', outer: rect(0, 0, 100, 100), holes: [rect(80, 80, 10, 10)] };
  const cells = [
    { id: 'inhole', outer: rect(82, 82, 6, 6), holes: [] }, // 全部在视野孔洞内
    { id: 'a', outer: rect(0, 0, 10, 10), holes: [] }
  ];
  const r = coverage(f, cells);
  assert.strictEqual(r.coveredAreaPx, 100);
  const keys = r.contributingCells.map((c) => c.key);
  assert.deepStrictEqual(keys, ['a']);
  ok('细胞完全落在视野孔洞内不贡献；仅净区域内的细胞计入');
}

// ---------- 旋转多边形交集（非轴对齐） ----------

{
  const f = { id: 'f1', outer: rect(0, 0, 100, 100), holes: [] };
  // 菱形（对角线各 100）面积 5000，整体在内
  const diamond = [{ x: 50, y: 0 }, { x: 100, y: 50 }, { x: 50, y: 100 }, { x: 0, y: 50 }];
  const r = coverage(f, [{ id: 'a', outer: diamond, holes: [] }]);
  assert.ok(Math.abs(r.coveredAreaPx - 5000) < 1e-7, `got ${r.coveredAreaPx}`);
  ok('旋转多边形（菱形）覆盖面积按真实几何交集（5000）');
}

// ---------- 未覆盖面积与覆盖率一致性 ----------

{
  const f = { id: 'f1', outer: rect(0, 0, 80, 80), holes: [] };
  const cells = [{ id: 'a', outer: rect(0, 0, 20, 80), holes: [] }]; // 1600 / 6400 = 25%
  const r = coverage(f, cells);
  assert.ok(Math.abs(r.coveredAreaPx + r.uncoveredAreaPx - r.fieldAreaPx) < 1e-7);
  assert.ok(Math.abs(r.coverageRatio - 0.25) < 1e-9);
  assert.ok(Math.abs(r.coveragePercent - 25) < 1e-9);
  ok('未覆盖 = 净面积 − 覆盖；覆盖率 = 覆盖/净面积（25%）');
}

// ---------- 物理面积换算与未定标 ----------

{
  const f = { id: 'f1', outer: rect(0, 0, 100, 100), holes: [] };
  const cells = [{ id: 'a', outer: rect(0, 0, 100, 100), holes: [] }];

  const cal = coverage(f, cells, 0.5); // 1px=0.5μm → 10000px²=0.0025mm²
  assert.ok(Math.abs(cal.fieldAreaMm2 - 0.0025) < 1e-12);
  assert.ok(Math.abs(cal.coveredAreaMm2 - 0.0025) < 1e-12);
  assert.strictEqual(cal.uncoveredAreaMm2, 0);
  assert.strictEqual(cal.calibrated, true);
  assert.strictEqual(cal.fieldAreaText, '0.0025');

  // 未定标：像素面积与覆盖率照常给出；物理面积为 null、文本“待定标”
  const uncal = coverage(f, cells, null);
  assert.strictEqual(uncal.fieldAreaPx, 10000);
  assert.strictEqual(uncal.coveredAreaPx, 10000);
  assert.strictEqual(uncal.coveragePercent, 100);
  assert.strictEqual(uncal.fieldAreaMm2, null);
  assert.strictEqual(uncal.coveredAreaMm2, null);
  assert.strictEqual(uncal.uncoveredAreaMm2, null);
  assert.strictEqual(uncal.fieldAreaText, cov.PENDING);
  assert.strictEqual(uncal.coveredAreaText, cov.PENDING);
  assert.strictEqual(uncal.uncoveredAreaText, cov.PENDING);
  assert.strictEqual(uncal.calibrated, false);
  assert.strictEqual(uncal.fieldAreaPxText, '10000');
  ok('已定标给出 mm² 物理面积；未定标像素面积/覆盖率照常，物理面积为 null 且文本“待定标”');
}

console.log(`\ncoverage 全部通过（${n} 组）`);
