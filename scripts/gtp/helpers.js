// ============================================================
// helpers.js — Builder toolkit cho Giáo trình Python (docx)
// Palette DM-1 (Deep Cyan) · Cover recipe R4 (Top Color Block)
// ============================================================
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  ImageRun, PageBreak, Header, Footer, PageNumber, NumberFormat,
  AlignmentType, HeadingLevel, WidthType, BorderStyle, ShadingType,
  PageOrientation, TabStopType, TabStopPosition, LevelFormat,
  TableOfContents, SectionType, TableLayoutType, VerticalAlign,
} = require("docx");

// ---------- Palette (DM-1 — Deep Cyan, darkened variants cho trang trắng) ----------
const PAL = {
  primary: "162235",        // xanh navy đậm — tiêu đề chương
  body: "1F2A38",           // gần đen dịu — thân bài
  secondary: "5B6B7D",      // xám trung — chú thích
  accent: "1B6B7A",         // teal đậm — nhấn, viền bảng, caption
  accentBright: "37DCF2",   // cyan sáng — CHỈ dùng trên cover nền tối
  coverBg: "162235",
  surface: "EDF3F5",        // nền xen kẽ hàng bảng
  codeBg: "F4F8FA",         // nền khối mã
  codeBorder: "C8DDE2",     // viền khối mã
  codeText: "233240",       // màu chữ mã
  inlineCode: "0E6E7E",     // màu inline code
  gray: "888888",
  // callout variants
  noteFill: "EDF3F5", noteEdge: "1B6B7A", noteTitle: "14525E",
  tipFill: "ECF6F0", tipEdge: "2A7A65", tipTitle: "1E6A52",
  warnFill: "FDF6E9", warnEdge: "C08A3E", warnTitle: "8A5A18",
};

// ---------- Fonts ----------
const F = {
  body: { ascii: "Calibri", hAnsi: "Calibri", eastAsia: "Microsoft YaHei" },
  head: { ascii: "Calibri", hAnsi: "Calibri", eastAsia: "Microsoft YaHei" },
  code: { ascii: "Consolas", hAnsi: "Consolas", eastAsia: "Microsoft YaHei" },
  cover: { ascii: "Arial", hAnsi: "Arial", eastAsia: "Microsoft YaHei" },
};

// ---------- Borders ----------
const noBorder = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };
const allNoBorders = {
  top: noBorder, bottom: noBorder, left: noBorder, right: noBorder,
  insideHorizontal: noBorder, insideVertical: noBorder,
};
const hairline = (color, size = 2) => ({ style: BorderStyle.SINGLE, size, color });

function emptyPara() {
  return new Paragraph({ spacing: { before: 0, after: 0, line: 240 }, children: [] });
}

// ---------- Inline segment renderer ----------
// segment: string | {c: "code"} | {b: "bold"} | {i: "italic"}
//          | {t: "text", color, bold, italics, font} | TextRun (pass-through)
function runs(segs, base = {}) {
  const out = [];
  const list = Array.isArray(segs) ? segs : [segs];
  for (const s of list) {
    if (s == null) continue;
    if (typeof s === "string") {
      out.push(new TextRun({ text: s, size: base.size ?? 24, color: base.color ?? PAL.body, font: base.font ?? F.body, bold: base.bold }));
      continue;
    }
    if (s instanceof TextRun) { out.push(s); continue; }
    if (s.c !== undefined) {
      out.push(new TextRun({ text: s.c, size: base.size ? base.size - 2 : 22, color: PAL.inlineCode, font: F.code, bold: s.bold }));
      continue;
    }
    if (s.b !== undefined) {
      out.push(new TextRun({ text: s.b, size: base.size ?? 24, color: base.color ?? PAL.body, font: base.font ?? F.body, bold: true }));
      continue;
    }
    if (s.i !== undefined) {
      out.push(new TextRun({ text: s.i, size: base.size ?? 24, color: base.color ?? PAL.secondary, font: base.font ?? F.body, italics: true }));
      continue;
    }
    if (s.t !== undefined) {
      out.push(new TextRun({ text: s.t, size: base.size ?? 24, color: s.color ?? base.color ?? PAL.body, bold: s.bold, italics: s.italics, font: s.font ?? base.font ?? F.body }));
      continue;
    }
  }
  return out;
}

// ---------- Headings (phải dùng HeadingLevel để TOC bắt được) ----------
function h1(text, opts = {}) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    pageBreakBefore: opts.pageBreak !== false,
    alignment: AlignmentType.LEFT,
    spacing: { before: opts.pageBreak === false ? 120 : 360, after: 200, line: 312 },
    children: [new TextRun({ text, bold: true, size: 32, color: PAL.primary, font: F.head })],
  });
}
function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 300, after: 140, line: 312 },
    children: [new TextRun({ text, bold: true, size: 27, color: PAL.primary, font: F.head })],
  });
}
function h3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 240, after: 120, line: 312 },
    children: [new TextRun({ text, bold: true, size: 24, color: PAL.accent, font: F.head })],
  });
}

// ---------- Body paragraph ----------
function p(segs, opts = {}) {
  return new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    indent: opts.noIndent ? undefined : { firstLine: 360 },
    spacing: { before: opts.before ?? 0, after: opts.after ?? 120, line: 312 },
    children: runs(segs, opts.base),
  });
}
// đoạn dẫn không thụt đầu dòng
function lead(segs, opts = {}) {
  return p(segs, { ...opts, noIndent: true });
}

// ---------- Bullet list ----------
function bullets(items) {
  return items.map((it) => new Paragraph({
    bullet: { level: 0 },
    alignment: AlignmentType.JUSTIFIED,
    spacing: { after: 80, line: 312 },
    children: runs(it),
  }));
}

// ---------- Numbered list ----------
function numberedList(reference, items) {
  return items.map((it) => new Paragraph({
    numbering: { reference, level: 0 },
    alignment: AlignmentType.JUSTIFIED,
    spacing: { after: 80, line: 312 },
    children: runs(it),
  }));
}

// ---------- Counters per chapter ----------
function makeCounters(chapterNo) {
  const st = { vi: 0, bang: 0 };
  return {
    nextVi() { st.vi += 1; return `Ví dụ ${chapterNo}.${st.vi}`; },
    nextBang() { st.bang += 1; return `Bảng ${chapterNo}.${st.bang}`; },
  };
}

// ---------- Code block (bảng 1 ô, viền trái teal, nền nhạt, Consolas) ----------
function codeBlock(caption, lines, opts = {}) {
  const out = [];
  if (caption) {
    out.push(new Paragraph({
      keepNext: true,
      spacing: { before: 200, after: 60, line: 312 },
      children: [
        new TextRun({ text: opts.label ?? "Ví dụ", bold: true, size: 21, color: PAL.accent, font: F.head }),
        new TextRun({ text: ` — ${caption}`, size: 21, color: PAL.secondary, font: F.head }),
      ],
    }));
  }
  const codeParas = lines.map((line) => new Paragraph({
    spacing: { before: 0, after: 0, line: 312 },
    children: [new TextRun({ text: line.length ? line : " ", size: 19, color: PAL.codeText, font: F.code })],
  }));
  const cantSplit = lines.length <= 14;
  out.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: {
      top: hairline(PAL.codeBorder), bottom: hairline(PAL.codeBorder),
      right: hairline(PAL.codeBorder),
      left: { style: BorderStyle.SINGLE, size: 12, color: PAL.accent },
      insideHorizontal: noBorder, insideVertical: noBorder,
    },
    rows: [new TableRow({
      cantSplit,
      children: [new TableCell({
        shading: { type: ShadingType.CLEAR, fill: PAL.codeBg },
        margins: { top: 110, bottom: 110, left: 180, right: 120 },
        width: { size: 100, type: WidthType.PERCENTAGE },
        children: codeParas,
      })],
    })],
  }));
  // spacer sau khối mã (tránh 2 bảng dính nhau)
  out.push(new Paragraph({ spacing: { before: 0, after: 60, line: 240 }, children: [] }));
  return out;
}

// ---------- Callout box ----------
const CALLOUT_STYLES = {
  note: { fill: PAL.noteFill, edge: PAL.noteEdge, title: PAL.noteTitle, label: "GHI NHỚ" },
  tip: { fill: PAL.tipFill, edge: PAL.tipEdge, title: PAL.tipTitle, label: "MẸO" },
  warn: { fill: PAL.warnFill, edge: PAL.warnEdge, title: PAL.warnTitle, label: "LƯU Ý" },
};
function callout(kind, title, paraSegs) {
  const st = CALLOUT_STYLES[kind] ?? CALLOUT_STYLES.note;
  const content = Array.isArray(paraSegs) && paraSegs.length && Array.isArray(paraSegs[0])
    ? paraSegs
    : [paraSegs];
  const paras = [
    new Paragraph({
      spacing: { before: 0, after: 60, line: 312 },
      children: [new TextRun({ text: title ? `${st.label} — ${title}` : st.label, bold: true, size: 22, color: st.title, font: F.head })],
    }),
    ...content.map((segs, i) => new Paragraph({
      alignment: AlignmentType.JUSTIFIED,
      spacing: { after: i === content.length - 1 ? 0 : 60, line: 312 },
      children: runs(segs, { size: 22 }),
    })),
  ];
  return [
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      layout: TableLayoutType.FIXED,
      borders: {
        top: hairline(st.edge, 2), bottom: hairline(st.edge, 2), right: hairline(st.edge, 2),
        left: { style: BorderStyle.SINGLE, size: 12, color: st.edge },
        insideHorizontal: noBorder, insideVertical: noBorder,
      },
      rows: [new TableRow({
        cantSplit: true,
        children: [new TableCell({
          shading: { type: ShadingType.CLEAR, fill: st.fill },
          margins: { top: 110, bottom: 110, left: 180, right: 140 },
          width: { size: 100, type: WidthType.PERCENTAGE },
          children: paras,
        })],
      })],
    }),
    new Paragraph({ spacing: { before: 0, after: 60, line: 240 }, children: [] }),
  ];
}

// ---------- Data table ----------
function dataTable(caption, headers, rowsData, colWidths, opts = {}) {
  const out = [];
  if (caption) {
    out.push(new Paragraph({
      keepNext: true,
      spacing: { before: 200, after: 60, line: 312 },
      children: [new TextRun({ text: caption, bold: true, size: 21, color: PAL.primary, font: F.head })],
    }));
  }
  const widths = colWidths ?? headers.map(() => Math.floor(100 / headers.length));
  const headerRow = new TableRow({
    tableHeader: true,
    cantSplit: true,
    children: headers.map((htext, i) => new TableCell({
      shading: { type: ShadingType.CLEAR, fill: PAL.accent },
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      width: { size: widths[i], type: WidthType.PERCENTAGE },
      children: [new Paragraph({
        spacing: { before: 0, after: 0, line: 312 },
        alignment: opts.headerAlign ?? AlignmentType.LEFT,
        children: runs(htext, { size: 20, color: "FFFFFF", bold: true }),
      })],
    })),
  });
  const dataRows = rowsData.map((row, r) => new TableRow({
    cantSplit: true,
    children: row.map((cell, i) => new TableCell({
      shading: { type: ShadingType.CLEAR, fill: r % 2 === 1 ? PAL.surface : "FFFFFF" },
      margins: { top: 70, bottom: 70, left: 120, right: 120 },
      width: { size: widths[i], type: WidthType.PERCENTAGE },
      children: [new Paragraph({
        spacing: { before: 0, after: 0, line: 312 },
        children: runs(cell, { size: 20 }),
      })],
    })),
  }));
  out.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: {
      top: hairline(PAL.accent, 4), bottom: hairline(PAL.accent, 4),
      left: noBorder, right: noBorder,
      insideHorizontal: hairline("D9E4E8", 2), insideVertical: hairline("D9E4E8", 2),
    },
    rows: [headerRow, ...dataRows],
  }));
  out.push(new Paragraph({ spacing: { before: 0, after: 60, line: 240 }, children: [] }));
  return out;
}

// ---------- Exercises ----------
function exercises(reference, items) {
  const out = [];
  for (const it of items) {
    out.push(new Paragraph({
      numbering: { reference, level: 0 },
      alignment: AlignmentType.JUSTIFIED,
      spacing: { after: it.hint ? 40 : 120, line: 312 },
      children: [
        ...(it.title ? [new TextRun({ text: `${it.title}. `, bold: true, size: 24, color: PAL.primary, font: F.body })] : []),
        ...runs(it.segs),
      ],
    }));
    if (it.hint) {
      out.push(new Paragraph({
        alignment: AlignmentType.JUSTIFIED,
        indent: { left: 720 },
        spacing: { after: 120, line: 312 },
        children: [
          new TextRun({ text: "Gợi ý: ", bold: true, italics: true, size: 22, color: PAL.secondary, font: F.body }),
          ...runs(it.hint, { size: 22 }),
        ],
      }));
    }
  }
  return out;
}

// ============================================================
// COVER — Recipe R4 (Top Color Block) · width-aware cho tiêu đề Latin
// ============================================================
function estimateTextWidth(text, pt) {
  let w = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    const isCJK = (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f) || (code >= 0xff00 && code <= 0xffef);
    w += isCJK ? pt * 20 : pt * 11; // Latin ~0.55em trung bình (chữ hoa + bold)
  }
  return w;
}
function splitTitleLinesLatin(title, maxWidthTwips, pt) {
  const words = title.split(/\s+/);
  const lines = [];
  let cur = "";
  for (const wd of words) {
    const trial = cur ? `${cur} ${wd}` : wd;
    if (estimateTextWidth(trial, pt) <= maxWidthTwips || !cur) cur = trial;
    else { lines.push(cur); cur = wd; }
  }
  if (cur) lines.push(cur);
  // chống orphan: dòng cuối 1 từ ngắn → gộp lên
  if (lines.length > 1 && lines[lines.length - 1].length <= 4) {
    const last = lines.pop();
    lines[lines.length - 1] += ` ${last}`;
  }
  return lines;
}
function calcTitleLayout(title, maxWidthTwips, preferredPt = 40, minPt = 24) {
  let titlePt = preferredPt;
  let lines = [title];
  while (titlePt >= minPt) {
    lines = splitTitleLinesLatin(title, maxWidthTwips, titlePt);
    if (lines.length <= 3) break;
    titlePt -= 2;
  }
  return { titlePt, titleLines: lines };
}

function buildCoverR4(config) {
  const P = config.palette;
  const padL = 1200, padR = 800;
  const availableWidth = 11906 - padL - padR;

  const { titlePt, titleLines } = calcTitleLayout(config.title, availableWidth, 40, 26);
  const titleSize = titlePt * 2;

  // Height budget cho khối tối phía trên — động theo nội dung
  const titleBlockHeight = titleLines.length * (titlePt * 23 + 200);
  const englishLabelH = config.englishLabel ? (9 * 23 + 500) : 0;
  const subtitleH = config.subtitle ? (12 * 23 + 200) : 0;
  const upperContentH = englishLabelH + titleBlockHeight + subtitleH;
  const UPPER_MIN = 7500;
  const UPPER_H = Math.max(UPPER_MIN, upperContentH + 1500 + 800);
  const DIVIDER_H = 60;

  const contentEstimate = englishLabelH + titleBlockHeight + subtitleH;
  const spacerIntrinsic = 280;
  const topSpacing = Math.max(UPPER_H - contentEstimate - spacerIntrinsic - 800, 400);

  const upperBlock = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: allNoBorders,
    rows: [new TableRow({
      height: { value: UPPER_H, rule: "exact" },
      children: [new TableCell({
        shading: { type: ShadingType.CLEAR, fill: P.bg },
        borders: noBorders,
        verticalAlign: VerticalAlign.TOP,
        margins: { left: padL, right: padR },
        children: [
          new Paragraph({ spacing: { before: topSpacing } }),
          config.englishLabel ? new Paragraph({
            spacing: { after: 500, line: 320, lineRule: "atLeast" },
            children: [new TextRun({
              text: config.englishLabel.split("").join(" "),
              size: 18, color: P.accent, font: { ascii: "Calibri", hAnsi: "Calibri" }, characterSpacing: 60,
            })],
          }) : null,
          ...titleLines.map((line, i) => new Paragraph({
            spacing: { after: i < titleLines.length - 1 ? 100 : 200, line: Math.ceil(titlePt * 23), lineRule: "atLeast" },
            children: [new TextRun({
              text: line, size: titleSize, bold: true,
              color: P.titleColor, font: { ascii: "Arial", hAnsi: "Arial", eastAsia: "Microsoft YaHei" },
            })],
          })),
          config.subtitle ? new Paragraph({
            spacing: { after: 100, line: 380, lineRule: "atLeast" },
            children: [new TextRun({
              text: config.subtitle, size: 24, color: P.subtitleColor,
              font: F.cover,
            })],
          }) : null,
        ].filter(Boolean),
      })],
    })],
  });

  const divider = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: allNoBorders,
    rows: [new TableRow({
      height: { value: DIVIDER_H, rule: "exact" },
      children: [new TableCell({
        borders: noBorders,
        shading: { type: ShadingType.CLEAR, fill: P.accent },
        children: [emptyPara()],
      })],
    })],
  });

  const lowerContent = [
    new Paragraph({ spacing: { before: 800 } }),
    ...(config.metaLines || []).map((line) => new Paragraph({
      indent: { left: padL }, spacing: { after: 100, line: 340, lineRule: "atLeast" },
      children: [new TextRun({ text: line, size: 26, color: P.metaColor, font: F.cover })],
    })),
    new Paragraph({ spacing: { before: 2000 } }),
    new Paragraph({
      indent: { left: padL },
      children: [
        new TextRun({ text: config.footerLeft || "", size: 22, color: "909090", font: F.cover }),
        new TextRun({ text: "          " }),
        new TextRun({ text: config.footerRight || "", size: 22, color: "909090", font: F.cover }),
      ],
    }),
  ];

  return [new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: allNoBorders,
    rows: [new TableRow({
      height: { value: 16838, rule: "exact" },
      children: [new TableCell({
        shading: { type: ShadingType.CLEAR, fill: "FFFFFF" },
        borders: noBorders,
        verticalAlign: VerticalAlign.TOP,
        children: [upperBlock, divider, ...lowerContent],
      })],
    })],
  })];
}

module.exports = {
  PAL, F, noBorder, noBorders, allNoBorders, hairline, emptyPara,
  runs, h1, h2, h3, p, lead, bullets, numberedList, makeCounters,
  codeBlock, callout, dataTable, exercises, buildCoverR4, calcTitleLayout,
};
