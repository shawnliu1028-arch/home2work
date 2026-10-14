"""One bounded native-renderer check; preserve diagnostic results on failure."""
from pathlib import Path
import importlib.util, subprocess, json, re
BASE=Path(__file__).resolve().parents[1]
QA=BASE/'diagrams'/'verification'
QA.mkdir(exist_ok=True)
spec=importlib.util.spec_from_file_location('encode','C:/Users/11361/.agents/skills/vercel-labs-skills/drawio-skill/scripts/encode_drawio_url.py')
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
url=mod.encode((BASE/'diagrams'/'安全护栏接入草图.drawio').read_text(encoding='utf-8'))
cmd=['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','--headless=new','--disable-gpu','--no-first-run',f'--user-data-dir={QA/"edge-profile"}','--virtual-time-budget=10000','--dump-dom',url]
result={'native_drawio_cli_available':False,'attempt':'official viewer in Edge','timeout_seconds':30}
try:
    proc=subprocess.run(cmd,capture_output=True,timeout=30,creationflags=subprocess.CREATE_NO_WINDOW)
    dom=proc.stdout.decode('utf-8',errors='replace')
    (QA/'viewer-dom.html').write_text(dom,encoding='utf-8')
    paths=re.findall(r'<path[^>]+d="([^"]+)"',dom)
    result.update(exit_code=proc.returncode,path_count=len(paths),dom_bytes=len(dom.encode()),render_confirmed=bool(paths and '输入护栏' in dom))
except subprocess.TimeoutExpired:
    result.update(render_confirmed=False,reason='viewer timed out; no native-render success claimed')
(QA/'viewer-check.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result,ensure_ascii=False))
