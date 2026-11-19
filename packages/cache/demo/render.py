# Renders out/demo.txt (a real recording) as an animated GIF, plus a before/after PNG card.
from PIL import Image, ImageDraw, ImageFont
import json, re, sys
W, H = 1000, 560
BG, FG, DIM, GREEN, AMBER, BLUE = (22,24,30), (225,228,235), (125,132,148), (110,220,150), (245,190,90), (120,170,255)
FONT = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', 20)
BIG = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', 34)
SMALL = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', 17)
lines = [l.rstrip('\n') for l in open('out/demo.txt')]
lines = [l for l in lines if not l.startswith('real ')]

def color(l):
    if l.startswith('$'): return FG
    if 'cache miss' in l: return AMBER
    if 'cache hit' in l or 'FULL TURBO' in l: return GREEN
    return DIM

def base(shown, cursor=True, banner=None):
    im = Image.new('RGB', (W, H), BG); d = ImageDraw.Draw(im)
    d.rectangle([0,0,W,38], fill=(36,39,48))
    for i,c in enumerate([(255,95,86),(255,189,46),(39,201,63)]): d.ellipse([16+i*24,12,30+i*24,26], fill=c)
    d.text((W//2-150,10), 'turbo + my remote cache server', font=SMALL, fill=DIM)
    y = 56
    for t,c in shown:
        d.text((28,y), t, font=FONT, fill=c); y += 28
    if cursor: d.rectangle([28+ (len(shown[-1][0]) if shown else 0)*12, y-28, 28+(len(shown[-1][0]) if shown else 0)*12+10, y-6], fill=FG)
    if banner:
        d.rounded_rectangle([40, H-130, W-40, H-30], radius=14, fill=(30,60,45), outline=GREEN)
        d.text((70, H-118), banner[0], font=BIG, fill=GREEN)
        d.text((70, H-70), banner[1], font=SMALL, fill=FG)
    return im

frames, durs = [], []
shown = []
def add(im, ms): frames.append(im); durs.append(ms)
add(base(shown), 400)
for l in lines:
    if l.startswith('$'):
        for i in range(0, len(l)+1, 2):
            add(base(shown+[(l[:i], FG)]), 35)
        shown.append((l, FG)); add(base(shown, False), 500 if 'rm -rf' not in l else 700)
    elif l == '':
        shown.append(('', FG))
    else:
        shown.append((l, color(l)))
        slow = 'cache miss' in l
        add(base(shown, False), 900 if slow else 250)
        if slow: add(base(shown, False), 900)
tail = base(shown, False, ('2.6 s  ->  11 ms', 'real turbo 2.11.11, remote hit from my own cache server'))
add(tail, 4000)
frames[0].save('out/demo.gif', save_all=True, append_images=frames[1:], duration=durs, loop=0, optimize=True)
print('gif frames', len(frames), 'total s', sum(durs)/1000)

# before / after card
c = Image.new('RGB', (1200, 630), BG); d = ImageDraw.Draw(c)
d.text((60,40), 'GitCafe API: what an agent has to load', font=ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', 30), fill=FG)
d.text((60,130), 'BEFORE', font=SMALL, fill=AMBER)
d.text((60,160), 'getApiReposByOwnerByRepoWebhooksByWebhook', font=FONT, fill=FG)
d.text((60,190), 'IdDeliveriesByDeliveryIdAttempts', font=FONT, fill=FG)
d.text((60,250), 'AFTER', font=SMALL, fill=GREEN)
d.text((60,280), 'listWebhookDeliveryAttempts', font=BIG, fill=GREEN)
d.line([60,360,1140,360], fill=(60,64,76), width=2)
for i,(big,small,col) in enumerate([('523K','full spec (2.09M chars)',AMBER),('15K','index of all 619 ops',GREEN),('6K','median single operation',GREEN)]):
    x = 60 + i*370
    d.text((x,395), big, font=ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', 64), fill=col)
    d.text((x,480), small, font=SMALL, fill=DIM)
d.text((60,570), 'token counts are chars/4 estimates  |  github.com/FindMalek/gitcafe-agent-kit', font=SMALL, fill=DIM)
c.save('out/before-after.png')
print('png ok')
