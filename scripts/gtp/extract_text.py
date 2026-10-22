#!/usr/bin/env python3
"""Extract GIAO_TRINH_PYTHON.docx into reviewable plain text.

Usage: python3 scripts/gtp/extract_text.py [output.txt]
Output marks: #/##/### headings, |code lines, tables as pipe rows,
[PGBREAK] section breaks, and flags paragraphs that mix many runs.
"""
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def para_text(p):
    return "".join(t.text or "" for t in p.iter(W + "t"))


def para_style(p):
    pPr = p.find(W + "pPr")
    if pPr is not None:
        st = pPr.find(W + "pStyle")
        if st is not None:
            return st.get(W + "val")
    return None


def para_is_code(p):
    """A paragraph is treated as a code line when its runs are Consolas-heavy."""
    runs = p.findall(W + "r")
    if not runs:
        return False
    consolas = 0
    total_chars = 0
    for r in runs:
        rPr = r.find(W + "rPr")
        txt = "".join(t.text or "" for t in r.findall(W + "t"))
        total_chars += len(txt)
        if rPr is not None:
            f = rPr.find(W + "rFonts")
            if f is not None and f.get(W + "ascii") == "Consolas":
                consolas += len(txt)
    if total_chars == 0:
        return False
    return consolas / total_chars > 0.7


def para_shading(p):
    pPr = p.find(W + "pPr")
    if pPr is None:
        return None
    sh = pPr.find(W + "shd")
    if sh is not None:
        return sh.get(W + "fill")
    return None


def walk(body, out):
    for child in body:
        tag = child.tag
        if tag == W + "p":
            st = para_style(child)
            txt = para_text(child)
            # skip TOC placeholder lines (numeric styles 9/11/12 + dot tabs)
            if st in ("9", "11", "12"):
                continue
            if st == "TOC1":
                out.append("[TOC FIELD]")
                continue
            if not txt.strip():
                out.append("")
                continue
            if st == "Heading1":
                out.append("\n# " + txt)
            elif st == "Heading2":
                out.append("\n## " + txt)
            elif st == "Heading3":
                out.append("\n### " + txt)
            elif st == "ListParagraph":
                out.append("  • " + txt)
            elif para_is_code(child):
                sh = para_shading(child)
                out.append("| " + txt if sh else "|? " + txt)
            else:
                out.append(txt)
        elif tag == W + "tbl":
            # detect if this is a code-block table (single cell, Consolas runs)
            all_txt = "".join(t.text or "" for t in child.iter(W + "t"))
            consolas = sum(
                len("".join(t.text or "" for t in r.findall(W + "t")))
                for r in child.iter(W + "r")
                if r.find(W + "rPr") is not None
                and (lambda f: f is not None and f.get(W + "ascii") == "Consolas")(
                    r.find(W + "rPr").find(W + "rFonts"))
            )
            is_code = all_txt.strip() and consolas / max(len(all_txt), 1) > 0.7
            rows = []
            for tr in child.findall(W + "tr"):
                cells = []
                for tc in tr.findall(W + "tc"):
                    # keep each paragraph on its own line inside a cell
                    cell_lines = []
                    for p in tc.findall(W + "p"):
                        ptxt = "".join(t.text or "" for t in p.iter(W + "t"))
                        if ptxt.strip() or (cell_lines and ptxt == ""):
                            cell_lines.append(ptxt)
                    cells.append("\n".join(cell_lines).strip())
                rows.append("\n".join("  " + c for c in cells if c).lstrip())
            out.append("[CODE]" if is_code else "[TABLE]")
            for r in rows:
                for ln in r.split("\n"):
                    out.append(("| " + ln) if is_code else ("  " + ln))
            out.append("[/CODE]" if is_code else "[/TABLE]")
        elif tag == W + "sectPr":
            out.append("[SECTION BREAK]")


def main():
    src = "GIAO_TRINH_PYTHON.docx"
    dst = sys.argv[1] if len(sys.argv) > 1 else "tool-results/gtp_extract.txt"
    z = zipfile.ZipFile(src)
    doc = ET.fromstring(z.read("word/document.xml"))
    body = doc.find(W + "body")
    out = []
    walk(body, out)
    text = "\n".join(out)
    with open(dst, "w", encoding="utf-8") as f:
        f.write(text)
    lines = [ln for ln in out if ln.strip()]
    n_code = sum(1 for ln in out if ln.startswith("|"))
    n_tbl = sum(1 for ln in out if ln == "[TABLE]")
    n_h = sum(1 for ln in out if ln.startswith("#"))
    print(f"OK {dst}: {len(out)} paras, {len(lines)} non-empty lines, "
          f"{n_code} code lines, {n_tbl} tables, {n_h} headings, {len(text)} chars")


if __name__ == "__main__":
    main()
