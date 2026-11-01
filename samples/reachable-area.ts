import { isTransitMode, type TravelMode } from '../../domain/models/analysis.js';
import type { AreaFeature, Coordinate } from '../../domain/models/geo.js';
import type { IsochroneProvider } from '../../domain/ports/isochrone-provider.js';
import { intersectAreas } from '../../domain/services/geometry.js';

/**
 * In welche Richtungen ein Ziel gilt (`TARGET_DIRECTIONS` in der `.env`).
 *
 * `toTarget` ist seit dem 30.09.2026 die Vorgabe: nur der Hinweg, also halb
 * so viele Abrufe je Ziel, dafür am Rand ein Saum von zwei, drei Minuten zu
 * grosszügig. `both` ist die strengere Antwort (siehe `reachableArea`) und
 * kostet das Doppelte. Den Rückweg allein gibt es nicht -- die Frage im
 * Formular ist "wie lange brauche ich *zum* Ziel".
 */
export const TARGET_DIRECTIONS = ['both', 'toTarget'] as const;

export type TargetDirections = (typeof TARGET_DIRECTIONS)[number];

export type ReachabilityOptions = {
  travelMode: TravelMode;
  maxTravelTimeMinutes: number;
  /** Pflicht und ohne Vorgabe, aus demselben Grund wie `IsochroneOptions.direction`. */
  directions: TargetDirections;
};

/**
 * Die Flaeche, die eine Zeitvorgabe **in beide Richtungen** einhaelt.
 *
 * "25 Minuten zur Arbeit" heisst hoechstens 25 Minuten, egal in welche
 * Richtung: Wer hin 25 und zurueck 30 braucht, liegt bei der Einstellung 25
 * draussen und erst ab 30 drin. Eine einzelne Isochrone kann das nicht sagen,
 * sie kennt nur eine Richtung -- und die beiden sind nicht dieselbe Flaeche
 * (986 gegen 964 km² an einem Ziel in Oldenburg, 25 Min. Auto, aber 163 km²
 * liegen in genau einer von beiden).
 *
 * Geschnitten, nicht vereinigt: Die Vereinigung waere die schwaechere Aussage
 * "in *irgendeiner* Richtung im Limit", und die will niemand -- man faehrt hin
 * *und* zurueck.
 *
 * Mit `directions: 'toTarget'` nur der Hinweg, ohne Schnitt. Bus & Bahn ist
 * immer nur der Hinweg: Der Fahrplan wird für die Ankunft zwischen 8 und 9
 * Uhr gerechnet, der Rückweg am Nachmittag wäre eine zweite Suche, die es
 * noch nicht gibt (`oepnv-versuch.md`).
 *
 * Kosten: zwei Providercalls je Punkt statt einem. Beide Richtungen liegen
 * getrennt im Cache (die Richtung steht im Schluessel), eine Wiederholung
 * kostet also weiterhin nichts. Deshalb nur fuer die Ziele -- die sind zu
 * fuenft. Die Orte aus Schritt 3 duerfen bis zu 25 sein und bleiben einseitig.
 */
export const reachableArea = async (
  isochrones: IsochroneProvider,
  origin: Coordinate,
  options: ReachabilityOptions,
): Promise<AreaFeature> => {
  const { directions, ...query } = options;
  if (directions === 'toTarget' || isTransitMode(query.travelMode)) {
    return isochrones.calculate(origin, { ...query, direction: 'toTarget' });
  }

  const [toTarget, fromTarget] = await Promise.all([
    isochrones.calculate(origin, { ...query, direction: 'toTarget' }),
    isochrones.calculate(origin, { ...query, direction: 'fromTarget' }),
  ]);

  // Beide Flaechen enthalten den Punkt selbst, koennen sich also nicht
  // verfehlen. Liefert der Provider trotzdem einmal etwas Entartetes, ist der
  // Hinweg die Frage, die im Formular steht -- besser als gar keine Flaeche.
  return bothDirections(toTarget, fromTarget);
};

/**
 * Der Schnitt der beiden Richtungen, gemerkt je Paar von Flächen.
 *
 * Er kostet bei 25 Minuten Auto rund 110 ms, und er wird oft gefragt: bei
 * jedem Klick auf − oder + (`peekReachableArea`) und danach noch einmal für
 * jedes Ziel in `/api/analyze`. Die Flächen kommen aus dem Arbeitsspeicher
 * des Caches und sind dort **dieselben Objekte**, solange der Eintrag liegt.
 * Deshalb hängt das Gedächtnis an ihnen selbst (`WeakMap`), nicht an einem
 * Schlüssel: Wird eine Stufe ersetzt oder fällt aus dem Speicher, ist es ein
 * neues Objekt, und der Schnitt wird neu gerechnet. Eine Haltedauer braucht
 * es so nicht, und veralten kann nichts.
 */
const intersected = new WeakMap<AreaFeature, WeakMap<AreaFeature, AreaFeature>>();

const bothDirections = (toTarget: AreaFeature, fromTarget: AreaFeature): AreaFeature => {
  let byReturn = intersected.get(toTarget);
  if (byReturn === undefined) {
    byReturn = new WeakMap();
    intersected.set(toTarget, byReturn);
  }

  const known = byReturn.get(fromTarget);
  if (known !== undefined) return known;

  const area = intersectAreas([toTarget, fromTarget]) ?? toTarget;
  byReturn.set(fromTarget, area);
  return area;
};

/**
 * Dieselbe Fläche, aber nur, wenn **beide** Richtungen (bzw. bei `toTarget`
 * der Hinweg) ohne Anbieterabruf vorliegen -- sonst `null`. Eine Richtung allein wäre nicht die Antwort auf
 * die Frage im Formular, und die Hälfte schon mal anzuzeigen hiesse, eine zu
 * grosse Fläche kurz als richtige auszugeben.
 */
export const peekReachableArea = async (
  isochrones: IsochroneProvider,
  origin: Coordinate,
  options: ReachabilityOptions,
): Promise<AreaFeature | null> => {
  if (isochrones.peek === undefined) return null;

  const { directions, ...query } = options;
  if (directions === 'toTarget' || isTransitMode(query.travelMode)) {
    return isochrones.peek(origin, { ...query, direction: 'toTarget' });
  }

  const [toTarget, fromTarget] = await Promise.all([
    isochrones.peek(origin, { ...query, direction: 'toTarget' }),
    isochrones.peek(origin, { ...query, direction: 'fromTarget' }),
  ]);
  if (toTarget === null || fromTarget === null) return null;

  return bothDirections(toTarget, fromTarget);
};
