"""Google Keep bridge for Athena's own Google account, via gkeepapi.

Keep has no API for consumer accounts. gkeepapi speaks the Android app's
private protocol with a long-lived "master token", which is why this is a
Python helper and not a connector in src/: the protocol, and Google's checks
on the client making the requests, are maintained in gkeepapi/gpsoauth.

One JSON object in on stdin, one out on stdout. Secrets travel on stdin only:
never argv (visible in the process list) and never printed.

  {"cmd": "exchange", "email": ..., "oauth_token": ...}  -> {"master_token": ...}
  {"cmd": "lists", "email": ..., "master_token": ...}     -> {"lists": [...]}
"""
import hashlib
import json
import sys


def device_id(email):
    # gpsoauth wants a stable Android id; derive one so nothing extra is stored.
    return hashlib.sha256(email.lower().encode()).hexdigest()[:16]


def exchange(req):
    import gpsoauth

    reply = gpsoauth.exchange_token(req["email"], req["oauth_token"], device_id(req["email"]))
    token = reply.get("Token")
    if not token:
        # Google's own error code (BadAuthentication, NeedsBrowser...), no secrets.
        return {"error": reply.get("Error", "no master token returned")}
    return {"master_token": token}


def iso(ts):
    return ts.isoformat() if ts else None


def lists(req):
    import gkeepapi

    keep = gkeepapi.Keep()
    keep.authenticate(req["email"], req["master_token"], device_id=device_id(req["email"]))
    out = []
    for note in keep.all():
        if note.type != gkeepapi.node.NodeType.List or note.trashed or note.archived:
            continue
        out.append({
            "id": note.id,
            "title": note.title,
            "updated": iso(note.timestamps.updated),
            "collaborators": len(list(note.collaborators.all())),
            "items": [{
                "id": item.id,
                "text": item.text,
                "checked": item.checked,
                # When an item was last touched. For a checked item that is
                # roughly when it was bought — the "probably in the house" signal.
                "updated": iso(item.timestamps.updated),
            } for item in note.items],
        })
    return {"lists": out}


def main():
    # utf-8-sig: PowerShell pipes prepend a byte-order mark.
    req = json.loads(sys.stdin.buffer.read().decode("utf-8-sig"))
    try:
        result = {"exchange": exchange, "lists": lists}[req["cmd"]](req)
    except Exception as err:  # report the kind of failure, never the request
        result = {"error": f"{type(err).__name__}: {err}"}
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    main()
