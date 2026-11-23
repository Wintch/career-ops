import re,os,sys,unicodedata,shutil
src_path,out,lang=sys.argv[1:4]
L={'es':dict(skip=('## Como leer este documento','## Resumen'),back='Volver al indice',ver='Verificado el 2026-11-23. Los plazos cambian: confirmar la fecha en el enlace antes de usar una fila.',idx='Indice por categoria',other='Otros',src='fuentes',src1='fuente',tail=('Fuentes transversales','Cerradas')),
   'pt':dict(skip=('## Como ler este documento','## Resumo'),back='Voltar ao índice',ver='Verificado em 2026-11-23. Os prazos mudam: confirme a data no link antes de usar uma linha.',idx='Índice por categoria',other='Outros',src='fontes',src1='fonte',tail=('Fontes transversais','Encerradas'))}[lang]
src=open(src_path).read().split('\n')
def slug(t):
    t=unicodedata.normalize('NFD',t.lower()); t=re.sub(r'[̀-ͯ]','',t)
    return re.sub(r'[^a-z0-9]+','-',t).strip('-')[:55]
secs=[];cur=None;pre=[]
for ln in src:
    if ln.startswith('## ') and ln not in L['skip']:
        cur=[ln]; secs.append(cur)
    elif cur is None: pre.append(ln)
    else: cur.append(ln)
shutil.rmtree(out,ignore_errors=True); os.makedirs(out)
HDR=f"[{L['back']}](README.md) | {L['ver']}"
cnt=lambda b: sum(1 for l in b if re.match(r'^- \*\*',l))
toc=[]; isco=[]; isco_intro=''
for i,s in enumerate(secs,1):
    t=s[0][3:]; b=s[1:]
    if t.startswith('Cobertura por ocupa'):
        intro=[];grp=None;groups=[]
        for l in b:
            if l.startswith('### '): grp=[l]; groups.append(grp)
            elif grp is None: intro.append(l)
            else: grp.append(l)
        for g in groups:
            tt=g[0][4:]; code=re.match(r'Grupo (\d+)',tt).group(1)
            fn=f"{i:02d}-isco-{code}-{slug(tt.split(':',1)[1])}.md"
            open(f"{out}/{fn}",'w').write('\n'.join([f"# {tt}","",HDR,""]+g[1:]).rstrip()+'\n'); isco.append((tt,fn,cnt(g)))
        isco_title=t; isco_intro='\n'.join(intro).strip(); continue
    fn=f"{i:02d}-{slug(t)}.md"
    open(f"{out}/{fn}",'w').write('\n'.join([f"# {t}","",HDR,""]+b).rstrip()+'\n'); toc.append((t,fn,cnt(b)))
idx=pre+['',f"## {L['idx']}",'']
main=[x for x in toc if not x[0].startswith(L['tail'])]; tail=[x for x in toc if x[0].startswith(L['tail'])]
for t,fn,n in main: idx.append(f"- [{t}]({fn}) ({n} {L['src1'] if n==1 else L['src']})")
if isco:
    idx+=['',f"## {isco_title}",'',isco_intro,'']
    for tt,fn,n in isco: idx.append(f"- [{tt}]({fn}) ({n} {L['src1'] if n==1 else L['src']})")
idx+=['',f"## {L['other']}",'']
for t,fn,n in tail: idx.append(f"- [{t}]({fn}) ({n} {L['src1'] if n==1 else L['src']})")
open(f"{out}/README.md",'w').write('\n'.join(idx).rstrip()+'\n')
print(len(os.listdir(out)),'files; largest',sorted(((os.path.getsize(f"{out}/{f}")//1024,f) for f in os.listdir(out)),reverse=True)[:3])
