from pathlib import Path
import xml.etree.ElementTree as ET
from PIL import Image, ImageDraw, ImageFont
import html, json, math

BASE = Path(__file__).resolve().parents[1]
OUT = BASE / 'diagrams'
OUT.mkdir(exist_ok=True)
FONT = 'C:/Windows/Fonts/msyh.ttc'
BOLD = 'C:/Windows/Fonts/msyhbd.ttc'
W, H = 1740, 1000
PALETTE = {
    'service': ('#dae8fc', '#6c8ebf'),
    'security': ('#e1d5e7', '#9673a6'),
    'queue': ('#fff2cc', '#d6b656'),
    'success': ('#d5e8d4', '#82b366'),
    'external': ('#f5f5f5', '#666666'),
    'error': ('#f8cecc', '#b85450'),
}

def node(i, text, x, y, w, h, role='service'):
    return dict(id=i, text=text, x=x, y=y, w=w, h=h, role=role)

def edge(i, a, b, points, label='', dashed=False, color='#536477'):
    return dict(id=i, a=a, b=b, points=points, label=label, dashed=dashed, color=color)

pages = [dict(
    name='01 总体接入架构', file='安全护栏架构草图',
    title='智能座舱 Agent｜安全护栏接入草图',
    subtitle='阿里云试接 · 车控执行前校验 · 流式内容审核后播报    /    v0.1 · 2026-10-14 · 设计建议',
    nodes=[
        node('user', '用户输入\nASR 最终转写 / 文字', 50, 190, 230, 100),
        node('input', '① 输入护栏\n检测 → 本地策略', 350, 190, 250, 100, 'security'),
        node('agent', 'Agent\n推理 / 检索 / 计划', 690, 190, 230, 100),
        node('output', '② 输出缓冲与护栏\n组段 / 送检 / 按序放行', 1000, 190, 280, 100, 'security'),
        node('tts', '已审核内容\n屏幕 + TTS 播放', 1380, 190, 280, 100, 'success'),
        node('policy', '③ 动作校验\n权限 / 参数\n车辆状态 / 确认', 690, 420, 230, 110, 'security'),
        node('gateway', '车控网关 / 模拟工具\n独立校验 + 幂等执行', 1000, 420, 280, 110),
        node('car', '可信执行回执\n成功 / 失败 / 状态未知', 1380, 420, 280, 110, 'success'),
        node('adapter', '统一供应商适配器\n超时 / 错误 / 结果归一化', 350, 700, 340, 110, 'queue'),
        node('vendor', '阿里云 AI 安全护栏\nMultiModalGuard（先联调）', 830, 700, 410, 110, 'external'),
        node('metrics', '策略与观测\n策略版本 / 脱敏日志 / 指标', 1380, 700, 280, 110, 'queue'),
    ],
    edges=[
        edge('e-user-input','user','input',[(280,240),(350,240)]),
        edge('e-input-agent','input','agent',[(600,240),(690,240)],'通过'),
        edge('e-agent-output','agent','output',[(920,240),(1000,240)]),
        edge('e-output-tts','output','tts',[(1280,240),(1380,240)],'通过'),
        edge('e-agent-policy','agent','policy',[(805,290),(805,420)],'工具调用'),
        edge('e-policy-gateway','policy','gateway',[(920,475),(1000,475)],'允许'),
        edge('e-gateway-car','gateway','car',[(1280,475),(1380,475)]),
        edge('e-input-adapter','input','adapter',[(440,290),(440,700)],'送检',True),
        edge('e-output-adapter','output','adapter',[(1140,190),(1140,170),(20,170),(20,670),(640,670),(640,700)],'',True),
        edge('e-adapter-vendor','adapter','vendor',[(690,755),(830,755)],'检测 API',True),
        edge('e-adapter-metrics','adapter','metrics',[(690,790),(740,790),(740,870),(1520,870),(1520,810)],'',True),
    ],
    notes=[
        (50,120,1600,40,'三个关口各有职责：内容审核不能替代车控授权与车辆状态判断。'),
        (1000,550,660,70,'执行回执经检查后回到 Agent，再生成并审核播报。\n以真实结果说话，执行失败时不能宣称“已完成”。'),
        (50,570,500,80,'拦截 / 故障：不启动或停止生成；清待播队列。\n使用本地已评审代答，不透出未审原文。'),
        (50,915,1620,45,'实线：业务主流程    虚线：检测与观测调用    紫色：护栏    黄色：支撑模块    绿色：已审内容 / 可信结果    灰色：供应商'),
    ]
), dict(
    name='02 流式播报门控', file='流式播报审核草图',
    title='流式播报｜先缓存，审核通过后释放',
    subtitle='模型持续生成；TTS 只接收已通过的连续片段。    /    第一版同轮审核串行 · 设计建议',
    nodes=[
        node('delta', '模型流式增量\n每轮生成独立标识', 50, 220, 240, 120),
        node('buffer', '私有缓冲 / 组段\n自然句候选 + 长度上限\n尾段同样送检', 380, 220, 280, 120, 'queue'),
        node('check', '阿里审核 + 本地策略\n必要上下文 / 有限超时\n未知结果不放行', 750, 220, 280, 120, 'security'),
        node('ordered', '已审核队列\n前序通过才释放\n旧轮结果丢弃', 1130, 220, 260, 120, 'success'),
        node('play', 'TTS / 屏幕\n按序播放与显示', 1480, 220, 210, 120, 'success'),
        node('interrupt', '用户打断 / 新轮次\n取消旧轮所有待处理任务', 50, 560, 310, 110, 'external'),
        node('stop', '停止该轮\n取消生成 / 清文本与音频队列\n故障用代答；用户打断则静默', 750, 560, 380, 110, 'error'),
    ],
    edges=[
        edge('s-delta-buffer','delta','buffer',[(290,280),(380,280)]),
        edge('s-buffer-check','buffer','check',[(660,280),(750,280)]),
        edge('s-check-ordered','check','ordered',[(1030,280),(1130,280)],'通过'),
        edge('s-ordered-play','ordered','play',[(1390,280),(1480,280)]),
        edge('s-check-stop','check','stop',[(890,340),(890,560)],'拦截 / 超时 / 异常',False,'#b85450'),
        edge('s-interrupt-stop','interrupt','stop',[(360,615),(750,615)],'取消',False,'#b85450'),
        edge('s-stop-play','stop','play',[(1130,615),(1585,615),(1585,340)],'清待播 / 停止后续',True,'#b85450'),
    ],
    notes=[
        (50,135,1640,45,'禁止把原始 token 直接送进播报队列。每片记录 turn_id / generation_id / seq；取消优先于迟到结果。'),
        (50,380,590,100,'先做整段审核基线，再对照验证分段模式。\n审核速度落后时有界缓存并暂停/结束生成；\n不能为减少等待而绕过护栏。'),
        (1150,720,520,100,'新服务：chatId / done 需按契约验证。\n上下文窗口、重试去重、开通权限待确认。\n新旧产品的 session 字段不能混用。'),
        (50,760,990,90,'残余风险：已经播放的声音无法撤回；后续内容可能改变前文语义。\n跨片风险与长窗口不足要测试，必要场景改为整段通过后播报。'),
        (50,915,1640,45,'蓝色：生成    黄色：待审缓冲    紫色：审核    绿色：通过后释放    红色：停止与清理    灰色：外部事件'),
    ]
)]

mxfile = ET.Element('mxfile', host='drawio', version='26.0.0')
for pi, p in enumerate(pages):
    diagram = ET.SubElement(mxfile, 'diagram', id=f'cockpit-{pi+1}', name=p['name'])
    model = ET.SubElement(diagram, 'mxGraphModel', page='1', pageWidth=str(W), pageHeight=str(H), grid='1', gridSize='10', background='#ffffff')
    root = ET.SubElement(model, 'root')
    ET.SubElement(root, 'mxCell', id='0')
    ET.SubElement(root, 'mxCell', id='1', parent='0')
    im = Image.new('RGB', (W,H), '#ffffff')
    d = ImageDraw.Draw(im)
    svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-label="{html.escape(p["title"])}"><rect width="100%" height="100%" fill="white"/>']
    def text_lines(text,x,y,w,h,size=22,bold=False,color='#213248',align='center'):
        f=ImageFont.truetype(BOLD if bold else FONT,size)
        lines=text.split('\n'); step=size+10
        top=y+(h-step*len(lines))/2
        for j,line in enumerate(lines):
            length=d.textlength(line,font=f)
            assert length <= w-12, (p['name'],line,length,w)
            xx=x+(w-length)/2 if align=='center' else x+4
            yy=top+j*step
            d.text((xx,yy),line,font=f,fill=color)
            anchor='middle' if align=='center' else 'start'
            sx=x+w/2 if align=='center' else x+4
            svg.append(f'<text x="{sx}" y="{yy+size}" text-anchor="{anchor}" font-family="Microsoft YaHei,sans-serif" font-size="{size}" font-weight="{700 if bold else 400}" fill="{color}">{html.escape(line)}</text>')
    def mxtext(i,text,x,y,w,h,size,bold=False):
        c=ET.SubElement(root,'mxCell',id=i,value=text,style=f'text;html=1;whiteSpace=wrap;align=left;verticalAlign=middle;fontFamily=Microsoft YaHei;fontSize={size};fontStyle={1 if bold else 0};fontColor=#213248;',vertex='1',parent='1')
        ET.SubElement(c,'mxGeometry',x=str(x),y=str(y),width=str(w),height=str(h),attrib={'as':'geometry'})
    text_lines(p['title'],50,25,1640,55,34,True,align='left')
    mxtext('title',p['title'],50,20,1640,60,34,True)
    text_lines(p['subtitle'],50,85,1640,35,18,align='left',color='#596b80')
    mxtext('subtitle',p['subtitle'],50,80,1640,40,18)
    byid={n['id']:n for n in p['nodes']}
    # Draw connectors first so node borders stay visible.
    for e in p['edges']:
        pts=e['points']
        c=ET.SubElement(root,'mxCell',id=e['id'],value=e['label'],edge='1',parent='1',source=e['a'],target=e['b'])
        a,b=byid[e['a']],byid[e['b']]
        ex=(pts[0][0]-a['x'])/a['w']; ey=(pts[0][1]-a['y'])/a['h']
        ix=(pts[-1][0]-b['x'])/b['w']; iy=(pts[-1][1]-b['y'])/b['h']
        c.set('style',f'edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;endSize=8;strokeColor={e["color"]};strokeWidth=2;fontFamily=Microsoft YaHei;fontSize=18;labelBackgroundColor=#ffffff;dashed={int(e["dashed"])};exitX={ex};exitY={ey};exitDx=0;exitDy=0;entryX={ix};entryY={iy};entryDx=0;entryDy=0;')
        g=ET.SubElement(c,'mxGeometry',relative='1',attrib={'as':'geometry'})
        if len(pts)>2:
            arr=ET.SubElement(g,'Array',attrib={'as':'points'})
            for x,y in pts[1:-1]: ET.SubElement(arr,'mxPoint',x=str(x),y=str(y))
        for (x1,y1),(x2,y2) in zip(pts,pts[1:]):
            if e['dashed']:
                length=math.hypot(x2-x1,y2-y1)
                for t in range(0,int(length),14):
                    aa=t/length; bb=min(t+8,length)/length
                    d.line([(x1+(x2-x1)*aa,y1+(y2-y1)*aa),(x1+(x2-x1)*bb,y1+(y2-y1)*bb)],fill=e['color'],width=2)
            else: d.line([(x1,y1),(x2,y2)],fill=e['color'],width=2)
        x,y=pts[-1]; px,py=pts[-2]; angle=math.atan2(y-py,x-px)
        triangle=[(x,y),(x-12*math.cos(angle)+5*math.sin(angle),y-12*math.sin(angle)-5*math.cos(angle)),(x-12*math.cos(angle)-5*math.sin(angle),y-12*math.sin(angle)+5*math.cos(angle))]
        d.polygon(triangle,fill=e['color'])
        svg.append(f'<polyline points="{" ".join(f"{x},{y}" for x,y in pts)}" fill="none" stroke="{e["color"]}" stroke-width="2" {"stroke-dasharray=\"8 6\"" if e["dashed"] else ""}/>')
        svg.append(f'<polygon points="{" ".join(f"{x},{y}" for x,y in triangle)}" fill="{e["color"]}"/>')
        if e['label']:
            f=ImageFont.truetype(FONT,18); lw=d.textlength(e['label'],font=f)
            # Label first segment midpoint; long vertical labels move left of the line.
            x1,y1=pts[0];x2,y2=pts[1]
            lx=(x1+x2)/2; ly=(y1+y2)/2
            if x1==x2: lx=x1-lw/2-16
            d.rectangle((lx-lw/2-4,ly-18,lx+lw/2+4,ly+7),fill='white')
            text_lines(e['label'],lx-lw/2-8,ly-24,lw+16,32,18,color=e['color'])
    for n in p['nodes']:
        fill,stroke=PALETTE[n['role']]
        c=ET.SubElement(root,'mxCell',id=n['id'],value=n['text'],style=f'rounded=1;whiteSpace=wrap;html=1;fillColor={fill};strokeColor={stroke};strokeWidth=2;fontFamily=Microsoft YaHei;fontSize=20;fontColor=#213248;spacing=10;',vertex='1',parent='1')
        ET.SubElement(c,'mxGeometry',x=str(n['x']),y=str(n['y']),width=str(n['w']),height=str(n['h']),attrib={'as':'geometry'})
        d.rounded_rectangle((n['x'],n['y'],n['x']+n['w'],n['y']+n['h']),radius=12,fill=fill,outline=stroke,width=2)
        svg.append(f'<rect x="{n["x"]}" y="{n["y"]}" width="{n["w"]}" height="{n["h"]}" rx="12" fill="{fill}" stroke="{stroke}" stroke-width="2"/>')
        text_lines(n['text'],n['x'],n['y'],n['w'],n['h'],20)
    for ni,(x,y,w,h,text) in enumerate(p['notes']):
        text_lines(text,x,y,w,h,18,align='left',color='#596b80')
        mxtext(f'note-{ni}',text,x,y,w,h,18)
    svg.append('</svg>')
    (OUT/f'{p["file"]}.svg').write_text(''.join(svg),encoding='utf-8')
    im.save(OUT/f'{p["file"]}.png')
ET.indent(mxfile,space='  ')
ET.ElementTree(mxfile).write(OUT/'安全护栏接入草图.drawio',encoding='utf-8',xml_declaration=True)
(OUT/'草图预览说明.txt').write_text('PNG/SVG 为与 drawio 同一节点及连线模型生成的草图预览，不是 drawio 原生导出。drawio XML 另做结构校验；编辑器中的自动路由与字体可能略有不同。内容为设计建议，未实测云 API 或车辆。',encoding='utf-8')
print(json.dumps({'pages':len(pages),'output':str(OUT)},ensure_ascii=False))
