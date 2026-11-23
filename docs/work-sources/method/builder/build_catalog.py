#!/usr/bin/env python3
"""Build a neutral Spanish markdown catalog + JSON from verified rows and audit results.

usage: build_catalog.py ROWS.json OUT_DIR SLUG TITLE AUDIT1.json [AUDIT2.json ...]
Rows come from either workflow schema (arts: money/verifierNotes, generic: pay/notes/lane).
Audit files are lists of {name, url, a:{verdict,currentCycleOrDeadline,correction,evidence}}.
"""
import json, re, sys, collections

rows_path, out_dir, slug, title = sys.argv[1:5]
audit_paths = sys.argv[5:]
TODAY = "2026-11-23"

rows = json.load(open(rows_path))
audits = {}
for p in audit_paths:
    for x in json.load(open(p)):
        if x.get("a"):
            audits.setdefault(x["url"], []).append(x["a"])


REL = [
    (re.compile(r"\s*\((?:es decir|o sea),? (?:en|a) \d+ d[ií]as?\)", re.I), ""),
    (re.compile(r",? (?:se entiende 2026, )?(?:o sea|es decir),? en \d+ d[ií]as", re.I), ""),
    (re.compile(r",? es decir,? ayer", re.I), ", fecha ya vencida"),
    (re.compile(r"[Cc]on el cierre a una semana,"), "Con el cierre el 30/11/2026,"),
    (re.compile(r"agregadas esta semana"), "agregadas en la semana del 23/11/2026"),
    (re.compile(r"la fecha de hoy", re.I), "el 23/11/2026"),
    (re.compile(r"\bnone seen\b", re.I), "ninguna vista"),
    (re.compile(r"\b(?:hoje|agora)\b"), "em 23/11/2026"),
    (re.compile(r"\bHoy\b"), "Al 23/11/2026"),
    (re.compile(r"\bhoy\b"), "al 23/11/2026"),
    (re.compile(r"\bahora\b", re.I), "al 23/11/2026"),
    (re.compile(r"\bunknown\b"), "sin datos"),
    (re.compile(r"\bTrue\b"), "si"),
]


def _unquote_tu(t):
    parts = re.split(r'("[^"]*"|\u201c[^\u201d]*\u201d|\'[^\']{3,}\')', t)
    for i in range(0, len(parts), 2):
        parts[i] = re.sub(r"\btus\b", "sus", re.sub(r"\btu\b", "su", parts[i]))
    return "".join(parts)


def clean(t):
    if not isinstance(t, str):
        return t
    t = _unquote_tu(t)
    t = re.sub(r"\s*\(el cupo para quien vive en Gran Buenos Aires[^)]*\)", "", t)
    for rx, rep in REL:
        t = rx.sub(rep, t)
    return t.strip()


def norm(r):
    d = _norm(r)
    for k, v in list(d.items()):
        d[k] = clean(v)
    d["name"] = r["name"].strip()
    d["key"] = f"{r['url']}|{r['name'].strip()}"
    return d


def _norm(r):
    return {
        "elig": r.get("eligibleFromArgentina", ""),
        "name": r["name"],
        "url": r["url"],
        "kind": r.get("kind", "other"),
        "lane": r.get("lane") or r.get("discipline", ""),
        "region": r.get("region", ""),
        "who": r.get("who", ""),
        "requirements": r.get("requirements", ""),
        "pay": r.get("pay") or r.get("money", ""),
        "cycle": r.get("cycleOrDeadline", ""),
        "apply": r.get("apply", ""),
        "feed": r.get("machineReadable", "unknown"),
        "status": r.get("status", "unverifiable"),
        "notes": r.get("notes") or r.get("verifierNotes", ""),
        "entryLevel": r.get("entryLevel", ""),
    }


KIND_TITLE = collections.OrderedDict([
    ("gov-grant", "Becas, subsidios y prestamos del Estado"),
    ("gov-program", "Programas y registros del Estado"),
    ("gov-prize-or-salon", "Premios y salones oficiales"),
    ("gov-job-or-teaching", "Empleo publico y docencia"),
    ("gov-public-job", "Empleo publico"),
    ("gov-employment-service", "Servicios publicos de empleo"),
    ("gov-training-or-subsidy", "Capacitacion y subsidios del Estado"),
    ("residency", "Residencias"),
    ("open-call", "Convocatorias abiertas"),
    ("private-grant-or-prize", "Becas, premios y fundaciones privadas"),
    ("employer-careers", "Empleadores con pagina de postulacion"),
    ("staffing-agency", "Agencias de empleo"),
    ("union-or-training-institute", "Sindicatos e institutos de formacion"),
    ("marketplace", "Plataformas y mercados"),
    ("gig-platform", "Plataformas de trabajo por demanda"),
    ("music-work", "Musica: licencias, sesiones y circuitos"),
    ("teaching-online", "Ensenanza en linea"),
    ("job-board", "Bolsas de trabajo"),
    ("microenterprise-support", "Apoyo a emprendimientos"),
    ("visa-or-abroad-program", "Trabajo en el exterior"),
    ("community-channel", "Canales comunitarios"),
    ("other", "Otros"),
])
STATUS_LABEL = {
    "verified-open": "abierta o vigente",
    "verified-recurring": "se repite (hoy sin llamado abierto)",
    "unverifiable": "sin verificar",
    "no-verdict": "sin verificar",
    "unreachable": "no cargo",
    "not-eligible": "no elegible",
    "closed": "cerrada",
}
ORDER = ["verified-open", "verified-recurring", "unverifiable", "no-verdict", "unreachable", "not-eligible", "closed"]
PERSONAL = re.compile(r"\b(vos|tu|tus|postulate|fijate|aplicá|elegí|mirá|sos|tenés|podés|voc[eê])\b", re.I)
PT_VOICE = re.compile(r"\b(consegui|verifiquei|busquei|confirmei|encontrei|consultei|tentei|abri|amanh[ãa]|ontem|esta semana)\b", re.I)

items = []
flags = []
for r in rows:
    n = norm(r)
    au = audits.get(r["url"], [])
    n["checks"] = 1 + len(au)
    n["audit"] = []
    for a in au:
        if a["verdict"] == "cannot-check":
            n["audit"].append("la segunda lectura no pudo cargar la pagina")
            continue
        if a.get("currentCycleOrDeadline") and a["verdict"] in ("partly-wrong", "wrong"):
            n["cycle"] = a["currentCycleOrDeadline"]
        if a["verdict"] in ("partly-wrong", "wrong") and a.get("correction"):
            n["audit"].append(a["correction"])
        if a["verdict"] == "wrong":
            n["status"] = "closed"
        if a["verdict"] == "confirmed" and a.get("correction") and not a["correction"].lower().startswith("sin correc"):
            n["audit"].append(a["correction"])
    n["double_checked"] = any(a["verdict"] != "cannot-check" for a in au)
    blob = " ".join(str(v) for v in n.values() if isinstance(v, str))
    if PERSONAL.search(blob):
        flags.append(n["name"])
    items.append(n)

import os as _os
CAV = {}
dropped = []
if _os.environ.get("CAVEATS"):
    CAV = json.load(open(_os.environ["CAVEATS"]))
    NUM = re.compile(r"\d+")
    URL = re.compile(r"https?://[^\s)>,;]+|[\w.+-]+@[\w-]+\.[\w.-]+")
    FIRST = re.compile(r"\b(pude|puedo|abri|abr\u00ed|lei|le\u00ed|verifiqu\u00e9|busqu\u00e9|confirm\u00e9|encontr\u00e9|consult\u00e9|intent\u00e9)\b", re.I)
    for i, n in enumerate(items):
        src = " ".join([n.get(k, "") for k in ("who", "requirements", "pay", "cycle", "apply", "notes", "feed", "name")] + n["audit"])
        src_nums = set(NUM.findall(src)) | {"2026", "11", "23"}
        kept = []
        for c in CAV.get(n["key"], CAV.get(str(i), [])):
            raw = re.sub(r'"[^"]*"|\u201c[^\u201d]*\u201d|\u00ab[^\u00bb]*\u00bb', "", c)
            c = clean(c)
            bad = None
            if not set(NUM.findall(c)) <= src_nums: bad = "number"
            elif any(u.rstrip(".") not in src for u in URL.findall(c)): bad = "url"
            elif PERSONAL.search(raw) or FIRST.search(raw) or PT_VOICE.search(raw) or re.search(r"para (el|su|tu) perfil|relevante para", raw, re.I): bad = "voice"
            if bad: dropped.append((i, n["name"][:40], bad, c[:90]))
            else: kept.append(c)
        n["caveats"] = kept
        n["notes"] = ""
        n["audit"] = []

if _os.environ.get("STATUS_OVERRIDES"):
    OV = json.load(open(_os.environ["STATUS_OVERRIDES"]))
    for n in items:
        for pref, st in OV.items():
            if n["name"].startswith(pref):
                n["status"] = st

if _os.environ.get("SUPPORTED_HOSTS"):
    from urllib.parse import urlparse
    SH = set(json.load(open(_os.environ["SUPPORTED_HOSTS"])))
    for n in items:
        try: h = re.sub(r"^www\.", "", urlparse(n["url"]).hostname or "")
        except Exception: h = ""
        n["scanner_supported"] = any(h == x or h.endswith("." + x) for x in SH)

if _os.environ.get("DROP_NAMES"):
    DN = set(json.load(open(_os.environ["DROP_NAMES"])))
    items = [n for n in items if n["name"][:60] not in DN]

by_kind = collections.defaultdict(list)
for n in items:
    by_kind[n["kind"]].append(n)

counts = collections.Counter(n["status"] for n in items)
dc = sum(1 for n in items if n["double_checked"])

md = [f"# {title}", ""]
md += [
    f"Verificado el {TODAY}. Cada fuente se reviso contra su pagina oficial; las abiertas y buena parte de las recurrentes se revisaron una segunda vez por separado. "
    "Los plazos cambian: antes de usar una fila, abrir el enlace y confirmar la fecha.",
    "",
    "## Como leer este documento",
    "",
    "- **Abierta o vigente**: se vio un llamado con fecha, o un tramite que se puede iniciar en cualquier momento.",
    "- **Se repite**: hoy no hay llamado abierto, pero hay evidencia de un ciclo anual; conviene mirar en el mes indicado.",
    "- **Sin verificar**: la pagina no cargo o no confirmo lo declarado. No es una recomendacion.",
    "- **Verificada 2 veces**: dos lecturas independientes de la pagina oficial; si difirieron, se uso la mas reciente y se anoto la correccion.",
    "- Los requisitos se transcriben tal cual los publica cada fuente. Ninguna fila supone titulo, portfolio ni trayectoria de quien consulta.",
    "",
    "## Resumen",
    "",
    f"- Fuentes: {len(items)}. Con segunda verificacion: {dc}.",
]
for s in ORDER:
    if counts.get(s):
        md.append(f"- {STATUS_LABEL[s].capitalize()}: {counts[s]}.")
md.append("")

def entry(n):
    out = []
    tag = "verificada 2 veces" if n["double_checked"] else "verificada 1 vez"
    out.append(f"- **{n['name']}** ({STATUS_LABEL.get(n['status'], n['status'])}, {tag}) {n['url']}")
    if n["who"]: out.append(f"  - Que es: {n['who']}")
    if n["requirements"]: out.append(f"  - Requisitos: {n['requirements']}")
    if n["entryLevel"] in ("yes", "no"): out.append(f"  - Sin experiencia previa: {'si' if n['entryLevel']=='yes' else 'no'}")
    if n.get("elig") in ("yes", "no"): out.append(f"  - Residentes en Argentina pueden postular: {'si' if n['elig']=='yes' else 'no'}")
    if n["pay"]: out.append(f"  - Pago o beneficio: {n['pay']}")
    if n["cycle"]: out.append(f"  - Plazo o ciclo: {n['cycle']}")
    if n["apply"]: out.append(f"  - Como postular: {n['apply']}")
    if n.get("scanner_supported"): out.append("  - Scanner: la plataforma ya esta soportada (ver docs/SUPPORTED_JOB_BOARDS.md)")
    elif n["feed"] and n["feed"] != "unknown": out.append(f"  - Lectura automatica posible: {n['feed']}")
    if n["notes"]: out.append(f"  - Nota de verificacion: {n['notes']}")
    for c in n.get("caveats", []):
        out.append(f"  - Aclaracion: {c}")
    for a in n["audit"]:
        out.append(f"  - Segunda lectura: {clean(a)}")
    return out

active = [n for n in items if n["status"] in ("verified-open", "verified-recurring", "unverifiable", "no-verdict")]
dead = [n for n in items if n["status"] in ("unreachable", "not-eligible", "closed")]

LANE_TITLES = collections.OrderedDict([
    ("retail", "Comercio y supermercados"), ("fuel", "Estaciones de servicio y tiendas de conveniencia"),
    ("logistics", "Logistica, depositos y reparto"), ("trades", "Oficios y construccion"),
    ("industry", "Industria, fabricas y mantenimiento"), ("hospitality", "Gastronomia y hoteleria"),
    ("care", "Salud y cuidados"), ("education", "Educacion y cuidado infantil"),
    ("domestic-security", "Servicio domestico, limpieza, seguridad y edificios"),
    ("agri-seasonal", "Campo, trabajo rural y de temporada"), ("gig", "Plataformas y trabajo por demanda"),
    ("first-job", "Primer empleo, juventud y capacitacion"), ("public-sector", "Empleo publico y concursos"),
    ("inclusive", "Programas inclusivos y poblaciones especificas"),
    ("employment-services", "Servicios publicos de empleo y bolsas generales"),
    ("self-employment", "Trabajo por cuenta propia y microemprendimientos"),
    ("call-center-admin", "Atencion al cliente, administracion y call centers"),
    ("remote-nontech", "Trabajo remoto no tecnico"), ("abroad", "Trabajo en el exterior"),
])
if _os.environ.get("GROUP") == "lane":
    for lane, ltitle in LANE_TITLES.items():
        ns = [n for n in active if n["lane"] == lane]
        if not ns: continue
        ns.sort(key=lambda n: ORDER.index(n["status"]))
        md += [f"## {ltitle}", ""]
        for n in ns: md += entry(n)
        md.append("")
    ISCO_TITLES = {
        "01": "Oficiales de las fuerzas armadas", "02": "Suboficiales de las fuerzas armadas", "03": "Otros miembros de las fuerzas armadas",
        "11": "Directivos de la administracion publica y legisladores", "12": "Directores administradores y comerciales",
        "13": "Directores de produccion y operaciones", "14": "Gerentes de hoteles, restaurantes, comercios y otros servicios",
        "22": "Profesionales de la salud", "24": "Especialistas en organizacion de la administracion publica y de empresas",
        "25": "Profesionales de tecnologia de la informacion y las comunicaciones", "32": "Profesionales de nivel medio de la salud",
        "33": "Profesionales de nivel medio en operaciones financieras y administrativas",
        "34": "Profesionales de nivel medio de servicios juridicos, sociales y culturales",
        "35": "Tecnicos de la tecnologia de la informacion y las comunicaciones",
        "43": "Empleados contables y de registro de materiales", "53": "Trabajadores de los cuidados personales",
        "61": "Agricultores y trabajadores agropecuarios calificados con destino al mercado",
        "62": "Trabajadores forestales, pescadores y cazadores", "63": "Agricultores y trabajadores agropecuarios de subsistencia",
        "73": "Artesanos y operarios de las artes graficas", "82": "Ensambladores",
        "92": "Peones agropecuarios, pesqueros y forestales", "94": "Ayudantes de preparacion de alimentos",
        "95": "Vendedores ambulantes de servicios y de productos",
        "21": "Profesionales de las ciencias y de las ingenierias", "23": "Profesionales de la ensenanza",
        "26": "Profesionales en derecho, ciencias sociales y culturales", "44": "Otro personal de apoyo administrativo",
        "54": "Personal de los servicios de proteccion", "72": "Oficiales y operarios de metalurgia, construccion mecanica y afines",
        "75": "Operarios de procesamiento de alimentos, confeccion, ebanisteria y otros artesanos", "96": "Recolectores de desechos y otras ocupaciones elementales",
    }
    isco_lanes = sorted({n["lane"] for n in active if n["lane"].startswith("isco-")})
    if isco_lanes:
        md += ["## Cobertura por ocupacion (clasificacion ISCO-08)", "",
               "Fuentes encontradas buscando especificamente los grupos de ocupaciones que la primera busqueda dejo con poca o ninguna cobertura. El codigo es el grupo de la Clasificacion Internacional Uniforme de Ocupaciones (ISCO-08).", ""]
        for lane in isco_lanes:
            code = lane.split("-")[1]
            ns = [n for n in active if n["lane"] == lane]
            ns.sort(key=lambda n: ORDER.index(n["status"]))
            md += [f"### Grupo {code}: {ISCO_TITLES.get(code, code)}", ""]
            for n in ns: md += entry(n)
            md.append("")
    rest = [n for n in active if n["lane"] not in LANE_TITLES and not n["lane"].startswith("isco-")]
    if rest:
        md += ["## Fuentes transversales y de otros rubros", ""]
        kinds = list(KIND_TITLE.keys())
        rest.sort(key=lambda n: (kinds.index(n["kind"]) if n["kind"] in kinds else 99, ORDER.index(n["status"])))
        for n in rest: md += entry(n)
        md.append("")
else:
    for kind, ktitle in KIND_TITLE.items():
        ns = [n for n in by_kind.get(kind, []) if n in active]
        if not ns: continue
        ns.sort(key=lambda n: ORDER.index(n["status"]))
        md += [f"## {ktitle}", ""]
        for n in ns: md += entry(n)
        md.append("")

if dead:
    md += ["## Cerradas, no elegibles o inaccesibles", "", "Se dejan listadas para no volver a investigarlas.", ""]
    for n in sorted(dead, key=lambda n: ORDER.index(n["status"])):
        md.append(f"- **{n['name']}** ({STATUS_LABEL.get(n['status'], n['status'])}) {n['url']}")
        if n["cycle"]: md.append(f"  - Plazo o ciclo: {n['cycle']}")
        if n["notes"]: md.append(f"  - Nota: {n['notes']}")
        for c in n.get("caveats", [])[:2]: md.append(f"  - Aclaracion: {c}")
    md.append("")

import os
os.makedirs(out_dir, exist_ok=True)
open(f"{out_dir}/{slug}.md", "w").write("\n".join(md) + "\n")
json.dump({"verified_on": TODAY, "title": title, "items": [{k: v for k, v in n.items() if k != "key"} for n in items]}, open(f"{out_dir}/{slug}.json", "w"), ensure_ascii=False, indent=1)
if dropped:
    print("DROPPED", len(dropped))
    for d in dropped[:40]: print("  ", d)
print(json.dumps({"items": len(items), "double_checked": dc, "counts": counts, "voseo_flags": flags[:20]}, ensure_ascii=False))
