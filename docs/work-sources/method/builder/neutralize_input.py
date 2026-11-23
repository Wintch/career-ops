"""usage: neutralize_input.py ROWS.json OUT.json AUDIT1.json [AUDIT2.json ...]
Builds {"items":[...]} for neutralize-catalog-notes.js: per row its notes plus the audit remarks,
in the same order as ROWS (indices in the workflow output refer to this order)."""
import json, sys
rows = json.load(open(sys.argv[1])); out = sys.argv[2]
aud = {}
for p in sys.argv[3:]:
    for x in json.load(open(p)):
        a = x.get('a') or {}
        aud.setdefault(x['url'], []).append(' | '.join(f"{k}: {a[k]}" for k in ('verdict', 'correction', 'evidence') if a.get(k)))
items = [{'name': r['name'], 'url': r['url'], 'cycle': r.get('cycleOrDeadline', ''), 'requirements': r.get('requirements', ''),
          'pay': r.get('pay', ''), 'who': r.get('who', ''), 'notes': r.get('notes', ''), 'audit': aud.get(r['url'], [])} for r in rows]
json.dump({'items': items}, open(out, 'w'), ensure_ascii=False); print(len(items))
