export function rgbaToYuv420(rgba, width, height) {
    const ySize = width * height;
    const uvWidth = width >> 1;
    const uvHeight = height >> 1;
    const uvSize = uvWidth * uvHeight;

    const y = new Uint8Array(ySize);
    const u = new Uint8Array(uvSize);
    const v = new Uint8Array(uvSize);

    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            const rgbaIdx = (row * width + col) * 4;
            const r = rgba[rgbaIdx];
            const g = rgba[rgbaIdx + 1];
            const b = rgba[rgbaIdx + 2];

            y[row * width + col] = clamp((66 * r + 129 * g + 25 * b + 128 >> 8) + 16);

            if ((row & 1) === 0 && (col & 1) === 0) {
                const uvIdx = (row >> 1) * uvWidth + (col >> 1);
                u[uvIdx] = clamp((-38 * r - 74 * g + 112 * b + 128 >> 8) + 128);
                v[uvIdx] = clamp((112 * r - 94 * g - 18 * b + 128 >> 8) + 128);
            }
        }
    }

    return { y, u, v };
}

function clamp(val) {
    return val < 0 ? 0 : val > 255 ? 255 : val;
}
