#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""将 项目文档.md 转换为 Word(.docx)：仅使用 Python 标准库（zipfile 手工封装 OOXML）。
支持：标题、段落、无序列表(•)、表格、代码块、引用、分隔线、行内加粗/等宽代码。
用法：python3 generate_docx.py [输入.md] [输出.docx]
"""
import re
import sys
import zipfile
from xml.sax.saxutils import escape

# ---------- 常量 ----------
A4_W, A4_H = 11906, 16838          # A4 尺寸(twips)
MARGIN = 1134                       # 2cm 页边距

NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

# ---------- 行内解析 ----------
_INLINE = re.compile(r'(\*\*.+?\*\*|`[^`]+`)')

def runs(text):
    """把一行文本拆成 runs 列表 [ (text, bold, code), ... ]"""
    out = []
    for part in _INLINE.split(text):
        if not part:
            continue
        if part.startswith('**') and part.endswith('**') and len(part) > 4:
            out.append((part[2:-2], True, False))
        elif part.startswith('`') and part.endswith('`') and len(part) > 2:
            out.append((part[1:-1], False, True))
        else:
            out.append((part, False, False))
    return out

def run_xml(text, bold=False, code=False, size=None):
    rpr = '<w:rPr>'
    if bold:
        rpr += '<w:b/>'
    if code:
        rpr += '<w:rFonts ascii="Consolas" hAnsi="Consolas" eastAsia="SimSun"/><w:color w:val="C7254E"/>'
    if size:
        rpr += f'<w:sz w:val="{size}"/><w:szCs w:val="{size}"/>'
    rpr += '</w:rPr>'
    return f'<w:r>{rpr}<w:t xml:space="preserve">{escape(text)}</w:t></w:r>'

def para(children, ppr=''):
    return f'<w:p>{ppr}{"".join(children)}</w:p>'

def inline_para(text, ppr=''):
    return para([run_xml(t, b, c) for t, b, c in runs(text)], ppr)

# ---------- 块解析 ----------
def parse_md(text):
    blocks = []  # (kind, payload)
    lines = text.splitlines()
    i, n = 0, len(lines)
    while i < n:
        line = lines[i]
        if line.strip() == '':
            i += 1
            continue
        if line.strip().startswith('```'):
            j = i + 1
            code = []
            while j < n and not lines[j].strip().startswith('```'):
                code.append(lines[j])
                j += 1
            blocks.append(('code', '\n'.join(code)))
            i = j + 1
            continue
        if line.lstrip().startswith('|') and i + 1 < n and re.match(r'^\s*\|[\s:\-|]+\|\s*$', lines[i + 1]):
            rows = []
            while i < n and re.match(r'^\s*\|', lines[i]):
                # 跳过表头分隔行（| --- |）
                if re.match(r'^\s*\|[\s:\-|]+\|\s*$', lines[i]):
                    i += 1
                    continue
                cells = [c.strip() for c in lines[i].strip().strip('|').split('|')]
                rows.append(cells)
                i += 1
            blocks.append(('table', rows))
            continue
        m = re.match(r'^(#{1,4})\s+(.*)$', line)
        if m:
            blocks.append(('h' + str(len(m.group(1))), m.group(2).strip()))
            i += 1
            continue
        if re.match(r'^\s*---+\s*$', line.strip()) or re.match(r'^\s*\*\*\*+\s*$', line.strip()):
            blocks.append(('hr', None))
            i += 1
            continue
        if line.lstrip().startswith('- '):
            items = []
            while i < n and lines[i].lstrip().startswith('- '):
                items.append(lines[i].lstrip()[2:].strip())
                i += 1
            blocks.append(('bullet', items))
            continue
        if line.lstrip().startswith('> '):
            quote = []
            while i < n and lines[i].lstrip().startswith('> '):
                quote.append(lines[i].lstrip()[2:].strip())
                i += 1
            blocks.append(('quote', '\n'.join(quote)))
            continue
        # 普通段落：合并直到空行或新的块起始
        para_lines = [line]
        i += 1
        while i < n and lines[i].strip() and not re.match(r'^(#{1,4})\s', lines[i]) \
                and not lines[i].lstrip().startswith('```') and not lines[i].lstrip().startswith('|') \
                and not lines[i].lstrip().startswith('- ') and not lines[i].lstrip().startswith('> '):
            para_lines.append(lines[i])
            i += 1
        blocks.append(('para', ' '.join(x.strip() for x in para_lines)))
    return blocks

# ---------- 块 → OOXML ----------
def style_ppr(name=None, before=0, after=0, indent=None, shd=None, border=None, spacing=None):
    ppr = '<w:pPr>'
    if name:
        ppr += f'<w:pStyle w:val="{name}"/>'
    if indent is not None:
        ppr += f'<w:ind w:left="{indent}" w:hanging="{indent if indent else 0}"/>'
    ppr += f'<w:spacing w:before="{before}" w:after="{after}"'
    if spacing:
        ppr += f' w:line="{spacing}" w:lineRule="auto"'
    ppr += '/>'
    if shd:
        ppr += f'<w:shd w:val="clear" w:color="auto" w:fill="{shd}"/>'
    if border:
        ppr += f'<w:pBdr><w:left w:val="{border}" w:sz="18" w:space="4" w:color="4353F7"/></w:pBdr>'
    ppr += '</w:pPr>'
    return ppr

def render_h(level, text):
    sizes = {'1': 32, '2': 28, '3': 24, '4': 20}
    names = {'1': 'Heading1', '2': 'Heading2', '3': 'Heading3', '4': 'Heading4'}
    before = {'1': 360, '2': 280, '3': 200, '4': 120}.get(level, 100)
    after = {'1': 180, '2': 120, '3': 100, '4': 80}.get(level, 60)
    ppr = style_ppr(name=names[level], before=before, after=after)
    return para([run_xml(t, b, c, size=sizes[level]) for t, b, c in runs(text)], ppr)

def render_para(text, ppr=''):
    return inline_para(text, ppr)

def render_bullet(items):
    out = []
    for it in items:
        ppr = style_ppr(indent=340, after=20)
        out.append(para([run_xml('•\u2002'), *[run_xml(t, b, c) for t, b, c in runs(it)]], ppr))
    return ''.join(out)

def render_quote(text):
    ppr = style_ppr(after=120, shd='F5F6F8', border='single')
    children = []
    for t, b, c in runs(text):
        if b:
            children.append(run_xml(t, True, False, size=20))
        else:
            children.append(run_xml(t, False, False, size=20))
    return para(children, ppr)

def render_code(text):
    lines = text.split('\n')
    ppr = style_ppr(after=80, shd='F2F3F5')
    inner = []
    for idx, ln in enumerate(lines):
        rpr = '<w:rPr><w:rFonts ascii="Consolas" hAnsi="Consolas" eastAsia="SimSun"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>'
        inner.append(f'<w:r>{rpr}<w:t xml:space="preserve">{escape(ln)}</w:t></w:r>')
        if idx < len(lines) - 1:
            inner.append('<w:r><w:br/></w:r>')
    return para(inner, ppr)

def render_hr():
    ppr = '<w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D0D4DC"/></w:pBdr><w:spacing w:before="120" w:after="160"/></w:pPr>'
    return f'<w:p>{ppr}</w:p>'

def render_table(rows):
    if not rows:
        return ''
    cols = max(len(r) for r in rows)
    widths = 8500 // cols
    grid = ''.join(f'<w:gridCol w:w="{widths}"/>' for _ in range(cols))
    body = ''
    for ri, row in enumerate(rows):
        row = (row + [''] * cols)[:cols]
        cells = ''
        for cell in row:
            # 单元格内文本可能含 <br> 或由多行组成
            lines = cell.split('<br>')
            cell_paras = ''.join(inline_para(ln, style_ppr(spacing=240)) for ln in lines) if lines else inline_para('', style_ppr(spacing=240))
            shade = ' w:shd="{w:shd w:val=\'clear\' w:color=\'auto\' w:fill=\'EEF0FF\'/}"' if ri == 0 else ''
            cells += (f'<w:tc><w:tcPr><w:tcW w:w="{widths}" w:type="dxa"/>{shade}</w:tcPr>{cell_paras}</w:tc>')
        body += f'<w:tr>{cells}</w:tr>'
    tbl = ('<w:tbl><w:tblPr><w:tblW w:w="8500" w:type="dxa"/>'
           '<w:tblBorders>'
           '<w:top w:val="single" w:sz="4" w:color="C9CED8"/><w:left w:val="single" w:sz="4" w:color="C9CED8"/>'
           '<w:bottom w:val="single" w:sz="4" w:color="C9CED8"/><w:right w:val="single" w:sz="4" w:color="C9CED8"/>'
           '<w:insideH w:val="single" w:sz="4" w:color="C9CED8"/><w:insideV w:val="single" w:sz="4" w:color="C9CED8"/>'
           '</w:tblBorders><w:tblLayout w:type="autofit"/></w:tblPr>'
           f'<w:tblGrid>{grid}</w:tblGrid>{body}</w:tbl>')
    return f'<w:p>{style_ppr()}</w:p>' + tbl + '<w:p><w:pPr><w:spacing w:after="40"/></w:pPr></w:p>'

def build_body(blocks):
    out = []
    for kind, payload in blocks:
        if kind == 'hr':
            out.append(render_hr())
        elif kind.startswith('h'):
            out.append(render_h(kind[1], payload))
        elif kind == 'para':
            out.append(render_para(payload, style_ppr(after=120)))
        elif kind == 'bullet':
            out.append(render_bullet(payload))
        elif kind == 'table':
            out.append(render_table(payload))
        elif kind == 'code':
            out.append(render_code(payload))
        elif kind == 'quote':
            out.append(render_quote(payload))
    return ''.join(out)

# ---------- 文档骨架 ----------
def build_docx(md_text):
    secpr = (
        f'<w:sectPr><w:pgSz w:w="{A4_W}" w:h="{A4_H}"/>'
        f'<w:pgMar w:top="{MARGIN}" w:right="{MARGIN}" w:bottom="{MARGIN}" w:left="{MARGIN}" '
        f'w:header="708" w:footer="708" w:gutter="0"/>'
        '</w:sectPr>'
    )
    document = (
        f'<w:document {NS}><w:body>{build_body(parse_md(md_text))}{secpr}</w:body></w:document>'
    )
    return document

def build_styles():
    return '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr>
    <w:rFonts ascii="Calibri" hAnsi="Calibri" eastAsia="SimSun"/><w:sz w:val="21"/><w:szCs w:val="21"/>
  </w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/>
    <w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="120" w:after="240"/></w:pPr>
    <w:rPr><w:rFonts ascii="Calibri" hAnsi="Calibri" eastAsia="SimHei"/><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="300" w:after="160"/><w:outlineLvl w:val="0"/></w:pPr>
    <w:rPr><w:rFonts ascii="Calibri" hAnsi="Calibri" eastAsia="SimHei"/><w:b/><w:color w:val="2B3A99"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/>
    <w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="260" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr>
    <w:rPr><w:rFonts ascii="Calibri" hAnsi="Calibri" eastAsia="SimHei"/><w:b/><w:color w:val="4353F7"/><w:sz w:val="27"/><w:szCs w:val="27"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/>
    <w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="2"/></w:pPr>
    <w:rPr><w:rFonts ascii="Calibri" hAnsi="Calibri" eastAsia="SimHei"/><w:b/><w:color w:val="333333"/><w:sz w:val="23"/><w:szCs w:val="23"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/>
    <w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="80"/><w:outlineLvl w:val="3"/></w:pPr>
    <w:rPr><w:b/><w:color w:val="555555"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:style>
</w:styles>'''

def build_package(md_path, out_path):
    md_text = md_path  # 直接传入已读取文本
    document = build_docx(md_text)
    parts = {
        '[Content_Types].xml': '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>''',
        '_rels/.rels': '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>''',
        'word/document.xml': document,
        'word/styles.xml': build_styles(),
        'word/_rels/document.xml.rels': '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>''',
    }
    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, content in parts.items():
            z.writestr(name, content)

if __name__ == '__main__':
    md_file = sys.argv[1] if len(sys.argv) > 1 else '项目文档.md'
    out_file = sys.argv[2] if len(sys.argv) > 2 else '身份信息管理平台项目文档.docx'
    text = open(md_file, encoding='utf-8').read()
    build_package(text, out_file)
    print('OK ->', out_file)