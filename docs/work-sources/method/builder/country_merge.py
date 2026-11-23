import json,re,sys,unicodedata,collections
def norm(u): return re.sub(r'[?#].*$','',re.sub(r'^https?://(www\.)?','',(u or '').lower())).rstrip('/')
def nk(n):
    n=unicodedata.normalize('NFD',n.lower()); n=re.sub(r'[̀-ͯ]','',n); return re.sub(r'[^a-z0-9]+',' ',n).strip()
a_path,b_out,prefix=sys.argv[1:4]
A=json.load(open(a_path)); Braw=json.load(open(b_out))['result']['rows']
idxu={norm(r['url']):r for r in A}; idxn={nk(r['name']):r for r in A}
keep=[];dups=moved=0
for b in Braw:
    a=idxu.get(norm(b['url'])) or idxn.get(nk(b['name']))
    if a:
        dups+=1
        if b['lane']!='gap' and a['lane']=='gap': a['lane']=b['lane']; moved+=1
    else: keep.append(b)
json.dump(keep,open(f'{prefix}-b-rows.json','w'),ensure_ascii=False)
json.dump(A+keep,open(f'{prefix}-all-rows.json','w'),ensure_ascii=False)
aud=[{'name':x['name'][:90],'url':x['url'],'claim':x['cycleOrDeadline'][:160]} for x in keep if x['status'] in ('verified-open','verified-recurring')]
json.dump(aud,open(f'{prefix}-b-audit-input.json','w'),ensure_ascii=False); json.dump([x['url'] for x in aud],open(f'{prefix}-b-audit-urls.json','w'))
print(prefix,'rawB',len(Braw),'dups',dups,'moved',moved,'keepB',len(keep),'all',len(A)+len(keep),'audit',len(aud),dict(collections.Counter(x['status'] for x in keep)))
