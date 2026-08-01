#!/usr/bin/env python3
"""Render the public V1 report DTO to a complete Chinese PDF on stdout."""
import io, json, sys
from html import escape
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, LongTable, Table, TableStyle, PageBreak, KeepTogether

pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
FONT = 'STSong-Light'
INK = colors.HexColor('#173634')
TEAL = colors.HexColor('#087d78')
MINT = colors.HexColor('#e9f4f2')
RED = colors.HexColor('#c4473a')

def text(value):
    if value is None: return '—'
    if isinstance(value, bool): return '是' if value else '否'
    if isinstance(value, (dict, list)): return json.dumps(value, ensure_ascii=False, indent=2)
    return str(value)

def p(value, style):
    return Paragraph(escape(text(value)).replace('\n', '<br/>'), style)

def model_audit(value):
    model = value.get('model')
    model_id = value.get('modelId')
    if model and model_id and model != model_id:
        return f'{model} / modelId: {model_id}'
    return model or model_id or '未记录'

def flat_table(rows, styles):
    data = [[p('字段', styles['tableHeader']), p('内容', styles['tableHeader'])]]
    for key, value in rows:
        data.append([p(key, styles['small']), p(value, styles['small'])])
    table = LongTable(data, colWidths=[48*mm, 122*mm], repeatRows=1)
    table.setStyle(TableStyle([
        ('FONTNAME', (0,0), (-1,-1), FONT), ('BACKGROUND', (0,0), (-1,0), INK),
        ('TEXTCOLOR', (0,0), (-1,0), colors.white), ('GRID', (0,0), (-1,-1), .3, colors.HexColor('#b6cbc7')),
        ('VALIGN', (0,0), (-1,-1), 'TOP'), ('LEFTPADDING', (0,0), (-1,-1), 6), ('RIGHTPADDING', (0,0), (-1,-1), 6),
        ('TOPPADDING', (0,0), (-1,-1), 3), ('BOTTOMPADDING', (0,0), (-1,-1), 3),
    ]))
    return table

def candidate_table(entries, styles):
    data = [[p('候选', styles['tableHeader']), p('综合评分', styles['tableHeader']), p('五项专业度', styles['tableHeader']), p('能力与耗时', styles['tableHeader'])]]
    for entry in entries:
        detail = entry.get('detail', {}); capability = detail.get('capability') or entry.get('execution') or {}; professionalism = detail.get('professionalism') or {}
        dimensions = '；'.join(f'{key}={value}' for key, value in entry.get('dimensions', {}).items()) or '—'
        professional_dimensions = professionalism.get('dimensions', {})
        professional_text = '\n'.join([f"{label}={text(professional_dimensions.get(key))}" for key, label in [('taskCompletion', '任务完成'), ('methodProfessionalism', '方法专业性'), ('evidenceDataQuality', '数据证据质量'), ('riskUncertainty', '风险与不确定性'), ('artifactUsability', '产物可用性')]])
        capability_text = f"端到端耗时={text(capability.get('durationMs'))}ms\n执行成功评分={text(capability.get('executionSuccessScore'))}\n耗时评分={text(capability.get('latencyScore'))}\n能力总分={text(capability.get('capabilityScore'))}\n工具调用观测={text(capability.get('toolObservation'))}\n包含网络与协议开销={text(capability.get('includesNetwork'))}"
        data.append([p(entry.get('name', entry.get('id', '候选')), styles['small']), p(f"总分={text(entry.get('score'))}\n{dimensions}", styles['small']), p(professional_text, styles['small']), p(capability_text, styles['small'])])
    table = LongTable(data, colWidths=[27*mm, 36*mm, 62*mm, 45*mm], repeatRows=1)
    table.setStyle(TableStyle([
        ('FONTNAME', (0,0), (-1,-1), FONT), ('BACKGROUND', (0,0), (-1,0), INK), ('TEXTCOLOR', (0,0), (-1,0), colors.white),
        ('GRID', (0,0), (-1,-1), .3, colors.HexColor('#b6cbc7')), ('VALIGN', (0,0), (-1,-1), 'TOP'),
        ('LEFTPADDING', (0,0), (-1,-1), 5), ('RIGHTPADDING', (0,0), (-1,-1), 5), ('TOPPADDING', (0,0), (-1,-1), 3), ('BOTTOMPADDING', (0,0), (-1,-1), 3)
    ]))
    return table

def section(title, story, styles, break_before=False):
    if break_before: story.append(PageBreak())
    story += [Paragraph(escape(title), styles['reportH1']), Spacer(1, 4*mm)]

def add_json(title, value, story, styles):
    story += [Paragraph(escape(title), styles['reportH2']), p(json.dumps(value if value is not None else {}, ensure_ascii=False, indent=2), styles['mono']), Spacer(1, 3*mm)]

def footer(canvas, doc):
    canvas.saveState(); canvas.setFont(FONT, 8); canvas.setFillColor(INK)
    canvas.drawString(18*mm, 12*mm, 'Agent 锐评系统 - V1 完整评测报告')
    canvas.drawRightString(192*mm, 12*mm, f'第 {doc.page} 页')
    canvas.setStrokeColor(TEAL); canvas.line(18*mm, 16*mm, 192*mm, 16*mm); canvas.restoreState()

def header(canvas, doc):
    canvas.saveState(); canvas.setFont(FONT, 8); canvas.setFillColor(TEAL)
    canvas.drawString(18*mm, 287*mm, 'Agent 锐评系统 / V1 COMPLETE REVIEW REPORT')
    canvas.drawRightString(192*mm, 287*mm, '公开评测归档')
    canvas.setStrokeColor(TEAL); canvas.line(18*mm, 283*mm, 192*mm, 283*mm); canvas.restoreState()

def decorate(canvas, doc):
    header(canvas, doc); footer(canvas, doc)

def main(dto):
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle('titleCN', parent=styles['Title'], fontName=FONT, fontSize=25, leading=34, textColor=INK, alignment=TA_CENTER, spaceAfter=9*mm))
    styles.add(ParagraphStyle('sub', parent=styles['Normal'], fontName=FONT, fontSize=11, leading=17, textColor=INK, alignment=TA_CENTER))
    styles.add(ParagraphStyle('reportH1', parent=styles['Heading1'], fontName=FONT, fontSize=17, leading=23, textColor=INK, spaceBefore=3*mm, spaceAfter=3*mm, keepWithNext=1))
    styles.add(ParagraphStyle('reportH2', parent=styles['Heading2'], fontName=FONT, fontSize=12, leading=18, textColor=TEAL, spaceBefore=3*mm, spaceAfter=2*mm))
    styles.add(ParagraphStyle('body', parent=styles['BodyText'], fontName=FONT, fontSize=9.5, leading=15, textColor=INK))
    styles.add(ParagraphStyle('small', parent=styles['BodyText'], fontName=FONT, fontSize=6.8, leading=9.5, textColor=INK))
    styles.add(ParagraphStyle('tableHeader', parent=styles['BodyText'], fontName=FONT, fontSize=6.8, leading=9.5, textColor=colors.white))
    styles.add(ParagraphStyle('mono', parent=styles['BodyText'], fontName=FONT, fontSize=6.8, leading=9.5, textColor=INK, backColor=colors.HexColor('#f5f8f7'), borderColor=colors.HexColor('#c7d8d5'), borderWidth=.3, borderPadding=5))
    stream = io.BytesIO()
    doc = SimpleDocTemplate(stream, pagesize=A4, leftMargin=18*mm, rightMargin=18*mm, topMargin=22*mm, bottomMargin=22*mm, title='V1 Agent 完整评测报告', author='Agent 锐评系统')
    story = []
    evaluation = dto.get('evaluation', {}); card = dto.get('agentCard', {}); scoring = dto.get('scoring', {})
    tier = scoring.get('roast', {}).get('tier') or {}
    story += [Spacer(1, 30*mm), Paragraph('V1 Agent 完整评测报告', styles['titleCN']), Paragraph('同 Prompt 对打 - 四方研究审稿 - 公开可下载版本', styles['sub']), Spacer(1, 12*mm), flat_table([('评测编号', evaluation.get('id')), ('Agent', card.get('name')), ('最终评级', tier.get('label') or tier.get('stamp') or '—'), ('评级代码', tier.get('code')), ('完成时间', evaluation.get('completedAt')), ('运行模式', evaluation.get('overallMode') or evaluation.get('mode'))], styles)]
    section('一、评分口径与免责声明', story, styles, True)
    story += [p('本报告仅记录本次 V1 评测的公开输入、输出与审计结果，不构成投资建议。能力耗时为端到端墙钟时间，包含网络、协议和运行开销；平台未观测 Agent 内部工具调用。', styles['body']), Spacer(1, 3*mm), flat_table([('场景价值', '20%：问题复杂度、Agent 适配性'), ('专业度', '60%：任务完成、方法、数据证据、风险不确定性、产物可用性'), ('Agent 能力', '20%：执行成功 70% + 耗时 30%'), ('审稿范围', 'Card 审稿只评审 Agent Card 的定位、Skill、协议、示例和边界')], styles)]
    section('二、评测概览', story, styles)
    story.append(flat_table([('最终锐评', scoring.get('roast', {}).get('headline')), ('最终评级', tier.get('label') or tier.get('stamp')), ('提交 Agent 平均分', scoring.get('averages', {}).get('submitted')), ('评测状态', evaluation.get('status')), ('评分版本', scoring.get('scoringConfig', {}).get('version')), ('Card 摘要', card.get('description')), ('Card Skills', '；'.join(skill.get('name', skill.get('id', 'Skill')) for skill in card.get('skills', [])) or '—')], styles))
    for round_data in dto.get('benchmark', []):
        ranking = sorted(round_data.get('ranking', []), key=lambda item: item.get('score') if isinstance(item.get('score'), (int, float)) else -1, reverse=True)
        story += [Paragraph(escape(f"{round_data.get('case', {}).get('name', '案例')} - CASE 排名"), styles['reportH2']), flat_table([(f"第 {index + 1} 名", f"{item.get('name', item.get('id', '候选'))} / {text(item.get('score'))} 分") for index, item in enumerate(ranking)], styles)]
    section('三、完整 Agent Card', story, styles, True); add_json('Agent Card 原始公开字段', card, story, styles)
    section('四、四方 Agent Card 设计评审', story, styles)
    for review in scoring.get('professional', {}).get('reviews', []):
        story += [Paragraph(escape(f"{review.get('reviewer') or review.get('model') or '评审'} - {review.get('score', '—')} 分"), styles['reportH2']), p('评审模型：' + model_audit(review), styles['body']), p(review.get('comment') or review.get('error') or '—', styles['body']), p('风险与不确定性：' + text(review.get('risk')), styles['body']), flat_table([(k, v) for k,v in review.get('dimensions', {}).items()], styles), Spacer(1, 3*mm)]
    section('五、逐 CASE 场景评估', story, styles, True)
    for index, round_data in enumerate(dto.get('benchmark', []), 1):
        case = round_data.get('case', {}); judging = round_data.get('judging', {}); scenario = judging.get('scenario', {})
        story += [Paragraph(escape(f"CASE {index:02d} - {case.get('name', '未命名案例')}"), styles['reportH2']), p('Prompt：' + text(case.get('prompt')), styles['body']), flat_table([(k, v) for k,v in scenario.get('dimensions', {}).items()] + [('场景总分', scenario.get('score'))], styles)]
        seats = judging.get('seats', [])
        if seats:
            story += [Paragraph('评审席位与真实模型标识', styles['reportH2']), flat_table([((seat.get('reviewerName') or seat.get('reviewerId') or '评审'), f"{model_audit(seat)} / 状态: {text(seat.get('status'))}") for seat in seats], styles)]
        for review in scenario.get('reviews', []): story += [p(f"{review.get('reviewerName') or review.get('model')}（{model_audit(review)}）：{review.get('rationale', '—')}", styles['body'])]
    section('六、逐候选同题对打与能力评估', story, styles, True)
    for round_data in dto.get('benchmark', []):
        story.append(Paragraph(escape(round_data.get('case', {}).get('name', '案例')), styles['reportH2']))
        story += [candidate_table(round_data.get('entries', []), styles), Spacer(1, 4*mm)]
    section('七、逐席模型评审审计', story, styles)
    for round_data in dto.get('benchmark', []):
        for entry in round_data.get('entries', []):
            for review in entry.get('judgeReviews', []):
                uncertainty = '；'.join(review.get('uncertainties', [])) or '—'
                story += [Paragraph(escape(f"{round_data.get('case', {}).get('name', '案例')} - {entry.get('name', '候选')} - {review.get('reviewerName') or review.get('model', '评审')}"), styles['reportH2']), p('评审模型：' + model_audit(review), styles['body']), p(review.get('rationale') or review.get('error') or '—', styles['body']), p('审计不确定性：' + uncertainty, styles['body']), flat_table([(k,v) for k,v in review.get('dimensions', {}).items()], styles)]
    section('八、完整候选原始输出', story, styles, True)
    for round_data in dto.get('benchmark', []):
        for entry in round_data.get('entries', []):
            story += [Paragraph(escape(f"{round_data.get('case', {}).get('name', '案例')} - {entry.get('name', '候选')}"), styles['reportH2']), p(entry.get('output', ''), styles['mono']), Spacer(1, 4*mm)]
    section('九、Runtime、数据、上下文与时间线附录', story, styles, True)
    for build in dto.get('builds', []): add_json(f"Runtime：{build.get('runtime', build.get('runtimeId', '未知'))}", build, story, styles)
    for round_data in dto.get('benchmark', []):
        add_json(f"数据验证：{round_data.get('case', {}).get('name', '案例')}", round_data.get('dataEvidence'), story, styles)
        for entry in round_data.get('entries', []): add_json(f"上下文与执行：{entry.get('name', '候选')}", entry.get('execution'), story, styles)
    add_json('公开执行时间线', dto.get('logs', []), story, styles)
    doc.build(story, onFirstPage=decorate, onLaterPages=decorate)
    sys.stdout.buffer.write(stream.getvalue())

if __name__ == '__main__':
    try: main(json.load(sys.stdin))
    except Exception as exc:
        print(str(exc), file=sys.stderr); sys.exit(1)
