import { describe, expect, it } from 'vitest';
import {
  peekReachableArea,
  reachableArea,
} from '../src/application/analysis/reachable-area.js';
import type { AreaFeature, Coordinate } from '../src/domain/models/geo.js';
import type {
  IsochroneOptions,
  IsochroneProvider,
} from '../src/domain/ports/isochrone-provider.js';
import { square, stepsNotExpected, StubIsochroneProvider } from './helpers/fixtures.js';

const ORIGIN: Coordinate = { latitude: 53.14, longitude: 8.21 };
const OPTIONS = {
  travelMode: 'driving' as const,
  maxTravelTimeMinutes: 25,
  directions: 'both' as const,
};
const ONE_WAY = { ...OPTIONS, directions: 'toTarget' as const };

/** Liefert je Richtung eine andere Flaeche -- wie der echte Provider. */
class DirectionalProvider implements IsochroneProvider {
  readonly maxTravelTimeMinutes = 60;
  calls: IsochroneOptions[] = [];

  constructor(
    private readonly toTarget: AreaFeature,
    private readonly fromTarget: AreaFeature,
  ) {}

  async calculate(_origin: Coordinate, options: IsochroneOptions): Promise<AreaFeature> {
    this.calls.push(options);
    return options.direction === 'toTarget' ? this.toTarget : this.fromTarget;
  }

  calculateSteps = stepsNotExpected;
}

describe('reachableArea', () => {
  it('fragt beide Fahrtrichtungen ab', async () => {
    const provider = new DirectionalProvider(square(0, 0, 10, 10), square(0, 0, 10, 10));

    await reachableArea(provider, ORIGIN, OPTIONS);

    expect(provider.calls.map((call) => call.direction).sort()).toEqual([
      'fromTarget',
      'toTarget',
    ]);
  });

  it('reicht Verkehrsmittel und Zeit unveraendert durch', async () => {
    const provider = new DirectionalProvider(square(0, 0, 10, 10), square(0, 0, 10, 10));

    await reachableArea(provider, ORIGIN, {
      travelMode: 'cycling',
      maxTravelTimeMinutes: 12,
      directions: 'both',
    });

    for (const call of provider.calls) {
      expect(call.travelMode).toBe('cycling');
      expect(call.maxTravelTimeMinutes).toBe(12);
    }
  });

  it('schneidet die Richtungen, statt sie zu vereinigen', async () => {
    // Hinweg deckt den Westen, Rueckweg den Osten. Wer in 25 Minuten hin *und*
    // zurueck will, dem bleibt nur der Streifen dazwischen -- die Vereinigung
    // waere die schwaechere Aussage "in irgendeiner Richtung im Limit".
    const provider = new DirectionalProvider(square(0, 0, 6, 10), square(4, 0, 10, 10));

    const area = await reachableArea(provider, ORIGIN, OPTIONS);
    const xs = (area.geometry.coordinates[0] as Array<[number, number]>).map(([x]) => x);

    expect(Math.min(...xs)).toBeCloseTo(4);
    expect(Math.max(...xs)).toBeCloseTo(6);
  });

  it('faellt auf den Hinweg zurueck, wenn sich die Richtungen nicht schneiden', async () => {
    // Kann real nicht vorkommen -- beide Flaechen enthalten den Punkt selbst.
    // Entartete Providerdaten duerfen die Karte aber nicht leer lassen.
    const provider = new DirectionalProvider(square(0, 0, 4, 4), square(50, 50, 60, 60));

    const area = await reachableArea(provider, ORIGIN, OPTIONS);
    const xs = (area.geometry.coordinates[0] as Array<[number, number]>).map(([x]) => x);

    expect(Math.max(...xs)).toBeCloseTo(4);
  });

  it('kostet genau zwei Providercalls je Punkt', async () => {
    const provider = new StubIsochroneProvider([square(0, 0, 10, 10)]);

    await reachableArea(provider, ORIGIN, OPTIONS);

    expect(provider.calls).toHaveLength(2);
  });

  it('fragt mit toTarget nur den Hinweg und liefert ihn unverändert', async () => {
    const toTarget = square(0, 0, 6, 10);
    const provider = new DirectionalProvider(toTarget, square(4, 0, 10, 10));

    const area = await reachableArea(provider, ORIGIN, ONE_WAY);

    expect(provider.calls.map((call) => call.direction)).toEqual(['toTarget']);
    expect(area).toBe(toTarget);
    // Die Einstellung gehört der App, nicht dem Anbieter.
    expect(provider.calls[0]).not.toHaveProperty('directions');
  });
});

describe('peekReachableArea', () => {
  /** Kennt nur, was man ihm vorher gibt, und ruft nie `calculate`. */
  const peeking = (known: Partial<Record<'toTarget' | 'fromTarget', AreaFeature>>) => {
    const provider = new DirectionalProvider(square(0, 0, 1, 1), square(0, 0, 1, 1));
    const peek = async (_origin: Coordinate, options: IsochroneOptions) =>
      known[options.direction] ?? null;
    return Object.assign(provider, { peek });
  };

  it('schneidet wie reachableArea, wenn beide Richtungen da sind', async () => {
    const provider = peeking({ toTarget: square(0, 0, 6, 10), fromTarget: square(4, 0, 10, 10) });

    const area = await peekReachableArea(provider, ORIGIN, OPTIONS);

    expect(area).not.toBeNull();
    expect(provider.calls).toHaveLength(0);
  });

  it('gibt nichts heraus, solange eine Richtung fehlt', async () => {
    // Die halbe Antwort wäre eine zu grosse Fläche, kurz als richtige gezeigt.
    const provider = peeking({ toTarget: square(0, 0, 6, 10) });

    expect(await peekReachableArea(provider, ORIGIN, OPTIONS)).toBeNull();
  });

  it('genügt mit toTarget der Hinweg allein', async () => {
    const toTarget = square(0, 0, 6, 10);
    const provider = peeking({ toTarget });

    expect(await peekReachableArea(provider, ORIGIN, ONE_WAY)).toBe(toTarget);
    expect(await peekReachableArea(peeking({ fromTarget: toTarget }), ORIGIN, ONE_WAY)).toBeNull();
  });

  it('verneint bei einem Anbieter ohne Vorrat', async () => {
    const provider = new StubIsochroneProvider([square(0, 0, 10, 10)]);

    expect(await peekReachableArea(provider, ORIGIN, OPTIONS)).toBeNull();
    expect(provider.calls).toHaveLength(0);
  });
});
