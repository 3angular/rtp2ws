# RTP2WS — WebSocket-Integrationsleitfaden

Dieses Dokument beschreibt das WebSocket-Protokoll, mit dem RTP2WS Live-Audio eines
Anrufs an Ihren Endpunkt streamt und Audio von Ihnen entgegennimmt. Es enthält alles,
was Sie zur Umsetzung der empfangenden Seite benötigen, und keine Details zu den
internen Abläufen von RTP2WS.

## 1. Rollen und Verbindung

- **Sie betreiben einen WebSocket-Server.** RTP2WS verbindet sich als **Client** damit
  (die `wss://`-URL wird auf der RTP2WS-Seite je Ziel konfiguriert).
- Eine WebSocket-Verbindung entspricht **einem laufenden Telefonanruf**.
- Die Verbindung wird geöffnet, **sobald der Anruf angenommen wird**, und geschlossen,
  wenn der Anruf endet (siehe §6).

RTP2WS kann dem WebSocket-Handshake konfigurierte HTTP-Header hinzufügen (zum Beispiel
`Authorization: Bearer …`), damit Sie die Verbindung authentifizieren können. Die
genauen Header-Namen und -Werte werden mit dem RTP2WS-Betreiber vorab abgestimmt.

## 2. Nachrichtenablauf

Nachrichten werden ausschließlich über den WebSocket-**Frame-Typ** unterschieden — es
gibt keinen zusätzlichen Header und keine Hülle (Envelope) innerhalb der Daten:

1. **Erste Nachricht — ein TEXT-Frame:** ein JSON-**Metadaten**-Objekt, das den Anruf
   beschreibt (§3). Wird unmittelbar nach dem Verbindungsaufbau gesendet, vor jeglichem
   Audio.
2. **Danach — BINARY-Frames:** rohes PCM-Audio des Anrufs, kontinuierlich gestreamt
   (§4).

Sie erhalten niemals einen zweiten Text-Frame. Alles, was Sie **zurücksenden**, muss
ausschließlich aus **BINARY**-Audio-Frames bestehen (§5) — senden Sie keinen
Metadaten-Frame.

```
RTP2WS ──► Sie :  [TEXT] Metadaten-JSON
RTP2WS ──► Sie :  [BINARY] PCM … [BINARY] PCM … [BINARY] PCM …   (kontinuierlich)
Sie ──► RTP2WS :  [BINARY] PCM … [BINARY] PCM …                  (optional, jederzeit)
```

## 3. Metadaten (erster TEXT-Frame)

```json
{
  "callId": "1720000000.42",
  "fromNumber": "+49301234567",
  "toNumber": "+49151234567",
  "startedAt": "2026-07-01T12:00:00.000Z",
  "audio": {
    "sampleRate": 8000,
    "format": "s16le",
    "captureChannels": 2,
    "injectChannels": 2,
    "monoWhisperTarget": "callee"
  }
}
```

| Feld | Typ | Bedeutung |
|---|---|---|
| `callId` | string | Eindeutige, opake Kennung dieses Anrufs. Als opak behandeln. |
| `fromNumber` | string | Rufnummer des Anrufers, E.164 (`+…`). |
| `toNumber` | string | Rufnummer des angerufenen Teilnehmers, E.164 (`+…`). |
| `startedAt` | string | Zeitpunkt der Anrufannahme, UTC ISO-8601. |
| `audio.sampleRate` | int | Abtastrate in Hz: `8000` oder `16000`. |
| `audio.format` | string | Immer `"s16le"` — 16 Bit vorzeichenbehaftet, Little-Endian. |
| `audio.captureChannels` | int | Kanäle im Audio, das **Sie empfangen**: `2` = Stereo, `1` = Mono. |
| `audio.injectChannels` | int | Kanäle im Audio, das **Sie senden dürfen**: `2` = Stereo, `1` = Mono. |
| `audio.monoWhisperTarget` | string | Nur relevant bei `injectChannels == 1`: welcher Teilnehmer Ihr Mono-Audio hört — `caller` (Anrufer), `callee` (Angerufener) oder `both` (beide). |

Der `audio`-Block bestimmt für diesen Anruf vollständig das Byte-Layout in beiden
Richtungen. Lesen Sie ihn aus, bevor Sie Audio verarbeiten; setzen Sie keine festen
Werte voraus.

## 4. Audio, das Sie empfangen (BINARY-Frames)

Jeder Binär-Frame von RTP2WS enthält **rohes PCM** ohne Header:

- **Sample-Format:** 16-Bit-Ganzzahl mit Vorzeichen, **Little-Endian** (`s16le`).
- **Abtastrate:** `audio.sampleRate` (8000 oder 16000 Hz).
- **Kanäle:** `audio.captureChannels`.
  - **`2` (Stereo):** verschachtelt (interleaved), **links = Anrufer, rechts =
    Angerufener** (`L₀ R₀ L₁ R₁ …`). So lassen sich die beiden Sprecher unterscheiden.
  - **`1` (Mono):** ein einzelner gemischter Stream beider Teilnehmer.

Behandeln Sie die Binär-Frames als **kontinuierlichen Byte-Stream**. Frames treffen
etwa alle 20 ms ein, **verlassen Sie sich aber nicht auf Frame-Grenzen oder
-Größen** — fügen Sie die Nutzdaten zusammen und zerlegen Sie sie selbst in Samples.

## 5. Audio, das Sie senden (optional, BINARY-Frames)

Das Senden von Audio ist optional; eine rein empfangende Integration ist zulässig.
Wenn Sie senden, wird das Audio in den laufenden Anruf gemischt:

- **Gleiches Format wie oben:** `s16le` mit `audio.sampleRate`.
- **Kanäle:** `audio.injectChannels`.
  - **`2` (Stereo):** verschachtelt, **links → Anrufer, rechts → Angerufener**. Der
    linke Kanal ist nur für den Anrufer hörbar, der rechte nur für den Angerufenen.
    Um nur einen Teilnehmer anzusprechen, senden Sie auf dem anderen Kanal **Stille
    (Null-Samples)**.
  - **`1` (Mono):** hörbar für den in `audio.monoWhisperTarget` genannten Teilnehmer
    (`caller`, `callee` oder `both`).
- **Taktung:** Senden Sie ungefähr in **Echtzeit** (also etwa eine Sekunde Audio pro
  Sekunde). RTP2WS puffert eine kleine Menge und speist sie getaktet in den Anruf ein;
  Audio, das weit über diesen Puffer hinaus schneller als in Echtzeit gesendet wird,
  wird **verworfen**.
- Die Frame-Größen bestimmen Sie selbst; Sie müssen keine 20-ms-Grenzen einhalten.

## 6. Lebenszyklus und Beenden des Anrufs

- **Sie schließen die Verbindung sauber** (regulärer WebSocket-Close-Handshake):
  standardmäßig **endet damit der Anruf**. Dies ist der vorgesehene Weg, um den Anruf
  von Ihrer Seite aufzulegen. (Dieses Verhalten ist auf der RTP2WS-Seite je Ziel
  konfigurierbar — stimmen Sie sich mit dem Betreiber ab, falls Sie sich darauf
  verlassen.)
- **Die Verbindung bricht unerwartet ab** (Netzwerkfehler, Absturz Ihres Prozesses,
  TCP-Reset): standardmäßig **läuft der Anruf ohne Streaming weiter**, und RTP2WS
  stellt die Verbindung **nicht** wieder her. Ein versehentlicher Abbruch beendet also
  keinen laufenden Anruf, Sie können das Streaming für diesen Anruf aber auch nicht
  wieder aufnehmen.
- **Einer der Telefonteilnehmer legt auf:** der Anruf endet und RTP2WS schließt die
  WebSocket-Verbindung. Behandeln Sie ein serverseitiges Schließen als Anrufende und
  geben Sie Ressourcen frei.

## 7. Kurzreferenz

Bytes pro 20-ms-Audioabschnitt, nach Abtastrate und Kanalanzahl:

| Abtastrate | Mono (1 Kanal) | Stereo (2 Kanäle) |
|---|---:|---:|
| 8 000 Hz | 320 Bytes | 640 Bytes |
| 16 000 Hz | 640 Bytes | 1280 Bytes |

(16-Bit-Samples = 2 Bytes/Sample; pro Kanal: `Abtastrate × 0,020 × 2` Bytes.)

### Zusammenfassung der Umsetzung

Eine konforme Integration führt die folgenden Schritte aus:

1. Die eingehende WebSocket-Verbindung annehmen und dabei etwaige vereinbarte
   Authentifizierungs-Header prüfen.
2. Den ersten **Text**-Frame als Metadaten-JSON parsen und den `audio`-Block auslesen,
   um das Format für die restliche Verbindung zu bestimmen.
3. Die nachfolgenden **Binär**-Frames als kontinuierlichen `s16le`-PCM-Stream
   verarbeiten.
4. Optional **Binär**-Frames mit `s16le`-PCM in Echtzeit zurücksenden, ohne einen
   Metadaten-Frame.
5. Die Verbindung sauber schließen, um den Anruf zu beenden, und ein serverseitiges
   Schließen als Anrufende behandeln.
