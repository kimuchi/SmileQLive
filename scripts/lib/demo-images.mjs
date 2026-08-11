/**
 * デモ用の画像を生成する。
 *
 * 第三者の素材を同梱しないため、すべて SVG から自前で描き起こして WebP へ変換する。
 * 絵文字は使わない（カラー絵文字フォントが無い環境では黒い塊になるため）。
 *
 * 会場のプロジェクタで見えることを優先し、
 *   * 背景と図形のコントラストを強く
 *   * 文字は太く大きく
 *   * 1 枚に情報を詰め込まない
 * という方針で作る。
 */
import sharp from 'sharp';

/** 投影を想定した基準サイズ。問題画像は横長、選択肢画像は正方形。 */
export const SIZES = {
  question: { width: 1280, height: 720 },
  choice: { width: 640, height: 640 },
  reveal: { width: 1280, height: 720 },
};

/** 画面全体で使う配色。 */
export const PALETTE = {
  ink: '#0f172a',
  paper: '#f8fafc',
  blue: '#2563eb',
  navy: '#1e3a8a',
  sky: '#38bdf8',
  amber: '#f59e0b',
  rose: '#f43f5e',
  emerald: '#10b981',
  violet: '#8b5cf6',
  teal: '#0d9488',
};

const FONT = "'Noto Sans JP','Hiragino Sans','Yu Gothic',sans-serif";

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 背景。淡いグラデーションに薄い格子を重ね、投影時ののっぺり感を減らす。 */
function background(width, height, from, to) {
  return `
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0.3" y2="1">
        <stop offset="0%" stop-color="${from}"/>
        <stop offset="100%" stop-color="${to}"/>
      </linearGradient>
      <pattern id="grid" width="64" height="64" patternUnits="userSpaceOnUse">
        <path d="M64 0 L0 0 0 64" fill="none" stroke="rgba(255,255,255,0.09)" stroke-width="2"/>
      </pattern>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    <rect width="${width}" height="${height}" fill="url(#grid)"/>`;
}

// ---------------------------------------------------------------------------
// 図版（すべて自前で描く）
// ---------------------------------------------------------------------------

/** 雪をかぶった山。 */
function mountain(cx, cy, scale = 1) {
  const s = (n) => n * scale;
  return `<g transform="translate(${cx},${cy})">
    <polygon points="0,${-s(150)} ${s(210)},${s(120)} ${-s(210)},${s(120)}" fill="#ffffff" opacity="0.95"/>
    <polygon points="0,${-s(150)} ${s(62)},${-s(40)} ${s(30)},${-s(62)} 0,${-s(30)} ${-s(34)},${-s(58)} ${-s(64)},${-s(38)}"
             fill="#e0f2fe"/>
    <polygon points="0,${-s(150)} ${s(210)},${s(120)} ${s(60)},${s(120)}" fill="rgba(15,23,42,0.16)"/>
  </g>`;
}

/** 都道府県の数を表す点の格子。 */
function dotGrid(cx, cy, columns, rows, gap = 46, radius = 15) {
  const cells = [];
  const offsetX = ((columns - 1) * gap) / 2;
  const offsetY = ((rows - 1) * gap) / 2;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      cells.push(
        `<circle cx="${cx - offsetX + column * gap}" cy="${cy - offsetY + row * gap}" r="${radius}" fill="rgba(255,255,255,0.92)"/>`,
      );
    }
  }
  return cells.join('');
}

/** 高さを測る目盛り付きの柱。 */
function measuringColumn(cx, cy, height = 300) {
  const top = cy - height / 2;
  const ticks = Array.from({ length: 7 }, (_, i) => {
    const y = top + (height / 6) * i;
    const long = i % 2 === 0;
    return `<line x1="${cx + 46}" y1="${y}" x2="${cx + (long ? 108 : 82)}" y2="${y}"
                  stroke="rgba(255,255,255,0.85)" stroke-width="${long ? 8 : 5}" stroke-linecap="round"/>`;
  }).join('');
  return `<g>
    <rect x="${cx - 46}" y="${top}" width="92" height="${height}" rx="16" fill="rgba(255,255,255,0.92)"/>
    ${ticks}
    <polygon points="${cx - 46},${top} ${cx},${top - 62} ${cx + 46},${top}" fill="#ffffff"/>
  </g>`;
}

/** 2 地点を結ぶ経路。距離の問題に使う。 */
function routeLine(cx, cy, span = 380) {
  const left = cx - span / 2;
  const right = cx + span / 2;
  return `<g>
    <path d="M ${left} ${cy} Q ${cx} ${cy - 140} ${right} ${cy}"
          fill="none" stroke="rgba(255,255,255,0.9)" stroke-width="10"
          stroke-linecap="round" stroke-dasharray="26 22"/>
    <circle cx="${left}" cy="${cy}" r="34" fill="#ffffff"/>
    <circle cx="${left}" cy="${cy}" r="15" fill="${PALETTE.rose}"/>
    <circle cx="${right}" cy="${cy}" r="34" fill="#ffffff"/>
    <circle cx="${right}" cy="${cy}" r="15" fill="${PALETTE.blue}"/>
  </g>`;
}

/** 面積の大小を表す入れ子の四角。 */
function nestedSquares(cx, cy) {
  return `<g>
    <rect x="${cx - 200}" y="${cy - 150}" width="400" height="300" rx="24" fill="rgba(255,255,255,0.95)"/>
    <rect x="${cx - 120}" y="${cy - 90}" width="200" height="150" rx="16" fill="rgba(37,99,235,0.30)"/>
    <rect x="${cx - 50}" y="${cy - 34}" width="86" height="64" rx="10" fill="rgba(15,23,42,0.35)"/>
  </g>`;
}

const ILLUSTRATIONS = {
  mountain,
  nestedSquares,
  dotGrid: (cx, cy) => dotGrid(cx, cy, 9, 6),
  measuringColumn,
  routeLine,
};

async function toWebp(svg) {
  return sharp(Buffer.from(svg)).webp({ quality: 88 }).toBuffer({ resolveWithObject: true });
}

/**
 * 問題画像。図版を上、見出しを下に置く。
 *
 * @param {{title: string, subtitle?: string, from: string, to: string,
 *          illustration?: keyof typeof ILLUSTRATIONS}} input
 */
export async function questionImage({ title, subtitle = '', from, to, illustration }) {
  const { width, height } = SIZES.question;
  const art = illustration ? ILLUSTRATIONS[illustration](width / 2, height / 2 - 70) : '';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    ${background(width, height, from, to)}
    ${art}
    <text x="${width / 2}" y="${height - 150}" font-family="${FONT}"
          font-size="70" font-weight="700" fill="#ffffff" text-anchor="middle">${escapeXml(title)}</text>
    ${
      subtitle
        ? `<text x="${width / 2}" y="${height - 84}" font-family="${FONT}"
             font-size="36" fill="rgba(255,255,255,0.86)" text-anchor="middle">${escapeXml(subtitle)}</text>`
        : ''
    }
  </svg>`;
  return toWebp(svg);
}

/**
 * 図形だけの選択肢画像。
 * 文章を持たない選択肢の例として使う（代替テキストが必須になる）。
 *
 * @param {'triangle'|'square'|'circle'|'star'} shape
 */
export async function shapeChoiceImage(shape, color) {
  const { width, height } = SIZES.choice;
  const cx = width / 2;
  const cy = height / 2;
  const r = 195;

  const shapes = {
    // 正三角形（外接円の半径 r）。
    triangle: `<polygon points="${[0, 1, 2]
      .map((i) => {
        const angle = -Math.PI / 2 + (i * 2 * Math.PI) / 3;
        return `${(cx + r * Math.cos(angle)).toFixed(1)},${(cy + r * Math.sin(angle)).toFixed(1)}`;
      })
      .join(' ')}" fill="${color}"/>`,
    square: `<rect x="${cx - r * 0.78}" y="${cy - r * 0.78}" width="${r * 1.56}" height="${r * 1.56}" rx="18" fill="${color}"/>`,
    circle: `<circle cx="${cx}" cy="${cy}" r="${r * 0.86}" fill="${color}"/>`,
    // 五芒星。
    star: `<polygon points="${Array.from({ length: 10 }, (_, i) => {
      const angle = -Math.PI / 2 + (i * Math.PI) / 5;
      const radius = i % 2 === 0 ? r : r * 0.44;
      return `${(cx + radius * Math.cos(angle)).toFixed(1)},${(cy + radius * Math.sin(angle)).toFixed(1)}`;
    }).join(' ')}" fill="${color}"/>`,
  };

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#ffffff"/>
    <rect x="14" y="14" width="${width - 28}" height="${height - 28}" rx="30" fill="${PALETTE.paper}" stroke="#e2e8f0" stroke-width="5"/>
    ${shapes[shape]}
  </svg>`;
  return toWebp(svg);
}

/**
 * 正解発表用の画像。答えを大きく見せる。
 *
 * @param {{answer: string, note?: string, color: string}} input
 */
export async function revealImage({ answer, note = '', color }) {
  const { width, height } = SIZES.reveal;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    ${background(width, height, color, PALETTE.ink)}
    <circle cx="${width / 2}" cy="${height / 2 - 20}" r="250" fill="rgba(255,255,255,0.10)"/>
    <text x="${width / 2}" y="${height / 2 - 20}" font-family="${FONT}" font-size="130" font-weight="800"
          fill="#ffffff" text-anchor="middle" dominant-baseline="central">${escapeXml(answer)}</text>
    ${
      note
        ? `<text x="${width / 2}" y="${height - 110}" font-family="${FONT}"
             font-size="42" fill="rgba(255,255,255,0.92)" text-anchor="middle">${escapeXml(note)}</text>`
        : ''
    }
  </svg>`;
  return toWebp(svg);
}
