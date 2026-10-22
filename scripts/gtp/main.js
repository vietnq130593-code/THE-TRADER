// ============================================================
// main.js — Assemble Giáo trình Python → GIAO_TRINH_PYTHON.docx
// Kiến trúc 3 section: Cover (R4/DM-1) · Front matter (La Mã) · Body (Ả Rập từ 1)
// ============================================================
const {
  Document, Packer, Paragraph, TextRun, Header, Footer, PageNumber,
  NumberFormat, AlignmentType, HeadingLevel, LevelFormat, TableOfContents,
  SectionType, BorderStyle,
} = require("docx");
const fs = require("fs");
const H = require("./helpers");
const { loiNoiDau, gioiThieu } = require("./front");
const { ch1 } = require("./ch1");
const { ch2 } = require("./ch2");
const { ch3 } = require("./ch3");
const { ch4 } = require("./ch4");
const { ch5 } = require("./ch5");
const { ch6 } = require("./ch6");
const { ch7 } = require("./ch7");

const OUT = "/home/z/my-project/GIAO_TRINH_PYTHON.docx";

// ---------- Palette DM-1 cho cover (nền tối) ----------
const COVER_PAL = {
  bg: "162235",
  titleColor: "FFFFFF",
  subtitleColor: "B0B8C0",
  metaColor: "90989F",
  accent: "37DCF2",
};

// ---------- Trang & lề ----------
const pgSize = { width: 11906, height: 16838 };
const pgMargin = { top: 1440, bottom: 1440, left: 1701, right: 1417 };

// ---------- Header/Footer ----------
function bodyHeader() {
  return new Header({
    children: [new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { after: 0, line: 240 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: "C8DDE2" } },
      children: [new TextRun({
        text: "Giáo trình Python — Từ nền tảng đến API & Database",
        size: 16, color: "8A97A5", font: H.F.body,
      })],
    })],
  });
}
function pageNumFooter() {
  return new Footer({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, line: 240 },
      children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, color: "8A97A5", font: H.F.body })],
    })],
  });
}

// ---------- Numbering: 7 danh sách bài tập riêng biệt ----------
const numberingConfig = ["bt-c1", "bt-c2", "bt-c3", "bt-c4", "bt-c5", "bt-c6", "bt-c7"].map((ref) => ({
  reference: ref,
  levels: [{
    level: 0,
    format: LevelFormat.DECIMAL,
    text: "%1.",
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 640, hanging: 360 } } },
  }],
}));

// ---------- Front matter: Lời nói đầu + Mục lục ----------
const frontChildren = [
  ...loiNoiDau,

  // Tiêu đề mục lục — KHÔNG dùng HeadingLevel (tránh TOC tự lập chỉ mục)
  new Paragraph({
    alignment: AlignmentType.CENTER,
    pageBreakBefore: true,
    spacing: { before: 240, after: 360, line: 312 },
    children: [new TextRun({ text: "MỤC LỤC", bold: true, size: 32, color: H.PAL.primary, font: H.F.head })],
  }),
  new TableOfContents("Table of Contents", {
    hyperlink: true,
    headingStyleRange: "1-3",
  }),
  new Paragraph({
    spacing: { before: 200, line: 312 },
    children: [new TextRun({
      text: "Lưu ý: Mục lục được sinh bằng trường (field) tự động. Sau khi mở file, hãy nhấp chuột phải vào mục lục và chọn Update Field để cập nhật số trang chính xác.",
      italics: true, size: 18, color: "888888", font: H.F.body,
    })],
  }),
];

// ---------- Body ----------
const bodyChildren = [
  ...gioiThieu,
  ...ch1,
  ...ch2,
  ...ch3,
  ...ch4,
  ...ch5,
  ...ch6,
  ...ch7,
];

// ---------- Document ----------
const doc = new Document({
  creator: "Giáo trình Python",
  title: "Giáo trình Python — Từ nền tảng cơ bản đến API, Database và dịch vụ thực tế",
  styles: {
    default: {
      document: {
        run: { font: H.F.body, size: 24, color: H.PAL.body },
        paragraph: { spacing: { line: 312 } },
      },
      heading1: {
        run: { font: H.F.head, size: 32, bold: true, color: H.PAL.primary },
        paragraph: { spacing: { before: 360, after: 200, line: 312 }, outlineLevel: 0 },
      },
      heading2: {
        run: { font: H.F.head, size: 27, bold: true, color: H.PAL.primary },
        paragraph: { spacing: { before: 300, after: 140, line: 312 }, outlineLevel: 1 },
      },
      heading3: {
        run: { font: H.F.head, size: 24, bold: true, color: H.PAL.accent },
        paragraph: { spacing: { before: 240, after: 120, line: 312 }, outlineLevel: 2 },
      },
    },
  },
  numbering: { config: numberingConfig },
  features: { updateFields: true },
  sections: [
    // ===== Section 1: COVER — không đánh số trang =====
    {
      properties: {
        page: { size: pgSize, margin: { top: 0, bottom: 0, left: 0, right: 0 } },
      },
      children: H.buildCoverR4({
        title: "GIÁO TRÌNH PYTHON",
        englishLabel: "PYTHON PROGRAMMING COURSE",
        subtitle: "Từ nền tảng cơ bản đến API, Database và dịch vụ thực tế",
        metaLines: [
          "Lộ trình 7 cấp độ — từ cú pháp cơ bản đến dịch vụ hoàn chỉnh",
          "Đối tượng: người mới bắt đầu theo hướng thực chiến",
          "Hơn 70 ví dụ mã nguồn chạy được · 11 bảng tra cứu · hơn 40 bài tập",
          "Phiên bản tham chiếu: Python 3.12 · FastAPI · SQLAlchemy",
        ],
        footerLeft: "Giáo trình đào tạo nội bộ",
        footerRight: "2025",
        palette: COVER_PAL,
      }),
    },
    // ===== Section 2: FRONT MATTER — số La Mã i, ii, iii =====
    {
      properties: {
        type: SectionType.NEXT_PAGE,
        page: {
          size: pgSize, margin: pgMargin,
          pageNumbers: { start: 1, formatType: NumberFormat.UPPER_ROMAN },
        },
      },
      footers: { default: pageNumFooter() },
      children: frontChildren,
    },
    // ===== Section 3: BODY — số Ả Rập, reset từ 1 =====
    {
      properties: {
        type: SectionType.NEXT_PAGE,
        page: {
          size: pgSize, margin: pgMargin,
          pageNumbers: { start: 1, formatType: NumberFormat.DECIMAL },
        },
      },
      headers: { default: bodyHeader() },
      footers: { default: pageNumFooter() },
      children: bodyChildren,
    },
  ],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(OUT, buf);
  console.log("Đã ghi:", OUT, `(${(buf.length / 1024).toFixed(1)} KB)`);
}).catch((err) => {
  console.error("LỖI:", err);
  process.exit(1);
});
