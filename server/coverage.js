'use strict';

// 单视野细胞标注覆盖核对（切片编辑页 / 已发布报告页，只读）
//
// 给定一个取样视野与该草稿/报告的全部细胞，按【几何交集】核对覆盖情况：
//   - 视野净面积：视野外环扣除其全部孔洞；
//   - 细胞覆盖面积：视野净区域与「全部细胞净区域（外轮廓扣除孔洞）的几何并集」的交集；
//   - 未覆盖面积 = 视野净面积 − 细胞覆盖面积；覆盖率 = 覆盖面积 / 视野净面积。
//
// 与既有「按净区域质心计数的密度规则」完全不同：
//   - 跨越视野边界的细胞只计其落在视野净区域内的部分；
//   - 多个细胞相互重叠时，重叠部分在覆盖面积中只计一次（按细胞净区域并集）；
//   - 细胞自身的孔洞、视野的孔洞都不贡献面积；
//   - 仅与视野边界接触（切线、共边）而不进入内部的细胞不贡献面积（边界面积为 0）。
//
// 面积计算：视野外环/孔洞与全部细胞外环/孔洞进入同一份平面排列（复用 merge-stats 的
// buildArrangement），逐个面用严格净区域谓词判定「在视野净区域内」且「被某细胞净区域
// 覆盖」，按有向面积求和——重叠/共线/旋转多边形均为真实几何交集，非面积简单加减。
//
// 本文件同时以 CommonJS（服务端/自测）与浏览器全局 Coverage 两种方式可用；
// 浏览器端依赖 <script> 先加载的 MergeStats（平面排列）与 ClientGeom（几何原语）。

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./geometry'), require('./merge-stats'));
  } else {
    const G = root.ClientGeom;
    root.Coverage = factory({
      pointStrictlyInside: G.gPointStrictlyInside,
      pointInsideOrOn: G.gPointInsideOrOn,
      signedArea: G.gSignedArea
    }, root.MergeStats);
  }
})(typeof self !== 'undefined' ? self : this, function (geo, mergeSvc) {

  const EPS = 1e-9;
  const PENDING = '待定标';

  // μm/px → mm²/px²（与 fields.js / merge-stats.js 相同换算）
  function px2ToMm2(areaPx, scale) {
    return areaPx * scale * scale / 1e6;
  }

  function round(v, n = 6) {
    const f = 10 ** n;
    return Math.round(v * f) / f;
  }

  function cellKey(cell, index) {
    return (cell && typeof cell.id === 'string' && cell.id) ? cell.id : `#${index}`;
  }

  function cellLabel(cell, index) {
    return (cell && cell.name && String(cell.name).trim()) || `细胞 ${index + 1}`;
  }

  function fieldLabel(field, index) {
    return (field && field.name && String(field.name).trim()) || `视野 ${index + 1}`;
  }

  // 点 p 是否严格落在某净区域（外环扣除孔洞）：严格在外环内，
  // 且不在任何孔洞的内部或边界上。视野与细胞净区域共用同一谓词。
  function pointInNetStrict(p, region) {
    if (!geo.pointStrictlyInside(p, region.outer)) return false;
    for (const h of region.holes || []) {
      if (geo.pointInsideOrOn(p, h)) return false;
    }
    return true;
  }

  // 外环包围盒
  function bbox(outer) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of outer) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
  }

  // 两包围盒是否具有正面积的二维重叠（仅边界/角点接触不算）。
  // 只有正面积重叠的细胞才可能与视野净区域有正面积交集；仅边界接触的细胞交集面积为 0，
  // 直接排除既不影响结果，又显著减少进入平面排列的边数。
  function bboxOverlapsArea(a, b) {
    return a.minX < b.maxX - EPS && b.minX < a.maxX - EPS &&
           a.minY < b.maxY - EPS && b.minY < a.maxY - EPS;
  }

  // ---------- 视野标识解析 ----------
  //
  // id 为用户输入的单个视野标识；fields 为同一草稿/报告的全部视野。
  // 非字符串/空白、不存在均抛出明确错误（由接口层返回 400）。
  function resolveField(fields, id) {
    const all = Array.isArray(fields) ? fields : [];
    if (typeof id !== 'string' || !id.trim()) {
      throw new Error('覆盖核对请求无效：fieldId 必须是单个非空的视野标识（id）字符串');
    }
    const fid = id;
    let found = null;
    let foundIndex = -1;
    all.forEach((f, i) => {
      if (f && typeof f.id === 'string' && f.id === fid) { found = f; foundIndex = i; }
    });
    if (!found) {
      throw new Error(`视野标识不存在：${fid}（请使用该切片/报告中存在的视野 id；草稿视野改动或删除后请重新获取列表），请求被拒绝`);
    }
    return { field: found, index: foundIndex };
  }

  // ---------- 单视野覆盖核对 ----------
  //
  // field：被核对的视野（已校验几何）；cells：同一草稿/报告的细胞数组；
  // scale：μm/px（未定标传 null）。只读计算，不修改任何输入。
  function buildFieldCoverage(field, fieldIndex, cells, scale) {
    const safeCells = Array.isArray(cells) ? cells : [];

    // 仅包围盒与视野外环包围盒有正面积重叠的细胞才可能贡献面积；
    // 仅边界接触的细胞交集面积恒为 0，提前排除（仍计入 cellCount，但不进贡献列表/平面排列）。
    const fieldBox = bbox(field.outer);
    const candidates = safeCells
      .map((cell, ci) => ({ cell, ci }))
      .filter(({ cell }) => {
        if (!cell || !Array.isArray(cell.outer) || cell.outer.length < 3) return false;
        try { return bboxOverlapsArea(bbox(cell.outer), fieldBox); } catch { return false; }
      });

    // 视野外环/孔洞 + 候选细胞外环/孔洞进入同一份平面排列
    const rings = [field.outer].concat(field.holes || []);
    for (const { cell } of candidates) {
      rings.push(cell.outer);
      for (const h of (Array.isArray(cell.holes) ? cell.holes : [])) rings.push(h);
    }
    const arrangement = mergeSvc.buildArrangement(rings);

    // 逐面判定：是否在视野净区域内、是否落在某候选细胞净区域（并集覆盖）内。
    // 面边界圈有向面积：视野孔洞的内圈为负，外面圈不计入，故求和即净面积。
    let fieldAreaPx = 0;
    let coveredAreaPx = 0;
    const perCellPx = new Map(); // ci -> 该细胞与视野净区域的有向交集面积
    for (const face of arrangement.faces) {
      let inField;
      try {
        inField = pointInNetStrict(face.samplePoint, field);
      } catch {
        inField = false;
      }
      if (!inField) continue;
      fieldAreaPx += face.area;
      // 该面被哪些细胞净区域覆盖（并集：≥1 即覆盖；同时记录每个细胞的交集面积）
      let coveredByAny = false;
      for (const { cell, ci } of candidates) {
        let inside = false;
        try {
          inside = pointInNetStrict(face.samplePoint, cell);
        } catch {
          inside = false;
        }
        if (inside) {
          coveredByAny = true;
          perCellPx.set(ci, (perCellPx.get(ci) || 0) + face.area); // 有向面积：细胞孔洞内圈为负
        }
      }
      if (coveredByAny) coveredAreaPx += face.area;
    }

    // 浮点尾差夹取（覆盖面积不应超出视野净面积）
    fieldAreaPx = Math.abs(fieldAreaPx);
    coveredAreaPx = Math.max(0, Math.min(fieldAreaPx, Math.abs(coveredAreaPx)));
    let uncoveredAreaPx = fieldAreaPx - coveredAreaPx;
    if (uncoveredAreaPx < 0 && uncoveredAreaPx > -1e-6) uncoveredAreaPx = 0;
    uncoveredAreaPx = Math.max(0, uncoveredAreaPx);

    const coverageRatio = fieldAreaPx > EPS ? coveredAreaPx / fieldAreaPx : null;
    const coveragePercent = coverageRatio == null ? null : round(coverageRatio * 100, 4);

    // 与覆盖面积有非零交集的细胞（跨边界细胞也计入，只要内部部分面积 > 0），按细胞原始顺序
    const contributing = [];
    for (const { cell, ci } of candidates) {
      const a = Math.abs(perCellPx.get(ci) || 0);
      if (a > EPS) {
        contributing.push({ ci, cell, intersectionAreaPx: a });
      }
    }
    contributing.sort((x, y) => x.ci - y.ci);

    const calibrated = typeof scale === 'number' && Number.isFinite(scale) && scale > 0;
    const toMm2 = (px) => (calibrated ? px2ToMm2(px, scale) : null);
    const mmText = (px) => (calibrated ? String(round(toMm2(px))) : PENDING);

    const result = {
      kind: 'field-coverage',
      fieldId: field.id,
      fieldName: fieldLabel(field, fieldIndex < 0 ? 0 : fieldIndex),
      fieldHoles: Array.isArray(field.holes) ? field.holes.length : 0,
      cellCount: safeCells.length,
      // 像素面积与覆盖率：未定标草稿也照常给出
      fieldAreaPx: round(fieldAreaPx),
      coveredAreaPx: round(coveredAreaPx),
      uncoveredAreaPx: round(uncoveredAreaPx),
      coverageRatio,
      coveragePercent,
      coverageText: coverageRatio == null ? '—' : `${round(coverageRatio * 100, 2)}%`,
      // 物理面积（mm²）：未定标时为 null，展示文本统一“待定标”
      fieldAreaMm2: calibrated ? round(toMm2(fieldAreaPx)) : null,
      coveredAreaMm2: calibrated ? round(toMm2(coveredAreaPx)) : null,
      uncoveredAreaMm2: calibrated ? round(toMm2(uncoveredAreaPx)) : null,
      fieldAreaText: mmText(fieldAreaPx),
      coveredAreaText: mmText(coveredAreaPx),
      uncoveredAreaText: mmText(uncoveredAreaPx),
      // 像素面积展示文本（始终可用，未定标时页面据此展示）
      fieldAreaPxText: String(round(fieldAreaPx)),
      coveredAreaPxText: String(round(coveredAreaPx)),
      uncoveredAreaPxText: String(round(uncoveredAreaPx)),
      contributingCellCount: contributing.length,
      contributingCells: contributing.map(({ ci, cell, intersectionAreaPx }) => ({
        key: cellKey(cell, ci),
        name: cellLabel(cell, ci),
        intersectionAreaPx: round(intersectionAreaPx),
        intersectionAreaMm2: calibrated ? round(toMm2(intersectionAreaPx)) : null,
        intersectionAreaText: mmText(intersectionAreaPx)
      })),
      calibrated
    };
    return result;
  }

  return {
    PENDING,
    pointInNetStrict,
    resolveField,
    buildFieldCoverage
  };
});
