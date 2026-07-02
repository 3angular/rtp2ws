#!/usr/bin/env python3
"""Renders /etc/asterisk config from the mounted rtp2ws YAML (spec §9)."""
import sys

import yaml

# Baked-in internals shared with the sidecar image (see sidecar/src/config.ts).
# ARI binds 127.0.0.1 only; the host is trusted by design (spec §8).
ARI_USER = "rtp2ws"
ARI_PASS = "rtp2ws-internal"
STASIS_APP = "rtp2ws"
# Asterisk's own RTP range (binds publicIp for calls, 127.0.0.1 for
# externalMedia). May overlap the sidecar's loopback pool (spec §6).
RTP_START, RTP_END = 10000, 19998


def die(msg):
    sys.exit(f"render-config: {msg}")


def main(path):
    with open(path) as f:
        cfg = yaml.safe_load(f)

    public_ip = cfg.get("publicIp") or die("publicIp is required")
    trunk = cfg.get("trunk") or die("trunk is required")
    host = trunk.get("host") or die("trunk.host is required")
    # A list means redundant hosts of the same trunk (spec §8): inbound is
    # accepted from all of them, outbound tries them in order (sidecar).
    hosts = host if isinstance(host, list) else [host]
    if not all(isinstance(h, str) and h for h in hosts):
        die("trunk.host must be a host or a list of hosts")
    port = trunk.get("port", 5060)
    username = trunk.get("username")
    password = trunk.get("password")
    register = trunk.get("register", True)
    transport = trunk.get("transport", "udp")
    if transport not in ("udp", "tcp", "tls"):
        die("trunk.transport must be udp, tcp or tls")
    if register and not username:
        die("trunk.username is required when trunk.register is true")

    pjsip = f"""\
; rendered by render-config.py — edits are lost on restart
[transport-{transport}]
type=transport
protocol={transport}
bind={public_ip}:5060

[trunk]
type=endpoint
transport=transport-{transport}
context=from-trunk
disallow=all
allow=amrwb
allow=alaw
aors=trunk
direct_media=no
; bind call RTP to publicIp (spec §2); without this it binds the wildcard
; address and could collide with the sidecar's loopback pool
media_address={public_ip}
bind_rtp_to_media_address=yes
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes
trust_id_inbound=yes
send_pai=yes
"""
    if username:
        pjsip += f"""outbound_auth=trunk-auth
from_user={username}

[trunk-auth]
type=auth
auth_type=userpass
username={username}
password={password or ""}
"""
    # qualify (OPTIONS keepalive) is monitoring only: outbound dials use explicit
    # per-host URIs, so an unavailable contact never blocks calls. Some carriers
    # ignore OPTIONS — trunk.qualify: false silences the resulting flapping.
    contacts = "".join(f"contact=sip:{h}:{port}\n" for h in hosts)
    qualify = "qualify_frequency=60\n" if trunk.get("qualify", True) else ""
    pjsip += f"""
[trunk]
type=aor
{contacts}{qualify}
[trunk-identify]
type=identify
endpoint=trunk
""" + "".join(f"match={h}\n" for h in hosts)
    if register:
        pjsip += f"""
[trunk-reg]
type=registration
transport=transport-{transport}
outbound_auth=trunk-auth
server_uri=sip:{hosts[0]}:{port}
client_uri=sip:{username}@{hosts[0]}:{port}
retry_interval=30
line=yes
endpoint=trunk
"""

    files = {
        "pjsip.conf": pjsip,
        "rtp.conf": f"[general]\nrtpstart={RTP_START}\nrtpend={RTP_END}\n",
        "http.conf": "[general]\nenabled=yes\nbindaddr=127.0.0.1\nbindport=8088\n",
        "ari.conf": f"[general]\nenabled=yes\n\n[{ARI_USER}]\ntype=user\nread_only=no\npassword={ARI_PASS}\n",
        "extensions.conf": (
            "[from-trunk]\n"
            f"exten => _[+0-9].,1,Stasis({STASIS_APP})\n"
            " same => n,Hangup()\n"
        ),
    }
    for name, content in files.items():
        with open(f"/etc/asterisk/{name}", "w") as f:
            f.write(content)
    print(f"render-config: wrote {', '.join(files)}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/config/rtp2ws.yaml")
