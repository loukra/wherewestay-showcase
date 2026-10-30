import type { TravelMode } from '../models/analysis.js';
import type { AreaFeature, Coordinate } from '../models/geo.js';

/**
 * Fahrtrichtung einer einzelnen Isochrone.
 *
 * Die beiden ergeben nicht dieselbe Flaeche: Einbahnstrassen, Abbiegeverbote
 * und Autobahnauffahrten machen den Hinweg zu einem anderen Weg als den
 * Rueckweg. Gemessen an einem Ziel (Oldenburg, 25 Min., Auto) sind sie fast
 * gleich gross -- 986 gegen 964 km² -- decken sich aber nur zu 85 %: 163 km²
 * liegen in genau einer von beiden, als schmaler Saum am Rand.
 *
 * Das Feld ist Pflicht und hat bewusst keinen Vorgabewert. Eine Aufrufstelle,
 * die die Richtung vergisst, bekaeme sonst stillschweigend die des Providers
 * (ORS: `start`, also den Rueckweg) -- und niemand saehe es der Flaeche an.
 */
export const ISOCHRONE_DIRECTIONS = ['toTarget', 'fromTarget'] as const;

export type IsochroneDirection = (typeof ISOCHRONE_DIRECTIONS)[number];

export type IsochroneOptions = {
  travelMode: TravelMode;
  maxTravelTimeMinutes: number;
  /**
   * `toTarget`: Flaeche, **von der aus** der Punkt in der Zeit erreichbar ist
   * -- der Hinweg, also die Frage, die im Formular steht.
   * `fromTarget`: Flaeche, die **vom Punkt aus** erreichbar ist -- der Rueckweg.
   */
  direction: IsochroneDirection;
};

/**
 * Mehrere Fahrzeiten um denselben Punkt, in *einer* Anfrage.
 *
 * Das ist kein Komfort, sondern der Grund, warum die Staffel überhaupt
 * vertretbar ist: Gemessen am 16.09.2026 gegen ORS zählt eine Anfrage mit vier
 * Stufen genau **einen** von 500 Tagesaufrufen -- `x-ratelimit-remaining` fällt
 * um eins, wie bei einer einzelnen Isochrone. Vier einzelne Anfragen kosteten
 * vier.
 */
export type IsochroneStepsOptions = {
  travelMode: TravelMode;
  /** Fahrzeiten in Minuten. Die Antwort kommt aufsteigend sortiert zurück. */
  minutes: number[];
  direction: IsochroneDirection;
};

export type IsochroneStep = {
  minutes: number;
  /** Die volle Fläche dieser Stufe -- sie enthält alle kleineren. */
  area: AreaFeature;
};

export interface IsochroneProvider {
  /**
   * Groesste Fahrzeit, die dieser Provider unterstuetzt. Provider haben hier
   * harte, unterschiedliche Grenzen (OpenRouteService z. B. 60 Minuten), die
   * bis in die UI sichtbar sein muessen -- sonst laeuft der Nutzer in eine
   * nichtssagende Fehlermeldung.
   */
  readonly maxTravelTimeMinutes: number;

  calculate(origin: Coordinate, options: IsochroneOptions): Promise<AreaFeature>;

  /**
   * Die Fläche, wenn sie **ohne** Anbieterabruf vorliegt, sonst `null`.
   *
   * Für das Umschalten von Zeit und Verkehrsmittel an einem fertigen Ziel:
   * Was schon da ist, soll sofort erscheinen; was fehlt, holt die Oberfläche
   * erst, wenn niemand mehr klickt. Wer die Frage nicht beantworten kann
   * (kein Zwischenspeicher), lässt die Methode weg -- dann gilt alles als
   * fehlend, und es wird wie bisher nach der Pause geholt.
   */
  peek?(origin: Coordinate, options: IsochroneOptions): Promise<AreaFeature | null>;

  /**
   * Mehrere Fahrzeiten um denselben Punkt, aufsteigend sortiert.
   *
   * Die Flächen sind **nicht** unabhängig davon, womit sie zusammen gefragt
   * wurden: Bei ORS baut jede Stufe auf der vorigen auf, die oberste fällt
   * eine Spur größer aus, und zu Fuß ändert sich mit dem Abstand der Stufen
   * sogar die Rechnung (gemessen am 25.09.2026, bis 21 % Fläche). Wer Stufen
   * ablegt und wiederverwendet, muss deshalb festlegen, aus welcher Anfrage
   * welche Minute kommt -- siehe `infrastructure/isochrone/package-plan.ts`.
   */
  calculateSteps(
    origin: Coordinate,
    options: IsochroneStepsOptions,
  ): Promise<IsochroneStep[]>;

  /**
   * Dieselben Stufen um **mehrere** Punkte, in so wenigen Anfragen wie möglich.
   * Das Ergebnis steht in der Reihenfolge der Punkte.
   *
   * ORS nimmt bis zu fünf Punkte je Anfrage und zählt sie als **einen** Abruf
   * (gemessen am 25.09.2026: fünf Orte zu Fuß mit zehn Stufen, 3,7 s,
   * Kontingent 258 -> 257). Für Schritt 3 mit bis zu 25 gewählten Orten ist
   * das der Unterschied zwischen fünf und fünfundzwanzig Abrufen.
   *
   * Optional: Wer nicht bündeln kann, lässt es weg, und es wird einzeln
   * gefragt.
   */
  calculateStepsForMany?(
    origins: Coordinate[],
    options: IsochroneStepsOptions,
  ): Promise<IsochroneStep[][]>;

  /**
   * Eine Fahrzeit um mehrere Punkte, in der Reihenfolge der Punkte. Für die
   * Orte aus Schritt 3; wer es nicht anbietet, wird einzeln gefragt (siehe
   * `calculateAll` in `application/analysis/poi-region.ts`).
   */
  calculateMany?(origins: Coordinate[], options: IsochroneOptions): Promise<AreaFeature[]>;

  /** Wie `peek`, für mehrere Punkte; `null`, wo die Fläche nicht vorliegt. */
  peekMany?(origins: Coordinate[], options: IsochroneOptions): Promise<(AreaFeature | null)[]>;
}
