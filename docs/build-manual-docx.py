"""Build the user manual as a DOCX.

Kept as a script so the document can be regenerated whenever the text changes.
The visual language is deliberately quiet: one accent colour, generous spacing,
and boxes only where a note really needs to stand apart from the body.
"""

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

INK = RGBColor(0x1F, 0x2A, 0x37)
ACCENT = RGBColor(0x1B, 0x4F, 0x7A)
MUTED = RGBColor(0x5A, 0x66, 0x73)
NOTE_BG = "EAF3EC"
WARN_BG = "FBEEE0"
CODE_BG = "F2F4F7"

HEAD_FONT = "微软雅黑"
BODY_FONT = "微软雅黑"
CODE_FONT = "Consolas"


def set_font(run, name, size=None, bold=None, color=None):
    run.font.name = name
    if size is not None:
        run.font.size = Pt(size)
    if bold is not None:
        run.font.bold = bold
    if color is not None:
        run.font.color.rgb = color
    # East Asian glyphs need their own font slot, or Word falls back silently.
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    rfonts.set(qn("w:eastAsia"), name)


def shade(paragraph_or_cell, hex_fill):
    """Paint a paragraph or table cell background."""
    element = paragraph_or_cell._element
    if element.tag.endswith("tc"):
        target = element.get_or_add_tcPr()
    else:
        target = element.get_or_add_pPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_fill)
    target.append(shd)


def left_bar(paragraph, hex_fill):
    """A thin coloured bar down the left edge: reads as a note, not a warning box."""
    ppr = paragraph._element.get_or_add_pPr()
    borders = OxmlElement("w:pBdr")
    left = OxmlElement("w:left")
    left.set(qn("w:val"), "single")
    left.set(qn("w:sz"), "18")
    left.set(qn("w:space"), "8")
    left.set(qn("w:color"), hex_fill)
    borders.append(left)
    ppr.append(borders)


def body(document, text, size=10.5, space_after=6, color=INK):
    p = document.add_paragraph()
    p.paragraph_format.space_after = Pt(space_after)
    p.paragraph_format.line_spacing = 1.6
    run = p.add_run(text)
    set_font(run, BODY_FONT, size, color=color)
    return p


def bullet(document, text, size=10.5):
    p = document.add_paragraph(style="List Bullet")
    p.paragraph_format.space_after = Pt(3)
    p.paragraph_format.line_spacing = 1.55
    run = p.add_run(text)
    set_font(run, BODY_FONT, size, color=INK)
    return p


def numbered(document, text, size=10.5, start=1):
    """A numbered step, with the number written by hand.

    The built-in List Number style keeps counting across separate lists, so the
    second batch of steps started at 3 and the install instructions read as if they
    began mid-way. Typing the number keeps every list starting at 1.
    """
    p = document.add_paragraph()
    p.paragraph_format.space_after = Pt(3)
    p.paragraph_format.line_spacing = 1.55
    p.paragraph_format.left_indent = Cm(0.9)
    p.paragraph_format.first_line_indent = Cm(-0.9)
    num = p.add_run(f"{start}.  ")
    set_font(num, BODY_FONT, size, color=ACCENT)
    run = p.add_run(text)
    set_font(run, BODY_FONT, size, color=INK)
    return p


def steps(document, items, size=10.5):
    """A numbered list that always starts at 1."""
    for i, text in enumerate(items, start=1):
        numbered(document, text, size=size, start=i)


def h1(document, text):
    p = document.add_paragraph()
    p.paragraph_format.space_before = Pt(22)
    p.paragraph_format.space_after = Pt(10)
    run = p.add_run(text)
    set_font(run, HEAD_FONT, 16, bold=True, color=ACCENT)
    left_bar(p, "1B4F7A")
    return p


def h2(document, text):
    p = document.add_paragraph()
    p.paragraph_format.space_before = Pt(14)
    p.paragraph_format.space_after = Pt(6)
    run = p.add_run(text)
    set_font(run, HEAD_FONT, 12.5, bold=True, color=INK)
    return p


def h3(document, text):
    p = document.add_paragraph()
    p.paragraph_format.space_before = Pt(10)
    p.paragraph_format.space_after = Pt(4)
    run = p.add_run(text)
    set_font(run, HEAD_FONT, 11, bold=True, color=ACCENT)
    return p


def note(document, text, fill=NOTE_BG, bar="3F7D54"):
    p = document.add_paragraph()
    p.paragraph_format.space_before = Pt(8)
    p.paragraph_format.space_after = Pt(8)
    p.paragraph_format.left_indent = Cm(0.3)
    p.paragraph_format.line_spacing = 1.55
    run = p.add_run(text)
    set_font(run, BODY_FONT, 10, color=INK)
    shade(p, fill)
    left_bar(p, bar)
    return p


def code(document, text):
    p = document.add_paragraph()
    p.paragraph_format.space_before = Pt(6)
    p.paragraph_format.space_after = Pt(8)
    p.paragraph_format.left_indent = Cm(0.3)
    run = p.add_run(text)
    set_font(run, CODE_FONT, 9.5, color=RGBColor(0x33, 0x3D, 0x4A))
    shade(p, CODE_BG)
    left_bar(p, "8895A7")
    return p


def table(document, headers, rows, widths=None):
    t = document.add_table(rows=1, cols=len(headers))
    t.style = "Table Grid"
    t.alignment = WD_TABLE_ALIGNMENT.LEFT
    hdr = t.rows[0].cells
    for i, text in enumerate(headers):
        hdr[i].text = ""
        p = hdr[i].paragraphs[0]
        p.paragraph_format.space_after = Pt(2)
        run = p.add_run(text)
        set_font(run, HEAD_FONT, 10, bold=True, color=ACCENT)
        shade(hdr[i], "E4EDF5")
    for row in rows:
        cells = t.add_row().cells
        for i, text in enumerate(row):
            cells[i].text = ""
            p = cells[i].paragraphs[0]
            p.paragraph_format.space_after = Pt(2)
            p.paragraph_format.line_spacing = 1.45
            run = p.add_run(text)
            set_font(run, BODY_FONT, 9.5, color=INK)
    if widths:
        for row in t.rows:
            for i, width in enumerate(widths):
                row.cells[i].width = Cm(width)
    document.add_paragraph().paragraph_format.space_after = Pt(2)
    return t


def build(path):
    doc = Document()

    # Page setup: A4 with margins that leave room for a comfortable line length.
    section = doc.sections[0]
    section.page_width = Cm(21.0)
    section.page_height = Cm(29.7)
    section.left_margin = Cm(2.6)
    section.right_margin = Cm(2.6)
    section.top_margin = Cm(2.2)
    section.bottom_margin = Cm(2.2)

    # ---------- Cover ----------
    for _ in range(4):
        doc.add_paragraph()

    title = doc.add_paragraph()
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = title.add_run("鲸鲸 × DSH 桥接")
    set_font(run, HEAD_FONT, 30, bold=True, color=ACCENT)

    sub = doc.add_paragraph()
    sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = sub.add_run("用 户 手 册")
    set_font(run, HEAD_FONT, 17, color=MUTED)

    doc.add_paragraph()
    ver = doc.add_paragraph()
    ver.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = ver.add_run("版本 v1.0.0")
    set_font(run, BODY_FONT, 11.5, color=MUTED)

    doc.add_page_break()

    # ---------- 1 ----------
    h1(doc, "一、这是做什么的")
    body(doc, "鲸鲸是一个微信机器人助手，它有自己的性格、人设和记忆。")
    body(doc, "DSH（DeepSeek Harness）是一个本地的 AI 工作台，它更聪明、能上网查资料、能查梗、能画图。")
    body(doc, "这个插件做的事只有一件：让微信上跟你聊天的那个人，换成 DSH 的脑子来回答。")
    body(doc, "装好之后，你在微信里发消息，回复由 DSH 生成，但：")
    bullet(doc, "人设还是鲸鲸的——你想让她是谁，她就还是谁")
    bullet(doc, "记忆还在鲸鲸那边，不会丢")
    bullet(doc, "微信记录、群聊、朋友圈这些照常")
    note(doc, "简单说：声音还是她的，脑子换成更强的那个。")

    # ---------- 2 ----------
    h1(doc, "二、能做什么")

    h2(doc, "2.1  基础能力")
    table(
        doc,
        ["能力", "说明"],
        [
            ["真思考", "回复由 DSH 生成，不是提前写好的模板"],
            ["跨轮记忆", "记得你上一句说了什么，能接着聊"],
            ["保留人设", "你在鲸鲸人设页改的内容，桥接后照样生效"],
            ["自动接上工具", "DSH 里装的插件，微信这边直接用"],
        ],
        widths=[4.0, 11.8],
    )

    h2(doc, "2.2  装了插件之后会自动获得的能力")
    body(doc, "桥接启动时，会自动把你在 DSH 里装的插件同步过去。也就是说，DSH 能用的，微信这边也能用：")
    bullet(doc, "查梗：问「doro 是谁」「典是什么意思」，她会真的去查")
    bullet(doc, "联网搜索：问实时信息、新闻，能查到")
    bullet(doc, "画图：让她画点什么，能出图")
    bullet(doc, "看图片：你发张图问她是什么，她能看懂")
    bullet(doc, "表情包：聊天时能发表情")
    body(doc, "这些不需要你额外配置。你在 DSH 里装了什么，微信这边就有什么。")

    h2(doc, "2.3  三种人格来源")
    body(doc, "配置页里有一个「人格来源」的选项，三选一：")

    h3(doc, "① 跟随鲸鲸的人格页（推荐）")
    body(doc, "把鲸鲸人设页里写的内容交给 DSH 当背景。你在鲸鲸里改人设，这边自动跟着变，不用重装、不用复制粘贴。")

    h3(doc, "② 自己写一份")
    body(doc, "在配置页里直接写。适合想让微信上那个人和 DSH 里那个人完全分开的情况。写什么就是什么。")

    h3(doc, "③ 跟随 DSH")
    body(doc, "不注入任何人设，让 DSH 那边自己决定。适合你已经在 DSH 里配好了完整人设的情况。")

    # ---------- 3 ----------
    h1(doc, "三、安装之前要准备什么")

    h2(doc, "3.1  必装的两样东西")
    steps(doc, ["鲸鲸（Whale-Girl）—— 已经能正常收发微信消息", "DSH（DeepSeek Harness）—— 能正常打开、能聊天"])
    body(doc, "两个都装好、都能用，再开始装桥接。")

    h2(doc, "3.2  一个 API Key")
    body(doc, "桥接需要一个 DeepSeek 的 API Key。去这里申请：")
    code(doc, "https://platform.deepseek.com")
    body(doc, "注册后在「API Keys」里创建一个，复制下来（形如 sk-xxxxxxxx）。")
    note(doc, "这个 Key 是给桥接单独用的，和你平时在 DSH 里用的不冲突，两套互不影响。", fill=WARN_BG, bar="C08A3E")

    h2(doc, "3.3  确认版本")
    bullet(doc, "鲸鲸：4.1.2 或更高")
    bullet(doc, "DSH：能正常启动即可")

    # ---------- 4 ----------
    h1(doc, "四、安装步骤")
    body(doc, "一共装两个东西：DSH 那边的插件，和鲸鲸这边的插件。建议先装 DSH，再装鲸鲸。")
    body(doc, "原因很实际：鲸鲸插件装上以后，如果 DSH 没在跑，它会一直报连不上，你在微信里也等不到回复。反过来先装就没这问题。")

    h2(doc, "第一步：装 DSH 插件")
    steps(doc, [
        "找到 dsh-whale-bridge-1.0.0.zip，解压出来",
        "里面是一个叫 dsh-whale-bridge 的文件夹，把它放到不会被清理工具扫到的地方（比如 D:\\dsh-plugins\\dsh-whale-bridge）",
        "打开 DSH",
        "进入「插件管理」或「插件市场」",
        "选择「安装本地插件」或「从本地安装」",
        "指向刚才那个文件夹（不是 zip 文件本身）",
        "等待安装完成",
        "重启 DSH",
    ])
    body(doc, "重启后，在 DSH 的设置里能看到「鲸鲸桥接」这一项，说明第一步成了。")
    note(doc, "如果找不到安装入口：DSH 也支持命令行安装。打开命令行，执行  dsh plugin install 你的路径\\dsh-whale-bridge　装完同样要重启 DSH。")
    note(doc, "为什么不能放桌面：桌面上的文件夹容易被清理工具扫掉，插件一没，微信那边立刻断。放在一个固定的地方更稳妥。", fill=WARN_BG, bar="C08A3E")

    h2(doc, "第二步：装鲸鲸插件")
    body(doc, "方式一：从插件市场装（推荐）")
    steps(doc, [
        "打开鲸鲸，进入「插件市场」",
        "搜索「DSH 桥接」",
        "点安装，装完重启鲸鲸",
    ])
    body(doc, "安装时鲸鲸会弹一个权限确认，说明这个插件要完整系统权限——因为它得访问你本机上的一个本地服务。同意才能用，不同意就只能走鲸鲸自己的模型。")
    body(doc, "方式二：从本地装")
    steps(doc, [
        "打开鲸鲸，进入「插件」页面",
        "点「安装插件」→「从文件安装」",
        "选择 whale-dsh-bridge-1.0.0.zip（这个不用解压，直接选 zip）",
        "安装完成后重启鲸鲸",
    ])
    note(doc, "重要：如果鲸鲸提示「插件未授权」，需要在插件列表里点一下「允许」或「授权」。没授权的话插件不会运行，表现为微信收到「模拟回复」。", fill=WARN_BG, bar="C08A3E")

    # ---------- 5 ----------
    h1(doc, "五、首次配置")
    body(doc, "打开 DSH 的设置页，找到「鲸鲸桥接」。从上到下依次是：")

    h2(doc, "5.1  启用桥接")
    body(doc, "最上面一个大开关。先别开，等下面配置完再开。")

    h2(doc, "5.2  人格来源")
    body(doc, "选一个。第一次用建议选「跟随鲸鲸的人格页」。选完之后下面会显示一段说明，告诉你这个选项是什么意思。")

    h2(doc, "5.3  回答用哪个")
    body(doc, "两个选项：")
    bullet(doc, "回声（测试用，不思考）：不连 DSH，你发什么它就回什么。用来验证「消息能不能通」")
    bullet(doc, "本机 DSH（真思考）：连 DSH，真的思考后回答")
    body(doc, "选「本机 DSH（真思考）」。")

    h2(doc, "5.4  填 API Key")
    bullet(doc, "API Key：粘贴你在第 3.2 步拿到的 Key")
    bullet(doc, "接口地址：默认 https://api.deepseek.com，不用改")
    bullet(doc, "模型：deepseek-flash（快）或 deepseek-pro（强），推荐先用 flash")
    bullet(doc, "推理：low 起步，觉得回答太简单可以调高")
    body(doc, "填完点「保存设置」。")

    h2(doc, "5.5  打开桥接")
    body(doc, "回到最上面，把大开关打开。")
    note(doc, "第一次打开会等十几秒——它在准备一个独立的运行环境，这是正常的。")

    h2(doc, "5.6  确认成功")
    body(doc, "看界面最下面那行状态，应该显示：")
    code(doc, "状态：已启用 · 正在回复 0 条 · 排队 0 条 · 回答方式：本机 DSH")
    body(doc, "「回答方式：本机 DSH」是关键。如果显示「回声测试」，说明还没切过去，回去检查 5.3。")

    # ---------- 6 ----------
    h1(doc, "六、开始使用")

    h2(doc, "6.1  第一次测试")
    body(doc, "配置好之后，用另一个微信账号给自己的号发一条消息：")
    code(doc, "你好")
    body(doc, "等几秒，应该收到回复。")
    body(doc, "怎么判断是不是 DSH 在回答：")
    bullet(doc, "有思考延迟（2–10 秒，不是秒回）")
    bullet(doc, "回复有上下文记忆")
    bullet(doc, "没有「模拟回复：」这个前缀")
    body(doc, "如果秒回且内容和你发的一模一样，说明还在回声模式。")

    h2(doc, "6.2  测试工具能力")
    body(doc, "验证插件同步有没有生效，问一个她必须查才知道的东西：")
    code(doc, "你知道 doro 是谁吗")
    body(doc, "如果她能说出是「妮姬里的桃乐丝，粉白毛白身子那个」这类具体内容，说明梗百科生效了。")
    body(doc, "再试一个：")
    code(doc, "帮我查一下今天有什么新闻")
    body(doc, "这个验证联网搜索。")

    h2(doc, "6.3  日常使用")
    body(doc, "配好之后就不用管了。正常在微信里跟她聊就行。她记得你说过的话，因为对话历史会保存在桥接那边。")

    h2(doc, "6.4  关于「安静」的时间")
    body(doc, "微信里聊天有个特点：你连着发好几条，她会等你发完再一起回。")
    bullet(doc, "私聊：安静 1.5 秒后开始回复")
    bullet(doc, "群聊：最多等 5 秒，把连发的几条合并成一次回复")
    body(doc, "这是有意的设计，避免你发一句她回一句，看起来很急。")

    # ---------- 7 ----------
    h1(doc, "七、常见问题")

    h3(doc, "Q1  微信里收到「模拟回复：xxx」")
    body(doc, "原因：桥接还在回声模式，没连上 DSH。")
    body(doc, "解决：")
    steps(doc, [
        "进 DSH 设置页 → 鲸鲸桥接",
        "确认「回答用哪个」是「本机 DSH（真思考）」",
        "点「保存设置」",
        "状态栏应该变成「回答方式：本机 DSH」",
    ])

    h3(doc, "Q2  回复很慢，或者超时")
    body(doc, "原因：可能是模型选了 deepseek-pro + 推理等级高，或者网络慢。")
    body(doc, "解决：")
    bullet(doc, "模型换成 deepseek-flash")
    bullet(doc, "推理等级调成 low")
    bullet(doc, "超时时间调大（默认 40000 毫秒 = 40 秒）")

    h3(doc, "Q3  她不知道自己是 DSH，或者答得像换了个人")
    body(doc, "这是正常的。")
    body(doc, "微信上那个人设是你在鲸鲸人设页里写的。如果那段人设里没有提「DSH」，她当然不知道。")
    body(doc, "想让她知道：去鲸鲸人设页，加一句类似「你知道自己住在一个叫 DSH 的环境里」。")

    h3(doc, "Q4  插件同步显示「X 个可用，Y 个跳过」")
    body(doc, "这两个数字每个人都不一样，取决于你自己在 DSH 里装了多少插件。")
    bullet(doc, "可用 = 能在这边用上的（查梗、联网、画图这些）")
    bullet(doc, "跳过 = 只负责画 DSH 界面的（侧边栏、宠物、皮肤），在后台跑没有意义")
    body(doc, "跳过还有一个原因：这类插件在无界面环境里容易崩，一个崩了整个桥接都起不来，所以干脆不加载。")
    body(doc, "不用管这两个数字，它们只是告诉你有多少被同步过去了。")

    h3(doc, "Q5  改了 DSH 的插件，微信这边什么时候生效")
    body(doc, "下次桥接启动时自动同步。你不需要手动做什么，重启鲸鲸或者关掉桥接再打开就行。")

    h3(doc, "Q6  卸载之后我的数据还在吗")
    body(doc, "在。桥接的数据存在 C:\\Users\\你的用户名\\.whale-dsh-bridge\\，卸载插件不会删。")
    body(doc, "想彻底清干净，手动删这个文件夹。")

    h3(doc, "Q7  能不能同时用两个微信号")
    body(doc, "可以。桥接是靠会话 ID 区分对话的，不同微信账号会有各自的上下文，不会串。")

    # ---------- 8 ----------
    h1(doc, "八、这个插件不动你什么")
    body(doc, "怕你不知道，这里说清楚：")
    bullet(doc, "不动你日常 DSH 的配置——桥接用的是独立的一套，你的模型设置、插件、人设都不受影响")
    bullet(doc, "不动你的聊天记录——DSH 里的会话不会被微信消息污染")
    bullet(doc, "不动你的 API Key——存在本机，不写进任何配置文件")
    bullet(doc, "随时可以关——关掉开关，微信立刻交还给鲸鲸自己回答，正在排队的消息会被取消")

    # ---------- 9 ----------
    h1(doc, "九、遇到问题怎么办")
    steps(doc, [
        "看状态栏：DSH 设置页最下面那行，写了当前状态和最近错误",
        "看错误列表：如果有错误，下面会显示「最近错误 N 条」，点开能看到具体原因",
        "截图反馈：把状态栏和错误列表截图，能快速定位",
    ])

    # ---------- Footer ----------
    doc.add_paragraph()
    tail = doc.add_paragraph()
    tail.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = tail.add_run("文档版本 v1.0.0　·　适用插件版本 v1.0.0")
    set_font(run, BODY_FONT, 9, color=MUTED)

    doc.save(path)
    return path


if __name__ == "__main__":
    import sys
    target = sys.argv[1] if len(sys.argv) > 1 else "鲸鲸DSH桥接_用户手册_v1.docx"
    print(build(target))
