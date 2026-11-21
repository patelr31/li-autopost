"""Print SQL that loads scripts/drafts.json into li_posts (priority = file order).
Usage:  python3 scripts/seed.py > /tmp/seed.sql   (then run it in Supabase)"""
import json
from pathlib import Path

drafts = json.loads((Path(__file__).parent / "drafts.json").read_text())
q = lambda s: "'" + s.replace("'", "''") + "'"
for i, d in enumerate(drafts, 1):
    assert len(d["body"]) <= 3000, d["title"]
    print(f"insert into public.li_posts (title, body, priority) values ({q(d['title'])}, {q(d['body'])}, {i * 10});")
