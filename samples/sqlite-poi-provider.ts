import { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../../domain/models/errors.js';
import type { BoundingBox } from '../../domain/models/geo.js';
import type { Poi, PoiCategory } from '../../domain/models/poi.js';
import type { PoiProvider, PoiSource } from '../../domain/ports/poi-provider.js';
import { containsBoundingBox, type Coverage } from './coverage.js';
import { META, POI_SCHEMA_VERSION, rulesFingerprint } from './database.js';

type Row = {
  osm_type: string;
  osm_id: number;
  name: string | null;
  brand: string | null;
  website: string | null;
  sport: string | null;
  place: string | null;
  latitude: number;
  longitude: number;
  area_square_meters: number | null;
};

/**
 * Der R-Tree grenzt ein, die exakten Spalten entscheiden.
 *
 * SQLite legt die Indexwerte als 32-Bit-Gleitkomma ab und rundet nach aussen
 * -- er liefert also eine Spur zu viel. Das ist die sichere Richtung, aber
 * beim Abgleich mit Overpass (S5) sähen die paar Randobjekte wie ein Fehler
 * im Filter aus. Deshalb die zweite Bedingung auf `pois`; sie kostet nichts,
 * weil sie nur noch auf die schon eingegrenzte Menge trifft.
 */
const query = (place: string): string => `
SELECT p.osm_type, p.osm_id, p.name, p.brand, p.website, p.sport, ${place} AS place,
       p.latitude, p.longitude, p.area_square_meters
FROM poi_bounds b
JOIN pois p ON p.id = b.id
WHERE p.category = ?
  AND b.max_lon >= ? AND b.min_lon <= ? AND b.max_lat >= ? AND b.min_lat <= ?
  AND p.max_lon >= ? AND p.min_lon <= ? AND p.max_lat >= ? AND p.min_lat <= ?
`;

/**
 * Die Spalte `place` ist nachgetragen (25.09.2026). Eine Datei von vorher hat
 * sie nicht und bleibt trotzdem benutzbar -- ohne Ort unter dem Namen, aber
 * mit denselben Orten. Die Schemafassung steigt deshalb **nicht**: Sie schützt
 * vor einer Abfrage, die auf einer fehlenden Spalte still nichts findet, und
 * genau das kann hier nicht passieren, weil der Leser nachsieht, statt
 * anzunehmen. Ein Neubau holt die Orte nach.
 */
const PLACE_COLUMN = 'p.place';

type OpenDatabase = { db: DatabaseSync; coverage: Coverage; query: string };

/**
 * Liest die selbst gebaute POI-Datei.
 *
 * Er antwortet nur, wenn er sicher sein kann, dass seine Antwort vollständig
 * ist. Alle Gründe, aus denen er das nicht kann, sind
 * `PROVIDER_UNAVAILABLE`/`AREA_NOT_COVERED` -- also "konnte nicht antworten"
 * und nicht "nichts gefunden". Genau an dieser Unterscheidung hängt der
 * Rückfall, dieselbe Regel wie beim Geocoder.
 */
export class SqlitePoiProvider implements PoiProvider {
  private open: OpenDatabase | null = null;

  constructor(private readonly path: string) {}

  async search(category: PoiCategory, area: BoundingBox): Promise<Poi[]> {
    const { db, coverage, query: sql } = this.database();

    if (!containsBoundingBox(coverage, area)) {
      throw new DomainError(
        'AREA_NOT_COVERED',
        'Für diese Gegend liegen noch keine Ortsdaten vor.',
        `Suchbereich ${area.join(', ')} liegt nicht vollständig in der Abdeckung von ${this.path}.`,
      );
    }

    const [west, south, east, north] = area;
    const rows = db
      .prepare(sql)
      .all(
        category,
        west,
        east,
        south,
        north,
        west,
        east,
        south,
        north,
      ) as unknown as Row[];

    return rows.map((row) => ({
      id: `${row.osm_type}/${row.osm_id}`,
      category,
      name: row.name,
      coordinate: { latitude: row.latitude, longitude: row.longitude },
      brand: row.brand,
      website: row.website,
      sport: row.sport,
      place: row.place,
      areaSquareMeters: row.area_square_meters,
    }));
  }

  /**
   * Einmal öffnen, offen halten.
   *
   * Ein **Fehlschlag** wird bewusst nicht gemerkt: Die Datei kann während des
   * Betriebs entstehen -- der Bau läuft als eigener Auftrag --, und ein
   * Adapter, der sie erst nach einem Neustart bemerkt, wäre eine Falle. Ein
   * fehlgeschlagenes Öffnen kostet einen ENOENT.
   *
   * Der Neubau ersetzt die Datei atomar. Ein Prozess mit offenem Handle liest
   * danach weiter die alte -- richtig so: Eine Woche alte Daten sind die
   * kleinere Lüge, verglichen mit einer Datei, die einem mitten in der
   * Abfrage unter den Händen wechselt.
   */
  /**
   * Nennt den Stand der Datei -- oder, wenn sie nicht benutzbar ist, warum.
   *
   * Sie faengt hier ab, was `search` wirft: Diese Auskunft **ist** der
   * Bericht ueber die Fehlerlage, sie darf nicht selbst an ihr scheitern.
   */
  async describe(): Promise<PoiSource> {
    try {
      const { db } = this.database();

      return {
        kind: 'file',
        dataTimestamp: this.meta(db, META.sourceTimestamp),
        problem: null,
      };
    } catch (error) {
      return {
        kind: 'file',
        dataTimestamp: null,
        problem:
          error instanceof DomainError
            ? `${error.message} ${error.details ?? ''}`.trim()
            : String(error),
      };
    }
  }

  private database(): OpenDatabase {
    if (this.open !== null) return this.open;

    let db: DatabaseSync;

    try {
      db = new DatabaseSync(this.path, { readOnly: true });
    } catch (cause) {
      throw new DomainError(
        'PROVIDER_UNAVAILABLE',
        'Die eigene Ortsdatenbank ist nicht lesbar.',
        `${this.path}: ${cause instanceof Error ? cause.message : String(cause)} -- gebaut wird sie mit "npm run pois:build".`,
      );
    }

    try {
      const hasPlace = (
        db.prepare('SELECT name FROM pragma_table_info(?)').all('pois') as { name: string }[]
      ).some((column) => column.name === 'place');
      const opened = {
        db,
        coverage: this.readCoverage(db),
        query: query(hasPlace ? PLACE_COLUMN : 'NULL'),
      };
      this.open = opened;
      return opened;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private meta(db: DatabaseSync, key: string): string | null {
    try {
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    } catch {
      // Keine meta-Tabelle: Das ist keine Datei dieses Bauwerks.
      return null;
    }
  }

  private readCoverage(db: DatabaseSync): Coverage {
    const unusable = (reason: string): DomainError =>
      new DomainError(
        'PROVIDER_UNAVAILABLE',
        'Die eigene Ortsdatenbank passt nicht zu diesem Stand.',
        `${this.path}: ${reason} -- neu bauen mit "npm run pois:build".`,
      );

    const version = this.meta(db, META.schemaVersion);

    if (version !== String(POI_SCHEMA_VERSION)) {
      throw unusable(`Schemafassung ${version ?? 'fehlt'}, erwartet ${POI_SCHEMA_VERSION}`);
    }

    const fingerprint = this.meta(db, META.rulesFingerprint);
    const expected = rulesFingerprint();

    if (fingerprint !== expected) {
      throw unusable(
        `gebaut mit Regelliste ${fingerprint ?? 'unbekannt'}, aktuell ist ${expected}`,
      );
    }

    const raw = this.meta(db, META.coverage);

    if (raw === null) throw unusable('kein Abdeckungsgebiet hinterlegt');

    const coverage = JSON.parse(raw) as Coverage;

    if (coverage.type !== 'MultiPolygon' || coverage.coordinates.length === 0) {
      throw unusable('das Abdeckungsgebiet ist leer');
    }

    return coverage;
  }
}
