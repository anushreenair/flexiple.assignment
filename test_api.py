#!/usr/bin/env python3
"""End-to-end test of the sourcing refinement loop API. Real LLM calls."""
import json, sys, time, urllib.request, urllib.error

BASE = "http://localhost:3000"

def req(method, path, body=None, timeout=180):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method,
                               headers={"Content-Type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read()), time.time() - t0
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}"), time.time() - t0

def check(name, cond, detail=""):
    print(("PASS" if cond else "FAIL") + f" | {name}" + (f" | {detail}" if detail else ""))
    if not cond:
        sys.exit(1)

# 0. health
s, b, dt = req("GET", "/api/health", timeout=10)
check("health ok", s == 200 and b.get("ok") is True, f"{b}")

# 1. create session with free text
FT = "RDS developers with 4-7 years of experience who have worked at startups, for a role based in Bangalore"
print(f"\n--- POST /api/session  ({FT[:60]}...)")
s, b, dt = req("POST", "/api/session", {"freeText": FT})
check("session created", s == 201, f"status={s} took {dt:.1f}s")
sess = b["session"]
sid = sess["id"]
spec = sess["spec"]
print(f"    took {dt:.1f}s")
print("    filters:", json.dumps(spec["filters"], indent=2))
print("    rubric ideal:", spec["rubric"]["ideal_profile"])
print("    criteria:", [c["name"] for c in spec["rubric"]["criteria"]])
check("filters has AWS RDS", any("rds" in x.lower() for x in (spec["filters"].get("skills") or {}).get("must_have", [])),
      json.dumps(spec["filters"].get("skills")))
check("years 4-7", (spec["filters"]["years_experience"] or {}) == {"min": 4, "max": 7}, str(spec["filters"]["years_experience"]))
check("location Bangalore", "bangalore" in [l.lower() for l in (spec["filters"]["locations"] or {}).get("values", [])], str(spec["filters"]["locations"]))
check("company startup", "startup" in (spec["filters"]["company_types"] or {}).get("values", []), str(spec["filters"]["company_types"]))
check("results non-empty", len(sess["results"]) > 0, f"{len(sess['results'])} results, filtered {sess['filteredCount']}/{sess['total']}")
check("results sorted desc", all(sess["results"][i]["score"] >= sess["results"][i+1]["score"] for i in range(len(sess["results"])-1)))
r0 = sess["results"][0]
print("    top match:", r0["profile"]["name"], r0["score"], r0["verdict"])
print("    explanation:", r0["explanation"][:200])
print("    citations:", json.dumps(r0["citations"], indent=2))
check("top match has citations", len(r0["citations"]) >= 1)
check("chat has spec_created + results", [m["kind"] for m in sess["chat"]] == ["spec_created", "results"], str([m["kind"] for m in sess["chat"]]))

# sanity: verify top result actually satisfies filters (deterministic engine)
pool = json.load(open("data/profiles.json"))
byid = {p["id"]: p for p in pool}
for r in sess["results"]:
    p = byid[r["profile_id"]]
    check(f"  {p['id']} has RDS skill", any("rds" in s.lower() for s in p["skills"]), str(p["skills"]))
    check(f"  {p['id']} years in [4,7]", 4 <= p["years_experience"] <= 7, str(p["years_experience"]))
    check(f"  {p['id']} location Bangalore", p["location"] == "Bangalore", p["location"])
    check(f"  {p['id']} startup any", p["current_company_type"] == "startup" or any(pc["company_type"] == "startup" for pc in p["past_companies"]))

# 2. feedback refine: reject the most junior shown profile as "too junior", accept the most senior.
#    Coherent signal => the engine should raise the years floor or otherwise drop the junior one.
print("\n--- POST /api/session/{sid}/feedback")
shown = sess["results"][:5]
no_pick = min(shown, key=lambda r: r["profile"]["years_experience"])
yes_pick = max(shown, key=lambda r: r["profile"]["years_experience"])
fb = (f"#{no_pick['rank']} is too junior for this role — I need people who have owned things end to end. "
      f"#{yes_pick['rank']} is exactly right, more like that.")
verdicts = {no_pick["profile_id"]: "no", yes_pick["profile_id"]: "yes"}
s, b, dt = req("POST", f"/api/session/{sid}/feedback", {"message": fb, "verdicts": verdicts})
check("feedback accepted", s == 200, f"status={s} took {dt:.1f}s")
sess2 = b["session"]
print(f"    took {dt:.1f}s")
print("    round:", sess2["round"], "filtered:", sess2["filteredCount"])
refined_msg = [m for m in sess2["chat"] if m["kind"] == "refined"][-1]
print("    refine summary:", refined_msg["text"])
print("    changes:", json.dumps(refined_msg["changes"], indent=2))
check("round advanced", sess2["round"] == 2)
yrs_before = spec["filters"].get("years_experience") or {}
yrs_after = sess2["spec"]["filters"].get("years_experience") or {}
spec_changed = sess2["spec"] != spec
responded = spec_changed or all(r["profile_id"] != no_pick["profile_id"] for r in sess2["results"])
check("refinement responded to feedback", responded,
      f"spec_changed={spec_changed}, junior gone={all(r['profile_id'] != no_pick['profile_id'] for r in sess2['results'])}")
if spec_changed and (yrs_after.get("min") or 0) != (yrs_before.get("min") or 0):
    check("years floor moved the right way", (yrs_after.get("min") or 0) > no_pick["profile"]["years_experience"] - 1,
          f"min {yrs_before.get('min')} -> {yrs_after.get('min')}, rejected had {no_pick['profile']['years_experience']}y")
check("why-fields are concise (no reasoning traces)", all(len(c["why"]) <= 220 for m in sess2["chat"] if m["kind"] == "refined" for c in (m.get("changes") or [])))
check("recruiter msg in chat", any(m["role"] == "recruiter" for m in sess2["chat"]))
check("new results present", len(sess2["results"]) > 0, f"{len(sess2['results'])}")
check("accepted senior still present", any(r["profile_id"] == yes_pick["profile_id"] for r in sess2["results"]),
      "the YES profile should survive refinement")

# 3. manual spec edit (PUT) — loosen years max
print("\n--- PUT /api/session/{sid}/spec")
edited = json.loads(json.dumps(sess2["spec"]))
edited["filters"]["years_experience"]["max"] = None
s, b, dt = req("PUT", f"/api/session/{sid}/spec", {"spec": edited})
check("edit accepted", s == 200, f"status={s} took {dt:.1f}s")
sess3 = b["session"]
check("round advanced after edit", sess3["round"] == 3, str(sess3["round"]))
check("max is null now", (sess3["spec"]["filters"]["years_experience"] or {}).get("max") is None)

# invalid spec -> 400
s, b, dt = req("PUT", f"/api/session/{sid}/spec", {"spec": {"filters": {"years_experience": {"min": 200}}, "rubric": {}}}, timeout=15)
check("invalid spec rejected 400", s == 400, f"status={s} {b.get('error','')[:80]}")

# 4. empty-feedback -> 400
s, b, dt = req("POST", f"/api/session/{sid}/feedback", {"message": "", "verdicts": {}}, timeout=15)
check("empty feedback rejected 400", s == 400, f"status={s}")

# 5. freeze
print("\n--- POST /api/session/{sid}/freeze")
s, b, dt = req("POST", f"/api/session/{sid}/freeze")
check("freeze ok", s == 200, f"status={s} took {dt:.1f}s")
sess4 = b["session"]
check("status frozen", sess4["status"] == "frozen")
fz = sess4["frozen"]
check("frozen snapshot has spec+results", fz and fz["spec"] and len(fz["results"]) > 0)
check("frozen rounds count", fz["rounds"] == 3, str(fz["rounds"]))

# frozen session rejects further changes
s, b, dt = req("POST", f"/api/session/{sid}/feedback", {"message": "more of #1"}, timeout=15)
check("frozen rejects feedback 409", s == 409, f"status={s}")
s, b, dt = req("PUT", f"/api/session/{sid}/spec", {"spec": sess4["spec"]}, timeout=15)
check("frozen rejects edit 409", s == 409, f"status={s}")

# 6. validation: bad free text
s, b, dt = req("POST", "/api/session", {"freeText": "hi"}, timeout=15)
check("too-short freeText 400", s == 400, f"status={s}")

# 7. unknown session
s, b, dt = req("GET", "/api/health", timeout=5)
s, b, dt = req("POST", "/api/session/nonexistent/freeze", timeout=5)
check("unknown session 404", s == 404, f"status={s}")

print("\nALL API TESTS PASSED")
