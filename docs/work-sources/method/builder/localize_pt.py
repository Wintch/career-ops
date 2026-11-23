#!/usr/bin/env python3
"""Localize the labels of a catalog built by build_catalog.py (Spanish) to Brazilian Portuguese.
usage: localize_pt.py IN_DIR OUT_DIR   (copies every .md/.json, translating fixed labels only)"""
import os, re, sys, shutil

src, dst = sys.argv[1:3]
shutil.rmtree(dst, ignore_errors=True)
shutil.copytree(src, dst)

PAIRS = [
    ('Becas, subsidios y prestamos del Estado', 'Bolsas, subsídios e empréstimos do Estado'),
    ('Programas y registros del Estado', 'Programas e registros do Estado'),
    ('Premios y salones oficiales', 'Prêmios e salões oficiais'),
    ('Empleo publico y docencia', 'Emprego público e docência'),
    ('## Residencias', '## Residências'),
    ('## Convocatorias abiertas', '## Chamadas abertas'),
    ('Becas, premios y fundaciones privadas', 'Bolsas, prêmios e fundações privadas'),
    ('## Plataformas y mercados', '## Plataformas e mercados'),
    ('Musica: licencias, sesiones y circuitos', 'Música: licenciamento, sessões e circuitos'),
    ('Ensenanza en linea', 'Ensino online'),
    ('## Bolsas de trabajo', '## Bolsas de trabalho'),
    ('Capacitacion y subsidios del Estado', 'Qualificação e subsídios do Estado'),
    ('Servicios publicos de empleo', 'Serviços públicos de emprego'),
    ('## Otros', '## Outros'),
    ('Profesionales de las ciencias y de las ingenierias', 'Profissionais das ciências e das engenharias'),
    ('Profesionales de la ensenanza', 'Profissionais do ensino'),
    ('Profesionales en derecho, ciencias sociales y culturales', 'Profissionais do direito, das ciências sociais e culturais'),
    ('Otro personal de apoyo administrativo', 'Outros trabalhadores de apoio administrativo'),
    ('Personal de los servicios de proteccion', 'Trabalhadores dos serviços de proteção'),
    ('Oficiales y operarios de metalurgia, construccion mecanica y afines', 'Operários da metalurgia, construção mecânica e afins'),
    ('Operarios de procesamiento de alimentos, confeccion, ebanisteria y otros artesanos', 'Operários do processamento de alimentos, confecção, marcenaria e outros artesãos'),
    ('Suboficiales de las fuerzas armadas', 'Suboficiais e sargentos das forças armadas'),
    ('Oficiales de las fuerzas armadas', 'Oficiais das forças armadas'),
    ('Otros miembros de las fuerzas armadas', 'Outros membros das forças armadas'),
    ('Directivos de la administracion publica y legisladores', 'Dirigentes da administração pública e legisladores'),
    ('Directores administradores y comerciales', 'Diretores administrativos e comerciais'),
    ('Directores de produccion y operaciones', 'Diretores de produção e operações'),
    ('Gerentes de hoteles, restaurantes, comercios y otros servicios', 'Gerentes de hotéis, restaurantes, comércio e outros serviços'),
    ('Especialistas en organizacion de la administracion publica y de empresas', 'Especialistas em organização da administração pública e de empresas'),
    ('Profesionales de tecnologia de la informacion y las comunicaciones', 'Profissionais de tecnologia da informação e comunicação'),
    ('Profesionales de nivel medio en operaciones financieras y administrativas', 'Profissionais de nível médio em operações financeiras e administrativas'),
    ('Profesionales de nivel medio de servicios juridicos, sociales y culturales', 'Profissionais de nível médio de serviços jurídicos, sociais e culturais'),
    ('Profesionales de nivel medio de la salud', 'Profissionais de nível médio da saúde'),
    ('Profesionales de la salud', 'Profissionais da saúde'),
    ('Tecnicos de la tecnologia de la informacion y las comunicaciones', 'Técnicos de tecnologia da informação e comunicação'),
    ('Empleados contables y de registro de materiales', 'Empregados contábeis e de registro de materiais'),
    ('Trabajadores de los cuidados personales', 'Trabalhadores dos cuidados pessoais'),
    ('Agricultores y trabajadores agropecuarios calificados con destino al mercado', 'Agricultores e trabalhadores agropecuários qualificados voltados ao mercado'),
    ('Trabajadores forestales, pescadores y cazadores', 'Trabalhadores florestais, pescadores e caçadores'),
    ('Agricultores y trabajadores agropecuarios de subsistencia', 'Agricultores e trabalhadores agropecuários de subsistência'),
    ('Artesanos y operarios de las artes graficas', 'Artesãos e operários das artes gráficas'),
    ('Ensambladores', 'Montadores'),
    ('Peones agropecuarios, pesqueros y forestales', 'Trabalhadores elementares agropecuários, da pesca e florestais'),
    ('Ayudantes de preparacion de alimentos', 'Auxiliares de preparação de alimentos'),
    ('Vendedores ambulantes de servicios y de productos', 'Vendedores ambulantes de serviços e de produtos'),
    ('Recolectores de desechos y otras ocupaciones elementales', 'Coletores de resíduos e outras ocupações elementares'),
    ("Cerradas, no elegibles o inaccesibles", "Encerradas, não elegíveis ou inacessíveis"),
    # entry labels
    ("  - Que es:", "  - O que é:"),
    ("  - Requisitos:", "  - Requisitos:"),
    ("  - Sin experiencia previa: si", "  - Sem experiência prévia: sim"),
    ("  - Sin experiencia previa: no", "  - Sem experiência prévia: não"),
    ("  - Residentes en Argentina pueden postular: si", "  - Residentes no Brasil podem se candidatar: sim"),
    ("  - Residentes en Argentina pueden postular: no", "  - Residentes no Brasil podem se candidatar: não"),
    ("  - Pago o beneficio:", "  - Pagamento ou benefício:"),
    ("  - Plazo o ciclo:", "  - Prazo ou ciclo:"),
    ("  - Como postular:", "  - Como se candidatar:"),
    ("  - Lectura automatica posible:", "  - Leitura automática possível:"),
    ("  - Scanner: la plataforma ya esta soportada (ver docs/SUPPORTED_JOB_BOARDS.md)", "  - Scanner: a plataforma já é suportada (ver docs/SUPPORTED_JOB_BOARDS.md)"),
    ("  - Aclaracion:", "  - Esclarecimento:"),
    ("  - Nota de verificacion:", "  - Nota de verificação:"),
    ("  - Segunda lectura:", "  - Segunda leitura:"),
    # status labels
    ("abierta o vigente", "aberta ou vigente"),
    ("se repite (hoy sin llamado abierto)", "se repete (hoje sem chamada aberta)"),
    ("sin verificar", "não verificada"),
    ("no cargo", "não carregou"),
    ("no elegible", "não elegível"),
    ("verificada 2 veces", "verificada 2 vezes"),
    ("verificada 1 vez", "verificada 1 vez"),
    # generic fillers produced by the builder
    ("sin datos", "sem dados"),
    ("ninguna vista", "nenhuma vista"),
    ("Al 23/11/2026", "Em 23/11/2026"),
    ("al 23/11/2026", "em 23/11/2026"),
    ("Verificado el 2026-11-23", "Verificado em 2026-11-23"),
    ("Volver al indice", "Voltar ao índice"),
    ("Indice por categoria", "Índice por categoria"),
    ("Cobertura por ocupacion (clasificacion ISCO-08)", "Cobertura por ocupação (classificação ISCO-08)"),
    ("## Otros", "## Outros"),
    ("Cerradas, no elegibles o inaccesibles", "Encerradas, não elegíveis ou inacessíveis"),
    ("Fuentes transversales y de otros rubros", "Fontes transversais e de outros setores"),
    ("fuentes)", "fontes)"),
    ("Grupo ", "Grupo "),
    # categories
    ("Comercio y supermercados", "Comércio e supermercados"),
    ("Estaciones de servicio y tiendas de conveniencia", "Postos de combustível e lojas de conveniência"),
    ("Logistica, depositos y reparto", "Logística, depósitos e entregas"),
    ("Oficios y construccion", "Ofícios e construção civil"),
    ("Industria, fabricas y mantenimiento", "Indústria, fábricas e manutenção"),
    ("Gastronomia y hoteleria", "Gastronomia e hotelaria"),
    ("Salud y cuidados", "Saúde e cuidados"),
    ("Educacion y cuidado infantil", "Educação e cuidado infantil"),
    ("Servicio domestico, limpieza, seguridad y edificios", "Serviço doméstico, limpeza, segurança e condomínios"),
    ("Campo, trabajo rural y de temporada", "Campo, trabalho rural e sazonal"),
    ("Plataformas y trabajo por demanda", "Plataformas e trabalho por demanda"),
    ("Primer empleo, juventud y capacitacion", "Primeiro emprego, juventude e qualificação"),
    ("Empleo publico y concursos", "Emprego público e concursos"),
    ("Programas inclusivos y poblaciones especificas", "Programas inclusivos e populações específicas"),
    ("Servicios publicos de empleo y bolsas generales", "Serviços públicos de emprego e bolsas gerais"),
    ("Trabajo por cuenta propia y microemprendimientos", "Trabalho por conta própria e microempreendimentos"),
    ("Atencion al cliente, administracion y call centers", "Atendimento ao cliente, administração e call centers"),
    ("Trabajo remoto no tecnico", "Trabalho remoto não técnico"),
    ("Trabajo en el exterior", "Trabalho no exterior"),
]

README_FIX = [
    ("Como leer este documento", "Como ler este documento"),
    ("- **Abierta o vigente**: se vio un llamado con fecha, o un tramite que se puede iniciar en cualquier momento.",
     "- **Aberta ou vigente**: foi vista uma chamada com data, ou um procedimento que pode ser iniciado a qualquer momento."),
    ("- **Se repite**: hoy no hay llamado abierto, pero hay evidencia de un ciclo anual; conviene mirar en el mes indicado.",
     "- **Se repete**: hoje não há chamada aberta, mas há evidência de um ciclo anual; convém olhar no mês indicado."),
    ("- **Sin verificar**: la pagina no cargo o no confirmo lo declarado. No es una recomendacion.",
     "- **Não verificada**: a página não carregou ou não confirmou o que foi declarado. Não é uma recomendação."),
    ("- **Verificada 2 veces**: dos lecturas independientes de la pagina oficial; si difirieron, se uso la mas reciente y se anoto la correccion.",
     "- **Verificada 2 vezes**: duas leituras independentes da página oficial; se diferiram, usou-se a mais recente e anotou-se a correção."),
    ("- Los requisitos se transcriben tal cual los publica cada fuente. Ninguna fila supone titulo, portfolio ni trayectoria de quien consulta.",
     "- Os requisitos são transcritos como cada fonte os publica. Nenhuma linha supõe diploma, portfólio nem trajetória de quem consulta."),
    ("Cada fuente se reviso contra su pagina oficial; las abiertas y buena parte de las recurrentes se revisaron una segunda vez por separado. Los plazos cambian: antes de usar una fila, abrir el enlace y confirmar la fecha.",
     "Cada fonte foi conferida na sua página oficial; as abertas e boa parte das recorrentes foram conferidas uma segunda vez, por leitor independente. Os prazos mudam: antes de usar uma linha, abra o link e confirme a data."),
    ("## Resumen", "## Resumo"),
    ("- Fuentes: ", "- Fontes: "),
    (" Con segunda verificacion: ", " Com segunda verificação: "),
    ("Fuentes encontradas buscando especificamente los grupos de ocupaciones que la primera busqueda dejo con poca o ninguna cobertura. El codigo es el grupo de la Clasificacion Internacional Uniforme de Ocupaciones (ISCO-08).",
     "Fontes encontradas buscando especificamente os grupos de ocupações que a primeira busca deixou com pouca ou nenhuma cobertura. O código é o grupo da Classificação Internacional Uniforme de Ocupações (ISCO-08)."),
    ("Se dejan listadas para no volver a investigarlas.", "Ficam listadas para que ninguém as pesquise de novo."),
    ("Abierta o vigente:", "Aberta ou vigente:"), ("Se repite (hoy sin llamado abierto):", "Se repete (hoje sem chamada aberta):"),
    ("Sin verificar:", "Não verificada:"), ("No cargo:", "Não carregou:"), ("No elegible:", "Não elegível:"), ("Cerrada:", "Encerrada:"),
]

def tr(t):
    for a, b in README_FIX + PAIRS:
        t = t.replace(a, b)
    t = t.replace("(se repite", "(se repete").replace("(abierta", "(aberta").replace("(cerrada", "(encerrada")
    t = re.sub(r"\(cerrada,", "(encerrada,", t)
    return t

for root, _, files in os.walk(dst):
    for f in files:
        if f.endswith((".md", ".json")):
            p = os.path.join(root, f)
            t = open(p).read()
            open(p, "w").write(tr(t))
print("localized", dst)
