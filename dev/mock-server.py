#!/usr/bin/env python3
"""Local stand-ins for Citi and SecOps, so Extendo can be tested without logging in.

    python3 dev/mock-server.py

Then set MOCK_CITI and/or MOCK_SECOPS = true in config.js, reload the extension, and open:

    Citi    http://localhost:8765/   (deal table lives in an iframe on http://127.0.0.1:8765)
    SecOps  http://localhost:8766/   (sign in, then Build table in the side panel)

What's simulated, matching what injected.js / sidepanel.js rely on:

Citi (port 8765)
  - Outer page on localhost with the deal list in a cross-origin iframe (127.0.0.1), like
    Citi's real iframe on another host.
  - Series cells link to `javascript:reqDl(<id>)`; reqDl navigates the iframe to the
    deal's Reports page (slowly, to exercise polling), so the side panel's Back handling
    walks iframe history.
  - Reports page: one table, sections headed by a single wide cell, year rows of month
    links to PDFs. Has all five configured sections, each with a different latest month;
    "Enhanced Loan-Level Data" has a "(report legends)" link in its heading, like the real
    page. A later-dated "Monthly Remittance Report" section checks that unconfigured
    sections are ignored. Deals with "reports": false lack the Certificate Holders
    Statement, and EU Risk Retention Reporting only appears on even deal ids.

SecOps (port 8766)
  - Dashboard keeps its token in sessionStorage (so each tab can be a different user) and
    calls /v1/deals with `Authorization: Bearer <token>`, which background.js captures.
  - /v1/deals answers 401 without a live token.
  - Buttons: sign in as alice/bob, refresh, expire the session server-side (next call is
    401), and log out (navigates to a sign-out page on another origin, 127.0.0.1:8766).

Fake data is in dev/fixtures.json. Nothing here touches the real sites.
"""

import html
import json
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

CITI_PORT = 8765
SECOPS_PORT = 8766
REPORTS_DELAY_S = 1.0  # how long the Reports page takes to load

FIXTURES = json.loads((Path(__file__).parent / "fixtures.json").read_text())
ROWS_BY_ID = {row["id"]: row for row in FIXTURES["citiRows"]}
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

TOKENS = {}  # live SecOps token -> user
TOKENS_LOCK = threading.Lock()

STYLE = """
<style>
  body { font: 13px/1.4 Arial, sans-serif; margin: 0; color: #222; background: #fff; }
  .bar { background: #003b70; color: #fff; padding: 10px 16px; font-weight: bold; }
  .bar small { font-weight: normal; opacity: .8; margin-left: 8px; }
  .page { padding: 12px 16px; }
  table { border-collapse: collapse; margin: 8px 0; }
  th, td { border: 1px solid #ccc; padding: 4px 8px; text-align: left; }
  th { background: #e8eef5; }
  td.section { background: #003b70; color: #fff; font-weight: bold; }
  .note { color: #888; font-size: 11px; }
  iframe { border: 0; width: 100%; height: calc(100vh - 40px); }
  button { margin-right: 6px; }
  .warn { background: #fff4d6; padding: 6px 8px; }
</style>
"""


def page(title, body):
    return f"<!doctype html><html><head><meta charset='utf-8'><title>{html.escape(title)}</title>{STYLE}</head><body>{body}</body></html>"


def tiny_pdf(text):
    """A minimal valid one-page PDF showing `text`."""
    text = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    stream = f"BT /F1 18 Tf 72 720 Td ({text}) Tj ET".encode()
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = b"%PDF-1.4\n"
    offsets = []
    for i, obj in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + obj + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    out += b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    return out


# --- Citi ---------------------------------------------------------------------------


def citi_outer():
    return page(
        "CitiDirect (mock)",
        f"""<div class="bar">CitiDirect Agency &amp; Trust <small>local mock, not the real site</small></div>
<iframe id="content" src="http://127.0.0.1:{CITI_PORT}/frame/deals"></iframe>""",
    )


def citi_deals():
    rows = "".join(
        f"""<tr><td>{html.escape(r['issuer'])}</td>
<td><a href="javascript:reqDl({r['id']})">{html.escape(r['series'])}</a></td>
<td>2026-11-25</td><td class="note">{html.escape(r.get('note', ''))}</td></tr>"""
        for r in FIXTURES["citiRows"]
    )
    return page(
        "Deal list",
        f"""<div class="page">
<!-- A layout table without the join headers, which extractTable must skip. -->
<table><tr><td>Search deals:</td><td><input placeholder="Issuer or series"></td></tr></table>
<table>
  <thead><tr><th>Issuer</th><th>Series</th><th>Next Distribution</th><th>Mock note</th></tr></thead>
  <tbody>{rows}</tbody>
</table>
</div>
<script>
  // Same shape as Citi's own handler that followLink calls in the MAIN world.
  function reqDl(id) {{ location.href = '/frame/reports?id=' + id; }}
</script>""",
    )


def report_section(label, deal_id, years, heading_extra=""):
    """A heading row, then one row per year of month links. years: {year: last_month}."""
    slug = label.lower().replace(" ", "-")
    # Cells on separate lines, as in real HTML: findLatestStatements reads the year from the
    # row's text, which needs whitespace between "2026" and "Jan".
    out = f'\n<tr><td class="section" colspan="13">{html.escape(label)}{heading_extra}</td></tr>'
    for year, last in years.items():
        cells = "\n".join(
            f'<td><a href="/files/{deal_id}/{slug}-{year}-{m + 1:02d}.pdf">{MONTHS[m]}</a></td>' if m < last else "<td></td>"
            for m in range(12)
        )
        out += f"\n<tr>\n<td>{year}</td>\n{cells}\n</tr>"
    return out


def citi_reports(deal_id):
    row = ROWS_BY_ID.get(deal_id)
    if not row:
        return page("Not found", f"<div class='page'>No deal {deal_id}.</div>")
    sections = report_section("Bond Factor Information", deal_id, {2026: 10})
    sections += report_section("Performance Loan Details", deal_id, {2026: 9})
    if deal_id % 2 == 0:
        sections += report_section("EU Risk Retention Reporting", deal_id, {2026: 6, 2025: 12})
    if row.get("reports", True):
        sections += report_section("Certificate Holders Statement", deal_id, {2026: 10, 2025: 12})
    legends = ' &nbsp;<a href="javascript:void(0)" style="color:#fff">(report legends)</a>'
    sections += report_section("Enhanced Loan-Level Data", deal_id, {2026: 10}, legends)
    # A later-dated section that isn't configured: must not be picked.
    sections += report_section("Monthly Remittance Report", deal_id, {2026: 11})
    return page(
        "Reports",
        f"""<div class="page">
<p><a href="javascript:history.back()">&larr; Back to deal list</a></p>
<h3>{html.escape(row['issuer'].strip())} {html.escape(row['series'])}: Reports</h3>
<table>{sections}</table>
</div>""",
    )


# --- SecOps -------------------------------------------------------------------------

SECOPS_DASHBOARD = """
<div class="bar">SecOps Dashboard <small>local mock, not the real site</small></div>
<div class="page">
  <p id="who">Not signed in.</p>
  <p>
    <button id="login-alice">Sign in as alice</button>
    <button id="login-bob">Sign in as bob</button>
    <button id="refresh">Refresh deals</button>
    <button id="expire">Expire session (server-side)</button>
    <button id="logout">Log out</button>
  </p>
  <p class="note">The token lives in this tab's sessionStorage, so different tabs can be
  signed in as different users. "Expire session" invalidates it on the server without
  telling the page; the next call gets a 401.</p>
  <div id="out"></div>
</div>
<script>
  const $ = (id) => document.getElementById(id);
  const token = () => sessionStorage.getItem('token');

  async function api(path, opts = {}) {
    const headers = { Accept: 'application/json', ...(opts.headers || {}) };
    if (token()) headers.Authorization = 'Bearer ' + token();
    return fetch(path, { ...opts, headers });
  }

  async function refresh() {
    if (!token()) { $('who').textContent = 'Not signed in.'; $('out').textContent = ''; return; }
    const res = await api('/v1/deals');
    if (res.status === 401) {
      $('who').innerHTML = '<span class="warn">Session expired (401). Sign in again.</span>';
      $('out').textContent = '';
      return;
    }
    const deals = await res.json();
    $('who').textContent = `Signed in as ${sessionStorage.getItem('user')} · ${deals.length} deals`;
    $('out').innerHTML = '<table><tr><th>Deal</th><th>Trustee</th><th>Report</th></tr>' +
      deals.map((d) => `<tr><td>${d.dealName}</td><td>${d.trustee}</td><td>${d.trusteeReportReceived?.status ?? ''}</td></tr>`).join('') +
      '</table>';
  }

  async function login(user) {
    const res = await fetch('/api/login', { method: 'POST', body: JSON.stringify({ user }) });
    const { token } = await res.json();
    sessionStorage.setItem('token', token);
    sessionStorage.setItem('user', user);
    refresh();
  }

  $('login-alice').onclick = () => login('alice');
  $('login-bob').onclick = () => login('bob');
  $('refresh').onclick = refresh;
  $('expire').onclick = async () => { await api('/api/expire', { method: 'POST' }); $('who').textContent += ' (expired on server)'; };
  $('logout').onclick = async () => {
    await api('/api/logout', { method: 'POST' });
    sessionStorage.clear();
    location.href = 'http://127.0.0.1:SECOPS_PORT/signed-out';
  };
  refresh();
</script>
""".replace("SECOPS_PORT", str(SECOPS_PORT))


def secops_signed_out():
    return page(
        "Signed out",
        f"""<div class="bar">SecOps sign-in <small>local mock</small></div>
<div class="page"><p>You have been signed out.</p>
<p><a href="http://localhost:{SECOPS_PORT}/">Back to the dashboard</a></p></div>""",
    )


# --- HTTP ---------------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    def send(self, status, body, content_type="text/html; charset=utf-8", extra_headers=None):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def json(self, status, obj):
        # CORS so the extension's direct fallback request (from chrome-extension://) works
        # even if Chrome applies CORS to it.
        cors = {"Access-Control-Allow-Origin": "*"}
        self.send(status, json.dumps(obj), "application/json", cors)

    def bearer(self):
        auth = self.headers.get("Authorization", "")
        return auth[7:] if auth.startswith("Bearer ") else None

    def do_OPTIONS(self):
        self.send(
            204,
            b"",
            "text/plain",
            {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Authorization, Accept, Content-Type",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            },
        )

    def do_GET(self):
        url = urlparse(self.path)
        port = self.server.server_address[1]
        host = (self.headers.get("Host") or "").split(":")[0]

        if port == CITI_PORT:
            if url.path == "/":
                return self.send(200, citi_outer())
            if url.path == "/frame/deals":
                return self.send(200, citi_deals())
            if url.path == "/frame/reports":
                time.sleep(REPORTS_DELAY_S)
                deal_id = int(parse_qs(url.query).get("id", ["0"])[0] or 0)
                return self.send(200, citi_reports(deal_id))
            if url.path.startswith("/files/") and url.path.endswith(".pdf"):
                name = url.path.rsplit("/", 1)[-1]
                return self.send(200, tiny_pdf(f"Mock statement {name}"), "application/pdf")

        if port == SECOPS_PORT:
            if host == "127.0.0.1":
                return self.send(200, secops_signed_out())
            if url.path == "/":
                return self.send(200, page("SecOps (mock)", SECOPS_DASHBOARD))
            if url.path == "/v1/deals":
                with TOKENS_LOCK:
                    user = TOKENS.get(self.bearer())
                if not user:
                    return self.json(401, {"error": "unauthorized"})
                return self.json(200, FIXTURES["secopsDeals"])

        self.send(404, page("Not found", "<div class='page'>Not found.</div>"))

    def do_POST(self):
        port = self.server.server_address[1]
        path = urlparse(self.path).path
        if port != SECOPS_PORT:
            return self.send(404, "")
        if path == "/api/login":
            length = int(self.headers.get("Content-Length") or 0)
            user = json.loads(self.rfile.read(length) or b"{}").get("user", "alice")
            token = f"{user}-{secrets.token_hex(6)}"
            with TOKENS_LOCK:
                TOKENS[token] = user
            return self.json(200, {"token": token})
        if path in ("/api/logout", "/api/expire"):
            with TOKENS_LOCK:
                TOKENS.pop(self.bearer(), None)
            return self.json(200, {"ok": True})
        self.send(404, "")

    def log_message(self, fmt, *args):
        auth = self.headers.get("Authorization") if hasattr(self, "headers") else None
        tag = f"  [auth {auth[7:]}]" if auth else ""
        print(f"{self.server.server_address[1]} {self.command} {self.path} -> {args[1] if len(args) > 1 else ''}{tag}")


def serve(port):
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    for p in (CITI_PORT, SECOPS_PORT):
        threading.Thread(target=serve, args=(p,), daemon=True).start()
    print(f"Citi mock:   http://localhost:{CITI_PORT}/")
    print(f"SecOps mock: http://localhost:{SECOPS_PORT}/")
    print("Set MOCK_CITI and/or MOCK_SECOPS = true in config.js and reload the extension. Ctrl-C to stop.")
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        pass
