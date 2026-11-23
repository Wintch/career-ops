import json,sys
task_out,urls_file,out_file=sys.argv[1:4]
o=json.load(open(task_out))['result']; urls=json.load(open(urls_file))
res=sorted([x for x in o['results'] if x['index']<len(urls)],key=lambda x:x['index'])
seen=set();out=[]
for x in res:
    if x['index'] in seen: continue
    seen.add(x['index']); out.append({'name':x['name'],'url':urls[x['index']],'a':{k:x.get(k,'') for k in ('verdict','currentCycleOrDeadline','correction','evidence')}})
json.dump(out,open(out_file,'w'),ensure_ascii=False); print(out_file,len(out),o['counts'])
