import * as Colors from './colors.js';
import { PindouConverter } from './converter.js';

// ==================== 色库 / 转换器初始化 ====================

const DEFAULT_BRAND = Colors.DEFAULT_BRAND || 'MARD';
const FALLBACK_COLORS = Array.isArray(Colors.PERLER_COLORS) ? Colors.PERLER_COLORS : [];

let currentBrand = DEFAULT_BRAND;
let currentSubsetSize = '291';
let currentPalette = [];
let converter = null;

let sourceImg = null;
let currentMatrix = [];
let currentStats = {};
let selectedColor = null;
let currentTool = 'pen';
let brushSize = 1;
let isPainting = false;
let historyStack = [];
let previewMode = 'pegboard';
let patternMode = 'bead';
let activePanState = null;
let excludedColors = new Set();

// 注意：这里不再做前置强平滑，避免图片变糊
const POST_DENOISE_PASSES = 1;

// ==================== DOM ====================

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const convertBtn = document.getElementById('convert-btn');
const outputArea = document.getElementById('output-area');
const customCursor = document.getElementById('custom-cursor');

const previewCanvas = document.getElementById('preview-canvas');
const previewWrapper = document.getElementById('preview-wrapper');
const previewZoom = document.getElementById('preview-zoom');

const patternCanvas = document.getElementById('pattern-canvas');
const patternWrapper = document.getElementById('pattern-wrapper');
const patternZoom = document.getElementById('pattern-zoom');

const paletteContainer = document.getElementById('palette');

const brandSelect = document.getElementById('brand-select');
const subsetSelect = document.getElementById('subset-select');
const subsetGroup = document.getElementById('subset-group');

// ==================== 基础工具函数 ====================

function cloneMatrix(matrix) {
    return JSON.parse(JSON.stringify(matrix));
}

function saveHistory() {
    if (!currentMatrix.length) return;
    historyStack.push(cloneMatrix(currentMatrix));
    if (historyStack.length > 100) historyStack.shift();
}

function safeFileName(name) {
    return String(name).replace(/[\\/:*?"<>|]/g, '_');
}

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

function normalizeSubsetValue(value) {
    const v = String(value ?? '').trim();
    if (!v) return '291';
    if (v === 'ALL' || v === 'all' || v === 'full') return '291';
    return v;
}

function hexToRgbFallback(hex) {
    const clean = String(hex || '#000000').replace('#', '').trim();
    if (clean.length !== 6) return [0, 0, 0];

    const num = parseInt(clean, 16);
    return [
        (num >> 16) & 255,
        (num >> 8) & 255,
        num & 255
    ];
}

function getTextColorByHex(hex) {
    const rgb = converter && typeof converter.hexToRgb === 'function'
        ? converter.hexToRgb(hex)
        : hexToRgbFallback(hex);

    const brightness = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114;
    return brightness > 150 ? '#111' : '#fff';
}

function getWhiteColor() {
    const palette = currentPalette.length ? currentPalette : FALLBACK_COLORS;

    return (
        palette.find(c => String(c.hex).toUpperCase() === '#FFFFFF') ||
        palette.find(c => /white/i.test(c.name || '')) ||
        palette.find(c => /白/.test(c.name || '')) ||
        palette[0] ||
        { id: 'WHITE', symbol: 'WHITE', name: 'White', hex: '#FFFFFF' }
    );
}

function findBestMatchManual(r, g, b, palette = currentPalette) {
    if (!palette || !palette.length) return getWhiteColor();

    let best = palette[0];
    let bestDist = Number.POSITIVE_INFINITY;

    for (const color of palette) {
        const [cr, cg, cb] = hexToRgbFallback(color.hex);
        const dr = r - cr;
        const dg = g - cg;
        const db = b - cb;
        const dist = dr * dr + dg * dg + db * db;

        if (dist < bestDist) {
            bestDist = dist;
            best = color;
        }
    }

    return best;
}

function remapMatrixToPalette(matrix, palette = currentPalette) {
    if (!matrix.length || !palette.length) return matrix;

    const tempConverter = new PindouConverter(palette);

    return matrix.map(row => row.map(bead => {
        const beadHex = String(bead?.hex || '#FFFFFF').toUpperCase();

        const exact = palette.find(c => String(c.hex).toUpperCase() === beadHex);
        if (exact) return exact;

        const rgb = tempConverter.hexToRgb(beadHex);
        return tempConverter.findBestMatch(rgb[0], rgb[1], rgb[2]) || palette[0];
    }));
}

function buildCurrentPalette() {
    let palette = [];

    // 1. 优先支持 MARD 色号规格分类
    if (currentBrand === 'MARD' && normalizeSubsetValue(currentSubsetSize) !== '291' && typeof Colors.buildSubsetPalette === 'function') {
        const size = parseInt(normalizeSubsetValue(currentSubsetSize), 10);

        if (!Number.isNaN(size)) {
            try {
                // 兼容 buildSubsetPalette(brand, size)
                const p1 = Colors.buildSubsetPalette(currentBrand, size);
                if (Array.isArray(p1) && p1.length) {
                    palette = p1;
                }
            } catch (_) {}

            if (!palette.length) {
                try {
                    // 兼容 buildSubsetPalette(size)
                    const p2 = Colors.buildSubsetPalette(size);
                    if (Array.isArray(p2) && p2.length) {
                        palette = p2;
                    }
                } catch (_) {}
            }
        }
    }

    // 2. 普通品牌色库
    if (!palette.length && typeof Colors.buildPalette === 'function') {
        try {
            const p = Colors.buildPalette(currentBrand);
            if (Array.isArray(p) && p.length) {
                palette = p;
            }
        } catch (_) {}
    }

    // 3. 兜底
    if (!palette.length) {
        palette = FALLBACK_COLORS.slice();
    }

    // 4. 排除色过滤
    if (excludedColors.size > 0) {
        const filtered = palette.filter(c => !excludedColors.has(c.id));
        if (filtered.length > 0) palette = filtered;
    }

    return palette;
}

function syncPaletteAndConverter(remapExisting = false) {
    currentPalette = buildCurrentPalette();
    converter = new PindouConverter(currentPalette);

    if (!selectedColor || !currentPalette.some(c => c.id === selectedColor.id)) {
        selectedColor = currentPalette[0] || getWhiteColor();
    }

    if (remapExisting && currentMatrix.length) {
        currentMatrix = remapMatrixToPalette(currentMatrix, currentPalette);
        historyStack = [];
    }

    initPalette();
    refreshAll();
}

function updateSubsetVisibility() {
    if (!subsetGroup || !subsetSelect) return;

    const isMard = currentBrand === 'MARD';
    subsetGroup.style.display = isMard ? 'block' : 'none';
    subsetSelect.disabled = !isMard;
}

// ==================== 降噪 / 杂色处理 ====================

function getNeighborBeads(matrix, x, y) {
    const counts = new Map();
    const neighbors = [];

    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;

            const ny = y + dy;
            const nx = x + dx;

            if (ny < 0 || ny >= matrix.length || nx < 0 || nx >= matrix[0].length) continue;

            const bead = matrix[ny][nx];
            neighbors.push(bead);
            counts.set(bead.id, (counts.get(bead.id) || 0) + 1);
        }
    }

    let bestBead = null;
    let bestCount = 0;

    for (const bead of neighbors) {
        const c = counts.get(bead.id) || 0;
        if (c > bestCount) {
            bestCount = c;
            bestBead = bead;
        }
    }

    return { counts, bestBead, bestCount };
}

function denoiseMatrix(matrix, passes = 1) {
    if (!matrix.length) return matrix;

    let result = cloneMatrix(matrix);

    for (let pass = 0; pass < passes; pass++) {
        const next = cloneMatrix(result);
        const rows = result.length;
        const cols = result[0].length;

        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                const current = result[y][x];
                const { counts, bestBead, bestCount } = getNeighborBeads(result, x, y);
                const sameCount = counts.get(current.id) || 0;

                // 只清理非常明显的孤立点，避免再次糊图
                if (sameCount <= 0 && bestBead && bestCount >= 4 && bestBead.id !== current.id) {
                    next[y][x] = bestBead;
                }
            }
        }

        result = next;
    }

    return result;
}

function colorDistance(beadA, beadB) {
    const [r1, g1, b1] = hexToRgbFallback(beadA.hex);
    const [r2, g2, b2] = hexToRgbFallback(beadB.hex);

    const dr = r1 - r2;
    const dg = g1 - g2;
    const db = b1 - b2;

    return Math.sqrt(dr * dr + dg * dg + db * db);
}

function mergeSimilarColors(threshold = 0) {
    if (!currentMatrix.length) return;

    threshold = Math.max(0, Math.min(100, Number(threshold) || 0));
    if (threshold <= 0) return;

    saveHistory();

    const rows = currentMatrix.length;
    const cols = currentMatrix[0].length;
    const result = cloneMatrix(currentMatrix);
    const visited = Array.from({ length: rows }, () => Array(cols).fill(false));

    const dirs = [
        [0, -1],
        [1, 0],
        [0, 1],
        [-1, 0]
    ];

    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            if (visited[y][x]) continue;

            const base = currentMatrix[y][x];
            const queue = [[x, y]];
            const region = [];
            visited[y][x] = true;

            while (queue.length) {
                const [cx, cy] = queue.shift();
                region.push([cx, cy]);

                for (const [dx, dy] of dirs) {
                    const nx = cx + dx;
                    const ny = cy + dy;

                    if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
                    if (visited[ny][nx]) continue;

                    const bead = currentMatrix[ny][nx];
                    if (colorDistance(base, bead) <= threshold) {
                        visited[ny][nx] = true;
                        queue.push([nx, ny]);
                    }
                }
            }

            if (region.length <= 1) continue;

            const counts = new Map();
            for (const [rx, ry] of region) {
                const bead = currentMatrix[ry][rx];
                counts.set(bead.id, (counts.get(bead.id) || 0) + 1);
            }

            let dominantId = currentMatrix[y][x].id;
            let dominantCount = 0;

            for (const [id, count] of counts.entries()) {
                if (count > dominantCount) {
                    dominantId = id;
                    dominantCount = count;
                }
            }

            const dominantBead =
                currentPalette.find(c => c.id === dominantId) ||
                currentMatrix[y][x];

            for (const [rx, ry] of region) {
                result[ry][rx] = dominantBead;
            }
        }
    }

    currentMatrix = result;
    refreshAll();
}

function autoRemoveBackground() {
    if (!currentMatrix.length) return;

    saveHistory();

    const rows = currentMatrix.length;
    const cols = currentMatrix[0].length;
    const white = getWhiteColor();

    const edgeCounts = new Map();

    for (let x = 0; x < cols; x++) {
        [currentMatrix[0][x], currentMatrix[rows - 1][x]].forEach(bead => {
            edgeCounts.set(bead.id, (edgeCounts.get(bead.id) || 0) + 1);
        });
    }

    for (let y = 0; y < rows; y++) {
        [currentMatrix[y][0], currentMatrix[y][cols - 1]].forEach(bead => {
            edgeCounts.set(bead.id, (edgeCounts.get(bead.id) || 0) + 1);
        });
    }

    let bgId = null;
    let bgCount = 0;

    for (const [id, count] of edgeCounts.entries()) {
        if (count > bgCount) {
            bgId = id;
            bgCount = count;
        }
    }

    if (!bgId) return;

    currentMatrix = currentMatrix.map(row => row.map(bead => {
        return bead.id === bgId ? white : bead;
    }));

    refreshAll();
}

// ==================== 画布绘制 ====================

function drawBead(ctx, cx, cy, radius, color, printFriendly = false) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    ctx.strokeStyle = 'rgba(0,0,0,0.22)';
    ctx.lineWidth = 1;
    ctx.stroke();

    if (!printFriendly) {
        ctx.beginPath();
        ctx.arc(cx - radius * 0.28, cy - radius * 0.28, radius * 0.24, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.fill();

        ctx.beginPath();
        ctx.arc(cx, cy, radius * 0.18, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.14)';
        ctx.fill();
    }
}

function drawPegboardCell(ctx, x, y, size, color) {
    ctx.fillStyle = '#f7ebdd';
    ctx.fillRect(x, y, size, size);

    const pad = Math.max(1, size * 0.18);

    ctx.fillStyle = color;
    ctx.fillRect(x + pad, y + pad, size - pad * 2, size - pad * 2);

    ctx.strokeStyle = '#eadbc8';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
}

function drawSymbolText(ctx, symbol, cx, cy, cellSize, bgHex, useContrast = true, printFriendly = false) {
    const fs = Math.max(7, Math.min(15, cellSize * 0.28));
    ctx.font = `900 ${fs}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const textColor = useContrast ? getTextColorByHex(bgHex) : '#111';

    if (!printFriendly) {
        ctx.lineWidth = Math.max(1.2, fs * 0.14);
        ctx.strokeStyle = textColor === '#fff'
            ? 'rgba(0,0,0,0.65)'
            : 'rgba(255,255,255,0.9)';
        ctx.strokeText(symbol, cx, cy);
    }

    ctx.fillStyle = textColor;
    ctx.fillText(symbol, cx, cy);
}

function buildPreviewCanvas(mode, cellSize) {
    if (!currentMatrix.length) {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        return canvas;
    }

    const rows = currentMatrix.length;
    const cols = currentMatrix[0].length;

    const canvas = document.createElement('canvas');
    canvas.width = cols * cellSize;
    canvas.height = rows * cellSize;

    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (mode === 'flat') {
        currentMatrix.forEach((row, y) => {
            row.forEach((bead, x) => {
                ctx.fillStyle = bead.hex;
                ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
            });
        });

        return canvas;
    }

    if (mode === 'bead') {
        ctx.strokeStyle = '#eee5dd';
        ctx.lineWidth = 1;

        for (let x = 0; x <= cols; x++) {
            ctx.beginPath();
            ctx.moveTo(x * cellSize, 0);
            ctx.lineTo(x * cellSize, rows * cellSize);
            ctx.stroke();
        }

        for (let y = 0; y <= rows; y++) {
            ctx.beginPath();
            ctx.moveTo(0, y * cellSize);
            ctx.lineTo(cols * cellSize, y * cellSize);
            ctx.stroke();
        }

        currentMatrix.forEach((row, y) => {
            row.forEach((bead, x) => {
                const cx = x * cellSize + cellSize / 2;
                const cy = y * cellSize + cellSize / 2;
                drawBead(ctx, cx, cy, Math.max(2, cellSize * 0.42), bead.hex);
            });
        });

        return canvas;
    }

    currentMatrix.forEach((row, y) => {
        row.forEach((bead, x) => {
            drawPegboardCell(ctx, x * cellSize, y * cellSize, cellSize, bead.hex);
        });
    });

    return canvas;
}

function drawGuides(ctx, startX, startY, cols, rows, cellSize, gridWidth, gridHeight) {
    for (let x = 0; x <= cols; x++) {
        if (x % 10 === 0) {
            ctx.beginPath();
            ctx.moveTo(startX + x * cellSize, startY);
            ctx.lineTo(startX + x * cellSize, startY + gridHeight);
            ctx.stroke();
        }
    }

    for (let y = 0; y <= rows; y++) {
        if (y % 10 === 0) {
            ctx.beginPath();
            ctx.moveTo(startX, startY + y * cellSize);
            ctx.lineTo(startX + gridWidth, startY + y * cellSize);
            ctx.stroke();
        }
    }
}

function buildPatternCanvas(mode, cellSize, opts = {}) {
    if (!currentMatrix.length) {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        return canvas;
    }

    const {
        showSymbols = true,
        showGrid = true,
        showGuides = true,
        showLegend = true,
        printFriendly = false
    } = opts;

    const rows = currentMatrix.length;
    const cols = currentMatrix[0].length;

    const ids = Object.keys(currentStats).sort((a, b) => currentStats[b] - currentStats[a]);

    const legendWidth = showLegend ? 190 : 0;
    const startX = 20;
    const startY = 20;
    const gridWidth = cols * cellSize;
    const gridHeight = rows * cellSize;

    const canvas = document.createElement('canvas');
    canvas.width = startX + gridWidth + legendWidth + 20;
    canvas.height = startY + gridHeight + 20;

    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 先画基础网格
    if (showGrid) {
        ctx.strokeStyle = '#e6e6e6';
        ctx.lineWidth = 1;

        for (let x = 0; x <= cols; x++) {
            ctx.beginPath();
            ctx.moveTo(startX + x * cellSize, startY);
            ctx.lineTo(startX + x * cellSize, startY + gridHeight);
            ctx.stroke();
        }

        for (let y = 0; y <= rows; y++) {
            ctx.beginPath();
            ctx.moveTo(startX, startY + y * cellSize);
            ctx.lineTo(startX + gridWidth, startY + y * cellSize);
            ctx.stroke();
        }
    }

    currentMatrix.forEach((row, y) => {
        row.forEach((bead, x) => {
            const px = startX + x * cellSize;
            const py = startY + y * cellSize;
            const cx = px + cellSize / 2;
            const cy = py + cellSize / 2;

            if (mode === 'grid') {
                ctx.fillStyle = bead.hex;
                ctx.fillRect(px + 1, py + 1, cellSize - 2, cellSize - 2);

                ctx.strokeStyle = '#666';
                ctx.lineWidth = 1;
                ctx.strokeRect(px + 1, py + 1, cellSize - 2, cellSize - 2);

                if (showSymbols) {
                    drawSymbolText(ctx, bead.symbol, cx, cy, cellSize, bead.hex, true);
                }

                return;
            }

            drawBead(ctx, cx, cy, Math.max(2, cellSize * 0.42), bead.hex, printFriendly);

            if (showSymbols) {
                drawSymbolText(ctx, bead.symbol, cx, cy, cellSize, bead.hex, true, printFriendly);
            }
        });
    });

    // 红色辅助线放在最上层，导出更明显
    if (showGuides) {
        ctx.save();

        ctx.strokeStyle = 'rgba(255,255,255,1)';
        ctx.lineWidth = Math.max(6, cellSize * 0.16);
        drawGuides(ctx, startX, startY, cols, rows, cellSize, gridWidth, gridHeight);

        ctx.strokeStyle = 'rgba(255,0,0,1)';
        ctx.lineWidth = Math.max(4, cellSize * 0.12);
        drawGuides(ctx, startX, startY, cols, rows, cellSize, gridWidth, gridHeight);

        ctx.restore();
    }

    if (showLegend) {
        const panelX = startX + gridWidth + 12;
        const panelY = 20;
        const panelW = legendWidth - 20;
        const panelH = canvas.height - 40;

        ctx.fillStyle = '#f8f8f8';
        ctx.fillRect(panelX, panelY, panelW, panelH);

        ctx.strokeStyle = '#ddd';
        ctx.lineWidth = 1;
        ctx.strokeRect(panelX, panelY, panelW, panelH);

        ctx.fillStyle = '#222';
        ctx.font = 'bold 20px Arial';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('拼豆数量统计', panelX + 12, panelY + 12);

        let listY = panelY + 50;

        ids.forEach(id => {
            const bead =
                currentPalette.find(c => c.id === id) ||
                FALLBACK_COLORS.find(c => c.id === id);

            if (!bead) return;

            ctx.fillStyle = bead.hex;
            ctx.fillRect(panelX + 12, listY + 4, 14, 14);

            ctx.strokeStyle = '#bbb';
            ctx.strokeRect(panelX + 12, listY + 4, 14, 14);

            ctx.fillStyle = '#222';
            ctx.font = '13px Arial';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(`${bead.symbol}`, panelX + 34, listY + 1);

            ctx.fillStyle = '#666';
            ctx.font = '12px Arial';
            ctx.fillText(`${currentStats[id]} 颗`, panelX + 34, listY + 18);

            listY += 36;
        });

        const total = Object.values(currentStats).reduce((sum, n) => sum + n, 0);

        ctx.fillStyle = '#222';
        ctx.font = 'bold 14px Arial';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`总计: ${total}`, panelX + 12, panelY + panelH - 12);
    }

    return canvas;
}

// ==================== 刷新 ====================

function refreshAll() {
    if (!currentMatrix.length) return;

    currentStats = {};

    currentMatrix.forEach(row => {
        row.forEach(bead => {
            currentStats[bead.id] = (currentStats[bead.id] || 0) + 1;
        });
    });

    const previewBuilt = buildPreviewCanvas(previewMode, parseInt(previewZoom?.value || '14', 10));

    previewCanvas.width = previewBuilt.width;
    previewCanvas.height = previewBuilt.height;
    previewCanvas.getContext('2d').drawImage(previewBuilt, 0, 0);

    const patternBuilt = buildPatternCanvas(patternMode, parseInt(patternZoom?.value || '16', 10), {
        showSymbols: true,
        showGrid: true,
        showGuides: true,
        showLegend: true,
        printFriendly: false
    });

    patternCanvas.width = patternBuilt.width;
    patternCanvas.height = patternBuilt.height;
    patternCanvas.getContext('2d').drawImage(patternBuilt, 0, 0);

    renderList();
}

// ==================== 清单 ====================

function renderList() {
    const tbody = document.querySelector('#bead-list tbody');
    if (!tbody) return;

    tbody.innerHTML = Object.entries(currentStats)
        .sort((a, b) => b[1] - a[1])
        .map(([id, count]) => {
            const c =
                currentPalette.find(x => x.id === id) ||
                FALLBACK_COLORS.find(x => x.id === id);

            if (!c) return '';

            const excluded = excludedColors.has(c.id);

            return `
                <tr class="${excluded ? 'excluded-row' : ''}">
                    <td>
                        <div style="background:${c.hex};width:22px;height:22px;border-radius:50%;border:1px solid #ddd;"></div>
                    </td>
                    <td><strong>${c.symbol}</strong></td>
                    <td>${c.name}</td>
                    <td><strong>${count}</strong> 颗</td>
                    <td>
                        <button class="mini-btn list-exclude-btn" data-color-id="${c.id}">
                            ${excluded ? '恢复' : '排除'}
                        </button>
                    </td>
                </tr>
            `;
        }).join('');

    tbody.querySelectorAll('.list-exclude-btn').forEach(btn => {
        btn.onclick = () => {
            const id = btn.dataset.colorId;

            if (excludedColors.has(id)) {
                excludedColors.delete(id);
            } else {
                excludedColors.add(id);
            }

            syncPaletteAndConverter(true);
        };
    });
}

// ==================== 调色盘 ====================

function initPalette() {
    if (!paletteContainer) return;

    paletteContainer.innerHTML = '';

    currentPalette.forEach(color => {
        const item = document.createElement('div');
        item.className = 'palette-item';
        item.style.backgroundColor = color.hex;
        item.title = `${color.symbol} - ${color.name}`;
        item.dataset.colorId = color.id;

        if (selectedColor && color.id === selectedColor.id && currentTool === 'pen') {
            item.classList.add('active');
        }

        item.onclick = () => {
            selectedColor = color;
            currentTool = 'pen';
            updateToolUI();
        };

        paletteContainer.appendChild(item);
    });

    updateToolUI();
}

function updateToolUI() {
    const swatch = document.getElementById('current-color-show');

    if (swatch) {
        if (currentTool === 'eraser') {
            swatch.style.backgroundColor = '#fff';
            swatch.style.backgroundImage = 'repeating-linear-gradient(45deg, #ddd 0, #ddd 6px, #fff 6px, #fff 12px)';
            swatch.style.backgroundSize = '12px 12px';
        } else if (currentTool === 'hand') {
            swatch.style.backgroundColor = '#ddd';
            swatch.style.backgroundImage = 'none';
        } else {
            swatch.style.backgroundColor = selectedColor ? selectedColor.hex : '#ffffff';
            swatch.style.backgroundImage = 'none';
        }
    }

    ['tool-pen', 'tool-eraser', 'tool-hand'].forEach(id => {
        document.getElementById(id)?.classList.remove('active');
    });

    document.body.classList.remove('draw-mode', 'hand-mode');

    if (currentTool === 'pen') {
        document.getElementById('tool-pen')?.classList.add('active');
        document.body.classList.add('draw-mode');
    } else if (currentTool === 'eraser') {
        document.getElementById('tool-eraser')?.classList.add('active');
        document.body.classList.add('draw-mode');
    } else if (currentTool === 'hand') {
        document.getElementById('tool-hand')?.classList.add('active');
        document.body.classList.add('hand-mode');
    }

    document.querySelectorAll('.palette-item').forEach(el => {
        el.classList.remove('active');

        if (currentTool === 'pen' && selectedColor && el.dataset.colorId === selectedColor.id) {
            el.classList.add('active');
        }
    });
}

// ==================== 视图 / 工具 / 交互 ====================

function switchMode(e, id) {
    document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.remove('active'));
    e.currentTarget.classList.add('active');

    document.getElementById('upload-section').style.display = 'none';
    document.getElementById('draw-section').style.display = 'none';
    document.getElementById(id).style.display = 'block';
}

document.getElementById('mode-upload')?.addEventListener('click', e => switchMode(e, 'upload-section'));
document.getElementById('mode-draw')?.addEventListener('click', e => switchMode(e, 'draw-section'));

document.getElementById('tool-undo')?.addEventListener('click', () => {
    if (historyStack.length > 0) {
        currentMatrix = historyStack.pop();
        refreshAll();
    }
});

document.getElementById('tool-pen')?.addEventListener('click', () => {
    currentTool = 'pen';
    updateToolUI();
});

document.getElementById('tool-eraser')?.addEventListener('click', () => {
    currentTool = 'eraser';
    updateToolUI();
});

document.getElementById('tool-hand')?.addEventListener('click', () => {
    currentTool = 'hand';
    updateToolUI();
});

document.getElementById('brush-size')?.addEventListener('input', e => {
    brushSize = parseInt(e.target.value, 10);
    const sizeVal = document.getElementById('size-val');
    if (sizeVal) sizeVal.innerText = brushSize;
});

document.querySelectorAll('[data-preview-mode]').forEach(btn => {
    btn.onclick = () => {
        previewMode = btn.dataset.previewMode;

        document.querySelectorAll('[data-preview-mode]').forEach(x => x.classList.remove('active'));
        btn.classList.add('active');

        refreshAll();
    };
});

document.querySelectorAll('[data-pattern-mode]').forEach(btn => {
    btn.onclick = () => {
        patternMode = btn.dataset.patternMode;

        document.querySelectorAll('[data-pattern-mode]').forEach(x => x.classList.remove('active'));
        btn.classList.add('active');

        refreshAll();
    };
});

function updateCursor(e, cellSize) {
    if (!customCursor) return;

    if (currentTool === 'hand') {
        customCursor.style.display = 'none';
        return;
    }

    customCursor.style.display = 'block';
    customCursor.style.left = `${e.clientX}px`;
    customCursor.style.top = `${e.clientY}px`;

    const size = Math.max(12, brushSize * cellSize);
    customCursor.style.width = `${size}px`;
    customCursor.style.height = `${size}px`;
}

function setupInteraction(wrapper, canvas, zoomInput, isPattern) {
    if (!wrapper || !canvas || !zoomInput) return;

    wrapper.addEventListener('wheel', e => {
        e.preventDefault();

        let val = parseInt(zoomInput.value, 10);

        if (e.deltaY < 0) {
            val = Math.min(60, val + 2);
        } else {
            val = Math.max(6, val - 2);
        }

        zoomInput.value = val;

        refreshAll();
        updateCursor(e, val);
    }, { passive: false });

    canvas.addEventListener('mousedown', e => {
        if (!currentMatrix.length) return;

        if (currentTool === 'hand') {
            activePanState = {
                wrapper,
                startX: e.pageX,
                startY: e.pageY,
                scrollLeft: wrapper.scrollLeft,
                scrollTop: wrapper.scrollTop
            };

            return;
        }

        saveHistory();
        isPainting = true;
        handlePaint(e, canvas, zoomInput, isPattern);
    });

    canvas.addEventListener('mousemove', e => {
        const size = parseInt(zoomInput.value, 10);
        updateCursor(e, size);

        if (activePanState && currentTool === 'hand' && activePanState.wrapper === wrapper) {
            const dx = e.pageX - activePanState.startX;
            const dy = e.pageY - activePanState.startY;

            wrapper.scrollLeft = activePanState.scrollLeft - dx;
            wrapper.scrollTop = activePanState.scrollTop - dy;

            return;
        }

        if (isPainting) {
            handlePaint(e, canvas, zoomInput, isPattern);
        }
    });

    canvas.addEventListener('mouseenter', () => {
        if (currentTool !== 'hand') {
            document.body.classList.add('draw-mode');
        }
    });

    canvas.addEventListener('mouseleave', () => {
        document.body.classList.remove('draw-mode');

        if (customCursor) {
            customCursor.style.display = 'none';
        }
    });
}

window.addEventListener('mouseup', () => {
    activePanState = null;
    isPainting = false;
});

function handlePaint(e, canvas, zoomInput, isPattern) {
    if (currentTool === 'hand') return;
    if (!currentMatrix.length) return;

    const rect = canvas.getBoundingClientRect();
    const size = parseInt(zoomInput.value, 10);

    let centerX;
    let centerY;

    if (isPattern) {
        const margin = 20;
        centerX = Math.floor((e.clientX - rect.left - margin) / size);
        centerY = Math.floor((e.clientY - rect.top - margin) / size);
    } else {
        centerX = Math.floor((e.clientX - rect.left) / size);
        centerY = Math.floor((e.clientY - rect.top) / size);
    }

    const offset = Math.floor(brushSize / 2);
    const white = getWhiteColor();

    for (let dy = -offset; dy < brushSize - offset; dy++) {
        for (let dx = -offset; dx < brushSize - offset; dx++) {
            const x = centerX + dx;
            const y = centerY + dy;

            if (y >= 0 && y < currentMatrix.length && x >= 0 && x < currentMatrix[0].length) {
                currentMatrix[y][x] = currentTool === 'eraser' ? white : selectedColor;
            }
        }
    }

    refreshAll();
}

setupInteraction(previewWrapper, previewCanvas, previewZoom, false);
setupInteraction(patternWrapper, patternCanvas, patternZoom, true);

// ==================== 上传 / 转换 ====================

['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropZone?.addEventListener(eventName, preventDefaults, false);
});

['dragenter', 'dragover'].forEach(eventName => {
    dropZone?.addEventListener(eventName, () => dropZone.classList.add('drag-active'), false);
});

['dragleave', 'drop'].forEach(eventName => {
    dropZone?.addEventListener(eventName, () => dropZone.classList.remove('drag-active'), false);
});

dropZone?.addEventListener('click', () => fileInput?.click());

dropZone?.addEventListener('drop', e => {
    const dt = e.dataTransfer;

    if (!dt || !dt.files || dt.files.length === 0) return;

    handleFile(dt.files[0]);
}, false);

fileInput?.addEventListener('change', e => {
    if (!e.target.files || e.target.files.length === 0) return;

    handleFile(e.target.files[0]);
});

function handleFile(file) {
    if (!file || !file.type.startsWith('image/')) {
        alert('请选择有效的图片文件');
        return;
    }

    const reader = new FileReader();

    reader.onload = ev => {
        const img = new Image();

        img.onload = () => {
            sourceImg = img;

            const uploadControls = document.getElementById('upload-controls');
            if (uploadControls) uploadControls.style.display = 'flex';
        };

        img.src = ev.target.result;
    };

    reader.readAsDataURL(file);
}

function convertSourceImage() {
    if (!sourceImg) {
        alert('请先上传图片');
        return;
    }

    const widthInput = document.getElementById('width-input');
    const w = parseInt(widthInput?.value || '58', 10);
    const h = Math.max(1, Math.floor(sourceImg.height / sourceImg.width * w));

    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;

    const ctx = off.getContext('2d');

    // 关键：关闭缩放平滑，防止图像被糊掉
    ctx.imageSmoothingEnabled = false;

    ctx.drawImage(sourceImg, 0, 0, w, h);

    const rawImageData = ctx.getImageData(0, 0, w, h);

    // 使用当前配色系统，不改变色库逻辑
    currentMatrix = converter.applyDithering(rawImageData, w, h, {
        palette: currentPalette,
        diffusion: 0.28,
        dither: true
    });

    // 轻微去孤点，不做强平滑
    currentMatrix = denoiseMatrix(currentMatrix, POST_DENOISE_PASSES);

    historyStack = [];

    initPalette();

    if (outputArea) {
        outputArea.style.display = 'block';
    }

    refreshAll();
}

convertBtn?.addEventListener('click', convertSourceImage);

document.getElementById('init-draw-btn')?.addEventListener('click', () => {
    const w = parseInt(document.getElementById('draw-width')?.value || '29', 10);
    const h = parseInt(document.getElementById('draw-height')?.value || '29', 10);

    const white = getWhiteColor();

    currentMatrix = Array.from({ length: h }, () => Array.from({ length: w }, () => white));

    historyStack = [];

    initPalette();

    if (outputArea) {
        outputArea.style.display = 'block';
    }

    refreshAll();
});

// ==================== 智能优化按钮 ====================

const mergeThreshold = document.getElementById('merge-threshold');
const mergeThresholdVal = document.getElementById('merge-threshold-val');

mergeThreshold?.addEventListener('input', e => {
    if (mergeThresholdVal) {
        mergeThresholdVal.textContent = e.target.value;
    }
});

document.getElementById('merge-minus')?.addEventListener('click', () => {
    if (!mergeThreshold) return;

    const val = Math.max(0, parseInt(mergeThreshold.value || '0', 10) - 1);
    mergeThreshold.value = String(val);

    if (mergeThresholdVal) {
        mergeThresholdVal.textContent = String(val);
    }
});

document.getElementById('merge-plus')?.addEventListener('click', () => {
    if (!mergeThreshold) return;

    const val = Math.min(100, parseInt(mergeThreshold.value || '0', 10) + 1);
    mergeThreshold.value = String(val);

    if (mergeThresholdVal) {
        mergeThresholdVal.textContent = String(val);
    }
});

document.getElementById('btn-merge')?.addEventListener('click', () => {
    const val = parseInt(mergeThreshold?.value || '0', 10);
    mergeSimilarColors(val);
});

document.getElementById('btn-denoise')?.addEventListener('click', () => {
    if (!currentMatrix.length) return;

    saveHistory();
    currentMatrix = denoiseMatrix(currentMatrix, 1);
    refreshAll();
});

document.getElementById('btn-auto-bg')?.addEventListener('click', () => {
    autoRemoveBackground();
});

document.getElementById('btn-reset-excluded')?.addEventListener('click', () => {
    excludedColors.clear();
    syncPaletteAndConverter(true);
});

// ==================== 标签切换 ====================

document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.onclick = () => {
        document.querySelectorAll('.tab-btn').forEach(x => x.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(x => x.style.display = 'none');

        btn.classList.add('active');

        const target = document.getElementById(btn.dataset.tab);
        if (target) target.style.display = 'block';
    };
});

// ==================== 导出 ====================

function getExportCellSize() {
    const gridSize = document.getElementById('grid-size')?.value || '5mm';
    const quality = document.getElementById('export-quality')?.value || 'hd';

    let base = gridSize === '5mm' ? 28 : 16;

    if (quality === 'standard') base = gridSize === '5mm' ? 24 : 14;
    if (quality === 'hd') base = gridSize === '5mm' ? 30 : 18;
    if (quality === 'ultra') base = gridSize === '5mm' ? 38 : 22;

    return base;
}

function getExportOptions() {
    return {
        cellSize: getExportCellSize(),
        gridSize: document.getElementById('grid-size')?.value || '5mm',
        quality: document.getElementById('export-quality')?.value || 'hd',
        showSymbols: (document.getElementById('export-show-symbols')?.value || 'yes') === 'yes',
        showGrid: (document.getElementById('export-show-grid')?.value || 'yes') === 'yes',
        showGuides: (document.getElementById('export-show-guides')?.value || 'yes') === 'yes',
        showLegend: (document.getElementById('export-show-legend')?.value || 'yes') === 'yes',
        printFriendly: (document.getElementById('export-print-friendly')?.value || 'no') === 'yes'
    };
}

document.getElementById('download-btn')?.addEventListener('click', () => {
    if (!currentMatrix.length) return;

    const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab;
    const opts = getExportOptions();

    let exportCanvas;

    if (activeTab === 'preview-container') {
        exportCanvas = buildPreviewCanvas(previewMode, opts.cellSize);
    } else {
        exportCanvas = buildPatternCanvas(patternMode, opts.cellSize, opts);
    }

    const a = document.createElement('a');
    a.download = `pindou-design-${Date.now()}.png`;
    a.href = exportCanvas.toDataURL('image/png');
    a.click();
});

document.getElementById('export-json-btn')?.addEventListener('click', () => {
    if (!currentMatrix.length) return;

    const opts = getExportOptions();

    const payload = {
        version: 4,
        exportedAt: new Date().toISOString(),
        brand: currentBrand,
        subsetSize: currentBrand === 'MARD' ? normalizeSubsetValue(currentSubsetSize) : '291',
        width: currentMatrix[0].length,
        height: currentMatrix.length,
        gridSize: opts.gridSize,
        previewMode,
        patternMode,
        stats: currentStats,
        matrix: currentMatrix.map(row => row.map(bead => ({
            id: bead.id,
            symbol: bead.symbol,
            name: bead.name,
            hex: bead.hex
        })))
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: 'application/json'
    });

    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = safeFileName(`pindou-design-${Date.now()}.json`);
    a.click();

    URL.revokeObjectURL(url);
});

document.getElementById('export-svg-btn')?.addEventListener('click', () => {
    if (!currentMatrix.length) return;

    const cell = getExportCellSize();
    const rows = currentMatrix.length;
    const cols = currentMatrix[0].length;

    const width = cols * cell;
    const height = rows * cell;

    let svg = '';

    svg += `<?xml version="1.0" encoding="UTF-8"?>\n`;
    svg += `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n`;
    svg += `<rect width="100%" height="100%" fill="#ffffff"/>\n`;
    if (previewMode === 'flat') {
        currentMatrix.forEach((row, y) => {
            row.forEach((bead, x) => {
                svg += `<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="${bead.hex}"/>\n`;
            });
        });
    } else if (previewMode === 'pegboard') {
        currentMatrix.forEach((row, y) => {
            row.forEach((bead, x) => {
                const px = x * cell;
                const py = y * cell;
                const pad = Math.max(1, cell * 0.18);
                svg += `<rect x="${px}" y="${py}" width="${cell}" height="${cell}" fill="#f7ebdd" stroke="#eadbc8" stroke-width="1"/>\n`;
                svg += `<rect x="${px + pad}" y="${py + pad}" width="${cell - pad * 2}" height="${cell - pad * 2}" fill="${bead.hex}"/>\n`;
            });
        });
    } else {
        currentMatrix.forEach((row, y) => {
            row.forEach((bead, x) => {
                const cx = x * cell + cell / 2;
                const cy = y * cell + cell / 2;
                const r = cell * 0.42;
                svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${bead.hex}" stroke="rgba(0,0,0,0.18)" stroke-width="1"/>\n`;
                svg += `<circle cx="${cx - r * 0.28}" cy="${cy - r * 0.28}" r="${r * 0.24}" fill="rgba(255,255,255,0.26)"/>\n`;
                svg += `<circle cx="${cx}" cy="${cy}" r="${r * 0.18}" fill="rgba(255,255,255,0.14)"/>\n`;
            });
        });
    }
    svg += `</svg>`;

    const blob = new Blob([svg], {
        type: 'image/svg+xml;charset=utf-8'
    });

    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = safeFileName(`pindou-design-${Date.now()}.svg`);
    a.click();

    URL.revokeObjectURL(url);
});

document.getElementById('export-pdf-btn')?.addEventListener('click', async () => {
    if (!currentMatrix.length || !window.jspdf) return;

    const { jsPDF } = window.jspdf;
    const opts = getExportOptions();
    const exportCanvas = buildPatternCanvas(patternMode, opts.cellSize, opts);

    const pdf = new jsPDF('p', 'mm', 'a4');

    const pageW = 210;
    const pageH = 297;
    const margin = 10;
    const usableW = pageW - margin * 2;
    const usableH = pageH - margin * 2;

    const scale = Math.min(usableW / exportCanvas.width, usableH / exportCanvas.height);

    const drawW = exportCanvas.width * scale;
    const drawH = exportCanvas.height * scale;
    const x = (pageW - drawW) / 2;
    const y = (pageH - drawH) / 2;

    pdf.addImage(exportCanvas.toDataURL('image/png'), 'PNG', x, y, drawW, drawH);
    pdf.save(`pindou-design-${Date.now()}.pdf`);
});

document.getElementById('print-a4-btn')?.addEventListener('click', () => {
    if (!currentMatrix.length) return;

    const opts = getExportOptions();
    const exportCanvas = buildPatternCanvas(patternMode, opts.cellSize, opts);
    const dataUrl = exportCanvas.toDataURL('image/png');

    const printWindow = window.open('', '_blank');
    if (!printWindow) return;

    printWindow.document.write(`
        <html>
        <head>
            <title>拼豆图纸打印</title>
            <style>
                body {
                    margin: 0;
                    padding: 0;
                    text-align: center;
                    background: #fff;
                }
                img {
                    max-width: 100%;
                    height: auto;
                }
                @page {
                    size: A4 portrait;
                    margin: 10mm;
                }
            </style>
        </head>
        <body>
            <img src="${dataUrl}" />
            <script>
                window.onload = function() {
                    window.print();
                };
            <\/script>
        </body>
        </html>
    `);

    printWindow.document.close();
});

// ==================== 品牌 / 色号规格 ====================

brandSelect?.addEventListener('change', e => {
    currentBrand = e.target.value;

    if (currentBrand !== 'MARD') {
        currentSubsetSize = '291';
    }

    updateSubsetVisibility();
    syncPaletteAndConverter(true);
});

subsetSelect?.addEventListener('change', e => {
    currentSubsetSize = normalizeSubsetValue(e.target.value);
    syncPaletteAndConverter(true);
});

// ==================== 初始化 ====================

function initBrandAndSubsetUI() {
    if (brandSelect) {
        currentBrand = brandSelect.value || currentBrand;
    }

    if (subsetSelect) {
        currentSubsetSize = normalizeSubsetValue(subsetSelect.value || currentSubsetSize);
    }

    updateSubsetVisibility();
}

initBrandAndSubsetUI();
syncPaletteAndConverter(false);
