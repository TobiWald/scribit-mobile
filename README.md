# Scribit Mobile

Android-App für den Scribit-Wandmalroboter mit der [Unbrickit](https://github.com/karimi/unbrickit)-Firmware. Sie ersetzt die Windows/Mac-App zum Zeichnen und kann einiges mehr.

## Installieren

1. Auf dem Handy die Seite **Releases** dieses Repos öffnen (rechts auf der Startseite).
2. Beim neuesten Eintrag unter *Assets* die Datei `ScribitMobile-….apk` antippen.
3. Android fragt beim ersten Mal, ob Installationen aus dem Browser erlaubt sind. Erlauben, installieren.

Jeder Push auf `main` baut automatisch eine neue Version. Updates lassen sich einfach über die alte Version installieren.

## Erste Schritte

1. Scribit einschalten und aufhängen.
2. Handy mit dem WLAN **ScribIt-XXXXXX** verbinden. Die Meldung „Kein Internet“ ist normal, verbunden bleiben.
3. In der App oben rechts sollte **Bereit** stehen.
4. Tab **Gerät**: Abstand der Aufhängepunkte und die beiden Fadenlängen eintragen (oder die Position der Stiftspitze), dann **Stiftmechanik kalibrieren**.
5. Tab **Motiv**: SVG öffnen, Foto umwandeln oder ein Beispiel nehmen. Farben den vier Stiftplätzen zuordnen.
6. Tab **Wand**: Motiv mit dem Finger verschieben, mit zwei Fingern größer oder kleiner machen. ▶ spielt den Ablauf ab.
7. Optional Tab **AR**: Wand fotografieren, die zwei Aufhängepunkte antippen und das Motiv direkt im Foto platzieren.
8. Tab **Zeichnen**: Häkchen setzen, optional **Rahmen abfahren**, dann **Zeichnen starten**.

Während gezeichnet wird, bleibt der Bildschirm an. Die App am besten offen lassen.

## Was gegenüber Unbrickit dazugekommen ist

- **Läuft auf Android** und spricht den Roboter direkt über das ScribIt-WLAN an, auch wenn das Handy gleichzeitig mobile Daten hat.
- **Keine Größengrenze mehr.** Die Firmware zählt die Upload-Länge in 16 Bit (max. 64 KB) und liest den Inhalt, ohne auf weitere Netzwerkpakete zu warten. Die App schickt deshalb kleine Pakete, prüft jedes nach und setzt bei einem abgeschnittenen Paket exakt an der richtigen Stelle wieder auf.
- **Echtes Stopp:** Stift hoch und zurück zur Startposition (die Firmware selbst hat kein Stopp).
- **Bilder umwandeln:** Linien (Konturen), Schraffur wie ein Kupferstich, oder Farbflächen passend zu den eingesetzten Stiften.
- **SVG vollständiger:** Transformationen, Gruppen, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `<use>`, CSS-Farben. Gefüllte Flächen werden auf Wunsch schraffiert.
- **4 Farben richtig sortiert:** Der Stiftzylinder dreht nur vorwärts und in der kürzesten Reihenfolge. Mehr als 4 Farben gehen mit Tausch-Pausen.
- **Vorschau und Simulation** mit Dauer, Strichlänge, Absetzern und Warnung, wenn etwas außerhalb des sicheren Bereichs liegt.
- **AR-Vorschau** im Kamerabild.
- **Position wird mitgerechnet:** Beim Bewegen mit den Pfeiltasten aktualisiert die App die Fadenlängen selbst.
- **Testquadrat-Kalibrierung:** Quadrat zeichnen, nachmessen, die App korrigiert Breite und Höhe.
- **Rahmen abfahren** (ohne Stift), **G-Code speichern**, **G-Code direkt senden**.
- Bilder aus der Galerie per **Teilen** an die App schicken, SVG-Dateien mit der App öffnen.

Firmware flashen geht weiterhin nur mit Unbrickit am PC.

## Technik

- `app/src/main/assets/www/` ist die eigentliche App (HTML/JS, ohne Build-Schritt).
- `app/src/main/java/…/MainActivity.java` ist die Android-Hülle: WebView, HTTP über das WLAN, Kamera, Dateien, Benachrichtigung während des Zeichnens.
- Die Kinematik entspricht dem am Gerät getesteten Unbrickit-Konverter (Gondel 105 mm, Winkel- und Höhenkorrektur), ist aber in beide Richtungen konsistent.
- Der Signierschlüssel `app/scribit-mobile.jks` liegt bewusst im Repo, damit die automatischen Builds sich gegenseitig updaten können. Für eine App, die nur du selbst installierst, ist das in Ordnung.

### Am PC testen ohne Roboter

```
node tools/mock-scribit.js
```

Dann `http://127.0.0.1:8080` im Browser öffnen und unter **Gerät** als Adresse `127.0.0.1` eintragen. Der Simulator verhält sich wie die Firmware (inkl. 64-KB-Grenze). Mit `TRUNC=0.2` werden zum Testen 20 % der Uploads abgeschnitten.
