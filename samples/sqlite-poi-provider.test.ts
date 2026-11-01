import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../src/domain/models/errors.js';
import type { BoundingBox } from '../src/domain/models/geo.js';
import type { Poi, PoiCategory } from '../src/domain/models/poi.js';
import type { PoiProvider, PoiSource } from '../src/domain/ports/poi-provider.js';
import {
  META,
  POI_SCHEMA,
  POI_SCHEMA_VERSION,
  rulesFingerprint,
} from '../src/infrastructure/poi/database.js';
import { SqlitePoiProvider } from '../src/infrastructure/poi/sqlite-poi-provider.js';
import { FallbackPoiProvider } from '../src/infrastructure/poi/fallback-poi-provider.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true })));
});

/** Abdeckung: das Quadrat 8–9 Ost, 53–54 Nord. */
const COVERAGE = {
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [8, 53],
        [9, 53],
        [9, 54],
        [8, 54],
        [8, 53],
      ],
    ],
  ],
};

type Place = {
  category: PoiCategory;
  osmType: string;
  osmId: number;
  name: string;
  lat: number;
  lon: number;
  bounds?: { minLat: number; maxLat: number; minLon: number; maxLon: number };
};

const buildDatabase = async (
  places: Place[],
  meta: Partial<Record<string, string>> = {},
): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'poi-db-'));
  directories.push(directory);
  const path = join(directory, 'pois.sqlite');

  const db = new DatabaseSync(path);
  db.exec(POI_SCHEMA);

  const insert = db.prepare(`
    INSERT INTO pois (category, osm_type, osm_id, name, brand, website, sport,
      latitude, longitude, area_square_meters,
      min_lat, max_lat, min_lon, max_lon, from_polygon)
    VALUES (?,?,?,?,NULL,NULL,NULL,?,?,NULL,?,?,?,?,0)`);

  for (const place of places) {
    const b = place.bounds ?? {
      minLat: place.lat,
      maxLat: place.lat,
      minLon: place.lon,
      maxLon: place.lon,
    };
    insert.run(
      place.category,
      place.osmType,
      place.osmId,
      place.name,
      place.lat,
      place.lon,
      b.minLat,
      b.maxLat,
      b.minLon,
      b.maxLon,
    );
  }

  db.exec(`INSERT INTO poi_bounds (id, min_lon, max_lon, min_lat, max_lat)
           SELECT id, min_lon, max_lon, min_lat, max_lat FROM pois`);

  const put = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  const values: Record<string, string> = {
    [META.schemaVersion]: String(POI_SCHEMA_VERSION),
    [META.rulesFingerprint]: rulesFingerprint(),
    [META.coverage]: JSON.stringify(COVERAGE),
    ...meta,
  };

  for (const [key, value] of Object.entries(values)) put.run(key, value);

  db.close();
  return path;
};

const SCHOOL: Place = {
  category: 'school',
  osmType: 'way',
  osmId: 77,
  name: 'Paulus-Schule',
  lat: 53.5,
  lon: 8.5,
};

const INSIDE: BoundingBox = [8.1, 53.1, 8.9, 53.9];

describe('Der Adapter antwortet nur, wenn er vollständig antworten kann', () => {
  it('liefert die Orte der Kategorie', async () => {
    const path = await buildDatabase([
      SCHOOL,
      { ...SCHOOL, category: 'doctor', osmId: 78, name: 'Praxis' },
    ]);

    const found = await new SqlitePoiProvider(path).search('school', INSIDE);

    expect(found).toEqual<Poi[]>([
      {
        id: 'way/77',
        category: 'school',
        name: 'Paulus-Schule',
        place: null,
        coordinate: { latitude: 53.5, longitude: 8.5 },
        brand: null,
        website: null,
        sport: null,
        areaSquareMeters: null,
      },
    ]);
  });

  it('gibt eine leere Liste zurück, statt zu scheitern', async () => {
    // Ein leeres Ergebnis **innerhalb** der Abdeckung ist eine Auskunft --
    // "hier gibt es keine Schwimmbäder" --, kein Fehlschlag. Würde es als
    // Fehler gelten, fragte der Rückfall für jede echte Leermeldung Overpass.
    const path = await buildDatabase([SCHOOL]);

    await expect(new SqlitePoiProvider(path).search('pool', INSIDE)).resolves.toEqual(
      [],
    );
  });

  it('findet ein Gelände, dessen Mittelpunkt neben dem Suchbereich liegt', async () => {
    // Overpass liefert zu einer Bbox alles, was hineinragt. Der Index trägt
    // deshalb die Hülle, nicht den Mittelpunkt.
    const path = await buildDatabase([
      {
        ...SCHOOL,
        lat: 53.5,
        lon: 8.8,
        bounds: { minLat: 53.4, maxLat: 53.6, minLon: 8.6, maxLon: 8.9 },
      },
    ]);

    const found = await new SqlitePoiProvider(path).search(
      'school',
      [8.1, 53.1, 8.7, 53.9] as BoundingBox,
    );

    expect(found).toHaveLength(1);
  });

  it('lehnt einen Suchbereich ab, der aus der Abdeckung ragt', async () => {
    const path = await buildDatabase([SCHOOL]);

    await expect(
      new SqlitePoiProvider(path).search('school', [8.5, 53.5, 9.5, 53.9]),
    ).rejects.toMatchObject({ code: 'AREA_NOT_COVERED' });
  });

  it('lehnt ab, wenn die Datei fehlt', async () => {
    await expect(
      new SqlitePoiProvider('/gibt/es/nicht/pois.sqlite').search('school', INSIDE),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('lehnt eine Datei mit fremder Schemafassung ab', async () => {
    const path = await buildDatabase([SCHOOL], {
      [META.schemaVersion]: String(POI_SCHEMA_VERSION + 1),
    });

    await expect(
      new SqlitePoiProvider(path).search('school', INSIDE),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('lehnt eine Datei ab, die mit einer anderen Regelliste gebaut wurde', async () => {
    // Die stillste Fehlerart der ganzen Kette: Jemand nimmt `railway=halt`
    // aus der Liste und baut nicht neu. Ohne diesen Vergleich antwortete die
    // Datei weiter -- mit den Orten der alten Regel.
    const path = await buildDatabase([SCHOOL], {
      [META.rulesFingerprint]: 'aaaaaaaaaaaaaaaa',
    });

    // Der Grund steht in `details` -- die bleiben serverseitig, sind aber
    // genau das, was man zur Diagnose braucht.
    await expect(
      new SqlitePoiProvider(path).search('school', INSIDE),
    ).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      details: expect.stringContaining('Regelliste') as unknown as string,
    });
  });
});

/** Ein Anbieter, der auf Kommando antwortet oder scheitert. */
const SOURCE_OK: PoiSource = { kind: 'file', dataTimestamp: null, problem: null };

class Stub implements PoiProvider {
  calls = 0;

  constructor(
    private readonly answer: Poi[] | DomainError,
    private readonly source: PoiSource = SOURCE_OK,
  ) {}

  async describe(): Promise<PoiSource> {
    return this.source;
  }

  async search(): Promise<Poi[]> {
    this.calls += 1;
    if (this.answer instanceof DomainError) throw this.answer;
    return this.answer;
  }
}

describe('Der Rückfall springt nur ein, wenn der Erste nicht antworten konnte', () => {
  const area: BoundingBox = [8.1, 53.1, 8.9, 53.9];

  it('übergeht ein leeres Ergebnis nicht', async () => {
    const primary = new Stub([]);
    const fallback = new Stub([{ id: 'node/1' } as Poi]);

    await expect(
      new FallbackPoiProvider(primary, fallback, () => {}).search('school', area),
    ).resolves.toEqual([]);
    expect(fallback.calls).toBe(0);
  });

  for (const code of ['PROVIDER_UNAVAILABLE', 'AREA_NOT_COVERED'] as const) {
    it(`springt bei ${code} ein`, async () => {
      const primary = new Stub(new DomainError(code, 'geht nicht'));
      const fallback = new Stub([{ id: 'node/1' } as Poi]);

      await expect(
        new FallbackPoiProvider(primary, fallback, () => {}).search('school', area),
      ).resolves.toHaveLength(1);
      expect(fallback.calls).toBe(1);
    });
  }

  it('reicht einen echten Fehler durch', async () => {
    const primary = new Stub(new DomainError('INVALID_INPUT', 'falsch gefragt'));
    const fallback = new Stub([]);

    await expect(
      new FallbackPoiProvider(primary, fallback, () => {}).search('school', area),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fallback.calls).toBe(0);
  });

  it('meldet jeden Wechsel des Grundes genau einmal', async () => {
    // Nicht still -- der einzige sichtbare Unterschied wäre sonst die
    // Antwortzeit. Aber auch nicht bei jeder Suche dieselbe Zeile: Wer in
    // Hamburg sucht, löst den Rückfall bei jeder Kategorie erneut aus.
    const log = vi.fn();
    const primary = new Stub(new DomainError('AREA_NOT_COVERED', 'draußen'));
    const provider = new FallbackPoiProvider(primary, new Stub([]), log);

    await provider.search('school', area);
    await provider.search('pool', area);

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain('AREA_NOT_COVERED');
  });

  it('meldet auch die Rückkehr zum Normalfall', async () => {
    const log = vi.fn();
    let broken = true;
    const primary: PoiProvider = {
      describe: async () => SOURCE_OK,
      search: async () => {
        if (broken) throw new DomainError('PROVIDER_UNAVAILABLE', 'weg');
        return [];
      },
    };
    const provider = new FallbackPoiProvider(primary, new Stub([]), log);

    await provider.search('school', area);
    broken = false;
    await provider.search('school', area);

    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1]?.[0]).toContain('antwortet wieder');
  });
});

describe('Der Ort unter dem Namen', () => {
  it('kommt aus der Spalte `place`', async () => {
    const path = await buildDatabase([SCHOOL]);
    const db = new DatabaseSync(path);
    db.prepare("UPDATE pois SET place = 'Oldenburg'").run();
    db.close();

    const [found] = await new SqlitePoiProvider(path).search('school', INSIDE);

    expect(found?.place).toBe('Oldenburg');
  });

  it('fehlt in einer Datei von vorher, ohne dass sie unbrauchbar wird', async () => {
    // Die Spalte ist nachgetragen. Eine ältere Datei soll dieselben Orte
    // liefern, nur ohne Ort -- nicht auf Overpass zurückfallen.
    const path = await buildDatabase([SCHOOL]);
    const db = new DatabaseSync(path);
    db.exec('ALTER TABLE pois DROP COLUMN place');
    db.close();

    const found = await new SqlitePoiProvider(path).search('school', INSIDE);

    expect(found).toHaveLength(1);
    expect(found[0]?.place).toBeNull();
  });
});
