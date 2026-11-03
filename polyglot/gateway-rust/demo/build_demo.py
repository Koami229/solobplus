#!/usr/bin/env python3
"""Converts the validated static mockups (no JS) into demo fragments for the Rust gateway.
Inline style="" attributes are moved to generated classes so the strict CSP (style-src 'self') holds.
Usage: build_demo.py <design-research dir>  -> writes src/demo_assets/*.html + *.css"""
import re, sys, hashlib, pathlib
SRC = pathlib.Path(sys.argv[1]); OUT = pathlib.Path(__file__).resolve().parent.parent / "src" / "demo_assets"
OUT.mkdir(exist_ok=True)
BIZ = [("1-accueil","accueil"),("2-missions","missions"),("3-parcours","parcours"),("4-entretien-ia","entretien-ia"),("5-profil","profil"),("6-annotation","annotation"),("7-espace-client","espace-client"),("8-gains","gains")]
SCH = [("02-tableau-de-bord","tableau-de-bord"),("03-solob-ai","solob-ai"),("04-library","library"),("05-mes-cours","mes-cours"),("06-espace-de-travail","espace-de-travail"),("07-quiz-examens","quiz-examens"),("08-atelier-verification","atelier-verification"),("09-videos-educatives","videos-educatives"),("10-progression","progression"),("11-langues","langues"),("01-profil","profil")]
styles = {}
def unstyle(html, prefix):
    def rep(m):
        decl = m.group(2)
        k = prefix + hashlib.sha1(decl.encode()).hexdigest()[:7]
        styles[k] = decl
        return m.group(1) + f' data-s="{k}"'
    # merge into class attr: first tag-level replace
    def tag(m):
        t = m.group(0)
        sm = re.search(r'\sstyle="([^"]*)"', t)
        if not sm: return t
        k = prefix + hashlib.sha1(sm.group(1).encode()).hexdigest()[:7]; styles[k] = sm.group(1)
        t = t.replace(sm.group(0), "")
        if re.search(r'\sclass="', t): t = re.sub(r'\sclass="([^"]*)"', lambda c: f' class="{(c.group(1)+" "+k).strip()}"', t, count=1)
        else: t = t[:-1].rstrip("/") + f' class="{k}">' if not t.endswith("/>") else t[:-2] + f' class="{k}"/>'
        return t
    return re.sub(r'<[a-zA-Z][^>]*>', tag, html)
def body(html):
    b = re.search(r'<body>(.*)</body>', html, re.S).group(1)
    return re.sub(r'<div class="fake">[^<]*</div>', '', b)
def links(html, labels_slugs, base):
    for label, slug in labels_slugs:
        html = re.sub(r'<a class="(on)?">' + re.escape(label) + '</a>', lambda m: f'<a{" class=\"on\"" if m.group(1) else ""} href="{base}/{slug}">{label}</a>', html)
    return html
def demo_cta(html):  # inert buttons become links to the demo hub explanation (no action performed)
    return re.sub(r'<a class="btn([^"]*)">', r'<a class="btn\1" href="/demo#action-demo">', html)
bnav = [("Accueil","accueil"),("Missions","missions"),("Parcours","parcours"),("Entretien IA","entretien-ia"),("Profil","profil"),("Annotation","annotation"),("Espace client","espace-client"),("Gains","gains")]
snav = [("Tableau de bord","tableau-de-bord"),("SOLOB AI","solob-ai"),("SOLOB Library","library"),("Mes cours","mes-cours"),("Mon espace de travail","espace-de-travail"),("Quiz et examens","quiz-examens"),("Atelier de vérification","atelier-verification"),("Vidéos éducatives","videos-educatives"),("Ma progression","progression"),("Langues","langues"),("Mon profil","profil")]
for f, slug in BIZ:
    h = body((SRC/"features/business-v2"/f"{f}.html").read_text())
    (OUT/f"business-{slug}.html").write_text(demo_cta(unstyle(links(h, bnav, "/demo/business"), "b")))
for f, slug in SCH:
    h = body((SRC/"features/school-v2"/f"{f}.html").read_text())
    h = re.sub(r'<p class="muted">(Verso : [^<]*)</p>', r'<details class="flip"><summary>Retourner la carte</summary><p class="muted">\1</p></details>', h)
    h = h.replace('<span class="pill y mono">⏱ 01:42:10</span>', '<span class="pill y mono">⏱ Durée : 4 h (exemple)</span>')
    (OUT/f"school-{slug}.html").write_text(demo_cta(unstyle(links(h, snav, "/demo/school"), "s")))
feat_css = (SRC/"features/school-v2/style.css").read_text()
feat_css = feat_css.replace(".fake{", ".fake-old{")
resp = "details.flip summary{cursor:pointer;color:#0B5D3B;font-weight:600;margin:6px 0}details.flip[open] summary{color:#6B645A}"+"@media(max-width:820px){.g2,.g3,.g4,.lay{grid-template-columns:1fr!important}header{flex-wrap:wrap;gap:12px;padding:12px 16px}main{padding:20px 16px}nav{display:flex;overflow-x:auto;white-space:nowrap;width:100%}.side{display:flex;overflow-x:auto;white-space:nowrap;gap:4px}h1{font-size:24px}table{display:block;overflow-x:auto}}"
gen = "".join(f".{k}{{{v}}}" for k, v in sorted(styles.items()) if k[0] in "bs")
(OUT/"demo.css").write_text(feat_css + "\n" + gen + "\n" + resp + "\n")
# homepage
styles.clear()
h = (SRC/"mockup/index.html").read_text()
hb = re.search(r'<body>(.*)</body>', h, re.S).group(1)
hmap = [('<a class="logo" href="#">', '<a class="logo" href="/">'), ('<a href="#">Entreprises</a>', '<a href="/demo/business/espace-client">Entreprises</a>'),
 ('<a class="btn" href="#">Rejoindre comme talent</a>', '<a class="btn" href="/demo/business/accueil">Rejoindre comme talent</a>'),
 ('<a class="btn ghost" href="#">Lancer un projet</a>', '<a class="btn ghost" href="/demo/business/espace-client">Lancer un projet</a>'),
 ('<a href="#"><b>Apprendre', '<a href="/demo/school/tableau-de-bord"><b>Apprendre'), ('<a href="#"><b>Travailler', '<a href="/demo/business/missions"><b>Travailler'),
 ('<a href="#"><b>Commander', '<a href="/demo/business/espace-client"><b>Commander'), ('<a href="#"><b>Contribuer', '<a href="/demo/business/annotation"><b>Contribuer'),
 ('<a class="btn" href="#">Commencer</a>', '<a class="btn" href="/demo">Commencer</a>')]
for a, b in hmap: hb = hb.replace(a, b)
assert 'href="#"' not in hb, re.findall(r'.{60}href="#".{30}', hb)
hb = unstyle(hb, "h")
(OUT/"home.html").write_text(hb)
(OUT/"home.css").write_text((SRC/"mockup/style.css").read_text() + "\n" + "".join(f".{k}{{{v}}}" for k, v in sorted(styles.items())) + "\n")
print("ok", len(list(OUT.iterdir())))
