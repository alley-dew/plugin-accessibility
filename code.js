// App Accessibility Checker - minimal, no-build Figma plugin
// Checks three guidelines:
// 1) Color-independent recognition
// 2) Text/image contrast (>=3:1)
// 3) Auto-rotating content exposes controls (prev/next/pause/full view)

const CONTRAST_THRESHOLD = 3;
const COLOR_INDICATOR_TYPES = ['RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'VECTOR', 'LINE'];
const CONTRAST_SHAPE_TYPES = ['RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'VECTOR', 'LINE', 'BOOLEAN_OPERATION'];
const INDICATOR_MIN_SIDE = 2;
const INDICATOR_MAX_SHORT_SIDE = 24;
const INDICATOR_MAX_LONG_SIDE = 640;
const INDICATOR_MAX_ASPECT = 120;
const INDICATOR_CLUSTER_GAP = 72;
const INDICATOR_MAX_SPREAD = 720;
const AUTO_CONTENT_KEYWORDS = ['carousel', 'slider', 'auto', 'rolling', 'banner', 'slide', '자동', '슬라이드', '배너', '롤링'];
const PREV_KEYWORDS = ['prev', 'previous', '이전', '이전보기', '이전글', '이전배너'];
const NEXT_KEYWORDS = ['next', '다음', '다음보기', '다음글', '다음배너'];
const PAUSE_TEXT_KEYWORDS = ['pause', 'stop', '정지', '일시정지', '멈춤', '재생', 'play', '멈추기'];
const PAUSE_GLYPHS = ['❚', '❙', '❚❚', '⏸', '⏯', '■', '▶', '⏵', '⏹'];
const FULL_KEYWORDS = ['full', '전체 보기', '전체보기'];
const SLIDE_INDEX_REGEX = /^\s*\d+\s*\/\s*\d+\s*$/;

figma.showUI(__html__, { width: 420, height: 520 });

/** Utils **/
const fmtNum = (n) => Math.round(n * 100) / 100;

const isVisibleNode = (node) => {
  let n = node;
  while (n) {
    if (typeof n.visible === 'boolean' && !n.visible) return false;
    n = n.parent;
  }
  return true;
};

const isSolidPaint = (p) => p && p.type === 'SOLID' && (p.visible === undefined || p.visible === true);

const firstSolidFill = (node) => {
  try {
    if ('fills' in node && Array.isArray(node.fills)) {
      return node.fills.find(isSolidPaint) || null;
    }
  } catch (_) {}
  return null;
};

const parentSolidFill = (node) => {
  let p = node.parent;
  while (p) {
    if ('fills' in p && Array.isArray(p.fills)) {
      const solid = p.fills.find(isSolidPaint);
      if (solid) return solid;
    }
    p = p.parent;
  }
  return null;
};

const hasVisibleStroke = (node) => {
  if (!('strokes' in node)) return false;
  try {
    return Array.isArray(node.strokes) && node.strokes.some(isSolidPaint) && node.strokeWeight !== 0;
  } catch (_) {
    return false;
  }
};

const hasEffects = (node) => {
  if (!('effects' in node)) return false;
  try {
    return Array.isArray(node.effects) && node.effects.length > 0;
  } catch (_) {
    return false;
  }
};

const transformPoint = (matrix, x, y) => ({
  x: matrix[0][0] * x + matrix[0][1] * y + matrix[0][2],
  y: matrix[1][0] * x + matrix[1][1] * y + matrix[1][2]
});

const getAbsoluteRect = (node) => {
  if (!node || typeof node.width !== 'number' || typeof node.height !== 'number' || !node.absoluteTransform) {
    return null;
  }
  const m = node.absoluteTransform;
  const corners = [
    transformPoint(m, 0, 0),
    transformPoint(m, node.width, 0),
    transformPoint(m, 0, node.height),
    transformPoint(m, node.width, node.height)
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = maxX - minX;
  const height = maxY - minY;
  return {
    x: minX,
    y: minY,
    width,
    height,
    cx: minX + width / 2,
    cy: minY + height / 2
  };
};

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

const luminance = (r, g, b) => {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
};

const contrastRatio = (fg, bg) => {
  const L1 = luminance(fg.color.r, fg.color.g, fg.color.b);
  const L2 = luminance(bg.color.r, bg.color.g, bg.color.b);
  const light = Math.max(L1, L2);
  const dark = Math.min(L1, L2);
  return (light + 0.05) / (dark + 0.05);
};

const getPageName = (node) => {
  let p = node;
  while (p && p.type !== 'PAGE') p = p.parent;
  return p && p.type === 'PAGE' ? p.name : '';
};

const isLikelyBackgroundName = (name) => {
  if (!name) return false;
  const lower = name.toLowerCase();
  return lower.includes('bg') || lower.includes('background') || lower.includes('container') || lower.includes('frame');
};

const getNodeText = (node) => {
  if (node.type !== 'TEXT') return '';
  try {
    return node.characters || '';
  } catch (_) {
    return '';
  }
};

const gatherTextTokens = (node, tokens) => {
  const name = node.name || '';
  tokens.push(name.toLowerCase());
  if (node.type === 'TEXT') {
    const chars = getNodeText(node);
    tokens.push(chars.toLowerCase());
  }
  if ('children' in node && Array.isArray(node.children)) {
    for (const child of node.children) {
      if (isVisibleNode(child)) gatherTextTokens(child, tokens);
    }
  }
};

const includesKeyword = (tokens, keywords) => keywords.some((kw) => tokens.some((t) => t.includes(kw)));

const collectNodes = (node, predicate, acc = []) => {
  if (!isVisibleNode(node)) return acc;
  if (predicate(node)) acc.push(node);
  if ('children' in node && Array.isArray(node.children)) {
    for (const child of node.children) collectNodes(child, predicate, acc);
  }
  return acc;
};

const isPauseNode = (node) => {
  const name = (node.name || '').toLowerCase();
  if (PAUSE_TEXT_KEYWORDS.some((kw) => name.includes(kw))) return true;
  if (PAUSE_GLYPHS.some((glyph) => name.includes(glyph))) return true;
  if (node.type === 'TEXT') {
    const text = getNodeText(node);
    const lower = text.toLowerCase();
    if (PAUSE_TEXT_KEYWORDS.some((kw) => lower.includes(kw))) return true;
    if (PAUSE_GLYPHS.some((glyph) => text.includes(glyph))) return true;
  }
  return false;
};

const nodesAreNearby = (a, b, maxDx = 160, maxDy = 120) => {
  const rectA = getAbsoluteRect(a);
  const rectB = getAbsoluteRect(b);
  if (!rectA || !rectB) return false;
  const dx = Math.abs(rectA.cx - rectB.cx);
  const dy = Math.abs(rectA.cy - rectB.cy);
  return dx <= maxDx && dy <= maxDy;
};

const colorKey = (paint) => {
  if (!paint || !paint.color) return '';
  const { r, g, b } = paint.color;
  return `${r.toFixed(3)}|${g.toFixed(3)}|${b.toFixed(3)}`;
};

const isIndicatorCandidate = (node) => {
  if (!COLOR_INDICATOR_TYPES.includes(node.type)) return false;
  if (!isVisibleNode(node)) return false;
  if (!('width' in node) || !('height' in node)) return false;
  const width = typeof node.width === 'number' ? Math.abs(node.width) : null;
  const height = typeof node.height === 'number' ? Math.abs(node.height) : null;
  if (width === null || height === null) return false;
  const longSide = Math.max(width, height);
  const shortSide = Math.min(width, height);
  if (shortSide < INDICATOR_MIN_SIDE || shortSide > INDICATOR_MAX_SHORT_SIDE) return false;
  if (longSide < shortSide) return false;
  if (longSide > INDICATOR_MAX_LONG_SIDE) return false;
  if (longSide / Math.max(shortSide, 0.001) > INDICATOR_MAX_ASPECT) return false;
  if ('children' in node && Array.isArray(node.children) && node.children.some((child) => isVisibleNode(child))) return false;
  const fill = firstSolidFill(node);
  if (!fill) return false;
  if (hasVisibleStroke(node) || hasEffects(node)) return false;
  return true;
};

const areRectsClose = (rectA, rectB) => {
  const dx = Math.abs(rectA.cx - rectB.cx);
  const dy = Math.abs(rectA.cy - rectB.cy);
  const allowX = Math.max(rectA.width, rectB.width) + INDICATOR_CLUSTER_GAP;
  const allowY = Math.max(rectA.height, rectB.height) + INDICATOR_CLUSTER_GAP;
  return dx <= allowX && dy <= allowY;
};

const analyzeIndicatorCluster = (cluster) => {
  if (cluster.length < 3) return null;
  const rects = cluster.map((item) => item.rect);
  const cxList = rects.map((r) => r.cx);
  const cyList = rects.map((r) => r.cy);
  const spanX = Math.max(...cxList) - Math.min(...cxList);
  const spanY = Math.max(...cyList) - Math.min(...cyList);
  if (Math.max(spanX, spanY) > INDICATOR_MAX_SPREAD) return null;
  const widths = rects.map((r) => r.width);
  const heights = rects.map((r) => r.height);
  const avgWidth = widths.reduce((a, b) => a + b, 0) / widths.length;
  const avgHeight = heights.reduce((a, b) => a + b, 0) / heights.length;
  const orientation = spanX >= spanY ? 'horizontal' : 'vertical';
  if (orientation === 'horizontal' && spanY > avgHeight * 1.5) return null;
  if (orientation === 'vertical' && spanX > avgWidth * 1.5) return null;
  const primarySpan = orientation === 'horizontal' ? spanX : spanY;
  const avgPrimarySize = orientation === 'horizontal' ? avgWidth : avgHeight;
  if (primarySpan > avgPrimarySize * cluster.length * 4) return null;
  const colorCounts = new Map();
  const colorItems = new Map();
  for (const item of cluster) {
    const key = colorKey(item.fill);
    colorCounts.set(key, (colorCounts.get(key) || 0) + 1);
    if (!colorItems.has(key)) colorItems.set(key, []);
    colorItems.get(key).push(item);
  }
  if (colorCounts.size < 2) return null;
  const groupsArray = Array.from(colorItems.values()).sort((a, b) => b.length - a.length);
  const primaryGroup = groupsArray[0];
  const focusCandidates = primaryGroup.length >= 2 ? cluster.filter((item) => !primaryGroup.includes(item)) : cluster;
  const focusItems = focusCandidates.filter((item) => {
    const widthRatio = Math.max(item.rect.width, avgWidth) / Math.max(Math.min(item.rect.width, avgWidth), 0.001);
    const heightRatio = Math.max(item.rect.height, avgHeight) / Math.max(Math.min(item.rect.height, avgHeight), 0.001);
    const itemAspect = item.rect.width / Math.max(item.rect.height, 0.001);
    const avgAspect = avgWidth / Math.max(avgHeight, 0.001);
    const aspectRatio = Math.max(itemAspect, avgAspect) / Math.max(Math.min(itemAspect, avgAspect), 0.001);
    return widthRatio <= 1.4 && heightRatio <= 1.4 && aspectRatio <= 1.6;
  });
  if (!focusItems.length) return null;
  return { focusItems, items: cluster };
};

const findIndicatorGroups = (parent) => {
  if (!parent || !('children' in parent)) return [];
  const candidates = collectNodes(parent, isIndicatorCandidate, [])
    .map((child) => {
      const rect = getAbsoluteRect(child);
      const fill = firstSolidFill(child);
      return rect && fill ? { node: child, rect, fill } : null;
    })
    .filter((item) => item !== null);
  if (candidates.length < 3) return [];
  const visited = new Set();
  const groups = [];
  for (const candidate of candidates) {
    if (visited.has(candidate.node.id)) continue;
    const stack = [candidate];
    const cluster = [];
    visited.add(candidate.node.id);
    while (stack.length) {
      const current = stack.pop();
      cluster.push(current);
      for (const other of candidates) {
        if (visited.has(other.node.id)) continue;
        if (areRectsClose(current.rect, other.rect)) {
          visited.add(other.node.id);
          stack.push(other);
        }
      }
    }
    const analyzed = analyzeIndicatorCluster(cluster);
    if (analyzed) {
      groups.push(analyzed);
    }
  }
  return groups;
};

/** Checks **/
function checkColorIndependence(node, ctx) {
  if (!COLOR_INDICATOR_TYPES.includes(node.type)) return;
  const containers = [];
  const parent = node.parent;
  if (parent && 'children' in parent) containers.push(parent);
  const grand = parent && parent.parent;
  if (grand && 'children' in grand) containers.push(grand);
  for (const container of containers) {
    if (ctx.checkedIndicatorContainers.has(container.id)) continue;
    ctx.checkedIndicatorContainers.add(container.id);
    const groups = findIndicatorGroups(container);
    for (const group of groups) {
      const target = group.focusItems.find((item) => !ctx.indicatorIssued.has(item.node.id));
      if (!target) continue;
      ctx.indicatorIssued.add(target.node.id);
      ctx.issues.push({
        nodeId: target.node.id,
        page: getPageName(target.node),
        name: target.node.name,
        type: 'color-independence',
        severity: 'warn',
        message: '색상만 다른 인디케이터 그룹이 감지되었습니다.',
        suggestion: '활성 상태를 패턴, 테두리, 텍스트 등 색 이외 수단으로도 구분하세요.'
      });
    }
  }
}

function checkTextContrast(node, issues, ctx) {
  if (!isVisibleNode(node)) return;
  const fill = firstSolidFill(node);
  if (!fill) return;
  const bg = parentSolidFill(node) || { type: 'SOLID', color: { r: 1, g: 1, b: 1 } };
  const ratio = contrastRatio(fill, bg);
  if (ratio >= ctx.minContrast) return;
  issues.push({
    nodeId: node.id,
    page: getPageName(node),
    name: node.name,
    type: 'contrast',
    severity: 'error',
    message: `${node.type} 대비 ${fmtNum(ratio)}:1, 기준 ${ctx.minContrast}:1 미만`,
    suggestion: '전경·배경 색상을 재조정하거나 보조 색을 추가하세요.'
  });
}

function checkShapeContrast(node, issues, ctx) {
  if (!isVisibleNode(node)) return;
  if (!CONTRAST_SHAPE_TYPES.includes(node.type)) return;
  if ('children' in node && Array.isArray(node.children) && node.children.length > 0) return;
  if (isLikelyBackgroundName(node.name || '')) return;
  const fill = firstSolidFill(node);
  if (!fill) return;
  const bg = parentSolidFill(node) || { type: 'SOLID', color: { r: 1, g: 1, b: 1 } };
  const ratio = contrastRatio(fill, bg);
  if (ratio >= ctx.minContrast) return;
  issues.push({
    nodeId: node.id,
    page: getPageName(node),
    name: node.name,
    type: 'contrast',
    severity: 'warn',
    message: `도형/아이콘 대비 ${fmtNum(ratio)}:1, 기준 ${ctx.minContrast}:1 미만`,
    suggestion: '배경과 구분될 수 있도록 색 대비를 높이십시오.'
  });
}

function checkAutoContentControls(node, issues) {
  if (!isVisibleNode(node)) return;
  const tokens = [];
  gatherTextTokens(node, tokens);
  const combined = tokens.join(' ');
  const ratioNodes = collectNodes(node, (n) => n.type === 'TEXT' && SLIDE_INDEX_REGEX.test(getNodeText(n)));
  const pauseNodes = collectNodes(node, (n) => isPauseNode(n));
  const likelyAuto = ratioNodes.length > 0 || includesKeyword([combined], AUTO_CONTENT_KEYWORDS);
  if (!likelyAuto) return;
  const hasPrev = includesKeyword(tokens, PREV_KEYWORDS);
  const hasNext = includesKeyword(tokens, NEXT_KEYWORDS);
  const hasFull = includesKeyword(tokens, FULL_KEYWORDS);
  const hasPauseText = includesKeyword(tokens, PAUSE_TEXT_KEYWORDS);
  const hasPauseNode = pauseNodes.length > 0 || hasPauseText;

  if (ratioNodes.length > 0) {
    const ratioHasPauseNearby = ratioNodes.some((ratioNode) => {
      const text = getNodeText(ratioNode);
      if (PAUSE_TEXT_KEYWORDS.some((kw) => text.toLowerCase().includes(kw))) return true;
      if (PAUSE_GLYPHS.some((glyph) => text.includes(glyph))) return true;
      return pauseNodes.some((pauseNode) => nodesAreNearby(ratioNode, pauseNode));
    });
    if (!ratioHasPauseNearby) {
      issues.push({
        nodeId: node.id,
        page: getPageName(node),
        name: node.name,
        type: 'auto-content',
        severity: 'warn',
        message: '슬라이드 지표(예: 1/4) 근처에서 재생/멈춤 컨트롤을 찾지 못했습니다. 자동재생이면 재생/멈춤 컨트롤 혹은 전체보기를 추가해 주세요.',
        suggestion: '자동 재생인 경우 재생/멈춤 컨트롤 또는 전체 보기를 추가해 주세요.'
      });
      return;
    }
  }

  if (hasPauseNode || hasFull || (hasPrev && hasNext)) return;
  issues.push({
    nodeId: node.id,
    page: getPageName(node),
    name: node.name,
    type: 'auto-content',
    severity: 'warn',
    message: '자동 전환 콘텐츠로 추정되지만 제어(이전/다음/정지/전체보기)를 찾지 못했습니다.',
    suggestion: '배너/슬라이더에 이전·다음·정지 또는 전체보기 컨트롤을 제공하세요.'
  });
}

function runChecksOnNode(node, ctx) {
  if (ctx.rules.colorIndependence) checkColorIndependence(node, ctx);
  if (ctx.rules.contrast) {
    if (node.type === 'TEXT') {
      checkTextContrast(node, ctx.issues, ctx);
    } else {
      checkShapeContrast(node, ctx.issues, ctx);
    }
  }
  if (ctx.rules.autoContent) checkAutoContentControls(node, ctx.issues);
}

function traverse(root, visit) {
  visit(root);
  if ('children' in root && Array.isArray(root.children)) {
    for (const child of root.children) traverse(child, visit);
  }
}

function gatherRoots(scope) {
  if (scope === 'selection') {
    return figma.currentPage.selection.length ? figma.currentPage.selection : [figma.currentPage];
  }
  if (scope === 'page') return [figma.currentPage];
  return figma.root.children;
}

async function runChecks(payload) {
  const scope = payload && payload.scope;
  const rawRules = (payload && payload.rules) || {};
  const rules = {
    colorIndependence: true,
    contrast: true,
    autoContent: true
  };
  for (const key in rawRules) {
    if (Object.prototype.hasOwnProperty.call(rawRules, key)) {
      rules[key] = rawRules[key];
    }
  }
  const minContrast = Number(payload && payload.minContrast) || CONTRAST_THRESHOLD;
  const issues = [];
  const ctx = { rules, minContrast, issues, checkedIndicatorContainers: new Set(), indicatorIssued: new Set() };
  const roots = gatherRoots(scope);
  for (const root of roots) traverse(root, (node) => runChecksOnNode(node, ctx));
  return issues;
}

/** UI messaging **/
figma.ui.onmessage = async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'run-checks') {
    const payload = msg.payload || {};
    const issues = await runChecks(payload);
    figma.ui.postMessage({ type: 'results', issues });
  } else if (msg.type === 'select-node') {
    if (!msg.nodeId) return;
    const node = figma.getNodeById(msg.nodeId);
    if (node) {
      figma.currentPage.selection = [node];
      figma.viewport.scrollAndZoomIntoView([node]);
    }
  } else if (msg.type === 'close') {
    figma.closePlugin();
  }
};
