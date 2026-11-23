import json,re,sys
task_out,rows_file,prev_keys,out_keys,out_drop=sys.argv[1:6]
o=json.load(open(task_out))['result']; rows=json.load(open(rows_file))
print(o['requested'],o['returned'],o['missingSlices'])
byidx={x['index']:x['caveats'] for x in o['rows']}
cav=json.load(open(prev_keys)) if prev_keys!='-' else {}
for i,r in enumerate(rows): cav[f"{r['url']}|{r['name'].strip()}"]=byidx.get(i,[])
json.dump(cav,open(out_keys,'w'),ensure_ascii=False)
pat=re.compile(r'no incluir|no debe (?:incluirse(?! como ruta confirmada)|listarse)|no corresponde a una fuente|no es una fuente de empleo|se recomienda retirarla|no sirve como ruta de empleo|fuera del alcance|no sirve como fuente de empleo|biblioteca de referencia|n[aã]o (deve ser )?inclu|forma[çc][ãa]o pol[íi]tica',re.I)
drop=[rows[i]['name'][:60] for i,cs in byidx.items() if any(pat.search(c) for c in cs)]
json.dump(drop,open(out_drop,'w'),ensure_ascii=False); print('drop',drop)
