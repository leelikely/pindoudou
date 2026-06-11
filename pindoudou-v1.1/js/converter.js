export class PindouConverter {
    constructor(palette) {
        this.palette = palette.map(c => ({
            ...c, lab: this.rgbToLab(...this.hexToRgb(c.hex))
        }));
    }
    hexToRgb(hex) {
        const b = parseInt(hex.replace('#', ''), 16);
        return [(b >> 16) & 255, (b >> 8) & 255, b & 255];
    }
    rgbToLab(r, g, b) {
        let [rn, gn, bn] = [r/255, g/255, b/255].map(v => v > 0.04045 ? Math.pow((v+0.055)/1.055, 2.4) : v/12.92);
        let x = (rn * 0.4124 + gn * 0.3576 + bn * 0.1805) / 0.95047;
        let y = (rn * 0.2126 + gn * 0.7152 + bn * 0.0722) / 1.00000;
        let z = (rn * 0.0193 + gn * 0.1192 + bn * 0.9505) / 1.08883;
        [x, y, z] = [x, y, z].map(v => v > 0.008856 ? Math.pow(v, 1/3) : (7.787 * v) + 16/116);
        return [(116 * y) - 16, 500 * (x - y), 200 * (y - z)];
    }
    findBestMatch(r, g, b) {
        const lab = this.rgbToLab(r, g, b);
        let min = Infinity, best = this.palette[0];
        for (const c of this.palette) {
            const d = Math.sqrt(Math.pow(lab[0]-c.lab[0],2) + Math.pow(lab[1]-c.lab[1],2) + Math.pow(lab[2]-c.lab[2],2));
            if (d < min) { min = d; best = c; }
        }
        return best;
    }
    applyDithering(imgData, w, h) {
        const data = new Float32Array(imgData.data);
        const matrix = [];
        for (let y = 0; y < h; y++) {
            const row = [];
            for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 4;
                const match = this.findBestMatch(data[i], data[i+1], data[i+2]);
                row.push(match);
                const rgb = this.hexToRgb(match.hex);
                const err = [data[i]-rgb[0], data[i+1]-rgb[1], data[i+2]-rgb[2]];
                this.distErr(data, x+1, y, w, h, err, 7/16);
                this.distErr(data, x-1, y+1, w, h, err, 3/16);
                this.distErr(data, x, y+1, w, h, err, 5/16);
                this.distErr(data, x+1, y+1, w, h, err, 1/16);
            }
            matrix.push(row);
        }
        return matrix;
    }
    distErr(data, x, y, w, h, err, weight) {
        if (x<0 || x>=w || y<0 || y>=h) return;
        const i = (y * w + x) * 4;
        data[i] += err[0] * weight; data[i+1] += err[1] * weight; data[i+2] += err[2] * weight;
    }
}
