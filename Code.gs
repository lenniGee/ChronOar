/**
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
 *
 * Sicherheit: Jeder Aufruf braucht den Schlüssel. Er wird pro Sheet
 * zufällig erzeugt und steckt im Verbindungscode / QR-Code. Eine Kopie des
 * Sheets bekommt automatisch einen neuen Schlüssel.
 *
 * Nach JEDER Änderung an diesem Code: "Bereitstellen → Bereitstellungen verwalten
 * → Bearbeiten (Stift) → Version: Neue Version → Bereitstellen". Sonst läuft
 * unter der Web-App-Adresse weiter die alte Version. Die Adresse bleibt gleich.
 */

var SCRIPT_VERSION = 7;
var CODE_PREFIX = 'CHRONOAR1:';
var SH_ATH = 'Sportler', SH_RES = 'Ergebnis Sportler', SH_TEAM = 'Ergebnis Mannschaft';
var OLD_NAMES = { 'Ergebnis Sportler': 'Ergebnisse', 'Ergebnis Mannschaft': 'Mannschaften' };
var TEAM_HEAD = ['Belastung', 'Datum', 'Uhrzeit', 'Strecke (m)', 'Mannschaft', 'Steuerperson', 'Kategorien', 'Boot',
  'Zeit', 'Zeit (s)', '/500 m', 'm/s', 'Ø SF', 'Splits', 'Relation (m/s)', 'Zielzeit', 'Zielzeit (s)', 'Prozent'];
/* Spaltennummern (1-basiert) in „Ergebnis Mannschaft“, die das Skript direkt anspricht */
var TEAM_COL = { dist: 4, rel: 15, target: 16, pct: 18 };
var ATH_HEAD = ['ID', 'Vorname', 'Nachname', 'Geschlecht', 'Altersklasse', 'Gewichtsklasse'];
var RES_HEAD = ['ID', 'Belastung', 'Datum', 'Uhrzeit', 'Vorname', 'Nachname', 'Kategorie', 'Rolle', 'Boot',
  'Strecke (m)', 'Zeit', 'Zeit (s)', 'm/s', '/500 m', 'Relation (m/s)', 'Prozent', 'Ø SF', 'Splits',
  'Mannschaft', 'Sportler-ID', 'Zielzeit', 'Zielzeit (s)'];
var AGE_TXT = { JB: 'Junior B', JA: 'Junior A', SB: 'Senior B', SA: 'Senior A' };


/* ------------------------------------------------------------------ Menü */

function onOpen() {
  // Sicherheitsnetz: läuft immer mit dem zuletzt gespeicherten Code, unabhängig von der Bereitstellung.
  try { renameOld_(); if (SpreadsheetApp.getActive().getSheetByName(SH_RES)) { fixHeaders_(); fixPercent_(); fixTargets_(); syncTeams_(); } } catch (e) { }
  SpreadsheetApp.getUi().createMenu('ChronOar')
    .addItem('1. Einrichten', 'setup')
    .addItem('2. Mit Handy verbinden (QR-Code)', 'showConnect')
    .addItem('Ergebnis Mannschaft neu aufbauen', 'rebuildTeams')
    .addSeparator()
    .addItem('Neuen Schlüssel erzeugen (alte Handys trennen)', 'resetKey')
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

  // Auswahllisten für die Sportler-Spalten D–F
  var dv = function (list) { return SpreadsheetApp.newDataValidation().requireValueInList(list, true).setAllowInvalid(false).build(); };
  ath.getRange('D2:D').setDataValidation(dv(['m', 'w']));
  ath.getRange('E2:E').setDataValidation(dv(['Junior B', 'Junior A', 'Senior B', 'Senior A']));
  ath.getRange('F2:F').setDataValidation(dv(['Offen', 'Leicht']));
  ath.setColumnWidth(1, 90);
  ath.getRange('A:A').setFontColor('#999999');
  ath.getRange('A1').setNote('Wird automatisch vergeben. Neue Sportler einfach ab Spalte B eintragen und ID leer lassen.');

  res.getRange('C:C').setNumberFormat('dd.MM.yyyy');
  res.getRange('D:D').setNumberFormat('HH:mm');
  res.getRange('K:K').setNumberFormat('@');
  res.getRange('N:N').setNumberFormat('@');
  res.getRange('L:L').setNumberFormat('0.00');
  res.getRange('M:M').setNumberFormat('0.000000');
  res.getRange('O:O').setNumberFormat('0.000000');
  res.getRange('P:P').setNumberFormat('0.0000');
  res.getRange('Q:Q').setNumberFormat('0.0');
  res.getRange('A:B').setFontColor('#999999');
  res.getRange('U:U').setNumberFormat('@');
  res.getRange('V:V').setNumberFormat('0.0');

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

/** Dialog: Web-App-Adresse eintragen, Verbindungscode + QR-Code anzeigen. */
function showConnect() {
  getKey_();
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('WEBAPP_URL') || '';
  if (!url) { try { url = ScriptApp.getService().getUrl() || ''; } catch (e) { url = ''; } }
  if (url && !/\/exec$/.test(url)) url = '';
  var t = HtmlService.createTemplate(CONNECT_HTML);
  t.url = url;
  t.lib = QR_LIB;
  SpreadsheetApp.getUi().showModalDialog(t.evaluate().setWidth(420).setHeight(560), 'ChronOar mit Handy verbinden');
}

/** Wird vom Dialog aufgerufen: speichert die Adresse und liefert den Verbindungscode. */
function saveUrl(url) {
  url = String(url || '').trim();
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) throw new Error('Das ist keine Web-App-Adresse. Sie beginnt mit https://script.google.com/ und endet mit /exec.');
  PropertiesService.getScriptProperties().setProperty('WEBAPP_URL', url);
  return CODE_PREFIX + url + '|' + getKey_();
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
    if (p.action === 'ping') return { name: SpreadsheetApp.getActive().getName(), version: SCRIPT_VERSION };
    if (p.action === 'athletes') return { athletes: readAthletes_(), version: SCRIPT_VERSION };
    throw new Error('unknown_action');
  });
}

function doPost(e) {
  return handle_(function () {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    checkKey_(body.key);
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
        done.push(o.qid);
      });
      SpreadsheetApp.flush();
      return { done: done };
    } finally { lock.releaseLock(); }
  });
}

function handle_(fn) {
  var out;
  try { out = fn(); out.ok = true; }
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
}

function deleteAthlete_(id) {
  var sh = sheet_(SH_ATH), r = findRow_(sh, id);
  if (r) sh.deleteRow(r);
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
  if (n > 1) sh.getRange(2, 1, n - 1, 1).getValues().forEach(function (r) { have[String(r[0])] = true; });
  var add = [];
  rows.forEach(function (r) {
    if (!r.id || have[r.id]) return;
    have[r.id] = true;
    var d = new Date(r.ts);
    add.push([r.id, r.run, d, d, r.first, r.last, r.cat, r.role, r.boat, r.dist, r.time, num_(r.t), num_(r.v),
      r.pace, num_(r.rel), r.role === 'Steuerperson' ? '' : pct_(r.pct), num_(r.avgRate), r.splits || '', r.crew || '', r.ath || ''].concat(target_(r.dist, r.rel)));
  });
  if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, RES_HEAD.length).setValues(add);
  appendTeams_(add);
}
/** Prozent als Anteil speichern (1,08 statt 108). Ältere App-Versionen schicken noch 108 → umrechnen. */
function pct_(x) { var n = num_(x); return n === '' ? '' : (n > 3 ? n / 100 : n); }
function num_(x) { return (x === null || x === undefined || x === '' || !isFinite(x)) ? '' : Number(x); }

function deleteRun_(run) {
  if (!run) return;
  var sh = sheet_(SH_RES), n = sh.getLastRow();
  if (n < 2) return;
  var runs = sh.getRange(2, 2, n - 1, 1).getValues();
  for (var i = runs.length - 1; i >= 0; i--) if (String(runs[i][0]) === String(run)) sh.deleteRow(i + 2);
  var t = teamSheet_(), tn = t.getLastRow();
  if (tn < 2) return;
  var truns = t.getRange(2, 1, tn - 1, 1).getValues();
  for (var j = truns.length - 1; j >= 0; j--) if (String(truns[j][0]) === String(run)) t.deleteRow(j + 2);
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
function formatTeam_(t) {
  t.getRange('A:A').setFontColor('#999999');
  t.getRange('B:B').setNumberFormat('dd.MM.yyyy');
  t.getRange('C:C').setNumberFormat('HH:mm');
  t.getRange('I:I').setNumberFormat('@');          // Zeit
  t.getRange('J:J').setNumberFormat('0.00');       // Zeit (s)
  t.getRange('K:K').setNumberFormat('@');          // /500 m
  t.getRange('L:L').setNumberFormat('0.00');       // m/s
  t.getRange('M:M').setNumberFormat('0.0');        // Ø SF
  t.getRange('O:O').setNumberFormat('0.000000');   // Relation
  t.getRange('P:P').setNumberFormat('@');          // Zielzeit
  t.getRange('Q:Q').setNumberFormat('0.0');        // Zielzeit (s)
  t.getRange('R:R').setNumberFormat('0.0000');     // Prozent (Anteil)
}

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
  var by = {}, order = [];
  resRows.forEach(function (r) {
    var run = String(r[1]);
    if (!run) return;
    if (!by[run]) { by[run] = { rowers: [], cox: [] }; order.push(run); }
    (r[7] === 'Steuerperson' ? by[run].cox : by[run].rowers).push(r);
  });
  var out = [];
  order.forEach(function (run) {
    var g = by[run], f = g.rowers[0];
    if (!f) return; // nur Steuerperson: keine Bootszeile
    var cats = [];
    g.rowers.forEach(function (r) { if (cats.indexOf(r[6]) < 0) cats.push(r[6]); });
    var crew = f[18] || g.rowers.map(function (r) { return r[4] + ' ' + r[5]; }).join(', ');
    var cox = g.cox.map(function (r) { return r[4] + ' ' + r[5]; }).join(', ');
    var tg = target_(f[9], f[14]);
    // Reihenfolge = TEAM_HEAD
    out.push([run, f[2], f[3], f[9], crew, cox, cats.join(', '), f[8], f[10], f[11], f[13], f[12], f[16], f[17], f[14], tg[0], tg[1], f[15]]);
  });
  return out;
}

/** Neue Ergebniszeilen → fehlende Bootszeilen anhängen. */
function appendTeams_(resRows) {
  var rows = teamRows_(resRows);
  if (!rows.length) return;
  var t = teamSheet_(), n = t.getLastRow(), have = {};
  if (n > 1) t.getRange(2, 1, n - 1, 1).getValues().forEach(function (r) { have[String(r[0])] = true; });
  rows = rows.filter(function (r) { return !have[String(r[0])]; });
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
  if (res && !same(res, RES_HEAD)) {           // „Ergebnis Sportler“: nur fehlende Überschriften ergänzen
    var hr = res.getRange(1, 1, 1, RES_HEAD.length);
    hr.setValues([RES_HEAD]);
    hr.setFontWeight('bold');
  }
  var team = ss.getSheetByName(SH_TEAM);       // „Ergebnis Mannschaft“: alte Spaltenreihenfolge → neu aufbauen
  if (team && !same(team, TEAM_HEAD)) resetTeamSheet_();
}

/** Fehlende Zielzeiten in alten Zeilen nachtragen (aus Strecke und Relation). */
function fixTargets_() {
  // [Blatt, Spalte Strecke, Spalte Relation, Spalte Zielzeit] (1-basiert)
  [[SH_RES, 10, 15, 21], [SH_TEAM, TEAM_COL.dist, TEAM_COL.rel, TEAM_COL.target]].forEach(function (x) {
    var sh = SpreadsheetApp.getActive().getSheetByName(x[0]);
    if (!sh || sh.getLastRow() < 2) return;
    var n = sh.getLastRow() - 1;
    var dist = sh.getRange(2, x[1], n, 1).getValues(), rel = sh.getRange(2, x[2], n, 1).getValues();
    var tg = sh.getRange(2, x[3], n, 2), v = tg.getValues(), changed = false;
    v.forEach(function (r, i) { if (r[0] === '' && dist[i][0] !== '') { var t = target_(dist[i][0], rel[i][0]); if (t[0]) { v[i] = t; changed = true; } } });
    if (changed) tg.setValues(v);
  });
}

/** Alte Prozentwerte (108) in Anteile (1,08) umrechnen. Ein Anteil ist nie > 3, ein Prozentwert nie < 3 → eindeutig. */
function fixPercent_() {
  [[SH_RES, 16], [SH_TEAM, TEAM_COL.pct]].forEach(function (x) {
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
function rebuildTeams_() {
  var res = sheet_(SH_RES), n = res.getLastRow();
  var data = n > 1 ? res.getRange(2, 1, n - 1, RES_HEAD.length).getValues() : [];
  var rows = teamRows_(data), t = teamSheet_();
  if (t.getLastRow() > 1) t.getRange(2, 1, t.getLastRow() - 1, TEAM_HEAD.length).clearContent();
  if (rows.length) t.getRange(2, 1, rows.length, TEAM_HEAD.length).setValues(rows);
  return rows.length;
}

/* ------------------------------------------------------------------ Dialog */

var CONNECT_HTML = '<!doctype html><html><head><base target="_top"><style>' +
  'body{font-family:Arial,sans-serif;font-size:14px;color:#222;margin:0;padding:4px 2px}' +
  'input{width:100%;box-sizing:border-box;padding:8px;font-size:13px;border:1px solid #bbb;border-radius:6px}' +
  'button{background:#ff8a1c;border:0;border-radius:6px;padding:9px 14px;font-weight:bold;font-size:14px;cursor:pointer;margin-top:8px}' +
  '#qr{display:flex;justify-content:center;margin:10px 0}#qr img,#qr svg{width:300px;height:300px}' +
  '#code{width:100%;box-sizing:border-box;font-size:11px;height:58px}.err{color:#c00}.muted{color:#666;font-size:12px}' +
  '</style><script><?!= lib ?></script></head><body>' +
  '<div id="step1"><p><b>Web-App-Adresse</b> (aus "Bereitstellen → Neue Bereitstellung", endet auf <code>/exec</code>):</p>' +
  '<input id="url" value="<?= url ?>" placeholder="https://script.google.com/macros/s/…/exec">' +
  '<button onclick="go()">QR-Code anzeigen</button><p id="msg" class="err"></p></div>' +
  '<div id="step2" style="display:none"><p>In ChronOar auf dem Handy: <b>Sportler → ☁ Sheet → QR-Code scannen</b>.</p>' +
  '<div id="qr"></div><p class="muted">Oder den Code kopieren und in der App unter „Code einfügen“ einsetzen:</p>' +
  '<textarea id="code" readonly onclick="this.select()"></textarea>' +
  '<p class="muted">Der Code ist wie ein Passwort: Wer ihn hat, kann in dieses Sheet schreiben.</p></div>' +
  '<script>function go(){var u=document.getElementById("url").value;document.getElementById("msg").textContent="";' +
  'google.script.run.withSuccessHandler(show).withFailureHandler(function(e){document.getElementById("msg").textContent=e.message}).saveUrl(u)}' +
  'function show(c){var q=qrcode(0,"M");q.addData(c);q.make();document.getElementById("qr").innerHTML=q.createSvgTag({cellSize:6,margin:2,scalable:true});' +
  'document.getElementById("code").value=c;document.getElementById("step1").style.display="none";document.getElementById("step2").style.display="block"}' +
  '</script></body></html>';

/* qrcode-generator 1.4.4 (MIT, Kazuhiko Arase) – erzeugt den QR-Code im Dialog. */
var QR_LIB = "var qrcode=function(){var t=function(t,r){var e=t,n=g[r],o=null,i=0,a=null,u=[],f={},c=function(t,r){o=function(t){for(var r=new Array(t),e=0;e<t;e+=1){r[e]=new Array(t);for(var n=0;n<t;n+=1)r[e][n]=null}return r}(i=4*e+17),l(0,0),l(i-7,0),l(0,i-7),s(),h(),d(t,r),e>=7&&v(t),null==a&&(a=p(e,n,u)),w(a,r)},l=function(t,r){for(var e=-1;e<=7;e+=1)if(!(t+e<=-1||i<=t+e))for(var n=-1;n<=7;n+=1)r+n<=-1||i<=r+n||(o[t+e][r+n]=0<=e&&e<=6&&(0==n||6==n)||0<=n&&n<=6&&(0==e||6==e)||2<=e&&e<=4&&2<=n&&n<=4)},h=function(){for(var t=8;t<i-8;t+=1)null==o[t][6]&&(o[t][6]=t%2==0);for(var r=8;r<i-8;r+=1)null==o[6][r]&&(o[6][r]=r%2==0)},s=function(){for(var t=B.getPatternPosition(e),r=0;r<t.length;r+=1)for(var n=0;n<t.length;n+=1){var i=t[r],a=t[n];if(null==o[i][a])for(var u=-2;u<=2;u+=1)for(var f=-2;f<=2;f+=1)o[i+u][a+f]=-2==u||2==u||-2==f||2==f||0==u&&0==f}},v=function(t){for(var r=B.getBCHTypeNumber(e),n=0;n<18;n+=1){var a=!t&&1==(r>>n&1);o[Math.floor(n/3)][n%3+i-8-3]=a}for(n=0;n<18;n+=1){a=!t&&1==(r>>n&1);o[n%3+i-8-3][Math.floor(n/3)]=a}},d=function(t,r){for(var e=n<<3|r,a=B.getBCHTypeInfo(e),u=0;u<15;u+=1){var f=!t&&1==(a>>u&1);u<6?o[u][8]=f:u<8?o[u+1][8]=f:o[i-15+u][8]=f}for(u=0;u<15;u+=1){f=!t&&1==(a>>u&1);u<8?o[8][i-u-1]=f:u<9?o[8][15-u-1+1]=f:o[8][15-u-1]=f}o[i-8][8]=!t},w=function(t,r){for(var e=-1,n=i-1,a=7,u=0,f=B.getMaskFunction(r),c=i-1;c>0;c-=2)for(6==c&&(c-=1);;){for(var g=0;g<2;g+=1)if(null==o[n][c-g]){var l=!1;u<t.length&&(l=1==(t[u]>>>a&1)),f(n,c-g)&&(l=!l),o[n][c-g]=l,-1==(a-=1)&&(u+=1,a=7)}if((n+=e)<0||i<=n){n-=e,e=-e;break}}},p=function(t,r,e){for(var n=A.getRSBlocks(t,r),o=b(),i=0;i<e.length;i+=1){var a=e[i];o.put(a.getMode(),4),o.put(a.getLength(),B.getLengthInBits(a.getMode(),t)),a.write(o)}var u=0;for(i=0;i<n.length;i+=1)u+=n[i].dataCount;if(o.getLengthInBits()>8*u)throw\"code length overflow. (\"+o.getLengthInBits()+\">\"+8*u+\")\";for(o.getLengthInBits()+4<=8*u&&o.put(0,4);o.getLengthInBits()%8!=0;)o.putBit(!1);for(;!(o.getLengthInBits()>=8*u||(o.put(236,8),o.getLengthInBits()>=8*u));)o.put(17,8);return function(t,r){for(var e=0,n=0,o=0,i=new Array(r.length),a=new Array(r.length),u=0;u<r.length;u+=1){var f=r[u].dataCount,c=r[u].totalCount-f;n=Math.max(n,f),o=Math.max(o,c),i[u]=new Array(f);for(var g=0;g<i[u].length;g+=1)i[u][g]=255&t.getBuffer()[g+e];e+=f;var l=B.getErrorCorrectPolynomial(c),h=k(i[u],l.getLength()-1).mod(l);for(a[u]=new Array(l.getLength()-1),g=0;g<a[u].length;g+=1){var s=g+h.getLength()-a[u].length;a[u][g]=s>=0?h.getAt(s):0}}var v=0;for(g=0;g<r.length;g+=1)v+=r[g].totalCount;var d=new Array(v),w=0;for(g=0;g<n;g+=1)for(u=0;u<r.length;u+=1)g<i[u].length&&(d[w]=i[u][g],w+=1);for(g=0;g<o;g+=1)for(u=0;u<r.length;u+=1)g<a[u].length&&(d[w]=a[u][g],w+=1);return d}(o,n)};f.addData=function(t,r){var e=null;switch(r=r||\"Byte\"){case\"Numeric\":e=M(t);break;case\"Alphanumeric\":e=x(t);break;case\"Byte\":e=m(t);break;case\"Kanji\":e=L(t);break;default:throw\"mode:\"+r}u.push(e),a=null},f.isDark=function(t,r){if(t<0||i<=t||r<0||i<=r)throw t+\",\"+r;return o[t][r]},f.getModuleCount=function(){return i},f.make=function(){if(e<1){for(var t=1;t<40;t++){for(var r=A.getRSBlocks(t,n),o=b(),i=0;i<u.length;i++){var a=u[i];o.put(a.getMode(),4),o.put(a.getLength(),B.getLengthInBits(a.getMode(),t)),a.write(o)}var g=0;for(i=0;i<r.length;i++)g+=r[i].dataCount;if(o.getLengthInBits()<=8*g)break}e=t}c(!1,function(){for(var t=0,r=0,e=0;e<8;e+=1){c(!0,e);var n=B.getLostPoint(f);(0==e||t>n)&&(t=n,r=e)}return r}())},f.createTableTag=function(t,r){t=t||2;var e=\"\";e+='<table style=\"',e+=\" border-width: 0px; border-style: none;\",e+=\" border-collapse: collapse;\",e+=\" padding: 0px; margin: \"+(r=void 0===r?4*t:r)+\"px;\",e+='\">',e+=\"<tbody>\";for(var n=0;n<f.getModuleCount();n+=1){e+=\"<tr>\";for(var o=0;o<f.getModuleCount();o+=1)e+='<td style=\"',e+=\" border-width: 0px; border-style: none;\",e+=\" border-collapse: collapse;\",e+=\" padding: 0px; margin: 0px;\",e+=\" width: \"+t+\"px;\",e+=\" height: \"+t+\"px;\",e+=\" background-color: \",e+=f.isDark(n,o)?\"#000000\":\"#ffffff\",e+=\";\",e+='\"/>';e+=\"</tr>\"}return e+=\"</tbody>\",e+=\"</table>\"},f.createSvgTag=function(t,r,e,n){var o={};\"object\"==typeof arguments[0]&&(t=(o=arguments[0]).cellSize,r=o.margin,e=o.alt,n=o.title),t=t||2,r=void 0===r?4*t:r,(e=\"string\"==typeof e?{text:e}:e||{}).text=e.text||null,e.id=e.text?e.id||\"qrcode-description\":null,(n=\"string\"==typeof n?{text:n}:n||{}).text=n.text||null,n.id=n.text?n.id||\"qrcode-title\":null;var i,a,u,c,g=f.getModuleCount()*t+2*r,l=\"\";for(c=\"l\"+t+\",0 0,\"+t+\" -\"+t+\",0 0,-\"+t+\"z \",l+='<svg version=\"1.1\" xmlns=\"http://www.w3.org/2000/svg\"',l+=o.scalable?\"\":' width=\"'+g+'px\" height=\"'+g+'px\"',l+=' viewBox=\"0 0 '+g+\" \"+g+'\" ',l+=' preserveAspectRatio=\"xMinYMin meet\"',l+=n.text||e.text?' role=\"img\" aria-labelledby=\"'+y([n.id,e.id].join(\" \").trim())+'\"':\"\",l+=\">\",l+=n.text?'<title id=\"'+y(n.id)+'\">'+y(n.text)+\"</title>\":\"\",l+=e.text?'<description id=\"'+y(e.id)+'\">'+y(e.text)+\"</description>\":\"\",l+='<rect width=\"100%\" height=\"100%\" fill=\"white\" cx=\"0\" cy=\"0\"/>',l+='<path d=\"',a=0;a<f.getModuleCount();a+=1)for(u=a*t+r,i=0;i<f.getModuleCount();i+=1)f.isDark(a,i)&&(l+=\"M\"+(i*t+r)+\",\"+u+c);return l+='\" stroke=\"transparent\" fill=\"black\"/>',l+=\"</svg>\"},f.createDataURL=function(t,r){t=t||2,r=void 0===r?4*t:r;var e=f.getModuleCount()*t+2*r,n=r,o=e-r;return I(e,e,function(r,e){if(n<=r&&r<o&&n<=e&&e<o){var i=Math.floor((r-n)/t),a=Math.floor((e-n)/t);return f.isDark(a,i)?0:1}return 1})},f.createImgTag=function(t,r,e){t=t||2,r=void 0===r?4*t:r;var n=f.getModuleCount()*t+2*r,o=\"\";return o+=\"<img\",o+=' src=\"',o+=f.createDataURL(t,r),o+='\"',o+=' width=\"',o+=n,o+='\"',o+=' height=\"',o+=n,o+='\"',e&&(o+=' alt=\"',o+=y(e),o+='\"'),o+=\"/>\"};var y=function(t){for(var r=\"\",e=0;e<t.length;e+=1){var n=t.charAt(e);switch(n){case\"<\":r+=\"&lt;\";break;case\">\":r+=\"&gt;\";break;case\"&\":r+=\"&amp;\";break;case'\"':r+=\"&quot;\";break;default:r+=n}}return r};return f.createASCII=function(t,r){if((t=t||1)<2)return function(t){t=void 0===t?2:t;var r,e,n,o,i,a=1*f.getModuleCount()+2*t,u=t,c=a-t,g={\"\u2588\u2588\":\"\u2588\",\"\u2588 \":\"\u2580\",\" \u2588\":\"\u2584\",\"  \":\" \"},l={\"\u2588\u2588\":\"\u2580\",\"\u2588 \":\"\u2580\",\" \u2588\":\" \",\"  \":\" \"},h=\"\";for(r=0;r<a;r+=2){for(n=Math.floor((r-u)/1),o=Math.floor((r+1-u)/1),e=0;e<a;e+=1)i=\"\u2588\",u<=e&&e<c&&u<=r&&r<c&&f.isDark(n,Math.floor((e-u)/1))&&(i=\" \"),u<=e&&e<c&&u<=r+1&&r+1<c&&f.isDark(o,Math.floor((e-u)/1))?i+=\" \":i+=\"\u2588\",h+=t<1&&r+1>=c?l[i]:g[i];h+=\"\\n\"}return a%2&&t>0?h.substring(0,h.length-a-1)+Array(a+1).join(\"\u2580\"):h.substring(0,h.length-1)}(r);t-=1,r=void 0===r?2*t:r;var e,n,o,i,a=f.getModuleCount()*t+2*r,u=r,c=a-r,g=Array(t+1).join(\"\u2588\u2588\"),l=Array(t+1).join(\"  \"),h=\"\",s=\"\";for(e=0;e<a;e+=1){for(o=Math.floor((e-u)/t),s=\"\",n=0;n<a;n+=1)i=1,u<=n&&n<c&&u<=e&&e<c&&f.isDark(o,Math.floor((n-u)/t))&&(i=0),s+=i?g:l;for(o=0;o<t;o+=1)h+=s+\"\\n\"}return h.substring(0,h.length-1)},f.renderTo2dContext=function(t,r){r=r||2;for(var e=f.getModuleCount(),n=0;n<e;n++)for(var o=0;o<e;o++)t.fillStyle=f.isDark(n,o)?\"black\":\"white\",t.fillRect(n*r,o*r,r,r)},f};t.stringToBytes=(t.stringToBytesFuncs={default:function(t){for(var r=[],e=0;e<t.length;e+=1){var n=t.charCodeAt(e);r.push(255&n)}return r}}).default,t.createStringToBytes=function(t,r){var e=function(){for(var e=S(t),n=function(){var t=e.read();if(-1==t)throw\"eof\";return t},o=0,i={};;){var a=e.read();if(-1==a)break;var u=n(),f=n()<<8|n();i[String.fromCharCode(a<<8|u)]=f,o+=1}if(o!=r)throw o+\" != \"+r;return i}(),n=\"?\".charCodeAt(0);return function(t){for(var r=[],o=0;o<t.length;o+=1){var i=t.charCodeAt(o);if(i<128)r.push(i);else{var a=e[t.charAt(o)];\"number\"==typeof a?(255&a)==a?r.push(a):(r.push(a>>>8),r.push(255&a)):r.push(n)}}return r}};var r,e,n,o,i,a=1,u=2,f=4,c=8,g={L:1,M:0,Q:3,H:2},l=0,h=1,s=2,v=3,d=4,w=5,p=6,y=7,B=(r=[[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],[6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],[6,26,50,74],[6,30,54,78],[6,30,56,82],[6,30,58,86],[6,34,62,90],[6,28,50,72,94],[6,26,50,74,98],[6,30,54,78,102],[6,28,54,80,106],[6,32,58,84,110],[6,30,58,86,114],[6,34,62,90,118],[6,26,50,74,98,122],[6,30,54,78,102,126],[6,26,52,78,104,130],[6,30,56,82,108,134],[6,34,60,86,112,138],[6,30,58,86,114,142],[6,34,62,90,118,146],[6,30,54,78,102,126,150],[6,24,50,76,102,128,154],[6,28,54,80,106,132,158],[6,32,58,84,110,136,162],[6,26,54,82,110,138,166],[6,30,58,86,114,142,170]],e=1335,n=7973,i=function(t){for(var r=0;0!=t;)r+=1,t>>>=1;return r},(o={}).getBCHTypeInfo=function(t){for(var r=t<<10;i(r)-i(e)>=0;)r^=e<<i(r)-i(e);return 21522^(t<<10|r)},o.getBCHTypeNumber=function(t){for(var r=t<<12;i(r)-i(n)>=0;)r^=n<<i(r)-i(n);return t<<12|r},o.getPatternPosition=function(t){return r[t-1]},o.getMaskFunction=function(t){switch(t){case l:return function(t,r){return(t+r)%2==0};case h:return function(t,r){return t%2==0};case s:return function(t,r){return r%3==0};case v:return function(t,r){return(t+r)%3==0};case d:return function(t,r){return(Math.floor(t/2)+Math.floor(r/3))%2==0};case w:return function(t,r){return t*r%2+t*r%3==0};case p:return function(t,r){return(t*r%2+t*r%3)%2==0};case y:return function(t,r){return(t*r%3+(t+r)%2)%2==0};default:throw\"bad maskPattern:\"+t}},o.getErrorCorrectPolynomial=function(t){for(var r=k([1],0),e=0;e<t;e+=1)r=r.multiply(k([1,C.gexp(e)],0));return r},o.getLengthInBits=function(t,r){if(1<=r&&r<10)switch(t){case a:return 10;case u:return 9;case f:case c:return 8;default:throw\"mode:\"+t}else if(r<27)switch(t){case a:return 12;case u:return 11;case f:return 16;case c:return 10;default:throw\"mode:\"+t}else{if(!(r<41))throw\"type:\"+r;switch(t){case a:return 14;case u:return 13;case f:return 16;case c:return 12;default:throw\"mode:\"+t}}},o.getLostPoint=function(t){for(var r=t.getModuleCount(),e=0,n=0;n<r;n+=1)for(var o=0;o<r;o+=1){for(var i=0,a=t.isDark(n,o),u=-1;u<=1;u+=1)if(!(n+u<0||r<=n+u))for(var f=-1;f<=1;f+=1)o+f<0||r<=o+f||0==u&&0==f||a==t.isDark(n+u,o+f)&&(i+=1);i>5&&(e+=3+i-5)}for(n=0;n<r-1;n+=1)for(o=0;o<r-1;o+=1){var c=0;t.isDark(n,o)&&(c+=1),t.isDark(n+1,o)&&(c+=1),t.isDark(n,o+1)&&(c+=1),t.isDark(n+1,o+1)&&(c+=1),0!=c&&4!=c||(e+=3)}for(n=0;n<r;n+=1)for(o=0;o<r-6;o+=1)t.isDark(n,o)&&!t.isDark(n,o+1)&&t.isDark(n,o+2)&&t.isDark(n,o+3)&&t.isDark(n,o+4)&&!t.isDark(n,o+5)&&t.isDark(n,o+6)&&(e+=40);for(o=0;o<r;o+=1)for(n=0;n<r-6;n+=1)t.isDark(n,o)&&!t.isDark(n+1,o)&&t.isDark(n+2,o)&&t.isDark(n+3,o)&&t.isDark(n+4,o)&&!t.isDark(n+5,o)&&t.isDark(n+6,o)&&(e+=40);var g=0;for(o=0;o<r;o+=1)for(n=0;n<r;n+=1)t.isDark(n,o)&&(g+=1);return e+=Math.abs(100*g/r/r-50)/5*10},o),C=function(){for(var t=new Array(256),r=new Array(256),e=0;e<8;e+=1)t[e]=1<<e;for(e=8;e<256;e+=1)t[e]=t[e-4]^t[e-5]^t[e-6]^t[e-8];for(e=0;e<255;e+=1)r[t[e]]=e;var n={glog:function(t){if(t<1)throw\"glog(\"+t+\")\";return r[t]},gexp:function(r){for(;r<0;)r+=255;for(;r>=256;)r-=255;return t[r]}};return n}();function k(t,r){if(void 0===t.length)throw t.length+\"/\"+r;var e=function(){for(var e=0;e<t.length&&0==t[e];)e+=1;for(var n=new Array(t.length-e+r),o=0;o<t.length-e;o+=1)n[o]=t[o+e];return n}(),n={getAt:function(t){return e[t]},getLength:function(){return e.length},multiply:function(t){for(var r=new Array(n.getLength()+t.getLength()-1),e=0;e<n.getLength();e+=1)for(var o=0;o<t.getLength();o+=1)r[e+o]^=C.gexp(C.glog(n.getAt(e))+C.glog(t.getAt(o)));return k(r,0)},mod:function(t){if(n.getLength()-t.getLength()<0)return n;for(var r=C.glog(n.getAt(0))-C.glog(t.getAt(0)),e=new Array(n.getLength()),o=0;o<n.getLength();o+=1)e[o]=n.getAt(o);for(o=0;o<t.getLength();o+=1)e[o]^=C.gexp(C.glog(t.getAt(o))+r);return k(e,0).mod(t)}};return n}var A=function(){var t=[[1,26,19],[1,26,16],[1,26,13],[1,26,9],[1,44,34],[1,44,28],[1,44,22],[1,44,16],[1,70,55],[1,70,44],[2,35,17],[2,35,13],[1,100,80],[2,50,32],[2,50,24],[4,25,9],[1,134,108],[2,67,43],[2,33,15,2,34,16],[2,33,11,2,34,12],[2,86,68],[4,43,27],[4,43,19],[4,43,15],[2,98,78],[4,49,31],[2,32,14,4,33,15],[4,39,13,1,40,14],[2,121,97],[2,60,38,2,61,39],[4,40,18,2,41,19],[4,40,14,2,41,15],[2,146,116],[3,58,36,2,59,37],[4,36,16,4,37,17],[4,36,12,4,37,13],[2,86,68,2,87,69],[4,69,43,1,70,44],[6,43,19,2,44,20],[6,43,15,2,44,16],[4,101,81],[1,80,50,4,81,51],[4,50,22,4,51,23],[3,36,12,8,37,13],[2,116,92,2,117,93],[6,58,36,2,59,37],[4,46,20,6,47,21],[7,42,14,4,43,15],[4,133,107],[8,59,37,1,60,38],[8,44,20,4,45,21],[12,33,11,4,34,12],[3,145,115,1,146,116],[4,64,40,5,65,41],[11,36,16,5,37,17],[11,36,12,5,37,13],[5,109,87,1,110,88],[5,65,41,5,66,42],[5,54,24,7,55,25],[11,36,12,7,37,13],[5,122,98,1,123,99],[7,73,45,3,74,46],[15,43,19,2,44,20],[3,45,15,13,46,16],[1,135,107,5,136,108],[10,74,46,1,75,47],[1,50,22,15,51,23],[2,42,14,17,43,15],[5,150,120,1,151,121],[9,69,43,4,70,44],[17,50,22,1,51,23],[2,42,14,19,43,15],[3,141,113,4,142,114],[3,70,44,11,71,45],[17,47,21,4,48,22],[9,39,13,16,40,14],[3,135,107,5,136,108],[3,67,41,13,68,42],[15,54,24,5,55,25],[15,43,15,10,44,16],[4,144,116,4,145,117],[17,68,42],[17,50,22,6,51,23],[19,46,16,6,47,17],[2,139,111,7,140,112],[17,74,46],[7,54,24,16,55,25],[34,37,13],[4,151,121,5,152,122],[4,75,47,14,76,48],[11,54,24,14,55,25],[16,45,15,14,46,16],[6,147,117,4,148,118],[6,73,45,14,74,46],[11,54,24,16,55,25],[30,46,16,2,47,17],[8,132,106,4,133,107],[8,75,47,13,76,48],[7,54,24,22,55,25],[22,45,15,13,46,16],[10,142,114,2,143,115],[19,74,46,4,75,47],[28,50,22,6,51,23],[33,46,16,4,47,17],[8,152,122,4,153,123],[22,73,45,3,74,46],[8,53,23,26,54,24],[12,45,15,28,46,16],[3,147,117,10,148,118],[3,73,45,23,74,46],[4,54,24,31,55,25],[11,45,15,31,46,16],[7,146,116,7,147,117],[21,73,45,7,74,46],[1,53,23,37,54,24],[19,45,15,26,46,16],[5,145,115,10,146,116],[19,75,47,10,76,48],[15,54,24,25,55,25],[23,45,15,25,46,16],[13,145,115,3,146,116],[2,74,46,29,75,47],[42,54,24,1,55,25],[23,45,15,28,46,16],[17,145,115],[10,74,46,23,75,47],[10,54,24,35,55,25],[19,45,15,35,46,16],[17,145,115,1,146,116],[14,74,46,21,75,47],[29,54,24,19,55,25],[11,45,15,46,46,16],[13,145,115,6,146,116],[14,74,46,23,75,47],[44,54,24,7,55,25],[59,46,16,1,47,17],[12,151,121,7,152,122],[12,75,47,26,76,48],[39,54,24,14,55,25],[22,45,15,41,46,16],[6,151,121,14,152,122],[6,75,47,34,76,48],[46,54,24,10,55,25],[2,45,15,64,46,16],[17,152,122,4,153,123],[29,74,46,14,75,47],[49,54,24,10,55,25],[24,45,15,46,46,16],[4,152,122,18,153,123],[13,74,46,32,75,47],[48,54,24,14,55,25],[42,45,15,32,46,16],[20,147,117,4,148,118],[40,75,47,7,76,48],[43,54,24,22,55,25],[10,45,15,67,46,16],[19,148,118,6,149,119],[18,75,47,31,76,48],[34,54,24,34,55,25],[20,45,15,61,46,16]],r=function(t,r){var e={};return e.totalCount=t,e.dataCount=r,e},e={};return e.getRSBlocks=function(e,n){var o=function(r,e){switch(e){case g.L:return t[4*(r-1)+0];case g.M:return t[4*(r-1)+1];case g.Q:return t[4*(r-1)+2];case g.H:return t[4*(r-1)+3];default:return}}(e,n);if(void 0===o)throw\"bad rs block @ typeNumber:\"+e+\"/errorCorrectionLevel:\"+n;for(var i=o.length/3,a=[],u=0;u<i;u+=1)for(var f=o[3*u+0],c=o[3*u+1],l=o[3*u+2],h=0;h<f;h+=1)a.push(r(c,l));return a},e}(),b=function(){var t=[],r=0,e={getBuffer:function(){return t},getAt:function(r){var e=Math.floor(r/8);return 1==(t[e]>>>7-r%8&1)},put:function(t,r){for(var n=0;n<r;n+=1)e.putBit(1==(t>>>r-n-1&1))},getLengthInBits:function(){return r},putBit:function(e){var n=Math.floor(r/8);t.length<=n&&t.push(0),e&&(t[n]|=128>>>r%8),r+=1}};return e},M=function(t){var r=a,e=t,n={getMode:function(){return r},getLength:function(t){return e.length},write:function(t){for(var r=e,n=0;n+2<r.length;)t.put(o(r.substring(n,n+3)),10),n+=3;n<r.length&&(r.length-n==1?t.put(o(r.substring(n,n+1)),4):r.length-n==2&&t.put(o(r.substring(n,n+2)),7))}},o=function(t){for(var r=0,e=0;e<t.length;e+=1)r=10*r+i(t.charAt(e));return r},i=function(t){if(\"0\"<=t&&t<=\"9\")return t.charCodeAt(0)-\"0\".charCodeAt(0);throw\"illegal char :\"+t};return n},x=function(t){var r=u,e=t,n={getMode:function(){return r},getLength:function(t){return e.length},write:function(t){for(var r=e,n=0;n+1<r.length;)t.put(45*o(r.charAt(n))+o(r.charAt(n+1)),11),n+=2;n<r.length&&t.put(o(r.charAt(n)),6)}},o=function(t){if(\"0\"<=t&&t<=\"9\")return t.charCodeAt(0)-\"0\".charCodeAt(0);if(\"A\"<=t&&t<=\"Z\")return t.charCodeAt(0)-\"A\".charCodeAt(0)+10;switch(t){case\" \":return 36;case\"$\":return 37;case\"%\":return 38;case\"*\":return 39;case\"+\":return 40;case\"-\":return 41;case\".\":return 42;case\"/\":return 43;case\":\":return 44;default:throw\"illegal char :\"+t}};return n},m=function(r){var e=f,n=t.stringToBytes(r),o={getMode:function(){return e},getLength:function(t){return n.length},write:function(t){for(var r=0;r<n.length;r+=1)t.put(n[r],8)}};return o},L=function(r){var e=c,n=t.stringToBytesFuncs.SJIS;if(!n)throw\"sjis not supported.\";!function(){var t=n(\"\u53cb\");if(2!=t.length||38726!=(t[0]<<8|t[1]))throw\"sjis not supported.\"}();var o=n(r),i={getMode:function(){return e},getLength:function(t){return~~(o.length/2)},write:function(t){for(var r=o,e=0;e+1<r.length;){var n=(255&r[e])<<8|255&r[e+1];if(33088<=n&&n<=40956)n-=33088;else{if(!(57408<=n&&n<=60351))throw\"illegal char at \"+(e+1)+\"/\"+n;n-=49472}n=192*(n>>>8&255)+(255&n),t.put(n,13),e+=2}if(e<r.length)throw\"illegal char at \"+(e+1)}};return i},D=function(){var t=[],r={writeByte:function(r){t.push(255&r)},writeShort:function(t){r.writeByte(t),r.writeByte(t>>>8)},writeBytes:function(t,e,n){e=e||0,n=n||t.length;for(var o=0;o<n;o+=1)r.writeByte(t[o+e])},writeString:function(t){for(var e=0;e<t.length;e+=1)r.writeByte(t.charCodeAt(e))},toByteArray:function(){return t},toString:function(){var r=\"\";r+=\"[\";for(var e=0;e<t.length;e+=1)e>0&&(r+=\",\"),r+=t[e];return r+=\"]\"}};return r},S=function(t){var r=t,e=0,n=0,o=0,i={read:function(){for(;o<8;){if(e>=r.length){if(0==o)return-1;throw\"unexpected end of file./\"+o}var t=r.charAt(e);if(e+=1,\"=\"==t)return o=0,-1;t.match(/^\\s$/)||(n=n<<6|a(t.charCodeAt(0)),o+=6)}var i=n>>>o-8&255;return o-=8,i}},a=function(t){if(65<=t&&t<=90)return t-65;if(97<=t&&t<=122)return t-97+26;if(48<=t&&t<=57)return t-48+52;if(43==t)return 62;if(47==t)return 63;throw\"c:\"+t};return i},I=function(t,r,e){for(var n=function(t,r){var e=t,n=r,o=new Array(t*r),i={setPixel:function(t,r,n){o[r*e+t]=n},write:function(t){t.writeString(\"GIF87a\"),t.writeShort(e),t.writeShort(n),t.writeByte(128),t.writeByte(0),t.writeByte(0),t.writeByte(0),t.writeByte(0),t.writeByte(0),t.writeByte(255),t.writeByte(255),t.writeByte(255),t.writeString(\",\"),t.writeShort(0),t.writeShort(0),t.writeShort(e),t.writeShort(n),t.writeByte(0);var r=a(2);t.writeByte(2);for(var o=0;r.length-o>255;)t.writeByte(255),t.writeBytes(r,o,255),o+=255;t.writeByte(r.length-o),t.writeBytes(r,o,r.length-o),t.writeByte(0),t.writeString(\";\")}},a=function(t){for(var r=1<<t,e=1+(1<<t),n=t+1,i=u(),a=0;a<r;a+=1)i.add(String.fromCharCode(a));i.add(String.fromCharCode(r)),i.add(String.fromCharCode(e));var f,c,g,l=D(),h=(f=l,c=0,g=0,{write:function(t,r){if(t>>>r!=0)throw\"length over\";for(;c+r>=8;)f.writeByte(255&(t<<c|g)),r-=8-c,t>>>=8-c,g=0,c=0;g|=t<<c,c+=r},flush:function(){c>0&&f.writeByte(g)}});h.write(r,n);var s=0,v=String.fromCharCode(o[s]);for(s+=1;s<o.length;){var d=String.fromCharCode(o[s]);s+=1,i.contains(v+d)?v+=d:(h.write(i.indexOf(v),n),i.size()<4095&&(i.size()==1<<n&&(n+=1),i.add(v+d)),v=d)}return h.write(i.indexOf(v),n),h.write(e,n),h.flush(),l.toByteArray()},u=function(){var t={},r=0,e={add:function(n){if(e.contains(n))throw\"dup key:\"+n;t[n]=r,r+=1},size:function(){return r},indexOf:function(r){return t[r]},contains:function(r){return void 0!==t[r]}};return e};return i}(t,r),o=0;o<r;o+=1)for(var i=0;i<t;i+=1)n.setPixel(i,o,e(i,o));var a=D();n.write(a);for(var u=function(){var t=0,r=0,e=0,n=\"\",o={},i=function(t){n+=String.fromCharCode(a(63&t))},a=function(t){if(t<0);else{if(t<26)return 65+t;if(t<52)return t-26+97;if(t<62)return t-52+48;if(62==t)return 43;if(63==t)return 47}throw\"n:\"+t};return o.writeByte=function(n){for(t=t<<8|255&n,r+=8,e+=1;r>=6;)i(t>>>r-6),r-=6},o.flush=function(){if(r>0&&(i(t<<6-r),t=0,r=0),e%3!=0)for(var o=3-e%3,a=0;a<o;a+=1)n+=\"=\"},o.toString=function(){return n},o}(),f=a.toByteArray(),c=0;c<f.length;c+=1)u.writeByte(f[c]);return u.flush(),\"data:image/gif;base64,\"+u};return t}();qrcode.stringToBytesFuncs[\"UTF-8\"]=function(t){return function(t){for(var r=[],e=0;e<t.length;e++){var n=t.charCodeAt(e);n<128?r.push(n):n<2048?r.push(192|n>>6,128|63&n):n<55296||n>=57344?r.push(224|n>>12,128|n>>6&63,128|63&n):(e++,n=65536+((1023&n)<<10|1023&t.charCodeAt(e)),r.push(240|n>>18,128|n>>12&63,128|n>>6&63,128|63&n))}return r}(t)},function(t){\"function\"==typeof define&&define.amd?define([],t):\"object\"==typeof exports&&(module.exports=t())}(function(){return qrcode});";
