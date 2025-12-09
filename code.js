// App Accessibility Checker - minimal, no-build Figma plugin
// Checks three guidelines:
// 1) Color-independent recognition
// 2) Text/image contrast (>=3:1)
// 3) Auto-rotating content exposes controls (prev/next/pause/full view)

const TEXT_CONTRAST_NORMAL = 4.5; // 일반 텍스트 대비 기준
const TEXT_CONTRAST_LARGE = 3; // 큰 텍스트 대비 기준
const COLOR_INDICATOR_TYPES = ['RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'VECTOR', 'LINE'];
const CONTRAST_SHAPE_TYPES = ['RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'VECTOR', 'LINE', 'BOOLEAN_OPERATION', 'INSTANCE', 'COMPONENT'];
const STATE_GROUP_TYPES = ['FRAME', 'RECTANGLE', 'COMPONENT', 'INSTANCE'];
const INDICATOR_MIN_SIDE = 2;
const INDICATOR_MAX_SHORT_SIDE = 24;
const INDICATOR_MAX_LONG_SIDE = 640;
const INDICATOR_MAX_ASPECT = 120;
const INDICATOR_CLUSTER_GAP = 72;
const INDICATOR_MAX_SPREAD = 720;
const AUTO_CONTENT_KEYWORDS = ['carousel', 'slider', 'auto', 'rolling', 'banner', 'slide', '자동', '슬라이드', '배너', '롤링'];
const AUTO_CONTENT_EXCLUDES = ['자동차', '자 동차', 'autocar'];
const UI_SHAPE_KEYWORDS = ['btn', 'button', 'chip', 'pill', 'tab', 'badge', 'tag', 'switch', 'toggle', 'checkbox', 'radio', 'icon', 'cta', 'link', 'control', 'indicator', 'pagination', 'slider', 'step', 'menu', 'nav', 'carousel', 'paging', 'dot', 'arrow', 'chevron', 'caret', 'edit', 'delete', 'close', 'search', 'back', 'forward', 'right', 'left'];
const DECOR_KEYWORDS = ['image', 'img', 'illust', 'illustration', 'decor', 'decoration', 'photo', 'picture', 'pic', 'thumbnail', 'thumb', 'avatar', 'logo', 'graphic'];
const MAX_UI_ELEMENT_SIZE = 100; // px - UI icons/elements are typically smaller than this
const PREV_KEYWORDS = ['prev', 'previous', '이전', '이전보기', '이전글', '이전배너'];
const NEXT_KEYWORDS = ['next', '다음', '다음보기', '다음글', '다음배너'];
const PAUSE_TEXT_KEYWORDS = ['pause', 'stop', '정지', '일시정지', '멈춤', '재생', 'play', '멈추기'];
const PAUSE_GLYPHS = ['❚', '❙', '❚❚', '⏸', '⏯', '■', '▶', '⏵', '⏹'];
const FULL_KEYWORDS = ['full', '전체 보기', '전체보기'];
const SLIDE_INDEX_REGEX = /^\s*\d+\s*\/\s*\d+\s*$/;

figma.showUI(__html__, { width: 420, height: 520 });

// Per-run caches to avoid recomputation
let CACHE_TOKEN = 0;
const RECT_CACHE = new WeakMap();
const VIS_CACHE = new WeakMap();
const BG_PAINT_CACHE = new WeakMap(); // Cache for findBackgroundPaint results
const EFFECTIVE_COLOR_CACHE = new WeakMap(); // Cache for getEffectiveColor results
const resetCaches = () => { CACHE_TOKEN += 1; };
let CANCEL_REQUESTED = false;
const requestCancel = () => { CANCEL_REQUESTED = true; };

/** Utils **/
const fmtNum = (n) => Math.round(n * 100) / 100;

const isVisibleNode = (node) => {
  if (!node) return false;
  const cached = VIS_CACHE.get(node);
  if (cached && cached.token === CACHE_TOKEN) return cached.value;
  let n = node;
  while (n) {
    if (typeof n.visible === 'boolean' && !n.visible) {
      VIS_CACHE.set(node, { token: CACHE_TOKEN, value: false });
      return false;
    }
    n = n.parent;
  }
  VIS_CACHE.set(node, { token: CACHE_TOKEN, value: true });
  return true;
};

const isSolidPaint = (p) => p && p.type === 'SOLID' && (p.visible === undefined || p.visible === true);
const isVisiblePaintAny = (p) => p && (p.visible === undefined || p.visible === true);

const getNodePaints = (node) => {
  try {
    // TEXT: handle mixed fills via range sampling
    if (node.type === 'TEXT') {
      if (node.fills === figma.mixed || !Array.isArray(node.fills)) {
        try {
          const rangeFills = node.getRangeFills(0, 1);
          if (Array.isArray(rangeFills) && rangeFills.length) return rangeFills;
        } catch (_) { }
      }
    }
    if ('fills' in node) {
      const f = node.fills;
      if (Array.isArray(f)) return f;
    }
    if (node.type === 'FRAME' && 'backgrounds' in node && Array.isArray(node.backgrounds)) {
      return node.backgrounds;
    }
    if (node.type === 'PAGE' && node.backgroundColor) {
      return [{ type: 'SOLID', color: node.backgroundColor }];
    }
  } catch (_) { }
  return [];
};

const getPaintColor = (paint) => {
  if (!paint) return null;
  if (paint.type === 'SOLID') return paint.color;
  if (paint.type && String(paint.type).startsWith('GRADIENT') && Array.isArray(paint.gradientStops)) {
    if (!paint.gradientStops.length) return null;
    const stops = paint.gradientStops;
    let r = 0, g = 0, b = 0;
    for (const stop of stops) {
      const c = stop.color;
      if (!c) continue;
      r += c.r;
      g += c.g;
      b += c.b;
    }
    const n = stops.length || 1;
    return { r: r / n, g: g / n, b: b / n };
  }
  return null; // IMAGE/VIDEO etc. -> unknown
};

// Get effective color considering opacity (blended with white background)
const getEffectiveColor = (paint) => {
  if (!paint) return null;

  // Check cache first
  const cached = EFFECTIVE_COLOR_CACHE.get(paint);
  if (cached && cached.token === CACHE_TOKEN) return cached.value;

  const baseColor = getPaintColor(paint);
  if (!baseColor) {
    EFFECTIVE_COLOR_CACHE.set(paint, { token: CACHE_TOKEN, value: null });
    return null;
  }

  const opacity = typeof paint.opacity === 'number' ? paint.opacity : 1;

  // Blend with white background (assuming white as default background)
  // Formula: finalColor = foregroundColor * opacity + backgroundColor * (1 - opacity)
  const r = baseColor.r * opacity + 1 * (1 - opacity);
  const g = baseColor.g * opacity + 1 * (1 - opacity);
  const b = baseColor.b * opacity + 1 * (1 - opacity);

  const result = { r, g, b };
  EFFECTIVE_COLOR_CACHE.set(paint, { token: CACHE_TOKEN, value: result });
  return result;
};

const firstVisiblePaint = (node) => {
  try {
    const paints = getNodePaints(node);
    if (paints.length) {
      const paint = paints.find(isVisiblePaintAny);
      if (paint && getPaintColor(paint)) return paint;
    }
  } catch (_) { }
  return null;
};

const firstSolidFill = (node) => {
  try {
    const paints = getNodePaints(node);
    if (paints.length) {
      return paints.find(isSolidPaint) || null;
    }
  } catch (_) { }
  return null;
};

const firstSolidStroke = (node) => {
  try {
    if ('strokes' in node && Array.isArray(node.strokes)) {
      return node.strokes.find(isSolidPaint) || null;
    }
  } catch (_) { }
  return null;
};

const firstVisibleFillOrStroke = (node) => {
  // Prefer fill, fallback to stroke if no usable fill.
  const fill = firstSolidFill(node) || firstVisiblePaint(node);
  if (fill && getPaintColor(fill)) return fill;
  const stroke = firstSolidStroke(node);
  if (stroke && getPaintColor(stroke)) return stroke;
  return null;
};

const parentSolidFill = (node) => {
  let p = node.parent;
  while (p) {
    const paints = getNodePaints(p);
    if (paints.length) {
      // Check for any solid fill, even with low opacity
      for (const fill of paints) {
        if (fill && fill.type === 'SOLID' && (fill.visible === undefined || fill.visible === true)) {
          // Accept fills with opacity > 0.1 (10%)
          const opacity = typeof fill.opacity === 'number' ? fill.opacity : 1;
          if (opacity > 0.1) {
            return fill;
          }
        }
        // Fallback: accept gradient-like fills with a computable average color
        if (fill && fill.type && String(fill.type).startsWith('GRADIENT') && (fill.visible === undefined || fill.visible === true)) {
          const opacity = typeof fill.opacity === 'number' ? fill.opacity : 1;
          if (opacity > 0.1 && getPaintColor(fill)) {
            return fill;
          }
        }
      }
    }
    p = p.parent;
  }
  return null;
};

const coveringSolidFill = (node) => {
  // Find a sibling/ancestor sibling that visually sits behind this node and has a solid fill.
  if (!node || !node.parent || !('children' in node.parent)) return null;
  const rect = getAbsoluteRect(node);
  if (!rect) return null;
  let best = null;
  let bestArea = -1;
  for (const sibling of node.parent.children) {
    if (sibling === node) continue;
    if (!isVisibleNode(sibling)) continue;
    const sibRect = getAbsoluteRect(sibling);
    if (!sibRect) continue;
    if (!rectContains(sibRect, rect)) continue; // must contain the text
    const fill = firstVisibleFillOrStroke(sibling);
    if (!fill) continue;
    const opacity = typeof fill.opacity === 'number' ? fill.opacity : 1;
    if (opacity <= 0.1) continue;
    const area = sibRect.width * sibRect.height;
    if (area > bestArea) {
      best = fill;
      bestArea = area;
    }
  }
  return best;
};

const overlapCoversNode = (nodeRect, siblingRect, minCoverage = 0.6) => {
  const xOverlap = Math.max(0, Math.min(nodeRect.x + nodeRect.width, siblingRect.x + siblingRect.width) - Math.max(nodeRect.x, siblingRect.x));
  const yOverlap = Math.max(0, Math.min(nodeRect.y + nodeRect.height, siblingRect.y + siblingRect.height) - Math.max(nodeRect.y, siblingRect.y));
  const overlapArea = xOverlap * yOverlap;
  const nodeArea = nodeRect.width * nodeRect.height;
  const siblingArea = siblingRect.width * siblingRect.height;
  if (nodeArea <= 0 || siblingArea <= 0) return false;
  const nodeCovered = overlapArea / nodeArea;
  const siblingLargeEnough = siblingArea >= nodeArea * 0.6; // avoid tiny chips/icons
  return nodeCovered >= minCoverage && siblingLargeEnough;
};

const bestOverlappingFillInAncestors = (node, minOverlapRatio = 0.2) => {
  // Fallback: pick the visible sibling (across ancestors) with the largest overlap area.
  if (!node) return null;
  const rect = getAbsoluteRect(node);
  if (!rect) return null;
  let best = null;
  let bestOverlap = 0;
  let current = node.parent;
  while (current && 'children' in current) {
    for (const sibling of current.children) {
      if (sibling === node) continue;
      if (!isVisibleNode(sibling)) continue;
      const sibRect = getAbsoluteRect(sibling);
      if (!sibRect) continue;
      const xOverlap = Math.max(0, Math.min(rect.x + rect.width, sibRect.x + sibRect.width) - Math.max(rect.x, sibRect.x));
      const yOverlap = Math.max(0, Math.min(rect.y + rect.height, sibRect.y + sibRect.height) - Math.max(rect.y, sibRect.y));
      const overlapArea = xOverlap * yOverlap;
      const nodeArea = rect.width * rect.height;
      if (nodeArea <= 0) continue;
      const overlapRatio = overlapArea / nodeArea;
      if (overlapRatio < minOverlapRatio) continue;
      const fill = firstSolidFill(sibling) || firstVisiblePaint(sibling);
      if (!fill) continue;
      const opacity = typeof fill.opacity === 'number' ? fill.opacity : 1;
      if (opacity <= 0.1) continue;
      if (!getPaintColor(fill)) continue;
      if (overlapRatio > bestOverlap) {
        best = fill;
        bestOverlap = overlapRatio;
      }
    }
    node = current;
    current = current.parent;
  }
  return best;
};

const largeBackgroundInSameParent = (node) => {
  // Prefer a large, visible sibling in the same parent that covers the node center or overlaps >=10%
  if (!node || !node.parent || !('children' in node.parent)) return null;
  const rect = getAbsoluteRect(node);
  if (!rect) return null;
  const { cx, cy, width, height } = rect;
  let best = null;
  let bestArea = 0;
  for (const sibling of node.parent.children) {
    if (sibling === node) continue;
    if (!isVisibleNode(sibling)) continue;
    const sibRect = getAbsoluteRect(sibling);
    if (!sibRect) continue;
    const area = sibRect.width * sibRect.height;
    if (area <= 0) continue;
    const xOverlap = Math.max(0, Math.min(rect.x + rect.width, sibRect.x + sibRect.width) - Math.max(rect.x, sibRect.x));
    const yOverlap = Math.max(0, Math.min(rect.y + rect.height, sibRect.y + sibRect.height) - Math.max(rect.y, sibRect.y));
    const overlapArea = xOverlap * yOverlap;
    const overlapRatio = overlapArea / Math.max(width * height, 1);
    const centerInside = cx >= sibRect.x && cx <= sibRect.x + sibRect.width && cy >= sibRect.y && cy <= sibRect.y + sibRect.height;
    if (!centerInside && overlapRatio < 0.1) continue;
    const fill = firstSolidFill(sibling) || firstVisiblePaint(sibling);
    if (!fill) continue;
    const opacity = typeof fill.opacity === 'number' ? fill.opacity : 1;
    if (opacity <= 0.05) continue;
    if (!getPaintColor(fill)) continue;
    const sizeRatio = area / Math.max(width * height, 1);
    if (sizeRatio < 1.5) continue; // ensure meaningfully larger than text box
    if (area > bestArea) {
      best = fill;
      bestArea = area;
    }
  }
  return best;
};

const centerCoverFillInAncestors = (node) => {
  // Fallback: find a visible sibling in ancestor chains whose rect contains the node center.
  if (!node) return null;
  const rect = getAbsoluteRect(node);
  if (!rect) return null;
  const { cx, cy } = rect;
  let current = node.parent;
  let best = null;
  let bestArea = 0;
  while (current && 'children' in current) {
    for (const sibling of current.children) {
      if (sibling === node) continue;
      if (!isVisibleNode(sibling)) continue;
      const sibRect = getAbsoluteRect(sibling);
      if (!sibRect) continue;
      if (cx < sibRect.x || cx > sibRect.x + sibRect.width || cy < sibRect.y || cy > sibRect.y + sibRect.height) continue;
      const fill = firstSolidFill(sibling) || firstVisiblePaint(sibling);
      if (!fill) continue;
      const opacity = typeof fill.opacity === 'number' ? fill.opacity : 1;
      if (opacity <= 0.1) continue;
      if (!getPaintColor(fill)) continue;
      const area = sibRect.width * sibRect.height;
      if (area > bestArea) {
        best = fill;
        bestArea = area;
      }
    }
    node = current;
    current = current.parent;
  }
  return best;
};

const coveringFillInAncestors = (node) => {
  // Look for any visible sibling in ancestor chains that fully contains the node and has a usable fill.
  if (!node) return null;
  const rect = getAbsoluteRect(node);
  if (!rect) return null;
  let current = node.parent;
  while (current && 'children' in current) {
    for (const sibling of current.children) {
      if (sibling === node) continue;
      if (!isVisibleNode(sibling)) continue;
      const sibRect = getAbsoluteRect(sibling);
      if (!sibRect) continue;
      const contains = rectContains(sibRect, rect) || overlapCoversNode(rect, sibRect, 0.6);
      if (!contains) continue;
      const fill = firstSolidFill(sibling) || firstVisiblePaint(sibling);
      if (!fill) continue;
      const opacity = typeof fill.opacity === 'number' ? fill.opacity : 1;
      if (opacity <= 0.1) continue;
      if (getPaintColor(fill)) return fill;
    }
    node = current;
    current = current.parent;
  }
  return null;
};

const overlappingSiblingFill = (node, minCoverage = 0.05) => {
  if (!node || !node.parent || !('children' in node.parent)) return null;
  const rect = getAbsoluteRect(node);
  if (!rect) return null;
  let best = null;
  let bestOverlap = 0;
  for (const sib of node.parent.children) {
    if (sib === node) continue;
    if (!isVisibleNode(sib)) continue;
    const sRect = getAbsoluteRect(sib);
    if (!sRect) continue;
    const xOverlap = Math.max(0, Math.min(rect.x + rect.width, sRect.x + sRect.width) - Math.max(rect.x, sRect.x));
    const yOverlap = Math.max(0, Math.min(rect.y + rect.height, sRect.y + sRect.height) - Math.max(rect.y, sRect.y));
    const overlapArea = xOverlap * yOverlap;
    const coverage = overlapArea / Math.max(rect.width * rect.height, 0.001);
    if (coverage < minCoverage) continue;
    const fill = firstVisibleFillOrStroke(sib);
    if (!fill || !getPaintColor(fill)) continue;
    if (coverage > bestOverlap) {
      best = fill;
      bestOverlap = coverage;
    }
  }
  return best;
};

const dominantBackgroundSibling = (node) => {
  // Pick the largest visible rectangle/vector sibling as a shared background, even if auto-layout prevents overlap.
  if (!node || !node.parent || !('children' in node.parent)) return null;
  const rect = getAbsoluteRect(node);
  if (!rect) return null;
  let best = null;
  let bestArea = 0;
  for (const sib of node.parent.children) {
    if (sib === node) continue;
    if (!isVisibleNode(sib)) continue;
    if (!['RECTANGLE', 'VECTOR', 'FRAME'].includes(sib.type)) continue;
    const sRect = getAbsoluteRect(sib);
    if (!sRect) continue;
    const area = sRect.width * sRect.height;
    if (area <= 0) continue;
    if (area < rect.width * rect.height * 2) continue; // must be meaningfully larger than text
    const fill = firstVisibleFillOrStroke(sib);
    if (!fill || !getPaintColor(fill)) continue;
    if (area > bestArea) {
      best = fill;
      bestArea = area;
    }
  }
  return best;
};

const dominantBackgroundInAncestor = (node) => {
  // Find the largest rectangle/vector within the nearest frame/component/instance/section ancestor.
  // If none, keep climbing to upper frames.
  if (!node) return null;
  const rect = getAbsoluteRect(node);
  if (!rect) return null;

  let scope = node.parent;
  while (scope && scope.type !== 'PAGE') {
    if ((scope.type === 'FRAME' || scope.type === 'COMPONENT' || scope.type === 'INSTANCE' || scope.type === 'SECTION') && ('children' in scope)) {
      let best = null;
      let bestArea = 0;
      const candidates = collectNodes(scope, (n) =>
        n !== node &&
        isVisibleNode(n) &&
        ['RECTANGLE', 'VECTOR', 'FRAME'].includes(n.type)
      );
      for (const cand of candidates) {
        const cRect = getAbsoluteRect(cand);
        if (!cRect) continue;
        const area = cRect.width * cRect.height;
        if (area <= 0) continue;
        if (area < rect.width * rect.height * 2) continue; // must be meaningfully larger
        const fill = firstVisibleFillOrStroke(cand);
        if (!fill || !getPaintColor(fill)) continue;
        if (area > bestArea) {
          best = fill;
          bestArea = area;
        }
      }
      if (best) return best;
    }
    scope = scope.parent;
  }
  return null;
};

const overlappingAncestorFill = (node, minCoverage = 0.01) => {
  // Climb ancestors; within each ancestor, look for rectangle/vector/frame that overlaps the text rect.
  if (!node) return null;
  const rect = getAbsoluteRect(node);
  if (!rect) return null;

  let ancestor = node.parent;
  while (ancestor && ancestor.type !== 'PAGE') {
    if ('children' in ancestor && Array.isArray(ancestor.children)) {
      for (const cand of ancestor.children) {
        if (!isVisibleNode(cand)) continue;
        if (cand === node) continue;
        if (!['RECTANGLE', 'VECTOR', 'FRAME'].includes(cand.type)) continue;
        const cRect = getAbsoluteRect(cand);
        if (!cRect) continue;
        const xOverlap = Math.max(0, Math.min(rect.x + rect.width, cRect.x + cRect.width) - Math.max(rect.x, cRect.x));
        const yOverlap = Math.max(0, Math.min(rect.y + rect.height, cRect.y + cRect.height) - Math.max(rect.y, cRect.y));
        const overlapArea = xOverlap * yOverlap;
        const coverage = overlapArea / Math.max(rect.width * rect.height, 0.001);
        if (coverage < minCoverage) continue;
        const fill = firstVisibleFillOrStroke(cand);
        if (fill && getPaintColor(fill)) return fill;
      }
    }
    ancestor = ancestor.parent;
  }
  return null;
};

const findBackgroundPaint = (node) => {
  // Check cache first
  const cached = BG_PAINT_CACHE.get(node);
  if (cached && cached.token === CACHE_TOKEN) return cached.value;

  const nearestAncestorFramePaint = () => {
    let p = node.parent;
    while (p) {
      if (p.type === 'FRAME' || p.type === 'COMPONENT' || p.type === 'INSTANCE') {
        const paints = getNodePaints(p);
        for (const f of paints) {
          if (!isVisiblePaintAny(f)) continue;
          const opacity = typeof f.opacity === 'number' ? f.opacity : 1;
          if (opacity <= 0.01) continue;
          if (getPaintColor(f)) return f;
        }
      }
      p = p.parent;
    }
    return null;
  };

  // 1) Immediate parent fill
  const parent = node.parent;
  if (parent) {
    const parentPaints = getNodePaints(parent);
    for (const f of parentPaints) {
      if (!isVisiblePaintAny(f)) continue;
      const opacity = typeof f.opacity === 'number' ? f.opacity : 1;
      if (opacity <= 0.05) continue;
      if (getPaintColor(f)) {
        const result = { paint: f, source: 'parent' };
        BG_PAINT_CACHE.set(node, { token: CACHE_TOKEN, value: result });
        return result;
      }
    }
  }

  // 2) Ancestor frame/group fill
  const ancestor = parentSolidFill(node);
  if (ancestor) {
    const result = { paint: ancestor, source: 'ancestor' };
    BG_PAINT_CACHE.set(node, { token: CACHE_TOKEN, value: result });
    return result;
  }

  // 3) Overlapping sibling in same parent (e.g., background rectangle)
  const overlapSibling = overlappingSiblingFill(node, 0.2);
  if (overlapSibling) {
    const result = { paint: overlapSibling, source: 'sibling-overlap' };
    BG_PAINT_CACHE.set(node, { token: CACHE_TOKEN, value: result });
    return result;
  }

  // 4) Dominant sibling background (large rectangle/vector) in same parent
  const dominantSibling = dominantBackgroundSibling(node);
  if (dominantSibling) {
    const result = { paint: dominantSibling, source: 'sibling-dominant' };
    BG_PAINT_CACHE.set(node, { token: CACHE_TOKEN, value: result });
    return result;
  }

  // 5) Dominant background in nearest ancestor frame/component
  const ancestorDominant = dominantBackgroundInAncestor(node);
  if (ancestorDominant) {
    const result = { paint: ancestorDominant, source: 'ancestor-dominant' };
    BG_PAINT_CACHE.set(node, { token: CACHE_TOKEN, value: result });
    return result;
  }

  // 6) Overlapping rectangle/vector in ancestor chain (when text frame has no fill)
  const ancestorOverlap = overlappingAncestorFill(node, 0.1);
  if (ancestorOverlap) {
    const result = { paint: ancestorOverlap, source: 'ancestor-overlap' };
    BG_PAINT_CACHE.set(node, { token: CACHE_TOKEN, value: result });
    return result;
  }

  // 7) Covering sibling/ancestor sibling (e.g., backplate)
  const cover = coveringFillInAncestors(node);
  if (cover) {
    const result = { paint: cover, source: 'covering' };
    BG_PAINT_CACHE.set(node, { token: CACHE_TOKEN, value: result });
    return result;
  }

  // 8) Large sibling in same parent (banner background)
  const largeBg = largeBackgroundInSameParent(node);
  if (largeBg) {
    const result = { paint: largeBg, source: 'large-sibling' };
    BG_PAINT_CACHE.set(node, { token: CACHE_TOKEN, value: result });
    return result;
  }

  // 9) Center-contained sibling (looser)
  const centerCover = centerCoverFillInAncestors(node);
  if (centerCover) {
    const result = { paint: centerCover, source: 'center-cover' };
    BG_PAINT_CACHE.set(node, { token: CACHE_TOKEN, value: result });
    return result;
  }

  // 10) Best overlapping fill (looser match)
  const overlap = bestOverlappingFillInAncestors(node, 0.2);
  if (overlap) {
    const result = { paint: overlap, source: 'overlap' };
    BG_PAINT_CACHE.set(node, { token: CACHE_TOKEN, value: result });
    return result;
  }

  // 11) Nearest ancestor frame/component paint (even if not covering)
  const ancestorPaint = nearestAncestorFramePaint();
  if (ancestorPaint) {
    const result = { paint: ancestorPaint, source: 'ancestor-frame' };
    BG_PAINT_CACHE.set(node, { token: CACHE_TOKEN, value: result });
    return result;
  }

  // 12) None found
  const result = { paint: null, source: 'fallback' };
  BG_PAINT_CACHE.set(node, { token: CACHE_TOKEN, value: result });
  return result;
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
  const cached = RECT_CACHE.get(node);
  if (cached && cached.token === CACHE_TOKEN) return cached.value;
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
  const rect = {
    x: minX,
    y: minY,
    width,
    height,
    cx: minX + width / 2,
    cy: minY + height / 2
  };
  RECT_CACHE.set(node, { token: CACHE_TOKEN, value: rect });
  return rect;
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

const rgbToHex = (rgb) => {
  const toHex = (c) => {
    const hex = Math.round(c * 255).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`.toUpperCase();
};

const getPageName = (node) => {
  let p = node;
  while (p && p.type !== 'PAGE') p = p.parent;
  return p && p.type === 'PAGE' ? p.name : '';
};

const getNearestFrameName = (node) => {
  let p = node;
  while (p && p.type !== 'PAGE') {
    if (p.type === 'FRAME' || p.type === 'COMPONENT' || p.type === 'INSTANCE' || p.type === 'SECTION') {
      return p.name || '';
    }
    p = p.parent;
  }
  return '';
};

const isLikelyBackgroundName = (name) => {
  if (!name) return false;
  const lower = name.toLowerCase();
  return (
    lower.includes('bg') ||
    lower.includes('background') ||
    lower.includes('container') ||
    lower.includes('frame') ||
    lower.includes('hit area') ||
    lower.includes('hit-area') ||
    lower.includes('hitarea') ||
    lower.includes('touch target') ||
    lower.includes('tap area') ||
    lower.includes('tap target')
  );
};

const getNodeText = (node) => {
  if (node.type !== 'TEXT') return '';
  try {
    return node.characters || '';
  } catch (_) {
    return '';
  }
};

const getNumericFontSize = (node) => {
  // Try direct fontSize first
  if (typeof node.fontSize === 'number') return node.fontSize || 0;
  // Fallback: scan ranges to find the largest size (handles mixed styles)
  try {
    const len = node.characters ? node.characters.length : 0;
    if (!len || typeof node.getRangeFontSize !== 'function') return 0;
    let maxSize = 0;
    const sample = Math.min(len, 48); // avoid very long scans
    for (let i = 0; i < sample; i++) {
      const size = node.getRangeFontSize(i, i + 1);
      if (typeof size === 'number' && size > maxSize) {
        maxSize = size;
        if (maxSize >= 32) break; // early exit once clearly large
      }
    }
    return maxSize;
  } catch (_) {
    return 0;
  }
};

const isBoldStyle = (node) => {
  // Direct checks
  try {
    if (typeof node.fontWeight === 'number' && node.fontWeight >= 600) return true;
    if (node.fontName && node.fontName.style) {
      const style = String(node.fontName.style).toLowerCase();
      if (/bold|semi|demi|black|heavy|extrabold|medium/.test(style)) return true;
    }
  } catch (_) { }
  // Mixed style fallback
  try {
    const len = node.characters ? node.characters.length : 0;
    if (!len || typeof node.getRangeFontName !== 'function') return false;
    const sample = Math.min(len, 48);
    for (let i = 0; i < sample; i++) {
      const fontName = node.getRangeFontName(i, i + 1);
      if (fontName && fontName.style) {
        const style = String(fontName.style).toLowerCase();
        if (/bold|semi|demi|black|heavy|extrabold|medium/.test(style)) return true;
      }
    }
  } catch (_) { }
  return false;
};

const rectContains = (outer, inner) =>
  outer &&
  inner &&
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

const isBackplateShape = (node) => {
  const parent = node.parent;
  if (!parent || !('children' in parent) || !Array.isArray(parent.children)) return false;
  const rect = getAbsoluteRect(node);
  if (!rect) return false;

  let maxArea = rect.width * rect.height;
  let isLargest = true;
  let hasInnerSiblings = false;

  for (const sibling of parent.children) {
    if (sibling === node) continue;
    const sibRect = getAbsoluteRect(sibling);
    if (!sibRect) continue;
    const area = sibRect.width * sibRect.height;
    if (area > maxArea) {
      isLargest = false;
    }
    if (rectContains(rect, sibRect)) {
      hasInnerSiblings = true;
    }
  }

  return isLargest && hasInnerSiblings;
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
const includesExcludedAuto = (tokens) => AUTO_CONTENT_EXCLUDES.some((ex) => tokens.some((t) => t.includes(ex)));

const collectNodes = (node, predicate, acc = []) => {
  if (!isVisibleNode(node)) return acc;
  if (predicate(node)) acc.push(node);
  if ('children' in node && Array.isArray(node.children)) {
    for (const child of node.children) collectNodes(child, predicate, acc);
  }
  return acc;
};

const hasTextDescendant = (node) => {
  const texts = collectNodes(node, (n) => n.type === 'TEXT', []);
  return texts.length > 0;
};

const hasAutoAncestorIssued = (node, issuedSet) => {
  let p = node && node.parent;
  while (p && p.type !== 'PAGE') {
    if (issuedSet.has(p.id)) return true;
    p = p.parent;
  }
  return false;
};

const isLikelyAutoFrame = (node) => {
  // Simplified rule: frame name includes "banner" (case-insensitive, or Korean "배너")
  if (!node) return false;
  if (!(node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE' || node.type === 'SECTION' || node.type === 'GROUP')) return false;
  const name = (node.name || '').toLowerCase();
  if (name.includes('banner') || name.includes('배너')) return true;
  return false;
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

const paintKey = (paint) => {
  if (!paint || !paint.color) return 'none';
  const { r, g, b } = paint.color;
  const opacity = typeof paint.opacity === 'number' ? paint.opacity : 1;
  return `${r.toFixed(3)}|${g.toFixed(3)}|${b.toFixed(3)}|${opacity.toFixed(2)}`;
};

const getStrokeWeight = (node) => {
  try {
    if ('strokeWeight' in node && typeof node.strokeWeight === 'number') return node.strokeWeight || 0;
    if ('strokeWeights' in node && Array.isArray(node.strokeWeights) && typeof node.strokeWeights[0] === 'number') {
      return node.strokeWeights[0] || 0;
    }
  } catch (_) { }
  return 0;
};

const hasBoldText = (node) => {
  const texts = collectNodes(node, (n) => n.type === 'TEXT', []);
  return texts.some((t) => {
    try {
      const weight = t.fontWeight || null;
      if (typeof weight === 'number' && weight >= 600) return true;
      const style = t.fontName && t.fontName.style ? String(t.fontName.style).toLowerCase() : '';
      return /bold|semi|demi|black|heavy|extrabold|medium/.test(style);
    } catch (_) {
      return false;
    }
  });
};

const keywordMatch = (name, kw) => {
  if (!name) return false;
  const lower = name.toLowerCase();
  if (kw === 'tab') {
    // Avoid false positives on "table"
    return /\btab\b/.test(lower) || /\btab\/|\btab-/.test(lower);
  }
  return lower.includes(kw);
};

const hasUIKeyword = (node, opts = {}) => {
  const { allowIcon = true } = opts;
  const keywords = allowIcon ? UI_SHAPE_KEYWORDS : UI_SHAPE_KEYWORDS.filter((kw) => kw !== 'icon');
  const names = [];
  if (node && node.name) names.push(node.name);
  if (node && node.parent && node.parent.name) names.push(node.parent.name);
  if (node && node.parent && node.parent.parent && node.parent.parent.name) {
    names.push(node.parent.parent.name);
  }
  return keywords.some((kw) => names.some((n) => keywordMatch(n, kw)));
};

const isDecorativeName = (node) => {
  const names = [];
  if (node && node.name) names.push(node.name);
  if (node && node.parent && node.parent.name) names.push(node.parent.name);
  if (node && node.parent && node.parent.parent && node.parent.parent.name) names.push(node.parent.parent.name);
  return DECOR_KEYWORDS.some((kw) => names.some((n) => n && n.toLowerCase().includes(kw)));
};

const hasNearbyText = (node, maxDx = 180, maxDy = 140) => {
  if (!node || !node.parent || !('children' in node.parent)) return false;
  const texts = node.parent.children.filter((c) => c.type === 'TEXT' && isVisibleNode(c));
  return texts.some((t) => nodesAreNearby(node, t, maxDx, maxDy));
};

const hasReactions = (node) => {
  return 'reactions' in node && Array.isArray(node.reactions) && node.reactions.length > 0;
};

const hasUnderlineIndicator = (textNode) => {
  // Detect thin line/vector/rect near the text within the same frame/container used as a state indicator.
  if (!textNode) return false;
  const rect = getAbsoluteRect(textNode);
  if (!rect) return false;

  // Find nearest frame-like ancestor to scope the search
  let scope = textNode.parent;
  while (scope && scope.type !== 'PAGE') {
    if (scope.type === 'FRAME' || scope.type === 'COMPONENT' || scope.type === 'INSTANCE' || scope.type === 'SECTION') break;
    scope = scope.parent;
  }
  if (!scope || !('children' in scope)) return false;

  const candidates = collectNodes(scope, (n) =>
    n !== textNode &&
    isVisibleNode(n) &&
    ['LINE', 'VECTOR', 'RECTANGLE'].includes(n.type)
  );

  for (const sib of candidates) {
    const sRect = getAbsoluteRect(sib);
    if (!sRect) continue;
    const isThin = sRect.height <= 4;
    const widthOk = sRect.width >= rect.width * 0.4;
    const horizontalOverlap = Math.max(0, Math.min(rect.x + rect.width, sRect.x + sRect.width) - Math.max(rect.x, sRect.x));
    const overlapOk = horizontalOverlap >= rect.width * 0.3;
    const yNearBottom = sRect.y >= rect.y + rect.height - 8 && sRect.y <= rect.y + rect.height + 12;
    if (isThin && widthOk && overlapOk && yNearBottom) return true;
  }
  return false;
};

const hasActionableContext = (node) => {
  // Only treat as functional if it looks like a control (button/tab/link/nav/etc.), has interactions,
  // lives inside a component, or has a nearby label in a UI-named container.
  if (isDecorativeName(node)) return false;
  const hasKeyword = hasUIKeyword(node, { allowIcon: false });
  const hasReact = hasReactions(node);
  const inComponent = isInsideComponent(node);
  const nearLabel = hasNearbyText(node);

  const w = typeof node.width === 'number' ? Math.abs(node.width) : null;
  const h = typeof node.height === 'number' ? Math.abs(node.height) : null;
  const shortSide = (w !== null && h !== null) ? Math.min(w, h) : null;

  // Skip small standalone icons/graphics without hints (even inside components)
  if (!hasKeyword && !hasReact && !nearLabel && shortSide !== null && shortSide <= 72) return false;

  if (hasReact) return true;
  if (hasKeyword) return true;
  if (nearLabel && (hasUIKeyword(node) || inComponent)) return true;
  return false;
};

const isInsideComponent = (node) => {
  let p = node.parent;
  while (p) {
    if (p.type === 'COMPONENT' || p.type === 'COMPONENT_SET' || p.type === 'INSTANCE') return true;
    p = p.parent;
  }
  return false;
};

const isLikelyUIElement = (node) => {
  const name = (node && node.name ? node.name.toLowerCase() : '');
  const parentName = (node && node.parent && node.parent.name ? node.parent.name.toLowerCase() : '');
  const grandName = (node && node.parent && node.parent.parent && node.parent.parent.name ? node.parent.parent.name.toLowerCase() : '');
  const isTableish = [name, parentName, grandName].some((n) => n.includes('table') || n.includes('thead') || n.includes('tbody') || n.includes('grid'));
  if (isTableish) return false; // 일반 테이블은 선택/미선택 UI 아님
  if (node.type === 'COMPONENT' || node.type === 'INSTANCE') return true;
  if (isInsideComponent(node)) return true;
  if (hasReactions(node)) return true;
  return hasUIKeyword(node);
};

const isLikelyTabGroup = (node) => {
  if (!node || !('children' in node) || !Array.isArray(node.children)) return false;
  const children = node.children.filter(isVisibleNode);
  if (children.length < 2 || children.length > 8) return false;
  const rects = children.map((c) => getAbsoluteRect(c)).filter(Boolean);
  if (!rects.length) return false;
  const widths = rects.map((r) => r.width);
  const heights = rects.map((r) => r.height);
  const avgWidth = widths.reduce((a, b) => a + b, 0) / widths.length;
  const avgHeight = heights.reduce((a, b) => a + b, 0) / heights.length;
  if (avgWidth > 400 || avgHeight > 180) return false;
  const shortTextChildren = children.filter((c) => {
    const texts = collectNodes(c, (n) => n.type === 'TEXT', []);
    if (!texts.length) return false;
    return texts.some((t) => {
      const txt = getNodeText(t);
      return txt && txt.length <= 6;
    });
  });
  return shortTextChildren.length >= Math.ceil(children.length * 0.6);
};

const hasLikelyTabGroup = (node) => {
  if (!node || !('children' in node) || !Array.isArray(node.children)) return false;
  return node.children.some((c) => isVisibleNode(c) && isLikelyTabGroup(c));
};

const hasOverlappingContent = (node) => {
  const parent = node.parent;
  if (!parent || !('children' in parent)) return false;

  const nodeRect = getAbsoluteRect(node);
  if (!nodeRect) return false;

  return parent.children.some((sibling) => {
    if (sibling === node) return false;
    if (!isVisibleNode(sibling)) return false;

    const siblingRect = getAbsoluteRect(sibling);
    if (!siblingRect) return false;

    // Check if sibling center is inside the node (likely an icon or text on top)
    if (
      siblingRect.cx >= nodeRect.x &&
      siblingRect.cx <= nodeRect.x + nodeRect.width &&
      siblingRect.cy >= nodeRect.y &&
      siblingRect.cy <= nodeRect.y + nodeRect.height
    ) {
      return true;
    }

    // Check for significant overlap
    const xOverlap = Math.max(0, Math.min(nodeRect.x + nodeRect.width, siblingRect.x + siblingRect.width) - Math.max(nodeRect.x, siblingRect.x));
    const yOverlap = Math.max(0, Math.min(nodeRect.y + nodeRect.height, siblingRect.y + siblingRect.height) - Math.max(nodeRect.y, siblingRect.y));
    const overlapArea = xOverlap * yOverlap;
    const nodeArea = nodeRect.width * nodeRect.height;

    return overlapArea > nodeArea * 0.5;
  });
};

const isIndicatorCandidate = (node) => {
  if (!isLikelyUIElement(node)) return false;
  if (!COLOR_INDICATOR_TYPES.includes(node.type)) return false;
  if (!isVisibleNode(node)) return false;
  if (isDecorativeName(node)) return false;
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

  // New Heuristic: If it has overlapping content (text/icon), it must be explicitly named as a UI element
  if (hasOverlappingContent(node)) {
    // If it's a generic name, assume it's a graphic/illustration part and skip it.
    // We rely on isLikelyUIElement's keyword check, but we can be stricter if needed.
    // isLikelyUIElement returns true if it has a keyword OR is a component.
    // If it's NOT a component and has NO keyword, isLikelyUIElement would have returned false anyway?
    // Wait, isLikelyUIElement checks: Component OR Inside Component OR Reactions OR Keyword.
    // The calculator buttons might be "Inside Component" or have "Reactions" (unlikely for a static image).
    // If the user just drew a frame with rectangles, isLikelyUIElement might be false unless they named the frame "Button".
    // But the user said "Color Independence" IS triggering. So `isLikelyUIElement` MUST be returning true.
    // This means either:
    // 1. They are using Components.
    // 2. They are inside a Component.
    // 3. They have a UI keyword in the name (e.g. "Group 1" -> no, "Frame" -> no).

    // Let's look at `isLikelyUIElement` again.
    // const UI_SHAPE_KEYWORDS = ['btn', 'button', ... 'dot'];

    // If the user named the parent "Calculator", that might not trigger.
    // Maybe `isLikelyUIElement` is too broad?
    // Actually `isIndicatorCandidate` checks `isLikelyUIElement` first.

    // If `hasOverlappingContent` is true, we want to be SURE it's an indicator.
    // So we require a specific "Indicator-like" keyword, or we skip.
    const indicatorKeywords = ['tab', 'nav', 'step', 'paging', 'indicator', 'pagination', 'dot', 'carousel'];
    const name = (node.name || '').toLowerCase();
    const parentName = (node.parent && node.parent.name || '').toLowerCase();

    const hasIndicatorName = indicatorKeywords.some(kw => name.includes(kw) || parentName.includes(kw));

    if (!hasIndicatorName) return false;
  }

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

const isStateCandidate = (node) => {
  if (!isLikelyUIElement(node)) return false;
  if (!STATE_GROUP_TYPES.includes(node.type)) return false;
  if (!isVisibleNode(node)) return false;
  if (!('width' in node) || !('height' in node)) return false;
  const width = typeof node.width === 'number' ? Math.abs(node.width) : null;
  const height = typeof node.height === 'number' ? Math.abs(node.height) : null;
  if (width === null || height === null) return false;
  const longSide = Math.max(width, height);
  const shortSide = Math.min(width, height);
  if (shortSide < 16 || longSide > 720) return false;
  if (longSide / Math.max(shortSide, 0.001) > 6) return false;
  if ('visible' in node && node.visible === false) return false;
  const hasFill = !!firstSolidFill(node);
  const hasStroke = hasVisibleStroke(node);
  if (!hasFill && !hasStroke) return false;
  return true;
};

const hasIcon = (node) => {
  if (!node) return false;
  if (['VECTOR', 'STAR', 'POLYGON', 'BOOLEAN_OPERATION'].includes(node.type)) return true;
  if (node.type === 'INSTANCE') {
    // 인스턴스는 크기가 작으면 아이콘으로 간주하거나, 내부 벡터 확인
    const w = node.width;
    const h = node.height;
    if (w <= 48 && h <= 48) return true;
  }
  if ('children' in node && Array.isArray(node.children)) {
    return node.children.some(child => isVisibleNode(child) && hasIcon(child));
  }
  return false;
};

const findStateColorGroups = (parent, ctx) => {
  if (!parent || !('children' in parent) || !Array.isArray(parent.children)) return [];
  const candidates = parent.children
    .filter((child) => isStateCandidate(child))
    .filter((child) => !ctx || !ctx.selectionOnly || (ctx.allowedNodeIds && ctx.allowedNodeIds.has(child.id)))
    .map((child) => {
      const rect = getAbsoluteRect(child);
      const fill = firstSolidFill(child);
      const stroke = firstSolidStroke(child);
      return rect
        ? {
          node: child,
          rect,
          fill,
          stroke,
          strokeWeight: getStrokeWeight(child),
          hasBold: hasBoldText(child),
          hasIcon: hasIcon(child)
        }
        : null;
    })
    .filter((item) => item !== null);
  if (candidates.length < 2) return [];

  const visited = new Set();
  const groups = [];

  for (let i = 0; i < candidates.length; i++) {
    if (visited.has(i)) continue;
    const cluster = [];
    const stack = [i];
    visited.add(i);
    while (stack.length) {
      const idx = stack.pop();
      cluster.push(candidates[idx]);
      for (let j = 0; j < candidates.length; j++) {
        if (visited.has(j)) continue;
        // 위치가 가깝고, 아이콘 유무가 동일해야 같은 그룹으로 간주
        if (areRectsClose(candidates[idx].rect, candidates[j].rect) &&
          candidates[idx].hasIcon === candidates[j].hasIcon) {
          visited.add(j);
          stack.push(j);
        }
      }
    }
    if (cluster.length < 2) continue;
    const rects = cluster.map((c) => c.rect);
    const cxList = rects.map((r) => r.cx);
    const cyList = rects.map((r) => r.cy);
    const spanX = Math.max(...cxList) - Math.min(...cxList);
    const spanY = Math.max(...cyList) - Math.min(...cyList);
    const widths = rects.map((r) => r.width);
    const heights = rects.map((r) => r.height);
    const avgWidth = widths.reduce((a, b) => a + b, 0) / widths.length;
    const avgHeight = heights.reduce((a, b) => a + b, 0) / heights.length;
    const orientation = spanX >= spanY ? 'horizontal' : 'vertical';
    if (orientation === 'horizontal' && spanY > avgHeight * 1.5) continue;
    if (orientation === 'vertical' && spanX > avgWidth * 1.5) continue;
    const colorCounts = new Map();
    const colorItems = new Map();
    for (const item of cluster) {
      const key = `${paintKey(item.fill)}|${paintKey(item.stroke)}`;
      colorCounts.set(key, (colorCounts.get(key) || 0) + 1);
      if (!colorItems.has(key)) colorItems.set(key, []);
      colorItems.get(key).push(item);
    }
    if (colorCounts.size < 2) continue;

    // If the cluster lacks any UI hint (keyword/reaction/text), treat it as static (e.g., table header) and skip
    const clusterHasUIHint = cluster.some((c) => hasUIKeyword(c.node) || hasReactions(c.node) || hasTextDescendant(c.node));
    if (!clusterHasUIHint) continue;

    const strokeWeights = cluster.map((c) => c.strokeWeight || 0);
    const strokeMin = Math.min(...strokeWeights);
    const strokeMax = Math.max(...strokeWeights);
    const strokeDiffers = strokeMax - strokeMin >= 0.75 || (strokeMax > 0 && strokeMin === 0);
    const hasBold = cluster.some((c) => c.hasBold);
    const mixedBold = hasBold && cluster.some((c) => !c.hasBold);
    if (strokeDiffers || mixedBold) continue;

    const groupsArray = Array.from(colorItems.values()).sort((a, b) => b.length - a.length);
    const primaryGroup = groupsArray[0];

    // 3개 이상인데 모두 색이 제각각(primaryGroup이 1개)이면 태그/카테고리일 확률 높음 -> 무시
    if (cluster.length >= 3 && primaryGroup.length === 1) continue;

    const focusCandidates = primaryGroup.length >= 2 ? cluster.filter((item) => !primaryGroup.includes(item)) : cluster;
    const focusItems = focusCandidates.filter((item) => {
      const widthRatio = Math.max(item.rect.width, avgWidth) / Math.max(Math.min(item.rect.width, avgWidth), 0.001);
      const heightRatio = Math.max(item.rect.height, avgHeight) / Math.max(Math.min(item.rect.height, avgHeight), 0.001);
      const itemAspect = item.rect.width / Math.max(item.rect.height, 0.001);
      const avgAspect = avgWidth / Math.max(avgHeight, 0.001);
      const aspectRatio = Math.max(itemAspect, avgAspect) / Math.max(Math.min(itemAspect, avgAspect), 0.001);
      return widthRatio <= 1.4 && heightRatio <= 1.4 && aspectRatio <= 1.6;
    });
    if (!focusItems.length) continue;
    groups.push({ focusItems, items: cluster });
  }

  return groups;
};

const findIndicatorGroups = (parent, ctx) => {
  if (!parent || !('children' in parent)) return [];
  const indicatorNodes = collectNodes(parent, isIndicatorCandidate, []);
  const filteredNodes = (ctx && ctx.selectionOnly && ctx.allowedNodeIds)
    ? indicatorNodes.filter((n) => ctx.allowedNodeIds.has(n.id))
    : indicatorNodes;
  const candidates = filteredNodes
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
    const clusterHasUIHint = cluster.some((c) => hasUIKeyword(c.node) || hasReactions(c.node));
    if (!clusterHasUIHint) continue; // 테이블 등 정적 배열은 제외
    const analyzed = analyzeIndicatorCluster(cluster);
    if (analyzed) {
      groups.push(analyzed);
    }
  }
  return groups;

};
// Syntax check passed



const isTextStateCandidate = (node) => {
  if (node.type !== 'TEXT') return false;
  if (!isVisibleNode(node)) return false;
  // Ignore if it's likely a title or heading (simple heuristic: very large text)
  if (node.fontSize > 32) return false;
  return true;
};

const isTableishName = (name) => {
  if (!name) return false;
  const lower = name.toLowerCase();
  return lower.includes('table') || lower.includes('thead') || lower.includes('tbody') || lower.includes('grid') || lower.includes('row') || lower.includes('col') || lower.includes('column') || lower.includes('header');
};

const findTextStateGroups = (parent) => {
  if (!parent || !('children' in parent)) return [];

  const parentNames = [];
  if (parent.name) parentNames.push(parent.name);
  if (parent.parent && parent.parent.name) parentNames.push(parent.parent.name);
  if (parent.parent && parent.parent.parent && parent.parent.parent.name) parentNames.push(parent.parent.parent.name);
  if (parentNames.some(isTableishName)) return [];

  const texts = collectNodes(parent, isTextStateCandidate, []);
  if (texts.length < 2) return [];

  // Require UI hint to avoid static tables: keyword, reaction, or component context
  const hasUIHint = hasUIKeyword(parent) || hasReactions(parent) || isInsideComponent(parent);
  if (!hasUIHint) return [];

  const groups = new Map();
  for (const t of texts) {
    const family = t.fontName ? t.fontName.family : 'default';
    const size = t.fontSize;
    const key = `${family}|${size}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  const issues = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;

    const colors = new Set();
    group.forEach(t => {
      const fill = firstSolidFill(t);
      colors.add(paintKey(fill));
    });

    if (colors.size < 2) continue;

    const weights = new Set();
    const decorations = new Set();

    group.forEach(t => {
      let w = 'Regular';
      if (t.fontName && t.fontName.style) {
        w = t.fontName.style;
      }
      weights.add(w);

      let d = 'None';
      if (t.textDecoration) d = t.textDecoration;
      decorations.add(d);
    });

    if (weights.size === 1 && decorations.size === 1) {
      // Skip if an underline/indicator line exists beneath any text (state is not color-only)
      const underlineExists = group.some(hasUnderlineIndicator);
      if (underlineExists) continue;
      issues.push({
        nodes: group,
        message: '상태 : 텍스트 상태(선택/미선택)가 색상으로만 구분됩니다.',
        suggestion: '조치 : 선택된 상태를 굵기(Bold)나 밑줄로 명확히 구분하세요.'
      });
    }
  }

  return issues;
};

/** Checks **/
function checkColorIndependence(node, ctx) {
  // 1. Existing Shape/Indicator Checks
  if (COLOR_INDICATOR_TYPES.includes(node.type) || STATE_GROUP_TYPES.includes(node.type)) {
    const containers = [];
    const parent = node.parent;
    if (parent && 'children' in parent) containers.push(parent);
    const grand = parent && parent.parent;
    if (grand && 'children' in grand) containers.push(grand);

    for (const container of containers) {
      if (ctx.checkedIndicatorContainers.has(container.id)) continue;
      ctx.checkedIndicatorContainers.add(container.id);

      const groups = findIndicatorGroups(container, ctx);
      for (const group of groups) {
        const target = group.focusItems.find((item) => !ctx.indicatorIssued.has(item.node.id));
        if (!target) continue;
        ctx.indicatorIssued.add(target.node.id);
        ctx.issues.push({
          nodeId: target.node.id,
          page: getPageName(target.node),
          frame: getNearestFrameName(target.node),
          name: target.node.name,
          type: 'color-independence',
          severity: 'warn',
          message: '상태 : 색상만 다른 인디케이터 그룹이 감지되었습니다.',
          suggestion: '조치 : 활성 상태를 패턴, 테두리, 텍스트 등 색 이외 수단으로도 구분하세요.'
        });
      }

      const stateGroups = findStateColorGroups(container, ctx);
      for (const group of stateGroups) {
        const target = group.focusItems.find((item) => !ctx.stateIssued.has(item.node.id));
        if (!target) continue;
        ctx.stateIssued.add(target.node.id);
        ctx.issues.push({
          nodeId: target.node.id,
          page: getPageName(target.node),
          frame: getNearestFrameName(target.node),
          name: target.node.name,
          type: 'color-independence',
          severity: 'warn',
          message: '상태 : 동일한 형태의 상태 그룹이 색/테두리만 달라집니다.',
          suggestion: '조치 : 활성 상태를 테두리 굵기/패턴, 아이콘, 밑줄, 음영 등 색 외 수단으로 구분하세요.'
        });
      }
    }
  }

  // 2. New Text State Checks
  // We only check this once per container to avoid duplicates
  if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE' || node.type === 'GROUP') {
    if (ctx.checkedTextContainers && ctx.checkedTextContainers.has(node.id)) return;
    if (!ctx.checkedTextContainers) ctx.checkedTextContainers = new Set();
    ctx.checkedTextContainers.add(node.id);

    const textIssues = findTextStateGroups(node);
    for (const issue of textIssues) {
      // Avoid duplicate reporting for the same group
      const firstNode = issue.nodes[0];
      if (ctx.indicatorIssued.has(firstNode.id)) continue;

      // Mark all as issued
      issue.nodes.forEach(n => ctx.indicatorIssued.add(n.id));

      ctx.issues.push({
        nodeId: firstNode.id,
        page: getPageName(firstNode),
        frame: getNearestFrameName(firstNode),
        name: firstNode.name,
        type: 'color-independence',
        severity: 'warn',
        message: issue.message,
        suggestion: issue.suggestion
      });
    }
  }
}

function checkTextContrast(node, issues, ctx) {

  if (!isVisibleNode(node)) return;
  let fill = firstSolidFill(node) || firstVisiblePaint(node);
  if (!fill && hasVisibleStroke(node)) {
    fill = firstSolidStroke(node);
  }

  if (!fill) return;

  // Try to find background: parent -> ancestor -> covering sibling. If not found, skip with info.
  const { paint: bg, source: bgSource } = findBackgroundPaint(node);
  if (!bg || bgSource === 'fallback') {
    issues.push({
      nodeId: node.id,
      page: getPageName(node),
      frame: getNearestFrameName(node),
      name: node.name,
      type: 'contrast',
      severity: 'info',
      message: '상태 : 배경을 찾지 못해 텍스트 대비를 계산하지 않았습니다.',
      suggestion: '조치 : 텍스트를 감싸는 프레임/그룹에 단색 Fill을 지정하고 다시 검사하세요.'
    });
    return;
  }

  // Use effective colors that consider opacity
  const fgColor = getEffectiveColor(fill) || getPaintColor(fill);
  const bgColor = getEffectiveColor(bg) || getPaintColor(bg);
  if (!fgColor || !bgColor) return; // cannot compute reliable contrast
  const ratio = contrastRatio({ color: fgColor }, { color: bgColor });

  // If foreground/background came out effectively identical from a non-fallback source, treat as unmeasurable instead of error.
  if (ratio <= 1.1 && bgSource !== 'fallback') {
    issues.push({
      nodeId: node.id,
      page: getPageName(node),
      frame: getNearestFrameName(node),
      name: node.name,
      type: 'contrast',
      severity: 'info',
      message: '상태 : 배경과 전경 색이 동일하게 계산되어 대비를 측정하지 않았습니다.',
      suggestion: '조치 : 텍스트 색/스타일을 명확히 지정하고 배경 레이어를 텍스트 뒤에 배치해 단색/그래디언트 Fill을 설정하세요.'
    });
    return;
  }

  // Determine if this is "Large Text" per WCAG AA
  // WCAG 기준 (Figma는 px 단위 사용):
  //   - 일반 텍스트 (24px 미만 또는 18.67px Bold 미만): 4.5:1 이상
  //   - 큰 텍스트 (24px 이상 또는 18.67px Bold 이상): 3:1 이상
  // 참고: 18pt = 24px, 14pt = 18.67px
  const fontSize = getNumericFontSize(node) || 16; // Default to 16 if not readable
  const isBold = isBoldStyle(node);
  const LARGE_TEXT_PX = 24; // 18pt = 24px
  const LARGE_BOLD_PX = 18.67; // 14pt = 18.67px
  const EPS = 0.5; // allow small rounding differences

  // Determine if large text per WCAG AA
  const isLargeText =
    fontSize >= (LARGE_TEXT_PX - EPS) ||
    (fontSize >= (LARGE_BOLD_PX - EPS) && isBold);

  // Apply threshold based on contrast mode
  let textThreshold;
  if (ctx.contrastMode === 'fixed3') {
    // 3:1 고정 모드: 모든 텍스트 3:1
    textThreshold = 3;
  } else {
    // 가이드 규정 모드 (WCAG): 크기 기반 (일반 4.5:1 / 큰 텍스트 3:1)
    const defaultThreshold = isLargeText ? TEXT_CONTRAST_LARGE : TEXT_CONTRAST_NORMAL;
    textThreshold = (ctx.minTextContrast !== null && ctx.minTextContrast !== undefined)
      ? ctx.minTextContrast
      : defaultThreshold;
  }

  if (ratio >= textThreshold) {
    return;
  }

  const weakBgSources = new Set([
    'sibling-overlap',
    'covering',
    'sibling-dominant',
    'ancestor-dominant',
    'ancestor-overlap',
    'large-sibling',
    'center-cover',
    'overlap',
    'ancestor-frame'
  ]);
  if (weakBgSources.has(bgSource)) {
    issues.push({
      nodeId: node.id,
      page: getPageName(node),
      frame: getNearestFrameName(node),
      name: node.name,
      type: 'contrast',
      severity: 'info',
      ratio: fmtNum(ratio),
      threshold: textThreshold,
      message: `상태: 텍스트 대비 ${fmtNum(ratio)}:1, 텍스트 크기 ${sizeLabel}<br>배경 추정치(${bgSource}) 기준으로 계산했습니다. 배경을 명시하면 정확한 결과를 볼 수 있습니다.`,
      suggestion: '조치: 텍스트를 감싸는 프레임/그룹에 명시적 배경 Fill을 지정하세요.'
    });
    return;
  }

  const sizeLabel = `${fmtNum(fontSize)}px`;

  // Determine category and detail labels based on contrast mode
  let categoryLabel, detailLabel;

  if (ctx.contrastMode === 'fixed3') {
    // 3:1 고정 모드
    categoryLabel = '3:1 고정 모드';
    detailLabel = '(모든 텍스트) 3:1 이상';
  } else {
    // 가이드 규정 모드 (WCAG)
    const hasUserThreshold = (ctx.minTextContrast !== null && ctx.minTextContrast !== undefined);
    categoryLabel = hasUserThreshold
      ? '사용자 설정 대비'
      : (isLargeText ? '큰 텍스트' : '일반 텍스트');
    detailLabel = hasUserThreshold
      ? `(${textThreshold}:1 이상, 사용자 설정)`
      : (isLargeText
        ? '(24px 이상 또는 18.67px Bold 이상) 3:1 이상'
        : '(24px 미만 또는 18.67px Bold 미만) 4.5:1 이상');
  }
  const basisLabel = `${categoryLabel}<br>${detailLabel}`;

  issues.push({
    nodeId: node.id,
    page: getPageName(node),
    frame: getNearestFrameName(node),
    name: node.name,
    type: 'contrast',
    severity: 'error',
    ratio: fmtNum(ratio),
    threshold: textThreshold,
    message: `상태: 텍스트 대비 ${fmtNum(ratio)}:1, 텍스트 크기 ${sizeLabel}<br>적용 기준: ${basisLabel}`,
    suggestion: `조치: 전경·배경 색상을 ${textThreshold}:1 이상으로 조정하세요.`
  });

}

function checkShapeContrast(node, issues, ctx) {
  // Skip if not a shape type
  if (!CONTRAST_SHAPE_TYPES.includes(node.type)) return;
  if (!isVisibleNode(node)) return;

  // Skip decorative shapes (no UI keywords, no nearby text)
  if (isDecorativeName(node)) return;
  if (!isLikelyUIElement(node)) return;

  // Skip if it's a backplate or background
  if (isBackplateShape(node)) return;

  // Skip large boxes (likely backgrounds/containers, not UI icons)
  if (node.width >= MAX_UI_ELEMENT_SIZE || node.height >= MAX_UI_ELEMENT_SIZE) {
    return;
  }

  // Get foreground color
  let fill = firstSolidFill(node);
  if (!fill) fill = firstVisiblePaint(node);

  if (!fill) {
    // Try stroke if no fill
    if (hasVisibleStroke(node)) {
      const stroke = firstSolidStroke(node);
      if (stroke) {
        fill = stroke;
      }
    }
  }

  if (!fill) return;

  // Find background
  const { paint: bg, source: bgSource } = findBackgroundPaint(node);
  if (!bg || bgSource === 'fallback') {
    // Skip info message for shapes (too noisy)
    return;
  }

  const fgColor = getPaintColor(fill);
  const bgColor = getPaintColor(bg);
  const bgOpacity = typeof bg.opacity === 'number' ? bg.opacity : 1;

  if (bgOpacity < 0.2) return; // Skip low opacity backgrounds
  if (!fgColor || !bgColor) return;

  const ratio = contrastRatio({ color: fgColor }, { color: bgColor });

  // Skip if colors are effectively identical (same as checkTextContrast)
  if (ratio <= 1.1) {
    return;
  }

  // UI shape threshold: 3:1
  const shapeThreshold = 3;

  if (ratio >= shapeThreshold) return;

  // Report issue
  issues.push({
    nodeId: node.id,
    page: getPageName(node),
    frame: getNearestFrameName(node),
    name: node.name,
    type: 'contrast',
    severity: 'warn',
    ratio: fmtNum(ratio),
    threshold: shapeThreshold,
    message: `상태: UI 요소 대비 ${fmtNum(ratio)}:1<br>적용 기준: UI 요소/아이콘 3:1 이상`,
    suggestion: `조치: 전경·배경 색상을 ${shapeThreshold}:1 이상으로 조정하세요.`
  });
}

function checkStrokeContrast(node, issues, ctx) {
  // Check stroke (border) contrast for UI elements
  if (!CONTRAST_SHAPE_TYPES.includes(node.type)) return;
  if (!isVisibleNode(node)) return;

  // Only check if node has a visible stroke
  if (!hasVisibleStroke(node)) return;

  const stroke = firstSolidStroke(node);
  if (!stroke) return;

  // Skip decorative shapes
  if (isDecorativeName(node)) return;

  // Check if this is a UI element with borders
  const borderKeywords = ['toggle', 'switch', 'checkbox', 'radio', 'input', 'field', 'text-field', 'textfield',
    'card', 'modal', 'dropdown', 'select', 'button', 'btn', 'border', 'outline'];
  const nodeName = (node.name || '').toLowerCase();
  const hasBorderKeyword = borderKeywords.some(kw => nodeName.includes(kw));

  // If no border keywords and not a likely UI element, skip
  if (!hasBorderKeyword && !isLikelyUIElement(node)) return;

  // Skip if it's a backplate or background
  if (isBackplateShape(node)) return;

  // Find background
  const { paint: bg, source: bgSource } = findBackgroundPaint(node);
  if (!bg || bgSource === 'fallback') {
    return;
  }

  const strokeColor = getPaintColor(stroke);
  const bgColor = getPaintColor(bg);
  const bgOpacity = typeof bg.opacity === 'number' ? bg.opacity : 1;

  if (bgOpacity < 0.2) return;
  if (!strokeColor || !bgColor) return;

  const ratio = contrastRatio({ color: strokeColor }, { color: bgColor });

  // Skip if colors are effectively identical
  if (ratio <= 1.1) return;

  // Stroke threshold: 3:1
  const strokeThreshold = 3;

  if (ratio >= strokeThreshold) return;

  // Report issue
  issues.push({
    nodeId: node.id,
    page: getPageName(node),
    frame: getNearestFrameName(node),
    name: node.name,
    type: 'contrast',
    severity: 'warn',
    ratio: fmtNum(ratio),
    threshold: strokeThreshold,
    message: `상태: 테두리(Stroke) 대비 ${fmtNum(ratio)}:1<br>적용 기준: UI 테두리 3:1 이상`,
    suggestion: `조치: 테두리 색상을 배경 대비 ${strokeThreshold}:1 이상으로 조정하세요.`
  });
}

function checkAutoContentControls(node, ctx) {
  if (!isVisibleNode(node)) return;
  if (!(node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE' || node.type === 'SECTION' || node.type === 'GROUP')) return;

  if (!isLikelyAutoFrame(node)) return;
  if (ctx.autoContentIssued.has(node.id)) return;
  if (hasAutoAncestorIssued(node, ctx.autoContentIssued)) return;

  ctx.autoContentIssued.add(node.id);
  ctx.issues.push({
    nodeId: node.id,
    page: getPageName(node),
    frame: getNearestFrameName(node),
    name: node.name,
    type: 'auto-content',
    severity: 'info',
    message: '상태 : 배너/슬라이드로 추정되는 프레임을 감지했습니다. 자동 전환 여부와 제어 버튼 제공 여부를 확인해 주세요.',
    suggestion: '조치 : 자동 재생 배너라면 정지·이전·다음·전체보기 등 조작 UI를 제공하세요.'
  });
}

function runChecksOnNode(node, ctx) {
  // Early exit: skip invisible nodes immediately
  if (!isVisibleNode(node)) return;

  if (ctx.selectionOnly && ctx.allowedNodeIds && !ctx.allowedNodeIds.has(node.id)) {
    return;
  }
  if (ctx.rules.colorIndependence) {
    checkColorIndependence(node, ctx);
  }
  if (ctx.rules.contrast) {
    if (node.type === 'TEXT') {
      checkTextContrast(node, ctx.issues, ctx);
    } else if (CONTRAST_SHAPE_TYPES.includes(node.type)) {
      checkShapeContrast(node, ctx.issues, ctx);
      checkStrokeContrast(node, ctx.issues, ctx); // Check stroke separately
    }
  }
  if (ctx.rules.autoContent) {
    checkAutoContentControls(node, ctx);
  }
}

function gatherRoots(scope) {
  if (scope === 'selection') {
    return figma.currentPage.selection.length ? figma.currentPage.selection : [];
  }
  if (scope === 'page') return [figma.currentPage];
  return figma.root.children;
}

function gatherAllowedIds(nodes, acc = new Set()) {
  for (const node of nodes) {
    acc.add(node.id);
    if ('children' in node && Array.isArray(node.children)) {
      gatherAllowedIds(node.children, acc);
    }
  }
  return acc;
}

async function runChecks(payload) {
  resetCaches();
  CANCEL_REQUESTED = false;
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
  const minTextContrast = (payload && payload.minTextContrast !== null && payload.minTextContrast !== undefined)
    ? Number(payload.minTextContrast)
    : null; // null means auto (size-based)
  const contrastMode = (payload && payload.contrastMode) || 'wcag'; // 'wcag' or 'fixed3'
  const issues = [];
  const ctx = {
    rules,
    minTextContrast,
    contrastMode,
    issues,
    checkedIndicatorContainers: new Set(),
    indicatorIssued: new Set(),
    stateIssued: new Set(),
    autoContentIssued: new Set()
  };
  const roots = gatherRoots(scope);
  if (scope === 'selection' && roots.length === 0) {
    figma.notify('선택한 프레임이나 컴포넌트를 찾지 못했습니다. 선택 후 다시 실행해 주세요.');
    return { issues: [], meta: { noSelection: true } };
  }
  if (scope === 'selection') {
    ctx.selectionOnly = true;
    ctx.allowedNodeIds = gatherAllowedIds(roots);
  } else {
    ctx.selectionOnly = false;
    ctx.allowedNodeIds = null;
  }
  const stack = [...roots];
  let processed = 0;
  while (stack.length) {
    if (CANCEL_REQUESTED) return { issues, meta: { cancelled: true } };
    const node = stack.pop();
    runChecksOnNode(node, ctx);
    if ('children' in node && Array.isArray(node.children)) {
      for (const child of node.children) {
        stack.push(child);
      }
    }
    processed += 1;
    if (processed % 200 === 0) {
      // Yield to allow stop messages to be processed
      await Promise.resolve();
    }
  }
  return { issues, meta: {} };
}

/** UI messaging **/
figma.ui.onmessage = async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'run-checks' || msg.type === 'run') {
    const payload = msg.payload || msg;
    const { issues, meta } = await runChecks(payload);
    figma.ui.postMessage({ type: 'results', issues, meta });
  } else if (msg.type === 'stop-checks' || msg.type === 'stop') {
    requestCancel();
  } else if (msg.type === 'check-contrast') {
    // Quick contrast check for selected element
    const selection = figma.currentPage.selection;
    if (selection.length === 0) {
      figma.ui.postMessage({
        type: 'results',
        issues: [{
          nodeId: '',
          type: 'contrast',
          severity: 'info',
          message: '요소를 선택한 후 명도 대비 체크 버튼을 눌러주세요.',
          suggestion: ''
        }],
        meta: { total: 1 }
      });
      return;
    }

    const node = selection[0];
    const issues = [];

    // Get element color (prefer fill over stroke)
    let elementPaint = null;
    let elementSource = '';

    // For frames/components, use their background
    if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE') {
      const paints = getNodePaints(node);
      elementPaint = paints.find(isVisiblePaintAny);
      elementSource = 'frame background';
    } else {
      // For other elements, get fill or stroke
      elementPaint = firstVisibleFillOrStroke(node);
      elementSource = 'element fill';
    }

    if (!elementPaint) {
      figma.ui.postMessage({
        type: 'results',
        issues: [{
          nodeId: node.id,
          name: node.name,
          type: 'contrast',
          severity: 'info',
          message: '선택한 요소에 색상이 없습니다.',
          suggestion: '색상이 있는 요소를 선택해주세요.'
        }],
        meta: { total: 1 }
      });
      return;
    }

    // Get background color - look for parent frame
    let bgPaint = null;
    let bgSource = '';
    let parent = node.parent;

    // Find first parent with a background
    while (parent && parent.type !== 'PAGE') {
      if (parent.type === 'FRAME' || parent.type === 'COMPONENT' || parent.type === 'INSTANCE' || parent.type === 'SECTION') {
        const paints = getNodePaints(parent);
        const visiblePaint = paints.find(isVisiblePaintAny);
        if (visiblePaint && getPaintColor(visiblePaint)) {
          bgPaint = visiblePaint;
          bgSource = `parent frame: ${parent.name} `;
          break;
        }
      }
      parent = parent.parent;
    }

    // Fallback to findBackgroundPaint if no parent frame found
    if (!bgPaint) {
      const bgResult = findBackgroundPaint(node);
      bgPaint = bgResult.paint;
      bgSource = bgResult.source;
    }

    if (!bgPaint) {
      figma.ui.postMessage({
        type: 'results',
        issues: [{
          nodeId: node.id,
          name: node.name,
          type: 'contrast',
          severity: 'info',
          message: '배경 색상을 찾을 수 없습니다.',
          suggestion: '요소를 감싸는 프레임에 배경 색상을 지정해주세요.'
        }],
        meta: { total: 1 }
      });
      return;
    }

    // Calculate contrast
    const fgColor = getEffectiveColor(elementPaint);
    const bgColor = getEffectiveColor(bgPaint);

    if (!fgColor || !bgColor) {
      figma.ui.postMessage({
        type: 'results',
        issues: [{
          nodeId: node.id,
          name: node.name,
          type: 'contrast',
          severity: 'info',
          message: '색상을 계산할 수 없습니다.',
          suggestion: '단색(Solid) 색상을 사용해주세요.'
        }],
        meta: { total: 1 }
      });
      return;
    }

    const ratio = contrastRatio({ color: fgColor }, { color: bgColor });
    const fgHex = rgbToHex(fgColor);
    const bgHex = rgbToHex(bgColor);

    // Determine if it passes WCAG standards
    let wcagStatus = '';
    if (ratio >= 4.5) {
      wcagStatus = '✅ WCAG AA 일반 텍스트 통과 (4.5:1)';
    } else if (ratio >= 3) {
      wcagStatus = '⚠️ WCAG AA 큰 텍스트만 통과 (3:1)';
    } else {
      wcagStatus = '❌ WCAG AA 기준 미달';
    }

    figma.ui.postMessage({
      type: 'results',
      issues: [{
        nodeId: node.id,
        page: getPageName(node),
        frame: getNearestFrameName(node),
        name: node.name,
        type: 'contrast',
        severity: ratio >= 3 ? 'info' : 'warn',
        ratio: fmtNum(ratio),
        message: `< strong > 명도 대비 체크 결과</strong > <br>요소 색상: ${fgHex} (${elementSource})<br>배경 색상: ${bgHex} (${bgSource})<br>명도 대비: ${fmtNum(ratio)}:1<br>${wcagStatus}`,
        suggestion: ratio < 4.5 ? '더 높은 명도 대비를 위해 색상을 조정하세요.' : ''
      }],
      meta: { total: 1 }
    });
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
