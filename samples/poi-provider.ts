import type { PoiCategory, Poi } from '../models/poi.js';
import type { BoundingBox } from '../models/geo.js';

/**
 * Woher die Orte kommen und wie alt sie sind.
 *
 * Zwei Fragen hängen daran, und beide wären sonst unbeantwortbar:
 *
 * - **Im Log beim Start.** Die eigene Datei wird über einen Pfad gefunden.
 *   Liegt sie woanders -- ein Dienst startet in einem anderen Verzeichnis als
 *   eine Shell --, faellt die App still auf den Rueckfall zurueck und
 *   antwortet in Sekunden statt in Millisekunden. Der einzige sichtbare
 *   Unterschied waere die Wartezeit.
 * - **Unter der Trefferliste.** Die Orte stammen aus OpenStreetMap, und die
 *   ODbL verlangt, dass das drandsteht, sobald die App sie selbst ausspielt.
 *   Der Stand gehoert in dieselbe Zeile: Wer sieht, dass die Daten von
 *   vorletzter Woche sind, versteht, warum das neue Studio fehlt.
 */
export type PoiSource = {
  /**
   * `file` = eigene Ablage, ein Schnappschuss. `service` = Live-Abfrage bei
   * einem fremden Dienst, also immer aktuell und immer langsam.
   */
  kind: 'file' | 'service';
  /** Stand der Daten (ISO). `null` bei einem Live-Dienst -- der hat keinen. */
  dataTimestamp: string | null;
  /**
   * Warum die bevorzugte Quelle gerade nicht benutzbar ist, im Klartext.
   * `null` heisst: alles in Ordnung. Steht hier etwas, antwortet der
   * Rueckfall -- und das soll man lesen koennen, statt es an der Antwortzeit
   * zu merken.
   */
  problem: string | null;
};

export interface PoiProvider {
  /**
   * Sucht POIs einer Kategorie im angegebenen Bereich.
   *
   * Der Bereich muss über die Zielregion hinausreichen: Ein POI kann außerhalb
   * der Region liegen und sie trotzdem bedienen. In der Testregion liegen mehr
   * relevante Studios außerhalb als innerhalb.
   */
  search(category: PoiCategory, area: BoundingBox): Promise<Poi[]>;

  /**
   * Auskunft über die eigene Quelle. Darf **nicht** werfen: Sie wird beim
   * Start und bei jedem `/api/config` abgefragt, und eine kaputte Datenlage
   * ist genau das, worüber sie berichten soll.
   */
  describe(): Promise<PoiSource>;
}
