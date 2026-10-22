#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_footers.py — Hậu xử lý GIAO_TRINH_PYTHON.docx
1. Ánh xạ footer của từng section (qua rels) và gắn format switch đúng:
   - section pgNumType fmt="upperRoman" -> instrText 'PAGE \\* ROMAN \\* MERGEFORMAT'
   - section pgNumType fmt="decimal"    -> instrText 'PAGE \\* arabic \\* MERGEFORMAT'
2. Xóa <w:pgNumType/> rỗng (docx-js phát thải ở section không đặt pageNumbers — gây rối WPS)
"""
import re
import sys
import shutil
import zipfile
import tempfile
import os

DOCX = sys.argv[1] if len(sys.argv) > 1 else "GIAO_TRINH_PYTHON.docx"

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def main():
    tmp = tempfile.mkdtemp(prefix="gtp_patch_")
    with zipfile.ZipFile(DOCX, "r") as zf:
        zf.extractall(tmp)

    doc_path = os.path.join(tmp, "word", "document.xml")
    rels_path = os.path.join(tmp, "word", "_rels", "document.xml.rels")
    doc = open(doc_path, encoding="utf-8").read()
    rels = open(rels_path, encoding="utf-8").read()

    # rels: rId -> target footerN.xml
    rid_to_target = dict(re.findall(r'<Relationship[^>]*Id="([^"]+)"[^>]*Target="(footer\d+\.xml)"', rels))
    # cũng bắt dạng attribute đảo thứ tự
    for m in re.finditer(r"<Relationship\b[^>]*>", rels):
        tag = m.group(0)
        rid = re.search(r'Id="([^"]+)"', tag)
        tgt = re.search(r'Target="(footer\d+\.xml)"', tag)
        if rid and tgt:
            rid_to_target[rid.group(1)] = tgt.group(1)

    # mỗi sectPr: fmt + footerReference default
    section_plans = []  # (footer_file, fmt)
    for sect in re.finditer(r"<w:sectPr\b.*?</w:sectPr>", doc, re.S):
        s = sect.group(0)
        fmt_m = re.search(r'<w:pgNumType[^>]*w:fmt="([^"]+)"', s)
        fmt = fmt_m.group(1) if fmt_m else None
        for fr in re.finditer(r'<w:footerReference[^>]*w:type="default"[^>]*/>|<w:footerReference[^>]*r:id="([^"]+)"[^>]*w:type="default"[^>]*/>', s):
            tag = fr.group(0)
            rid = re.search(r'r:id="([^"]+)"', tag)
            if rid and rid.group(1) in rid_to_target:
                section_plans.append((rid_to_target[rid.group(1)], fmt))

    patched = []
    for footer_file, fmt in section_plans:
        if footer_file in patched:
            continue
        fpath = os.path.join(tmp, "word", footer_file)
        if not os.path.exists(fpath):
            continue
        ftxt = open(fpath, encoding="utf-8").read()
        if "PAGE" not in ftxt:
            continue
        if fmt == "upperRoman":
            switch = r"PAGE \* ROMAN \* MERGEFORMAT"
        else:
            switch = r"PAGE \* arabic \* MERGEFORMAT"
        new_ftxt = re.sub(
            r"(<w:instrText[^>]*>)\s*PAGE\s*(</w:instrText>)",
            lambda m: m.group(1) + " " + switch + " " + m.group(2),
            ftxt,
        )
        if new_ftxt != ftxt:
            open(fpath, "w", encoding="utf-8").write(new_ftxt)
            print(f"patched {footer_file}: fmt={fmt} -> {switch}")
        patched.append(footer_file)

    # xóa pgNumType rỗng (không attribute)
    n_empty = len(re.findall(r"<w:pgNumType\s*/>", doc))
    if n_empty:
        doc = re.sub(r"<w:pgNumType\s*/>", "", doc)
        open(doc_path, "w", encoding="utf-8").write(doc)
        print(f"removed {n_empty} empty <w:pgNumType/>")

    # đóng gói lại
    out = DOCX
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, _, files in os.walk(tmp):
            for name in files:
                full = os.path.join(root, name)
                arc = os.path.relpath(full, tmp)
                zf.write(full, arc)
    shutil.rmtree(tmp)
    print("repacked:", out)


if __name__ == "__main__":
    main()
