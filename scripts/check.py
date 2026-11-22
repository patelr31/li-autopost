"""Pre-flight checks for LinkedIn drafts: spelling, AI-sounding phrases, UK/US spelling mix,
broken links, doubled words, length and hashtag count.

Usage:  python3 scripts/check.py                 # checks scripts/drafts.json
        python3 scripts/check.py some.json       # any [{title, body}] file
Spelling uses the macOS system dictionary (en_US) through JavaScript for Automation, so it
runs only on a Mac. Exit code 1 if anything needs a look.
"""
import json, re, subprocess, sys, urllib.request
from pathlib import Path

# Domain words the system dictionary doesn't know.
KNOWN = set("""
DecodeMyBill CivicFeed Medicaid Medicare MBBS CPT CMS ER ICD CM FHIR LOINC Ayush Prakriti
Ashtavidha SIH SIH26047 MedTech Razorpay ABN PR CO N115 LCD remittance interoperability
deduplication Ottawa oxycodone opioid synthetic Co-pilot pre post-acute hospital–nursing
""".split())

TYPOS = {"teh", "hte", "adn", "taht", "wiht", "thier", "fo", "ot", "si", "nad", "yuo", "tehre"}

AI_TELLS = [
    "delve", "tapestry", "testament to", "game-changer", "game changer", "in today's", "unlock",
    "leverage", "seamless", "robust", "it's not just", "not just about", "here's the thing",
    "excited to share", "thrilled", "journey", "landscape", "revolutioniz", "empower",
    "cutting-edge", "dive into", "deep dive", "harness", "elevate", "supercharge", "—",
]
UK_US = {
    "summarise": "summarize", "summarising": "summarizing", "organisation": "organization",
    "digitisation": "digitization", "maths": "math", "colour": "color", "behaviour": "behavior",
    "analyse": "analyze", "practise": "practice", "optimise": "optimize", "prioritise": "prioritize",
    "recognise": "recognize", "centre": "center", "programme": "program", "favour": "favor",
}

JXA = r"""
function run(argv) {
  ObjC.import("AppKit");
  const c = $.NSSpellChecker.sharedSpellChecker; c.setLanguage("en_US");
  return JSON.stringify(JSON.parse(argv[0]).filter((w) => c.checkSpellingOfStringStartingAt(w, 0).length > 0));
}
"""

def misspelled(text: str) -> list[str]:
    text = re.sub(r"https?://\S+|#\w+", " ", text)
    words = {w.strip("'’-") for w in re.findall(r"[A-Za-z][A-Za-z'’-]*", text)}
    words = {w for w in words if w and w not in KNOWN and re.sub(r"[’']s$", "", w) not in KNOWN and not re.fullmatch(r"[A-Z]{2,}s?", w)}
    # Check each part of hyphenated words separately (e.g. "corrected-claim").
    parts = sorted({p for w in words for p in w.split("-") if p and p not in KNOWN})
    raw = subprocess.run(["osascript", "-l", "JavaScript", "-e", JXA, json.dumps(parts)], capture_output=True, text=True, check=True).stdout
    return sorted(set(json.loads(raw)) | {w for w in words if w.lower() in TYPOS})

def link_ok(url: str) -> bool:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (link check)"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status < 400
    except Exception:
        return False

def check(title: str, body: str) -> list[str]:
    issues = []
    if not 1 <= len(body) <= 3000: issues.append(f"length {len(body)} (LinkedIn allows 1–3000)")
    tags = re.findall(r"#\w+", body)
    if len(tags) > 5: issues.append(f"{len(tags)} hashtags (keep to 5 or fewer)")
    if w := misspelled(body): issues.append("spelling: " + ", ".join(w))
    low = body.lower()
    if t := [p for p in AI_TELLS if p in low]: issues.append("sounds AI-written: " + ", ".join(repr(p) for p in t))
    if u := [f"{k}→{v}" for k, v in UK_US.items() if re.search(rf"\b{k}\b", low)]: issues.append("UK spelling: " + ", ".join(u))
    if d := re.findall(r"\b(\w+)\s+\1\b", body, re.I): issues.append("doubled word: " + ", ".join(d))
    for url in re.findall(r"https?://[^\s)]+", body):
        if not link_ok(url.rstrip(".,")): issues.append(f"link not loading: {url}")
    return issues

if __name__ == "__main__":
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "drafts.json"
    bad = 0
    for d in json.loads(path.read_text()):
        issues = check(d["title"], d["body"])
        print(("✗ " if issues else "✓ ") + d["title"])
        for i in issues: print("    " + i)
        bad += bool(issues)
    sys.exit(1 if bad else 0)
