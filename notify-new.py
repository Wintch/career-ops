#!/usr/bin/env python3
"""Email new job finds from data/pipeline.md (local add-on, not upstream).

Run after each scan (systemd ExecStartPost). Compares the Pending lines in
data/pipeline.md against data/.notified-urls.txt and emails any URL not seen
before, then records it. Nothing is sent when there is nothing new.

Config: ~/.config/career-ops/notify.env (chmod 600)
    ENABLED=1
    SMTP_USER=you@gmail.com
    SMTP_PASS=<Gmail app password, 16 chars>
    MAIL_TO=you@gmail.com
Turn off: set ENABLED=0 (or delete the file).

Usage: notify-new.py [--test] [--seed]
    --test  send a test email now
    --seed  mark everything currently pending as already notified (no email)
"""
import os
import re
import smtplib
import ssl
import sys
from email.message import EmailMessage
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PIPELINE = ROOT / 'data' / 'pipeline.md'
SEEN = ROOT / 'data' / '.notified-urls.txt'
CONF = Path.home() / '.config' / 'career-ops' / 'notify.env'


def load_conf():
    if not CONF.exists():
        return None
    conf = {}
    for line in CONF.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            conf[k.strip()] = v.strip().strip('"\'')
    if conf.get('ENABLED', '1') != '1':
        return None
    if not all(conf.get(k) for k in ('SMTP_USER', 'SMTP_PASS', 'MAIL_TO')):
        return None
    return conf


def pending_items():
    text = PIPELINE.read_text(encoding='utf-8')
    m = re.search(r'## Pending(.*?)## Processed', text, re.S)
    items = []
    for line in (m.group(1) if m else '').splitlines():
        if line.startswith('- [ ] '):
            parts = [p.strip() for p in line[6:].split('|')]
            items.append({'url': parts[0], 'desc': ' — '.join(parts[1:]) or parts[0]})
    return items


def send(conf, subject, body):
    msg = EmailMessage()
    msg['Subject'] = subject
    msg['From'] = conf['SMTP_USER']
    msg['To'] = conf['MAIL_TO']
    msg.set_content(body)
    with smtplib.SMTP_SSL('smtp.gmail.com', 465, context=ssl.create_default_context(), timeout=30) as s:
        s.login(conf['SMTP_USER'], conf['SMTP_PASS'].replace(' ', ''))
        s.send_message(msg)


def main():
    args = sys.argv[1:]
    seen = set(SEEN.read_text().split()) if SEEN.exists() else set()
    items = pending_items()

    if '--seed' in args:
        SEEN.write_text('\n'.join(sorted(seen | {i['url'] for i in items})) + '\n')
        print(f'seeded {len(items)} pending URL(s)')
        return

    conf = load_conf()
    if conf is None:
        print('notify: disabled or not configured')
        return

    if '--test' in args:
        send(conf, 'career-ops: test notification', 'Notifications are working.\n\nTurn off: set ENABLED=0 in ~/.config/career-ops/notify.env')
        print('test email sent')
        return

    new = [i for i in items if i['url'] not in seen]
    if not new:
        print('notify: nothing new')
        return

    lines = [f"• {i['desc']}\n  {i['url']}" for i in new]
    body = ('New postings found by the scanner (title/location-filtered, NOT yet triaged):\n\n'
            + '\n\n'.join(lines)
            + '\n\nOpen a Claude session to triage them.\n'
            + 'Turn off these emails: set ENABLED=0 in ~/.config/career-ops/notify.env\n')
    send(conf, f'career-ops: {len(new)} new posting(s)', body)
    SEEN.write_text('\n'.join(sorted(seen | {i['url'] for i in new})) + '\n')
    print(f'notify: emailed {len(new)} new posting(s)')


if __name__ == '__main__':
    main()
