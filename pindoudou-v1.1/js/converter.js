// ============================================
// 拼豆图片转换核心
// CIEDE2000 色差匹配 + 低强度误差扩散
// 注意：本文件不管理品牌、不管理色库分类，只负责把颜色匹配到传入的 palette
// ============================================

export class PindouConverter {
    constructor(palette = []) {
        this.palette = [];
        this.preparedPalette = [];
        this.setPalette(palette);
    }

    setPalette(palette = []) {
        this.palette = Array.isArray(palette) ? palette.slice() : [];
        this.preparedPalette = this._preparePalette(this.palette);
    }

    _preparePalette(palette) {
        return palette.map(color => {
            const rgb = this.hexToRgb(color.hex);
            return {
                ...color,
                _rgb: rgb,
                _lab: this.rgbToLab(rgb[0], rgb[1], rgb[2])
            };
        });
    }

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

    rgbToXyz(r, g, b) {
        let rr = r / 255;
        let gg = g / 255;
        let bb = b / 255;

        rr = rr > 0.04045 ? Math.pow((rr + 0.055) / 1.055, 2.4) : rr / 12.92;
        gg = gg > 0.04045 ? Math.pow((gg + 0.055) / 1.055, 2.4) : gg / 12.92;
        bb = bb > 0.04045 ? Math.pow((bb + 0.055) / 1.055, 2.4) : bb / 12.92;

        return [
            rr * 0.4124 + gg * 0.3576 + bb * 0.1805,
            rr * 0.2126 + gg * 0.7152 + bb * 0.0722,
            rr * 0.0193 + gg * 0.1192 + bb * 0.9505
        ];
    }

    rgbToLab(r, g, b) {
        const [x, y, z] = this.rgbToXyz(r, g, b);

        const refX = 0.95047;
        const refY = 1.00000;
        const refZ = 1.08883;

        const fx = this._pivotLab(x / refX);
        const fy = this._pivotLab(y / refY);
        const fz = this._pivotLab(z / refZ);

        return [
            116 * fy - 16,
            500 * (fx - fy),
            200 * (fy - fz)
        ];
    }

    _pivotLab(t) {
        return t > 0.008856
            ? Math.cbrt(t)
            : (7.787 * t) + (16 / 116);
    }

    _degToRad(deg) {
        return (deg * Math.PI) / 180;
    }

    _radToDeg(rad) {
        return (rad * 180) / Math.PI;
    }

    _hpF(b, a) {
        if (a === 0 && b === 0) return 0;

        const angle = this._radToDeg(Math.atan2(b, a));
        return angle >= 0 ? angle : angle + 360;
    }

    ciede2000(lab1, lab2) {
        const [L1, a1, b1] = lab1;
        const [L2, a2, b2] = lab2;

        const avgLp = (L1 + L2) / 2;

        const c1 = Math.sqrt(a1 * a1 + b1 * b1);
        const c2 = Math.sqrt(a2 * a2 + b2 * b2);
        const avgC = (c1 + c2) / 2;

        const pow7 = Math.pow(25, 7);
        const G = 0.5 * (1 - Math.sqrt(Math.pow(avgC, 7) / (Math.pow(avgC, 7) + pow7)));

        const a1p = (1 + G) * a1;
        const a2p = (1 + G) * a2;

        const c1p = Math.sqrt(a1p * a1p + b1 * b1);
        const c2p = Math.sqrt(a2p * a2p + b2 * b2);

        const avgCp = (c1p + c2p) / 2;

        const h1p = this._hpF(b1, a1p);
        const h2p = this._hpF(b2, a2p);

        let deltahp;

        if (c1p * c2p === 0) {
            deltahp = 0;
        } else if (Math.abs(h1p - h2p) <= 180) {
            deltahp = h2p - h1p;
        } else if (h2p <= h1p) {
            deltahp = h2p - h1p + 360;
        } else {
            deltahp = h2p - h1p - 360;
        }

        const deltaLp = L2 - L1;
        const deltaCp = c2p - c1p;
        const deltaHp = 2 * Math.sqrt(c1p * c2p) * Math.sin(this._degToRad(deltahp / 2));

        let avgHp;

        if (c1p * c2p === 0) {
            avgHp = h1p + h2p;
        } else if (Math.abs(h1p - h2p) <= 180) {
            avgHp = (h1p + h2p) / 2;
        } else if (h1p + h2p < 360) {
            avgHp = (h1p + h2p + 360) / 2;
        } else {
            avgHp = (h1p + h2p - 360) / 2;
        }

        const T =
            1 -
            0.17 * Math.cos(this._degToRad(avgHp - 30)) +
            0.24 * Math.cos(this._degToRad(2 * avgHp)) +
            0.32 * Math.cos(this._degToRad(3 * avgHp + 6)) -
            0.20 * Math.cos(this._degToRad(4 * avgHp - 63));

        const deltaTheta = 30 * Math.exp(-Math.pow((avgHp - 275) / 25, 2));
        const Rc = 2 * Math.sqrt(Math.pow(avgCp, 7) / (Math.pow(avgCp, 7) + pow7));

        const Sl = 1 + ((0.015 * Math.pow(avgLp - 50, 2)) / Math.sqrt(20 + Math.pow(avgLp - 50, 2)));
        const Sc = 1 + 0.045 * avgCp;
        const Sh = 1 + 0.015 * avgCp * T;

        const Rt = -Math.sin(this._degToRad(2 * deltaTheta)) * Rc;

        const dL = deltaLp / Sl;
        const dC = deltaCp / Sc;
        const dH = deltaHp / Sh;

        return Math.sqrt(
            dL * dL +
            dC * dC +
            dH * dH +
            Rt * dC * dH
        );
    }

    findBestMatch(r, g, b, palette = this.preparedPalette) {
        if (!palette || palette.length === 0) return null;

        const rr = Math.max(0, Math.min(255, r));
        const gg = Math.max(0, Math.min(255, g));
        const bb = Math.max(0, Math.min(255, b));

        const hex = this.rgbToHex(rr, gg, bb);

        for (const color of palette) {
            if (String(color.hex).toUpperCase() === hex) {
                return color;
            }
        }

        const lab = this.rgbToLab(rr, gg, bb);

        let best = palette[0];
        let bestDist = Number.POSITIVE_INFINITY;

        for (const color of palette) {
            const dist = this.ciede2000(
                lab,
                color._lab || this.rgbToLab(...this.hexToRgb(color.hex))
            );

            if (dist < bestDist) {
                bestDist = dist;
                best = color;
            }
        }

        return best;
    }

    /**
     * 无强抖动转换：更清晰、更稳定，不会糊
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
     * 兼容旧 app.js 的接口。
     * 默认使用低强度误差扩散，减少噪点，但保留一点细节。
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

                const [newR, newG, newB] = match._rgb || this.hexToRgb(match.hex);

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
