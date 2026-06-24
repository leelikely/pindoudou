// ============================================
// 拼豆图片转换核心
// 基于单元格像素聚合 + OKLAB感知色差匹配
// 参考: github.com/Zippland/perler-beads
// 注意：本文件不管理品牌、不管理色库分类，只负责把颜色匹配到传入的 palette
// ============================================

/**
 * 像素化模式
 * - dominant: 卡通模式 — 取单元格内出现最多的颜色（适合卡通/矢量图）
 * - average:  真实模式 — 取单元格内所有像素的平均色（适合照片）
 */
export const PixelationMode = {
    DOMINANT: 'dominant',
    AVERAGE: 'average'
};

export class PindouConverter {
    constructor(palette = []) {
        this.palette = [];
        this.preparedPalette = [];
        this._oklabCache = new Map();
        this.setPalette(palette);
    }

    // ==================== 色板管理 ====================

    setPalette(palette = []) {
        this.palette = Array.isArray(palette) ? palette.slice() : [];
        this.preparedPalette = this._preparePalette(this.palette);
        this._oklabCache.clear();
    }

    _preparePalette(palette) {
        return palette.map(color => {
            const rgb = this.hexToRgb(color.hex);
            const oklab = this._rgbToOklab(rgb[0], rgb[1], rgb[2]);
            return {
                ...color,
                _rgb: rgb,
                _oklab: oklab
            };
        });
    }

    // ==================== 颜色转换工具 ====================

    hexToRgb(hex) {
        if (!hex) return [0, 0, 0];
        const clean = String(hex).replace('#', '').trim();
        if (clean.length !== 6) return [0, 0, 0];
        const num = parseInt(clean, 16);
        return [
            (num >> 16) & 255,
            (num >> 8) & 255,
            num & 255
        ];
    }

    rgbToHex(r, g, b) {
        const toHex = n => {
            return Math.max(0, Math.min(255, Math.round(n)))
                .toString(16)
                .padStart(2, '0');
        };
        return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
    }

    // ==================== OKLAB 颜色空间 ====================
    // OKLAB 是感知均匀的颜色空间，比 CIEDE2000 更简单但效果相当
    // 比 CIE Lab 更精确地反映人眼对颜色的感知差异

    _srgbChannelToLinear(channel) {
        const normalized = channel / 255;
        return normalized <= 0.04045
            ? normalized / 12.92
            : Math.pow((normalized + 0.055) / 1.055, 2.4);
    }

    _rgbToOklab(r, g, b) {
        const lr = this._srgbChannelToLinear(r);
        const lg = this._srgbChannelToLinear(g);
        const lb = this._srgbChannelToLinear(b);

        // 从线性 RGB 到 LMS
        const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
        const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
        const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

        // 立方根映射
        const lRoot = Math.cbrt(l);
        const mRoot = Math.cbrt(m);
        const sRoot = Math.cbrt(s);

        // LMS 到 OKLAB
        return {
            L: 0.2104542553 * lRoot + 0.7936177850 * mRoot - 0.0040720468 * sRoot,
            A: 1.9779984951 * lRoot - 2.4285922050 * mRoot + 0.4505937099 * sRoot,
            B: 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.8086757660 * sRoot
        };
    }

    _getOklabColor(r, g, b) {
        const cacheKey = `${r},${g},${b}`;
        if (this._oklabCache.has(cacheKey)) {
            return this._oklabCache.get(cacheKey);
        }
        const oklab = this._rgbToOklab(r, g, b);
        this._oklabCache.set(cacheKey, oklab);
        return oklab;
    }

    /**
     * 计算两个 RGB 颜色在 OKLAB 空间中的感知距离
     * 乘以100使得阈值范围与现有 UI 的 0-100 范围兼容
     */
    colorDistance(r1, g1, b1, r2, g2, b2) {
        const oklab1 = this._getOklabColor(r1, g1, b1);
        const oklab2 = this._getOklabColor(r2, g2, b2);

        const dL = oklab1.L - oklab2.L;
        const dA = oklab1.A - oklab2.A;
        const dB = oklab1.B - oklab2.B;

        return Math.sqrt(dL * dL + dA * dA + dB * dB) * 100;
    }

    // ==================== 颜色匹配 ====================

    /**
     * 在色板中查找与目标RGB最接近的颜色
     * @returns {Object} 色板中匹配的颜色对象，或 null
     */
    findBestMatch(r, g, b, palette = this.preparedPalette) {
        if (!palette || palette.length === 0) return null;

        const rr = Math.max(0, Math.min(255, r));
        const gg = Math.max(0, Math.min(255, g));
        const bb = Math.max(0, Math.min(255, b));

        // 1. 先检查精确匹配（hex相同）
        const targetHex = this.rgbToHex(rr, gg, bb);
        for (const color of palette) {
            if (String(color.hex).toUpperCase() === targetHex) {
                return color;
            }
        }

        // 2. 在 OKLAB 空间中查找最近的
        const targetOklab = this._getOklabColor(rr, gg, bb);
        let best = palette[0];
        let bestDist = Number.POSITIVE_INFINITY;

        for (const color of palette) {
            const dist = this._oklabDistance(targetOklab, color._oklab);
            if (dist < bestDist) {
                bestDist = dist;
                best = color;
            }
            if (dist === 0) break;
        }

        return best;
    }

    _oklabDistance(oklab1, oklab2) {
        const dL = oklab1.L - oklab2.L;
        const dA = oklab1.A - oklab2.A;
        const dB = oklab1.B - oklab2.B;
        return dL * dL + dA * dA + dB * dB;
    }

    // ==================== 核心：单元格像素聚合 ====================

    /**
     * 计算原图指定单元格区域内的代表色
     * 
     * 这是效果提升的核心函数。不再对每个像素单独匹配拼豆颜色，
     * 而是先把整个单元格内的所有像素聚合为一个代表色，再匹配拼豆。
     * 这样可以自然地消除JPEG噪点、压缩伪影和杂色。
     *
     * @param {ImageData} imageData - 全分辨率原图的ImageData
     * @param {number} startX - 单元格在原图中的起始X坐标
     * @param {number} startY - 单元格在原图中的起始Y坐标
     * @param {number} cellW - 单元格在原图中覆盖的宽度（像素）
     * @param {number} cellH - 单元格在原图中覆盖的高度（像素）
     * @param {string} mode - 'dominant'（主色）或 'average'（平均色）
     * @returns {{r:number, g:number, b:number}|null} 代表色RGB
     */
    _calculateCellRepresentativeColor(imageData, startX, startY, cellW, cellH, mode) {
        const data = imageData.data;
        const imgWidth = imageData.width;
        const endX = startX + cellW;
        const endY = startY + cellH;

        let rSum = 0, gSum = 0, bSum = 0;
        let pixelCount = 0;

        // 主色模式专用统计
        const colorCountMap = new Map();
        let dominantRgb = null;
        let maxCount = 0;

        for (let y = startY; y < endY; y++) {
            for (let x = startX; x < endX; x++) {
                const idx = (y * imgWidth + x) * 4;

                // 忽略透明/半透明像素
                if (data[idx + 3] < 128) continue;

                const r = data[idx];
                const g = data[idx + 1];
                const b = data[idx + 2];

                pixelCount++;

                if (mode === PixelationMode.AVERAGE) {
                    rSum += r;
                    gSum += g;
                    bSum += b;
                } else {
                    // 主色模式：按颜色值统计频次
                    // 将RGB量化到6位（64阶）做近似，避免轻微色差分散统计
                    const qr = r >> 2;  // 256/64 = 4, 即量化到 0-63
                    const qg = g >> 2;
                    const qb = b >> 2;
                    const colorKey = (qr << 12) | (qg << 6) | qb;

                    const count = (colorCountMap.get(colorKey) || 0) + 1;
                    colorCountMap.set(colorKey, count);

                    if (count > maxCount) {
                        maxCount = count;
                        dominantRgb = { r, g, b };
                    }
                }
            }
        }

        if (pixelCount === 0) {
            return null; // 单元格内全透明
        }

        if (mode === PixelationMode.AVERAGE) {
            return {
                r: Math.round(rSum / pixelCount),
                g: Math.round(gSum / pixelCount),
                b: Math.round(bSum / pixelCount)
            };
        }

        return dominantRgb;
    }

    // ==================== 主转换函数（新版） ====================

    /**
     * 像素化转换 — 基于单元格的代表色聚合。
     * 
     * 与原版的区别：
     * - 原版：缩放图像到目标尺寸 → 每个像素独立匹配 → 误差扩散
     * - 新版：使用全分辨率原图 → 每个单元格聚合其覆盖的所有像素 → 无噪点
     *
     * @param {CanvasRenderingContext2D} originalCtx - 加载了全分辨率原图的canvas context
     * @param {number} imgWidth - 原图宽度
     * @param {number} imgHeight - 原图高度
     * @param {number} N - 输出网格横向数量（每行拼豆数）
     * @param {number} M - 输出网格纵向数量（每列拼豆数）
     * @param {Array} palette - 当前色板
     * @param {string} mode - 'dominant' 或 'average'
     * @returns {Array<Array>} M×N 的拼豆颜色矩阵
     */
    pixelate(originalCtx, imgWidth, imgHeight, N, M, palette, mode = PixelationMode.DOMINANT) {
        const preparedPalette = palette && Array.isArray(palette)
            ? this._preparePalette(palette)
            : this.preparedPalette;

        if (!preparedPalette.length) return [];

        // 获取全分辨率图像数据
        let fullImageData;
        try {
            fullImageData = originalCtx.getImageData(0, 0, imgWidth, imgHeight);
        } catch (e) {
            console.error('pixelate: 无法获取全分辨率图像数据', e);
            return [];
        }

        // 每个单元格在原图上的覆盖尺寸
        const cellWidthOriginal = imgWidth / N;
        const cellHeightOriginal = imgHeight / M;

        // 默认用色板第一个颜色作为备用
        const fallback = preparedPalette[0];

        const matrix = Array.from({ length: M }, () => Array(N));

        for (let j = 0; j < M; j++) {
            for (let i = 0; i < N; i++) {
                // 计算单元格在原图中的确切坐标范围
                const startX = Math.floor(i * cellWidthOriginal);
                const startY = Math.floor(j * cellHeightOriginal);
                const endX = Math.min(imgWidth, Math.ceil((i + 1) * cellWidthOriginal));
                const endY = Math.min(imgHeight, Math.ceil((j + 1) * cellHeightOriginal));

                const cellW = Math.max(1, endX - startX);
                const cellH = Math.max(1, endY - startY);

                // ★ 核心步骤：计算单元格代表色
                const representativeRgb = this._calculateCellRepresentativeColor(
                    fullImageData, startX, startY, cellW, cellH, mode
                );

                if (representativeRgb) {
                    // 将代表色匹配到最接近的拼豆色
                    matrix[j][i] = this.findBestMatch(
                        representativeRgb.r,
                        representativeRgb.g,
                        representativeRgb.b,
                        preparedPalette
                    ) || fallback;
                } else {
                    // 单元格全透明 → 使用默认色（白色）
                    matrix[j][i] = fallback;
                }
            }
        }

        return matrix;
    }

    // ==================== 兼容旧版接口 ====================

    /**
     * 兼容旧 app.js 的 convertImageToMatrix 接口。
     * 直接对每个像素做颜色匹配（无聚合），效果较差。
     * 建议使用 pixelate() 替代。
     */
    convertImageToMatrix(imageData, width = imageData.width, height = imageData.height, options = {}) {
        const palette = options.palette && Array.isArray(options.palette)
            ? this._preparePalette(options.palette)
            : this.preparedPalette;

        if (!imageData || !imageData.data || !palette.length) return [];

        const w = width || imageData.width;
        const h = height || imageData.height;
        const data = imageData.data;

        const matrix = Array.from({ length: h }, () => Array(w));

        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const idx = (y * w + x) * 4;
                const r = data[idx];
                const g = data[idx + 1];
                const b = data[idx + 2];
                matrix[y][x] = this.findBestMatch(r, g, b, palette) || palette[0];
            }
        }

        return matrix;
    }

    /**
     * 兼容旧 app.js 的 applyDithering 接口。
     * Floyd-Steinberg 误差扩散，v4版中不再推荐使用。
     * 保留此方法仅用于向后兼容。
     */
    applyDithering(imageData, width = imageData.width, height = imageData.height, options = {}) {
        const palette = options.palette && Array.isArray(options.palette)
            ? this._preparePalette(options.palette)
            : this.preparedPalette;

        if (!imageData || !imageData.data || !palette.length) return [];

        const useDither = options.dither !== false;
        const diffusion = typeof options.diffusion === 'number' ? options.diffusion : 0.28;

        if (!useDither || diffusion <= 0) {
            return this.convertImageToMatrix(imageData, width, height, { palette });
        }

        const w = width || imageData.width;
        const h = height || imageData.height;
        const src = imageData.data;
        const buffer = new Float32Array(src.length);

        for (let i = 0; i < src.length; i++) {
            buffer[i] = src[i];
        }

        const matrix = Array.from({ length: h }, () => Array(w));
        const clamp = v => Math.max(0, Math.min(255, v));
        const idxOf = (x, y) => (y * w + x) * 4;

        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const idx = idxOf(x, y);
                const oldR = clamp(buffer[idx]);
                const oldG = clamp(buffer[idx + 1]);
                const oldB = clamp(buffer[idx + 2]);

                const match = this.findBestMatch(oldR, oldG, oldB, palette) || palette[0];
                matrix[y][x] = match;

                const newR = match._rgb ? match._rgb[0] : this.hexToRgb(match.hex)[0];
                const newG = match._rgb ? match._rgb[1] : this.hexToRgb(match.hex)[1];
                const newB = match._rgb ? match._rgb[2] : this.hexToRgb(match.hex)[2];

                const errR = oldR - newR;
                const errG = oldG - newG;
                const errB = oldB - newB;

                const applyError = (nx, ny, factor) => {
                    if (nx < 0 || nx >= w || ny < 0 || ny >= h) return;
                    const nidx = idxOf(nx, ny);
                    buffer[nidx] += errR * factor * diffusion;
                    buffer[nidx + 1] += errG * factor * diffusion;
                    buffer[nidx + 2] += errB * factor * diffusion;
                };

                applyError(x + 1, y, 7 / 16);
                applyError(x - 1, y + 1, 3 / 16);
                applyError(x, y + 1, 5 / 16);
                applyError(x + 1, y + 1, 1 / 16);
            }
        }

        return matrix;
    }
}
