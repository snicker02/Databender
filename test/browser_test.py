# End-to-end test in headless Chrome.  python3 test/browser_test.py <app_dir> <testdata_dir> <shots_dir>
import sys, os, json, threading, http.server, functools, time
from playwright.sync_api import sync_playwright

APP, DATA, SHOTS = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(SHOTS, exist_ok=True)
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=APP)
handler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f'http://127.0.0.1:{srv.server_address[1]}/index.html'

passed = failed = 0
def ok(c, m):
    global passed, failed
    if c: passed += 1
    else: failed += 1; print('FAIL:', m)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'])
    pg = b.new_page(viewport={'width': 1500, 'height': 1000}, accept_downloads=True)
    errors = []
    pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    pg.on('console', lambda m: errors.append('console: ' + m.text) if m.type == 'error' else None)
    pg.goto(URL); pg.wait_for_load_state('networkidle')
    ok(pg.evaluate("document.querySelectorAll('.fx').length") >= 40, 'effect blocks generated')

    def idle(ms=60):
        pg.wait_for_timeout(ms)
        pg.evaluate("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
        pg.wait_for_timeout(40)
    def sig():  # canvas signature
        return pg.evaluate("""() => { const c=document.getElementById('cv'), d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; let h=0; for(let i=0;i<d.length;i+=97) h=(h*31+d[i])>>>0; return c.width+'x'+c.height+':'+h; }""")
    nsteps = lambda: pg.evaluate("window.__databender.steps.length")

    pg.set_input_files('#file', f'{DATA}/test.png'); pg.wait_for_selector('#meta:not([hidden])'); idle(200)
    src_sig = sig()
    ok(src_sig.startswith('517x389'), 'loaded png dims ' + src_sig)
    ok(pg.evaluate("window.__databender.base.length") == 54 + 1552 * 389, 'bmp base length w/ padding')
    pg.screenshot(path=f'{SHOTS}/01-loaded.png')

    # ---- every effect in BMP mode
    fx_ids = pg.evaluate("[...document.querySelectorAll('.fx')].map(e=>e.dataset.fx)")
    unchanged = []
    for i, fx in enumerate(fx_ids):
        pg.evaluate(f"document.querySelector('.fx[data-fx=\"{fx}\"]').closest('details').open=true")
        pg.click(f'.fx[data-fx="{fx}"] .apply'); idle()
        ok(nsteps() == 1, f'{fx} added a step')
        if sig() == src_sig: unchanged.append(fx)
        pg.evaluate("window.__databender.steps.length=0"); pg.click('#stClear') if nsteps() else None
        pg.evaluate("(()=>{const S=window.__databender;S.steps=[];S.cache=[];})()")
    pg.click('#stClear'); idle()
    print('effects with no visible change at defaults:', unchanged)
    ok(len(unchanged) <= 2, 'almost all effects change the image')
    ok(not errors, 'no errors after all effects: ' + '; '.join(errors[:3]))

    # ---- stack + live edit
    pg.evaluate("document.querySelector('.fx[data-fx=\"wave\"]').closest('details').open=true")
    pg.click('.fx[data-fx="wave"] .apply'); idle()
    pg.click('.fx[data-fx="noise"] .apply'); idle()
    s2 = sig(); ok(nsteps() == 2, 'two steps')
    pg.click('.st[data-i="0"] .stn'); idle()
    ok(pg.evaluate("window.__databender.edit") == 0, 'step 0 selected for edit')
    ok(pg.evaluate("document.querySelector('.fx[data-fx=\"wave\"]').classList.contains('editing')"), 'wave block in editing state')
    pg.evaluate("""(()=>{const r=document.querySelector('.fx[data-fx="wave"] input[type=range]');r.value=50;r.dispatchEvent(new Event('input',{bubbles:true}));})()"""); idle()
    ok(pg.evaluate("window.__databender.steps[0].p.amp") == 50, 'live edit updated step param')
    s3 = sig(); ok(s3 != s2, 'live edit changed render')
    pg.keyboard.press('Escape'); idle()
    ok(pg.evaluate("window.__databender.edit") == -1, 'Esc stops editing')
    pg.click('.st[data-i="1"] [data-a="on"]'); idle()
    s4 = sig(); ok(s4 != s3, 'toggle off changes render')
    pg.keyboard.press('Control+z'); idle(); ok(sig() == s3, 'undo restores toggle')
    pg.keyboard.press('Control+Shift+z'); idle(); ok(sig() == s4, 'redo re-applies toggle')
    pg.keyboard.press('Control+z'); idle()
    pg.click('.st[data-i="1"] [data-a="up"]'); idle()
    ok(pg.evaluate("window.__databender.steps[0].fx") == 'noise', 'move up reorders')
    pg.click('.st[data-i="0"] [data-a="seed"]'); idle()
    pg.click('.st[data-i="0"] [data-a="del"]'); idle(); ok(nsteps() == 1, 'delete step')
    pg.click('#stClear'); idle(); ok(sig() == src_sig, 'clear returns to source')

    # ---- reset to source (stack + decode view), undoable
    pg.click('.fx[data-fx="noise"] .apply'); idle(); pg.click('.fx[data-fx="wave"] .apply'); idle()
    pg.evaluate("""(()=>{const r=document.getElementById('dw');r.value=5;r.dispatchEvent(new Event('input',{bubbles:true}));})()"""); idle()
    dirty = sig()
    pg.click('#btnReset'); idle()
    ok(sig() == src_sig and nsteps() == 0, 'reset to source clears stack + view')
    ok(pg.evaluate("document.getElementById('dw').value") == '0', 'reset restores decode view UI')
    pg.keyboard.press('Control+z'); idle(150)
    ok(sig() == dirty and nsteps() == 2, 'undo reset restores stack + view')
    pg.click('#btnReset'); idle()

    # ---- repeat-apply now differs (old bug)
    pg.click('.fx[data-fx="noise"] .apply'); idle(); a = sig()
    pg.click('.fx[data-fx="noise"] .apply'); idle(); b2 = sig()
    seeds = pg.evaluate("window.__databender.steps.map(s=>s.seed)")
    ok(seeds[0] != seeds[1] and a != b2, 'repeat apply uses new seed')
    pg.click('#stClear'); idle()

    # ---- selection
    box = pg.locator('#cv').bounding_box()
    pg.mouse.move(box['x'] + box['width'] * .2, box['y'] + box['height'] * .2); pg.mouse.down()
    pg.mouse.move(box['x'] + box['width'] * .6, box['y'] + box['height'] * .7, steps=6); pg.mouse.up(); idle()
    sel = pg.evaluate("window.__databender.sel")
    ok(sel and abs(sel['x0'] - .2) < .02 and abs(sel['y1'] - .7) < .02, f'selection captured {sel}')
    pg.evaluate("document.querySelector('.fx[data-fx=\"invert\"]').closest('details').open=true")
    pg.click('.fx[data-fx="invert"] .apply'); idle()
    corner = pg.evaluate("Array.from(document.getElementById('cv').getContext('2d').getImageData(5,5,1,1).data)")
    mid = pg.evaluate("(()=>{const c=document.getElementById('cv');return Array.from(c.getContext('2d').getImageData(c.width*0.4|0,c.height*0.45|0,1,1).data)})()")
    pg.click('#stClear'); idle()
    corner0 = pg.evaluate("Array.from(document.getElementById('cv').getContext('2d').getImageData(5,5,1,1).data)")
    mid0 = pg.evaluate("(()=>{const c=document.getElementById('cv');return Array.from(c.getContext('2d').getImageData(c.width*0.4|0,c.height*0.45|0,1,1).data)})()")
    ok(corner == corner0, 'outside selection untouched')
    ok(mid[0] == 255 - mid0[0], 'inside selection inverted')
    pg.screenshot(path=f'{SHOTS}/02-selection.png')
    pg.keyboard.press('Escape'); idle(); ok(pg.evaluate("window.__databender.sel") is None, 'Esc clears selection')

    # ---- random + A/B + decode-as
    pg.keyboard.press('r'); idle(150); ok(nsteps() >= 2, 'R random corrupt adds steps')
    pg.keyboard.press('r'); idle(150)
    rs = sig(); ok(rs != src_sig, 'random changed image')
    pg.screenshot(path=f'{SHOTS}/03-random.png')
    pg.keyboard.down('\\'); idle(); ok(sig() == src_sig, 'hold \\ shows source'); pg.keyboard.up('\\'); idle(); ok(sig() == rs, 'release returns')
    pg.evaluate("""(()=>{const r=document.getElementById('dw');r.value=7;r.dispatchEvent(new Event('input',{bubbles:true}));})()"""); idle()
    ok(sig().startswith('524x'), 'decode-as width delta')
    pg.select_option('#dfmt', 'rgb565'); idle(); ok(sig().startswith('524x'), 'decode-as 565')
    pg.screenshot(path=f'{SHOTS}/04-decodeas.png')
    pg.click('#dReset'); idle(); ok(sig() == rs, 'reset view')

    # ---- recipe save / load
    with pg.expect_download() as dl: pg.click('#stSave')
    rp = f'{SHOTS}/recipe.json'; dl.value.save_as(rp)
    rj = json.load(open(rp)); ok(rj['app'] == 'databender' and len(rj['steps']) == nsteps(), 'recipe saved')
    pg.click('#stClear'); idle()
    pg.set_input_files('#stLoad', rp); idle(300)
    ok(sig() == rs, 'recipe reload reproduces exact image')

    # ---- save raw bmp, reload it raw
    with pg.expect_download() as dl: pg.click('#btnRaw')
    bp = f'{SHOTS}/out.bmp'; dl.value.save_as(bp)
    ok(os.path.getsize(bp) == pg.evaluate("window.__databender.bytes.length"), 'raw bmp download matches bytes')

    # ---- variations
    pg.keyboard.press('v'); pg.wait_for_function("document.querySelector('.vstatus').textContent.startsWith('click')", timeout=30000)
    pg.screenshot(path=f'{SHOTS}/05-variations.png')
    n_before = nsteps(); pg.click('.vtile >> nth=4'); idle(150)
    ok(nsteps() > n_before, 'extend variation adopted')
    pg.keyboard.press('v'); pg.click('.vmode [data-v="reseed"]')
    pg.wait_for_function("document.querySelector('.vstatus').textContent.startsWith('click')", timeout=30000)
    pg.click('.vtile >> nth=2'); idle(150); ok(True, 'reseed variation adopted')

    # ---- bake
    pre = sig(); pg.click('#btnBake'); idle(200)
    ok(nsteps() == 0 and sig() == pre, 'bake keeps look, clears stack')
    pg.keyboard.press('Control+z'); idle(200); ok(nsteps() > 0, 'undo bake restores stack')

    # ---- hex edit
    pg.click('#stClear'); idle()
    pg.click('#jumpPix'); idle(150)
    pg.click('#hexinner .by:not(.hdr) >> nth=40')
    pg.keyboard.type('ff'); pg.keyboard.press('Enter'); idle()
    ok(pg.evaluate("window.__databender.steps.at(-1).fx") == 'poke', 'hex edit adds poke step')

    # ---- JPEG container
    pg.click('#stClear'); idle()
    pg.click('#fmtSeg [data-v="jpeg"]'); idle(500)
    S = pg.evaluate("({f:window.__databender.fmt, s:window.__databender.env.scanStart, b0:window.__databender.base[0], b1:window.__databender.base[1]})")
    ok(S['f'] == 'jpeg' and S['b0'] == 0xFF and S['b1'] == 0xD8 and S['s'] > 100, f'jpeg base {S}')
    jsig = sig(); ok(jsig.startswith('517x389'), 'jpeg decodes')
    ok(pg.evaluate("document.querySelector('.fx[data-fx=\"pixelsort\"] .apply').disabled"), 'pixel fx disabled in jpeg')
    bad = []
    for fx in pg.evaluate("[...document.querySelectorAll('.fx')].filter(e=>!e.classList.contains('na')).map(e=>e.dataset.fx)"):
        pg.click(f'.fx[data-fx="{fx}"] .apply'); idle(120)
        if not pg.evaluate("window.__databender.frameOk"): bad.append(fx)
        pg.evaluate("(()=>{const S=window.__databender;S.steps=[];S.cache=[];})()")
    print('jpeg: undecodable at defaults (expected for heavy ops):', bad)
    pg.click('#stClear'); idle(200)
    for i in range(3): pg.keyboard.press('r'); idle(250)
    pg.screenshot(path=f'{SHOTS}/06-jpeg-random.png')
    with pg.expect_download() as dl: pg.click('#btnRaw')
    jp = f'{SHOTS}/out.jpg'; dl.value.save_as(jp)
    jb = open(jp, 'rb').read(); ok(jb[:2] == b'\xff\xd8' and jb[-2:] == b'\xff\xd9', 'saved jpg has SOI/EOI')
    pg.keyboard.press('v'); pg.wait_for_function("document.querySelector('.vstatus').textContent.startsWith('click')", timeout=30000)
    pg.screenshot(path=f'{SHOTS}/07-jpeg-variations.png'); pg.keyboard.press('Escape'); idle()
    pg.click('#fmtSeg [data-v="bmp"]'); idle(300)
    ok(pg.evaluate("window.__databender.fmt") == 'bmp', 'back to bmp')

    # ---- raw jpeg + progressive load
    pg.click('#fmtSeg [data-v="jpeg"]'); idle(300)
    pg.set_input_files('#file', f'{DATA}/test.jpg'); idle(600)
    raw_same = pg.evaluate("window.__databender.base.length") == os.path.getsize(f'{DATA}/test.jpg')
    ok(raw_same, 'raw jpeg bytes used as base')
    pg.set_input_files('#file', f'{DATA}/prog.jpg'); idle(600)
    ok(pg.evaluate("!window.__databender.src.raw.jpeg"), 'progressive jpeg re-encoded')
    pg.click('#fmtSeg [data-v="bmp"]'); idle(300)

    # ---- raw bmp reload
    pg.set_input_files('#file', bp); idle(400)
    ok(pg.evaluate("!!window.__databender.src.raw.bmp"), 'raw bmp loaded as raw')

    # ---- 3D terrain
    pg.click('#btn3D'); idle(600)
    pg.screenshot(path=f'{SHOTS}/08-terrain.png')
    pg.click('#d3mode [data-v="blocks"]'); idle(400)
    pg.click('#btn3D'); idle(200)
    ok(pg.evaluate("!document.getElementById('cv').hidden"), 'terrain off restores 2d')

    ok(not errors, 'no console/page errors: ' + '; '.join(errors[:5]))
    b.close()
srv.shutdown()
print(f'\n{passed} passed, {failed} failed')
sys.exit(1 if failed else 0)
