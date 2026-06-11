import { buildPalette, DEFAULT_BRAND, COLOR_SYSTEM_MAPPING } from './colors.js';
import { PindouConverter } from './converter.js';

let currentBrand = DEFAULT_BRAND;
let PERLER_COLORS = buildPalette(currentBrand);
let converter = new PindouConverter(PERLER_COLORS);

let sourceImg = null;
let currentMatrix = [];
let currentStats = {};
let selectedColor = PERLER_COLORS[0];
let currentTool = 'pen';
let brushSize = 1;
let isPainting = false;
let historyStack = [];
let previewMode = 'pegboard';
let patternMode = 'bead';
let activePanState = null;

// 颜色排除管理
let excludedColors = new Set();

// DOM
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

// ==================== 工具函数 ====================

function cloneMatrix(matrix) {
    return JSON.parse(JSON.stringify(matrix));
}

function saveHistory() {
    historyStack.push(cloneMatrix(currentMatrix));
    if (historyStack.length > 100) historyStack.shift();
}

function getTextColorByHex(hex) {
    const rgb = converter.hexToRgb(hex);
    const brightness = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114;
    return brightness > 150 ? '#111' : '#fff';
}

function colorDistance(a, b) {
    const ra = parseInt(a.hex.slice(1, 3), 16);
    const ga = parseInt(a.hex.slice(3, 5), 16);
    const ba = parseInt(a.hex.slice(5, 7), 16);
    const rb = parseInt(b.hex.slice(1, 3), 16);
    const gb = parseInt(b.hex.slice(3, 5), 16);
    const bb = parseInt(b.hex.slice(5, 7), 16);
    return Math.sqrt((ra - rb) ** 2 + (ga - gb) ** 2 + (ba - bb) ** 2);
}

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
        ctx.fillStyle = 'rgba(255,255,255,0.26)';
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

function safeFileName(name) {
    return name.replace(/[\\\/:*?"<>|]/g, '_');
}

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

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

// ==================== 颜色排除与重映射 ====================

function excludeColor(colorId) {
    excludedColors.add(colorId);
    remapExcludedColors();
}

function includeColor(colorId) {
    excludedColors.delete(colorId);
    remapExcludedColors();
}

function resetExcluded() {
    excludedColors.clear();
    // 不做 remap，让用户看到原始状态
    refreshAll();
}

function remapExcludedColors() {
    if (!currentMatrix.length) return;
    if (excludedColors.size === 0) { refreshAll(); return; }

    const available = PERLER_COLORS.filter(c => !excludedColors.has(c.id));
    if (available.length === 0) return;

    const tempConverter = new PindouConverter(available);
    saveHistory();

    currentMatrix = currentMatrix.map(row => row.map(bead => {
        if (excludedColors.has(bead.id)) {
            const rgb = converter.hexToRgb(bead.hex);
            return tempConverter.findBestMatch(rgb[0], rgb[1], rgb[2]);
        }
        return bead;
    }));

    refreshAll();
}

// ==================== BFS 颜色合并 ====================

function mergeSimilarColors(threshold) {
    if (!currentMatrix.length) return;

    const rows = currentMatrix.length;
    const cols = currentMatrix[0].length;
    const visited = Array.from({ length: rows }, () => Array(cols).fill(false));
    const newMatrix = cloneMatrix(currentMatrix);

    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            if (visited[y][x]) continue;

            // BFS 查找连通区域
            const region = [];
            const queue = [[y, x]];
            visited[y][x] = true;
            const baseColor = currentMatrix[y][x];

            while (queue.length > 0) {
                const [cy, cx] = queue.shift();
                region.push([cy, cx]);

                const neighbors = [[cy - 1, cx], [cy + 1, cx], [cy, cx - 1], [cy, cx + 1]];
                for (const [ny, nx] of neighbors) {
                    if (ny >= 0 && ny < rows && nx >= 0 && nx < cols && !visited[ny][nx]) {
                        const dist = colorDistance(currentMatrix[ny][nx], baseColor);
                        if (dist < threshold) {
                            visited[ny][nx] = true;
                            queue.push([ny, nx]);
                        }
                    }
                }
            }

            // 找出区域内出现次数最多的颜色
            const colorCount = {};
            for (const [cy, cx] of region) {
                const cid = currentMatrix[cy][cx].id;
                colorCount[cid] = (colorCount[cid] || 0) + 1;
            }
            let mostFreq = null;
            let maxCount = 0;
            for (const [cid, count] of Object.entries(colorCount)) {
                if (count > maxCount) {
                    maxCount = count;
                    mostFreq = cid;
                }
            }

            // 统一为该区域的主色
            const mostFreqColor = PERLER_COLORS.find(c => c.id === mostFreq);
            if (mostFreqColor && region.length > 1) {
                for (const [cy, cx] of region) {
                    newMatrix[cy][cx] = mostFreqColor;
                }
            }
        }
    }

    saveHistory();
    currentMatrix = newMatrix;
    refreshAll();
}

// ==================== 去除杂色（单像素清理） ====================

function denoiseColors() {
    if (!currentMatrix.length) return;

    const rows = currentMatrix.length;
    const cols = currentMatrix[0].length;
    const newMatrix = cloneMatrix(currentMatrix);
    let changed = 0;

    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            const center = currentMatrix[y][x];

            // 统计 8 个邻居的颜色
            const neighborCount = {};
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (dy === 0 && dx === 0) continue;
                    const ny = y + dy;
                    const nx = x + dx;
                    if (ny >= 0 && ny < rows && nx >= 0 && nx < cols) {
                        const nid = currentMatrix[ny][nx].id;
                        neighborCount[nid] = (neighborCount[nid] || 0) + 1;
                    }
                }
            }

            // 如果中心颜色不在邻居中占主导，替换为最常见的邻居颜色
            const centerCount = neighborCount[center.id] || 0;
            if (centerCount <= 1) {
                let bestNeighbor = null;
                let bestCount = 0;
                for (const [nid, count] of Object.entries(neighborCount)) {
                    if (count > bestCount) {
                        bestCount = count;
                        bestNeighbor = nid;
                    }
                }
                if (bestNeighbor && bestCount >= 3) {
                    const replaceColor = PERLER_COLORS.find(c => c.id === bestNeighbor);
                    if (replaceColor) {
                        newMatrix[y][x] = replaceColor;
                        changed++;
                    }
                }
            }
        }
    }

    if (changed > 0) {
        saveHistory();
        currentMatrix = newMatrix;
        refreshAll();
        console.log('去除杂色：修改了 ' + changed + ' 个像素');
    }
}

// ==================== 自动去背景 ====================

function autoRemoveBackground() {
    if (!currentMatrix.length) return;

    const rows = currentMatrix.length;
    const cols = currentMatrix[0].length;

    // 收集所有边界上出现的颜色作为"背景候选"
    const borderColors = new Set();
    for (let y = 0; y < rows; y++) {
        borderColors.add(currentMatrix[y][0].id);
        borderColors.add(currentMatrix[y][cols - 1].id);
    }
    for (let x = 0; x < cols; x++) {
        borderColors.add(currentMatrix[0][x].id);
        borderColors.add(currentMatrix[rows - 1][x].id);
    }

    // 选出现次数最多的边界颜色作为背景色
    const borderStats = {};
    for (const bid of borderColors) {
        borderStats[bid] = 0;
    }
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            if (borderColors.has(currentMatrix[y][x].id)) {
                borderStats[currentMatrix[y][x].id] = (borderStats[currentMatrix[y][x].id] || 0) + 1;
            }
        }
    }

    let bgColorId = null;
    let bgMax = 0;
    for (const [bid, count] of Object.entries(borderStats)) {
        if (count > bgMax) {
            bgMax = count;
            bgColorId = bid;
        }
    }

    if (!bgColorId) return;

    // 从边界执行洪水填充，标记外部背景
    const visited = Array.from({ length: rows }, () => Array(cols).fill(false));
    const queue = [];

    // 从所有边界开始
    for (let y = 0; y < rows; y++) {
        if (currentMatrix[y][0].id === bgColorId && !visited[y][0]) {
            visited[y][0] = true; queue.push([y, 0]);
        }
        if (currentMatrix[y][cols - 1].id === bgColorId && !visited[y][cols - 1]) {
            visited[y][cols - 1] = true; queue.push([y, cols - 1]);
        }
    }
    for (let x = 0; x < cols; x++) {
        if (currentMatrix[0][x].id === bgColorId && !visited[0][x]) {
            visited[0][x] = true; queue.push([0, x]);
        }
        if (currentMatrix[rows - 1][x].id === bgColorId && !visited[rows - 1][x]) {
            visited[rows - 1][x] = true; queue.push([rows - 1, x]);
        }
    }

    while (queue.length > 0) {
        const [cy, cx] = queue.shift();
        const neighbors = [[cy - 1, cx], [cy + 1, cx], [cy, cx - 1], [cy, cx + 1]];
        for (const [ny, nx] of neighbors) {
            if (ny >= 0 && ny < rows && nx >= 0 && nx < cols && !visited[ny][nx] && currentMatrix[ny][nx].id === bgColorId) {
                visited[ny][nx] = true;
                queue.push([ny, nx]);
            }
        }
    }

    // 将背景色通过洪水填充统一替换为白色
    const white = PERLER_COLORS.find(c => c.hex === '#FFFFFF') || PERLER_COLORS[0];
    const newMatrix = cloneMatrix(currentMatrix);
    let bgChanged = 0;

    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            if (visited[y][x] && currentMatrix[y][x].id === bgColorId) {
                newMatrix[y][x] = white;
                bgChanged++;
            }
        }
    }

    if (bgChanged > 0) {
        saveHistory();
        currentMatrix = newMatrix;
        refreshAll();
        console.log('去背景：替换了 ' + bgChanged + ' 个背景像素');
    }
}

// ==================== 品牌切换 ====================

document.getElementById('brand-select')?.addEventListener('change', (e) => {
    currentBrand = e.target.value;
    // 非 MARD 品牌重置子集为全部
    PERLER_COLORS = buildPalette(currentBrand);
    converter = new PindouConverter(PERLER_COLORS);
    selectedColor = PERLER_COLORS[0];
    // 更新子集下拉菜单
    excludedColors.clear();

    if (currentMatrix.length) {
        currentMatrix = currentMatrix.map(row => row.map(bead => {
            const hex = bead.hex.toUpperCase();
            const mapping = COLOR_SYSTEM_MAPPING[hex];
            const newCode = mapping ? mapping[currentBrand] : null;
            if (newCode && newCode !== '-') {
                const found = PERLER_COLORS.find(c => c.symbol === newCode);
                return found || PERLER_COLORS[0];
            }
            const rgb = converter.hexToRgb(bead.hex);
            const rematch = converter.findBestMatch(rgb[0], rgb[1], rgb[2]);
            return rematch;
        }));
        historyStack = [];
    }

    initPalette();
    refreshAll();
});

// ==================== 智能优化按钮 ====================

document.getElementById('merge-threshold')?.addEventListener('input', (e) => {
    document.getElementById('merge-threshold-val').textContent = e.target.value;
});

document.getElementById('btn-merge')?.addEventListener('click', () => {
    const threshold = parseInt(document.getElementById('merge-threshold').value, 10);
    mergeSimilarColors(threshold);
});

document.getElementById('btn-denoise')?.addEventListener('click', () => {
    denoiseColors();
});

document.getElementById('btn-bg-remove')?.addEventListener('click', () => {
    autoRemoveBackground();
});

document.getElementById('btn-reset-exclude')?.addEventListener('click', () => {
    resetExcluded();
});

// ==================== 模式切换 ====================

document.getElementById('mode-upload').onclick = (e) => switchMode(e, 'upload-section');
document.getElementById('mode-draw').onclick = (e) => switchMode(e, 'draw-section');

function switchMode(e, id) {
    document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.remove('active'));
    e.target.classList.add('active');
    document.getElementById('upload-section').style.display = 'none';
    document.getElementById('draw-section').style.display = 'none';
    document.getElementById(id).style.display = 'block';
}

// ==================== 拖拽上传 ====================

['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, preventDefaults, false);
});

['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, () => dropZone.classList.add('drag-active'), false);
});

['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, () => dropZone.classList.remove('drag-active'), false);
});

dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    if (!dt || !dt.files || dt.files.length === 0) return;
    handleFile(dt.files[0]);
}, false);

fileInput.addEventListener('change', (e) => {
    if (!e.target.files || e.target.files.length === 0) return;
    handleFile(e.target.files[0]);
});

function handleFile(file) {
    if (!file || !file.type.startsWith('image/')) {
        alert('请选择有效的图片文件');
        return;
    }

    const reader = new FileReader();
    reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
            sourceImg = img;
            document.getElementById('upload-controls').style.display = 'flex';
        };
        img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
}

// ==================== 工具按钮 ====================

document.getElementById('tool-undo').onclick = () => {
    if (historyStack.length > 0) {
        currentMatrix = historyStack.pop();
        refreshAll();
    }
};

document.getElementById('tool-pen').onclick = () => {
    currentTool = 'pen';
    updateToolUI();
};

document.getElementById('tool-eraser').onclick = () => {
    currentTool = 'eraser';
    updateToolUI();
};

document.getElementById('tool-hand').onclick = () => {
    currentTool = 'hand';
    updateToolUI();
};

document.getElementById('brush-size').oninput = (e) => {
    brushSize = parseInt(e.target.value, 10);
    document.getElementById('size-val').innerText = brushSize;
};

// ==================== 视图模式 ====================

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

// ==================== 光标 ====================

function updateCursor(e, cellSize) {
    if (currentTool === 'hand') {
        customCursor.style.display = 'none';
        return;
    }

    customCursor.style.display = 'block';
    customCursor.style.left = e.clientX + 'px';
    customCursor.style.top = e.clientY + 'px';

    const size = Math.max(12, brushSize * cellSize);
    customCursor.style.width = size + 'px';
    customCursor.style.height = size + 'px';
}

// ==================== 交互系统 ====================

function setupInteraction(wrapper, canvas, zoomInput, isPattern) {
    wrapper.addEventListener('wheel', (e) => {
        e.preventDefault();
        let val = parseInt(zoomInput.value, 10);
        if (e.deltaY < 0) val = Math.min(60, val + 2);
        else val = Math.max(6, val - 2);
        zoomInput.value = val;
        refreshAll();
        updateCursor(e, val);
    }, { passive: false });

    canvas.addEventListener('mousedown', (e) => {
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

    canvas.addEventListener('mousemove', (e) => {
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
        if (currentTool !== 'hand') document.body.classList.add('draw-mode');
    });

    canvas.addEventListener('mouseleave', () => {
        document.body.classList.remove('draw-mode');
        customCursor.style.display = 'none';
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

    let centerX, centerY;

    if (isPattern) {
        const margin = 20;
        centerX = Math.floor((e.clientX - rect.left - margin) / size);
        centerY = Math.floor((e.clientY - rect.top - margin) / size);
    } else {
        centerX = Math.floor((e.clientX - rect.left) / size);
        centerY = Math.floor((e.clientY - rect.top) / size);
    }

    const offset = Math.floor(brushSize / 2);
    const white = PERLER_COLORS.find(c => c.hex === '#FFFFFF') || PERLER_COLORS[0];

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

// ==================== 生成 ====================

convertBtn.onclick = () => {
    if (!sourceImg) {
        alert('请先上传图片');
        return;
    }

    const w = parseInt(document.getElementById('width-input').value, 10);
    const h = Math.floor(sourceImg.height / sourceImg.width * w);

    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;

    const ctx = off.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sourceImg, 0, 0, w, h);

    currentMatrix = converter.applyDithering(ctx.getImageData(0, 0, w, h), w, h);
    historyStack = [];
    excludedColors.clear();
    initPalette();
    outputArea.style.display = 'block';
    refreshAll();
};

document.getElementById('init-draw-btn').onclick = () => {
    const w = parseInt(document.getElementById('draw-width').value, 10);
    const h = parseInt(document.getElementById('draw-height').value, 10);
    const white = PERLER_COLORS.find(c => c.hex === '#FFFFFF') || PERLER_COLORS[0];

    currentMatrix = Array.from({ length: h }, () => Array.from({ length: w }, () => white));
    historyStack = [];
    excludedColors.clear();
    initPalette();
    outputArea.style.display = 'block';
    refreshAll();
};

// ==================== 预览画布 ====================

function buildPreviewCanvas(mode, cellSize) {
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

// ==================== 图纸画布 ====================

function drawSymbolText(ctx, symbol, cx, cy, cellSize, bgHex, useContrast = true, printFriendly = false) {
    const fs = Math.max(7, Math.min(15, cellSize * 0.28));
    ctx.font = '900 ' + fs + 'px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const textColor = useContrast ? getTextColorByHex(bgHex) : '#111';

    if (!printFriendly) {
        ctx.lineWidth = Math.max(1.2, fs * 0.14);
        ctx.strokeStyle = textColor === '#fff' ? 'rgba(0,0,0,0.65)' : 'rgba(255,255,255,0.9)';
        ctx.strokeText(symbol, cx, cy);
    }

    ctx.fillStyle = textColor;
    ctx.fillText(symbol, cx, cy);
}

function buildPatternCanvas(mode, cellSize, opts = {}) {
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

    if (showGuides) {
        ctx.strokeStyle = 'rgba(220,50,50,0.85)';
        ctx.lineWidth = 1.5;
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

    currentMatrix.forEach((row, y) => {
        row.forEach((bead, x) => {
            const px = startX + x * cellSize;
            const py = startY + y * cellSize;
            const cx = px + cellSize / 2;
            const cy = py + cellSize / 2;

            if (mode === 'grid') {
                ctx.fillStyle = bead.hex;
                ctx.fillRect(px + 1, py + 1, cellSize - 2, cellSize - 2);
                ctx.strokeStyle = '#888';
                ctx.lineWidth = 1;
                ctx.strokeRect(px + 1, py + 1, cellSize - 2, cellSize - 2);
                if (showSymbols) {
                    drawSymbolText(ctx, bead.symbol, cx, cy, cellSize, bead.hex, true);
                }
                return;
            }

            drawBead(ctx, cx, cy, Math.max(2, cellSize * 0.42), bead.hex, !printFriendly);
            if (showSymbols) {
                drawSymbolText(ctx, bead.symbol, cx, cy, cellSize, bead.hex, true, printFriendly);
            }
        });
    });

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
            const bead = PERLER_COLORS.find(c => c.id === id);
            if (!bead) return;

            ctx.fillStyle = bead.hex;
            ctx.fillRect(panelX + 12, listY + 4, 14, 14);
            ctx.strokeStyle = '#bbb';
            ctx.strokeRect(panelX + 12, listY + 4, 14, 14);

            ctx.fillStyle = '#222';
            ctx.font = '13px Arial';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(bead.symbol, panelX + 34, listY + 1);

            ctx.fillStyle = '#666';
            ctx.font = '12px Arial';
            ctx.fillText(currentStats[id] + ' 颗', panelX + 34, listY + 18);

            listY += 36;
        });

        const total = Object.values(currentStats).reduce((sum, n) => sum + n, 0);
        ctx.fillStyle = '#222';
        ctx.font = 'bold 14px Arial';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText('总计: ' + total, panelX + 12, panelY + panelH - 12);
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

    const previewBuilt = buildPreviewCanvas(previewMode, parseInt(previewZoom.value, 10));
    previewCanvas.width = previewBuilt.width;
    previewCanvas.height = previewBuilt.height;
    previewCanvas.getContext('2d').drawImage(previewBuilt, 0, 0);

    const patternBuilt = buildPatternCanvas(patternMode, parseInt(patternZoom.value, 10), {
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

// ==================== 清单（含排除按钮） ====================

function renderList() {
    const tbody = document.querySelector('#bead-list tbody');
    let html = '';
    const entries = Object.entries(currentStats).sort((a, b) => b[1] - a[1]);
    for (const [id, count] of entries) {
        const c = PERLER_COLORS.find(x => x.id === id);
        if (!c) continue;
        const isExcluded = excludedColors.has(id);
        const rowStyle = isExcluded ? ' style="opacity:0.4;text-decoration:line-through;"' : '';
        const btnLabel = isExcluded ? '恢复' : '排除';
        const btnClass = isExcluded ? 'exclude-btn include-action' : 'exclude-btn';
        html += '<tr' + rowStyle + '>' +
            '<td><div style="background:' + c.hex + ';width:22px;height:22px;border-radius:50%;border:1px solid #ddd;"></div></td>' +
            '<td><strong>' + c.symbol + '</strong></td>' +
            '<td>' + c.name + '</td>' +
            '<td><strong>' + count + ' 颗</strong></td>' +
            '<td><button class="' + btnClass + '" data-color-id="' + id + '">' + btnLabel + '</button></td>' +
            '</tr>';
    }
    tbody.innerHTML = html;

    // 绑定排除按钮事件
    tbody.querySelectorAll('.exclude-btn').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            const colorId = btn.dataset.colorId;
            if (excludedColors.has(colorId)) {
                includeColor(colorId);
            } else {
                excludeColor(colorId);
            }
        };
    });
}

// ==================== 调色盘 ====================

function initPalette() {
    paletteContainer.innerHTML = '';
    PERLER_COLORS.forEach(color => {
        const item = document.createElement('div');
        item.className = 'palette-item';
        if (excludedColors.has(color.id)) {
            item.classList.add('excluded');
        }
        item.style.backgroundColor = color.hex;
        item.title = color.symbol + ' - ' + color.name;
        item.dataset.colorId = color.id;
        item.onclick = () => {
            selectedColor = color;
            if (currentTool !== 'pen') {
                currentTool = 'pen';
            }
            updateToolUI();
        };
        paletteContainer.appendChild(item);
    });
    updateToolUI();
}

function updateToolUI() {
    const swatch = document.getElementById('current-color-show');
    if (currentTool === 'eraser') {
        swatch.style.backgroundColor = '#ffffff';
        swatch.style.backgroundImage = 'linear-gradient(135deg, #ccc 25%, transparent 25%, transparent 75%, #ccc 75%)';
        swatch.style.backgroundSize = '8px 8px';
    } else if (currentTool === 'hand') {
        swatch.style.backgroundColor = '#ddd';
        swatch.style.backgroundImage = 'none';
    } else {
        swatch.style.backgroundColor = selectedColor.hex;
        swatch.style.backgroundImage = 'none';
    }

    ['tool-pen', 'tool-eraser', 'tool-hand'].forEach(id => {
        document.getElementById(id).classList.remove('active');
    });
    document.body.classList.remove('draw-mode', 'hand-mode');

    if (currentTool === 'pen') {
        document.getElementById('tool-pen').classList.add('active');
        document.body.classList.add('draw-mode');
    } else if (currentTool === 'eraser') {
        document.getElementById('tool-eraser').classList.add('active');
        document.body.classList.add('draw-mode');
    } else if (currentTool === 'hand') {
        document.getElementById('tool-hand').classList.add('active');
        document.body.classList.add('hand-mode');
    }

    document.querySelectorAll('.palette-item').forEach(el => {
        el.classList.remove('active');
        if (currentTool === 'pen' && el.dataset.colorId === selectedColor.id) {
            el.classList.add('active');
        }
    });
}

// ==================== 标签切换 ====================

document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.onclick = () => {
        document.querySelectorAll('.tab-btn').forEach(x => x.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(x => x.style.display = 'none');
        btn.classList.add('active');
        document.getElementById(btn.dataset.tab).style.display = 'block';
    };
});

// ==================== 导出功能 ====================

document.getElementById('download-btn').onclick = () => {
    if (!currentMatrix.length) return;

    const activeTab = document.querySelector('.tab-btn.active').dataset.tab;
    const opts = getExportOptions();
    let exportCanvas;

    if (activeTab === 'preview-container') {
        exportCanvas = buildPreviewCanvas(previewMode, opts.cellSize);
    } else {
        exportCanvas = buildPatternCanvas(patternMode, opts.cellSize, opts);
    }

    const a = document.createElement('a');
    a.download = 'pindou-design-' + Date.now() + '.png';
    a.href = exportCanvas.toDataURL('image/png');
    a.click();
};

document.getElementById('export-json-btn').onclick = () => {
    if (!currentMatrix.length) return;

    const opts = getExportOptions();
    const payload = {
        version: 5,
        exportedAt: new Date().toISOString(),
        width: currentMatrix[0].length,
        height: currentMatrix.length,
        brand: currentBrand,
        gridSize: opts.gridSize,
        previewMode,
        patternMode,
        stats: currentStats,
        excludedColors: Array.from(excludedColors),
        matrix: currentMatrix.map(row => row.map(bead => ({
            id: bead.id,
            symbol: bead.symbol,
            name: bead.name,
            hex: bead.hex
        })))
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = safeFileName('pindou-design-' + Date.now() + '.json');
    a.click();
    URL.revokeObjectURL(url);
};

document.getElementById('export-svg-btn').onclick = () => {
    if (!currentMatrix.length) return;

    const cell = getExportCellSize();
    const rows = currentMatrix.length;
    const cols = currentMatrix[0].length;
    const width = cols * cell;
    const height = rows * cell;

    let svg = '<?xml version="1.0" encoding="UTF-8"?>\n';
    svg += '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">\n';
    svg += '<rect width="100%" height="100%" fill="#ffffff"/>\n';
    if (previewMode === 'flat') {
        currentMatrix.forEach((row, y) => {
            row.forEach((bead, x) => {
                svg += '<rect x="' + (x * cell) + '" y="' + (y * cell) + '" width="' + cell + '" height="' + cell + '" fill="' + bead.hex + '"/>\n';
            });
        });
    } else if (previewMode === 'pegboard') {
        currentMatrix.forEach((row, y) => {
            row.forEach((bead, x) => {
                const px = x * cell;
                const py = y * cell;
                const pad = Math.max(1, cell * 0.18);
                svg += '<rect x="' + px + '" y="' + py + '" width="' + cell + '" height="' + cell + '" fill="#f7ebdd" stroke="#eadbc8" stroke-width="1"/>\n';
                svg += '<rect x="' + (px + pad) + '" y="' + (py + pad) + '" width="' + (cell - pad * 2) + '" height="' + (cell - pad * 2) + '" fill="' + bead.hex + '"/>\n';
            });
        });
    } else {
        currentMatrix.forEach((row, y) => {
            row.forEach((bead, x) => {
                const cx = x * cell + cell / 2;
                const cy = y * cell + cell / 2;
                const r = cell * 0.42;
                svg += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + bead.hex + '" stroke="rgba(0,0,0,0.18)" stroke-width="1"/>\n';
                svg += '<circle cx="' + (cx - r * 0.28) + '" cy="' + (cy - r * 0.28) + '" r="' + (r * 0.24) + '" fill="rgba(255,255,255,0.26)"/>\n';
                svg += '<circle cx="' + cx + '" cy="' + cy + '" r="' + (r * 0.18) + '" fill="rgba(255,255,255,0.14)"/>\n';
            });
        });
    }
    svg += '</svg>';

    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = safeFileName('pindou-design-' + Date.now() + '.svg');
    a.click();
    URL.revokeObjectURL(url);
};

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
    pdf.save('pindou-design-' + Date.now() + '.pdf');
});

document.getElementById('print-a4-btn')?.addEventListener('click', () => {
    if (!currentMatrix.length) return;

    const opts = getExportOptions();
    const exportCanvas = buildPatternCanvas(patternMode, opts.cellSize, opts);
    const dataUrl = exportCanvas.toDataURL('image/png');

    const printWindow = window.open('', '_blank');
    if (!printWindow) return;

    printWindow.document.write('<html><head><title>拼豆图纸打印</title>' +
        '<style>body{margin:0;padding:0;text-align:center;background:#fff;}img{max-width:100%;height:auto;}@page{size:A4 portrait;margin:10mm;}</style>' +
        '</head><body><img src="' + dataUrl + '" />' +
        '<script>window.onload=function(){window.print();};<\/script></body></html>');

    printWindow.document.close();
});
