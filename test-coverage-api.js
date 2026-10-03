'use strict';

// 单视野覆盖核对的端到端 HTTP 自测（npm test）：在临时 DATA_DIR 上启动真实服务，走
// 上传 → 未定标保存视野/轮廓 → 草稿覆盖（像素面积+待定标）→ 错误语义 →
// 定标后物理面积 → 发布冻结 → 草稿改动（实时变/旧报告不变）→ 更正新报告反映新草稿 全流程，
// 并验证只读：查询不改草稿版本、不追加修订、不改报告。
// 纯几何逻辑（交集/孔洞/重叠/边界）见 test-coverage.js。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const PORT = 8235;
const DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pm-coverage-'));

const base = `http://localhost:${PORT}`;
let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('ok -', name); }
  else { failures += 1; console.error('FAIL -', name, extra != null ? JSON.stringify(extra) : ''); }
}

async function jget(p) {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function jsend(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
function upload(buffer) {
  return new Promise((resolve, reject) => {
    const boundary = '----b' + Math.random().toString(16).slice(2);
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\n` +
      'Content-Type: image/png\r\n\r\n');
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const req = require('http').request(base + '/api/images', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': head.length + buffer.length + tail.length }
    }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d || '{}') }));
    });
    req.on('error', reject);
    req.write(head); req.write(buffer); req.write(tail); req.end();
  });
}

const sq = (x, y, w) => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + w }, { x, y: y + w }
];
// 显式矩形（宽、高可不同）
const rect = (x, y, w, h) => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }
];

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let started = false;
  srv.stdout.on('data', (d) => { if (String(d).includes('已启动')) started = true; });
  srv.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 50 && !started; i++) await new Promise((r) => setTimeout(r, 100));
  if (!started) throw new Error('server did not start');

  try {
    const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#ffffff' } })
      .png().toBuffer();

    const up = await upload(png);
    check('上传图片成功', up.status === 201, up);
    const imgId = up.body.id;

    // 第二张切片：用于验证「视野标识不属于指定切片」
    const up2 = await upload(png);
    const otherId = up2.body.id;

    // 未定标即可保存视野与轮廓
    // 视野 f1：(50,50) 100×100；f2 带孔洞
    let r = await jsend('PUT', `/api/images/${imgId}/fields`, {
      version: 1,
      fields: [
        { id: 'f1', name: '中心视野', outer: sq(50, 50, 100), holes: [] },
        { id: 'f2', name: '带孔视野', outer: sq(180, 180, 80), holes: [sq(200, 200, 20)] }
      ]
    });
    check('未定标保存视野 200', r.status === 200, r.body && r.body.error);

    // 细胞：a 跨视野左边界（视野内 x∈[50,100] 共 50×100=5000）；
    // b(90,50) 30×100 与 a 在 x∈[90,100] 重叠 1000，视野内 3000；并集覆盖 5000+3000−1000=7000。
    // d 完全在 f2 的孔洞（200,200 20×20）内，对 f2 不贡献。
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: 2,
      cells: [
        { id: 'a', name: '甲', outer: rect(40, 50, 60, 100), holes: [] },
        { id: 'b', name: '乙', outer: rect(90, 50, 30, 100), holes: [] },
        { id: 'd', name: '丁', outer: sq(205, 205, 10), holes: [] }
      ]
    });
    check('未定标保存轮廓 200', r.status === 200, r.body && r.body.error);

    // 另一切片保存同名 id 视野
    r = await jsend('PUT', `/api/images/${otherId}/fields`, {
      version: 1,
      fields: [{ id: 'f1', name: '别的切片视野', outer: sq(0, 0, 50), holes: [] }]
    });
    check('另一切片保存视野 200', r.status === 200, r.body && r.body.error);

    const draftCov = (id, fieldId) =>
      jsend('POST', `/api/images/${id}/field-coverage`, { fieldId });
    const reportCov = (id, fieldId) =>
      jsend('POST', `/api/reports/${id}/field-coverage`, { fieldId });

    // ---- 未定标草稿：像素面积与覆盖率给出，物理面积待定标 ----
    r = await draftCov(imgId, 'f1');
    check('未定标草稿覆盖查询 200', r.status === 200, r.body && r.body.error);
    check('scope/标识回显',
      r.body.scope === 'draft' && r.body.imageId === imgId &&
      r.body.coverage.fieldId === 'f1' && r.body.coverage.fieldName === '中心视野' &&
      r.body.calibrated === false, r.body);
    check('像素净面积/覆盖/未覆盖',
      r.body.coverage.fieldAreaPx === 10000 &&
      r.body.coverage.coveredAreaPx === 7000 &&
      r.body.coverage.uncoveredAreaPx === 3000, r.body.coverage);
    check('覆盖率 70%', r.body.coverage.coveragePercent === 70, r.body.coverage);
    check('贡献细胞为 甲、乙（跨边界计内部、重叠去重）',
      r.body.coverage.contributingCellCount === 2 &&
      r.body.coverage.contributingCells.map((c) => c.key).join() === 'a,b', r.body.coverage);
    check('未定标物理面积为 null 且文本待定标',
      r.body.coverage.fieldAreaMm2 === null &&
      r.body.coverage.coveredAreaMm2 === null &&
      r.body.coverage.uncoveredAreaMm2 === null &&
      r.body.coverage.fieldAreaText === '待定标' &&
      r.body.coverage.coveredAreaText === '待定标', r.body.coverage);
    check('未定标像素文本仍给出', r.body.coverage.fieldAreaPxText === '10000');

    // f2：丁完全在 f2 孔洞内 → 覆盖 0；净面积 = 6400−400 = 6000
    r = await draftCov(imgId, 'f2');
    check('视野孔洞内细胞不贡献',
      r.status === 200 && r.body.coverage.fieldAreaPx === 6000 &&
      r.body.coverage.coveredAreaPx === 0 &&
      r.body.coverage.contributingCellCount === 0, r.body.coverage);

    // ---- 只读：查询前后草稿版本与修订数不变 ----
    let imgBefore = (await jget(`/api/images/${imgId}`)).body;
    const revsBefore = (await jget(`/api/images/${imgId}/revisions`)).body.revisions.length;
    await draftCov(imgId, 'f1');
    await draftCov(imgId, 'f2');
    let imgAfter = (await jget(`/api/images/${imgId}`)).body;
    const revsAfter = (await jget(`/api/images/${imgId}/revisions`)).body.revisions.length;
    check('覆盖查询不改草稿版本', imgBefore.version === imgAfter.version,
      { before: imgBefore.version, after: imgAfter.version });
    check('覆盖查询不追加修订', revsBefore === revsAfter, { revsBefore, revsAfter });

    // ---- 错误语义（草稿） ----
    r = await jsend('POST', `/api/images/${imgId}/field-coverage`, {});
    check('缺 fieldId → 400', r.status === 400 && /fieldId 必须是单个非空/.test(r.body.error), r.body);
    r = await jsend('POST', `/api/images/${imgId}/field-coverage`, { fieldId: ['f1'] });
    check('fieldId 非字符串 → 400', r.status === 400, r.body);
    r = await jsend('POST', `/api/images/${imgId}/field-coverage`, { fieldId: 'nope' });
    check('视野标识不存在 → 400（指明 id）',
      r.status === 400 && /视野标识不存在：nope/.test(r.body.error), r.body);
    r = await draftCov(otherId, 'f2');
    check('视野不属于该切片 → 400（不泄露其它切片）',
      r.status === 400 && /视野标识不存在：f2/.test(r.body.error), r.body);
    r = await draftCov('no-such-image', 'f1');
    check('草稿不存在 → 404', r.status === 404 && /图片不存在/.test(r.body.error), r.body);

    // ---- 定标后：物理面积 mm²（1px=1μm → 7000px²=0.007mm²） ----
    r = await jsend('PUT', `/api/images/${imgId}/calibration`, {
      version: 3, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100
    });
    check('定标 200', r.status === 200, r.body && r.body.error);
    r = await draftCov(imgId, 'f1');
    check('定标后物理面积给出',
      r.status === 200 && r.body.calibrated === true &&
      Math.abs(r.body.coverage.fieldAreaMm2 - 0.01) < 1e-12 &&
      Math.abs(r.body.coverage.coveredAreaMm2 - 0.007) < 1e-12 &&
      Math.abs(r.body.coverage.uncoveredAreaMm2 - 0.003) < 1e-12 &&
      r.body.coverage.coverageText === '70%', r.body.coverage);

    // ---- 发布冻结 ----
    r = await jsend('POST', `/api/images/${imgId}/publish`, { version: 4, title: '覆盖切片' });
    check('发布 201', r.status === 201, r.body && r.body.error);
    const rep = r.body.report;

    r = await reportCov(rep.id, 'f1');
    check('报告覆盖查询 200（冻结值）',
      r.status === 200 && r.body.scope === 'report' && r.body.reportId === rep.id &&
      r.body.draftVersion === 4 &&
      r.body.coverage.coveredAreaPx === 7000 &&
      r.body.coverage.coveragePercent === 70, r.body);

    // ---- 报告侧错误语义 ----
    r = await jsend('POST', `/api/reports/${rep.id}/field-coverage`, {});
    check('报告侧缺 fieldId → 400', r.status === 400, r.body);
    r = await reportCov(rep.id, 'nope');
    check('报告侧视野不存在 → 400', r.status === 400 && /视野标识不存在：nope/.test(r.body.error), r.body);
    // f1 属于另一切片的草稿、不属于本报告 → 400
    r = await reportCov(rep.id, 'f1-other');
    check('视野不属于该报告 → 400', r.status === 400, r.body);
    r = await reportCov('no-such-report', 'f1');
    check('报告不存在 → 404', r.status === 404 && /报告不存在/.test(r.body.error), r.body);

    // ---- 冻结性：改草稿细胞 → 草稿实时变，旧报告不变 ----
    let img = (await jget(`/api/images/${imgId}`)).body;
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: img.version,
      cells: [
        { id: 'z', name: '全新细胞', outer: sq(50, 50, 100), holes: [] } // 完全覆盖 f1（10000）
      ]
    });
    check('草稿改轮廓 200', r.status === 200, r.body && r.body.error);

    r = await draftCov(imgId, 'f1');
    check('草稿侧按当前轮廓实时重算（覆盖 10000、100%）',
      r.status === 200 && r.body.coverage.coveredAreaPx === 10000 &&
      r.body.coverage.coveragePercent === 100 &&
      r.body.coverage.contributingCells.map((c) => c.key).join() === 'z', r.body.coverage);

    r = await reportCov(rep.id, 'f1');
    check('旧报告仍为发布时冻结结果（覆盖 7000、70%）',
      r.status === 200 && r.body.coverage.coveredAreaPx === 7000 &&
      r.body.coverage.coveragePercent === 70 &&
      r.body.coverage.contributingCells.map((c) => c.key).join() === 'a,b', r.body.coverage);

    // 查询不改报告
    const repBefore = (await jget(`/api/reports/${rep.id}`)).body;
    await reportCov(rep.id, 'f1');
    const repAfter = (await jget(`/api/reports/${rep.id}`)).body;
    check('报告覆盖查询不改报告内容',
      JSON.stringify(repBefore.cells) === JSON.stringify(repAfter.cells) &&
      repBefore.draftVersion === repAfter.draftVersion);

    // ---- 更正：新报告反映新草稿，旧报告依旧冻结 ----
    img = (await jget(`/api/images/${imgId}`)).body;
    r = await jsend('POST', `/api/reports/${rep.id}/correct`, {
      reason: '重画细胞覆盖整个视野', draftVersion: img.version, expectedTipId: rep.id
    });
    check('更正 201', r.status === 201, r.body && r.body.error);
    const rep2 = r.body.report;
    r = await reportCov(rep2.id, 'f1');
    check('更正后的新报告按新草稿（覆盖 10000、100%）',
      r.status === 200 && r.body.coverage.coveredAreaPx === 10000 &&
      r.body.coverage.coveragePercent === 100, r.body.coverage);
    r = await reportCov(rep.id, 'f1');
    check('被更正的旧报告结果不变（7000、70%）',
      r.status === 200 && r.body.coverage.coveredAreaPx === 7000 &&
      r.body.coverage.coveragePercent === 70, r.body.coverage);

    console.log(failures === 0 ? '\ncoverage API 全部通过' : `\n有 ${failures} 项失败`);
  } finally {
    srv.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
