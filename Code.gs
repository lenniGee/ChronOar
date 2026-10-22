/**
 * ChronOar – Trainings- und Regatta-App von Lennart Geerdes.
 * ChronOar – Google-Sheet-Anbindung
 * =================================
 *
 * Dieses Skript macht aus einem Google Sheet den persönlichen Datenspeicher
 * eines Trainers für die App ChronOar. Es wird als "Web-App" bereitgestellt;
 * die App schickt Ergebnisse dorthin und lädt die Sportlerliste von dort.
 *
 * Blätter (werden von "ChronOar → Einrichten" angelegt):
 *   Sportler    ID | Vorname | Nachname | Geschlecht | Altersklasse | Gewichtsklasse
 *   Ergebnis Sportler    eine Zeile pro Sportler und Belastung (wird nur von der App beschrieben)
 *   Ergebnis Mannschaft  eine Zeile pro Boot und Belastung (wird automatisch aus „Ergebnis Sportler“ gebildet:
 *                        bei jedem Upload und zusätzlich bei jedem Öffnen des Sheets)
 *   (bis Version 2 hießen die beiden Blätter „Ergebnisse“ und „Mannschaften“ – sie werden automatisch umbenannt)
 * Die Relationsgeschwindigkeiten stehen NICHT im Sheet, sondern zentral in relationen.csv im
 * GitHub-Repository der App (ab Version 4). Ein altes Blatt „Relationen“ wird nicht mehr benutzt.
 *
 * Schnittstelle (alle Antworten JSON: {ok:true,...} oder {ok:false,error:"..."}):
 *   GET  ?action=ping&key=…                Verbindung prüfen, liefert Sheet-Name
 *   GET  ?action=athletes&key=…            Sportlerliste
 *   POST {key, action:"batch", ops:[…]}    Änderungen der App in Reihenfolge anwenden:
 *        {op:"results",    rows:[…]}       Ergebniszeilen anhängen (doppelte IDs werden übersprungen)
 *        {op:"resultsDel", run:"…"}        Zeilen einer Belastung löschen (Stopp in der App zurückgenommen)
 *        {op:"athlete",    athlete:{…}}    Sportler anlegen oder ändern
 *        {op:"athleteDel", id:"…"}         Sportler löschen
 *        {op:"rgBoat",     boat:{…}}       Regatta-Boot anlegen oder ändern
 *        {op:"rgBoatDel",  id:"…"}         Regatta-Boot löschen
 *        {op:"rgNewRun",   id:"…"}         Regatta-Boot für einen neuen Lauf zurücksetzen (Lauf + 1)
 *        {op:"rgEvent",    ev:{…}}         Start / Split / Frequenz / Stopp eines Handys protokollieren
 *        {op:"rgEventDel", id:"…"}         ein Ereignis zurücknehmen
 *   GET  ?action=regatta&key=…&etag=…     Regatta-Boote + Ereignisse (oder {same:true}, wenn unverändert)
 *   Jede Antwort enthält "now" = Serverzeit in ms. Daraus berechnet jedes Handy seine Uhr-Abweichung,
 *   damit Zeiten von verschiedenen Handys (Start auf A, Stopp auf B) zusammenpassen.
 *
 * Sicherheit: Jeder Aufruf braucht den Schlüssel. Er wird pro Sheet
 * zufällig erzeugt und steckt im Verbindungscode / QR-Code. Eine Kopie des
 * Sheets bekommt automatisch einen neuen Schlüssel.
 *
 * Nach JEDER Änderung an diesem Code: "Bereitstellen → Bereitstellungen verwalten
 * → Bearbeiten (Stift) → Version: Neue Version → Bereitstellen". Sonst läuft
 * unter der Web-App-Adresse weiter die alte Version. Die Adresse bleibt gleich.
 */

var SCRIPT_VERSION = 15;
var CODE_PREFIX = 'CHRONOAR1:';
var SH_ATH = 'Sportler', SH_RES = 'Ergebnis Sportler', SH_TEAM = 'Ergebnis Mannschaft';
var OLD_NAMES = { 'Ergebnis Sportler': 'Ergebnisse', 'Ergebnis Mannschaft': 'Mannschaften' };
var TEAM_HEAD = ['Belastung', 'Datum', 'Uhrzeit', 'Strecke (m)', 'Startnummer', 'Abteilung', 'Strecke Nr.', 'Mannschaft', 'Steuerperson', 'Kategorien', 'Boot',
  'Zeit', 'Zeit (s)', '/500 m', 'm/s', 'Ø SF', 'Frequenzen', 'Splits', 'Relation (m/s)', 'Zielzeit', 'Zielzeit (s)', 'Prozent'];
var ATH_HEAD = ['ID', 'Vorname', 'Nachname', 'Geschlecht', 'Altersklasse', 'Gewichtsklasse'];
/* „Ergebnis Sportler“. ID und Belastung sind technische Spalten (Doppel-Upload-Schutz, Zurücknehmen eines Stopps). */
var RES_HEAD = ['Mannschaft', 'Sportler-ID', 'Datum', 'Uhrzeit', 'Strecke (m)', 'Startnummer', 'Abteilung', 'Strecke Nr.', 'Vorname', 'Nachname', 'Rolle', 'Kategorie',
  'Boot', 'Zeit', 'Zeit (s)', '/500 m', 'm/s', 'Ø SF', 'Frequenzen', 'Splits', 'Relation (m/s)', 'Zielzeit', 'Zielzeit (s)', 'Prozent',
  'ID', 'Belastung'];
/* Spalten werden im ganzen Skript über ihren Namen angesprochen: RC['Prozent'] = Spaltennummer (1-basiert). */
var RC = colMap_(RES_HEAD), TC = colMap_(TEAM_HEAD);
function colMap_(head) { var m = {}; head.forEach(function (h, i) { m[h] = i + 1; }); return m; }
/** Zeile (Array in Kopfzeilen-Reihenfolge) aus einem Objekt {Spaltenname: Wert} bauen. */
function rowFrom_(head, o) { return head.map(function (h) { return o.hasOwnProperty(h) ? o[h] : ''; }); }
/** Spaltenformate nach Namen setzen. */
function formatCols_(sh, head, fmts) {
  Object.keys(fmts).forEach(function (name) {
    var c = head.indexOf(name) + 1; if (!c) return;
    var rg = sh.getRange(1, c, sh.getMaxRows(), 1);
    if (fmts[name] === 'grey') rg.setFontColor('#999999'); else rg.setNumberFormat(fmts[name]);
  });
}
var RES_FMT = { 'Startnummer': '@', 'Datum': 'dd.MM.yyyy', 'Uhrzeit': 'HH:mm', 'Zeit': '@', 'Zeit (s)': '0.00', '/500 m': '@', 'm/s': '0.000000',
  'Ø SF': '0.0', 'Relation (m/s)': '0.000000', 'Zielzeit': '@', 'Zielzeit (s)': '0.0', 'Prozent': '0.0000',
  'Sportler-ID': 'grey', 'ID': 'grey', 'Belastung': 'grey' };
var TEAM_FMT = { 'Startnummer': '@', 'Belastung': 'grey', 'Datum': 'dd.MM.yyyy', 'Uhrzeit': 'HH:mm', 'Zeit': '@', 'Zeit (s)': '0.00', '/500 m': '@',
  'm/s': '0.00', 'Ø SF': '0.0', 'Relation (m/s)': '0.000000', 'Zielzeit': '@', 'Zielzeit (s)': '0.0', 'Prozent': '0.0000' };
var AGE_TXT = { JB: 'Junior B', JA: 'Junior A', SB: 'Senior B', SA: 'Senior A' };


/* ------------------------------------------------------------------ Menü */

function onOpen() {
  // Sicherheitsnetz: läuft immer mit dem zuletzt gespeicherten Code, unabhängig von der Bereitstellung.
  try { renameOld_(); if (SpreadsheetApp.getActive().getSheetByName(SH_RES)) { fixHeaders_(); fixTargets_(); syncTeams_(); numberRuns_(); } } catch (e) { }
  try { if (SpreadsheetApp.getActive().getSheetByName(SH_ATH)) { regattaSheet_(); logSheet_(); refreshNameList_(); } } catch (e) { }
  SpreadsheetApp.getUi().createMenu('ChronOar')
    .addItem('1. Einrichten', 'setup')
    .addItem('2. Mit Handy verbinden (QR-Code)', 'showConnect')
    .addItem('Ergebnis Mannschaft neu aufbauen', 'rebuildTeams')
    .addItem('Ergebnis-PDF erstellen', 'showPdf')
    .addItem('Regatta leeren (alle Boote und Zeiten löschen)', 'clearRegatta')
    .addSeparator()
    .addItem('Neuen Schlüssel erzeugen (alte Handys trennen)', 'resetKey')
    .addSeparator()
    .addItem('Über ChronOar', 'about')
    .addToUi();
}

/** Legt fehlende Blätter an, formatiert sie und erzeugt den Schlüssel. Bestehende Daten bleiben unangetastet. */
function setup() {
  var ss = SpreadsheetApp.getActive();
  renameOld_();
  var ath = ensureSheet_(ss, SH_ATH, ATH_HEAD);
  var res = ensureSheet_(ss, SH_RES, RES_HEAD);
  var team = teamSheet_();
  if (team.getLastRow() < 2 && res.getLastRow() > 1) rebuildTeams_();
  regattaSheet_(); logSheet_(); refreshNameList_();

  // Auswahllisten für die Sportler-Spalten D–F
  var dv = function (list) { return SpreadsheetApp.newDataValidation().requireValueInList(list, true).setAllowInvalid(false).build(); };
  ath.getRange('D2:D').setDataValidation(dv(['m', 'w']));
  ath.getRange('E2:E').setDataValidation(dv(['Junior B', 'Junior A', 'Senior B', 'Senior A']));
  ath.getRange('F2:F').setDataValidation(dv(['Offen', 'Leicht']));
  ath.setColumnWidth(1, 90);
  ath.getRange('A:A').setFontColor('#999999');
  ath.getRange('A1').setNote('Wird automatisch vergeben. Neue Sportler einfach ab Spalte B eintragen und ID leer lassen.');

  formatCols_(res, RES_HEAD, RES_FMT);

  ['Sheet1', 'Tabellenblatt1', 'Tabellenblatt 1'].forEach(function (n) {
    var s = ss.getSheetByName(n);
    if (s && s.getLastRow() === 0 && ss.getSheets().length > 3) ss.deleteSheet(s);
  });
  getKey_();
  SpreadsheetApp.getUi().alert('ChronOar ist eingerichtet.\n\nNächster Schritt: Erweiterungen → Apps Script → Bereitstellen → Neue Bereitstellung (siehe Anleitung). Danach "ChronOar → Mit Handy verbinden".');
}

function ensureSheet_(ss, name, head) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, head.length).setValues([head]);
  sh.getRange(1, 1, 1, head.length).setFontWeight('bold');
  sh.setFrozenRows(1);
  return sh;
}

/** Menü: Über ChronOar */
function about() {
  SpreadsheetApp.getUi().alert('ChronOar', 'Trainings- und Regatta-App für Rudertrainer.\n\nKonzipiert und entwickelt von Lennart Geerdes.\n© ' + new Date().getFullYear() + ' Lennart Geerdes\n\nSkript-Version ' + SCRIPT_VERSION, SpreadsheetApp.getUi().ButtonSet.OK);
}

/** Dialog: Web-App-Adresse eintragen, Verbindungscode + QR-Code anzeigen. */
function showConnect() {
  getKey_();
  // Adresse automatisch finden: gespeicherte oder von Google gemeldete – aber nur, wenn sie nachweislich zu DIESEM Sheet gehört.
  var props = PropertiesService.getScriptProperties(), found = null, cands = [];
  cands.push(props.getProperty('WEBAPP_URL'));
  try { cands.push(ScriptApp.getService().getUrl()); } catch (e) { }
  for (var i = 0; i < cands.length && !found; i++) {
    var u = String(cands[i] || '').replace(/\/dev$/, '/exec');
    if (/^https:\/\/script\.google\.com\/.+\/exec$/.test(u)) {
      var r = checkUrl_(u);
      if (r.ok) found = { url: u, code: CODE_PREFIX + u + '|' + getKey_(), warn: r.warn };
    }
  }
  if (found) props.setProperty('WEBAPP_URL', found.url); else props.deleteProperty('WEBAPP_URL');
  var t = HtmlService.createTemplate(CONNECT_HTML);
  t.found = JSON.stringify(found);
  t.lib = QR_LIB;
  SpreadsheetApp.getUi().showModalDialog(t.evaluate().setWidth(420).setHeight(600), 'ChronOar mit Handy verbinden');
}

/** Ruft die Web-App-Adresse testweise auf und prüft, ob sie zu diesem Sheet gehört. */
function checkUrl_(url) {
  try {
    var res = UrlFetchApp.fetch(url + '?action=ping&key=' + encodeURIComponent(getKey_()), { muteHttpExceptions: true, followRedirects: true });
    var j = JSON.parse(res.getContentText());
    if (!j.ok) return { ok: false, why: j.error === 'bad_key' ? 'other' : 'error' };
    var ss = SpreadsheetApp.getActive();
    if (j.id ? j.id !== ss.getId() : j.name !== ss.getName()) return { ok: false, why: 'other' };
    return { ok: true, warn: (j.version || 0) < SCRIPT_VERSION
      ? 'Unter dieser Adresse läuft noch Skript-Version ' + (j.version || 1) + '. Bitte: Bereitstellen → Bereitstellungen verwalten → Stift → Version „Neue Version“ → Bereitstellen.' : '' };
  } catch (e) {
    return { ok: false, why: 'unreachable' };
  }
}

/** Wird vom Dialog aufgerufen: prüft die eingegebene Adresse, speichert sie und liefert den Verbindungscode. */
function saveUrl(url) {
  url = String(url || '').trim();
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) throw new Error('Das ist keine Web-App-Adresse. Sie beginnt mit https://script.google.com/ und endet mit /exec.');
  var r = checkUrl_(url);
  if (!r.ok) throw new Error(r.why === 'other'
    ? 'Diese Adresse gehört zu einem anderen Sheet. Nimm die Web-App-URL aus DIESEM Sheet (Erweiterungen → Apps Script → Bereitstellen → Bereitstellungen verwalten).'
    : 'Die Adresse antwortet nicht. Prüfe bei der Bereitstellung „Wer hat Zugriff: Jeder“.');
  PropertiesService.getScriptProperties().setProperty('WEBAPP_URL', url);
  return { url: url, code: CODE_PREFIX + url + '|' + getKey_(), warn: r.warn };
}

function resetKey() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.alert('Neuen Schlüssel erzeugen?', 'Alle bisher verbundenen Handys verlieren die Verbindung und müssen den neuen QR-Code scannen.', ui.ButtonSet.OK_CANCEL);
  if (r !== ui.Button.OK) return;
  PropertiesService.getScriptProperties().deleteProperty('KEY');
  getKey_();
  ui.alert('Neuer Schlüssel erzeugt. Öffne "ChronOar → Mit Handy verbinden" für den neuen QR-Code.');
}

/** Schlüssel dieses Sheets. Gehört er zu einem anderen Sheet (Kopie einer Vorlage), wird ein neuer erzeugt. */
function getKey_() {
  var props = PropertiesService.getScriptProperties();
  var id = SpreadsheetApp.getActive().getId();
  var key = props.getProperty('KEY');
  if (!key || props.getProperty('KEY_SHEET') !== id) {
    key = Utilities.getUuid().replace(/-/g, '');
    props.setProperties({ KEY: key, KEY_SHEET: id });
    props.deleteProperty('WEBAPP_URL'); // Adresse einer fremden Bereitstellung nicht übernehmen
  }
  return key;
}

/* ------------------------------------------------------------------ Web-App */

function doGet(e) {
  return handle_(function () {
    var p = (e && e.parameter) || {};
    checkKey_(p.key);
    if (p.action === 'ping') return { name: SpreadsheetApp.getActive().getName(), id: SpreadsheetApp.getActive().getId(), version: SCRIPT_VERSION };
    if (p.action === 'athletes') return { athletes: readAthletes_(), version: SCRIPT_VERSION };
    if (p.action === 'time') return {};
    if (p.action === 'regatta') {
      var st = readRegatta_();
      return st.etag === p.etag ? { same: true, etag: st.etag } : st;
    }
    throw new Error('unknown_action');
  });
}

function doPost(e) {
  return handle_(function () {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    checkKey_(body.key);
    if (body.action === 'pdf') return makePdf(body.form);   // App: „PDF für heute“
    if (body.action !== 'batch') throw new Error('unknown_action');
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      var done = [];
      (body.ops || []).forEach(function (o) {
        if (o.op === 'results') appendResults_(o.rows || []);
        else if (o.op === 'resultsDel') deleteRun_(o.run);
        else if (o.op === 'athlete') upsertAthlete_(o.athlete);
        else if (o.op === 'athleteDel') deleteAthlete_(o.id);
        else if (o.op === 'rgBoat') upsertRgBoat_(o.boat);
        else if (o.op === 'rgBoatDel') deleteRgBoat_(o.id);
        else if (o.op === 'rgNewRun') newRgRun_(o.id);
        else if (o.op === 'rgEvent') addRgEvent_(o.ev);
        else if (o.op === 'rgEventDel') delRgEvent_(o.id);
        done.push(o.qid);
      });
      SpreadsheetApp.flush();
      return { done: done };
    } finally { lock.releaseLock(); }
  });
}

function handle_(fn) {
  var out;
  try { out = fn(); out.ok = true; out.now = Date.now(); }
  catch (err) { out = { ok: false, error: String(err && err.message || err) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function checkKey_(k) { if (!k || k !== getKey_()) throw new Error('bad_key'); }

/* ------------------------------------------------------------------ Daten */

/** Blätter aus Version 1/2 („Ergebnisse“, „Mannschaften“) auf die neuen Namen umbenennen. */
function renameOld_() {
  var ss = SpreadsheetApp.getActive();
  Object.keys(OLD_NAMES).forEach(function (neu) {
    var old = ss.getSheetByName(OLD_NAMES[neu]);
    if (old && !ss.getSheetByName(neu)) old.setName(neu);
  });
}

function sheet_(name) {
  if (OLD_NAMES[name]) renameOld_();
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('missing_sheet:' + name);
  return sh;
}

/** Sportler lesen. Zeilen ohne ID bekommen eine. Unvollständige Zeilen werden übersprungen. */
function readAthletes_() {
  var sh = sheet_(SH_ATH), v = sh.getDataRange().getValues(), out = [], newIds = false;
  for (var i = 1; i < v.length; i++) {
    var r = v[i], first = String(r[1]).trim(), last = String(r[2]).trim();
    if (!first && !last) continue;
    var sex = normSex_(r[3]), age = normAge_(r[4]), weight = /^l/i.test(String(r[5]).trim()) ? 'L' : 'O';
    if (!sex || !age) continue;
    var id = String(r[0]).trim();
    if (!id) { id = newId_(); v[i][0] = id; newIds = true; }
    out.push({ id: id, first: first, last: last, sex: sex, age: age, weight: weight });
  }
  if (newIds) sh.getRange(1, 1, v.length, 1).setValues(v.map(function (r) { return [r[0]]; }));
  return out;
}

function normSex_(x) {
  x = String(x).trim().toLowerCase();
  if (/^(m|männlich|maennlich|male)/.test(x)) return 'M';
  if (/^(w|f|weiblich|female)/.test(x)) return 'F';
  return '';
}
function normAge_(x) {
  x = String(x).trim().toUpperCase().replace(/\s+/g, ' ');
  var m = x.match(/^(J|JUNIOR|JUNIORIN|S|SENIOR|SENIORIN)\s*-?\s*(A|B)$/);
  if (!m) return '';
  return (m[1][0] === 'J' ? 'J' : 'S') + m[2];
}
function newId_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 12); }

function upsertAthlete_(a) {
  if (!a || !a.id) return;
  var sh = sheet_(SH_ATH);
  var row = [a.id, a.first, a.last, a.sex === 'F' ? 'w' : 'm', AGE_TXT[a.age] || a.age, a.weight === 'L' ? 'Leicht' : 'Offen'];
  var r = findRow_(sh, a.id);
  if (r) sh.getRange(r, 1, 1, row.length).setValues([row]);
  else sh.appendRow(row);
  refreshNameList_();
}

function deleteAthlete_(id) {
  var sh = sheet_(SH_ATH), r = findRow_(sh, id);
  if (r) sh.deleteRow(r);
  refreshNameList_();
}

function findRow_(sh, id) {
  var n = sh.getLastRow();
  if (n < 2) return 0;
  var ids = sh.getRange(2, 1, n - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  return 0;
}

function appendResults_(rows) {
  fixHeaders_();
  var sh = sheet_(SH_RES), n = sh.getLastRow(), have = {};
  if (n > 1) sh.getRange(2, RC['ID'], n - 1, 1).getValues().forEach(function (r) { have[String(r[0])] = true; });
  var add = [];
  rows.forEach(function (r) {
    if (!r.id || have[r.id]) return;
    have[r.id] = true;
    var d = new Date(r.ts), tg = target_(r.dist, r.rel);
    add.push(rowFrom_(RES_HEAD, {
      'Mannschaft': r.crew || '', 'Sportler-ID': r.ath || '', 'Datum': d, 'Uhrzeit': d, 'Strecke (m)': r.dist,
      'Vorname': r.first, 'Nachname': r.last, 'Rolle': r.role, 'Kategorie': r.cat, 'Boot': r.boat,
      'Zeit': r.time, 'Zeit (s)': num_(r.t), '/500 m': r.pace, 'm/s': num_(r.v), 'Ø SF': num_(r.avgRate),
      'Frequenzen': r.rates || '', 'Startnummer': r.startNo || '', 'Abteilung': r.abt || '',
      'Splits': lapSplits_(r.splits || '', r.time), 'Relation (m/s)': num_(r.rel), 'Zielzeit': tg[0], 'Zielzeit (s)': tg[1],
      'Prozent': r.role === 'Steuerperson' ? '' : pct_(r.pct, r.pf), 'ID': r.id, 'Belastung': r.run }));
  });
  if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, RES_HEAD.length).setValues(add);
  appendTeams_(add);
  if (add.length) numberRuns_();
}
/**
 * Prozent als Anteil speichern (1,08 statt 108). Die App kennzeichnet Anteile mit pf=1 und wird nie umgerechnet –
 * auch nicht bei Testwerten wie 37,78 (= 3778 %). Nur sehr alte App-Versionen ohne pf schicken noch 108 → /100.
 */
function pct_(x, isFraction) { var n = num_(x); return n === '' ? '' : (!isFraction && n > 3 ? n / 100 : n); }
function num_(x) { return (x === null || x === undefined || x === '' || !isFinite(x)) ? '' : Number(x); }

function deleteRun_(run) {
  if (!run) return;
  var sh = sheet_(SH_RES), n = sh.getLastRow();
  if (n < 2) return;
  var runs = sh.getRange(2, RC['Belastung'], n - 1, 1).getValues();
  for (var i = runs.length - 1; i >= 0; i--) if (String(runs[i][0]) === String(run)) sh.deleteRow(i + 2);
  var t = teamSheet_(), tn = t.getLastRow();
  if (tn < 2) return;
  var truns = t.getRange(2, TC['Belastung'], tn - 1, 1).getValues();
  for (var j = truns.length - 1; j >= 0; j--) if (String(truns[j][0]) === String(run)) t.deleteRow(j + 2);
  numberRuns_();
}

/* ------------------------------------------------------------------ Mannschaften */

/** Blatt „Ergebnis Mannschaft“ holen bzw. anlegen (auch in älteren Sheets ohne erneutes "Einrichten"). */
function teamSheet_() {
  renameOld_();
  var ss = SpreadsheetApp.getActive(), had = !!ss.getSheetByName(SH_TEAM);
  var t = ensureSheet_(ss, SH_TEAM, TEAM_HEAD);
  if (!had) formatTeam_(t);
  return t;
}

/** Spaltenformate für „Ergebnis Mannschaft“ (Reihenfolge siehe TEAM_HEAD). */
function formatTeam_(t) { formatCols_(t, TEAM_HEAD, TEAM_FMT); }

/** „Ergebnis Mannschaft“ mit neuer Spaltenreihenfolge komplett neu anlegen (Inhalt kommt aus „Ergebnis Sportler“). */
function resetTeamSheet_() {
  var t = teamSheet_();
  t.clear();
  t.getRange(1, 1, 1, TEAM_HEAD.length).setValues([TEAM_HEAD]);
  t.getRange(1, 1, 1, TEAM_HEAD.length).setFontWeight('bold');
  t.setFrozenRows(1);
  formatTeam_(t);
  rebuildTeams_();
}

/** Fasst Ergebniszeilen (Format wie Blatt „Ergebnis Sportler“) zu einer Zeile pro Belastung zusammen. */
function teamRows_(resRows) {
  var v = function (r, name) { return r[RC[name] - 1]; };
  var by = {}, order = [];
  resRows.forEach(function (r) {
    var run = String(v(r, 'Belastung'));
    if (!run) return;
    if (!by[run]) { by[run] = { rowers: [], cox: [] }; order.push(run); }
    (v(r, 'Rolle') === 'Steuerperson' ? by[run].cox : by[run].rowers).push(r);
  });
  var name = function (r) { return v(r, 'Vorname') + ' ' + v(r, 'Nachname'); };
  var out = [];
  order.forEach(function (run) {
    var g = by[run], f = g.rowers[0];
    if (!f) return; // nur Steuerperson: keine Bootszeile
    var cats = [];
    g.rowers.forEach(function (r) { if (cats.indexOf(v(r, 'Kategorie')) < 0) cats.push(v(r, 'Kategorie')); });
    var tg = target_(v(f, 'Strecke (m)'), v(f, 'Relation (m/s)'));
    out.push(rowFrom_(TEAM_HEAD, {
      'Belastung': run, 'Datum': v(f, 'Datum'), 'Uhrzeit': v(f, 'Uhrzeit'), 'Strecke (m)': v(f, 'Strecke (m)'), 'Startnummer': v(f, 'Startnummer'), 'Abteilung': v(f, 'Abteilung'), 'Strecke Nr.': v(f, 'Strecke Nr.'),
      'Mannschaft': v(f, 'Mannschaft') || g.rowers.map(name).join(', '), 'Steuerperson': g.cox.map(name).join(', '),
      'Kategorien': cats.join(', '), 'Boot': v(f, 'Boot'), 'Zeit': v(f, 'Zeit'), 'Zeit (s)': v(f, 'Zeit (s)'),
      '/500 m': v(f, '/500 m'), 'm/s': v(f, 'm/s'), 'Ø SF': v(f, 'Ø SF'), 'Frequenzen': v(f, 'Frequenzen'), 'Splits': v(f, 'Splits'),
      'Relation (m/s)': v(f, 'Relation (m/s)'), 'Zielzeit': tg[0], 'Zielzeit (s)': tg[1], 'Prozent': v(f, 'Prozent') }));
  });
  return out;
}

/** Neue Ergebniszeilen → fehlende Bootszeilen anhängen. */
function appendTeams_(resRows) {
  var rows = teamRows_(resRows);
  if (!rows.length) return;
  var t = teamSheet_(), n = t.getLastRow(), have = {};
  if (n > 1) t.getRange(2, TC['Belastung'], n - 1, 1).getValues().forEach(function (r) { have[String(r[0])] = true; });
  rows = rows.filter(function (r) { return !have[String(r[TC['Belastung'] - 1])]; });
  if (rows.length) t.getRange(t.getLastRow() + 1, 1, rows.length, TEAM_HEAD.length).setValues(rows);
}

/** Blatt „Ergebnis Mannschaft“ komplett aus „Ergebnis Sportler“ neu bilden (Menü). */
function rebuildTeams() {
  var n = rebuildTeams_();
  SpreadsheetApp.getUi().alert('Ergebnis Mannschaft neu aufgebaut: ' + n + ' Bootszeilen.');
}

/** Zielzeit des Bootes = Strecke / Relationsgeschwindigkeit → ['6:45,3', 405.3] (Zehntel abgeschnitten wie in der App). */
function target_(dist, rel) {
  dist = Number(dist); rel = Number(rel);
  if (!(dist > 0) || !(rel > 0)) return ['', ''];
  var sec = dist / rel, t = Math.floor(sec * 10 + 1e-6), m = Math.floor(t / 600), s = Math.floor(t / 10) % 60;
  var txt = (m >= 60 ? Math.floor(m / 60) + ':' + ('0' + m % 60).slice(-2) : m) + ':' + ('0' + s).slice(-2) + ',' + (t % 10);
  return [txt, Math.round(sec * 10) / 10];
}

/** Überschriften älterer Blätter um neue Spalten (z. B. Zielzeit) ergänzen. */
function fixHeaders_() {
  var ss = SpreadsheetApp.getActive();
  var same = function (sh, head) {
    var cur = sh.getRange(1, 1, 1, head.length).getValues()[0];
    return !cur.some(function (c, i) { return String(c) !== head[i]; });
  };
  var res = ss.getSheetByName(SH_RES);
  if (res && !same(res, RES_HEAD)) migrateRes_(res);   // „Ergebnis Sportler“: Spalten nach Namen umsortieren
  var team = ss.getSheetByName(SH_TEAM);               // „Ergebnis Mannschaft“: wird aus „Ergebnis Sportler“ neu gebildet
  if (team && !same(team, TEAM_HEAD)) resetTeamSheet_();
}

/**
 * „Ergebnis Sportler“ in die aktuelle Spaltenreihenfolge bringen, ohne Daten zu verlieren:
 * jede Spalte wird über ihre Überschrift zugeordnet; unbekannte eigene Spalten bleiben hinten erhalten;
 * fehlende Spalten (z. B. Zielzeit bei alten Zeilen) bleiben leer und werden danach nachgetragen.
 */
function migrateRes_(sh) {
  var data = sh.getDataRange().getValues(), oldHead = data[0].map(String), rows = data.slice(1);
  var extra = oldHead.filter(function (h) { return h && RES_HEAD.indexOf(h) < 0; });
  var head = RES_HEAD.concat(extra);
  var out = rows.filter(function (r) { return r.some(function (c) { return c !== ''; }); }).map(function (r) {
    var o = {};
    oldHead.forEach(function (h, i) { if (h) o[h] = r[i]; });
    if (o['Splits'] !== undefined) o['Splits'] = lapSplits_(o['Splits'], o['Zeit']);
    return rowFrom_(head, o);
  });
  sh.clear();
  formatCols_(sh, RES_HEAD, RES_FMT);
  sh.getRange(1, 1, 1, head.length).setValues([head]);
  sh.getRange(1, 1, 1, head.length).setFontWeight('bold');
  sh.setFrozenRows(1);
  if (out.length) sh.getRange(2, 1, out.length, head.length).setValues(out);
  var team = SpreadsheetApp.getActive().getSheetByName(SH_TEAM);
  if (team) resetTeamSheet_();
}

/** Zeittext „m:ss,t“ bzw. „h:mm:ss,t“ → Zehntelsekunden (oder null). */
function tenths_(txt) {
  var m = String(txt).trim().match(/^(?:(\d+):)?(\d+):(\d{2})[,.](\d)$/);
  if (!m) return null;
  return ((Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 10 + Number(m[4]);
}
function fmtTenths_(t) {
  var m = Math.floor(t / 600), s = Math.floor(t / 10) % 60;
  return (m >= 60 ? Math.floor(m / 60) + ':' + ('0' + m % 60).slice(-2) : m) + ':' + ('0' + s).slice(-2) + ',' + (t % 10);
}
/**
 * Splits als Abschnittszeiten (Zeit seit dem letzten Split). Ältere Daten enthalten Zeiten ab Start
 * („1:00 | 2:00“); erkennbar daran, dass der letzte Wert der Endzeit entspricht → umrechnen in „1:00 | 1:00“.
 */
function lapSplits_(splits, zeit) {
  var parts = String(splits || '').split('|').map(function (x) { return x.trim(); }).filter(String);
  if (parts.length < 2) return String(splits || '');
  var t = parts.map(tenths_), total = tenths_(zeit);
  if (t.some(function (x) { return x === null; }) || total === null || t[t.length - 1] !== total) return String(splits);
  return t.map(function (x, i) { return fmtTenths_(i ? x - t[i - 1] : x); }).join(' | ');
}

/** Fehlende Zielzeiten in alten Zeilen nachtragen (aus Strecke und Relation). */
function fixTargets_() {
  // [Blatt, Spalte Strecke, Spalte Relation, Spalte Zielzeit (Zielzeit (s) steht direkt rechts daneben)]
  [[SH_RES, RC['Strecke (m)'], RC['Relation (m/s)'], RC['Zielzeit']], [SH_TEAM, TC['Strecke (m)'], TC['Relation (m/s)'], TC['Zielzeit']]].forEach(function (x) {
    var sh = SpreadsheetApp.getActive().getSheetByName(x[0]);
    if (!sh || sh.getLastRow() < 2) return;
    var n = sh.getLastRow() - 1;
    var dist = sh.getRange(2, x[1], n, 1).getValues(), rel = sh.getRange(2, x[2], n, 1).getValues();
    var tg = sh.getRange(2, x[3], n, 2), v = tg.getValues(), changed = false;
    v.forEach(function (r, i) { if (r[0] === '' && dist[i][0] !== '') { var t = target_(dist[i][0], rel[i][0]); if (t[0]) { v[i] = t; changed = true; } } });
    if (changed) tg.setValues(v);
  });
}

/** Einmalige Umstellung (Version 5) alter Prozentwerte (108) in Anteile (1,08). Wird ab Version 10 nicht mehr automatisch
 *  ausgeführt, weil echte Anteile aus Testfahrten (z. B. 37,78) sonst fälschlich umgerechnet würden. */
function fixPercent_() {
  [[SH_RES, RC['Prozent']], [SH_TEAM, TC['Prozent']]].forEach(function (x) {
    var sh = SpreadsheetApp.getActive().getSheetByName(x[0]);
    if (!sh || sh.getLastRow() < 2) return;
    var rg = sh.getRange(2, x[1], sh.getLastRow() - 1, 1), v = rg.getValues(), changed = false;
    v.forEach(function (r) { if (typeof r[0] === 'number' && r[0] > 3) { r[0] = r[0] / 100; changed = true; } });
    if (changed) rg.setValues(v);
  });
}

/** Abgleich ohne Neuaufbau: fehlende Bootszeilen anhängen, verwaiste entfernen. Gibt die Zahl neuer Zeilen zurück. */
function syncTeams_() {
  var res = sheet_(SH_RES), n = res.getLastRow();
  var want = teamRows_(n > 1 ? res.getRange(2, 1, n - 1, RES_HEAD.length).getValues() : []);
  var t = teamSheet_(), tn = t.getLastRow();
  var have = tn > 1 ? t.getRange(2, 1, tn - 1, 1).getValues().map(function (r) { return String(r[0]); }) : [];
  var wantSet = {}, haveSet = {};
  want.forEach(function (r) { wantSet[String(r[0])] = true; });
  for (var i = have.length - 1; i >= 0; i--) {
    if (have[i] && !wantSet[have[i]]) t.deleteRow(i + 2); else haveSet[have[i]] = true;
  }
  var add = want.filter(function (r) { return !haveSet[String(r[0])]; });
  if (add.length) t.getRange(t.getLastRow() + 1, 1, add.length, TEAM_HEAD.length).setValues(add);
  return add.length;
}
/**
 * „Strecke Nr.“: zählt pro Kalendertag die Fahrten derselben Mannschaft (gleiche Ruderer – Reihenfolge egal,
 * Steuerperson zählt nicht – im gleichen Boot) in zeitlicher Reihenfolge: „1. Strecke“, „2. Strecke“, …
 * Wird nach jedem Upload, jedem zurückgenommenen Stopp und beim Öffnen des Sheets komplett neu berechnet,
 * damit auch spät hochgeladene oder gelöschte Fahrten richtig einsortiert werden.
 */
function numberRuns_() {
  var ss = SpreadsheetApp.getActive(), res = ss.getSheetByName(SH_RES);
  if (!res || res.getLastRow() < 2) return;
  var tz = ss.getSpreadsheetTimeZone ? ss.getSpreadsheetTimeZone() : 'Europe/Berlin';
  var n = res.getLastRow() - 1, data = res.getRange(2, 1, n, RES_HEAD.length).getValues();
  var v = function (r, name) { return r[RC[name] - 1]; };
  var runs = {};   // Belastung → {ts, day, boat, ids[]}
  data.forEach(function (r) {
    var run = String(v(r, 'Belastung')); if (!run) return;
    var d = v(r, 'Datum'); d = d instanceof Date ? d : new Date(d);
    var x = runs[run] || (runs[run] = { ts: d.getTime(), boat: v(r, 'Boot'), ids: [],
      day: isNaN(d.getTime()) ? '' : Utilities.formatDate(d, tz, 'yyyy-MM-dd') });
    if (v(r, 'Rolle') !== 'Steuerperson') x.ids.push(String(v(r, 'Sportler-ID') || (v(r, 'Vorname') + ' ' + v(r, 'Nachname'))));
  });
  var groups = {};
  Object.keys(runs).forEach(function (run) {
    var x = runs[run], key = x.day + '|' + x.boat + '|' + x.ids.sort().join(',');
    (groups[key] = groups[key] || []).push(run);
  });
  var label = {};
  Object.keys(groups).forEach(function (k) {
    groups[k].sort(function (a, b) { return runs[a].ts - runs[b].ts; })
      .forEach(function (run, i) { label[run] = (i + 1) + '. Strecke'; });
  });
  var writeCol = function (sh, cols, nRows, runCol, nrCol) {
    if (!sh || nRows < 1) return;
    var runsV = sh.getRange(2, runCol, nRows, 1).getValues(), rg = sh.getRange(2, nrCol, nRows, 1), cur = rg.getValues(), changed = false;
    var out = runsV.map(function (r, i) { var l = label[String(r[0])] || ''; if (l !== cur[i][0]) changed = true; return [l]; });
    if (changed) rg.setValues(out);
  };
  writeCol(res, RES_HEAD, n, RC['Belastung'], RC['Strecke Nr.']);
  var team = ss.getSheetByName(SH_TEAM);
  if (team && team.getLastRow() > 1) writeCol(team, TEAM_HEAD, team.getLastRow() - 1, TC['Belastung'], TC['Strecke Nr.']);
}

function rebuildTeams_() {
  var res = sheet_(SH_RES), n = res.getLastRow();
  var data = n > 1 ? res.getRange(2, 1, n - 1, RES_HEAD.length).getValues() : [];
  var rows = teamRows_(data), t = teamSheet_();
  if (t.getLastRow() > 1) t.getRange(2, 1, t.getLastRow() - 1, TEAM_HEAD.length).clearContent();
  if (rows.length) t.getRange(2, 1, rows.length, TEAM_HEAD.length).setValues(rows);
  return rows.length;
}

/* ------------------------------------------------------------------ Regatta */
/*
 * Blatt „Regatta“: eine Zeile pro Boot. Kann in der App ODER direkt im Sheet gepflegt werden
 * (Sportler per Auswahlliste, Schreibweise „Vorname Nachname“ wie im Blatt Sportler).
 * Blatt „Regatta-Log“ (versteckt): jedes Ereignis jedes Handys (Start, Split, Frequenz, Stopp) mit Serverzeit.
 * Die Handys holen sich beides regelmäßig ab und berechnen daraus die laufenden Uhren.
 * Die Ergebniszeilen schickt das Handy, das gestoppt hat (wie bei den normalen Uhren).
 */
var SH_RG = 'Regatta', SH_LOG = 'Regatta-Log', SH_LIST = '_Listen';
var RG_HEAD = ['ID', 'Abteilung', 'Startnummer', 'Boot', 'Strecke (m)', 'Platz 1', 'Platz 2', 'Platz 3', 'Platz 4',
  'Platz 5', 'Platz 6', 'Platz 7', 'Platz 8', 'Steuerperson', 'Lauf'];
var LOG_HEAD = ['Event-ID', 'Boot-ID', 'Lauf', 'Typ', 'Zeit', 'Wert', 'Gelöscht', 'Gerät', 'Eingang'];
var BOAT_LIST = ['1x', '2x', '2-', '2+', '4x', '4x+', '4-', '4+', '8+', 'Ergo'];

function regattaSheet_() {
  var ss = SpreadsheetApp.getActive(), had = ss.getSheetByName(SH_RG);
  if (had) return had;   // schneller Weg: wird bei jeder Abfrage der Handys aufgerufen
  var sh = ensureSheet_(ss, SH_RG, RG_HEAD);
  if (!had) {
    sh.getRange('A:A').setFontColor('#999999');
    sh.getRange('O:O').setFontColor('#999999');
    sh.getRange('C:C').setNumberFormat('@');
    sh.getRange('A1').setNote('Wird automatisch vergeben. Neue Boote einfach ab Spalte B eintragen.');
    sh.getRange('O1').setNote('Wird von der App hochgezählt („Neuer Lauf“).');
    sh.getRange('D2:D').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(BOAT_LIST, true).setAllowInvalid(false).build());
    var list = SpreadsheetApp.getActive().getSheetByName(SH_LIST) || listSheet_();
    var dv = SpreadsheetApp.newDataValidation().requireValueInRange(list.getRange('A2:A'), true).setAllowInvalid(true).build();
    sh.getRange('F2:N').setDataValidation(dv);
  }
  return sh;
}
function logSheet_() {
  var ss = SpreadsheetApp.getActive(), had = ss.getSheetByName(SH_LOG);
  if (had) return had;
  var sh = ensureSheet_(ss, SH_LOG, LOG_HEAD);
  if (!had) { try { sh.hideSheet(); } catch (e) { } }
  return sh;
}
function listSheet_() {
  var ss = SpreadsheetApp.getActive(), sh = ss.getSheetByName(SH_LIST);
  if (!sh) { sh = ss.insertSheet(SH_LIST); sh.getRange(1, 1).setValue('Sportler (automatisch)'); try { sh.hideSheet(); } catch (e) { } }
  return sh;
}
/** Namensliste für die Auswahllisten im Blatt Regatta („Vorname Nachname“, alphabetisch nach Nachname). */
function refreshNameList_() {
  var ath = SpreadsheetApp.getActive().getSheetByName(SH_ATH);
  if (!ath) return;
  var v = ath.getDataRange().getValues().slice(1).filter(function (r) { return String(r[1]).trim() || String(r[2]).trim(); });
  v.sort(function (a, b) { return String(a[2]).localeCompare(String(b[2])) || String(a[1]).localeCompare(String(b[1])); });
  var names = v.map(function (r) { return [String(r[1]).trim() + ' ' + String(r[2]).trim()]; });
  var sh = listSheet_();
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 1).clearContent();
  if (names.length) sh.getRange(2, 1, names.length, 1).setValues(names);
}
/** Einfacher Trigger: Änderungen im Blatt Sportler aktualisieren sofort die Auswahllisten der Regatta. */
function onEdit(e) {
  try { if (e && e.range && e.range.getSheet().getName() === SH_ATH) refreshNameList_(); } catch (err) { }
}
function athleteNames_() {
  var ath = SpreadsheetApp.getActive().getSheetByName(SH_ATH), byName = {}, byId = {};
  if (ath) ath.getDataRange().getValues().slice(1).forEach(function (r) {
    var id = String(r[0]).trim(), name = (String(r[1]).trim() + ' ' + String(r[2]).trim()).trim();
    if (!name) return;
    if (id) byId[id] = name;
    byName[name.toLowerCase()] = id || null;
  });
  return { byName: byName, byId: byId };
}

/** Regatta lesen: Boote (Zeilen ohne ID bekommen eine) + Ereignisse des aktuellen Laufs jedes Bootes. */
function readRegatta_() {
  var sh = regattaSheet_(), n = sh.getLastRow(), names = athleteNames_(), boats = [], dirty = false;
  var rows = n > 1 ? sh.getRange(2, 1, n - 1, RG_HEAD.length).getValues() : [];
  rows.forEach(function (r, i) {
    if (!r.slice(1, 14).some(function (c) { return String(c).trim(); })) return;
    if (!String(r[0]).trim()) { r[0] = newId_(); sh.getRange(i + 2, 1).setValue(r[0]); dirty = true; }
    if (!(Number(r[14]) >= 1)) { r[14] = 1; sh.getRange(i + 2, 15).setValue(1); }
    var person = function (c) {
      var nm = String(c || '').trim(); if (!nm) return null;
      var id = names.byName[nm.toLowerCase()];
      return { id: id || null, name: nm };
    };
    var crew = []; for (var k = 5; k <= 12; k++) { var pp = person(r[k]); if (pp) crew.push(pp); }
    boats.push({ id: String(r[0]), abt: String(r[1]).trim(), startNo: String(r[2]).trim(), boat: String(r[3]).trim(),
      dist: Number(String(r[4]).replace(',', '.')) || 0, crew: crew, cox: person(r[13]), lauf: Number(r[14]) || 1, row: i + 2 });
  });
  var cur = {}; boats.forEach(function (b) { cur[b.id] = b.lauf; });
  var log = logSheet_(), ln = log.getLastRow(), events = [];
  if (ln > 1) log.getRange(2, 1, ln - 1, LOG_HEAD.length).getValues().forEach(function (r) {
    var bid = String(r[1]);
    if (r[6] === true || String(r[6]) === 'TRUE' || cur[bid] === undefined || Number(r[2]) !== cur[bid]) return;
    events.push({ id: String(r[0]), boat: bid, lauf: Number(r[2]), type: String(r[3]), t: Number(r[4]), v: r[5] === '' ? null : Number(r[5]), dev: String(r[7]) });
  });
  boats.forEach(function (b) { delete b.row; });
  var body = { boats: boats, events: events };
  var etag = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(body)));
  body.etag = etag;
  return body;
}
function findRgRow_(id) {
  var sh = regattaSheet_(), n = sh.getLastRow();
  if (n < 2) return 0;
  var ids = sh.getRange(2, 1, n - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  return 0;
}
function upsertRgBoat_(b) {
  if (!b || !b.id) return;
  var sh = regattaSheet_(), names = athleteNames_().byId, r = findRgRow_(b.id);
  var nm = function (p) { return p ? (names[p.id] || p.name || '') : ''; };
  var crew = (b.crew || []).slice(0, 8).map(nm); while (crew.length < 8) crew.push('');
  var lauf = r ? Number(sh.getRange(r, 15).getValue()) || 1 : 1;
  var row = [b.id, b.abt || '', String(b.startNo || ''), b.boat || '', Number(b.dist) || ''].concat(crew, [nm(b.cox), lauf]);
  if (r) sh.getRange(r, 1, 1, row.length).setValues([row]);
  else sh.getRange(sh.getLastRow() + 1, 1, 1, row.length).setValues([row]);
}
function deleteRgBoat_(id) { var r = findRgRow_(id); if (r) regattaSheet_().deleteRow(r); }
function newRgRun_(id) {
  var r = findRgRow_(id); if (!r) return;
  var c = regattaSheet_().getRange(r, 15); c.setValue((Number(c.getValue()) || 1) + 1);
}
function addRgEvent_(ev) {
  if (!ev || !ev.id || !ev.boat) return;
  var log = logSheet_(), n = log.getLastRow();
  if (n > 1) {
    var from = Math.max(2, n - 500);   // nur die letzten Einträge auf Doppel-Upload prüfen
    var ids = log.getRange(from, 1, n - from + 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === ev.id) return;
  }
  log.getRange(n + 1, 1, 1, LOG_HEAD.length).setValues([[ev.id, ev.boat, Number(ev.lauf) || 1, ev.type, Number(ev.t),
    ev.v === null || ev.v === undefined ? '' : Number(ev.v), false, ev.dev || '', Date.now()]]);
}
function delRgEvent_(id) {
  var log = logSheet_(), n = log.getLastRow(); if (n < 2) return;
  var ids = log.getRange(2, 1, n - 1, 1).getValues();
  for (var i = ids.length - 1; i >= 0; i--) if (String(ids[i][0]) === String(id)) { log.getRange(i + 2, 7).setValue(true); return; }
}
/** Menü: Regatta komplett leeren (Boote und Protokoll). Ergebnisse bleiben erhalten. */
function clearRegatta() {
  var ui = SpreadsheetApp.getUi();
  if (ui.alert('Regatta leeren?', 'Alle Boote und Zeiten im Blatt „Regatta“ werden gelöscht. Die Ergebnis-Blätter bleiben erhalten.', ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;
  [regattaSheet_(), logSheet_()].forEach(function (sh) { if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1); });
}

/* ------------------------------------------------------------------ Ergebnis-PDF */
/*
 * Menü „ChronOar → Ergebnis-PDF erstellen“: alle Fahrten eines Tages aus „Ergebnis Mannschaft“ als PDF (A4 hoch)
 * in drei Teilen: nach Prozent · nach Strecke Nr., dann Prozent · nach Mannschaft, dann Prozent.
 * Die Seiten werden hier selbst umbrochen (Zeilenhöhen geschätzt), damit Spaltenköpfe auf jeder Seite stehen,
 * keine Fahrt zerrissen wird und eine Mannschaft im dritten Teil nicht über zwei Seiten läuft.
 * Das PDF wird im selben Drive-Ordner wie das Sheet gespeichert.
 */
var PDF_PAGE = 780, PDF_FIRST = 670, PDF_ROW = 40, PDF_ROW_WRAP = 15, PDF_GRP = 36;  // Höhen in px (geschätzt, mit Reserve)
var PDF_LOGO = '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';

function showPdf() {
  var t = HtmlService.createTemplate(PDF_DIALOG);
  t.days = JSON.stringify(pdfDays_());
  SpreadsheetApp.getUi().showModalDialog(t.evaluate().setWidth(440).setHeight(560), 'Ergebnis-PDF erstellen');
}
function pdfTz_() { return SpreadsheetApp.getActive().getSpreadsheetTimeZone() || Session.getScriptTimeZone(); }
function pdfDayKey_(d) {
  if (d instanceof Date) return Utilities.formatDate(d, pdfTz_(), 'yyyy-MM-dd');
  var m = String(d || '').match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  return m ? m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2) : '';
}
function pdfTime_(d) {
  if (d instanceof Date) return Utilities.formatDate(d, pdfTz_(), 'HH:mm');
  var m = String(d || '').match(/(\d{1,2}):(\d{2})/); return m ? ('0' + m[1]).slice(-2) + ':' + m[2] : '';
}
function pdfRows_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SH_TEAM);
  if (!sh || sh.getLastRow() < 2) return [];
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0], c = {};
  head.forEach(function (h, i) { c[h] = i; });
  return sh.getRange(2, 1, sh.getLastRow() - 1, head.length).getValues().map(function (r) {
    var g = function (n) { return c[n] === undefined ? '' : r[c[n]]; };
    return { day: pdfDayKey_(g('Datum')), time: pdfTime_(g('Uhrzeit')), abt: String(g('Abteilung') || '').trim(), dist: Number(g('Strecke (m)')) || 0, nr: String(g('Strecke Nr.') || ''),
      crew: String(g('Mannschaft') || ''), cox: String(g('Steuerperson') || ''), cats: String(g('Kategorien') || ''), boat: String(g('Boot') || ''),
      time_s: Number(g('Zeit (s)')) || 0, zeit: String(g('Zeit') || ''), v: Number(g('m/s')) || 0, sf: g('Ø SF') === '' ? null : Number(g('Ø SF')),
      splits: String(g('Splits') || ''), rel: g('Relation (m/s)') === '' ? null : Number(g('Relation (m/s)')),
      pct: g('Prozent') === '' ? null : Number(g('Prozent')) * 100 };
  }).filter(function (x) { return x.day && x.crew; });
}
/** Tage mit Fahrten für die Auswahl im Dialog, neueste zuerst. */
function pdfDays_() {
  var n = {};
  pdfRows_().forEach(function (r) { n[r.day] = (n[r.day] || 0) + 1; });
  return Object.keys(n).sort().reverse().map(function (k) { return { day: k, label: pdfDate_(k, false) + ' (' + n[k] + ' Fahrt' + (n[k] === 1 ? '' : 'en') + ')' }; });
}
function pdfDate_(key, weekday) {
  var p = key.split('-'), d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  return (weekday ? ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][d.getDay()] + ', ' : '') + p[2] + '.' + p[1] + '.' + p[0];
}
function pdfEsc_(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function pdfDec_(x, n) { return x === null || x === undefined || !isFinite(x) ? '–' : x.toFixed(n).replace('.', ','); }
/** „JM B L“ → „JMBL1x“; gemischte Boote „JMA/JMBL 4x“. */
function pdfBoat_(r) {
  var cats = r.cats.split(',').map(function (c) { return c.replace(/\s+/g, ''); }).filter(String);
  cats = cats.filter(function (c, i) { return cats.indexOf(c) === i; }).sort();
  if (!cats.length) return r.boat;
  return cats.length === 1 ? cats[0] + r.boat : cats.join('/') + ' ' + r.boat;
}
function pdfNr_(s) { var m = String(s).match(/\d+/); return m ? Number(m[0]) : 9999; }
function pdfByPct_(a, b) { return (b.pct === null ? -1 : b.pct) - (a.pct === null ? -1 : a.pct); }
function pdfCrewKey_(r) { return r.boat + '|' + r.crew.split(',').map(function (s) { return s.trim().toLowerCase(); }).sort().join(','); }

/** Dialog → PDF bauen und speichern. f = {day, ort, wind, temp, goal} */
function makePdf(f) {
  f = f || {};
  if (!f.day) throw new Error('Bitte einen Tag wählen.');
  if (!String(f.ort || '').trim()) throw new Error('Bitte den Ort eintragen.');
  var runs = pdfRows_().filter(function (r) { return r.day === f.day; });
  if (!runs.length) throw new Error('An diesem Tag gibt es keine Fahrten.');
  var html = pdfHtml_(runs, f);
  var ss = SpreadsheetApp.getActive();
  var name = 'ChronOar ' + f.day + ' ' + String(f.ort).trim().replace(/[\\\/:*?"<>|]/g, '').slice(0, 40) + '.pdf';
  var blob = Utilities.newBlob(html, 'text/html', 'ergebnis.html').getAs('application/pdf').setName(name);
  var parents = DriveApp.getFileById(ss.getId()).getParents();
  var file = parents.hasNext() ? parents.next().createFile(blob) : DriveApp.createFile(blob);
  return { name: name, url: file.getUrl(), download: 'https://drive.google.com/uc?export=download&id=' + file.getId() };
}

function pdfHtml_(runs, f) {
  var times = runs.map(function (r) { return r.time; }).filter(String).sort();
  var when = pdfDate_(f.day, true), span = times.length ? times[0] + ' – ' + times[times.length - 1] + ' Uhr' : '';
  var byPct = function (l) { return l.slice().sort(pdfByPct_); };
  // Teil 2: Strecke Nr.
  var nrs = {}, nrKeys = [];
  runs.forEach(function (r) { var k = r.nr || 'ohne Nummer'; if (!nrs[k]) { nrs[k] = []; nrKeys.push(k); } nrs[k].push(r); });
  nrKeys.sort(function (a, b) { return pdfNr_(a) - pdfNr_(b); });
  // Teil 3: Mannschaften (gleiche Ruderer im gleichen Boot), geordnet nach ihrem besten Ergebnis
  var crews = {}, crewKeys = [];
  runs.forEach(function (r) { var k = pdfCrewKey_(r); if (!crews[k]) { crews[k] = []; crewKeys.push(k); } crews[k].push(r); });
  var best = function (k) { return Math.max.apply(null, crews[k].map(function (r) { return r.pct === null ? -1 : r.pct; })); };
  crewKeys.sort(function (a, b) { return best(b) - best(a); });

  // Teil 3: jede Abteilung und Strecke Nr. einzeln (nur wenn an diesem Tag Abteilungen vergeben wurden)
  var abts = {}, abtKeys = [], hasAbt = runs.some(function (r) { return r.abt; });
  runs.forEach(function (r) { var k = (r.abt || '\uffff') + '\u0000' + (r.nr || 'ohne Nummer'); if (!abts[k]) { abts[k] = []; abtKeys.push(k); } abts[k].push(r); });
  abtKeys.sort(function (a, b) {
    var x = a.split('\u0000'), y = b.split('\u0000');
    return x[0].localeCompare(y[0], 'de', { numeric: true }) || pdfNr_(x[1]) - pdfNr_(y[1]);
  });
  var secs = [
    { title: 'Nach Prozent', keep: false, blocks: [{ title: null, runs: byPct(runs) }] },
    { title: 'Nach Strecke Nr., dann Prozent', keep: false, blocks: nrKeys.map(function (k) { return { title: pdfEsc_(k), runs: byPct(nrs[k]) }; }) }
  ];
  if (hasAbt) secs.push({ title: 'Nach Abteilung und Strecke Nr., dann Prozent', keep: true, blocks: abtKeys.map(function (k) {
    var x = k.split('\u0000');
    return { title: pdfEsc_(x[0] === '\uffff' ? 'Ohne Abteilung' : x[0]) + ' <span class="gb">' + pdfEsc_(x[1]) + '</span>', runs: byPct(abts[k]) }; }) });
  secs = secs.concat([
    { title: 'Nach Mannschaft, dann Prozent', keep: true, blocks: crewKeys.map(function (k) {
        var r0 = crews[k][0];
        return { title: pdfEsc_(r0.crew) + ' <span class="gb">' + pdfEsc_(pdfBoat_(r0)) + '</span>', runs: byPct(crews[k]) }; }) }
  ]);
  var rowH = function (r) { return PDF_ROW + ((r.crew.length + (r.cox ? r.cox.length + 6 : 0)) > 42 ? PDF_ROW_WRAP : 0); };
  var pages = [];
  secs.forEach(function (sec) {
    var cap = pages.length ? PDF_PAGE : PDF_FIRST, cur = [], used = 0;
    var flush = function () { pages.push({ title: sec.title, rows: cur }); cur = []; used = 0; cap = PDF_PAGE; };
    sec.blocks.forEach(function (bl) {
      var hs = bl.runs.map(rowH), need = (bl.title ? PDF_GRP : 0) + hs.reduce(function (a, b) { return a + b; }, 0);
      if (sec.keep && used && used + need > cap) flush();                       // Mannschaft passt nicht mehr ganz → neue Seite
      if (bl.title) { if (used + PDF_GRP + hs[0] > cap) flush(); cur.push(pdfGrp_(bl.title)); used += PDF_GRP; }
      bl.runs.forEach(function (r, i) {
        if (used + hs[i] > cap) { flush(); if (bl.title) { cur.push(pdfGrp_(bl.title + ' <span class="gb">(Fortsetzung)</span>')); used += PDF_GRP; } }
        cur.push(pdfRun_(r, i % 2)); used += hs[i];
      });
    });
    if (cur.length) flush();
  });
  var info = '<table class="info"><tr><td class="k">Ort</td><td>' + pdfEsc_(f.ort) + '</td>' +
    (f.wind ? '<td class="k">Wind</td><td>' + pdfEsc_(f.wind) + '</td>' : '<td></td><td></td>') + '</tr>' +
    (f.temp ? '<tr><td class="k">Temperatur</td><td>' + pdfEsc_(f.temp) + '</td><td></td><td></td></tr>' : '') +
    (f.goal ? '<tr><td class="k">Vorgabe</td><td colspan="3"><div class="goal">' + pdfEsc_(f.goal).replace(/\n/g, '<br>') + '</div></td></tr>' : '') + '</table>';
  var made = Utilities.formatDate(new Date(), pdfTz_(), "dd.MM.yyyy, HH:mm");
  var out = pages.map(function (p, i) {
    return '<div class="page' + (i ? ' brk' : '') + '"><table class="head"><tr><td style="width:52px"><img src="data:image/png;base64,' + PDF_LOGO + '" width="42" height="42"></td>' +
      '<td><div class="h1"><span class="c1">CHRON</span><span class="c2">OAR</span></div><div class="by">von Lennart Geerdes</div></td>' +
      '<td class="when"><b>' + when + '</b><br>' + span + '</td></tr></table>' + (i ? '' : info) + '<div class="sec">' + p.title + '</div>' +
      '<table class="res">' + PDF_THEAD + p.rows.join('') + '</table>' +
      '<table class="foot"><tr><td>Erstellt am ' + made + ' mit <b>ChronOar</b> – Trainings- und Regatta-App von Lennart Geerdes</td><td class="r">Seite ' + (i + 1) + ' / ' + pages.length + '</td></tr></table></div>';
  }).join('');
  return '<!doctype html><html><head><meta charset="utf-8"><style>' + PDF_CSS + '</style></head><body>' + out + '</body></html>';
}
function pdfGrp_(t) { return '<tbody class="grp"><tr><td colspan="7">' + t + '</td></tr></tbody>'; }
function pdfRun_(r, alt) {
  var crew = '<b>' + pdfEsc_(r.crew) + '</b>' + (r.cox ? ' <span class="cox">· St: ' + pdfEsc_(r.cox) + '</span>' : '');
  return '<tbody class="res' + (alt ? ' alt' : '') + '"><tr class="l1"><td>' + crew + '</td><td class="bt">' + pdfEsc_(pdfBoat_(r)) + '</td>' +
    '<td class="n">' + (r.dist ? r.dist.toLocaleString('de-DE').replace(/,/g, '.') + ' m' : '–') + '</td><td class="n">' + pdfDec_(r.sf, 1) + '</td>' +
    '<td class="n">' + pdfDec_(r.v, 2) + '</td><td class="n t">' + pdfEsc_(r.zeit) + '</td><td class="n pct">' + (r.pct === null ? '–' : pdfDec_(r.pct, 1) + ' %') + '</td></tr>' +
    '<tr class="l2"><td>' + pdfEsc_(r.nr) + '</td><td>' + (r.rel ? pdfDec_(r.rel, 2) + ' m/s' + (r.dist ? ' – ' + target_(r.dist, r.rel)[0] : '') : '–') + '</td>' +
    '<td class="sp" colspan="4">' + (r.splits ? '<span class="lbl">Splits</span> ' + pdfEsc_(r.splits) : '') + '</td><td></td></tr></tbody>';
}
var PDF_THEAD = '<colgroup><col width="35%"><col width="17%"><col width="11%"><col width="8%"><col width="8%"><col width="10%"><col width="11%"></colgroup>' +
  '<thead><tr><th>Mannschaft</th><th>Boot</th><th class="n">Distanz</th><th class="n">Ø SF</th><th class="n">m/s</th><th class="n">Zeit</th><th class="n">Prozent</th></tr>' +
  '<tr class="hl2"><th>Strecke Nr.</th><th>Relation – Zielzeit</th><th></th><th></th><th></th><th class="n">Splits</th><th></th></tr></thead>';
var PDF_CSS =
  '@page{size:A4;margin:12mm}body{margin:0;font-family:Arial,Helvetica,sans-serif;color:#1d1d1f}' +
  '.brk{page-break-before:always}' +
  '.head{width:100%;border-collapse:collapse;border-bottom:3px solid #e8740c;margin-bottom:10px}.head td{vertical-align:middle;padding:0 0 8px}' +
  '.h1{font-size:25px;font-weight:bold;letter-spacing:2px}.c1{color:#1d1d1f}.c2{color:#e8740c}' +
  '.by{color:#6b6b70;font-size:11px;margin-top:3px;letter-spacing:.5px}.sec{font-size:12px;font-weight:bold;color:#e8740c;text-transform:uppercase;letter-spacing:1.5px;margin:2px 0 4px}' +
  '.when{text-align:right;font-size:13px;line-height:1.5}.when b{font-size:15px}' +
  '.info{width:100%;border-collapse:collapse;margin:6px 0 14px;font-size:12.5px}.info td{padding:3px 8px 3px 0;vertical-align:top}' +
  '.info .k{color:#6b6b70;width:92px;text-transform:uppercase;font-size:10.5px;letter-spacing:1px;padding-top:5px}' +
  '.goal{background:#f5f5f6;border-left:3px solid #e8740c;padding:6px 10px}' +
  'table.res{width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed}' +
  'table.res th{font-size:9.5px;text-transform:uppercase;letter-spacing:1px;color:#6b6b70;text-align:left;padding:5px 6px 0;white-space:nowrap}' +
  'table.res tr.hl2 th{font-weight:normal;font-size:8.5px;padding:0 6px 4px;border-bottom:1.5px solid #1d1d1f}' +
  'table.res .n{text-align:right;white-space:nowrap;padding-left:12px}table.res td{padding:5px 6px 1px;vertical-align:top}.bt{white-space:nowrap}' +
  'tbody.res{border-bottom:1px solid #d9d9dc}tbody.res tr{page-break-inside:avoid}tbody.alt{background:#f5f5f6}' +
  'tbody.grp td{padding:12px 6px 4px;font-weight:bold;font-size:12.5px;color:#1d1d1f;border-bottom:1.5px solid #e8740c}.gb{color:#6b6b70;font-weight:normal;margin-left:6px}' +
  'tr.l1 td{font-size:12.5px}tr.l2 td{padding:0 6px 5px;font-size:10.5px;color:#6b6b70;white-space:nowrap}' +
  '.cox{color:#6b6b70}.t{font-weight:bold}.pct{font-weight:bold;color:#e8740c;font-size:13.5px}.sp{text-align:right}' +
  '.lbl{text-transform:uppercase;font-size:9px;letter-spacing:1px;margin-right:4px}' +
  '.foot{width:100%;border-collapse:collapse;margin-top:14px;font-size:10px;color:#6b6b70;border-top:1px solid #d9d9dc}.foot td{padding-top:6px}.foot .r{text-align:right}';

var PDF_DIALOG = '<!doctype html><html><head><base target="_blank"><style>' +
  'body{font-family:Arial,sans-serif;font-size:14px;color:#222;margin:0;padding:2px}label{display:block;margin:10px 0 3px;font-weight:bold}' +
  'label small{font-weight:normal;color:#777}input,select,textarea{width:100%;box-sizing:border-box;padding:7px;font-size:14px;border:1px solid #bbb;border-radius:6px;font-family:inherit}' +
  'textarea{height:70px;resize:vertical}button{background:#ff8a1c;border:0;border-radius:6px;padding:10px 16px;font-weight:bold;font-size:14px;cursor:pointer;margin-top:14px}' +
  'button[disabled]{opacity:.6}.err{color:#c00}.muted{color:#666;font-size:12px}a{color:#c45f00;font-weight:bold}#done p{margin:8px 0}' +
  '</style></head><body><div id="form">' +
  '<label for="day">Tag</label><select id="day"></select>' +
  '<label for="ort">Ort</label><input id="ort" maxlength="80">' +
  '<label for="wind">Wind <small>(optional)</small></label><input id="wind" maxlength="80">' +
  '<label for="temp">Temperatur <small>(optional)</small></label><input id="temp" maxlength="40">' +
  '<label for="goal">Trainingsvorgabe <small>(optional)</small></label><textarea id="goal" maxlength="600"></textarea>' +
  '<button id="go" onclick="go()">PDF erstellen</button><p id="msg" class="err"></p>' +
  '<p class="muted">Enthält alle Fahrten des Tages aus „Ergebnis Mannschaft“: nach Prozent, nach Strecke Nr., nach Abteilung und Strecke Nr. (falls vergeben) und nach Mannschaft. Das PDF wird im selben Drive-Ordner wie dieses Sheet gespeichert.</p></div>' +
  '<div id="done" style="display:none"><p>Fertig: <b id="fname"></b></p><p><a id="open" href="#">PDF öffnen</a></p><p><a id="dl" href="#">Herunterladen</a></p>' +
  '<button onclick="again()">Noch eins erstellen</button></div><p class="muted" style="margin-top:16px">ChronOar · eine App von Lennart Geerdes</p>' +
  '<script>var days=<?!= days ?>;function $(i){return document.getElementById(i)}' +
  'try{var s=JSON.parse(localStorage.getItem("chronoarPdf")||"{}");["ort","wind","temp","goal"].forEach(function(k){if(s[k])$(k).value=s[k]})}catch(e){}' +
  'if(!days.length){$("form").innerHTML="<p>Im Blatt „Ergebnis Mannschaft“ gibt es noch keine Fahrten.</p>"}' +
  'days.forEach(function(d){var o=document.createElement("option");o.value=d.day;o.textContent=d.label;$("day").appendChild(o)});' +
  'function go(){var f={day:$("day").value,ort:$("ort").value.trim(),wind:$("wind").value.trim(),temp:$("temp").value.trim(),goal:$("goal").value.trim()};' +
  'if(!f.ort){$("msg").textContent="Bitte den Ort eintragen.";$("ort").focus();return}' +
  'try{localStorage.setItem("chronoarPdf",JSON.stringify({ort:f.ort,wind:f.wind,temp:f.temp,goal:f.goal}))}catch(e){}' +
  '$("msg").textContent="";$("go").disabled=true;$("go").textContent="Erstelle PDF…";' +
  'google.script.run.withSuccessHandler(function(r){$("form").style.display="none";$("done").style.display="block";$("fname").textContent=r.name;$("open").href=r.url;$("dl").href=r.download})' +
  '.withFailureHandler(function(e){$("msg").textContent=e.message;$("go").disabled=false;$("go").textContent="PDF erstellen"}).makePdf(f)}' +
  'function again(){$("done").style.display="none";$("form").style.display="block";$("go").disabled=false;$("go").textContent="PDF erstellen"}' +
  '</script></body></html>';


/* ------------------------------------------------------------------ Dialog */

var CONNECT_HTML = '<!doctype html><html><head><base target="_top"><style>' +
  'body{font-family:Arial,sans-serif;font-size:14px;color:#222;margin:0;padding:4px 2px}' +
  'input{width:100%;box-sizing:border-box;padding:8px;font-size:13px;border:1px solid #bbb;border-radius:6px}' +
  'button{background:#ff8a1c;border:0;border-radius:6px;padding:9px 14px;font-weight:bold;font-size:14px;cursor:pointer;margin-top:8px}' +
  '#qr{display:flex;justify-content:center;margin:10px 0}#qr img,#qr svg{width:300px;height:300px}' +
  '#code{width:100%;box-sizing:border-box;font-size:11px;height:58px}.err{color:#c00}.warn{color:#a35a00;font-weight:bold}.muted{color:#666;font-size:12px}a{color:#c45f00}' +
  '</style><script><?!= lib ?></script></head><body>' +
  '<div id="step1" style="display:none"><p><b>Web-App-Adresse</b> dieses Sheets einfügen.</p>' +
  '<p class="muted">Zu finden unter Erweiterungen → Apps Script → Bereitstellen → Bereitstellungen verwalten → Web-App-URL kopieren. Sie endet auf <code>/exec</code>.</p>' +
  '<input id="url" value="" placeholder="https://script.google.com/macros/s/…/exec">' +
  '<button id="go" onclick="go()">Prüfen und QR-Code anzeigen</button><p id="msg" class="err"></p></div>' +
  '<div id="step2" style="display:none"><p>In ChronOar auf dem Handy: <b>Sportler → ☁ Sheet → QR-Code scannen</b>.</p>' +
  '<p id="warn" class="warn"></p><div id="qr"></div>' +
  '<p class="muted">Oder den Code kopieren und in der App unter „Code einfügen“ einsetzen:</p>' +
  '<textarea id="code" readonly onclick="this.select()"></textarea>' +
  '<p class="muted">Der Code ist wie ein Passwort: Wer ihn hat, kann in dieses Sheet schreiben. ' +
  '<a href="#" onclick="other();return false">Andere Adresse eingeben</a></p></div>' +
  '<script>var found=<?!= found ?>;' +
  'function $(i){return document.getElementById(i)}' +
  'function go(){$("msg").textContent="";$("go").disabled=true;$("go").textContent="Prüfe…";' +
  'google.script.run.withSuccessHandler(show).withFailureHandler(function(e){$("msg").textContent=e.message;$("go").disabled=false;$("go").textContent="Prüfen und QR-Code anzeigen"}).saveUrl($("url").value)}' +
  'function show(f){var q=qrcode(0,"M");q.addData(f.code);q.make();$("qr").innerHTML=q.createSvgTag({cellSize:6,margin:2,scalable:true});' +
  '$("code").value=f.code;$("warn").textContent=f.warn||"";$("step1").style.display="none";$("step2").style.display="block"}' +
  'function other(){$("step2").style.display="none";$("step1").style.display="block";$("go").disabled=false;$("go").textContent="Prüfen und QR-Code anzeigen"}' +
  'if(found)show(found);else other();' +
  '</script></body></html>';

/* qrcode-generator 1.4.4 (MIT, Kazuhiko Arase) – erzeugt den QR-Code im Dialog. */
var QR_LIB = "var qrcode=function(){var t=function(t,r){var e=t,n=g[r],o=null,i=0,a=null,u=[],f={},c=function(t,r){o=function(t){for(var r=new Array(t),e=0;e<t;e+=1){r[e]=new Array(t);for(var n=0;n<t;n+=1)r[e][n]=null}return r}(i=4*e+17),l(0,0),l(i-7,0),l(0,i-7),s(),h(),d(t,r),e>=7&&v(t),null==a&&(a=p(e,n,u)),w(a,r)},l=function(t,r){for(var e=-1;e<=7;e+=1)if(!(t+e<=-1||i<=t+e))for(var n=-1;n<=7;n+=1)r+n<=-1||i<=r+n||(o[t+e][r+n]=0<=e&&e<=6&&(0==n||6==n)||0<=n&&n<=6&&(0==e||6==e)||2<=e&&e<=4&&2<=n&&n<=4)},h=function(){for(var t=8;t<i-8;t+=1)null==o[t][6]&&(o[t][6]=t%2==0);for(var r=8;r<i-8;r+=1)null==o[6][r]&&(o[6][r]=r%2==0)},s=function(){for(var t=B.getPatternPosition(e),r=0;r<t.length;r+=1)for(var n=0;n<t.length;n+=1){var i=t[r],a=t[n];if(null==o[i][a])for(var u=-2;u<=2;u+=1)for(var f=-2;f<=2;f+=1)o[i+u][a+f]=-2==u||2==u||-2==f||2==f||0==u&&0==f}},v=function(t){for(var r=B.getBCHTypeNumber(e),n=0;n<18;n+=1){var a=!t&&1==(r>>n&1);o[Math.floor(n/3)][n%3+i-8-3]=a}for(n=0;n<18;n+=1){a=!t&&1==(r>>n&1);o[n%3+i-8-3][Math.floor(n/3)]=a}},d=function(t,r){for(var e=n<<3|r,a=B.getBCHTypeInfo(e),u=0;u<15;u+=1){var f=!t&&1==(a>>u&1);u<6?o[u][8]=f:u<8?o[u+1][8]=f:o[i-15+u][8]=f}for(u=0;u<15;u+=1){f=!t&&1==(a>>u&1);u<8?o[8][i-u-1]=f:u<9?o[8][15-u-1+1]=f:o[8][15-u-1]=f}o[i-8][8]=!t},w=function(t,r){for(var e=-1,n=i-1,a=7,u=0,f=B.getMaskFunction(r),c=i-1;c>0;c-=2)for(6==c&&(c-=1);;){for(var g=0;g<2;g+=1)if(null==o[n][c-g]){var l=!1;u<t.length&&(l=1==(t[u]>>>a&1)),f(n,c-g)&&(l=!l),o[n][c-g]=l,-1==(a-=1)&&(u+=1,a=7)}if((n+=e)<0||i<=n){n-=e,e=-e;break}}},p=function(t,r,e){for(var n=A.getRSBlocks(t,r),o=b(),i=0;i<e.length;i+=1){var a=e[i];o.put(a.getMode(),4),o.put(a.getLength(),B.getLengthInBits(a.getMode(),t)),a.write(o)}var u=0;for(i=0;i<n.length;i+=1)u+=n[i].dataCount;if(o.getLengthInBits()>8*u)throw\"code length overflow. (\"+o.getLengthInBits()+\">\"+8*u+\")\";for(o.getLengthInBits()+4<=8*u&&o.put(0,4);o.getLengthInBits()%8!=0;)o.putBit(!1);for(;!(o.getLengthInBits()>=8*u||(o.put(236,8),o.getLengthInBits()>=8*u));)o.put(17,8);return function(t,r){for(var e=0,n=0,o=0,i=new Array(r.length),a=new Array(r.length),u=0;u<r.length;u+=1){var f=r[u].dataCount,c=r[u].totalCount-f;n=Math.max(n,f),o=Math.max(o,c),i[u]=new Array(f);for(var g=0;g<i[u].length;g+=1)i[u][g]=255&t.getBuffer()[g+e];e+=f;var l=B.getErrorCorrectPolynomial(c),h=k(i[u],l.getLength()-1).mod(l);for(a[u]=new Array(l.getLength()-1),g=0;g<a[u].length;g+=1){var s=g+h.getLength()-a[u].length;a[u][g]=s>=0?h.getAt(s):0}}var v=0;for(g=0;g<r.length;g+=1)v+=r[g].totalCount;var d=new Array(v),w=0;for(g=0;g<n;g+=1)for(u=0;u<r.length;u+=1)g<i[u].length&&(d[w]=i[u][g],w+=1);for(g=0;g<o;g+=1)for(u=0;u<r.length;u+=1)g<a[u].length&&(d[w]=a[u][g],w+=1);return d}(o,n)};f.addData=function(t,r){var e=null;switch(r=r||\"Byte\"){case\"Numeric\":e=M(t);break;case\"Alphanumeric\":e=x(t);break;case\"Byte\":e=m(t);break;case\"Kanji\":e=L(t);break;default:throw\"mode:\"+r}u.push(e),a=null},f.isDark=function(t,r){if(t<0||i<=t||r<0||i<=r)throw t+\",\"+r;return o[t][r]},f.getModuleCount=function(){return i},f.make=function(){if(e<1){for(var t=1;t<40;t++){for(var r=A.getRSBlocks(t,n),o=b(),i=0;i<u.length;i++){var a=u[i];o.put(a.getMode(),4),o.put(a.getLength(),B.getLengthInBits(a.getMode(),t)),a.write(o)}var g=0;for(i=0;i<r.length;i++)g+=r[i].dataCount;if(o.getLengthInBits()<=8*g)break}e=t}c(!1,function(){for(var t=0,r=0,e=0;e<8;e+=1){c(!0,e);var n=B.getLostPoint(f);(0==e||t>n)&&(t=n,r=e)}return r}())},f.createTableTag=function(t,r){t=t||2;var e=\"\";e+='<table style=\"',e+=\" border-width: 0px; border-style: none;\",e+=\" border-collapse: collapse;\",e+=\" padding: 0px; margin: \"+(r=void 0===r?4*t:r)+\"px;\",e+='\">',e+=\"<tbody>\";for(var n=0;n<f.getModuleCount();n+=1){e+=\"<tr>\";for(var o=0;o<f.getModuleCount();o+=1)e+='<td style=\"',e+=\" border-width: 0px; border-style: none;\",e+=\" border-collapse: collapse;\",e+=\" padding: 0px; margin: 0px;\",e+=\" width: \"+t+\"px;\",e+=\" height: \"+t+\"px;\",e+=\" background-color: \",e+=f.isDark(n,o)?\"#000000\":\"#ffffff\",e+=\";\",e+='\"/>';e+=\"</tr>\"}return e+=\"</tbody>\",e+=\"</table>\"},f.createSvgTag=function(t,r,e,n){var o={};\"object\"==typeof arguments[0]&&(t=(o=arguments[0]).cellSize,r=o.margin,e=o.alt,n=o.title),t=t||2,r=void 0===r?4*t:r,(e=\"string\"==typeof e?{text:e}:e||{}).text=e.text||null,e.id=e.text?e.id||\"qrcode-description\":null,(n=\"string\"==typeof n?{text:n}:n||{}).text=n.text||null,n.id=n.text?n.id||\"qrcode-title\":null;var i,a,u,c,g=f.getModuleCount()*t+2*r,l=\"\";for(c=\"l\"+t+\",0 0,\"+t+\" -\"+t+\",0 0,-\"+t+\"z \",l+='<svg version=\"1.1\" xmlns=\"http://www.w3.org/2000/svg\"',l+=o.scalable?\"\":' width=\"'+g+'px\" height=\"'+g+'px\"',l+=' viewBox=\"0 0 '+g+\" \"+g+'\" ',l+=' preserveAspectRatio=\"xMinYMin meet\"',l+=n.text||e.text?' role=\"img\" aria-labelledby=\"'+y([n.id,e.id].join(\" \").trim())+'\"':\"\",l+=\">\",l+=n.text?'<title id=\"'+y(n.id)+'\">'+y(n.text)+\"</title>\":\"\",l+=e.text?'<description id=\"'+y(e.id)+'\">'+y(e.text)+\"</description>\":\"\",l+='<rect width=\"100%\" height=\"100%\" fill=\"white\" cx=\"0\" cy=\"0\"/>',l+='<path d=\"',a=0;a<f.getModuleCount();a+=1)for(u=a*t+r,i=0;i<f.getModuleCount();i+=1)f.isDark(a,i)&&(l+=\"M\"+(i*t+r)+\",\"+u+c);return l+='\" stroke=\"transparent\" fill=\"black\"/>',l+=\"</svg>\"},f.createDataURL=function(t,r){t=t||2,r=void 0===r?4*t:r;var e=f.getModuleCount()*t+2*r,n=r,o=e-r;return I(e,e,function(r,e){if(n<=r&&r<o&&n<=e&&e<o){var i=Math.floor((r-n)/t),a=Math.floor((e-n)/t);return f.isDark(a,i)?0:1}return 1})},f.createImgTag=function(t,r,e){t=t||2,r=void 0===r?4*t:r;var n=f.getModuleCount()*t+2*r,o=\"\";return o+=\"<img\",o+=' src=\"',o+=f.createDataURL(t,r),o+='\"',o+=' width=\"',o+=n,o+='\"',o+=' height=\"',o+=n,o+='\"',e&&(o+=' alt=\"',o+=y(e),o+='\"'),o+=\"/>\"};var y=function(t){for(var r=\"\",e=0;e<t.length;e+=1){var n=t.charAt(e);switch(n){case\"<\":r+=\"&lt;\";break;case\">\":r+=\"&gt;\";break;case\"&\":r+=\"&amp;\";break;case'\"':r+=\"&quot;\";break;default:r+=n}}return r};return f.createASCII=function(t,r){if((t=t||1)<2)return function(t){t=void 0===t?2:t;var r,e,n,o,i,a=1*f.getModuleCount()+2*t,u=t,c=a-t,g={\"\u2588\u2588\":\"\u2588\",\"\u2588 \":\"\u2580\",\" \u2588\":\"\u2584\",\"  \":\" \"},l={\"\u2588\u2588\":\"\u2580\",\"\u2588 \":\"\u2580\",\" \u2588\":\" \",\"  \":\" \"},h=\"\";for(r=0;r<a;r+=2){for(n=Math.floor((r-u)/1),o=Math.floor((r+1-u)/1),e=0;e<a;e+=1)i=\"\u2588\",u<=e&&e<c&&u<=r&&r<c&&f.isDark(n,Math.floor((e-u)/1))&&(i=\" \"),u<=e&&e<c&&u<=r+1&&r+1<c&&f.isDark(o,Math.floor((e-u)/1))?i+=\" \":i+=\"\u2588\",h+=t<1&&r+1>=c?l[i]:g[i];h+=\"\\n\"}return a%2&&t>0?h.substring(0,h.length-a-1)+Array(a+1).join(\"\u2580\"):h.substring(0,h.length-1)}(r);t-=1,r=void 0===r?2*t:r;var e,n,o,i,a=f.getModuleCount()*t+2*r,u=r,c=a-r,g=Array(t+1).join(\"\u2588\u2588\"),l=Array(t+1).join(\"  \"),h=\"\",s=\"\";for(e=0;e<a;e+=1){for(o=Math.floor((e-u)/t),s=\"\",n=0;n<a;n+=1)i=1,u<=n&&n<c&&u<=e&&e<c&&f.isDark(o,Math.floor((n-u)/t))&&(i=0),s+=i?g:l;for(o=0;o<t;o+=1)h+=s+\"\\n\"}return h.substring(0,h.length-1)},f.renderTo2dContext=function(t,r){r=r||2;for(var e=f.getModuleCount(),n=0;n<e;n++)for(var o=0;o<e;o++)t.fillStyle=f.isDark(n,o)?\"black\":\"white\",t.fillRect(n*r,o*r,r,r)},f};t.stringToBytes=(t.stringToBytesFuncs={default:function(t){for(var r=[],e=0;e<t.length;e+=1){var n=t.charCodeAt(e);r.push(255&n)}return r}}).default,t.createStringToBytes=function(t,r){var e=function(){for(var e=S(t),n=function(){var t=e.read();if(-1==t)throw\"eof\";return t},o=0,i={};;){var a=e.read();if(-1==a)break;var u=n(),f=n()<<8|n();i[String.fromCharCode(a<<8|u)]=f,o+=1}if(o!=r)throw o+\" != \"+r;return i}(),n=\"?\".charCodeAt(0);return function(t){for(var r=[],o=0;o<t.length;o+=1){var i=t.charCodeAt(o);if(i<128)r.push(i);else{var a=e[t.charAt(o)];\"number\"==typeof a?(255&a)==a?r.push(a):(r.push(a>>>8),r.push(255&a)):r.push(n)}}return r}};var r,e,n,o,i,a=1,u=2,f=4,c=8,g={L:1,M:0,Q:3,H:2},l=0,h=1,s=2,v=3,d=4,w=5,p=6,y=7,B=(r=[[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],[6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],[6,26,50,74],[6,30,54,78],[6,30,56,82],[6,30,58,86],[6,34,62,90],[6,28,50,72,94],[6,26,50,74,98],[6,30,54,78,102],[6,28,54,80,106],[6,32,58,84,110],[6,30,58,86,114],[6,34,62,90,118],[6,26,50,74,98,122],[6,30,54,78,102,126],[6,26,52,78,104,130],[6,30,56,82,108,134],[6,34,60,86,112,138],[6,30,58,86,114,142],[6,34,62,90,118,146],[6,30,54,78,102,126,150],[6,24,50,76,102,128,154],[6,28,54,80,106,132,158],[6,32,58,84,110,136,162],[6,26,54,82,110,138,166],[6,30,58,86,114,142,170]],e=1335,n=7973,i=function(t){for(var r=0;0!=t;)r+=1,t>>>=1;return r},(o={}).getBCHTypeInfo=function(t){for(var r=t<<10;i(r)-i(e)>=0;)r^=e<<i(r)-i(e);return 21522^(t<<10|r)},o.getBCHTypeNumber=function(t){for(var r=t<<12;i(r)-i(n)>=0;)r^=n<<i(r)-i(n);return t<<12|r},o.getPatternPosition=function(t){return r[t-1]},o.getMaskFunction=function(t){switch(t){case l:return function(t,r){return(t+r)%2==0};case h:return function(t,r){return t%2==0};case s:return function(t,r){return r%3==0};case v:return function(t,r){return(t+r)%3==0};case d:return function(t,r){return(Math.floor(t/2)+Math.floor(r/3))%2==0};case w:return function(t,r){return t*r%2+t*r%3==0};case p:return function(t,r){return(t*r%2+t*r%3)%2==0};case y:return function(t,r){return(t*r%3+(t+r)%2)%2==0};default:throw\"bad maskPattern:\"+t}},o.getErrorCorrectPolynomial=function(t){for(var r=k([1],0),e=0;e<t;e+=1)r=r.multiply(k([1,C.gexp(e)],0));return r},o.getLengthInBits=function(t,r){if(1<=r&&r<10)switch(t){case a:return 10;case u:return 9;case f:case c:return 8;default:throw\"mode:\"+t}else if(r<27)switch(t){case a:return 12;case u:return 11;case f:return 16;case c:return 10;default:throw\"mode:\"+t}else{if(!(r<41))throw\"type:\"+r;switch(t){case a:return 14;case u:return 13;case f:return 16;case c:return 12;default:throw\"mode:\"+t}}},o.getLostPoint=function(t){for(var r=t.getModuleCount(),e=0,n=0;n<r;n+=1)for(var o=0;o<r;o+=1){for(var i=0,a=t.isDark(n,o),u=-1;u<=1;u+=1)if(!(n+u<0||r<=n+u))for(var f=-1;f<=1;f+=1)o+f<0||r<=o+f||0==u&&0==f||a==t.isDark(n+u,o+f)&&(i+=1);i>5&&(e+=3+i-5)}for(n=0;n<r-1;n+=1)for(o=0;o<r-1;o+=1){var c=0;t.isDark(n,o)&&(c+=1),t.isDark(n+1,o)&&(c+=1),t.isDark(n,o+1)&&(c+=1),t.isDark(n+1,o+1)&&(c+=1),0!=c&&4!=c||(e+=3)}for(n=0;n<r;n+=1)for(o=0;o<r-6;o+=1)t.isDark(n,o)&&!t.isDark(n,o+1)&&t.isDark(n,o+2)&&t.isDark(n,o+3)&&t.isDark(n,o+4)&&!t.isDark(n,o+5)&&t.isDark(n,o+6)&&(e+=40);for(o=0;o<r;o+=1)for(n=0;n<r-6;n+=1)t.isDark(n,o)&&!t.isDark(n+1,o)&&t.isDark(n+2,o)&&t.isDark(n+3,o)&&t.isDark(n+4,o)&&!t.isDark(n+5,o)&&t.isDark(n+6,o)&&(e+=40);var g=0;for(o=0;o<r;o+=1)for(n=0;n<r;n+=1)t.isDark(n,o)&&(g+=1);return e+=Math.abs(100*g/r/r-50)/5*10},o),C=function(){for(var t=new Array(256),r=new Array(256),e=0;e<8;e+=1)t[e]=1<<e;for(e=8;e<256;e+=1)t[e]=t[e-4]^t[e-5]^t[e-6]^t[e-8];for(e=0;e<255;e+=1)r[t[e]]=e;var n={glog:function(t){if(t<1)throw\"glog(\"+t+\")\";return r[t]},gexp:function(r){for(;r<0;)r+=255;for(;r>=256;)r-=255;return t[r]}};return n}();function k(t,r){if(void 0===t.length)throw t.length+\"/\"+r;var e=function(){for(var e=0;e<t.length&&0==t[e];)e+=1;for(var n=new Array(t.length-e+r),o=0;o<t.length-e;o+=1)n[o]=t[o+e];return n}(),n={getAt:function(t){return e[t]},getLength:function(){return e.length},multiply:function(t){for(var r=new Array(n.getLength()+t.getLength()-1),e=0;e<n.getLength();e+=1)for(var o=0;o<t.getLength();o+=1)r[e+o]^=C.gexp(C.glog(n.getAt(e))+C.glog(t.getAt(o)));return k(r,0)},mod:function(t){if(n.getLength()-t.getLength()<0)return n;for(var r=C.glog(n.getAt(0))-C.glog(t.getAt(0)),e=new Array(n.getLength()),o=0;o<n.getLength();o+=1)e[o]=n.getAt(o);for(o=0;o<t.getLength();o+=1)e[o]^=C.gexp(C.glog(t.getAt(o))+r);return k(e,0).mod(t)}};return n}var A=function(){var t=[[1,26,19],[1,26,16],[1,26,13],[1,26,9],[1,44,34],[1,44,28],[1,44,22],[1,44,16],[1,70,55],[1,70,44],[2,35,17],[2,35,13],[1,100,80],[2,50,32],[2,50,24],[4,25,9],[1,134,108],[2,67,43],[2,33,15,2,34,16],[2,33,11,2,34,12],[2,86,68],[4,43,27],[4,43,19],[4,43,15],[2,98,78],[4,49,31],[2,32,14,4,33,15],[4,39,13,1,40,14],[2,121,97],[2,60,38,2,61,39],[4,40,18,2,41,19],[4,40,14,2,41,15],[2,146,116],[3,58,36,2,59,37],[4,36,16,4,37,17],[4,36,12,4,37,13],[2,86,68,2,87,69],[4,69,43,1,70,44],[6,43,19,2,44,20],[6,43,15,2,44,16],[4,101,81],[1,80,50,4,81,51],[4,50,22,4,51,23],[3,36,12,8,37,13],[2,116,92,2,117,93],[6,58,36,2,59,37],[4,46,20,6,47,21],[7,42,14,4,43,15],[4,133,107],[8,59,37,1,60,38],[8,44,20,4,45,21],[12,33,11,4,34,12],[3,145,115,1,146,116],[4,64,40,5,65,41],[11,36,16,5,37,17],[11,36,12,5,37,13],[5,109,87,1,110,88],[5,65,41,5,66,42],[5,54,24,7,55,25],[11,36,12,7,37,13],[5,122,98,1,123,99],[7,73,45,3,74,46],[15,43,19,2,44,20],[3,45,15,13,46,16],[1,135,107,5,136,108],[10,74,46,1,75,47],[1,50,22,15,51,23],[2,42,14,17,43,15],[5,150,120,1,151,121],[9,69,43,4,70,44],[17,50,22,1,51,23],[2,42,14,19,43,15],[3,141,113,4,142,114],[3,70,44,11,71,45],[17,47,21,4,48,22],[9,39,13,16,40,14],[3,135,107,5,136,108],[3,67,41,13,68,42],[15,54,24,5,55,25],[15,43,15,10,44,16],[4,144,116,4,145,117],[17,68,42],[17,50,22,6,51,23],[19,46,16,6,47,17],[2,139,111,7,140,112],[17,74,46],[7,54,24,16,55,25],[34,37,13],[4,151,121,5,152,122],[4,75,47,14,76,48],[11,54,24,14,55,25],[16,45,15,14,46,16],[6,147,117,4,148,118],[6,73,45,14,74,46],[11,54,24,16,55,25],[30,46,16,2,47,17],[8,132,106,4,133,107],[8,75,47,13,76,48],[7,54,24,22,55,25],[22,45,15,13,46,16],[10,142,114,2,143,115],[19,74,46,4,75,47],[28,50,22,6,51,23],[33,46,16,4,47,17],[8,152,122,4,153,123],[22,73,45,3,74,46],[8,53,23,26,54,24],[12,45,15,28,46,16],[3,147,117,10,148,118],[3,73,45,23,74,46],[4,54,24,31,55,25],[11,45,15,31,46,16],[7,146,116,7,147,117],[21,73,45,7,74,46],[1,53,23,37,54,24],[19,45,15,26,46,16],[5,145,115,10,146,116],[19,75,47,10,76,48],[15,54,24,25,55,25],[23,45,15,25,46,16],[13,145,115,3,146,116],[2,74,46,29,75,47],[42,54,24,1,55,25],[23,45,15,28,46,16],[17,145,115],[10,74,46,23,75,47],[10,54,24,35,55,25],[19,45,15,35,46,16],[17,145,115,1,146,116],[14,74,46,21,75,47],[29,54,24,19,55,25],[11,45,15,46,46,16],[13,145,115,6,146,116],[14,74,46,23,75,47],[44,54,24,7,55,25],[59,46,16,1,47,17],[12,151,121,7,152,122],[12,75,47,26,76,48],[39,54,24,14,55,25],[22,45,15,41,46,16],[6,151,121,14,152,122],[6,75,47,34,76,48],[46,54,24,10,55,25],[2,45,15,64,46,16],[17,152,122,4,153,123],[29,74,46,14,75,47],[49,54,24,10,55,25],[24,45,15,46,46,16],[4,152,122,18,153,123],[13,74,46,32,75,47],[48,54,24,14,55,25],[42,45,15,32,46,16],[20,147,117,4,148,118],[40,75,47,7,76,48],[43,54,24,22,55,25],[10,45,15,67,46,16],[19,148,118,6,149,119],[18,75,47,31,76,48],[34,54,24,34,55,25],[20,45,15,61,46,16]],r=function(t,r){var e={};return e.totalCount=t,e.dataCount=r,e},e={};return e.getRSBlocks=function(e,n){var o=function(r,e){switch(e){case g.L:return t[4*(r-1)+0];case g.M:return t[4*(r-1)+1];case g.Q:return t[4*(r-1)+2];case g.H:return t[4*(r-1)+3];default:return}}(e,n);if(void 0===o)throw\"bad rs block @ typeNumber:\"+e+\"/errorCorrectionLevel:\"+n;for(var i=o.length/3,a=[],u=0;u<i;u+=1)for(var f=o[3*u+0],c=o[3*u+1],l=o[3*u+2],h=0;h<f;h+=1)a.push(r(c,l));return a},e}(),b=function(){var t=[],r=0,e={getBuffer:function(){return t},getAt:function(r){var e=Math.floor(r/8);return 1==(t[e]>>>7-r%8&1)},put:function(t,r){for(var n=0;n<r;n+=1)e.putBit(1==(t>>>r-n-1&1))},getLengthInBits:function(){return r},putBit:function(e){var n=Math.floor(r/8);t.length<=n&&t.push(0),e&&(t[n]|=128>>>r%8),r+=1}};return e},M=function(t){var r=a,e=t,n={getMode:function(){return r},getLength:function(t){return e.length},write:function(t){for(var r=e,n=0;n+2<r.length;)t.put(o(r.substring(n,n+3)),10),n+=3;n<r.length&&(r.length-n==1?t.put(o(r.substring(n,n+1)),4):r.length-n==2&&t.put(o(r.substring(n,n+2)),7))}},o=function(t){for(var r=0,e=0;e<t.length;e+=1)r=10*r+i(t.charAt(e));return r},i=function(t){if(\"0\"<=t&&t<=\"9\")return t.charCodeAt(0)-\"0\".charCodeAt(0);throw\"illegal char :\"+t};return n},x=function(t){var r=u,e=t,n={getMode:function(){return r},getLength:function(t){return e.length},write:function(t){for(var r=e,n=0;n+1<r.length;)t.put(45*o(r.charAt(n))+o(r.charAt(n+1)),11),n+=2;n<r.length&&t.put(o(r.charAt(n)),6)}},o=function(t){if(\"0\"<=t&&t<=\"9\")return t.charCodeAt(0)-\"0\".charCodeAt(0);if(\"A\"<=t&&t<=\"Z\")return t.charCodeAt(0)-\"A\".charCodeAt(0)+10;switch(t){case\" \":return 36;case\"$\":return 37;case\"%\":return 38;case\"*\":return 39;case\"+\":return 40;case\"-\":return 41;case\".\":return 42;case\"/\":return 43;case\":\":return 44;default:throw\"illegal char :\"+t}};return n},m=function(r){var e=f,n=t.stringToBytes(r),o={getMode:function(){return e},getLength:function(t){return n.length},write:function(t){for(var r=0;r<n.length;r+=1)t.put(n[r],8)}};return o},L=function(r){var e=c,n=t.stringToBytesFuncs.SJIS;if(!n)throw\"sjis not supported.\";!function(){var t=n(\"\u53cb\");if(2!=t.length||38726!=(t[0]<<8|t[1]))throw\"sjis not supported.\"}();var o=n(r),i={getMode:function(){return e},getLength:function(t){return~~(o.length/2)},write:function(t){for(var r=o,e=0;e+1<r.length;){var n=(255&r[e])<<8|255&r[e+1];if(33088<=n&&n<=40956)n-=33088;else{if(!(57408<=n&&n<=60351))throw\"illegal char at \"+(e+1)+\"/\"+n;n-=49472}n=192*(n>>>8&255)+(255&n),t.put(n,13),e+=2}if(e<r.length)throw\"illegal char at \"+(e+1)}};return i},D=function(){var t=[],r={writeByte:function(r){t.push(255&r)},writeShort:function(t){r.writeByte(t),r.writeByte(t>>>8)},writeBytes:function(t,e,n){e=e||0,n=n||t.length;for(var o=0;o<n;o+=1)r.writeByte(t[o+e])},writeString:function(t){for(var e=0;e<t.length;e+=1)r.writeByte(t.charCodeAt(e))},toByteArray:function(){return t},toString:function(){var r=\"\";r+=\"[\";for(var e=0;e<t.length;e+=1)e>0&&(r+=\",\"),r+=t[e];return r+=\"]\"}};return r},S=function(t){var r=t,e=0,n=0,o=0,i={read:function(){for(;o<8;){if(e>=r.length){if(0==o)return-1;throw\"unexpected end of file./\"+o}var t=r.charAt(e);if(e+=1,\"=\"==t)return o=0,-1;t.match(/^\\s$/)||(n=n<<6|a(t.charCodeAt(0)),o+=6)}var i=n>>>o-8&255;return o-=8,i}},a=function(t){if(65<=t&&t<=90)return t-65;if(97<=t&&t<=122)return t-97+26;if(48<=t&&t<=57)return t-48+52;if(43==t)return 62;if(47==t)return 63;throw\"c:\"+t};return i},I=function(t,r,e){for(var n=function(t,r){var e=t,n=r,o=new Array(t*r),i={setPixel:function(t,r,n){o[r*e+t]=n},write:function(t){t.writeString(\"GIF87a\"),t.writeShort(e),t.writeShort(n),t.writeByte(128),t.writeByte(0),t.writeByte(0),t.writeByte(0),t.writeByte(0),t.writeByte(0),t.writeByte(255),t.writeByte(255),t.writeByte(255),t.writeString(\",\"),t.writeShort(0),t.writeShort(0),t.writeShort(e),t.writeShort(n),t.writeByte(0);var r=a(2);t.writeByte(2);for(var o=0;r.length-o>255;)t.writeByte(255),t.writeBytes(r,o,255),o+=255;t.writeByte(r.length-o),t.writeBytes(r,o,r.length-o),t.writeByte(0),t.writeString(\";\")}},a=function(t){for(var r=1<<t,e=1+(1<<t),n=t+1,i=u(),a=0;a<r;a+=1)i.add(String.fromCharCode(a));i.add(String.fromCharCode(r)),i.add(String.fromCharCode(e));var f,c,g,l=D(),h=(f=l,c=0,g=0,{write:function(t,r){if(t>>>r!=0)throw\"length over\";for(;c+r>=8;)f.writeByte(255&(t<<c|g)),r-=8-c,t>>>=8-c,g=0,c=0;g|=t<<c,c+=r},flush:function(){c>0&&f.writeByte(g)}});h.write(r,n);var s=0,v=String.fromCharCode(o[s]);for(s+=1;s<o.length;){var d=String.fromCharCode(o[s]);s+=1,i.contains(v+d)?v+=d:(h.write(i.indexOf(v),n),i.size()<4095&&(i.size()==1<<n&&(n+=1),i.add(v+d)),v=d)}return h.write(i.indexOf(v),n),h.write(e,n),h.flush(),l.toByteArray()},u=function(){var t={},r=0,e={add:function(n){if(e.contains(n))throw\"dup key:\"+n;t[n]=r,r+=1},size:function(){return r},indexOf:function(r){return t[r]},contains:function(r){return void 0!==t[r]}};return e};return i}(t,r),o=0;o<r;o+=1)for(var i=0;i<t;i+=1)n.setPixel(i,o,e(i,o));var a=D();n.write(a);for(var u=function(){var t=0,r=0,e=0,n=\"\",o={},i=function(t){n+=String.fromCharCode(a(63&t))},a=function(t){if(t<0);else{if(t<26)return 65+t;if(t<52)return t-26+97;if(t<62)return t-52+48;if(62==t)return 43;if(63==t)return 47}throw\"n:\"+t};return o.writeByte=function(n){for(t=t<<8|255&n,r+=8,e+=1;r>=6;)i(t>>>r-6),r-=6},o.flush=function(){if(r>0&&(i(t<<6-r),t=0,r=0),e%3!=0)for(var o=3-e%3,a=0;a<o;a+=1)n+=\"=\"},o.toString=function(){return n},o}(),f=a.toByteArray(),c=0;c<f.length;c+=1)u.writeByte(f[c]);return u.flush(),\"data:image/gif;base64,\"+u};return t}();qrcode.stringToBytesFuncs[\"UTF-8\"]=function(t){return function(t){for(var r=[],e=0;e<t.length;e++){var n=t.charCodeAt(e);n<128?r.push(n):n<2048?r.push(192|n>>6,128|63&n):n<55296||n>=57344?r.push(224|n>>12,128|n>>6&63,128|63&n):(e++,n=65536+((1023&n)<<10|1023&t.charCodeAt(e)),r.push(240|n>>18,128|n>>12&63,128|n>>6&63,128|63&n))}return r}(t)},function(t){\"function\"==typeof define&&define.amd?define([],t):\"object\"==typeof exports&&(module.exports=t())}(function(){return qrcode});";
