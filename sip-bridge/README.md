# CallAssist SIP bridge (Asterisk + any SIP trunk)

Lets CallAssist place real phone calls through an existing Asterisk PBX. Built for testing in India over an Airtel SIP trunk, alongside the Amazon Connect line used for US numbers.

```
CallAssist ──/sip/events (call job)──► bridge ──ARI──► Asterisk ──SIP trunk──► phone
CallAssist ◄── /sip/turn · /sip/tts · /sip/stt ── bridge   (speak, record, transcribe, repeat)
```

- **Outbound only.** The bridge connects out to CallAssist over HTTPS. Nothing on the PBX is exposed.
- **No AWS keys on the PBX.** CallAssist makes the 8 kHz voice (Amazon Polly) and reads replies (Amazon Transcribe).
- **Allowlist.** Asterisk dials only through a dedicated context that accepts the consenting test numbers.
- **Privacy.** Reply recordings are deleted right after they are transcribed; logs mask phone numbers.

## Asterisk setup

1. ARI user in `/etc/asterisk/ari.conf`:
   ```ini
   [general]
   enabled = yes

   [callassist]
   type = user
   read_only = no
   password = <long random password>
   password_format = plain
   ```
   `asterisk -rx "module reload res_ari.so"`
2. Folders: `mkdir -p /var/lib/asterisk/sounds/callassist /var/spool/asterisk/recording`
3. Test-only context in `extensions.conf` (replace the numbers, then `asterisk -rx "dialplan reload"`):
   ```ini
   [callassist-test]
   exten => _+91XXXXXXXXXX,1,NoOp(CallAssist test call to ${EXTEN})
    same => n,GotoIf($["${EXTEN}" = "+91XXXXXXXXXX"]?ok)
    same => n,Hangup(21)
    same => n(ok),Set(CALLERID(num)=+91YOURPILOT)
    same => n,Dial(PJSIP/${EXTEN}@airtel,45)
    same => n,Hangup()
   ```
4. Keep port 8088 closed to the internet; the bridge talks to ARI on `127.0.0.1`.

## Install the bridge

Needs Node.js 22 or later.

```bash
mkdir -p /opt/callassist-bridge
cp bridge.mjs /opt/callassist-bridge/
cp bridge.env.example /etc/callassist-bridge.env   # fill in, then:
chmod 600 /etc/callassist-bridge.env
cp callassist-bridge.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now callassist-bridge
journalctl -u callassist-bridge -f
```

Healthy logs show `ari_connected` and `callassist_connected`. CallAssist's `/healthz` then reports `"sipBridges": 1`.

## Using it

Give a CallAssist contact `"line": "sip"` and a `+91…` number (in the server's private `data/local/contacts.json`). Calls to that contact now ring the real phone.
