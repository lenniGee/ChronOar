# ChronOar

Stoppuhren mit Relationsgeschwindigkeiten für Rudertrainer – als Web-App (PWA) für iPhone und Android, gehostet über GitHub Pages. Jeder Trainer speichert Sportler und Ergebnisse in seinem **eigenen** Google Sheet; die Relationsgeschwindigkeiten kommen **zentral** aus dem Sheet des Betreibers.

- **Für Trainer:** Einrichtung Schritt für Schritt in [`anleitung.html`](anleitung.html) (in der App unter *Sportler → ☁ Sheet* verlinkt).
- **Dieses Dokument:** für den Betreiber (Admin) – Aufbau, einmalige Einrichtung, Pflege.

---

## Inhalt

1. [Aufbau](#aufbau)
2. [Dateien im Repository](#dateien-im-repository)
3. [Einmalige Einrichtung (Admin)](#einmalige-einrichtung-admin)
4. [Relationsgeschwindigkeiten ändern](#relationsgeschwindigkeiten-ändern)
5. [App aktualisieren](#app-aktualisieren)
6. [Skript (Code.gs) aktualisieren](#skript-codegs-aktualisieren)
7. [Datenmodell im Sheet](#datenmodell-im-sheet)
8. [Schnittstelle App ↔ Sheet](#schnittstelle-app--sheet)
9. [Sicherheit & Datenschutz](#sicherheit--datenschutz)
10. [Lizenzen](#lizenzen)

---

## Aufbau

```
 Handy (ChronOar, GitHub Pages)                    Google
 ┌────────────────────────────┐   Ergebnisse,     ┌──────────────────────────────┐
 │ Uhren, StrokeCoach         │   Sportler        │ Sheet von Trainer X          │
 │ Warteschlange (offline)    │ ───────────────▶ │  + Skript (Code.gs, Web-App) │
 │                            │ ◀─────────────── │  Blätter: Sportler,          │
 │                            │   Sportlerliste   │  Ergebnis Sportler/Mannsch., │
 │                            │                   │  Relationen                  │
 │                            │                   └──────────────────────────────┘
 │                            │   Relationen      ┌──────────────────────────────┐
 │                            │ ◀─────────────── │ Sheet des Betreibers         │
 └────────────────────────────┘   (öffentlich)    │  Blatt „Relationen“          │
          ▲                                       └──────────────────────────────┘
          │ config.json → relationsUrl
```

- **Eine App für alle.** Alle Trainer nutzen dieselbe Adresse. Personalisiert wird über den Verbindungscode (QR-Code) zum eigenen Sheet; er wird nur auf dem jeweiligen Handy gespeichert.
- **Offline zuerst.** Jede Änderung (Ergebnis, Sportler) kommt in eine Warteschlange auf dem Handy und wird hochgeladen, sobald Netz da ist (automatisch, alle 45 s und bei Netzrückkehr).
- **Das Sheet ist führend** für die Sportlerliste. Änderungen in der App werden ins Sheet geschrieben; was im Sheet gelöscht wird, verschwindet beim nächsten Abgleich aus der App.
- **Relationen zentral.** Beim Start liest die App `config.json` → `relationsUrl` und lädt die Tabelle aus dem Blatt „Relationen“ des Betreiber-Sheets. Ohne Netz gilt die zuletzt geladene Tabelle, sonst die in der App eingebaute.

## Dateien im Repository

| Datei | Zweck |
|---|---|
| `index.html` | Die komplette App (HTML, CSS, JavaScript). Enthält auch die eingebaute Relationstabelle als Rückfall (`REL_BUILTIN`). |
| `config.json` | Einstellungen des Betreibers: `relationsUrl`, `templateUrl` (siehe unten). |
| `anleitung.html` | Einrichtungsanleitung für Trainer. |
| `Code.gs` | Google-Apps-Script fürs Sheet. Liegt hier nur zur Ablage/Versionierung; benutzt wird die Kopie im Sheet. |
| `sw.js` | Service Worker: Offline-Speicher der App-Dateien. |
| `manifest.webmanifest` | Name, Symbol, Farben für „Zum Home-Bildschirm“. |
| `icon-*.png`, `apple-touch-icon.png` | App-Symbole. |
| `jsqr.min.js` | QR-Code-Scanner (jsQR 1.4.0). |
| `qrcode.min.js` | QR-Code-Erzeugung (qrcode-generator 1.4.4). |
| `README.md` | Dieses Dokument. |

## Einmalige Einrichtung (Admin)

Du brauchst zwei Google Sheets: eine leere **Vorlage**, die Trainer kopieren, und dein **eigenes** Sheet, das gleichzeitig die zentralen Relationen liefert.

### 1. Vorlage erstellen

1. In Google Drive: **Neu → Google Tabellen**. Name: `ChronOar Vorlage`.
2. **Erweiterungen → Apps Script**. Projektname oben links auf `ChronOar` ändern (diesen Namen sehen Trainer später in der Google-Warnung).
3. Den gesamten Inhalt von `Code.gs` in die Datei `Code.gs` im Editor einfügen (vorhandenen Text ersetzen) → **Speichern** (Disketten-Symbol).
4. Zurück im Sheet: Seite neu laden → Menü **ChronOar → 1. Einrichten** → Berechtigungen erlauben (Warnung „nicht überprüft“ → *Erweitert* → *Zu ChronOar wechseln* → *Zulassen*).
5. Die Vorlage **nicht** bereitstellen (keine Web-App). Jeder Trainer stellt seine eigene Kopie bereit.
6. **Teilen → Allgemeiner Zugriff: „Jeder mit dem Link“, Rolle „Betrachter“.**
7. Link kopieren und das Ende `/edit…` durch `/copy` ersetzen, z. B.
   `https://docs.google.com/spreadsheets/d/1AbC…XyZ/copy`
   Dieser Link öffnet direkt „Kopie erstellen?“.

### 2. Eigenes Sheet (mit zentralen Relationen)

1. Den `/copy`-Link selbst öffnen → Kopie erstellen → z. B. `ChronOar Lennart` nennen.
2. Weiter wie jeder Trainer: [`anleitung.html`](anleitung.html) Schritte 2–4 (Einrichten, Bereitstellen mit „Jeder“, Handy verbinden).
3. Die **Web-App-URL** deines Sheets (`https://script.google.com/macros/s/…/exec`) notieren.

### 3. `config.json` ausfüllen

Auf GitHub `config.json` öffnen → Stift-Symbol → Werte eintragen → *Commit changes*:

```json
{
  "relationsUrl": "https://script.google.com/macros/s/DEINE-ID/exec",
  "templateUrl": "https://docs.google.com/spreadsheets/d/VORLAGE-ID/copy"
}
```

| Feld | Bedeutung |
|---|---|
| `relationsUrl` | Web-App-URL **deines** Sheets. Alle Apps laden von dort das Blatt „Relationen“ (öffentlich, ohne Schlüssel). Leer = eingebaute Tabelle. |
| `templateUrl` | `/copy`-Link der Vorlage. Erscheint in `anleitung.html` als Knopf „Vorlage kopieren“. |

Achte auf die Anführungszeichen und das Komma zwischen den Zeilen, sonst kann die App die Datei nicht lesen (sie arbeitet dann mit den eingebauten Relationen weiter).

## Relationsgeschwindigkeiten ändern

1. In **deinem** Sheet das Blatt **Relationen** bearbeiten: Spalte A Boot-Kürzel, Spalte B m/s (z. B. `JMA2x` | `5,341880`). Zeilen hinzufügen oder löschen ist erlaubt.
2. Fertig. Jede App lädt die Tabelle beim nächsten Start mit Netz.

Regeln:

- **Kürzel:** `J`/`S` (Junior/Senior) + `M`/`F` (Geschlecht) + `A`/`B` (Altersklasse) + optional `L` (leicht) + Bootsklasse (`1x`, `2x`, `2-`, `2+`, `4x`, `4x+`, `4-`, `4+`, `8+`, `Ergo`). Beispiel: `JFBL2x` = leichte Juniorinnen B im Doppelzweier.
- **Plausibilitätsprüfung:** Werte außerhalb 2–8 m/s werden übersprungen und in der App unter *☁ Sheet* als „ungültige Werte“ angezeigt. Weniger als 10 gültige Einträge → die App ignoriert die Tabelle komplett.
- **Fehlende Kombination:** Gibt es für einen Sportler keinen Wert in der gewählten Bootsklasse, zählt er nicht zur Relation des Bootes (es zählen nur die anderen).
- **Bestehende Daten** ändern sich nicht: Angelegte Uhren behalten die Relation vom Anlegezeitpunkt, gespeicherte Ergebnisse ihre Prozentwerte.

Die eingebaute Tabelle in `index.html` (`REL_BUILTIN`) ist nur der Rückfall. Sie muss nicht gepflegt werden, sollte aber gelegentlich (z. B. jährlich) aktualisiert werden.

## App aktualisieren

1. Geänderte Dateien auf GitHub hochladen: **Add file → Upload files** → Dateien hineinziehen → **Commit changes**. Gleichnamige Dateien werden ersetzt.
2. Nach 1–2 Minuten ist die neue Version online. Handys mit Netz laden `index.html` beim nächsten Öffnen neu.
3. Wenn andere Dateien als `index.html`, `config.json` oder `anleitung.html` geändert wurden (z. B. Symbole), in `sw.js` die Zeile `const CACHE = "chronoar-v…"` hochzählen, damit die Handys den Offline-Speicher erneuern.

**Nicht ändern:** den Repository-Namen. Er ist Teil der Adresse; eine neue Adresse ist für die Handys eine neue App mit leerem Speicher.

Gespeichert wird auf dem Handy im Browser-Speicher unter dem Schlüssel `rudertrainer.v1` (historischer Name, bitte beibehalten – sonst sind lokale Daten weg).

## Skript (Code.gs) aktualisieren

Nötig, wenn sich `Code.gs` ändert (`SCRIPT_VERSION`). Version 2 brachte das Mannschaftsblatt, Version 3 die Blattnamen „Ergebnis Sportler“ / „Ergebnis Mannschaft“ (alte Blätter werden automatisch umbenannt) und die Versionsanzeige in der App.

**Kontrolle:** In der App unter *Sportler → ☁ Sheet* steht „Sheet-Skript: Version 3“. Steht dort ein Hinweis „veraltet“, läuft unter der Web-App-Adresse noch der alte Code – dann fehlt Schritt 2 (neue Version in der bestehenden Bereitstellung).

1. **Vorlage:** Erweiterungen → Apps Script → Code ersetzen → Speichern.
2. **Jedes bereits kopierte Sheet** (auch deins): Code ersetzen → Speichern → **Bereitstellen → Bereitstellungen verwalten → Stift → Version: „Neue Version“ → Bereitstellen.** Ohne neue Version läuft unter der Adresse weiter der alte Code. Die Adresse und der QR-Code bleiben gleich.

Bestehende Kopien aktualisieren sich **nicht** automatisch – Trainer müssen informiert werden.

## Datenmodell im Sheet

**Sportler**

| Spalte | Inhalt |
|---|---|
| ID | 12-stellig, wird automatisch vergeben (leer lassen) |
| Vorname, Nachname | Text |
| Geschlecht | `m` / `w` |
| Altersklasse | `Junior B`, `Junior A`, `Senior B`, `Senior A` (auch `JB`, `JA`, … werden akzeptiert) |
| Gewichtsklasse | `Offen` / `Leicht` |

**Ergebnis Sportler** – eine Zeile pro Sportler und Belastung, wird nur von der App geschrieben

| Spalte | Inhalt |
|---|---|
| ID | eindeutige Zeilen-ID (verhindert Doppel-Uploads) |
| Belastung | ID der Belastung (gleich für alle Sportler eines Bootes in einer Fahrt) |
| Datum, Uhrzeit | Zeitpunkt des Stopps |
| Vorname, Nachname, Kategorie, Rolle | Rolle = `Ruderer` oder `Steuerperson` |
| Boot, Strecke (m) | |
| Zeit, Zeit (s) | `6:45,3` als Text und als Zahl (für Diagramme) |
| m/s, /500 m | Bootsgeschwindigkeit |
| Relation (m/s), Prozent | Relationsgeschwindigkeit des Bootes und erreichte Prozent (Steuerleute ohne Prozent) |
| Ø SF | durchschnittliche Schlagfrequenz |
| Splits | Zwischenzeiten ab Start, z. B. `1:41,2 \| 3:23,0` |
| Mannschaft | alle Ruderer des Bootes |
| Sportler-ID | Verknüpfung zum Blatt Sportler |

Tipp für Auswertungen: eigene Blätter mit `FILTER`, `QUERY` oder Pivot-Tabellen auf „Ergebnis Sportler“ bzw. „Ergebnis Mannschaft“ anlegen – nicht in diesen Blättern selbst Spalten einfügen.

**Ergebnis Mannschaft** – eine Zeile pro Boot und Belastung, wird vom Skript automatisch aus „Ergebnis Sportler“ gebildet: bei jedem Upload aus der App und zusätzlich bei jedem Öffnen des Sheets (fehlende Zeilen werden ergänzt, verwaiste entfernt)

| Spalte | Inhalt |
|---|---|
| Belastung | ID der Belastung (Verknüpfung zu „Ergebnis Sportler“) |
| Datum, Uhrzeit, Boot | |
| Mannschaft | alle Ruderer in Sitzreihenfolge der Auswahl |
| Kategorien | alle Kategorien im Boot, z. B. `JM A, JM B L` (Mixed-Boote erkennbar) |
| Steuerperson | falls vorhanden |
| Strecke, Zeit, Zeit (s), m/s, /500 m, Relation, Prozent, Ø SF, Splits | wie in „Ergebnis Sportler“ |

Wird eine Belastung in der App zurückgenommen, verschwindet ihre Zeile auch hier. Fehlt das Blatt oder passt es nicht mehr zu den Ergebnissen (z. B. nach Löschen von Hand): **ChronOar → Ergebnis Mannschaft neu aufbauen**.

**Relationen** – Spalte A Boot-Kürzel, Spalte B m/s.

## Schnittstelle App ↔ Sheet

Web-App-URL des Sheets, Antworten immer JSON `{ "ok": true, … }` bzw. `{ "ok": false, "error": "…" }`.

| Aufruf | Schlüssel | Antwort |
|---|---|---|
| `GET ?action=relations` | nein | `{ relations: { "JMA2x": 5.34, … } }` |
| `GET ?action=ping&key=…` | ja | `{ name, version }` |
| `GET ?action=athletes&key=…` | ja | `{ athletes: [ { id, first, last, sex: "M"/"F", age: "JB"/"JA"/"SB"/"SA", weight: "O"/"L" } ] }` |
| `POST { key, action: "batch", ops: [...] }` | ja | `{ done: [qid, …] }` |

Operationen in `ops` (jede mit eindeutiger `qid`): `results` (Zeilen anhängen, doppelte IDs werden übersprungen), `resultsDel` (alle Zeilen einer Belastung löschen), `athlete` (anlegen/ändern), `athleteDel` (löschen). POST wird als `text/plain` gesendet, damit der Browser keine CORS-Vorabanfrage schickt.

**Verbindungscode:** `CHRONOAR1:<Web-App-URL>|<Schlüssel>` – derselbe Text steckt im QR-Code.

## Sicherheit & Datenschutz

- Die Daten eines Trainers liegen nur in **seinem** Google Drive. Der Betreiber sieht sie nicht; GitHub liefert nur die App-Dateien aus.
- Die Web-App läuft „als Ich“ (Sheet-Besitzer) und ist für „Jeder“ erreichbar. Lesen/Schreiben von Sportlern und Ergebnissen erfordert den **Schlüssel** (32 Zeichen, zufällig, pro Sheet). Eine Kopie des Sheets erzeugt automatisch einen neuen Schlüssel.
- Öffentlich ist nur `action=relations`.
- Schlüssel kompromittiert oder Helfer-Handy verloren: im Sheet **ChronOar → Neuen Schlüssel erzeugen** – alle Handys sind getrennt und müssen neu scannen.
- Der Schlüssel liegt im Browser-Speicher des Handys. Wer das entsperrte Handy hat, kann ihn unter *☁ Sheet → Weiteres Handy verbinden* sehen.

## Lizenzen

- jsQR 1.4.0 – Apache License 2.0 – https://github.com/cozmo/jsQR
- qrcode-generator 1.4.4 – MIT – Kazuhiko Arase – https://github.com/kazuhikoarase/qrcode-generator
- Schriften Barlow / Barlow Condensed – SIL Open Font License, über Google Fonts
